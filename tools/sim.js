#!/usr/bin/env node
/* TeTrowers — headless balancing simulator.
 *
 * Plays complete runs with a heuristic bot (real physics, real rules) and reports how long
 * runs last. Use it to tune js/config.js toward the target session (10-20 min, 100-500 drops).
 *
 *   node tools/sim.js [--runs 8] [--seed BASE] [--think 3] [--noise 0.6] [--max-drops 900]
 *                     [--mode assisted] [--set NEG_PER_M=0.012,LIFE_MILESTONE=12] [--quiet]
 *
 * --think   seconds a human spends choosing each drop (added to simulated wait time)
 * --noise   0 = perfect greedy bot, higher = sloppier choices (more human-like)
 * --set     temporary CONFIG overrides for experiments (comma separated KEY=VALUE)
 */
'use strict';
const path = require('path');

const args = parseArgs(process.argv.slice(2));
const ROOT = path.join(__dirname, '..');
const CORE = ['js/config.js', 'js/util.js', 'js/rng.js', 'js/shapes.js', 'js/blocktypes.js', 'js/generator.js',
  'js/physics.js', 'js/effects.js', 'js/placement.js', 'js/game.js'];

global.planck = require(path.join(ROOT, 'js/lib/planck.min.js'));
for (const rel of CORE) {
  require(path.join(ROOT, rel));
  if (rel === 'js/config.js' && args.set) {
    const over = {};
    for (const kv of String(args.set).split(',')) {
      const [k, v] = kv.split('=');
      if (k) over[k.trim()] = isNaN(+v) ? v : +v;
    }
    global.TT.CONFIG = Object.freeze(Object.assign({}, global.TT.CONFIG, over));
  }
}
const TT = global.TT;
const C = TT.CONFIG;

const RUNS = +(args.runs || 8);
const THINK = +(args.think != null ? args.think : 3);
const NOISE = +(args.noise != null ? args.noise : 0.6);
const MAX_DROPS = +(args['max-drops'] || 900);
const MODE = args.mode || 'assisted';
const BASE = args.seed || 'SIM';
const DT = 1 / 60;
const NEG_TRASH = new Set(['mine', 'anvil', 'magma', 'blackhole', 'crumble', 'oil']);

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = list[i + 1];
    if (next == null || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

// Skyline helpers (surface fields: skyline Float32Array, x0, samplesPerCell, n)
function skyAt(surface, x) {
  const k = Math.floor((x - surface.x0) * surface.samplesPerCell);
  return k >= 0 && k < surface.n ? surface.skyline[k] : -Infinity;
}

// Column heights (integer columns 0..15, sampled at centres) before and after a placement
function columnHeights(surface, shape, x, y) {
  const h = new Array(C.FIELD_WIDTH);
  for (let c = 0; c < C.FIELD_WIDTH; c++) h[c] = skyAt(surface, c + 0.5);
  for (let j = 0; j < shape.w; j++) {
    const c = Math.floor(x + j + 0.5);
    if (c >= 0 && c < C.FIELD_WIDTH) h[c] = Math.max(h[c], y + shape.top[j]);
  }
  return h;
}

function scorePlacement(game, surface, spec, x, rng) {
  const shape = TT.SHAPES[spec.shapeId];
  const type = TT.BLOCK_TYPES[spec.typeKey];
  const L = TT.Placement.landing(surface, shape, x, game.hoverY);
  const key = spec.typeKey;
  const negative = type.category === 'negative';
  if (L.void) return 1e6;
  let s = 0;
  const w = L.warnings;
  if (w.includes('horizon')) s += NEG_TRASH.has(key) ? -30 : 400; // a black hole doubles as a bin
  if (w.includes('spikes')) s += NEG_TRASH.has(key) ? -10 : 300;
  if (w.includes('mine')) s += key === 'pebble' ? 12 : 120;
  if (w.includes('glass')) s += 35;

  // Real support: which skyline samples under each piece column touch its bottom
  const spc = surface.samplesPerCell;
  let supLo = Infinity, supHi = -Infinity, holes = 0, partial = 0;
  for (let j = 0; j < shape.w; j++) {
    const bottom = L.y + shape.bottom[j];
    let touch = 0;
    for (let k = 0; k < spc; k++) {
      const sx = x + j + (k + 0.5) / spc;
      const t = skyAt(surface, sx);
      if (t >= bottom - 0.06) {
        touch++;
        if (sx < supLo) supLo = sx;
        if (sx > supHi) supHi = sx;
      } else {
        holes += Math.min(3, bottom - (isFinite(t) ? t : bottom - 3)) / spc;
      }
    }
    if (touch > 0 && touch < spc * 0.75) partial++;
  }
  const com = x + shape.com.x;
  let tips = !(com > supLo + 0.3 && com < supHi - 0.3);
  if (L.y < -0.05) return 1e5; // hangs off the platform edge: certain loss
  if (tips) {
    // Tipping onto the tower is messy but survivable; tipping toward open air loses the block
    const side = com <= supLo + 0.3 ? -1 : 1;
    const edgeX = side < 0 ? supLo - 0.6 : supHi + 0.6;
    const below = skyAt(surface, edgeX);
    if (!isFinite(below) || below < L.y - 1.5) s += 400;
    else { s += 18; tips = false; }
  }

  // Surface shape after placing (Tetris-style): bumpiness inside the tower span, peak height
  const hts = columnHeights(surface, shape, x, L.y);
  let bump = 0, maxH = -Infinity, span = 0;
  for (let c = 0; c < C.FIELD_WIDTH; c++) {
    if (!isFinite(hts[c])) continue;
    span++;
    if (hts[c] > maxH) maxH = hts[c];
    if (c + 1 < C.FIELD_WIDTH && isFinite(hts[c + 1])) bump += Math.min(4, Math.abs(hts[c] - hts[c + 1]));
  }
  s += (L.y + shape.h / 2) * 1.6 + maxH * 0.3 + holes * 2.5 + bump * 0.5 + partial * 1.2 + (tips ? 80 : 0);
  s -= Math.min(span, 9) * 0.25; // a wider footprint is a steadier tower

  const center = x + shape.w / 2;
  const fromMid = Math.abs(center - C.FIELD_WIDTH / 2);
  if (NEG_TRASH.has(key) || key === 'glass' || key === 'spikes') s -= fromMid * 0.8; // hazards to the rim
  else s += fromMid * 0.15;
  if (key === 'anvil' && L.primary && !(L.primary.isPlatform || L.primary.body.isStatic())) s += 20;
  if ((key === 'steel' || key === 'frost') && !tips) s -= 1;
  if (negative && key === 'rubber') s += (L.y + shape.h) * 0.2;
  return s + (rng() - 0.5) * 2 * NOISE * 3;
}

function chooseMove(game, rng) {
  const surface = game._getSurface(true);
  let best = null;
  game.batch.forEach((slot, i) => {
    if (slot.used) return;
    const shape = TT.SHAPES[slot.spec.shapeId];
    const xs = TT.Placement.candidates(surface, shape, MODE === 'manual' ? 'fixed' : MODE);
    for (const x of xs) {
      const s = scorePlacement(game, surface, slot.spec, x, rng);
      if (!best || s < best.s) best = { s, i, x };
    }
  });
  return best;
}

function playRun(seed) {
  const game = TT.Game.create({ seed, mode: MODE });
  const rng = TT.RNG.mulberry32(TT.RNG.hashString(seed + '#bot'));
  const lifeLossAt = [];
  const causes = {};
  game.on('lifeLost', () => lifeLossAt.push(game.turn));
  game.on('blockLost', (p) => {
    causes[p.block.look] = (causes[p.block.look] || 0) + 1;
    if (args.verbose) console.log(`    lost #${p.block.id} ${p.block.look}/${p.block.shapeId} (dropped turn ${p.block.dropTurn}) at turn ${game.turn}, x=${p.x.toFixed(2)}`);
  });
  if (args.verbose) {
    game.on('drop', (p) => {
      const L = TT.Placement.landing(game._getSurface(), TT.SHAPES[p.block.shapeId], p.x);
      console.log(`  drop ${game.turn} ${p.block.typeKey}/${p.block.shapeId} x=${p.x.toFixed(2)} landY=${L.void ? 'void' : L.y.toFixed(2)} h=${game.height.toFixed(1)}`);
    });
    for (const ev of ['explode', 'shatter', 'swallow', 'pop', 'melt']) game.on(ev, (p) => console.log(`    ${ev} ${p.cause || ''} at (${(p.x || 0).toFixed(1)}, ${(p.y || 0).toFixed(1)})`));
  }
  let frames = 0, updMs = 0, lateMs = 0, lateFrames = 0, maxFrameMs = 0;
  const t0 = Date.now();
  while (game.state !== 'over' && game.turn < MAX_DROPS) {
    let guard = 0;
    while (!game.canDrop && game.state === 'playing' && guard++ < 60 * 12) {
      const a = process.hrtime.bigint();
      game.update(DT);
      const ms = Number(process.hrtime.bigint() - a) / 1e6;
      frames++; updMs += ms; if (ms > maxFrameMs) maxFrameMs = ms;
      if (game.physics.blocks.length > 250) { lateMs += ms; lateFrames++; }
    }
    if (game.state !== 'playing') break;
    if (!game.canDrop) break;
    const mv = chooseMove(game, rng);
    if (!mv) break;
    game.selectSlot(mv.i);
    game.setTargetX(mv.x);
    game.drop();
  }
  for (let k = 0; k < 60 * 3 && game.state !== 'over'; k++) game.update(DT);
  const simTime = game.physics.time;
  return {
    seed, drops: game.turn, best: game.bestHeight, height: game.height, over: game.state === 'over',
    lives: game.lives, lifeLossAt, causes, stats: game.stats, blocks: game.physics.blocks.length,
    statics: game.physics.blocks.length - game.physics.movers.length,
    minutes: (simTime + game.turn * THINK) / 60, simTime,
    avgUpdateMs: updMs / Math.max(1, frames), lateUpdateMs: lateFrames ? lateMs / lateFrames : null, maxFrameMs,
    wallMs: Date.now() - t0
  };
}

function pct(arr, p) {
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
}

const results = [];
for (let r = 0; r < RUNS; r++) {
  const res = playRun(BASE + '-' + r);
  results.push(res);
  if (!args.quiet) {
    console.log(
      res.seed.padEnd(12),
      'drops', String(res.drops).padStart(4),
      'best', res.best.toFixed(1).padStart(6), 'm',
      '~' + res.minutes.toFixed(1).padStart(5), 'min',
      'lifeLoss@', JSON.stringify(res.lifeLossAt),
      'blocks', res.blocks, '(static ' + res.statics + ')',
      'upd', res.avgUpdateMs.toFixed(3), 'ms',
      res.lateUpdateMs != null ? '(>250 blocks ' + res.lateUpdateMs.toFixed(3) + ')' : '',
      'max', res.maxFrameMs.toFixed(1),
      res.over ? '' : '[NOT OVER]'
    );
  }
}
const drops = results.map((r) => r.drops), mins = results.map((r) => r.minutes), best = results.map((r) => r.best);
console.log('---');
console.log(`runs ${RUNS}  think ${THINK}s  noise ${NOISE}  mode ${MODE}${args.set ? '  set ' + args.set : ''}`);
console.log(`drops   median ${pct(drops, 0.5)}  p10 ${pct(drops, 0.1)}  p90 ${pct(drops, 0.9)}`);
console.log(`minutes median ${pct(mins, 0.5).toFixed(1)}  p10 ${pct(mins, 0.1).toFixed(1)}  p90 ${pct(mins, 0.9).toFixed(1)}`);
console.log(`best m  median ${pct(best, 0.5).toFixed(1)}  p10 ${pct(best, 0.1).toFixed(1)}  p90 ${pct(best, 0.9).toFixed(1)}`);
const agg = {};
for (const r of results) for (const [k, v] of Object.entries(r.causes)) agg[k] = (agg[k] || 0) + v;
console.log('lost blocks by look:', JSON.stringify(agg));
if (args.json) console.log(JSON.stringify(results));
