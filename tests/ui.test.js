/* DOM-light parts of js/ui.js in Node: the Drop / slot press guard (one action per pointer press,
 * however long the hold), the pending-run snapshot (a run the OS kills still gets its record,
 * without spoiling the game-over badge), and the Back guard's history state machine. */
'use strict';
const assert = require('assert');
const path = require('path');
const TT = require('./load-core')();

const UI_FILE = path.join(__dirname, '..', 'js/ui.js');
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

// --- Drop / slot buttons: the click ending a handled press never acts again ---------------------
{
  const { UI } = loadUI();
  let clock = 0;                                   // every press below is held for 2 s
  globalThis.performance = { now: () => (clock += 1000) };
  const calls = [];
  const ui = Object.create(UI.prototype);
  ui.root = { contains: () => true };
  ui._run = (action) => calls.push(action);
  const button = (action) => {
    const b = { dataset: { action }, blur() {} };
    b.closest = (sel) => (sel === '.hud' ? null : sel.includes('[data-action') && (sel === '[data-action]' || sel.includes('"' + action + '"')) ? b : null);
    return b;
  };
  const drop = button('drop'), slot = button('slot'), pause = button('pause');

  ui._onPress({ target: drop, button: 0 });
  assert.deepStrictEqual(calls, ['drop'], 'pointerdown drops');
  ui._onClick({ target: drop, detail: 1 });          // the click after a 2 s hold (was a 2nd drop)
  assert.deepStrictEqual(calls, ['drop'], 'its click does nothing more');
  ui._onClick({ target: drop, detail: 0 });          // Enter / Space on the focused button
  assert.deepStrictEqual(calls, ['drop', 'drop'], 'keyboard activation still drops');

  ui._onPress({ target: drop, button: 2 });          // right button: ignored
  ui._onClick({ target: drop, detail: 1 });          // a click with no press of its own acts
  assert.deepStrictEqual(calls, ['drop', 'drop', 'drop']);

  calls.length = 0;
  ui._onPress({ target: slot, button: 0 });
  ui._onClick({ target: slot, detail: 1 });
  ui._onPress({ target: slot, button: 0 });
  ui._onClick({ target: slot, detail: 2 });          // double click
  assert.deepStrictEqual(calls, ['slot', 'slot'], 'slot: one action per press');

  calls.length = 0;
  ui._onPress({ target: drop, button: 0 });
  ui._onPressCancel({ target: drop });               // cancelled press: no click follows...
  ui._onClick({ target: drop, detail: 1 });          // ...so a later click is not swallowed
  assert.deepStrictEqual(calls, ['drop', 'drop'], 'pointercancel clears the press');

  calls.length = 0;
  ui._onClick({ target: pause, detail: 1 });         // other buttons act on click as before
  ui._onPress({ target: pause, button: 0 });
  assert.deepStrictEqual(calls, ['pause']);
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
