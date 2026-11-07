/* Keyboard input (js/input.js with a stub window/document and a fake clock): Ctrl cycles the
 * placement mode only when tapped on its own (not as part of a shortcut or AltGr), and a mode
 * change while an arrow is held never replays a backlog of steps. */
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
global.document = Object.assign(target('document'), { hidden: false });
require(path.join(__dirname, '..', 'js/input.js'));

const fire = (name, type, ev) => { for (const fn of listeners[name + ':' + type] || []) fn(ev); };
const key = (k, code, extra) => Object.assign({
  key: k, code, repeat: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
  defaultPrevented: false, target: null, preventDefault() {}
}, extra || {});
const down = (k, code, extra) => fire('window', 'keydown', key(k, code, extra));
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

console.log('input tests passed');
