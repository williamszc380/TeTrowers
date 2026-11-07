/* Game rules: batches, selection, modes, readiness, lives per turn, milestones, game over,
 * determinism, and the assisted guided fall (a drifting support must not make a drop miss). */
'use strict';
const assert = require('assert');
const TT = require('./load-core')();
const C = TT.CONFIG;

function run(game, seconds) {
  const steps = Math.round(seconds * 60);
  for (let i = 0; i < steps; i++) game.update(1 / 60);
}
function waitReady(game, max = 8) {
  for (let t = 0; t < max * 60 && !game.canDrop; t++) game.update(1 / 60);
  return game.canDrop;
}
function events(game) {
  const log = [];
  game.on('*', (name, p) => log.push([name, p]));
  return log;
}

// --- dealing, selection, determinism -------------------------------------------------
{
  const a = TT.Game.create({ seed: 'TEST-1' });
  const b = TT.Game.create({ seed: 'test-1' });
  run(a, 0.1); run(b, 0.1);
  assert.strictEqual(a.batch.length, 3, 'batch of 3');
  assert.deepStrictEqual(a.batch.map((s) => s.spec), b.batch.map((s) => s.spec), 'same seed => same batch');
  assert.ok(a.piece && a.selected === 0 && a.canDrop, 'first piece ready');
  assert.ok(a.selectNext() && a.selected === 1);
  assert.ok(a.selectSlot(2) && a.selected === 2);
  assert.ok(!a.selectSlot(5));
}

// --- modes & movement ------------------------------------------------------------------
{
  const g = TT.Game.create({ seed: 'MOVE', mode: 'fixed' });
  run(g, 0.1);
  const x0 = g.piece.x;
  g.moveStep(1);
  assert.ok(Math.abs(g.piece.x - (x0 + 0.5)) < 1e-9 || g.piece.x === TT.Placement.clampX(g.piece.shape, x0 + 0.5), 'fixed step 0.5');
  g.setMode('manual');
  g.setPixelSize(0.02);
  const x1 = g.piece.x;
  g.moveStep(-1);
  assert.ok(Math.abs(g.piece.x - (x1 - 0.02)) < 1e-9, 'manual step = 1 px');
  g.moveBy(0.333);
  assert.ok(Math.abs(g.piece.x - (x1 - 0.02 + 0.333)) < 1e-9, 'manual moveBy');
  g.setMode('assisted');
  assert.ok(Math.abs(g.piece.x * 2 - Math.round(g.piece.x * 2)) < 1e-6, 'assisted over bare platform snaps to half grid');
  assert.ok(g.cycleMode() && g.mode === 'fixed');
  g.setTargetX(-50);
  assert.strictEqual(g.piece.x, 0, 'clamped to field');
}

// --- drop flow, readiness, new batch ------------------------------------------------
{
  const g = TT.Game.create({ seed: 'FLOW', mode: 'fixed' });
  const log = events(g);
  run(g, 0.1);
  for (let k = 0; k < 3; k++) {
    assert.ok(waitReady(g), 'ready before drop ' + k);
    g.setTargetX(6);
    assert.ok(g.drop(), 'drop ' + k);
    assert.ok(!g.canDrop, 'not ready right after a drop');
    assert.ok(!g.drop(), 'second drop refused while not ready');
  }
  assert.ok(waitReady(g), 'ready after third drop');
  assert.strictEqual(g.round, 2, 'second batch dealt');
  assert.ok(g.batch.every((s) => !s.used));
  assert.strictEqual(g.turn, 3);
  assert.ok(log.some((e) => e[0] === 'land'), 'land events');
  assert.ok(log.some((e) => e[0] === 'settle'), 'settle events');
  assert.ok(g.height > 0.9, 'tower has height, got ' + g.height);
}

// --- lives: one per turn, shield, game over --------------------------------------------
{
  const g = TT.Game.create({ seed: 'LIVES', mode: 'fixed' });
  const log = events(g);
  run(g, 0.1);
  // Turn 1: drop into the void at the far left, plus an extra block lost in the same turn
  assert.ok(waitReady(g));
  g.setTargetX(0);
  g.drop();
  const extra = g.physics.createBlock({ typeKey: 'normal', shapeId: 'O0' }, 14, 4);
  extra.dropped = true;
  run(g, 2.5);
  assert.strictEqual(g.stats.lost, 2, 'two blocks lost');
  assert.strictEqual(g.lives, 2, 'only one life lost in one turn');
  // Shield absorbs the next loss
  g.addShield();
  assert.ok(waitReady(g));
  g.setTargetX(0);
  g.drop();
  run(g, 2.5);
  assert.strictEqual(g.lives, 2, 'shield absorbed the loss');
  assert.ok(!g.shield);
  assert.ok(log.some((e) => e[0] === 'shieldUsed'));
  // Two more void drops end the run
  for (let k = 0; k < 2; k++) {
    assert.ok(waitReady(g), 'ready for void drop ' + k);
    g.setTargetX(0);
    g.drop();
    run(g, 2.5);
  }
  assert.strictEqual(g.lives, 0);
  run(g, 2);
  assert.strictEqual(g.state, 'over', 'game over');
  assert.ok(log.some((e) => e[0] === 'gameOver'));
  assert.ok(!g.drop() && !g.moveStep(1), 'no control after game over');
  const lastLife = log.map((e) => e[0]).lastIndexOf('lifeLost');
  assert.ok(!log.slice(lastLife).some((e) => e[0] === 'ready'), 'no ready (chime) during the game-over delay');
}

// --- lives: a turn's falls cost one life, however long they take ------------------------
// A 62 m tower of static columns: a block knocked off its top falls for ~2.5 s
function tallTower(seed) {
  const g = TT.Game.create({ seed, mode: 'fixed', enabledTypes: [] });
  const P = g.physics;
  for (let y = 0; y < 60; y += 4) {
    for (let x = 5; x < 11; x++) P.makeStatic(P.createBlock({ typeKey: 'normal', shapeId: 'I1' }, x, y), 'steel');
  }
  run(g, 8.5); // the hover line rises above the top
  return g;
}
function looseOnTop(g, x) {
  const b = g.physics.createBlock({ typeKey: 'normal', shapeId: 'O0' }, x, 60);
  b.dropped = b.touched = true;
  return b;
}
{
  // Two blocks knocked off during turn 1, the second 1.1 s after the first; the next drop is
  // made as soon as the game allows it
  const g = tallTower('LATE');
  const A = looseOnTop(g, 9), B = looseOnTop(g, 5);
  run(g, 2);
  assert.ok(g.canDrop && g.hoverY > g.towerTop);
  const lostIn = [];
  g.on('blockLost', () => lostIn.push(g.turn));
  g.setTargetX(7);
  assert.ok(g.drop());
  A.body.setLinearVelocity({ x: 6, y: 1 });
  for (let k = 0; k < 60 * 12 && !g.canDrop; k++) {
    if (k === 66) B.body.setLinearVelocity({ x: -6, y: 1 });
    g.update(1 / 60);
  }
  assert.ok(g.canDrop, 'ready again');
  assert.ok(A.dead && B.dead, 'the next drop waited until both had fallen');
  assert.deepStrictEqual(lostIn, [1, 1]);
  g.setTargetX(7);
  assert.ok(g.drop());
  run(g, 3);
  assert.strictEqual(g.stats.lost, 2);
  assert.strictEqual(g.lives, 2, 'one life for one turn');
}
{
  // A fall still under way when the next turn starts is charged to the turn it began in: a
  // void drop from the top (READY_MAX opens turn 2 long before it is gone) after turn 1 has
  // already lost a block
  const g = tallTower('LATE2');
  const A = looseOnTop(g, 9);
  run(g, 2);
  g.setTargetX(0);
  assert.ok(g.drop());
  const voidDrop = g.physics.blocks[g.physics.blocks.length - 1];
  A.body.setLinearVelocity({ x: 6, y: 1 });
  assert.ok(waitReady(g, 6));
  assert.ok(A.dead && !voidDrop.dead && g.lives === 2, 'turn 2 starts while the void drop still falls');
  g.setTargetX(7);
  assert.ok(g.drop());
  const lostIn = [];
  g.on('blockLost', (p) => lostIn.push([p.block === voidDrop, g.turn]));
  run(g, 6);
  assert.deepStrictEqual(lostIn, [[true, 2]], 'it is lost during turn 2...');
  assert.strictEqual(g.lives, 2, '...but turn 1 already paid for its falls');
}
{
  // Readiness also waits while other blocks are still in motion, but never longer than
  // READY_FALL_MAX after the drop
  const cap = C.READY_FALL_MAX != null ? C.READY_FALL_MAX : 10;
  const g = TT.Game.create({ seed: 'CAP', mode: 'fixed', enabledTypes: [] });
  run(g, 0.1);
  const P = g.physics;
  const restless = P.createBlock({ typeKey: 'normal', shapeId: 'O0' }, 14, 30);
  const log = events(g);
  g.setTargetX(7);
  assert.ok(g.drop());
  const dropped = P.blocks[P.blocks.length - 1];
  const t0 = P.time;
  let progress = 0, readyAt = null;
  while (readyAt == null && P.time - t0 < cap + 1) {
    restless.body.setTransform({ x: 14, y: 30 }, 0);   // falls forever
    restless.body.setLinearVelocity({ x: 0, y: -10 });
    g.update(1 / 60);
    if (g.canDrop) readyAt = P.time - t0;
    else {
      assert.ok(g.readyProgress >= progress && g.readyProgress <= 0.99, 'progress grows and stays below 1');
      progress = g.readyProgress;
    }
  }
  assert.ok(dropped.settled, 'the dropped block itself settled long before');
  assert.ok(Math.abs(readyAt - cap) < 0.05, 'ready at the cap, after ' + readyAt);
  assert.strictEqual(log.filter((e) => e[0] === 'ready').length, 1, 'one ready event');
}

// --- milestone gives a life back ---------------------------------------------------------
{
  const g = TT.Game.create({ seed: 'MILE', mode: 'fixed' });
  run(g, 0.1);
  g.setTargetX(0); g.drop(); run(g, 2.5);
  assert.strictEqual(g.lives, 2);
  // A static column reaching 12 m counts immediately
  for (let y = 0; y < 12; y += 4) {
    const b = g.physics.createBlock({ typeKey: 'normal', shapeId: 'I1' }, 7, y);
    g.physics.makeStatic(b, 'steel');
  }
  run(g, 0.2);
  assert.ok(g.bestHeight >= 11.9, 'best height from static column, got ' + g.bestHeight);
  assert.strictEqual(g.nextMilestone, (Math.floor(g.bestHeight / C.LIFE_MILESTONE) + 1) * C.LIFE_MILESTONE);
  assert.strictEqual(g.lives, 3, 'milestone restored a life');
}

// --- pause ---------------------------------------------------------------------------------
{
  const g = TT.Game.create({ seed: 'PAUSE' });
  run(g, 0.1);
  g.drop();
  g.pause();
  const t = g.physics.time;
  run(g, 1);
  assert.strictEqual(g.physics.time, t, 'paused world does not advance');
  g.resume();
  run(g, 0.5);
  assert.ok(g.physics.time > t);
}

// --- assisted guided fall: support shoved mid-fall, drop still lands flush -----------------
{
  const g = TT.Game.create({ seed: 'GUIDE', mode: 'assisted' });
  run(g, 0.1);
  // A 4-wide plank on the platform, deliberately off-grid by 0.3
  const base = g.physics.createBlock({ typeKey: 'normal', shapeId: 'I0' }, 6.3, 0.02);
  base.dropped = base.touched = true;
  run(g, 1.5);
  // Force the next piece to be an O so the expected landing is unambiguous
  g.batch[g.selected].spec = { n: -1, typeKey: 'normal', shapeId: 'O0' };
  g.selectSlot(g.selected);
  g.setTargetX(7.3);
  assert.ok(Math.abs(g.piece.x - 7.3) < 0.02, 'assisted snapped onto the drifted plank grid, x=' + g.piece.x);
  assert.ok(waitReady(g));
  g.drop();
  const dropped = g.physics.blocks[g.physics.blocks.length - 1];
  assert.ok(dropped.guide, 'guided fall armed');
  run(g, 0.15);
  // Shove the support 0.25 to the right while the piece is falling
  const p = base.body.getPosition();
  base.body.setTransform({ x: p.x + 0.25, y: p.y }, 0);
  base.body.setAwake(true);
  run(g, 2);
  const offset = dropped.body.getPosition().x - base.body.getPosition().x;
  assert.ok(Math.abs(offset - 1) < 0.06, 'dropped O stayed aligned with the shifted support, offset=' + offset.toFixed(3));
  assert.ok(Math.abs(dropped.body.getAngle()) < 0.05, 'no tipping');
}

// --- assisted guided fall: a support sliding steadily the whole time ------------------------
for (const vx of [0.3, 0.6]) {
  const g = TT.Game.create({ seed: 'GUIDEFF', mode: 'assisted' });
  run(g, 0.1);
  const P = g.physics;
  // A plank sliding frictionlessly at a constant speed on a frozen oil slick
  const oil = P.createBlock({ typeKey: 'oil', shapeId: 'I0' }, 5, 0);
  oil.dropped = oil.touched = true;
  run(g, 1);
  P.makeStatic(oil, 'steel');
  const plank = P.createBlock({ typeKey: 'normal', shapeId: 'I0' }, 5, 1);
  plank.dropped = plank.touched = true;
  run(g, 0.5);
  const push = () => plank.body.setLinearVelocity({ x: vx, y: plank.body.getLinearVelocity().y });
  const frames = (n) => { for (let i = 0; i < n; i++) { g.update(1 / 60); push(); } };
  push();
  g.batch[g.selected].spec = { n: -1, typeKey: 'normal', shapeId: 'O0' };
  g.selectSlot(g.selected);
  frames(7);
  g.setTargetX(plank.body.getPosition().x + 1);  // flush, one cell in
  frames(5);                                      // so the placement surface is 0.1 s old
  assert.ok(g.drop());
  const o = P.blocks[P.blocks.length - 1];
  assert.ok(o.guide, 'guided fall armed');
  const atDrop = o.body.getPosition().x - plank.body.getPosition().x;
  assert.ok(Math.abs(atDrop - 1) < 0.005, 're-snapped onto the plank where it is now, offset ' + atDrop.toFixed(4));
  for (let i = 0; i < 180 && !o.touched; i++) frames(1);
  assert.ok(o.touched);
  run(g, 1.5);
  const err = Math.abs(o.body.getPosition().x - plank.body.getPosition().x - 1);
  assert.ok(err < 0.02, 'landed flush on the plank sliding at ' + vx + ' m/s, error ' + err.toFixed(4));
  assert.ok(Math.abs(o.body.getAngle()) < 0.01, 'no tipping');
}

// --- assisted guided fall: a support pushed out of reach cancels the chase, not the drop ----
for (const [shove, killAt] of [[3, 0], [5, 0], [2, 12]]) {
  const g = TT.Game.create({ seed: 'GUIDEABORT', mode: 'assisted' });
  run(g, 0.1);
  const P = g.physics;
  const column = P.createBlock({ typeKey: 'normal', shapeId: 'I1' }, 8.2, 0);
  column.dropped = column.touched = true;
  run(g, 1.5);
  g.batch[g.selected].spec = { n: -1, typeKey: 'normal', shapeId: 'O0' };
  g.selectSlot(g.selected);
  g.setTargetX(7.7);                               // on top of the column
  run(g, 0.5);
  assert.ok(g.drop());
  const o = P.blocks[P.blocks.length - 1];
  assert.ok(o.guide, 'guided fall armed');
  let aborted = false;
  for (let i = 0; i < 240; i++) {
    if (i === 6) { column.body.setLinearVelocity({ x: shove, y: 0 }); column.body.setAwake(true); }
    if (killAt && i === killAt) P.removeBlock(column, 'swallowed'); // destroyed while being chased
    const guided = !!o.guide;
    g.update(1 / 60);
    if (guided && !o.guide && !o.touched) {
      aborted = true;
      assert.ok(Math.abs(o.body.getLinearVelocity().x) < 1e-9, 'chase speed dropped at once (shove ' + shove + ')');
    }
  }
  assert.ok(aborted, 'the guide gave up');
  assert.ok(!o.dead, 'the O fell straight down and survived (shove ' + shove + ', ' + o.deathReason + ')');
}

console.log('game ok');
