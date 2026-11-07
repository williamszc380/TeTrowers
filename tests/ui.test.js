/* DOM-light parts of js/ui.js (and TT.App from js/main.js) in Node: slot buttons leave pointer
 * presses to TT.Input (no Drop button any more), the drag cues mirror TT.Input's state (the red
 * cancel target, the renderer's greyed-out piece, one buzz per entry into the cancel zone,
 * "Cancelled" plus the cancel sound when a drag is let go there, everything reset when the drag
 * ends or is interrupted), both "Same seed" boxes share one setting, Restart / Play again use a new
 * random seed unless "Same seed" is ticked (persisted as restartSameSeed, false for older saves),
 * saved block sets that list removed types (pebble, crumble) still load, the installed app locks
 * portrait, the pending-run snapshot (a run the OS kills still gets its record, without spoiling
 * the game-over badge), toasts, and the Back guard's history state machine. The "?" badge shows on
 * the special blocks of the tray only; pressing it opens that block's card without selecting,
 * moving or dropping anything; the card and the special-block explorer ("?" button, ? / H) list
 * what each block does with its current odds, pause the game and resume it when they close (a game
 * that was already paused stays paused). */
'use strict';
const assert = require('assert');
const path = require('path');
const TT = require('./load-core')();

const UI_FILE = path.join(__dirname, '..', 'js/ui.js');
const MAIN_FILE = path.join(__dirname, '..', 'js/main.js');
const local = new Map();   // a fake localStorage shared by "page loads"
global.window = {
  TT,
  localStorage: {
    getItem: (k) => (local.has(k) ? local.get(k) : null),
    setItem: (k, v) => { local.set(k, String(v)); },
    removeItem: (k) => { local.delete(k); }
  }
};
// Each call is a fresh page load: ui.js is evaluated again (its in-memory storage cache starts empty)
function loadUI() {
  delete require.cache[require.resolve(UI_FILE)];
  require(UI_FILE);
  return TT.UI;
}

// Just enough DOM: class lists, text, attributes, style, children
function el(tag) {
  const cls = new Set();
  const n = {
    tagName: String(tag || 'div').toUpperCase(), children: [], parent: null, dataset: {}, hidden: false,
    clientWidth: 0, clientHeight: 0, offsetWidth: 0, offsetHeight: 0, style: { setProperty() {} }, writes: 0,
    _text: '', attrs: {},
    get textContent() { return n._text + n.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); },
    set textContent(v) {
      for (const c of n.children) if (typeof c !== 'string') c.parent = null;
      n._text = String(v); n.children = []; n.writes++;
    },
    set className(v) { cls.clear(); for (const c of String(v).split(/\s+/)) if (c) cls.add(c); },
    get className() { return Array.from(cls).join(' '); },
    classList: {
      add: (...c) => { for (const x of c) cls.add(x); }, remove: (...c) => { for (const x of c) cls.delete(x); },
      contains: (c) => cls.has(c),
      toggle: (c, on) => { if (on === undefined ? !cls.has(c) : on) cls.add(c); else cls.delete(c); }
    },
    setAttribute(k, v) { n.attrs[k] = String(v); },
    getAttribute(k) { return k in n.attrs ? n.attrs[k] : null; },
    appendChild(c) { c.parent = n; n.children.push(c); return c; },
    append(...cs) { for (const c of cs) { if (typeof c === 'string') n.children.push(c); else n.appendChild(c); } },
    remove() { if (n.parent) { n.parent.children.splice(n.parent.children.indexOf(n), 1); n.parent = null; } }
  };
  return n;
}
// Every element below n (depth first) that passes test
function findAll(n, test, out) {
  const list = out || [];
  for (const c of n.children) {
    if (typeof c === 'string') continue;
    if (test(c)) list.push(c);
    findAll(c, test, list);
  }
  return list;
}

// --- Slot buttons: pointer presses belong to TT.Input; there is no Drop button any more -------------
{
  const { UI } = loadUI();
  globalThis.performance = { now: () => 1e6 };
  assert.strictEqual(UI.prototype._onPress, undefined, 'no press-to-act path (it drove the Drop button)');
  const calls = [];
  const ui = Object.create(UI.prototype);
  ui.root = { contains: () => true };
  ui._run = (action) => calls.push(action);
  const button = (action, inHud) => {
    const b = { dataset: { action }, blurs: 0, blur() { this.blurs++; } };
    b.closest = (sel) => (sel === '[data-action]' ? b : sel === '.hud' ? (inHud ? {} : null) : null);
    return b;
  };
  const slot = button('slot', true), pause = button('pause', true), resume = button('resume', false);
  ui._onClick({ target: slot, detail: 1 });          // tap / click: TT.Input already picked it on pointerdown
  ui._onClick({ target: slot, detail: 2 });          // double click
  assert.deepStrictEqual(calls, [], 'pointer clicks on a slot do nothing more');
  ui._onClick({ target: slot, detail: 0 });          // Enter / Space on a slot the player tabbed to
  assert.deepStrictEqual(calls, ['slot'], 'keyboard activation selects');
  ui._onClick({ target: pause, detail: 1 });
  assert.deepStrictEqual(calls, ['slot', 'pause'], 'other buttons act on click');
  assert.strictEqual(pause.blurs, 1, 'a clicked HUD button lets go of the focus (Space / Enter drop again)');
  ui._onClick({ target: resume, detail: 0 });
  assert.strictEqual(resume.blurs, 0, 'keyboard focus stays where the player put it');
}

// --- Drag cues: lifted slot, the red cancel target, "Cancelled", "Dropping when ready" by the piece -----
{
  const { UI } = loadUI();
  const ui = Object.create(UI.prototype);
  ui.slots = [0, 1, 2].map(() => ({ btn: el('button') }));
  const tray = el('footer'), trayCue = el('p'), dropCue = el('div'), bar = el('i');
  dropCue.hidden = true;
  dropCue.offsetWidth = 140;
  dropCue.offsetHeight = 30;
  ui.el = { hudTray: tray, trayCue, dropCue, dropCueBar: bar };
  ui.root = el('div');
  ui.hud = {};
  ui._stageW = 400;
  ui._pt = { x: 0, y: 0 };
  const cue = { slot: -1, zone: '', queued: false, cancels: 0 };
  const rcues = [], buzzes = [], sounds = [];
  // 25 px per cell, world y 24 at the top of the playfield
  const renderer = {
    scale: 25, worldToScreen: (x, y, o) => { o.x = x * 25; o.y = (24 - y) * 25; return o; },
    setDragCue: (c) => rcues.push(c.active ? (c.cancel ? 'cancel' : 'active') : 'off')
  };
  ui.app = {
    input: { cue }, renderer, sfx: (name) => sounds.push(name),
    audio: { vibrate: (ms) => { buzzes.push(ms); return true; } }
  };
  const game = { piece: { x: 6, y: 10, shape: { w: 2, h: 3 } }, readyProgress: 0.5 };
  const lifted = () => ui.slots.map((s) => s.btn.classList.contains('is-lifted'));
  const has = (n, c) => n.classList.contains(c);
  const sync = (slot, zone) => { cue.slot = slot; cue.zone = zone; ui._syncDrag(game); };

  ui._syncDrag(game);
  assert.deepStrictEqual(lifted(), [false, false, false]);
  assert.ok(!has(tray, 'is-dragging') && !has(tray, 'is-cancel') && dropCue.hidden);
  assert.deepStrictEqual(rcues, ['off']);
  // Picked up, still over the tray: letting go would cancel (no buzz: it never left the tray)
  sync(1, 'cancel');
  assert.deepStrictEqual(lifted(), [false, true, false], 'the dragged slot is lifted');
  assert.ok(has(tray, 'is-cancel') && !has(tray, 'is-dragging') && has(ui.root, 'is-dragging') && has(ui.root, 'is-drag-cancel'));
  assert.strictEqual(trayCue.textContent, '✕ Release to cancel');
  assert.deepStrictEqual(rcues, ['off', 'cancel'], 'the renderer greys the piece out');
  assert.deepStrictEqual(buzzes, []);
  // Over the playfield: a calm hint, the piece and its ghost are normal again
  sync(1, 'field');
  assert.ok(has(tray, 'is-dragging') && !has(tray, 'is-cancel') && !has(ui.root, 'is-drag-cancel'));
  assert.strictEqual(trayCue.textContent, 'Let go to drop · drag back here to cancel');
  assert.deepStrictEqual(rcues, ['off', 'cancel', 'active']);
  const writes = trayCue.writes;
  for (let i = 0; i < 5; i++) ui._syncDrag(game);
  assert.strictEqual(trayCue.writes, writes, 'the DOM changes only when the state does');
  assert.strictEqual(rcues.length, 3, '...and so does the renderer cue');
  // Each entry into the cancel zone buzzes once (10 ms); crossing back clears the cue
  sync(1, 'cancel');
  ui._syncDrag(game);
  assert.deepStrictEqual(buzzes, [10], 'one short buzz on the way in');
  assert.ok(has(tray, 'is-cancel') && trayCue.textContent === '✕ Release to cancel');
  sync(1, 'field');
  assert.ok(!has(tray, 'is-cancel') && !has(ui.root, 'is-drag-cancel'), 'back over the playfield: cleared');
  sync(1, 'cancel');
  assert.deepStrictEqual(buzzes, [10, 10], 'once per entry');
  assert.deepStrictEqual(rcues.slice(3), ['cancel', 'active', 'cancel']);
  // Let go there: everything resets, "Cancelled" for a moment with the soft cancel sound
  cue.cancels = 1;
  sync(-1, '');
  assert.deepStrictEqual(lifted(), [false, false, false]);
  assert.ok(!has(tray, 'is-cancel') && !has(tray, 'is-dragging') && !has(ui.root, 'is-dragging') && !has(ui.root, 'is-drag-cancel'));
  assert.strictEqual(rcues[rcues.length - 1], 'off', 'renderer cue reset');
  assert.ok(has(tray, 'is-cancelled') && trayCue.textContent === 'Cancelled', '"Cancelled" in the tray');
  assert.deepStrictEqual(sounds, ['cancel'], 'the cancel sound');
  ui._syncDrag(game);
  assert.deepStrictEqual(sounds, ['cancel'], 'once');
  sync(0, 'field');                                   // a new drag at once: the flash gives way
  assert.ok(!has(tray, 'is-cancelled') && has(tray, 'is-dragging'));
  // The drag ends without a release in the cancel zone (a drop, pause, a menu, game over, blur):
  // the cue resets quietly
  sync(-1, '');
  assert.ok(!has(tray, 'is-dragging') && !has(tray, 'is-cancelled') && rcues[rcues.length - 1] === 'off');
  assert.deepStrictEqual(sounds, ['cancel'], 'no sound');
  assert.deepStrictEqual(buzzes, [10, 10], 'no buzz');
  sync(2, 'cancel');                                  // interrupted while over the cancel zone
  sync(-1, '');
  assert.ok(!has(tray, 'is-cancel') && !has(ui.root, 'is-drag-cancel') && rcues[rcues.length - 1] === 'off', 'reset');
  assert.deepStrictEqual(sounds, ['cancel']);
  // A new run never flashes what the previous one counted
  ui.hud = {};
  cue.cancels = 5;
  ui._syncDrag(game);
  assert.ok(!has(tray, 'is-cancelled') && sounds.length === 1, 'nothing to flash after bindGame');
  ui._endCancelled();
  // Let go too early: the cue sits centred above the piece, with the readiness bar
  cue.slot = -1;
  cue.zone = '';
  cue.queued = true;
  ui._syncDrag(game);
  assert.deepStrictEqual(lifted(), [false, false, false]);
  assert.ok(!has(tray, 'is-dragging') && !has(tray, 'is-cancel') && !has(ui.root, 'is-dragging'));
  assert.ok(!dropCue.hidden, 'Dropping when ready');
  assert.strictEqual(dropCue.style.transform, 'translate(105px, 237px)', 'centred above the piece');
  assert.strictEqual(bar.style.transform, 'scaleX(0.5)');
  game.piece.y = 20;                                  // at the very top: below the piece instead
  ui._syncDrag(game);
  assert.strictEqual(dropCue.style.transform, 'translate(105px, 108px)');
  game.piece.x = 15;                                  // at the right edge: kept inside the playfield
  game.readyProgress = 0.9;
  ui._syncDrag(game);
  assert.strictEqual(dropCue.style.transform, 'translate(256px, 108px)');
  assert.strictEqual(bar.style.transform, 'scaleX(0.9)');
  cue.queued = false;
  ui._syncDrag(game);
  assert.ok(dropCue.hidden, 'gone when the drop happened or was cancelled');
  // A new run starts clean, whatever the previous one left behind
  cue.slot = 2;
  cue.zone = 'cancel';
  ui._syncDrag(game);
  ui._clearDragCues();
  assert.deepStrictEqual(lifted(), [false, false, false]);
  assert.ok(!has(tray, 'is-cancel') && !has(ui.root, 'is-dragging') && !has(ui.root, 'is-drag-cancel') && dropCue.hidden);
  assert.strictEqual(rcues[rcues.length - 1], 'off', 'the renderer cue too');
}

// --- "Same seed" beside Restart and Play again: one setting, both boxes, labelled with the seed ------
{
  const { UI } = loadUI();
  const ui = Object.create(UI.prototype);
  const box = () => ({ checked: false, dataset: { setting: 'restartSameSeed' } });
  const boxes = [box(), box()], labels = [el('b'), el('b')];
  ui.app = { settings: { restartSameSeed: false }, setSetting(k, v) { this.settings[k] = v; }, sfx() {}, wake() {} };
  ui.el = { sameSeed: boxes, sameSeedVal: labels };
  ui.root = { querySelectorAll: (sel) => (sel === '[data-setting="restartSameSeed"]' ? boxes : []) };
  ui._syncRestart('K7QP2M');
  assert.deepStrictEqual(boxes.map((b) => b.checked), [false, false], 'unticked by default');
  assert.deepStrictEqual(labels.map((l) => l.textContent), ['(K7QP2M)', '(K7QP2M)'], 'shows the seed it would replay');
  boxes[1].checked = true;                            // ticked on the game-over screen
  ui._onChange({ target: boxes[1] });
  assert.strictEqual(ui.app.settings.restartSameSeed, true);
  assert.deepStrictEqual(boxes.map((b) => b.checked), [true, true], 'the pause menu box follows');
  boxes[0].checked = false;
  ui._onChange({ target: boxes[0] });
  assert.deepStrictEqual(boxes.map((b) => b.checked), [false, false]);
  assert.strictEqual(ui.app.settings.restartSameSeed, false);
}

// --- TT.App: restart seeds, the restartSameSeed setting, the portrait lock --------------------------
{
  local.clear();
  loadUI();
  const realDoc = global.document;
  global.document = {
    readyState: 'loading', addEventListener() {},      // boot() never runs here
    getElementById: () => ({ getBoundingClientRect: () => ({ width: 0, height: 0 }) }),
    documentElement: { classList: { toggle() {} } }
  };
  globalThis.performance = { now: () => 5000 };
  let standalone = false, coarse = false;
  const locks = [];
  window.matchMedia = (q) => ({ matches: (q === '(display-mode: standalone)' && standalone) || (q === '(any-pointer: coarse)' && coarse) });
  global.screen = { orientation: { lock: (o) => { locks.push(o); return Promise.reject(new Error('NotSupportedError')); } } };
  try {
    delete require.cache[require.resolve(MAIN_FILE)];
    require(MAIN_FILE);
    const App = TT.App;
    const settingsKey = TT.Storage.KEYS.settings;

    // Settings: off by default, also for settings saved before the option existed
    assert.strictEqual(App.loadSettings().restartSameSeed, false, 'a new player: off');
    local.set(settingsKey, JSON.stringify({ mode: 'fixed', sound: false, enabledTypes: TT.SPECIAL_KEYS }));
    loadUI();
    let s = App.loadSettings();
    assert.ok(s.restartSameSeed === false && s.mode === 'fixed' && s.sound === false, 'older settings: off, the rest kept');
    local.set(settingsKey, JSON.stringify({ restartSameSeed: 'yes' }));
    loadUI();
    assert.strictEqual(App.loadSettings().restartSameSeed, false, 'junk: off');
    local.set(settingsKey, JSON.stringify({ restartSameSeed: true }));
    loadUI();
    assert.strictEqual(App.loadSettings().restartSameSeed, true);
    // Block sets saved while pebble and crumble existed (with and without knownTypes) still load:
    // removed keys are dropped, the rest of the choice is kept, types added since start enabled
    const removed = ['pebble', 'crumble'];
    const knownThen = TT.SPECIAL_KEYS.filter((k) => !removed.includes(k)).concat(removed);
    for (const saved of [
      { enabledTypes: ['steel', 'pebble', 'crumble', 'mine', 'bogus'], knownTypes: knownThen },
      { enabledTypes: ['steel', 'pebble', 'crumble', 'mine'] }   // first release: no knownTypes
    ]) {
      local.set(settingsKey, JSON.stringify(saved));
      loadUI();
      const types = App.loadSettings().enabledTypes;
      assert.ok(types.every((k) => TT.SPECIAL_KEYS.includes(k)), 'only current special types: ' + types);
      assert.ok(types.includes('steel') && types.includes('mine'), 'the saved choice is kept');
      for (const k of removed) if (!TT.SPECIAL_KEYS.includes(k)) assert.ok(!types.includes(k), k + ' is gone');
      assert.ok(!types.includes('vine') && !types.includes('blackhole'), 'types switched off stay off');
      if (!saved.knownTypes) assert.ok(types.includes('rubber') && types.includes('spikes'), 'types added since start enabled');
    }
    local.clear();
    loadUI();

    App.settings = App.loadSettings();
    App.ui = { bindGame() {}, closeAll() {}, show() {}, toast() {}, onLayout() {}, syncSettings() {}, isMenuOpen: () => false };
    App.input = { reset() {}, releaseAll() {}, isActive: () => false };
    App.renderer = null;
    App.audio = null;
    App.setSetting('restartSameSeed', true);
    assert.strictEqual(JSON.parse(local.get(settingsKey)).restartSameSeed, true, 'saved');
    loadUI();
    assert.strictEqual(App.loadSettings().restartSameSeed, true, 'and loaded again on the next start');
    App.setSetting('restartSameSeed', false);
    assert.strictEqual(JSON.parse(local.get(settingsKey)).restartSameSeed, false);

    // Restart / Play again: a new random seed by default, mode and block set kept
    const set = ['steel', 'mine', 'vine'];
    App.startGame({ seed: 'OLDSEED', mode: 'fixed', enabledTypes: set });
    assert.strictEqual(App.game.seed, 'OLDSEED');
    const seen = new Set(['OLDSEED']);
    for (let i = 0; i < 5; i++) {
      const prev = App.game.seed;
      App.restart();
      assert.notStrictEqual(App.game.seed, prev, 'restart: a new seed');
      assert.ok(/^[A-Z0-9]{6}$/.test(App.game.seed), 'a random seed: ' + App.game.seed);
      assert.strictEqual(App.game.mode, 'fixed', 'mode kept');
      assert.deepStrictEqual(Array.from(App.game.enabledTypes).sort(), set.slice().sort(), 'block set kept');
      seen.add(App.game.seed);
    }
    assert.strictEqual(seen.size, 6, 'every restart a different seed');
    // Same seed ticked: the seed replays
    App.setSetting('restartSameSeed', true);
    const same = App.game.seed;
    App.restart();
    assert.strictEqual(App.game.seed, same, 'Same seed: replayed');
    App.restart();
    assert.strictEqual(App.game.seed, same);
    // An explicit option overrides the box either way
    App.restart({ sameSeed: false });
    assert.notStrictEqual(App.game.seed, same, '{ sameSeed: false } overrides the box');
    App.setSetting('restartSameSeed', false);
    const again = App.game.seed;
    App.restart({ sameSeed: true });
    assert.strictEqual(App.game.seed, again, '{ sameSeed: true } overrides the box');

    // Portrait lock: only an installed app on a touch device; a refusal is swallowed
    locks.length = 0;
    assert.strictEqual(App.lockPortrait(), false, 'a browser tab: no lock');
    standalone = true;
    assert.strictEqual(App.lockPortrait(), false, 'installed on a desktop without touch: no lock');
    coarse = true;
    assert.strictEqual(App.lockPortrait(), true, 'installed on a phone: locked');
    assert.deepStrictEqual(locks, ['portrait-primary']);
    App.restart();
    assert.deepStrictEqual(locks, ['portrait-primary', 'portrait-primary'], 'again when a game starts');
    global.screen = { orientation: { lock: () => { throw new Error('SecurityError'); } } };
    assert.strictEqual(App.lockPortrait(), false, 'a lock that throws is harmless');
    global.screen = {};
    assert.strictEqual(App.lockPortrait(), false, 'no Screen Orientation API: nothing to do');
    delete global.screen;
    assert.strictEqual(App.lockPortrait(), false);
  } finally {
    delete global.screen;
    delete window.matchMedia;
    if (realDoc === undefined) delete global.document; else global.document = realDoc;
  }
}

// --- "?" badges on special blocks, block cards and the explorer: they pause, closing resumes -------
{
  local.clear();
  const { UI } = loadUI();
  const realDoc = global.document;
  global.document = {
    readyState: 'loading', addEventListener() {}, activeElement: null, createElement: el,   // boot() never runs
    getElementById: () => ({ getBoundingClientRect: () => ({ width: 0, height: 0 }) }),
    documentElement: { classList: { toggle() {} } }
  };
  globalThis.performance = { now: () => 5000 };
  try {
    delete require.cache[require.resolve(MAIN_FILE)];
    require(MAIN_FILE);
    const App = TT.App;
    const pct = TT.UI.formatPct;
    App.settings = App.loadSettings();
    App.renderer = null;
    App.audio = null;
    let pressing = false, releases = 0;
    App.input = { reset() {}, releaseAll() { releases++; }, isActive: () => false, isPressing: () => pressing };

    // The real UI screen stack, slots, explorer and card over a fake DOM
    const ui = Object.create(UI.prototype);
    const screen = (name) => Object.assign(el('section'), { name, querySelector: () => null, querySelectorAll: () => [], contains: () => false });
    Object.assign(ui, {
      app: App, game: null, stack: [], hud: {}, _exploreRows: [], _info: null, _overAt: -Infinity, _dirtyPreviews: true,
      _toasts: [], _toastQueue: [], _toastNext: 0,
      root: Object.assign(el('div'), { contains: () => true, querySelector: () => el('div'), querySelectorAll: () => [] }),
      screens: { pause: screen('pause'), odds: screen('odds'), explore: screen('explore'), blockinfo: screen('blockinfo') },
      el: {
        exploreBody: el('div'),
        info: {
          panel: el('div'), canvas: el('canvas'), cat: el('p'), name: el('h2'), desc: el('p'),
          unlock: el('dd'), odds: el('dd'), note: el('p'), all: el('button')
        }
      }
    });
    ui.bindGame = (g) => { ui.game = g; };
    ui._syncInert = () => {};
    ui._focusInitial = () => {};
    ui._prepPause = () => {};
    ui._buildOdds();
    App.ui = ui;
    const card = ui.el.info;
    const names = () => ui.stack.map((s) => s.name);
    const key = (k, extra) => Object.assign({
      key: k, repeat: false, ctrlKey: false, metaKey: false, altKey: false, target: null, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }
    }, extra || {});
    // A pointer click on a HUD / tray button
    const button = (dataset) => {
      const b = { dataset, blurs: 0, blur() { b.blurs++; } };
      b.closest = (sel) => (sel === '[data-action]' ? b : sel === '.hud' ? {} : null);
      return b;
    };
    const badge = (i) => button({ action: 'block-info', help: String(i) });

    // The badge is on the special blocks of the tray only (cold / warm), and only while they wait
    const mkSlot = (i) => {
      const btn = el('button');
      btn.dataset.slot = String(i);
      const help = el('button');
      help.hidden = true;
      return { btn, canvas: el('canvas'), name: el('span'), cat: el('span'), help, spec: undefined, used: null, sel: null, helpKey: undefined };
    };
    ui.slots = [0, 1, 2].map(mkSlot);
    const tray = [
      { spec: { n: 0, typeKey: 'normal', shapeId: 'T0' }, used: false },
      { spec: { n: 1, typeKey: 'steel', shapeId: 'L0' }, used: false },
      { spec: { n: 2, typeKey: 'mine', shapeId: 'O0' }, used: false }
    ];
    const syncTray = () => tray.forEach((b, i) => ui._syncSlot(ui.slots[i], b, i === 0));
    const shown = () => ui.slots.map((s) => !s.help.hidden);
    syncTray();
    assert.deepStrictEqual(shown(), [false, true, true], 'a "?" on the special blocks, none on stone');
    assert.ok(ui.slots[1].help.classList.contains('cat-positive') && ui.slots[2].help.classList.contains('cat-negative'),
      'cold for a good block, warm for a bad one');
    assert.strictEqual(ui.slots[2].help.getAttribute('aria-label'), 'What does Mine do?');
    let helpSyncs = 0;
    const syncHelp = ui._syncHelp;
    ui._syncHelp = function (...a) { helpSyncs++; return syncHelp.apply(this, a); };
    for (let i = 0; i < 5; i++) syncTray();
    assert.strictEqual(helpSyncs, 0, 'the DOM changes only when the slot does');
    tray[2].used = true;
    syncTray();
    assert.deepStrictEqual(shown(), [false, true, false], 'gone once the block is placed');
    ui._syncSlot(ui.slots[1], null, false);
    assert.deepStrictEqual(shown(), [false, false, false], 'none while the next batch is on its way');
    ui._syncSlot(ui.slots[0], { spec: { n: 3, typeKey: 'vine', shapeId: 'S0' }, used: false }, true);
    assert.ok(shown()[0] && ui.slots[0].help.classList.contains('cat-positive'), 'a new batch: the badge follows its block');
    ui._syncSlot(ui.slots[0], { spec: { n: 4, typeKey: 'rubber', shapeId: 'S0' }, used: false }, true);
    assert.ok(ui.slots[0].help.classList.contains('cat-negative') && !ui.slots[0].help.classList.contains('cat-positive'));
    ui._syncHelp = syncHelp;

    // A run with Vine switched off; slot 2 holds a Steel, slot 3 a Mine
    const off = TT.SPECIAL_KEYS.filter((k) => k !== 'vine');
    App.startGame({ seed: 'HELPUI', mode: 'assisted', enabledTypes: off });
    const g = App.game;
    for (let i = 0; i < 5 && !g.piece; i++) g.update(1 / 60);
    assert.ok(g.piece && g.batch.length === 3 && g.state === 'playing');
    g.batch[1].spec.typeKey = 'steel';
    g.batch[2].spec.typeKey = 'mine';
    const sel0 = g.selected, x0 = g.piece.x;
    let selects = 0, drops = 0;
    g.on('select', () => selects++);
    g.on('drop', () => drops++);
    const untouched = (what) => {
      assert.ok(g.selected === sel0 && selects === 0 && g.piece.x === x0, what + ': nothing selected or moved');
      assert.ok(g.turn === 0 && drops === 0 && !g.batch[1].used && !g.batch[2].used, what + ': nothing dropped');
    };

    // Pressing the badge of block 2 opens that block's card: the game pauses until it closes
    const r0 = releases;
    ui._onClick({ target: badge(1), detail: 1 });
    assert.strictEqual(g.state, 'paused', 'the card pauses the game');
    assert.deepStrictEqual(names(), ['blockinfo']);
    assert.ok(releases > r0, 'a block in hand goes back first');
    assert.strictEqual(card.name.textContent, 'Steel');
    assert.strictEqual(card.cat.textContent, 'Good block');
    assert.strictEqual(card.desc.textContent, TT.BLOCK_TYPES.steel.desc);
    assert.strictEqual(card.unlock.textContent, 'From the start');
    assert.strictEqual(card.odds.textContent, pct(g.odds.types.steel), 'its current odds');
    assert.ok(card.panel.classList.contains('cat-positive') && !card.odds.classList.contains('is-dim'));
    assert.strictEqual(ui._info.spec, g.batch[1].spec, 'the dealt block is previewed exactly as it will look');
    assert.ok(!card.all.hidden, '"All special blocks" is offered');
    untouched('badge');
    ui._run('back', button({ action: 'back' }));                 // Close
    assert.deepStrictEqual(names(), []);
    assert.strictEqual(g.state, 'playing', 'closing the card resumes');
    // A bad block that is not unlocked yet; Esc closes
    ui._onClick({ target: badge(2), detail: 1 });
    assert.ok(g.state === 'paused' && card.name.textContent === 'Mine' && card.cat.textContent === 'Bad block');
    assert.ok(card.panel.classList.contains('cat-negative') && !card.panel.classList.contains('cat-positive'));
    assert.strictEqual(card.unlock.textContent, 'From ' + TT.BLOCK_TYPES.mine.unlock + ' m');
    assert.strictEqual(card.odds.textContent, 'unlocks at ' + TT.BLOCK_TYPES.mine.unlock + ' m');
    assert.ok(card.odds.classList.contains('is-dim'));
    const esc = key('Escape');
    ui._onKey(esc);
    assert.ok(esc.defaultPrevented && !names().length && g.state === 'playing', 'Esc closes it and resumes');
    untouched('second badge');
    // A switched-off block says so
    assert.ok(App.showBlockInfo('vine'));
    assert.strictEqual(card.odds.textContent, 'off');
    ui.back();
    // Another finger while a block is dragged: ignored like any extra finger
    pressing = true;
    ui._onClick({ target: badge(1), detail: 1 });
    assert.ok(g.state === 'playing' && !names().length, 'no card mid-drag');
    pressing = false;
    // Only special blocks have a card; nothing while the run is ending
    assert.strictEqual(App.showBlockInfo('normal'), false);
    assert.strictEqual(App.showBlockInfo('bogus'), false);
    g.ending = true;
    assert.ok(!App.showBlockInfo('steel') && !App.showExplorer() && g.state === 'playing', 'not during the final collapse');
    g.ending = false;
    // Already paused (pause menu): the card opens on top and closing goes back there, still paused
    App.pause();
    assert.deepStrictEqual(names(), ['pause']);
    assert.ok(App.showBlockInfo('frost'));
    assert.deepStrictEqual(names(), ['pause', 'blockinfo']);
    assert.strictEqual(ui._info.spec.n, -1, 'a sample block when it is not in the tray');
    ui.back();
    assert.deepStrictEqual(names(), ['pause']);
    assert.strictEqual(g.state, 'paused', 'it was paused before: it stays paused');
    App.resume();
    assert.strictEqual(g.state, 'playing');

    // The "?" button in the HUD: the explorer of every special block, grouped good / bad
    const tip = Object.assign(el('div'), { _opts: { id: 'drag-tip', kind: 'info' } });
    const warn = Object.assign(el('div'), { _opts: { kind: 'warn' } });
    ui._toasts.push(tip, warn);
    const helpBtn = button({ action: 'explore' });
    ui._onClick({ target: helpBtn, detail: 1 });
    assert.strictEqual(g.state, 'paused', 'the explorer pauses the game');
    assert.deepStrictEqual(names(), ['explore']);
    assert.strictEqual(helpBtn.blurs, 1, 'the HUD button lets go of the focus');
    assert.deepStrictEqual(ui._toasts, [warn], 'a tip would cover the panel header: it goes (warnings stay)');
    ui._toasts.length = 0;
    const rows = findAll(ui.el.exploreBody, (n) => n.dataset.action === 'explore-row');
    assert.deepStrictEqual(rows.map((r) => r.dataset.key).sort(), TT.SPECIAL_KEYS.slice().sort(), 'every special block, once');
    const groups = findAll(ui.el.exploreBody, (n) => n.tagName === 'SECTION');
    const keysIn = (sec) => findAll(sec, (n) => n.dataset.action === 'explore-row').map((r) => r.dataset.key).sort();
    assert.ok(groups.length === 2 && groups[0].classList.contains('group-positive') && groups[1].classList.contains('group-negative'));
    assert.deepStrictEqual(keysIn(groups[0]), TT.POSITIVE_KEYS.slice().sort(), 'good blocks first');
    assert.deepStrictEqual(keysIn(groups[1]), TT.NEGATIVE_KEYS.slice().sort(), 'then the bad ones');
    const row = (k) => rows.find((r) => r.dataset.key === k);
    const part = (r, cls) => findAll(r, (n) => n.className === cls)[0].textContent;
    for (const k of TT.SPECIAL_KEYS) {
      const t = TT.BLOCK_TYPES[k];
      assert.strictEqual(part(row(k), 'explore-name'), t.name);
      assert.strictEqual(part(row(k), 'explore-desc'), t.desc, k + ': what it does');
      assert.strictEqual(part(row(k), 'explore-unlock'), t.unlock > 0 ? 'Appears from ' + t.unlock + ' m' : 'Appears from the start');
      assert.ok(findAll(row(k), (n) => n.dataset.preview === k).length === 1, k + ': a preview');
    }
    assert.strictEqual(part(row('steel'), 'explore-val'), pct(g.odds.types.steel), 'current odds');
    assert.ok(row('steel').classList.contains('is-on'));
    assert.strictEqual(part(row('vine'), 'explore-val'), 'off', 'switched off for this run');
    assert.ok(row('vine').classList.contains('is-off'));
    assert.strictEqual(part(row('blackhole'), 'explore-val'), 'unlocks at ' + TT.BLOCK_TYPES.blackhole.unlock + ' m');
    assert.ok(row('blackhole').classList.contains('is-locked'));
    // A row opens its card over the list; Close comes back to it, with that row marked
    ui._run('explore-row', row('crystal'));
    assert.deepStrictEqual(names(), ['explore', 'blockinfo']);
    assert.ok(card.name.textContent === 'Crystal Heart' && card.all.hidden, 'no "All special blocks" link back to where it came from');
    ui.back();
    assert.deepStrictEqual(names(), ['explore']);
    assert.ok(g.state === 'paused' && row('crystal').classList.contains('is-current'), 'back in the list, still paused');
    ui._run('back', button({ action: 'back' }));
    assert.ok(!names().length && g.state === 'playing', 'closing the explorer resumes');
    // From a card opened in the tray, "All special blocks" takes the card's place
    ui._onClick({ target: badge(2), detail: 1 });
    ui._run('explore', card.all);
    assert.deepStrictEqual(names(), ['explore']);
    assert.ok(row('mine').classList.contains('is-current') && !row('crystal').classList.contains('is-current'), 'that block marked');
    ui.back();
    assert.ok(!names().length && g.state === 'playing', 'one Close back to the game');
    untouched('explorer');

    // Keys in the menus: ? / H toggle the explorer (also from the pause menu or a card), P resumes
    App.showExplorer();
    let ev = key('?', { shiftKey: true });
    ui._onKey(ev);
    assert.ok(ev.defaultPrevented && !names().length && g.state === 'playing', '? closes the explorer');
    App.pause();
    ui._onKey(key('h'));
    assert.deepStrictEqual(names(), ['pause', 'explore'], 'H from the pause menu opens it on top');
    ui._onKey(key('H', { shiftKey: true }));
    assert.deepStrictEqual(names(), ['pause'], '...and closes it again');
    App.resume();
    ui._onClick({ target: badge(1), detail: 1 });
    ui._onKey(key('?', { shiftKey: true }));
    assert.deepStrictEqual(names(), ['explore'], '? on a card: the full list');
    ev = key('p');
    ui._onKey(ev);
    assert.ok(ev.defaultPrevented && !names().length && g.state === 'playing', 'P resumes from the explorer');
    App.showBlockInfo('magnet');
    ui._onKey(key('P', { shiftKey: true }));
    assert.ok(!names().length && g.state === 'playing', '...and from a card');
    ev = key('?', { shiftKey: true });
    ui._onKey(ev);
    assert.ok(!ev.defaultPrevented && !names().length, 'in play the keys are TT.Input\'s');
    untouched('keys');
  } finally {
    if (realDoc === undefined) delete global.document; else global.document = realDoc;
  }
}

// --- Pending run snapshot ---------------------------------------------------------------------
{
  local.clear();
  let { Records, Storage } = loadUI();
  // A run in progress is hidden, then killed: the snapshot is not a record yet...
  assert.strictEqual(Records.savePending({ seed: 'KILLED', rules: '', bestHeight: 3.13, elapsed: 12.4 }), true);
  assert.ok(local.has(Storage.KEYS.pending));
  assert.strictEqual(Records.get('KILLED', ''), null, 'not a record while the run may still go on');
  // ...and the next start submits it
  ({ Records } = loadUI());
  const r = Records.flushPending();
  assert.ok(r && r.isNew && r.isTop, 'submitted at start-up');
  assert.strictEqual(Records.get('KILLED', '').height, 3.1);
  assert.strictEqual(Records.get('KILLED', '').time, 12);
  assert.ok(!local.has(Storage.KEYS.pending), 'cleared after submitting');
  assert.strictEqual(Records.flushPending(), null, 'only once');
  // A lower snapshot never lowers a record
  Records.savePending({ seed: 'KILLED', rules: '', bestHeight: 2, elapsed: 5 });
  ({ Records } = loadUI());
  Records.flushPending();
  assert.strictEqual(Records.get('KILLED', '').height, 3.1);

  // The game-over badge is untouched: hidden mid-run (snapshot), then the run ends normally
  Records.savePending({ seed: 'BADGE', rules: 'no:mine', bestHeight: 6.04, elapsed: 30 });
  Records.clearPending();                                   // recordRun
  const over = Records.submit({ seed: 'BADGE', rules: 'no:mine', bestHeight: 6.04, elapsed: 30 });
  assert.ok(over.isNew && over.isTop && over.previous === null, 'game over still reports a new best');
  ({ Records } = loadUI());
  assert.strictEqual(Records.flushPending(), null, 'nothing left to submit');
  assert.strictEqual(Records.get('BADGE', 'no:mine').height, 6);

  // Nothing worth keeping, or junk in storage
  assert.strictEqual(Records.savePending({ seed: 'ZERO', rules: '', bestHeight: 0, elapsed: 3 }), false);
  assert.ok(!local.has(Storage.KEYS.pending));
  for (const junk of ['{"seed":5}', '"text"', 'not json', '{"seed":"X","rules":"","bestHeight":"NaN"}', 'null']) {
    local.set(Storage.KEYS.pending, junk);
    ({ Records } = loadUI());
    assert.strictEqual(Records.flushPending(), null, 'junk ignored: ' + junk);
    assert.ok(!local.has(Storage.KEYS.pending), 'junk removed: ' + junk);
  }
  assert.strictEqual(Records.get('X', ''), null);
}

// --- Toasts: one compact toast at a time on short playfields, intros wait, placement -----------
{
  local.clear();                                   // a fresh player: no block seen yet
  const { UI, Seen, Storage } = loadUI();
  // Just enough DOM for the toast code
  const el = (tag) => {
    const cls = new Set();
    const n = {
      tagName: tag.toUpperCase(), children: [], parent: null, dataset: {}, textContent: '',
      clientWidth: 0, clientHeight: 0, offsetHeight: 0, style: { setProperty() {} },
      set className(v) { cls.clear(); for (const c of String(v).split(/\s+/)) if (c) cls.add(c); },
      get className() { return Array.from(cls).join(' '); },
      classList: {
        add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c),
        toggle: (c, on) => { if (on === undefined ? !cls.has(c) : on) cls.add(c); else cls.delete(c); }
      },
      appendChild(c) { c.parent = n; n.children.push(c); return c; },
      remove() { if (n.parent) { n.parent.children.splice(n.parent.children.indexOf(n), 1); n.parent = null; } }
    };
    return n;
  };
  global.document = { createElement: el };
  let now = 0;
  globalThis.performance = { now: () => now };
  const timers = [];
  const realSet = global.setTimeout, realClear = global.clearTimeout;
  global.setTimeout = (fn, ms) => { timers.push({ fn, ms, done: false }); return timers.length; };
  global.clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].done = true; };
  const fire = (ms) => { for (const t of timers.slice()) if (!t.done && t.ms === ms) { t.done = true; t.fn(); } };
  try {
    const box = el('div');
    let stageH = 700;
    const ui = Object.assign(Object.create(UI.prototype), {
      stack: [], _toasts: [], _toastQueue: [], _toastNext: 0, _toastTop: null, _toastH: -1, _compact: false,
      _stageH: 0, _chipClear: 0, _pt: { x: 0, y: 0 }, app: { renderer: null },
      el: {
        toasts: box,
        stage: { getBoundingClientRect: () => ({ height: stageH, bottom: 56 + stageH }) },
        oddsChip: { getBoundingClientRect: () => ({ height: 44, top: 56 + stageH - 52 }) }
      }
    });
    const shown = () => ui._toasts.map((t) => t._opts.intro || t._opts.id || t._opts.kind);
    const intro = (key) => ({ title: 'New block: ' + key, text: '...', kind: 'negative', time: 6.5, intro: key });

    // Tall playfield: up to three at once
    ui.onLayout();
    assert.ok(!ui._compact && !box.classList.contains('is-compact'));
    ui.toast(intro('rubber'));
    ui.toast(intro('steel'));
    assert.deepStrictEqual(shown(), ['rubber', 'steel']);
    // Rotated to landscape: a short playfield keeps one compact toast, the other intro waits
    stageH = 360;
    ui.onLayout();
    assert.ok(ui._compact && box.classList.contains('is-compact'), 'short playfield is compact');
    assert.strictEqual(ui._chipClear, 52, 'clearance above the odds chip');
    assert.deepStrictEqual(shown(), ['steel']);
    assert.deepStrictEqual(ui._toastQueue.map((o) => o.intro), ['rubber'], 'the older intro waits');
    ui._toastQueue.length = 0;
    ui._dropToast(ui._toasts[0]);
    Storage.remove(Storage.KEYS.seen);
    Seen._set = null;

    // One at a time; an intro counts as seen only once it is shown
    ui.toast(intro('rubber'));
    ui.toast(intro('steel'));
    assert.deepStrictEqual(shown(), ['rubber']);
    assert.ok(Seen.has('rubber') && !Seen.has('steel'), 'the waiting intro is not marked seen yet');
    ui._updateToasts({ piece: null });
    assert.deepStrictEqual(shown(), ['rubber'], 'no free spot');
    // Feedback toasts show at once; the intro they push out waits for its turn again
    ui.toast({ id: 'mode', title: 'Manual mode', time: 2.2 });
    assert.deepStrictEqual(shown(), ['mode']);
    assert.deepStrictEqual(ui._toastQueue.map((o) => o.intro), ['rubber', 'steel']);
    ui.toast({ id: 'mode', title: 'Assisted mode', time: 2.2 });
    assert.deepStrictEqual(shown(), ['mode'], 'same id replaces');
    fire(2200);                                    // the mode toast times out
    ui._updateToasts({ piece: null });
    assert.deepStrictEqual(shown(), [], 'a short pause before the next one');
    now += 400;
    ui.stack.push({ name: 'pause' });
    ui._updateToasts({ piece: null });
    assert.deepStrictEqual(shown(), [], 'nothing new while a menu is open');
    ui.stack.length = 0;
    ui._updateToasts({ piece: null });
    assert.deepStrictEqual(shown(), ['rubber']);
    // A press on the playfield dismisses it; the next intro follows
    ui._dismissToasts();
    assert.deepStrictEqual(shown(), []);
    now += 400;
    ui._updateToasts({ piece: null });
    assert.deepStrictEqual(shown(), ['steel']);
    assert.ok(Seen.has('steel'));
    ui.toast({ title: 'The game could not start', kind: 'warn' });
    ui._dismissToasts();
    assert.deepStrictEqual(shown(), ['warn'], 'warnings are not dismissed by play');
    ui._dropToast(ui._toasts[0]);
    now += 400;
    ui._updateToasts({ piece: null });
    assert.deepStrictEqual(shown(), ['steel'], 'the pushed-out intro came back');

    // Placement: top while the piece is low on screen, bottom once the camera follows the tower up
    box.offsetHeight = 36;
    ui._toastH = -1;
    ui._toastTop = null;
    ui.app.renderer = { scale: 20, worldToScreen: (x, y, o) => { o.x = x * 20; o.y = (18 - y) * 20; return o; } };
    const game = (pieceY, ghostY, voidGhost) => ({ piece: { y: pieceY, shape: { h: 2 } }, ghost: { y: ghostY, void: !!voidGhost } });
    ui._updateToasts(game(5, 1));                  // piece top 220 px, ghost bottom 340 px of 360
    assert.ok(ui._toastTop === true && box.classList.contains('at-top'), 'low tower: top');
    ui._updateToasts(game(15, 11));                // piece top 20 px: the top would cover it
    assert.ok(ui._toastTop === false && !box.classList.contains('at-top'), 'tall tower: bottom');
    ui._updateToasts(game(15, 2));                 // both sides blocked: stays put
    assert.strictEqual(ui._toastTop, false);
    ui._updateToasts(game(9, 5));                  // both sides free: stays put
    assert.strictEqual(ui._toastTop, false);
    ui._updateToasts(game(6, 1));                  // the bottom would cover the ghost, the top is free
    assert.strictEqual(ui._toastTop, true);
    ui._updateToasts(game(15, 0, true));           // void drop: only the piece matters
    assert.strictEqual(ui._toastTop, false);
    ui._dismissToasts();
    ui._updateToasts(game(15, 11));
    assert.strictEqual(ui._toastTop, null, 'decided afresh for the next toast');
  } finally {
    global.setTimeout = realSet;
    global.clearTimeout = realClear;
    delete global.document;
  }
}

// --- Back guard ---------------------------------------------------------------------------------
class FakeHistory {
  constructor(states) {
    this.entries = (states || [null]).map((s) => ({ state: s }));
    this.index = this.entries.length - 1;
    this.pending = [];   // history.back() traversals not delivered yet
    this.left = false;   // Back went past the first entry: the app closed
  }
  get state() { return this.entries[this.index].state; }
  get length() { return this.entries.length; }
  pushState(state) { this.entries.splice(this.index + 1); this.entries.push({ state }); this.index++; }
  replaceState(state) { this.entries[this.index] = { state }; }
  back() { this.pending.push(-1); }
  deliver(guard) {   // the browser runs the queued traversals and fires popstate
    while (this.pending.length) {
      this.pending.shift();
      if (this.index === 0) { this.left = true; continue; }
      this.index--;
      guard.onPopState({ state: this.state });
    }
  }
  userBack(guard) {  // the system Back button / gesture
    if (this.index === 0) { this.left = true; return; }
    this.index--;
    guard.onPopState({ state: this.state });
  }
}

// A tiny app with the same Back rules as main.js
function makeApp(history) {
  const { BackGuard } = TT.UI;
  const app = {
    game: null,         // null | 'playing' | 'paused' | 'over'
    screens: ['title'],
    top() { return this.screens[this.screens.length - 1] || null; },
    nav() { app.guard.sync(); },
    open(name) { this.screens.push(name); this.nav(); },
    close() { this.screens.pop(); if (!this.screens.length && this.game === 'paused') this.game = 'playing'; this.nav(); },
    start() { this.game = 'playing'; this.screens = []; this.nav(); },
    pause() { this.game = 'paused'; this.screens = ['pause']; this.nav(); },
    quit() { this.game = null; this.screens = ['title']; this.nav(); },
    over() { this.game = 'over'; this.screens = ['over']; this.nav(); }
  };
  app.guard = new BackGuard({
    history,
    wanted: () => !!app.game || (!!app.top() && app.top() !== 'title'),
    onBack: () => {
      const top = app.top();
      if (top === 'over') app.quit();
      else if (top && top !== 'title') app.close();
      else if (!top) app.pause();
    }
  });
  return app;
}

{
  // Title -> How to Play -> Back closes it; Back again leaves the app
  const h = new FakeHistory();
  const app = makeApp(h);
  app.nav();
  assert.strictEqual(h.length, 1, 'no guard on the title');
  app.open('howto');
  assert.strictEqual(h.length, 2, 'a menu over the title pushes the guard');
  h.userBack(app.guard);
  assert.deepStrictEqual(app.screens, ['title'], 'Back closed How to Play');
  assert.ok(!h.left);
  h.userBack(app.guard);
  assert.ok(h.left, 'Back on the title leaves');
}
{
  // A run: Back pauses, Back again resumes, the app never leaves; the guard is always on top
  const h = new FakeHistory();
  const app = makeApp(h);
  app.nav();
  app.start();
  assert.strictEqual(h.index, 1);
  h.userBack(app.guard);
  assert.strictEqual(app.game, 'paused');
  assert.deepStrictEqual(app.screens, ['pause'], 'Back paused the game and shows the pause menu');
  assert.strictEqual(h.index, 1, 'guard pushed again');
  app.open('settings');
  h.userBack(app.guard);
  assert.deepStrictEqual(app.screens, ['pause'], 'Back closed Settings (back to the pause menu)');
  h.userBack(app.guard);
  assert.strictEqual(app.game, 'playing', 'Back on the pause menu resumes');
  for (let i = 0; i < 5; i++) h.userBack(app.guard);
  assert.ok(!h.left && h.index === 1 && h.length === 2, 'never leaves during a run, history does not grow');
  // Game over: Back goes to the menu, then Back leaves
  app.over();
  h.userBack(app.guard);
  assert.strictEqual(app.game, null);
  assert.deepStrictEqual(app.screens, ['title'], 'Back on game over opens the menu');
  h.userBack(app.guard);
  assert.ok(h.left, 'then Back leaves');
}
{
  // Quit to menu in the app: the guard is taken down, so the next Back leaves at once
  const h = new FakeHistory();
  const app = makeApp(h);
  app.nav();
  app.start();
  app.quit();
  assert.ok(app.guard.leaving, 'history.back() on its way');
  app.nav();                                          // other UI changes meanwhile do not push
  assert.strictEqual(h.pending.length, 1);
  h.deliver(app.guard);
  assert.ok(!app.guard.leaving && !app.guard.active && h.index === 0, 'our own popstate was ignored');
  assert.deepStrictEqual(app.screens, ['title']);
  h.userBack(app.guard);
  assert.ok(h.left, 'Back from the title leaves (no dead press)');
}
{
  // A menu opened while the guard was being taken down gets a fresh guard afterwards
  const h = new FakeHistory();
  const app = makeApp(h);
  app.nav();
  app.start();
  app.quit();
  app.open('settings');
  h.deliver(app.guard);
  assert.ok(app.guard.active && h.index === 1, 'guard back up for Settings');
  h.userBack(app.guard);
  assert.deepStrictEqual(app.screens, ['title']);
  assert.ok(!h.left);
}
{
  // Reloaded while a guard entry was current: it becomes a plain entry
  const h = new FakeHistory([null, { tetrowersGuard: true }]);
  const app = makeApp(h);
  assert.strictEqual(h.state, null, 'guard state replaced');
  app.nav();
  assert.strictEqual(h.length, 2, 'nothing pushed on the title');
  // Forward onto a guard entry (desktop Forward button) is not a Back
  const h2 = new FakeHistory([null, { tetrowersGuard: true }]);
  h2.index = 0;
  const app2 = makeApp(h2);
  app2.start();
  h2.userBack(app2.guard);
  assert.strictEqual(app2.game, 'paused');
}
{
  // No usable history API (sandboxed frame): nothing breaks, Back just leaves
  const h = new FakeHistory();
  h.pushState = () => { throw new Error('SecurityError'); };
  const app = makeApp(h);
  app.start();
  assert.ok(app.guard.off && !app.guard.active);
  app.guard.onPopState({ state: null });
  assert.strictEqual(app.game, 'playing', 'popstate ignored once the guard is off');
  // history.back() that never reports back: the guard gives up instead of blocking pushes forever
  const h3 = new FakeHistory();
  const app3 = makeApp(h3);
  const realTimeout = global.setTimeout;
  let fire = null;
  global.setTimeout = (fn) => { fire = fn; return 1; };
  try {
    app3.start();
    app3.quit();
  } finally { global.setTimeout = realTimeout; }
  assert.ok(app3.guard.leaving && typeof fire === 'function');
  fire();
  assert.ok(app3.guard.off && !app3.guard.leaving, 'gave up after the timeout');
}

console.log('ui tests passed');
