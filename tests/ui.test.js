/* DOM-light parts of js/ui.js (and TT.App from js/main.js) in Node: slot buttons leave pointer
 * presses to TT.Input (no Drop button any more), the drag cues mirror TT.Input's state, both "Same
 * seed" boxes share one setting, Restart / Play again use a new random seed unless "Same seed" is
 * ticked (persisted as restartSameSeed, false for older saves), the installed app locks portrait,
 * the pending-run snapshot (a run the OS kills still gets its record, without spoiling the
 * game-over badge), toasts, and the Back guard's history state machine. */
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

// Just enough DOM: class lists, text, style, children
function el(tag) {
  const cls = new Set();
  const n = {
    tagName: String(tag || 'div').toUpperCase(), children: [], parent: null, dataset: {}, hidden: false,
    clientWidth: 0, clientHeight: 0, offsetWidth: 0, offsetHeight: 0, style: { setProperty() {} }, writes: 0,
    _text: '',
    get textContent() { return n._text; },
    set textContent(v) { n._text = String(v); n.writes++; },
    set className(v) { cls.clear(); for (const c of String(v).split(/\s+/)) if (c) cls.add(c); },
    get className() { return Array.from(cls).join(' '); },
    classList: {
      add: (...c) => { for (const x of c) cls.add(x); }, remove: (...c) => { for (const x of c) cls.delete(x); },
      contains: (c) => cls.has(c),
      toggle: (c, on) => { if (on === undefined ? !cls.has(c) : on) cls.add(c); else cls.delete(c); }
    },
    appendChild(c) { c.parent = n; n.children.push(c); return c; },
    remove() { if (n.parent) { n.parent.children.splice(n.parent.children.indexOf(n), 1); n.parent = null; } }
  };
  return n;
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

// --- Drag cues: lifted slot, "Release to cancel" over the tray, "Dropping when ready" by the piece -----
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
  const cue = { slot: -1, zone: '', queued: false };
  // 25 px per cell, world y 24 at the top of the playfield
  ui.app = { input: { cue }, renderer: { scale: 25, worldToScreen: (x, y, o) => { o.x = x * 25; o.y = (24 - y) * 25; return o; } } };
  const game = { piece: { x: 6, y: 10, shape: { w: 2, h: 3 } }, readyProgress: 0.5 };
  const lifted = () => ui.slots.map((s) => s.btn.classList.contains('is-lifted'));
  const has = (n, c) => n.classList.contains(c);

  ui._syncDrag(game);
  assert.deepStrictEqual(lifted(), [false, false, false]);
  assert.ok(!has(tray, 'is-dragging') && !has(tray, 'is-cancel') && dropCue.hidden);
  // Picked up, still over the tray
  cue.slot = 1;
  cue.zone = 'cancel';
  ui._syncDrag(game);
  assert.deepStrictEqual(lifted(), [false, true, false], 'the dragged slot is lifted');
  assert.ok(has(tray, 'is-cancel') && !has(tray, 'is-dragging') && has(ui.root, 'is-dragging'));
  assert.strictEqual(trayCue.textContent, 'Release to cancel');
  // Over the playfield
  cue.zone = 'field';
  ui._syncDrag(game);
  assert.ok(has(tray, 'is-dragging') && !has(tray, 'is-cancel'));
  assert.ok(/drop/.test(trayCue.textContent) && /cancel/.test(trayCue.textContent), 'says how to drop and cancel');
  const writes = trayCue.writes;
  for (let i = 0; i < 5; i++) ui._syncDrag(game);
  assert.strictEqual(trayCue.writes, writes, 'the DOM changes only when the state does');
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
  assert.ok(!has(tray, 'is-cancel') && !has(ui.root, 'is-dragging') && dropCue.hidden);
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
    ui.toast(intro('pebble'));
    ui.toast(intro('steel'));
    assert.deepStrictEqual(shown(), ['pebble', 'steel']);
    // Rotated to landscape: a short playfield keeps one compact toast, the other intro waits
    stageH = 360;
    ui.onLayout();
    assert.ok(ui._compact && box.classList.contains('is-compact'), 'short playfield is compact');
    assert.strictEqual(ui._chipClear, 52, 'clearance above the odds chip');
    assert.deepStrictEqual(shown(), ['steel']);
    assert.deepStrictEqual(ui._toastQueue.map((o) => o.intro), ['pebble'], 'the older intro waits');
    ui._toastQueue.length = 0;
    ui._dropToast(ui._toasts[0]);
    Storage.remove(Storage.KEYS.seen);
    Seen._set = null;

    // One at a time; an intro counts as seen only once it is shown
    ui.toast(intro('pebble'));
    ui.toast(intro('steel'));
    assert.deepStrictEqual(shown(), ['pebble']);
    assert.ok(Seen.has('pebble') && !Seen.has('steel'), 'the waiting intro is not marked seen yet');
    ui._updateToasts({ piece: null });
    assert.deepStrictEqual(shown(), ['pebble'], 'no free spot');
    // Feedback toasts show at once; the intro they push out waits for its turn again
    ui.toast({ id: 'mode', title: 'Manual mode', time: 2.2 });
    assert.deepStrictEqual(shown(), ['mode']);
    assert.deepStrictEqual(ui._toastQueue.map((o) => o.intro), ['pebble', 'steel']);
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
    assert.deepStrictEqual(shown(), ['pebble']);
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
