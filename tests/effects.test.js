/* Special block behaviours (js/effects.js), driven by a small game.js-like loop: fixed
 * 120 Hz substeps, contacts drained after every substep (first touch, then onContact),
 * per-frame settle tracking, then Effects.update. The last scenario plays the real game.
 */
'use strict';
const assert = require('assert');
const TT = require('./load-core')();
const C = TT.CONFIG;
const E = TT.Effects;
const FRAME = 1 / 60;

class FakeGame {
  constructor(opts) {
    const o = opts || {};
    this.physics = TT.Physics.create();
    this.time = 0;
    this.turn = 0;
    this.lives = o.lives != null ? o.lives : 3;
    this.maxLives = 3;
    this.shield = false;
    this.stats = { drops: 0, lost: 0, livesLost: 0, swallowed: 0, popped: 0, exploded: 0, shattered: 0, melted: 0, frozen: 0, welded: 0, magnetized: 0 };
    this.events = [];
    this.records = [];
  }

  emit(name, payload) { this.events.push({ name, payload }); }
  eventsOf(name) { return this.events.filter((e) => e.name === name).map((e) => e.payload); }

  gainLife(reason) {
    if (this.lives >= this.maxLives) return false;
    this.lives++;
    this.emit('lifeGained', { lives: this.lives, reason });
    return true;
  }

  addShield() {
    if (this.shield) return false;
    this.shield = true;
    this.emit('shield', { active: true });
    return true;
  }

  // A block released by the player: it counts as touched on its first solid contact
  drop(typeKey, shapeId, x, y, opts) {
    const b = this.physics.createBlock({ typeKey, shapeId }, x, y, opts);
    b.dropped = true;
    b.dropTime = this.physics.time;
    b.dropTurn = this.turn;
    this.stats.drops++;
    return b;
  }

  turnStart() { this.turn++; E.onTurnStart(this); }

  frame(dt) {
    const P = this.physics;
    P.step(dt, { afterSubstep: () => this.drain() });
    this.time = P.time;
    for (const b of P.movers.slice()) { // like game.js: static bodies never settle/activate
      if (b.dead || b.activated || !b.touched) continue;
      const v = b.body.getLinearVelocity();
      const still = Math.hypot(v.x, v.y) + Math.abs(b.body.getAngularVelocity()) < C.SETTLE_SPEED;
      b.stillTime = still ? b.stillTime + dt : 0;
      if (b.stillTime >= C.SETTLE_TIME) {
        b.settled = true;
        b.activated = true;
        E.onSettle(this, b);
      }
    }
    E.update(this, dt);
  }

  drain() {
    for (const rec of this.physics.drainContacts()) {
      this.records.push(rec);
      if (!rec.sensor) {
        for (const b of [rec.a, rec.b]) {
          if (!b.isPlatform && !b.dead && b.dropped && !b.touched) {
            b.touched = true;
            b.touchTime = this.physics.time;
            E.onFirstTouch(this, b, rec);
          }
        }
      }
      E.onContact(this, rec);
    }
  }

  run(seconds) {
    const n = Math.round(seconds / FRAME);
    for (let i = 0; i < n; i++) this.frame(FRAME);
  }

  runUntil(cond, maxSeconds) {
    const n = Math.round(maxSeconds / FRAME);
    for (let i = 0; i < n; i++) {
      this.frame(FRAME);
      if (cond()) return true;
    }
    return false;
  }
}

// Release a block a hair above its resting place and run until it has settled
function place(g, typeKey, shapeId, x, y) {
  const b = g.drop(typeKey, shapeId, x, y + 0.02);
  assert.ok(g.runUntil(() => b.activated || b.dead, 3), typeKey + ' ' + shapeId + ' settles');
  return b;
}

function near(actual, expected, eps, msg) {
  assert.ok(Math.abs(actual - expected) <= eps, (msg || 'value') + ': ' + actual + ' vs ' + expected + ' (+-' + eps + ')');
}

function jointedTo(block, other) {
  for (let je = block.body.getJointList(); je; je = je.next) if (je.other === other.body) return true;
  return false;
}

function isPair(rec, x, y) { return (rec.a === x && rec.b === y) || (rec.a === y && rec.b === x); }

// Pose of `top` in `base`'s frame
function relPose(base, top) {
  const p = base.body.getLocalPoint(top.body.getPosition());
  return { x: p.x, y: p.y, a: top.body.getAngle() - base.body.getAngle() };
}

function liveRubble(g) { return g.physics.blocks.filter((b) => b.typeKey === 'rubble'); }

function solidRec(g, a, b, normal) {
  return { a, b, kindA: 'solid', kindB: 'solid', tagA: null, tagB: null, sensor: false, normal, point: null, time: g.physics.time };
}

// Activate a block by hand (no settling), as game.js does for blocks frozen before they settle
function activate(g, b) {
  b.activated = true;
  E.onSettle(g, b);
  return b;
}

// Pose of `b` relative to the magnet's grid: lattice column, offset from it, tilt from the
// nearest quarter turn
function onGrid(magnet, b) {
  const x = magnet.body.getLocalPoint(b.body.getPosition()).x;
  const rel = b.body.getAngle() - magnet.body.getAngle();
  return { col: Math.round(x), off: x - Math.round(x), tilt: rel - Math.PI / 2 * Math.round(rel / (Math.PI / 2)) };
}

// Records whether the popped block was still alive when 'pop' was emitted
function watchPops(g) {
  const aliveAtEmit = [];
  const emit = g.emit.bind(g);
  g.emit = (name, p) => {
    if (name === 'pop') aliveAtEmit.push(!p.block.dead && g.physics.blocks.includes(p.block));
    emit(name, p);
  };
  return aliveAtEmit;
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---------------------------------------------------------------------------------------
test('steel becomes static on settle and does not move when hit', () => {
  const g = new FakeGame();
  const steel = place(g, 'steel', 'O0', 7, 0);
  assert.ok(steel.body.isStatic(), 'static');
  assert.strictEqual(steel.frozen, 'steel');
  assert.strictEqual(g.stats.frozen, 1);
  const fz = g.eventsOf('freeze');
  assert.strictEqual(fz.length, 1);
  assert.strictEqual(fz[0].source, 'steel');
  assert.ok(fz[0].blocks.length === 1 && fz[0].blocks[0] === steel);
  near(fz[0].x, 8, 0.05, 'freeze x');
  near(fz[0].y, 1, 0.05, 'freeze y');

  const p0 = steel.body.getPosition().clone(), a0 = steel.body.getAngle();
  const hammer = g.drop('normal', 'I0', 5.5, 4, { vx: 4, vy: -12 });
  g.run(1.5);
  assert.ok(g.records.some((r) => isPair(r, steel, hammer)), 'the hammer hit the steel');
  const p = steel.body.getPosition();
  assert.ok(p.x === p0.x && p.y === p0.y && steel.body.getAngle() === a0, 'steel did not move');

  E.onSettle(g, steel);
  assert.strictEqual(g.stats.frozen, 1, 'idempotent');
  assert.strictEqual(g.eventsOf('freeze').length, 1);
});

test('vine welds what it rests on; the pair resists an impulse that separates an unwelded pair', () => {
  function scene(topType) {
    const g = new FakeGame();
    const base = place(g, 'normal', 'O0', 7, 0);
    const top = place(g, topType, 'O0', 7, 2);
    return { g, base, top };
  }
  const ctl = scene('normal'), vin = scene('vine');
  assert.strictEqual(ctl.g.stats.welded, 0);
  assert.strictEqual(vin.g.stats.welded, 1);
  assert.ok(jointedTo(vin.top, vin.base), 'weld joint exists');
  assert.strictEqual(vin.top.fx.welds.length, 1);
  near(vin.top.fx.welds[0].x, 1, 0.1, 'anchor local x');
  near(vin.top.fx.welds[0].y, 0, 0.05, 'anchor local y (shared face)');
  const w = vin.g.eventsOf('weld');
  assert.strictEqual(w.length, 1);
  assert.strictEqual(w[0].block, vin.top);
  near(w[0].points[0].x, 8, 0.1, 'weld world x');
  near(w[0].points[0].y, 2, 0.05, 'weld world y');
  E.onSettle(vin.g, vin.top);
  assert.strictEqual(vin.g.stats.welded, 1, 'idempotent');

  for (const s of [ctl, vin]) {
    const b = s.top.body;
    s.before = relPose(s.base, s.top);
    b.applyLinearImpulse({ x: 3 * b.getMass(), y: 9 * b.getMass() }, b.getWorldCenter(), true);
    s.g.run(0.25);
    s.after = relPose(s.base, s.top);
    s.moved = Math.hypot(s.after.x - s.before.x, s.after.y - s.before.y);
  }
  assert.ok(ctl.moved > 0.5, 'unwelded top flies off (moved ' + ctl.moved + ')');
  assert.ok(vin.moved < 0.02, 'welded pair stays together (moved ' + vin.moved + ')');
  assert.ok(Math.abs(vin.after.a - vin.before.a) < 0.01, 'welded pair keeps its relative angle');
});

test('vine also grabs a flush side neighbour and the platform, but not across a gap', () => {
  const g = new FakeGame();
  const left = place(g, 'normal', 'O0', 5, 0);
  const far = place(g, 'normal', 'O0', 9.3, 0);
  const vine = place(g, 'vine', 'O0', 7, 0);
  assert.ok(jointedTo(vine, left), 'welded to the flush neighbour');
  assert.ok(jointedTo(vine, g.physics.platform), 'welded to the platform');
  assert.ok(!jointedTo(vine, far), 'not welded across a 0.3 gap');
  assert.strictEqual(g.stats.welded, 2);
  assert.strictEqual(vine.fx.welds.length, 2);
  const side = vine.fx.welds.find((p) => p.x < 0.1);
  assert.ok(side, 'anchor on the left face');
  near(side.y, 1, 0.05, 'anchor centred on the shared face');
  E.onSettle(g, vine);
  assert.strictEqual(g.stats.welded, 2, 'idempotent');
  assert.strictEqual(g.eventsOf('weld').length, 1);
});

test('frost freezes itself and every block it touches', () => {
  const g = new FakeGame();
  const a = place(g, 'normal', 'O0', 5, 0);
  const b = place(g, 'normal', 'O0', 7, 0);
  const c = place(g, 'normal', 'O0', 9, 0);
  const d = place(g, 'normal', 'O0', 9, 2);     // on c, flush beside the frost's right end
  const frost = place(g, 'frost', 'I0', 5, 2);  // rests on a and b; only a corner meets c
  for (const blk of [frost, a, b, d]) {
    assert.ok(blk.body.isStatic(), 'frozen block is static');
    assert.strictEqual(blk.frozen, 'frost');
  }
  assert.ok(!c.body.isStatic() && c.frozen === null, 'diagonal neighbour stays dynamic');
  assert.strictEqual(g.stats.frozen, 4);
  const fz = g.eventsOf('freeze');
  assert.strictEqual(fz.length, 1);
  assert.strictEqual(fz[0].source, 'frost');
  assert.strictEqual(fz[0].blocks.length, 4);
  for (const blk of [frost, a, b, d]) assert.ok(fz[0].blocks.includes(blk));
  near(fz[0].x, 7, 0.05, 'freeze x');
  near(fz[0].y, 2.5, 0.05, 'freeze y');
  E.onSettle(g, frost);
  assert.strictEqual(g.stats.frozen, 4, 'idempotent');
});

test('crystal heals below max lives and shields at max', () => {
  const g = new FakeGame({ lives: 2 });
  const c1 = place(g, 'crystal', 'O0', 7, 0);
  assert.strictEqual(g.lives, 3);
  assert.ok(c1.fx.used);
  assert.ok(!g.shield);
  const lg = g.eventsOf('lifeGained');
  assert.strictEqual(lg.length, 1);
  assert.strictEqual(lg[0].reason, 'crystal');
  const c2 = place(g, 'crystal', 'O0', 7, 2);
  assert.ok(c2.fx.used);
  assert.ok(g.shield, 'shield at full lives');
  assert.strictEqual(g.lives, 3);
  E.onSettle(g, c1);
  E.onSettle(g, c2);
  assert.strictEqual(g.eventsOf('lifeGained').length, 1, 'idempotent');
  assert.strictEqual(g.eventsOf('shield').length, 1, 'idempotent');
});

test('mine arms, explodes when an O lands on top, removes itself and pushes a neighbour', () => {
  const g = new FakeGame();
  const side = place(g, 'normal', 'O0', 5, 0);
  const mine = place(g, 'mine', 'O0', 7, 0);
  assert.ok(mine.fx.armed && !mine.fx.lit);
  assert.strictEqual(g.eventsOf('mineArmed').length, 1);
  assert.strictEqual(g.eventsOf('mineArmed')[0].block, mine);
  assert.ok(E.hazards(g).mines.has(mine.id), 'hazards lists the armed mine');
  assert.ok(E.canPetrify(g, mine));
  g.run(0.5);
  assert.ok(!mine.fx.lit, 'a resting neighbour does not light it');

  const o = g.drop('normal', 'O0', 7, 6);
  assert.ok(g.runUntil(() => mine.fx.lit, 2), 'lit by the block landing on top');
  const fu = g.eventsOf('fuse');
  assert.strictEqual(fu.length, 1);
  assert.strictEqual(fu[0].block, mine);
  assert.ok(!E.canPetrify(g, mine), 'a lit mine is never petrified');
  const tLit = g.time;
  assert.ok(g.runUntil(() => mine.dead, 1), 'exploded');
  near(g.time - tLit, C.MINE_FUSE, 2 * FRAME, 'fuse length');
  assert.strictEqual(mine.deathReason, 'exploded');
  assert.strictEqual(g.stats.exploded, 1);
  const ex = g.eventsOf('explode');
  assert.strictEqual(ex.length, 1);
  near(ex[0].x, 8, 0.1, 'blast x');
  near(ex[0].y, 1, 0.1, 'blast y');
  assert.strictEqual(ex[0].radius, C.MINE_RADIUS);
  const v = side.body.getLinearVelocity();
  assert.ok(v.x < -1, 'neighbour pushed away from the blast (vx ' + v.x + ')');
  assert.ok(o.body.getLinearVelocity().y > 1, 'block on top thrown up');
  assert.ok(!side.dead && !o.dead, 'the blast removes nothing');
  assert.ok(!E.hazards(g).mines.has(mine.id));
  assert.strictEqual(g.stats.shattered + g.stats.swallowed, 0);
});

test('a block beside a mine never triggers it; a static mine still explodes', () => {
  const g = new FakeGame();
  const mine = place(g, 'mine', 'O0', 7, 0);
  const side = g.drop('normal', 'O0', 5, 4);    // falls flush past its side face
  assert.ok(g.runUntil(() => side.activated, 3));
  side.body.setLinearVelocity({ x: 1.5, y: 0 }); // slide into the mine's side face
  g.run(1.5);
  assert.ok(g.records.some((r) => isPair(r, mine, side) && !r.sensor && r.normal && Math.abs(r.normal.y) < 0.5),
    'a side contact happened');
  assert.ok(!mine.fx.lit && !mine.dead, 'not triggered from the side');

  // Freezing re-creates its contacts (the side block's again): still no trigger
  assert.ok(g.physics.makeStatic(mine, 'petrified'));
  g.run(0.5);
  assert.ok(!mine.fx.lit, 'not triggered by re-created side contact');
  assert.strictEqual(g.eventsOf('fuse').length, 0);

  g.drop('normal', 'O0', mine.body.getPosition().x, 6);
  assert.ok(g.runUntil(() => mine.dead, 3), 'static mine explodes');
  assert.strictEqual(mine.deathReason, 'exploded');
  assert.ok(side.body.getLinearVelocity().x < -0.5, 'neighbour pushed');
});

test('a block that landed on a mine before it armed does not set it off later', () => {
  const g = new FakeGame();
  const mine = g.drop('mine', 'O0', 7, 0.02);
  const lid = g.drop('normal', 'O0', 7, 2.1);
  assert.ok(g.runUntil(() => mine.activated && lid.activated, 3));
  assert.ok(mine.fx.armed && !mine.fx.lit);
  assert.ok(mine.fx.ignoreIds.has(lid.id));
  assert.ok(g.physics.makeStatic(mine, 'petrified')); // re-creates the contact with the lid
  g.run(0.5);
  assert.ok(g.records.filter((r) => isPair(r, mine, lid)).length >= 2, 'contact was re-created');
  assert.ok(!mine.fx.lit && !mine.dead);
});

test('contact records are handled whichever side the special block is on', () => {
  const g = new FakeGame();
  const mine = place(g, 'mine', 'O0', 7, 0);
  const o = place(g, 'normal', 'O0', 5, 0);
  E.onContact(g, solidRec(g, mine, o, { x: -1, y: 0 }));  // beside
  E.onContact(g, solidRec(g, o, mine, { x: 1, y: 0 }));
  E.onContact(g, solidRec(g, mine, o, { x: 0, y: -1 }));  // o below the mine
  E.onContact(g, solidRec(g, o, mine, { x: 0, y: 1 }));
  E.onContact(g, solidRec(g, mine, o, null));             // centroid fallback: beside
  assert.ok(!mine.fx.lit);
  E.onContact(g, solidRec(g, o, mine, { x: 0, y: -1 }));  // o -> mine points down: o is above
  assert.ok(mine.fx.lit);
  E.onContact(g, solidRec(g, mine, o, { x: 0, y: 1 }));
  assert.strictEqual(g.eventsOf('fuse').length, 1, 'idempotent');

  const P = g.physics;
  const anvil = P.createBlock({ typeKey: 'anvil', shapeId: 'O0' }, 7, 2);
  const t1 = P.createBlock({ typeKey: 'normal', shapeId: 'T0' }, 2, 0);
  const t2 = P.createBlock({ typeKey: 'normal', shapeId: 'T0' }, 12, 0);
  const t3 = P.createBlock({ typeKey: 'normal', shapeId: 'L0' }, 7, -2);
  const beside = P.createBlock({ typeKey: 'normal', shapeId: 'O0' }, 9, 2);
  assert.ok(E.canPetrify(g, anvil));
  anvil.fx.impactUntil = g.time + 1;
  assert.ok(!E.canPetrify(g, anvil), 'no petrify inside the impact window');
  E.onContact(g, solidRec(g, anvil, t1, { x: 1, y: 0 }));
  E.onContact(g, solidRec(g, t1, anvil, { x: 0, y: -1 })); // anvil below t1
  E.onContact(g, solidRec(g, anvil, beside, null));        // centroid fallback: beside
  assert.strictEqual(g.stats.shattered, 0);
  E.onContact(g, solidRec(g, t1, anvil, { x: 0, y: 1 }));  // t1 -> anvil points up: t1 below
  assert.ok(t1.dead && t1.deathReason === 'shattered');
  E.onContact(g, solidRec(g, anvil, t1, { x: 0, y: -1 }));
  E.onContact(g, solidRec(g, anvil, t2, { x: 0, y: -1 }));
  E.onContact(g, solidRec(g, t3, anvil, null));             // centroid fallback: below
  assert.ok(t2.dead && t3.dead);
  assert.strictEqual(g.stats.shattered, 3, 'a dead block is never shattered twice');
  E.onContact(g, solidRec(g, anvil, mine, { x: 0, y: -1 }));
  assert.ok(!mine.dead, 'mines are not shattered');
  const t4 = P.createBlock({ typeKey: 'normal', shapeId: 'T0' }, 2, 4);
  g.time = anvil.fx.impactUntil + 0.01;
  assert.ok(E.canPetrify(g, anvil));
  E.onContact(g, solidRec(g, anvil, t4, { x: 0, y: -1 }));
  assert.ok(!t4.dead, 'impact window over');
  assert.strictEqual(liveRubble(g).length, 12);
});

test('anvil dropped on a T piece shatters it into 4 rubble', () => {
  const g = new FakeGame();
  const t = place(g, 'normal', 'T0', 6, 0);
  const anvil = g.drop('anvil', 'O0', 7, 4);
  assert.ok(g.runUntil(() => t.dead, 2), 'T shattered');
  assert.strictEqual(t.deathReason, 'shattered');
  const rubble = liveRubble(g);
  assert.strictEqual(rubble.length, 4);
  assert.ok(rubble.every((r) => r.look === 'normal' && r.cracked && r.cells.length === 1));
  assert.strictEqual(g.stats.shattered, 1);
  const sh = g.eventsOf('shatter');
  assert.strictEqual(sh.length, 1);
  assert.strictEqual(sh[0].cause, 'anvil');
  assert.strictEqual(sh[0].count, 4);
  near(sh[0].x, 7.5, 0.05, 'shatter x (T centroid)');
  near(sh[0].y, 0.75, 0.05, 'shatter y (T centroid)');
  assert.ok(!anvil.dead);
  g.run(1.5);
  assert.strictEqual(g.stats.shattered, 1, 'rubble is never shattered again');
  assert.strictEqual(liveRubble(g).length, 4);
  assert.ok(E.canPetrify(g, anvil), 'impact window is over');
});

test('anvil does not shatter a mine: the mine detonates instead', () => {
  const g = new FakeGame();
  const mine = place(g, 'mine', 'O0', 7, 0);
  g.drop('anvil', 'O0', 7, 4);
  assert.ok(g.runUntil(() => mine.fx.lit, 2), 'anvil lights the mine');
  assert.ok(g.runUntil(() => mine.dead, 1));
  assert.strictEqual(mine.deathReason, 'exploded');
  assert.strictEqual(g.stats.shattered, 0);
});

test('crumble breaks into 4 rubble the moment it lands', () => {
  const g = new FakeGame();
  const cr = g.drop('crumble', 'T0', 6, 1);
  assert.ok(g.runUntil(() => cr.dead, 1), 'crumbled');
  assert.strictEqual(cr.deathReason, 'shattered');
  const rubble = liveRubble(g);
  assert.strictEqual(rubble.length, 4);
  assert.ok(rubble.every((r) => r.look === 'crumble' && r.cracked && r.touched && r.activated));
  const sh = g.eventsOf('shatter');
  assert.strictEqual(sh.length, 1);
  assert.strictEqual(sh[0].cause, 'crumble');
  assert.strictEqual(sh[0].count, 4);
  assert.strictEqual(g.stats.shattered, 1);
  g.run(1.5);
  assert.strictEqual(liveRubble(g).length, 4);
  assert.ok(liveRubble(g).every((r) => g.physics.bounds(r).minY > -0.05), 'rubble rests on the platform');
  assert.strictEqual(g.stats.shattered, 1);
});

test('magma melts after exactly MAGMA_TURNS turn starts once settled, even when frozen', () => {
  const g = new FakeGame();
  const m = g.drop('magma', 'O0', 7, 0.02);
  g.turnStart(); // a drop before it settled does not count
  assert.strictEqual(m.fx.turnsLeft, undefined);
  assert.ok(g.runUntil(() => m.activated, 2));
  assert.strictEqual(m.fx.turnsLeft, C.MAGMA_TURNS);
  for (let i = 1; i < C.MAGMA_TURNS; i++) {
    g.turnStart();
    assert.ok(!m.dead, 'alive after ' + i + ' turns');
    assert.strictEqual(m.fx.turnsLeft, C.MAGMA_TURNS - i);
  }
  E.onSettle(g, m);
  assert.strictEqual(m.fx.turnsLeft, 1, 'settle is idempotent');
  g.turnStart();
  assert.ok(m.dead && m.deathReason === 'melted');
  assert.strictEqual(g.stats.melted, 1);
  const mt = g.eventsOf('melt');
  assert.strictEqual(mt.length, 1);
  assert.strictEqual(mt[0].block, m);

  const f = place(g, 'magma', 'O0', 7, 0);
  assert.ok(g.physics.makeStatic(f, 'frost'));
  for (let i = 1; i < C.MAGMA_TURNS; i++) g.turnStart();
  assert.ok(!f.dead);
  g.turnStart();
  assert.ok(f.dead && f.deathReason === 'melted', 'frozen magma melts too');
  assert.strictEqual(g.stats.melted, 2);
  const last = g.eventsOf('melt')[1];
  near(last.x, 8, 0.05, 'melt x of a static block (centroid, not body origin)');
  near(last.y, 1, 0.05, 'melt y of a static block');
});

test('black hole spares a neighbour present at activation, swallows later ones beside it, not ones on top', () => {
  const g = new FakeGame();
  const left = place(g, 'normal', 'O0', 5, 0);
  const hole = place(g, 'blackhole', 'O0', 7, 0);
  assert.ok(hole.fx.active);
  const cells = hole.fx.horizonCells.map((c) => c.join(',')).sort();
  assert.deepStrictEqual(cells, ['-1,0', '-1,1', '2,0', '2,1']);
  assert.ok(!E.canPetrify(g, hole), 'in grace right after activation');
  g.run(1);
  assert.ok(E.canPetrify(g, hole));
  assert.ok(!left.dead && hole.fx.spared.has(left.id), 'pre-existing neighbour spared');
  assert.strictEqual(g.stats.swallowed, 0);

  const hz = E.hazards(g);
  assert.strictEqual(hz.horizons.length, 4);
  for (const box of hz.horizons) {
    assert.strictEqual(box.hole, hole);
    near(box.maxX - box.minX, C.HORIZON_SIZE, 0.01, 'box width');
    near(box.maxY - box.minY, C.HORIZON_SIZE, 0.01, 'box height');
  }
  const lefts = hz.horizons.filter((b) => b.maxX < 7.5), rights = hz.horizons.filter((b) => b.minX > 8.5);
  assert.strictEqual(lefts.length, 2);
  assert.strictEqual(rights.length, 2);
  for (const b of lefts) near(b.minX, 6.05, 0.02, 'left horizon minX');
  for (const b of rights) near(b.minX, 9.05, 0.02, 'right horizon minX');
  near(Math.min(...hz.horizons.map((b) => b.minY)), 0.05, 0.02, 'lowest horizon minY');
  near(Math.max(...hz.horizons.map((b) => b.maxY)), 1.95, 0.02, 'highest horizon maxY');
  assert.strictEqual(hz.mines.size, 0);

  const victim = g.drop('normal', 'O0', 9, 5);
  assert.ok(g.runUntil(() => victim.dead, 2), 'block dropped beside it is swallowed');
  assert.strictEqual(victim.deathReason, 'swallowed');
  const sw = g.eventsOf('swallow');
  assert.strictEqual(sw.length, 1);
  assert.strictEqual(sw[0].block, victim);
  assert.strictEqual(sw[0].hole, hole);
  near(sw[0].x, 10, 0.05, 'swallow x');
  assert.strictEqual(g.stats.swallowed, 1);

  // Rests on the hole and its neighbour, overhanging the right horizon by a full cell
  const lid = g.drop('normal', 'I0', 6, 2.3);
  assert.ok(g.runUntil(() => lid.activated, 3));
  g.run(1);
  assert.ok(!lid.dead, 'block on top is not swallowed');
  assert.ok(!left.dead);
  assert.strictEqual(g.stats.swallowed, 1);
  E.onSettle(g, hole);
  assert.strictEqual(E.hazards(g).horizons.length, 4, 'settle is idempotent');
});

test('a sleeping neighbour of a frozen black hole is spared too', () => {
  // Box2D only evaluates a contact once a body in it is awake and dynamic, so here the
  // neighbour's begin-contact arrives long after the grace window.
  const g = new FakeGame();
  const P = g.physics;
  const left = place(g, 'normal', 'O0', 5, 0);
  const hole = P.createBlock({ typeKey: 'blackhole', shapeId: 'O0' }, 7, 0.02); // not dropped: activated by hand
  g.run(0.2);
  assert.ok(P.makeStatic(hole, 'frost'));
  assert.ok(g.runUntil(() => !left.body.isAwake(), 3), 'neighbour falls asleep');
  hole.activated = true;
  const tActive = P.time;
  E.onSettle(g, hole);
  assert.ok(hole.fx.active && hole.fx.spared.has(left.id), 'spared by geometry at activation');
  g.run(0.5);
  left.body.setAwake(true);
  g.run(1);
  const late = g.records.find((r) => r.sensor && isPair(r, hole, left));
  assert.ok(late, 'begin-contact arrived once the neighbour woke');
  assert.ok(late.time > tActive + C.HORIZON_GRACE_STEPS / C.PHYSICS_HZ + 0.1, 'it arrived after the grace window');
  assert.ok(!left.dead, 'late overlap did not swallow the spared neighbour');
  assert.strictEqual(g.stats.swallowed, 0);
  const victim = g.drop('normal', 'O0', 9, 5);
  assert.ok(g.runUntil(() => victim.dead, 2), 'a frozen hole still swallows');
  assert.strictEqual(victim.deathReason, 'swallowed');
});

test('black hole sensor records: grace window, static blocks, foreign sensors, either side (synthetic)', () => {
  const g = new FakeGame();
  const P = g.physics;
  const sensorRec = (a, b, kindA, tagA, kindB, tagB) =>
    ({ a, b, kindA, kindB, tagA, tagB, sensor: true, normal: null, point: null, time: P.time });
  const horizon = (hole, other, holeIsA) => holeIsA
    ? sensorRec(hole, other, 'sensor', 'horizon', 'solid', null)
    : sensorRec(other, hole, 'solid', null, 'sensor', 'horizon');
  const hole = P.createBlock({ typeKey: 'blackhole', shapeId: 'O0' }, 7, 0);
  const early = P.createBlock({ typeKey: 'normal', shapeId: 'O0' }, 1, 8); // far away: not spared by geometry
  hole.activated = true;
  E.onSettle(g, hole);
  assert.ok(!hole.fx.spared.has(early.id));
  E.onContact(g, horizon(hole, early, false));
  assert.ok(!early.dead && hole.fx.spared.has(early.id), 'overlap reported within the grace substeps is spared');
  g.run(0.05);
  assert.ok(P.stepCount > hole.fx.graceUntil);
  E.onContact(g, horizon(hole, early, true));
  assert.ok(!early.dead, 'spared forever');

  const late = P.createBlock({ typeKey: 'normal', shapeId: 'O0' }, 12, 8);
  const frozen = P.createBlock({ typeKey: 'normal', shapeId: 'O0' }, 1, 12);
  const hole2 = P.createBlock({ typeKey: 'blackhole', shapeId: 'O0' }, 12, 12);
  assert.ok(P.makeStatic(frozen, 'petrified'));
  E.onContact(g, horizon(hole, frozen, true));
  E.onContact(g, horizon(hole, hole2, false));
  E.onContact(g, horizon(hole, P.platform, true));
  E.onContact(g, sensorRec(hole, late, 'solid', null, 'sensor', 'zone'));       // someone else's sensor
  E.onContact(g, sensorRec(late, hole, 'sensor', 'zone', 'sensor', 'horizon'));  // sensor vs sensor
  E.onContact(g, solidRec(g, hole, late, { x: 1, y: 0 }));                       // solid contact
  assert.ok(!frozen.dead && !hole2.dead && !late.dead);
  assert.strictEqual(g.stats.swallowed, 0);
  E.onContact(g, horizon(hole, late, false));
  assert.ok(late.dead && late.deathReason === 'swallowed', 'swallowed after the grace window');
  E.onContact(g, horizon(hole, late, true));
  assert.strictEqual(g.stats.swallowed, 1, 'idempotent');
  assert.strictEqual(g.eventsOf('swallow').length, 1);
});

test('explode pushes dynamic blocks with linear falloff and an upward bias, never static ones', () => {
  const g = new FakeGame();
  const blk = place(g, 'normal', 'O0', 5, 0);
  const st = place(g, 'normal', 'O0', 9, 0);
  assert.ok(g.physics.makeStatic(st, 'petrified'));
  blk.body.setLinearVelocity({ x: 0, y: 0 });
  blk.body.setAngularVelocity(0);
  const count = g.physics.blocks.length;
  const c = blk.body.getWorldCenter();
  const dx = c.x - 8, dy = c.y - 1;
  const fall = 1 - Math.hypot(dx, dy) / C.MINE_RADIUS;
  const len = Math.hypot(dx, dy + C.MINE_UPWARD_BIAS);
  assert.strictEqual(E.explode(g, 8, 1), 1);
  const v = blk.body.getLinearVelocity();
  near(v.x, C.MINE_IMPULSE * fall * dx / len, 0.01, 'vx');
  near(v.y, C.MINE_IMPULSE * fall * (dy + C.MINE_UPWARD_BIAS) / len, 0.01, 'vy');
  assert.ok(Math.abs(blk.body.getAngularVelocity()) <= 1.5 * fall + 1e-9, 'small cosmetic spin');
  assert.ok(st.body.isStatic() && st.body.getLinearVelocity().x === 0, 'static block untouched');
  assert.strictEqual(g.physics.blocks.length, count, 'nothing removed');
  const ex = g.eventsOf('explode');
  assert.strictEqual(ex.length, 1);
  assert.deepStrictEqual(ex[0], { x: 8, y: 1, radius: C.MINE_RADIUS });
  assert.strictEqual(E.explode(g, 8, 1, { radius: 1.2 }), 0, 'outside a smaller radius');
  assert.strictEqual(E.explode(g, 8, 1, { impulse: 0 }), 1);
});

test('ruby glass arms, survives a side neighbour, and shatters into glass rubble when an O lands on it', () => {
  const g = new FakeGame();
  const glass = place(g, 'glass', 'O0', 7, 0);
  assert.ok(glass.fx.armed);
  assert.strictEqual(glass.fx.ignoreIds.size, 0);
  assert.ok(E.hazards(g).glass.has(glass.id), 'hazards lists the armed glass');
  assert.ok(E.canPetrify(g, glass));

  const side = g.drop('normal', 'O0', 5, 4);       // falls flush past its side face
  assert.ok(g.runUntil(() => side.activated, 3));
  side.body.setLinearVelocity({ x: 1.5, y: 0 });   // slide into the glass's side face
  g.run(1.5);
  assert.ok(g.records.some((r) => isPair(r, glass, side) && !r.sensor && r.normal && Math.abs(r.normal.y) < 0.5),
    'a side contact happened');
  assert.ok(!glass.dead, 'a side neighbour does not break it');

  const o = g.drop('normal', 'O0', 7, 6);
  assert.ok(g.runUntil(() => glass.dead, 2), 'shattered by the block landing on it');
  assert.strictEqual(glass.deathReason, 'shattered');
  const rubble = liveRubble(g);
  assert.strictEqual(rubble.length, 4);
  assert.ok(rubble.every((r) => r.look === 'glass' && r.cracked && r.cells.length === 1), 'rubble keeps the glass look');
  const sh = g.eventsOf('shatter');
  assert.strictEqual(sh.length, 1);
  assert.strictEqual(sh[0].cause, 'glass');
  assert.strictEqual(sh[0].count, 4);
  near(sh[0].x, 8, 0.05, 'shatter x');
  near(sh[0].y, 1, 0.05, 'shatter y');
  assert.strictEqual(g.stats.shattered, 1);
  assert.ok(!E.hazards(g).glass.has(glass.id));
  g.run(1.5);
  assert.ok(!o.dead && !side.dead, 'the glass only breaks itself');
  assert.strictEqual(g.stats.shattered, 1, 'once');
  assert.strictEqual(liveRubble(g).length, 4);
});

test('glass ignores a block that rested on it before it armed, even once petrify re-creates their contact', () => {
  const g = new FakeGame();
  const glass = g.drop('glass', 'O0', 7, 0.02);
  const lid = g.drop('normal', 'O0', 7, 2.1);
  assert.ok(g.runUntil(() => glass.activated && lid.activated, 3));
  assert.ok(glass.fx.armed && glass.fx.ignoreIds.has(lid.id));
  E.onContact(g, solidRec(g, lid, glass, { x: 0, y: -1 }));  // its contact begins again while both are dynamic
  assert.ok(!glass.dead, 'a re-created contact is not a landing');
  assert.ok(g.physics.makeStatic(glass, 'petrified'));       // re-creates the contact with the lid
  g.run(0.5);
  assert.ok(g.records.filter((r) => isPair(r, glass, lid)).length >= 2, 'contact was re-created');
  assert.ok(!glass.dead);
  assert.strictEqual(g.stats.shattered, 0);
});

test('frozen glass is immune and no longer a hazard', () => {
  const g = new FakeGame();
  const glass = place(g, 'glass', 'O0', 7, 0);
  assert.ok(E.hazards(g).glass.has(glass.id));
  assert.ok(g.physics.makeStatic(glass, 'frost'));
  assert.ok(!E.hazards(g).glass.has(glass.id), 'landing on it is safe now');
  const o = g.drop('normal', 'O0', 7, 6);
  assert.ok(g.runUntil(() => o.activated, 3), 'the O rests on the frozen glass');
  assert.ok(g.records.some((r) => isPair(r, glass, o)), 'it landed on the glass');
  assert.ok(!glass.dead && glass.body.isStatic());
  assert.strictEqual(g.eventsOf('shatter').length, 0);
  near(o.body.getPosition().y, 2, 0.03, 'O on top of the glass');
});

test('spikes destroy a block dropped on top (no life lost, pop emitted first), spare a side neighbour, and work when static', () => {
  const g = new FakeGame();
  const aliveAtPop = watchPops(g);
  const sp = place(g, 'spikes', 'O0', 7, 0);
  assert.ok(sp.fx.active);
  assert.strictEqual(sp.fx.ignoreIds.size, 0);
  assert.ok(E.hazards(g).spikes.has(sp.id), 'hazards lists the active spikes');

  const side = g.drop('normal', 'O0', 5, 4);
  assert.ok(g.runUntil(() => side.activated, 3));
  side.body.setLinearVelocity({ x: 1.5, y: 0 });   // slide into the spikes' side face
  g.run(1.5);
  assert.ok(g.records.some((r) => isPair(r, sp, side) && !r.sensor && r.normal && Math.abs(r.normal.y) < 0.5),
    'a side contact happened');
  assert.ok(!side.dead, 'build beside it, never on it');

  const o = g.drop('normal', 'O0', 7, 6);
  assert.ok(g.runUntil(() => o.dead, 2), 'popped');
  assert.strictEqual(o.deathReason, 'popped');
  assert.ok(!g.physics.blocks.includes(o), 'removed from the world');
  assert.deepStrictEqual(aliveAtPop, [true], 'pop is emitted before the block is removed');
  const pops = g.eventsOf('pop');
  assert.strictEqual(pops.length, 1);
  assert.strictEqual(pops[0].block, o);
  assert.strictEqual(pops[0].spikes, sp);
  near(pops[0].x, 8, 0.05, 'pop x (centre of the popped block)');
  near(pops[0].y, 3, 0.1, 'pop y');
  assert.strictEqual(g.stats.popped, 1);
  assert.strictEqual(g.lives, 3);
  assert.ok(!sp.dead && !side.dead);
  assert.strictEqual(g.stats.shattered + g.stats.lost, 0);

  assert.ok(g.physics.makeStatic(sp, 'petrified'));
  assert.ok(E.hazards(g).spikes.has(sp.id), 'static spikes stay a hazard');
  const o2 = g.drop('normal', 'T0', 6.5, 6);
  assert.ok(g.runUntil(() => o2.dead, 2), 'static spikes still pop');
  assert.strictEqual(o2.deathReason, 'popped');
  assert.strictEqual(g.stats.popped, 2);
  assert.deepStrictEqual(aliveAtPop, [true, true]);
});

test('spikes win against an anvil, and pop a mine without setting it off', () => {
  const g = new FakeGame();
  const sp = place(g, 'spikes', 'T0', 6, 0);
  const anvil = g.drop('anvil', 'O0', 7, 4);
  assert.ok(g.runUntil(() => anvil.dead, 2), 'the anvil is popped');
  assert.strictEqual(anvil.deathReason, 'popped');
  assert.ok(!sp.dead && sp.cells.length === 4, 'the spikes are not shattered');
  assert.strictEqual(g.stats.shattered, 0);
  assert.strictEqual(g.stats.popped, 1);
  g.run(1);
  assert.ok(!sp.dead);

  const g2 = new FakeGame();
  const sp2 = place(g2, 'spikes', 'O0', 7, 0);
  const mine = g2.drop('mine', 'O0', 7, 4);
  assert.ok(g2.runUntil(() => mine.dead, 2));
  assert.strictEqual(mine.deathReason, 'popped');
  g2.run(1);
  assert.strictEqual(g2.eventsOf('explode').length + g2.eventsOf('fuse').length, 0, 'no blast');
  assert.strictEqual(g2.stats.exploded, 0);
  assert.ok(!sp2.dead);
});

test('an anvil dropped on armed glass shatters it exactly once', () => {
  const g = new FakeGame();
  const glass = place(g, 'glass', 'T0', 6, 0);
  const anvil = g.drop('anvil', 'O0', 7, 4);
  assert.ok(g.runUntil(() => glass.dead, 2));
  assert.strictEqual(glass.deathReason, 'shattered');
  g.run(1.5);
  const sh = g.eventsOf('shatter');
  assert.strictEqual(sh.length, 1);
  assert.strictEqual(sh[0].cause, 'glass');
  assert.strictEqual(sh[0].count, 4);
  assert.strictEqual(g.stats.shattered, 1);
  assert.ok(liveRubble(g).length === 4 && liveRubble(g).every((r) => r.look === 'glass'));
  assert.ok(!anvil.dead);
});

test('glass and spikes contact records: only a dynamic block landing on top counts, either side (synthetic)', () => {
  const g = new FakeGame();
  const P = g.physics;
  const glass = activate(g, P.createBlock({ typeKey: 'glass', shapeId: 'O0' }, 2, 0));
  const spikes = activate(g, P.createBlock({ typeKey: 'spikes', shapeId: 'O0' }, 12, 0));
  assert.ok(glass.fx.armed && spikes.fx.active);
  const o = P.createBlock({ typeKey: 'normal', shapeId: 'O0' }, 7, 0);
  const frozen = P.createBlock({ typeKey: 'normal', shapeId: 'O0' }, 7, 4);
  assert.ok(P.makeStatic(frozen, 'frost'));
  const sensor = (a, b) => Object.assign(solidRec(g, a, b, null), { sensor: true, kindA: 'sensor', tagA: 'horizon' });
  for (const h of [glass, spikes]) {
    E.onContact(g, solidRec(g, h, o, { x: 1, y: 0 }));        // beside
    E.onContact(g, solidRec(g, o, h, { x: -1, y: 0 }));
    E.onContact(g, solidRec(g, h, o, { x: 0, y: -1 }));       // o below
    E.onContact(g, solidRec(g, o, h, { x: 0, y: 1 }));
    E.onContact(g, solidRec(g, h, o, null));                  // centroid fallback: o beside
    E.onContact(g, sensor(h, o));                             // a sensor touching
    E.onContact(g, solidRec(g, h, frozen, { x: 0, y: 1 }));   // a static block on top
    E.onContact(g, solidRec(g, h, P.platform, { x: 0, y: 1 }));
    E.onContact(g, solidRec(g, P.platform, h, { x: 0, y: 1 }));
  }
  assert.ok(!glass.dead && !spikes.dead && !o.dead && !frozen.dead);
  assert.strictEqual(g.events.length, 0);

  E.onContact(g, solidRec(g, o, spikes, { x: 0, y: -1 }));   // o -> spikes points down: o is on top
  assert.ok(o.dead && o.deathReason === 'popped');
  E.onContact(g, solidRec(g, o, spikes, { x: 0, y: -1 }));
  const lid = P.createBlock({ typeKey: 'normal', shapeId: 'O0' }, 2, 2);
  E.onContact(g, solidRec(g, glass, lid, null));              // centroid fallback: on top
  assert.ok(glass.dead && !lid.dead);
  E.onContact(g, solidRec(g, glass, lid, { x: 0, y: 1 }));
  assert.strictEqual(g.stats.popped, 1, 'idempotent');
  assert.strictEqual(g.stats.shattered, 1, 'idempotent');
  assert.strictEqual(g.eventsOf('shatter')[0].cause, 'glass');

  // Anvil precedence: spikes pop the anvil; armed glass breaks itself; glass that has not
  // armed yet is just a block the anvil smashes
  const s2 = activate(g, P.createBlock({ typeKey: 'spikes', shapeId: 'T0' }, 2, 6));
  const g2 = activate(g, P.createBlock({ typeKey: 'glass', shapeId: 'T0' }, 6, 6));
  const g3 = P.createBlock({ typeKey: 'glass', shapeId: 'T0' }, 10, 6);
  const anvils = [0, 1, 2].map((i) => P.createBlock({ typeKey: 'anvil', shapeId: 'O0' }, 2 + 4 * i, 8));
  for (const a of anvils) a.fx.impactUntil = g.time + 1;
  E.onContact(g, solidRec(g, anvils[0], s2, { x: 0, y: -1 }));
  assert.ok(anvils[0].dead && anvils[0].deathReason === 'popped' && !s2.dead);
  E.onContact(g, solidRec(g, anvils[1], g2, { x: 0, y: -1 }));
  assert.ok(g2.dead && !anvils[1].dead);
  E.onContact(g, solidRec(g, anvils[2], g3, { x: 0, y: -1 }));
  assert.ok(g3.dead && !anvils[2].dead);
  assert.deepStrictEqual(g.eventsOf('shatter').map((s) => s.cause), ['glass', 'glass', 'anvil']);
  assert.strictEqual(g.stats.popped, 2);
});

test('magnet picks dynamic blocks near its cells that are within MAGNET_MAX_TILT of its grid', () => {
  const g = new FakeGame();
  const P = g.physics;
  const mk = (shapeId, x, y, angle) => P.createBlock({ typeKey: 'normal', shapeId }, x, y, { angle: angle || 0 });
  const magnet = P.createBlock({ typeKey: 'magnet', shapeId: 'O0' }, 7, 0);   // cell centres x 7.5|8.5, y 0.5|1.5
  const offset = mk('O0', 9.3, 0);                       // flat, 0.3 off the grid
  const tilted = mk('O0', 4.6, 0.3, 0.2);                // tilted 0.2 rad
  const turned = mk('I0', 7.5, 2.2, Math.PI / 2 + 0.1);  // a quarter turn + 0.1 rad: 0.1 from the grid
  const askew = mk('O0', 8, 3, 1);                       // 1 rad: 0.57 from the nearest quarter turn
  const inside = mk('P1', 10.4, 1);                      // cell centre 2.4 from the magnet's (8.5, 1.5)
  const outside = mk('P1', 10.6, 1);                     // 2.6 away
  const far = mk('O0', 13, 0);
  const frozen = mk('O0', 5, 2);
  assert.ok(P.makeStatic(frozen, 'petrified'));
  const falling = g.drop('normal', 'O0', 9, 2.5);        // still falling from the hover line
  for (const b of [askew, outside, far, frozen, falling]) assert.ok(b);
  activate(g, magnet);
  assert.deepStrictEqual(magnet.fx.targets, [offset.id, tilted.id, turned.id, inside.id]);
  assert.ok(magnet.fx.used);
  near(magnet.fx.pullUntil, g.time + C.MAGNET_TIME, 1e-9, 'pullUntil');
  const ev = g.eventsOf('magnet');
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].block, magnet);
  assert.strictEqual(ev[0].count, 4);
  near(ev[0].x, 8, 1e-6, 'magnet x');
  near(ev[0].y, 1, 1e-6, 'magnet y');
  assert.strictEqual(g.stats.magnetized, 4);
  assert.ok(!E.canPetrify(g, magnet), 'never petrified while pulling');
  activate(g, magnet);
  assert.strictEqual(g.eventsOf('magnet').length, 1, 'idempotent');
  assert.strictEqual(g.stats.magnetized, 4);
  g.time = magnet.fx.pullUntil;
  E.update(g, FRAME);
  assert.ok(E.canPetrify(g, magnet), 'the pull is over');
  assert.strictEqual(magnet.fx.pull, null);
  assert.ok(magnet.body.isDynamic(), 'the magnet itself stays dynamic');

  // nothing in reach: still announced, nothing pulled
  const g2 = new FakeGame();
  const lone = place(g2, 'magnet', 'O0', 7, 0);
  assert.deepStrictEqual(lone.fx.targets, []);
  assert.strictEqual(g2.eventsOf('magnet')[0].count, 0);
  assert.ok(E.canPetrify(g2, lone));
});

test('magnet stands a leaning neighbour straight and pulls an offset one flush onto its grid', () => {
  // A bar leaning on the magnet's top corner (a lean under ~0.25 rad would stand up by
  // itself) and an O resting 0.3 off the magnet's grid. The control has a stone instead.
  function scene(typeKey) {
    const g = new FakeGame();
    const P = g.physics;
    const mag = P.createBlock({ typeKey, shapeId: 'O0' }, 7, 0);
    const off = P.createBlock({ typeKey: 'normal', shapeId: 'O0' }, 4.7, 0);
    const bar = P.createBlock({ typeKey: 'normal', shapeId: 'I1' }, 9 + 2 * Math.tan(0.3) + 0.01, 0.005, { angle: 0.3 });
    g.run(1.5);
    assert.ok(bar.body.getAngle() > 0.25, 'the bar leans on its neighbour (' + bar.body.getAngle() + ')');
    assert.ok(Math.abs(onGrid(mag, off).off + 0.3) < 0.01, 'O starts 0.3 off');
    activate(g, mag);
    return { g, mag, off, bar };
  }
  const ctl = scene('normal');
  const s = scene('magnet');
  assert.deepStrictEqual(s.mag.fx.targets, [s.off.id, s.bar.id]);
  assert.strictEqual(s.g.stats.magnetized, 2);
  let pulling = 0;
  for (let i = 0; i < 60; i++) { s.g.frame(FRAME); ctl.g.frame(FRAME); if (s.mag.fx.pull) pulling++; }
  near(pulling * FRAME, C.MAGNET_TIME, 2 * FRAME, 'the pull lasts MAGNET_TIME');
  const bar = onGrid(s.mag, s.bar), off = onGrid(s.mag, s.off);
  assert.ok(Math.abs(bar.tilt) < 0.02, 'bar straightened (tilt ' + bar.tilt + ')');
  assert.ok(Math.abs(off.off) < 0.03, 'O on the lattice (off ' + off.off + ')');
  assert.strictEqual(off.col, -2, 'O flush beside the magnet');
  assert.strictEqual(bar.col, 2, 'bar flush beside the magnet');
  assert.ok(Math.abs(bar.off) < 0.03, 'bar on the lattice too (off ' + bar.off + ')');
  assert.ok(s.mag.body.isDynamic() && Math.abs(s.mag.body.getAngle()) < 0.01);
  s.g.run(1);
  assert.ok(Math.abs(onGrid(s.mag, s.bar).tilt) < 0.01 && Math.abs(onGrid(s.mag, s.off).off) < 0.03, 'and they stay there');
  assert.ok(ctl.bar.body.getAngle() > 0.25, 'without the magnet the bar keeps leaning');
  near(onGrid(ctl.mag, ctl.off).off, -0.3, 0.01, 'without the magnet the O stays off the grid');
});

test('magnet pulls a block resting on it onto its grid without rocking itself', () => {
  const g = new FakeGame();
  const P = g.physics;
  const mag = P.createBlock({ typeKey: 'magnet', shapeId: 'O0' }, 7, 0);
  const top = P.createBlock({ typeKey: 'normal', shapeId: 'O0' }, 7.3, 2.01);
  g.run(1.5);
  activate(g, mag);
  assert.deepStrictEqual(mag.fx.targets, [top.id]);
  let rock = 0;
  for (let i = 0; i < 120; i++) { g.frame(FRAME); rock = Math.max(rock, Math.abs(mag.body.getAngle())); }
  const t = onGrid(mag, top);
  assert.ok(Math.abs(t.off) < 0.03 && t.col === 0, 'on top, on the grid (col ' + t.col + ', off ' + t.off + ')');
  assert.ok(Math.abs(t.tilt) < 0.01);
  assert.ok(rock < 0.03, 'the magnet barely rocks (' + rock + ' rad)');
});

test('rubber bounces, and so does a block dropped on it; stone does not', () => {
  assert.strictEqual(TT.BLOCK_TYPES.rubber.restitution, 0.55);
  assert.ok(!E.HANDLERS.rubber, 'material only');
  // Highest point an O reaches after it first touches what it was dropped on (3 m below)
  function rebound(baseType, dropType) {
    const g = new FakeGame();
    const top = baseType ? 2 : 0;
    if (baseType) place(g, baseType, 'O0', 7, 0);
    const b = g.drop(dropType, 'O0', 7, top + 3);
    let peak = -Infinity;
    for (let i = 0; i < 150; i++) {
      g.frame(FRAME);
      if (b.touched) peak = Math.max(peak, b.body.getPosition().y - top);
    }
    return peak;
  }
  const onStone = rebound('normal', 'normal'), onRubber = rebound('rubber', 'normal');
  const rubberDropped = rebound(null, 'rubber'), stoneDropped = rebound(null, 'normal');
  assert.ok(onStone < 0.05, 'stone on stone does not bounce (' + onStone + ')');
  assert.ok(onRubber > 0.5, 'stone on rubber bounces (' + onRubber + ' m)');   // ~0.55^2 * 3 m
  assert.ok(stoneDropped < 0.05, 'stone on the platform does not bounce (' + stoneDropped + ')');
  assert.ok(rubberDropped > 0.5, 'rubber bounces on the platform (' + rubberDropped + ' m)');
});

test('hazards lists live active spikes and live armed glass that can still break', () => {
  const g = new FakeGame();
  const P = g.physics;
  const mk = (typeKey, x, y) => P.createBlock({ typeKey, shapeId: 'O0' }, x, y);
  const s1 = mk('spikes', 1, 0), s2 = mk('spikes', 4, 0), g1 = mk('glass', 7, 0), g2 = mk('glass', 10, 0), g3 = mk('glass', 13, 0);
  const mine = mk('mine', 1, 6);
  let hz = E.hazards(g);
  assert.strictEqual(hz.spikes.size + hz.glass.size + hz.mines.size + hz.horizons.length, 0, 'nothing activated yet');
  for (const b of [s1, s2, g1, g2, g3, mine]) activate(g, b);
  const ids = (set) => Array.from(set).sort((a, b) => a - b);
  hz = E.hazards(g);
  assert.deepStrictEqual(ids(hz.spikes), [s1.id, s2.id]);
  assert.deepStrictEqual(ids(hz.glass), [g1.id, g2.id, g3.id]);
  assert.deepStrictEqual(ids(hz.mines), [mine.id]);
  assert.deepStrictEqual(hz.horizons, []);
  assert.ok(P.makeStatic(s2, 'petrified'));   // static spikes still pop
  assert.ok(P.makeStatic(g2, 'frost'));       // frozen glass is immune
  P.removeBlock(s1, 'swallowed');
  P.shatter(g3);
  hz = E.hazards(g);
  assert.deepStrictEqual(ids(hz.spikes), [s2.id]);
  assert.deepStrictEqual(ids(hz.glass), [g1.id]);
  assert.deepStrictEqual(ids(hz.mines), [mine.id]);
});

test('dispatchers ignore dead blocks, the platform and plain types', () => {
  const g = new FakeGame();
  const P = g.physics;
  const plain = P.createBlock({ typeKey: 'normal', shapeId: 'O0' }, 7, 0);
  const dead = P.createBlock({ typeKey: 'crumble', shapeId: 'T0' }, 2, 0);
  P.removeBlock(dead, 'lost');
  E.onFirstTouch(g, dead, null);
  E.onSettle(g, dead);
  E.onSettle(g, P.platform);
  E.onFirstTouch(g, plain, null);
  E.onSettle(g, plain);
  E.onContact(g, solidRec(g, plain, P.platform, { x: 0, y: -1 }));
  E.onContact(g, solidRec(g, dead, plain, { x: 0, y: -1 }));
  E.update(g, 1);
  E.onTurnStart(g);
  assert.strictEqual(g.events.length, 0);
  assert.ok(E.canPetrify(g, plain));
  assert.ok(!E.canPetrify(g, dead));
  assert.deepStrictEqual(Object.keys(E.HANDLERS).sort(),
    ['anvil', 'blackhole', 'crumble', 'crystal', 'frost', 'glass', 'magma', 'magnet', 'mine', 'spikes', 'steel', 'vine']);
});

test('in the real game: spikes and glass are flagged by the ghost, and a popped block costs no life', () => {
  const game = TT.Game.create({ seed: 'POPGLASS', mode: 'fixed', enabledTypes: [] });
  const step = (s) => { for (let i = 0; i < Math.round(s * 60); i++) game.update(FRAME); };
  const ready = () => { for (let i = 0; i < 480 && !game.canDrop; i++) game.update(FRAME); return game.canDrop; };
  const popped = [];
  game.on('pop', (p) => popped.push({ block: p.block, alive: !p.block.dead }));
  step(0.1);
  const P = game.physics;
  const sp = P.createBlock({ typeKey: 'spikes', shapeId: 'O0' }, 5, 0.02);
  const gl = P.createBlock({ typeKey: 'glass', shapeId: 'O0' }, 9, 0.02);
  sp.dropped = gl.dropped = true;
  step(2);
  assert.ok(sp.activated && sp.fx.active && gl.activated && gl.fx.armed);
  const forceO = () => {
    game.batch[game.selected].spec = { n: -1, typeKey: 'normal', shapeId: 'O0' };
    game.selectSlot(game.selected);
  };
  assert.ok(ready());
  forceO();
  game.setTargetX(5);
  assert.deepStrictEqual(game.ghost.warnings, ['spikes'], 'ghost over the spikes');
  game.setTargetX(9);
  assert.deepStrictEqual(game.ghost.warnings, ['glass'], 'ghost over the glass');
  game.setTargetX(7);
  assert.deepStrictEqual(game.ghost.warnings, [], 'between them');

  game.setTargetX(5);
  const lives = game.lives;
  assert.ok(game.drop());
  const victim = P.blocks[P.blocks.length - 1];
  step(2);
  assert.ok(victim.dead && victim.deathReason === 'popped', 'popped by the spikes');
  assert.deepStrictEqual(popped, [{ block: victim, alive: true }]);
  assert.strictEqual(game.lives, lives, 'no life lost');
  assert.strictEqual(game.stats.popped, 1);
  assert.strictEqual(game.stats.lost + game.stats.livesLost, 0);

  assert.ok(ready());
  forceO();
  game.setTargetX(9);
  assert.ok(game.drop());
  const lander = P.blocks[P.blocks.length - 1];
  step(2);
  assert.ok(gl.dead && gl.deathReason === 'shattered', 'the glass broke');
  assert.ok(!lander.dead, 'the block that broke it survives');
  assert.strictEqual(game.stats.shattered, 1);
  assert.strictEqual(game.lives, lives);
});

// --- 'already resting on top' at arming (mine, spikes, glass) ---------------------------
// Scenes in the real game: blocks created in place; touched ones settle by themselves.
function restScene(seed) {
  const game = TT.Game.create({ seed, mode: 'fixed', enabledTypes: [] });
  game.update(FRAME);
  const P = game.physics;
  const seen = [];
  game.on('*', (name) => { if (['fuse', 'explode', 'pop', 'shatter'].includes(name)) seen.push(name); });
  const mk = (typeKey, shapeId, x, y, opts, untouched) => {
    const b = P.createBlock({ typeKey, shapeId }, x, y, opts);
    if (!untouched) b.dropped = b.touched = true;
    return b;
  };
  const step = (s) => { for (let i = 0; i < Math.round(s / FRAME); i++) game.update(FRAME); };
  return { game, P, mk, step, seen };
}

test('a lid resting on a mine or spikes stays ignored when frost freezes the hazard before it arms', () => {
  for (const hazard of ['mine', 'spikes']) {
    for (const withFrost of [false, true]) {
      // Creation order is settle order: the frost settles first and freezes its flush neighbour
      const s = restScene('FROSTARM');
      const left = s.mk(withFrost ? 'frost' : 'normal', 'O0', 5, 0);
      const h = s.mk(hazard, 'O0', 7, 0);
      const lid = s.mk('normal', 'O0', 7, 2);
      s.step(2);
      const what = hazard + (withFrost ? ' frozen by frost' : ' (control)');
      assert.strictEqual(h.body.isStatic(), withFrost, what + ': static only when frozen');
      assert.strictEqual(left.body.isStatic(), withFrost);
      assert.ok(h.fx.armed || h.fx.active, what + ' armed');
      assert.ok(h.fx.ignoreIds.has(lid.id), what + ': the lid resting on it is ignored');
      assert.ok(!h.dead && !lid.dead && !h.fx.lit, what + ': nothing set off');
      assert.deepStrictEqual(s.seen, [], what + ': no fuse / explode / pop');
    }
  }
});

test('frost freezing only the lid does not let the mine below arm without it', () => {
  // The frost touches the lid, not the mine; the mine settles later in the same pass
  for (const withFrost of [false, true]) {
    const s = restScene('FROSTARM2');
    s.mk('normal', 'O0', 5, 0);
    const frost = s.mk(withFrost ? 'frost' : 'normal', 'O0', 5, 2);
    const mine = s.mk('mine', 'O0', 7, 0);
    const lid = s.mk('normal', 'O0', 7, 2);
    s.step(2.5);
    assert.strictEqual(lid.body.isStatic(), withFrost);
    assert.ok(!mine.dead && mine.fx.armed && !mine.fx.lit, 'mine armed and quiet');
    assert.ok(mine.fx.ignoreIds.has(lid.id), 'lid ignored (' + (withFrost ? 'frost' : 'control') + ')');
    assert.strictEqual(frost.body.isStatic(), withFrost);
    assert.strictEqual(s.game.stats.exploded, 0);
    assert.deepStrictEqual(s.seen, []);
  }
});

test('a tilted lid on an unarmed hazard that frost freezes is remembered from its contact', () => {
  // The bar leans from a column onto the hazard: its cells are not flush with the hazard's,
  // so only the contact (which freezing destroys) says it rests on top
  for (const hazard of ['mine', 'spikes']) {
    const s = restScene('TILT');
    s.mk('normal', 'O0', 5, 0);
    s.mk('normal', 'P1', 5, 2);
    const h = s.mk(hazard, 'O0', 8, 0, null, true);  // untouched: it only arms once frozen
    const bar = s.mk('normal', 'I0', 5.6, 3.01, { angle: -Math.atan2(1, 2.2) });
    s.step(2);
    assert.ok(Math.abs(bar.body.getAngle()) > 0.2, 'the bar is tilted (' + bar.body.getAngle() + ')');
    assert.ok(s.P.touching(h).some((t) => t.other === bar), 'the bar rests on the ' + hazard);
    s.mk('frost', 'P1', 10, 0.01);                     // flush right of its lower cell
    s.step(1.5);
    assert.ok(h.body.isStatic() && (h.fx.armed || h.fx.active), hazard + ' frozen and armed');
    assert.ok(h.fx.ignoreIds.has(bar.id), hazard + ' ignores the bar');
    bar.body.setAwake(true);                           // re-creates their contact
    s.step(1.5);
    assert.ok(!h.dead && !bar.dead && !h.fx.lit, hazard + ': nothing set off');
    assert.deepStrictEqual(s.seen, []);
  }
});

test('a pebble resting in the notch of an L/J hazard is ignored although its side contact comes first', () => {
  // Box2D lists the side contact (against the raised cell) before the top one
  for (const [shape, pebX, push] of [['L0', 6, 6.5], ['J0', 8, -6.5]]) {
    for (const hazard of ['mine', 'spikes', 'glass']) {
      const s = restScene('DEDUPE');
      const h = s.mk(hazard, shape, 6, 0);
      const peb = s.mk('pebble', 'P1', pebX, 1);
      s.step(4 * FRAME);
      peb.body.setLinearVelocity({ x: push, y: 0 });   // slides into the raised cell's side face
      s.step(1.5);
      const what = hazard + ' ' + shape;
      const ny = [];
      for (let ce = h.body.getContactList(); ce; ce = ce.next) {
        if (ce.other !== peb.body || !ce.contact.isTouching()) continue;
        const wm = ce.contact.getWorldManifold(null);
        ny.push(Math.round((ce.contact.getFixtureA().getBody() === h.body ? 1 : -1) * wm.normal.y) || 0);
      }
      assert.deepStrictEqual(ny, [0, 1], what + ': side contact listed first, then the top one');
      assert.ok(h.fx.ignoreIds.has(peb.id), what + ': the pebble resting on it is ignored');
      if (hazard === 'glass') {
        E.onContact(s.game, solidRec(s.game, peb, h, { x: 0, y: -1 })); // its contact begins again
      } else {
        assert.ok(s.P.makeStatic(h, 'petrified'));     // petrify re-creates the contact
        s.step(1);
      }
      assert.ok(!h.dead && !peb.dead && !h.fx.lit, what + ': nothing set off');
      assert.deepStrictEqual(s.seen, [], what);
    }
  }
});

test('a block flush on top counts as resting without a contact; one beside or still falling does not', () => {
  // Frozen before any step, so the pair never had a Box2D contact
  const g = new FakeGame();
  const P = g.physics;
  const mine = P.createBlock({ typeKey: 'mine', shapeId: 'O0' }, 7, 0);
  const lid = P.createBlock({ typeKey: 'normal', shapeId: 'P1' }, 7, 1.99); // on its left top cell
  const side = P.createBlock({ typeKey: 'normal', shapeId: 'O0' }, 9, 0);   // flush beside it
  assert.ok(P.makeStatic(lid, 'frost'));
  activate(g, mine);                              // as game.js does for a block frozen first
  assert.ok(mine.fx.armed && mine.fx.ignoreIds.has(lid.id), 'flush lid ignored without a contact');
  assert.ok(!mine.fx.ignoreIds.has(side.id), 'a side neighbour is not on top');
  g.run(0.5);
  assert.ok(g.records.some((r) => isPair(r, mine, lid)), 'their contact began once stepped');
  assert.ok(!mine.fx.lit && !mine.dead, 'not set off by it');

  const g2 = new FakeGame();
  const mine2 = g2.physics.createBlock({ typeKey: 'mine', shapeId: 'O0' }, 7, 0);
  const falling = g2.drop('normal', 'P1', 8, 2);  // flush on top, but still falling: landing now
  activate(g2, mine2);
  assert.ok(!mine2.fx.ignoreIds.has(falling.id), 'a falling block is not resting');
  assert.ok(g2.runUntil(() => mine2.fx.lit, 1), 'it lights the mine');
});

test('vine weld anchors know their partner and disappear when it is destroyed', () => {
  const g = new FakeGame();
  const base = place(g, 'normal', 'I0', 5, 0);
  const side = place(g, 'normal', 'O0', 9, 0);
  const vine = place(g, 'vine', 'O0', 7, 1);       // on the plank, flush beside the O
  const partners = vine.fx.welds.map((w) => w.partner);
  assert.strictEqual(vine.fx.welds.length, 2);
  assert.ok(partners.includes(base) && partners.includes(side), 'anchors name their partners');
  assert.ok(vine.fx.welds.every((w) => w.joint && jointedTo(vine, w.partner)), 'and keep their joint');
  g.physics.shatter(base);                          // the joint goes with the body
  g.run(FRAME);
  assert.ok(base.dead && !jointedTo(vine, base));
  assert.strictEqual(vine.fx.welds.length, 1, 'its anchor is dropped');
  assert.ok(vine.fx.welds[0].partner === side && typeof vine.fx.welds[0].x === 'number', 'the other one stays');
  g.physics.removeBlock(side, 'swallowed');
  g.run(FRAME);
  assert.strictEqual(vine.fx.welds.length, 0);
});

// ---------------------------------------------------------------------------------------
let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log('ok   ' + t.name);
  } catch (err) {
    failed++;
    console.log('FAIL ' + t.name + '\n' + (err && err.stack ? err.stack : err));
  }
}
if (failed) {
  console.log(failed + ' of ' + tests.length + ' effects tests failed');
  process.exit(1);
}
console.log('effects ok (' + tests.length + ' tests)');
