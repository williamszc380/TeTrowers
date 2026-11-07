/* Input (js/input.js with a stub window/document, a fake canvas / tray / renderer and a fake clock).
 * Keyboard: Ctrl cycles the placement mode only when tapped on its own (not as part of a shortcut or
 * AltGr), a mode change while an arrow is held never replays a backlog of steps, Down / Up pick the
 * next / previous unused block (wrapping) and never drop, Space / Enter / NumpadEnter drop unless a
 * control has keyboard focus, a text field has the keys or the game is not live.
 * Pointer (touch and mouse alike): a block dragged out of the tray drops exactly once when let go over
 * the playfield, where the pointer is; back over the tray, or let go anywhere else, nothing drops; a
 * tap only selects; a drag that starts on the playfield never drops; a drop let go too early waits
 * until it is allowed and is cancelled by a new drag, selection, key move, pause or menu; cancel,
 * lost capture and blur cancel; extra fingers are ignored; moves are applied once per frame; no hover
 * aim, wheel or right-click controls. */
'use strict';
const assert = require('assert');
const path = require('path');
const TT = require('./load-core')();
const C = TT.CONFIG;

let clock = 1000;   // ms
globalThis.performance = { now: () => clock };
const listeners = {};
const target = (name) => ({
  addEventListener(t, fn) { (listeners[name + ':' + t] = listeners[name + ':' + t] || []).push(fn); },
  removeEventListener() {}
});
global.window = Object.assign(target('window'), { TT });
global.document = Object.assign(target('document'), { hidden: false, body: { tagName: 'BODY' }, activeElement: null });
require(path.join(__dirname, '..', 'js/input.js'));

const fire = (name, type, ev) => { for (const fn of listeners[name + ':' + type] || []) fn(ev); };
const key = (k, code, extra) => Object.assign({
  key: k, code, repeat: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
  defaultPrevented: false, target: null, preventDefault() { this.defaultPrevented = true; }
}, extra || {});
const down = (k, code, extra) => { const ev = key(k, code, extra); fire('window', 'keydown', ev); return ev; };
const up = (k, code, extra) => fire('window', 'keyup', key(k, code, extra));

function setup(mode) {
  for (const k of Object.keys(listeners)) delete listeners[k];
  const game = TT.Game.create({ seed: 'INPUT', mode });
  game.update(1 / 60);
  game.setPixelSize(1 / 40);
  const input = TT.Input.create({ getGame: () => game, isBlocked: () => false });
  let steps = 0;
  const step = game.moveStep.bind(game);
  game.moveStep = (d) => { steps++; return step(d); };
  return { game, input, steps: () => steps };
}

// Count drop() calls (attempts, whether or not the game allowed them)
function countDrops(game) {
  const calls = { n: 0 };
  const drop = game.drop.bind(game);
  game.drop = () => { calls.n++; return drop(); };
  return calls;
}

// Let the dropped block land until the next drop is allowed
function waitReady(game) {
  for (let i = 0; i < 900 && !game.canDrop; i++) game.update(1 / 60);
  assert.ok(game.canDrop, 'drop ready again');
}

// --- Ctrl tapped on its own cycles the mode, on release ------------------------------------
{
  const { game } = setup('assisted');
  down('Control', 'ControlLeft', { ctrlKey: true });
  assert.strictEqual(game.mode, 'assisted', 'nothing happens while Ctrl is still down');
  down('Control', 'ControlLeft', { ctrlKey: true, repeat: true });   // OS auto-repeat of Ctrl itself
  up('Control', 'ControlLeft');
  assert.strictEqual(game.mode, 'fixed', 'released on its own: next mode');
  down('Control', 'ControlRight', { ctrlKey: true });
  up('Control', 'ControlRight');
  assert.strictEqual(game.mode, 'manual');
  up('Control', 'ControlLeft');
  assert.strictEqual(game.mode, 'manual', 'a stray keyup without a keydown does nothing');
}

// --- Ctrl as a modifier (browser shortcuts, zoom) never cycles -----------------------------
{
  const { game } = setup('fixed');
  for (const [k, code] of [['=', 'Equal'], ['-', 'Minus'], ['0', 'Digit0'], ['Tab', 'Tab'], ['Shift', 'ShiftLeft']]) {
    down('Control', 'ControlLeft', { ctrlKey: true });
    down(k, code, { ctrlKey: true });
    up(k, code, { ctrlKey: true });
    up('Control', 'ControlLeft');
    assert.strictEqual(game.mode, 'fixed', 'Ctrl+' + k + ' is a shortcut, not a mode change');
  }
  // Ctrl+wheel (zoom) and Ctrl+click
  for (const type of ['wheel', 'pointerdown']) {
    down('Control', 'ControlLeft', { ctrlKey: true });
    fire('window', type, { ctrlKey: true });
    up('Control', 'ControlLeft');
    assert.strictEqual(game.mode, 'fixed', 'Ctrl+' + type);
  }
  // Released in the other order (the other key last)
  down('Control', 'ControlLeft', { ctrlKey: true });
  down('=', 'Equal', { ctrlKey: true });
  up('Control', 'ControlLeft');
  up('=', 'Equal');
  assert.strictEqual(game.mode, 'fixed', 'Ctrl released before the other key');
  // The window lost focus while Ctrl was down (Ctrl+Tab to another tab, Alt+Tab, ...)
  down('Control', 'ControlLeft', { ctrlKey: true });
  fire('window', 'blur', {});
  up('Control', 'ControlLeft');
  assert.strictEqual(game.mode, 'fixed', 'blur cancels the pending cycle');
  // A tap still works afterwards
  down('Control', 'ControlLeft', { ctrlKey: true });
  up('Control', 'ControlLeft');
  assert.strictEqual(game.mode, 'manual', 'a clean tap after shortcuts still cycles');
}

// --- AltGr (Windows sends ControlLeft, then AltGraph) is ignored ------------------------------
{
  const { game } = setup('assisted');
  for (const ctrlFirst of [true, false]) {
    down('Control', 'ControlLeft', { ctrlKey: true });
    down('AltGraph', 'AltRight', { ctrlKey: true, altKey: true });
    down('@', 'KeyQ', { ctrlKey: true, altKey: true });            // AltGr+Q on a German layout
    up('@', 'KeyQ', { ctrlKey: true, altKey: true });
    if (ctrlFirst) { up('Control', 'ControlLeft', { altKey: true }); up('AltGraph', 'AltRight'); }
    else { up('AltGraph', 'AltRight', { ctrlKey: true }); up('Control', 'ControlLeft'); }
    assert.strictEqual(game.mode, 'assisted', 'AltGr sequence (Ctrl released ' + (ctrlFirst ? 'first' : 'last') + ')');
  }
  // AltGr pressed and released alone
  down('Control', 'ControlLeft', { ctrlKey: true });
  down('AltGraph', 'AltRight', { ctrlKey: true, altKey: true });
  up('Control', 'ControlLeft', { altKey: true });
  up('AltGraph', 'AltRight');
  assert.strictEqual(game.mode, 'assisted', 'AltGr alone');
}

// --- Not live (menu open): Ctrl does nothing ---------------------------------------------------
{
  for (const k of Object.keys(listeners)) delete listeners[k];
  const game = TT.Game.create({ seed: 'INPUT', mode: 'assisted' });
  game.update(1 / 60);
  let blocked = true;
  TT.Input.create({ getGame: () => game, isBlocked: () => blocked });
  down('Control', 'ControlLeft', { ctrlKey: true });
  blocked = false;
  up('Control', 'ControlLeft');
  assert.strictEqual(game.mode, 'assisted', 'Ctrl pressed while a menu was open');
}

// --- Holding an arrow across a mode change: no burst of catch-up steps ------------------------
{
  // manual -> assisted after a 2 s hold (was: 3 steps = 1.5 cells in the next frame)
  const { game, input, steps } = setup('manual');
  down('ArrowRight', 'ArrowRight');
  clock += 2000;
  input.update(1 / 60);                     // sliding at full manual speed
  down('Control', 'ControlLeft', { ctrlKey: true });
  up('Control', 'ControlLeft');
  assert.strictEqual(game.mode, 'assisted', 'Ctrl cycled while Right is held');
  const s0 = steps(), x0 = game.piece.x;
  input.update(1 / 60);
  clock += 16;
  input.update(1 / 60);
  assert.strictEqual(steps() - s0, 0, 'no steps right after the mode change');
  assert.strictEqual(game.piece.x, x0, 'piece did not jump');
  // The hold then repeats like a fresh press: first repeat after KEY_REPEAT_DELAY, then the normal rate
  clock += C.KEY_REPEAT_DELAY * 1000 - 16 + 1;
  input.update(1 / 60);
  assert.strictEqual(steps() - s0, 1, 'first repeat after the repeat delay');
  clock += C.KEY_REPEAT_RATE * 1000;
  input.update(1 / 60);
  assert.strictEqual(steps() - s0, 2, 'then at the repeat rate');
  up('ArrowRight', 'ArrowRight');
}
{
  // fixed -> manual after a 2 s hold: the slide starts slow again instead of at top speed
  const { game, input } = setup('fixed');
  down('ArrowLeft', 'ArrowLeft');
  clock += 2000;
  input.update(1 / 60);
  game.setMode('manual');
  const x0 = game.piece.x;
  input.update(1 / 60);
  clock += C.MANUAL_HOLD_DELAY * 1000 + 100;
  input.update(0.1);
  const moved = x0 - game.piece.x;
  assert.ok(moved > 0 && moved <= C.MANUAL_SPEED_MIN * 0.1 * 1.5 + 1e-9,
    'manual slide restarts at its slow initial speed, moved ' + moved);
  up('ArrowLeft', 'ArrowLeft');
}

// --- Down = next block, Up = previous block: wrapping, skipping used slots, never a drop ----------
{
  const { game } = setup('assisted');
  const drops = countDrops(game);
  const sel = (k, code, extra) => { const ev = down(k, code, extra); up(k, code); return ev; };
  assert.strictEqual(game.selected, 0);
  const ev = sel('ArrowDown', 'ArrowDown');
  assert.ok(ev.defaultPrevented, 'Down is a game key');
  assert.strictEqual(game.selected, 1, 'Down: next');
  sel('ArrowDown', 'ArrowDown');
  assert.strictEqual(game.selected, 2);
  sel('ArrowDown', 'ArrowDown');
  assert.strictEqual(game.selected, 0, 'Down wraps to the first');
  sel('ArrowUp', 'ArrowUp');
  assert.strictEqual(game.selected, 2, 'Up wraps to the last');
  sel('ArrowUp', 'ArrowUp');
  assert.strictEqual(game.selected, 1, 'Up: previous');
  // Held: the OS auto-repeat does not race through the tray
  down('ArrowDown', 'ArrowDown');
  for (let i = 0; i < 5; i++) assert.ok(down('ArrowDown', 'ArrowDown', { repeat: true }).defaultPrevented);
  up('ArrowDown', 'ArrowDown');
  assert.strictEqual(game.selected, 2, 'one switch per press');
  assert.strictEqual(drops.n, 0, 'Down and Up never drop');
  assert.strictEqual(game.turn, 0);
  // Slot 2 used: both directions skip it
  sel(' ', 'Space');
  assert.strictEqual(game.turn, 1, 'Space drops');
  assert.ok(game.batch[2].used && game.selected === 0);
  sel('ArrowDown', 'ArrowDown');
  assert.strictEqual(game.selected, 1);
  sel('ArrowDown', 'ArrowDown');
  assert.strictEqual(game.selected, 0, 'Down skips the used slot');
  sel('ArrowUp', 'ArrowUp');
  assert.strictEqual(game.selected, 1, 'Up skips the used slot');
  sel('ArrowUp', 'ArrowUp');
  assert.strictEqual(game.selected, 0);
  assert.strictEqual(drops.n, 1);
  assert.strictEqual(TT.Input.keyAction({ key: 'ArrowDown', code: 'ArrowDown' }), 'next');
  assert.strictEqual(TT.Input.keyAction({ key: 'ArrowUp', code: 'ArrowUp' }), 'prev');
}

// --- Space / Enter / NumpadEnter drop; not on a focused control, in a text field or off-play ------
{
  let blocked = false;
  for (const k of Object.keys(listeners)) delete listeners[k];
  const game = TT.Game.create({ seed: 'INPUT', mode: 'assisted' });
  game.update(1 / 60);
  TT.Input.create({ getGame: () => game, isBlocked: () => blocked });
  for (const [k, code] of [[' ', 'Space'], ['Enter', 'Enter'], ['Enter', 'NumpadEnter']]) {
    waitReady(game);
    const t = game.turn;
    const ev = down(k, code);
    up(k, code);
    assert.strictEqual(game.turn, t + 1, code + ' drops');
    assert.ok(ev.defaultPrevented, code + ' is captured');
  }
  waitReady(game);
  const t = game.turn;
  const focusRing = { tagName: 'BUTTON', getAttribute: () => null, matches: (s) => s === ':focus-visible' };
  for (const [k, code] of [['Enter', 'Enter'], [' ', 'Space'], ['Enter', 'NumpadEnter']]) {
    const ev = down(k, code, { target: focusRing });
    assert.ok(!ev.defaultPrevented, code + ' is left to the control the player tabbed to');
  }
  const typing = { tagName: 'INPUT', type: 'text' };
  down('Enter', 'Enter', { target: typing });
  down(' ', 'Space', { target: typing });
  game.pause();
  down('Enter', 'Enter');
  game.resume();
  blocked = true;
  down('Enter', 'Enter');
  down(' ', 'Space');
  blocked = false;
  down('ArrowDown', 'ArrowDown');
  assert.strictEqual(game.turn, t, 'no drop: focused control, text field, paused, menu open, Down');
  // A button that only has focus from a mouse or touch press does not keep the keys
  const clicked = { tagName: 'BUTTON', getAttribute: () => null, matches: () => false };
  down('Enter', 'Enter', { target: clicked });
  assert.strictEqual(game.turn, t + 1, 'Enter after clicking a button drops');
}

// --- Pointer: a fake page ---------------------------------------------------------------------
// A portrait phone, 400 x 806 CSS px: HUD bar y < 56, playfield (canvas) y 56..656, tray below it
// with three slots at y 700..790 (slot i: x 10 + 130 i .. 130 + 130 i, centre 70 + 130 i). 25 CSS
// px per cell and the 16-cell field spans the width, so world x = x / 25.
const SLOT_Y = 745;
const slotX = (i) => 70 + 130 * i;
function makePage() {
  const node = (name, inTray) => ({ name, inTray: !!inTray, closest: () => null });
  const capturable = (o) => Object.assign(o, {
    captured: null,
    setPointerCapture(id) { this.captured = id; },
    releasePointerCapture(id) { if (this.captured === id) this.captured = null; }
  });
  const canvas = capturable(Object.assign(target('canvas'), {
    name: 'canvas', style: {},
    getBoundingClientRect: () => ({ left: 0, top: 56, right: 400, bottom: 656, width: 400, height: 600 })
  }));
  const slots = [0, 1, 2].map((i) => {
    const btn = capturable({ name: 'slot' + i, inTray: true, dataset: { slot: String(i) }, x0: 10 + 130 * i, x1: 130 + 130 * i });
    btn.closest = (sel) => (sel === '[data-slot]' ? btn : null);
    btn.inner = { name: 'slot-canvas' + i, inTray: true, closest: (sel) => btn.closest(sel) };   // what a press hits
    return btn;
  });
  const tray = Object.assign(target('tray'), { name: 'tray', inTray: true, contains: (n) => !!n && !!n.inTray });
  const hud = node('hud'), trayBg = node('tray-desc', true);
  document.elementFromPoint = (x, y) => {
    if (!(x >= 0 && x < 400 && y >= 0 && y < 806)) return null;   // outside the window
    if (y < 56) return hud;
    if (y < 656) return canvas;
    if (y >= 700 && y < 790) for (const s of slots) if (x >= s.x0 && x < s.x1) return s.inner;
    return trayBg;
  };
  const renderer = { scale: 25, screenToWorld: (px, py, o) => { o.x = px / 25; o.y = (600 - py) / 25; return o; } };
  return { canvas, tray, slots, renderer };
}

function setupPointer(mode) {
  for (const k of Object.keys(listeners)) delete listeners[k];
  const page = makePage();
  const game = TT.Game.create({ seed: 'INPUT', mode: mode || 'assisted' });
  game.update(1 / 60);
  game.setPixelSize(1 / 25);
  let blocked = false;
  const input = TT.Input.create({
    canvas: page.canvas, tray: page.tray, getGame: () => game, getRenderer: () => page.renderer,
    isBlocked: () => blocked
  });
  const drops = countDrops(game);
  const dropped = [];
  let denies = 0;
  game.on('drop', (d) => dropped.push(d));
  game.on('deny', () => denies++);
  // One main-loop frame: game first, then input (as main.js does)
  const frame = (n) => { for (let i = 0; i < (n || 1); i++) { clock += 16; game.update(1 / 60); input.update(1 / 60); } };
  return { page, game, input, drops, dropped, frame, denies: () => denies, block: (b) => { blocked = b; } };
}

let nextId = 10;
// One pointer. A press goes to what is under it (canvas or tray, then window); moves and the release
// go to window (where TT.Input follows a press, captured or not).
function pointer(type) {
  const id = nextId++;
  const mouse = type === 'mouse';
  const ev = (x, y, extra) => Object.assign({
    pointerId: id, pointerType: type, button: 0, buttons: 1, clientX: x, clientY: y,
    target: document.elementFromPoint(x, y), defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }
  }, extra || {});
  return {
    id,
    down(x, y, extra) {
      const e = ev(x, y, extra);
      if (e.target && e.target.name === 'canvas') fire('canvas', 'pointerdown', e);
      else if (e.target && e.target.inTray) fire('tray', 'pointerdown', e);
      fire('window', 'pointerdown', e);
      return e;
    },
    move(x, y, extra) { fire('window', 'pointermove', ev(x, y, extra)); },
    up(x, y, extra) { fire('window', 'pointerup', ev(x, y, Object.assign({ buttons: 0 }, extra))); },
    cancel(x, y) { fire('window', 'pointercancel', ev(x, y, { buttons: 0 })); },
    mouse
  };
}

// Move in steps (a frame after each) from (x0, y0) to (x1, y1)
function glide(s, p, x0, y0, x1, y1, steps) {
  const n = steps || 6;
  for (let i = 1; i <= n; i++) {
    p.move(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n);
    s.frame();
  }
}

// Pick a slot up and bring it over the playfield at (x, y), without letting go
function dragOut(s, p, slot, x, y) {
  p.down(slotX(slot), SLOT_Y);
  s.frame();
  glide(s, p, slotX(slot), SLOT_Y, x, y, 6);
}

const centre = (game) => game.piece.x + game.piece.shape.w / 2;

// --- Tray -> playfield -> let go: exactly one drop, where the pointer is (touch and mouse) ---------
for (const type of ['touch', 'mouse']) {
  const s = setupPointer();
  const { game, input, drops, dropped } = s;
  const p = pointer(type);
  p.down(slotX(1), SLOT_Y);
  assert.strictEqual(game.selected, 1, type + ': pressing a block picks it');
  assert.ok(input.isActive());
  p.move(slotX(1), SLOT_Y - 6);
  s.frame();
  assert.strictEqual(input.cue.slot, -1, type + ': a 6 px wiggle is not a drag yet');
  p.move(slotX(1), SLOT_Y - 14);
  s.frame();
  assert.strictEqual(input.cue.slot, 1, type + ': lifted once it travels');
  assert.strictEqual(input.cue.zone, 'cancel', type + ': still over the tray: letting go would cancel');
  glide(s, p, slotX(1), SLOT_Y - 14, 150, 300, 8);
  assert.strictEqual(input.cue.zone, 'field');
  assert.ok(Math.abs(centre(game) - 6) <= 0.5, type + ': the piece is centred under the pointer, centre ' + centre(game));
  const y0 = game.piece.y;
  glide(s, p, 150, 300, 150, 600, 4);             // straight down over the playfield: x stays
  assert.ok(Math.abs(centre(game) - 6) <= 0.5 && game.piece.y === y0, type + ': only x follows the pointer');
  glide(s, p, 150, 600, 250, 400, 4);             // world x 10
  assert.ok(Math.abs(centre(game) - 10) <= 0.5, type + ': follows, centre ' + centre(game));
  assert.strictEqual(drops.n, 0, type + ': nothing drops while dragging');
  p.move(150, 300);                               // a last move with no frame before the release...
  p.up(200, 300);                                 // ...the release point decides (world x 8)
  assert.strictEqual(drops.n, 1, type + ': let go over the playfield drops');
  assert.strictEqual(game.turn, 1);
  assert.ok(game.batch[1].used, type + ': the dragged block was dropped');
  const b = dropped[0].block;
  assert.ok(Math.abs(b.body.getPosition().x + b.shape.w / 2 - 8) <= 0.5, type + ': dropped under the pointer');
  assert.deepStrictEqual([input.cue.slot, input.cue.zone, input.cue.queued], [-1, '', false], 'cues cleared');
  assert.ok(!input.isActive());
  s.frame(30);
  assert.strictEqual(drops.n, 1, type + ': exactly once');
  assert.strictEqual(s.denies(), 0);
}

// --- Dragged back into the tray, or let go outside the playfield: nothing drops --------------------
for (const type of ['touch', 'mouse']) {
  const ends = [
    ['back on its slot', slotX(0), SLOT_Y],
    ['on another slot', slotX(2), SLOT_Y],
    ['on the tray between the slots', 200, 680],
    ['on the HUD bar', 200, 20],
    ['above the window', 200, -40],
    ['beside the window', 460, 300],
    ['below the window', 200, 900]
  ];
  for (const [where, x, y] of ends) {
    const s = setupPointer();
    const { game, input, drops } = s;
    const p = pointer(type);
    const home = game.piece.x;
    dragOut(s, p, 0, 100, 300);
    assert.strictEqual(input.cue.zone, 'field');
    assert.ok(Math.abs(game.piece.x - home) > 1, type + ': aimed away from its spot');
    glide(s, p, 100, 300, x, y, 6);
    assert.strictEqual(input.cue.zone, 'cancel', type + ' ' + where + ': cancel cue');
    assert.strictEqual(game.piece.x, home, type + ' ' + where + ': the piece shows it going back');
    p.up(x, y);
    s.frame(5);
    assert.strictEqual(drops.n, 0, type + ' let go ' + where + ': no drop');
    assert.strictEqual(game.turn, 0);
    assert.ok(!game.batch[0].used && game.selected === 0, type + ' ' + where + ': the block stays in its slot');
    assert.strictEqual(game.piece.x, home, type + ' ' + where + ': ...where it was picked up');
    assert.strictEqual(input.cue.slot, -1);
  }
  // Back over the tray and out again: it follows again, and drops
  const s = setupPointer();
  const p = pointer(type);
  dragOut(s, p, 0, 100, 300);
  glide(s, p, 100, 300, slotX(1), SLOT_Y, 4);
  glide(s, p, slotX(1), SLOT_Y, 200, 300, 4);
  assert.ok(s.input.cue.zone === 'field' && Math.abs(centre(s.game) - 8) <= 0.5, type + ': follows again');
  p.up(200, 300);
  assert.strictEqual(s.drops.n, 1, type + ': changed its mind twice, then dropped');
}

// --- A tap (or a press that barely moves) on a slot selects it and never drops ----------------------
for (const type of ['touch', 'mouse']) {
  const s = setupPointer();
  const { game, input, drops } = s;
  const p = pointer(type);
  p.down(slotX(2), SLOT_Y);
  p.up(slotX(2), SLOT_Y);
  assert.strictEqual(game.selected, 2, type + ': tap selects');
  p.down(slotX(1), SLOT_Y);
  s.frame();
  p.move(slotX(1) + 3, SLOT_Y - 4);
  s.frame();
  p.up(slotX(1) + 3, SLOT_Y - 4);
  assert.strictEqual(game.selected, 1, type + ': a press with a little jitter selects');
  assert.strictEqual(input.cue.slot, -1);
  s.frame(5);
  assert.strictEqual(drops.n, 0, type + ': a tap never drops');
  // A used slot does nothing, not even when dragged onto the playfield
  waitReady(game);
  game.drop();
  waitReady(game);
  const sel = game.selected;
  assert.ok(game.batch[1].used && sel !== 1);
  p.down(slotX(1), SLOT_Y);
  assert.strictEqual(game.selected, sel, type + ': a used slot cannot be picked');
  glide(s, p, slotX(1), SLOT_Y, 200, 300, 6);
  assert.strictEqual(input.cue.slot, -1, type + ': nothing is lifted');
  p.up(200, 300);
  assert.strictEqual(drops.n, 1, type + ': a drag from a used slot never drops');
}

// --- A drag that starts on the playfield moves the piece and never drops ---------------------------
for (const type of ['touch', 'mouse']) {
  const s = setupPointer();
  const { game, input, drops } = s;
  const p = pointer(type);
  const x0 = game.piece.x;
  p.down(200, 300);
  glide(s, p, 200, 300, 300, 300, 5);             // +4 cells
  assert.ok(Math.abs(game.piece.x - (x0 + 4)) <= 0.5, type + ': moved with the drag, x ' + game.piece.x);
  assert.strictEqual(input.cue.slot, -1, type + ': nothing is lifted from the tray');
  p.up(300, 300);
  glide(s, p, 300, 300, 300, 300, 1);
  // Any direction, speed and length; ending over the tray or outside too
  for (const [x1, y1] of [[200, 600], [300, 100], [100, 760], [200, -50], [205, 302]]) {
    p.down(200, 300);
    p.move((200 + x1) / 2, (300 + y1) / 2);
    p.move(x1, y1);
    s.frame();
    p.up(x1, y1);
  }
  // A plain click or tap on the playfield
  p.down(200, 300);
  p.up(200, 300);
  s.frame(5);
  assert.strictEqual(drops.n, 0, type + ': playfield presses never drop');
  assert.strictEqual(game.turn, 0);
}

// --- Too early: the drop waits until it is allowed, then fires exactly once -------------------------
{
  const s = setupPointer();
  const { game, input, drops, dropped } = s;
  const p = pointer('touch');
  dragOut(s, p, 0, 175, 300);
  p.up(175, 300);
  assert.strictEqual(game.turn, 1, 'first drop');
  assert.ok(!game.canDrop, 'the next drop is not allowed yet');
  // Straight away: drag the next block out and let go
  dragOut(s, p, 1, 250, 300);
  const aimed = game.piece.x;
  p.up(250, 300);
  assert.strictEqual(game.turn, 1, 'not dropped yet');
  assert.ok(input.cue.queued && input.isActive(), 'dropping when ready');
  assert.strictEqual(drops.n, 1, 'no refused attempt');
  assert.strictEqual(s.denies(), 0, 'no "not ready" buzz');
  let frames = 0;
  while (game.turn === 1 && frames < 900) { s.frame(); frames++; }
  assert.strictEqual(game.turn, 2, 'dropped once it was allowed');
  assert.ok(game.batch[1].used, 'the block that was let go');
  assert.ok(Math.abs(dropped[1].x - aimed) <= 0.5, 'where it was aimed: ' + dropped[1].x + ' vs ' + aimed);
  assert.ok(!input.cue.queued);
  s.frame(120);
  assert.strictEqual(drops.n, 2, 'exactly once');
}

// --- ...and anything new cancels the waiting drop ----------------------------------------------
{
  const cases = {
    'a new drag from the tray': (s) => { const q = pointer('touch'); q.down(slotX(2), SLOT_Y); glide(s, q, slotX(2), SLOT_Y, slotX(2), 680, 3); q.up(slotX(2), 680); },
    'a tap on a slot': (s) => { const q = pointer('mouse'); q.down(slotX(2), SLOT_Y); q.up(slotX(2), SLOT_Y); },
    'a tap on the same slot': (s) => { const q = pointer('touch'); q.down(slotX(1), SLOT_Y); q.up(slotX(1), SLOT_Y); },
    'a drag on the playfield': (s) => { const q = pointer('touch'); q.down(200, 200); glide(s, q, 200, 200, 120, 200, 3); q.up(120, 200); },
    'Down': () => { down('ArrowDown', 'ArrowDown'); up('ArrowDown', 'ArrowDown'); },
    'Up': () => { down('ArrowUp', 'ArrowUp'); up('ArrowUp', 'ArrowUp'); },
    'a key move': () => { down('ArrowLeft', 'ArrowLeft'); up('ArrowLeft', 'ArrowLeft'); },
    'a slot key': () => { down('3', 'Digit3'); up('3', 'Digit3'); },
    'pause': (s) => { s.game.pause(); s.frame(); s.game.resume(); },
    'a menu': (s) => { s.block(true); s.frame(); s.block(false); },
    'blur': () => fire('window', 'blur', {})
  };
  for (const name of Object.keys(cases)) {
    const s = setupPointer();
    const { game, input, drops } = s;
    const p = pointer('touch');
    dragOut(s, p, 0, 175, 300);
    p.up(175, 300);
    dragOut(s, p, 1, 250, 300);
    p.up(250, 300);
    assert.ok(input.cue.queued, name + ': waiting');
    cases[name](s);
    s.frame();
    assert.ok(!input.cue.queued && !input.queued, name + ' cancels the waiting drop');
    s.frame(600);
    assert.strictEqual(game.turn, 1, name + ': it never drops');
    assert.strictEqual(drops.n, 1);
  }
  // A plain tap on the playfield is not a new drag: the drop still happens
  const s = setupPointer();
  const p = pointer('touch');
  dragOut(s, p, 0, 175, 300);
  p.up(175, 300);
  dragOut(s, p, 1, 250, 300);
  p.up(250, 300);
  p.down(200, 200);
  p.up(200, 200);
  s.frame(600);
  assert.strictEqual(s.game.turn, 2, 'a tap on the playfield keeps the waiting drop');
}
{
  // The last block of a batch waits: Down / Up have nothing to switch to and still cancel
  for (const k of ['ArrowDown', 'ArrowUp']) {
    const s = setupPointer();
    const { game, input } = s;
    const p = pointer('touch');
    dragOut(s, p, 0, 175, 300);
    p.up(175, 300);
    waitReady(game);
    dragOut(s, p, 1, 250, 300);
    p.up(250, 300);
    dragOut(s, p, 2, 150, 300);
    p.up(150, 300);
    assert.ok(input.cue.queued && game.batch.filter((b) => !b.used).length === 1, k + ': the last block waits');
    down(k, k);
    up(k, k);
    assert.strictEqual(game.selected, 2, k + ': nothing to switch to');
    s.frame(600);
    assert.strictEqual(game.turn, 2, k + ' cancelled it anyway');
  }
}
{
  // A selection made elsewhere (a slot button pressed with the keyboard goes through ui.js)
  const s = setupPointer();
  const { game, input } = s;
  const p = pointer('touch');
  dragOut(s, p, 0, 175, 300);
  p.up(175, 300);
  dragOut(s, p, 1, 250, 300);
  p.up(250, 300);
  game.selectSlot(1);                                // even the same slot: a new pick
  s.frame(600);
  assert.ok(game.turn === 1 && !input.cue.queued, 'another selection cancels the waiting drop');
  // The waiting block dropped another way (Space the moment it was allowed): no second drop
  const s2 = setupPointer();
  dragOut(s2, p, 0, 175, 300);
  p.up(175, 300);
  dragOut(s2, p, 1, 250, 300);
  p.up(250, 300);
  for (let i = 0; i < 900 && !s2.game.canDrop; i++) s2.game.update(1 / 60);   // input not updated yet
  down(' ', 'Space');
  up(' ', 'Space');
  assert.strictEqual(s2.game.turn, 2, 'Space dropped the waiting block');
  s2.frame(600);
  assert.strictEqual(s2.game.turn, 2, 'the next block does not drop by itself');
}

// --- Cancelled gestures: pointercancel, lost capture, blur, a mouse released out of sight ----------
{
  const run = (name, end, drops0) => {
    const s = setupPointer();
    const p = pointer(name.startsWith('mouse') ? 'mouse' : 'touch');
    const home = s.game.piece.x;
    dragOut(s, p, 0, 150, 300);
    end(s, p);
    if (!drops0) assert.strictEqual(s.game.piece.x, home, name + ': the piece is back where it was picked up');
    p.up(150, 300);                                    // whatever comes after is ignored
    s.frame(5);
    assert.strictEqual(s.drops.n, drops0, name);
    assert.strictEqual(s.input.cue.slot, -1, name + ': cue cleared');
  };
  run('pointercancel', (s, p) => p.cancel(150, 300), 0);
  run('lost capture', (s, p) => fire('tray', 'lostpointercapture', { pointerId: p.id, target: s.page.slots[0] }), 0);
  run('blur', () => fire('window', 'blur', {}), 0);
  run('hidden', () => { document.hidden = true; fire('document', 'visibilitychange', {}); document.hidden = false; }, 0);
  run('mouse released out of sight', (s, p) => p.move(150, 300, { buttons: 0 }), 0);
  // The touch's implicit capture moving from the slot's child to the slot itself is not a loss
  run('capture handed to the slot', (s, p) => fire('tray', 'lostpointercapture', { pointerId: p.id, target: s.page.slots[0].inner }), 1);
  // Another pointer's capture changes are not ours
  run('another pointer lost capture', (s, p) => fire('tray', 'lostpointercapture', { pointerId: p.id + 1000, target: s.page.slots[0] }), 1);
}

// --- Multi-touch: extra fingers are ignored while a drag is on ---------------------------------
{
  const s = setupPointer();
  const { game, input, drops } = s;
  const a = pointer('touch'), b = pointer('touch');
  dragOut(s, a, 0, 175, 300);
  b.down(slotX(2), SLOT_Y);
  assert.strictEqual(game.selected, 0, 'a second finger on the tray does not switch the block');
  glide(s, b, slotX(2), SLOT_Y, 300, 300, 4);
  assert.ok(Math.abs(centre(game) - 7) <= 0.5, 'nor does it aim');
  b.up(300, 300);
  assert.strictEqual(drops.n, 0, 'nor drop');
  assert.strictEqual(input.cue.slot, 0, 'the first drag goes on');
  const c = pointer('touch');
  c.down(200, 200);
  c.up(200, 200);
  a.up(175, 300);
  assert.strictEqual(drops.n, 1, 'the first finger drops');
  assert.ok(game.batch[0].used);
}

// --- Moves are coalesced: one aim per frame, however many pointer events ----------------------------
{
  const s = setupPointer();
  const { game, input } = s;
  let aims = 0;
  const setTargetX = game.setTargetX.bind(game);
  game.setTargetX = (x) => { aims++; return setTargetX(x); };
  const p = pointer('mouse');
  dragOut(s, p, 1, 200, 300);
  aims = 0;
  for (let i = 0; i < 12; i++) p.move(200 + i * 5, 300);
  assert.strictEqual(aims, 0, 'nothing applied between frames');
  input.update(1 / 60);
  assert.strictEqual(aims, 1, 'one aim per frame');
  assert.ok(Math.abs(centre(game) - 255 / 25) <= 0.5, 'at the latest position');
  input.update(1 / 60);
  assert.strictEqual(aims, 1, 'no move, no aim');
  p.up(255, 300);
}

// --- The mouse needs no hover aim, wheel or right button -------------------------------------------
{
  const s = setupPointer();
  const { game, page, drops } = s;
  const x0 = game.piece.x, mode = game.mode;
  for (const x of [20, 120, 380]) {
    fire('window', 'pointermove', { pointerId: 1, pointerType: 'mouse', buttons: 0, button: -1, clientX: x, clientY: 300, target: page.canvas });
    s.frame();
  }
  assert.strictEqual(game.piece.x, x0, 'pointing at the playfield does not aim');
  assert.ok(!listeners['canvas:wheel'] && !listeners['tray:wheel'], 'no wheel controls');
  const m = pointer('mouse');
  m.down(200, 300, { button: 2, buttons: 2 });
  m.up(200, 300, { button: 2 });
  m.down(slotX(2), SLOT_Y, { button: 2, buttons: 2 });
  m.up(slotX(2), SLOT_Y, { button: 2 });
  assert.ok(game.mode === mode && game.selected === 0 && drops.n === 0, 'the right button does nothing');
  let prevented = false;
  fire('canvas', 'contextmenu', { target: page.canvas, preventDefault() { prevented = true; } });
  assert.ok(prevented, 'no context menu on the playfield (long press)');
}

console.log('input tests passed');
