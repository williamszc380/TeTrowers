#!/usr/bin/env node
/* TeTrowers — headless smoke test in a real browser.
 * Loads the game, plays a few drops with real key presses in a phone-portrait and a desktop
 * viewport, saves screenshots and reports game state and any console errors.
 *
 *   node tools/smoke.js [--url URL] [--out DIR] [--drops 12] [--seed SMOKE1]
 *                       [--only portrait|landscape] [--headed]
 *
 * Needs the dev dependency puppeteer-core (`npm install`) and an installed Chrome or Edge
 * (override with CHROME_PATH). Exit code 1 if the page logged errors or the game did not run.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next == null || next.startsWith('--')) args[a.slice(2)] = true;
  else { args[a.slice(2)] = next; i++; }
}

let puppeteer;
try {
  puppeteer = require('puppeteer-core');
} catch (err) {
  console.error('puppeteer-core is not installed. Run "npm install" in the project folder first.');
  process.exit(2);
}

const URL = args.url || 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/').replace(/ /g, '%20');
const OUT = path.resolve(args.out || path.join(ROOT, 'tools/out'));
const DROPS = +(args.drops || 12);
const SEED = String(args.seed || 'SMOKE1');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  const env = process.env;
  const list = [
    env.CHROME_PATH,
    env.ProgramFiles && path.join(env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Google/Chrome/Application/chrome.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'Microsoft/Edge/Application/msedge.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
  ];
  return list.find((p) => p && fs.existsSync(p));
}

async function session(name, viewport) {
  const browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: !args.headed,
    args: ['--autoplay-policy=no-user-gesture-required', '--allow-file-access-from-files']
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + ((e && e.stack) || e)));
  page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url()));
  await page.setViewport(viewport);
  // Tiny placement heuristic (lowest stable spot, no holes, avoid hazards); keys do the moving
  await page.evaluateOnNewDocument(() => {
    window.pickMove = function (game) {
      const TT = window.TT;
      const surface = game._getSurface(true);
      const colTop = (x) => { const L = TT.Placement.landing(surface, TT.SHAPES.P1, x); return L.void ? -Infinity : L.y; };
      let best = null;
      game.batch.forEach((slot, i) => {
        if (slot.used) return;
        const shape = TT.SHAPES[slot.spec.shapeId];
        for (const x of TT.Placement.candidates(surface, shape, 'assisted')) {
          const L = TT.Placement.landing(surface, shape, x, game.hoverY);
          if (L.void || L.warnings.length) continue;
          let holes = 0, lo = Infinity, hi = -Infinity;
          for (let j = 0; j < shape.w; j++) {
            const t = colTop(x + j);
            if (!isFinite(t)) { holes += 3; continue; }
            const gap = L.y + shape.bottom[j] - t;
            holes += Math.max(0, gap);
            if (gap < 0.08) { lo = Math.min(lo, x + j); hi = Math.max(hi, x + j + 1); }
          }
          const com = x + shape.com.x;
          const tip = com > lo + 0.25 && com < hi - 0.25 ? 0 : 50;
          const s = L.y + shape.h + holes * 2 + tip + Math.abs(x + shape.w / 2 - 8) * 0.1;
          if (!best || s < best.s) best = { s, slot: i, x };
        }
      });
      return best;
    };
  });
  await page.goto(URL, { waitUntil: 'load' });
  await sleep(700);
  const shots = [path.join(OUT, name + '-title.png')];
  await page.screenshot({ path: shots[0] });

  const hasApp = await page.evaluate(() => !!(window.TT && window.TT.App && window.TT.App.startGame));
  if (!hasApp) {
    errors.push('window.TT.App.startGame is missing');
    await browser.close();
    return { name, errors, info: null, shots };
  }
  await page.evaluate((seed) => window.TT.App.startGame({ seed }), SEED);
  await sleep(600);
  const press = async (key, wait) => { await page.keyboard.press(key); await sleep(wait || 40); };
  const state = () => page.evaluate(() => {
    const g = window.TT.App.game;
    return { selected: g.selected, x: g.piece ? g.piece.x : null, canDrop: g.canDrop, playing: g.state === 'playing', mode: g.mode };
  });
  for (let i = 0; i < DROPS; i++) {
    // Wait for the drop to be allowed, then let a simple in-page heuristic pick a stable spot
    for (let t = 0; t < 60 && !(await state()).canDrop && (await state()).playing; t++) await sleep(100);
    const st = await state();
    if (!st.playing) break;
    if (i === 4) {
      for (let k = 0; k < 3; k++) await press('Control', 80); // assisted -> fixed -> manual -> assisted
    }
    const plan = await page.evaluate(() => pickMove(window.TT.App.game));
    if (!plan) break;
    for (let k = 0; k < 3 && (await state()).selected !== plan.slot; k++) await press('ArrowDown', 60); // Down = next block
    for (let k = 0; k < 60; k++) {
      const x = (await state()).x;
      if (x == null || Math.abs(x - plan.x) < 0.02) break;
      await press(x < plan.x ? 'ArrowRight' : 'ArrowLeft', 30);
    }
    await press('Enter', 900); // Enter (or Space) drops
  }
  await sleep(1200);
  shots.push(path.join(OUT, name + '-game.png'));
  await page.screenshot({ path: shots[1] });
  const info = await page.evaluate(() => {
    const g = window.TT.App.game;
    return g && {
      state: g.state, turn: g.turn, round: g.round, lives: g.lives, mode: g.mode,
      height: +g.height.toFixed(2), best: +g.bestHeight.toFixed(2),
      blocks: g.physics.blocks.length, movers: g.physics.movers.length, canDrop: g.canDrop
    };
  });
  await press('Escape', 400);
  shots.push(path.join(OUT, name + '-pause.png'));
  await page.screenshot({ path: shots[2] });
  await browser.close();
  return { name, errors, info, shots };
}

(async () => {
  const viewports = {
    portrait: { width: 412, height: 860, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    landscape: { width: 1280, height: 720, deviceScaleFactor: 1 }
  };
  let failed = false;
  for (const name of Object.keys(viewports)) {
    if (args.only && args.only !== name) continue;
    const r = await session(name, viewports[name]);
    const ran = r.info && r.info.turn > 0;
    if (r.errors.length || !ran) failed = true;
    console.log('== ' + name + ' ==');
    console.log('game:', JSON.stringify(r.info));
    console.log('screenshots:', r.shots.join(', '));
    console.log('errors (' + r.errors.length + ')' + (r.errors.length ? ':' : ''));
    for (const e of r.errors.slice(0, 40)) console.log('  ' + e);
    if (!ran) console.log('  game did not register any drops');
  }
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
