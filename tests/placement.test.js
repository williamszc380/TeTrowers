/* Placement: skyline, landing prediction, assisted/fixed/manual candidates, stepping,
 * snapping, hazard warnings, guided-fall targets, landing vs Box2D, buildSurface speed.
 */
'use strict';
const assert = require('assert');
const TT = require('./load-core')({ only: ['js/config.js', 'js/util.js', 'js/rng.js', 'js/shapes.js', 'js/blocktypes.js', 'js/generator.js', 'js/physics.js', 'js/placement.js'] });

const C = TT.CONFIG;
const P = TT.Placement;
const S = TT.SHAPES;
const FW = C.FIELD_WIDTH;
const PX0 = C.PLATFORM_X0, PX1 = C.PLATFORM_X1;     // 4.9 and 11.1: not on the integer grid
const MERGE = P.CANDIDATE_MERGE;
const ALL_SHAPES = TT.TETROMINO_IDS.concat(['P1']);
assert.strictEqual(MERGE, 0.08);

// ---- helpers ------------------------------------------------------------------------
// A static block placed exactly (cell geometry is then exact, no physics noise)
function put(ph, shapeId, x, y, opts) {
  const o = opts || {};
  const b = ph.createBlock({ typeKey: o.typeKey || 'normal', shapeId }, x, y, { angle: o.angle || 0 });
  ph.makeStatic(b, 'petrified');
  b.touched = true;
  return b;
}
function settle(ph, seconds) {
  const n = Math.round(seconds * C.PHYSICS_HZ);
  for (let i = 0; i < n; i++) ph.step(1 / C.PHYSICS_HZ);
}
function near(actual, expected, eps, msg) {
  assert.ok(Math.abs(actual - expected) <= eps, (msg || 'value') + ': expected ' + expected + ' ±' + eps + ', got ' + actual);
}
function nearList(actual, expected, eps, msg) {
  assert.strictEqual(actual.length, expected.length, (msg || 'list') + ' length: ' + JSON.stringify(actual));
  for (let i = 0; i < expected.length; i++) near(actual[i], expected[i], eps, (msg || 'list') + '[' + i + ']');
}
const frac = (v) => v - Math.floor(v);
const onHalf = (x) => Math.abs(x * 2 - Math.round(x * 2)) < 1e-6;
const has = (list, x) => list.some((v) => Math.abs(v - x) < 1e-9);
function halfGrid(w) {
  const out = [];
  for (let i = 0; i * 0.5 <= FW - w + 1e-9; i++) out.push(i * 0.5);
  return out;
}
// Corner-aligned positions: a column boundary j (0..w) of the piece on one of the corners
function alignedTo(corners, w) {
  const out = [];
  for (const c of corners) for (let j = 0; j <= w; j++) if (c - j > -1e-6 && c - j < FW - w + 1e-6) out.push(c - j);
  return out.sort((a, b) => a - b);
}
const platformAligned = (w) => alignedTo([PX0, PX1], w);
// Brute-force reference of the corners below, from the exact world geometry: the platform's
// edges plus, for every block owning part of the skyline, both ends of each cell's face that
// looks up most, unless another cell of the same block sits right behind that face.
function refCorners(ph, s) {
  const out = [ph.platform.x0, ph.platform.x1];
  for (const b of new Set(s.owner.filter((o) => o && !o.isPlatform))) {
    const quads = ph.cellQuads(b);
    for (const q of quads) {
      let best = -1, bestY = -Infinity;
      for (let i = 0; i < 8; i += 2) {
        const my = (q.pts[i + 1] + q.pts[(i + 3) & 7]) / 2;
        if (my > bestY) { bestY = my; best = i; }
      }
      const ax = q.pts[best], ay = q.pts[best + 1], bx = q.pts[(best + 2) & 7], by = q.pts[(best + 3) & 7];
      const nx = ax + bx - q.x, ny = ay + by - q.y;     // centre of the cell behind that face
      if (quads.some((o) => o !== q && Math.hypot(o.x - nx, o.y - ny) < 0.1)) continue;
      out.push(ax, bx);
    }
  }
  return out;
}
// The assisted contract: sorted, in range, no two positions closer than MERGE; every one is
// on the half grid or corner-aligned; every half-grid position is there unless a corner-
// aligned one closer than MERGE replaced it; every corner-aligned position is there or has
// a corner-aligned stand-in closer than MERGE.
function checkAssisted(ph, s, shape, cand, label) {
  const want = alignedTo(refCorners(ph, s), shape.w);
  const isAligned = (x) => want.some((v) => Math.abs(v - x) < 1e-6);
  const standIn = (x) => cand.some((v) => Math.abs(v - x) < MERGE && isAligned(v));
  assert.ok(Object.isFrozen(cand), label + ': frozen');
  for (let i = 0; i < cand.length; i++) {
    const x = cand[i];
    assert.ok(x >= -1e-9 && x <= FW - shape.w + 1e-9, label + ': in range ' + x);
    if (i) assert.ok(cand[i] - cand[i - 1] >= MERGE - 1e-9, label + ': sorted & merged at ' + cand[i - 1] + ', ' + x);
    assert.ok(onHalf(x) || isAligned(x), label + ': x=' + x + ' on the half grid or corner-aligned');
  }
  for (const g of halfGrid(shape.w)) assert.ok(has(cand, g) || standIn(g), label + ': half-grid ' + g + ' present or merged');
  for (const a of want) {
    assert.ok(cand.some((v) => Math.abs(v - a) < 1e-6) || standIn(a), label + ': corner-aligned ' + a.toFixed(4) + ' present or merged');
  }
}

// ---- 1. Platform only -----------------------------------------------------------------
{
  const ph = TT.Physics.create();
  const s = P.buildSurface(ph, {});
  assert.ok(s.skyline instanceof Float32Array);
  assert.strictEqual(s.skyline.length, (FW + 2) * 32);
  assert.strictEqual(s.owner.length, s.skyline.length);
  // samples over the platform (6.2 wide, off the integer grid) belong to it, beyond it are empty
  assert.ok(ph.platform.x0 === PX0 && ph.platform.x1 === PX1 && PX1 - PX0 > 6.1, 'platform ' + PX0 + '..' + PX1);
  let onPlatform = 0;
  for (let k = 0; k < s.skyline.length; k++) {
    const x = P.sampleX(k);
    if (x > PX0 && x < PX1) { assert.strictEqual(s.skyline[k], 0); assert.strictEqual(s.owner[k], ph.platform); onPlatform++; }
    else { assert.strictEqual(s.skyline[k], -Infinity); assert.strictEqual(s.owner[k], null); }
  }
  assert.strictEqual(onPlatform, 198, '6.2 cells of samples');
  // assisted: the half grid plus every position with a column boundary on a platform edge
  for (const id of ALL_SHAPES) {
    const shape = S[id];
    const cand = P.candidates(s, shape, 'assisted');
    nearList(Array.from(cand), halfGrid(shape.w).concat(platformAligned(shape.w)).sort((a, b) => a - b), 1e-9, id + ' assisted on the bare platform');
    checkAssisted(ph, s, shape, cand, id + ' bare platform');
    assert.deepStrictEqual(Array.from(P.candidates(s, shape, 'fixed')), halfGrid(shape.w), id + ' fixed = half grid');
  }
  const o = P.candidates(s, S.O0, 'assisted');
  for (const [x, what] of [[4.9, 'left edge on the left edge'], [3.9, 'middle on the left edge'], [2.9, 'right edge on the left edge'],
    [11.1, 'left edge on the right edge'], [10.1, 'middle on the right edge'], [9.1, 'right edge on the right edge']]) {
    assert.ok(has(o, x), 'O0 at ' + x + ': ' + what);
  }
  assert.ok(has(o, 5) && has(o, 9) && has(o, 9.5), 'the half grid stays next to them (0.1 apart)');
  const L = P.landing(s, S.O0, 7);
  assert.strictEqual(L.y, 0);
  assert.strictEqual(L.void, false);
  assert.strictEqual(L.primary, ph.platform);
  assert.deepStrictEqual(L.supports, [ph.platform]);
  assert.deepStrictEqual(L.warnings, []);
  assert.strictEqual(P.landing(s, S.O0, 4.9).primary, ph.platform, 'flush with the left edge');
  assert.strictEqual(P.landing(s, S.O0, 9.1).primary, ph.platform, 'flush with the right edge');
  assert.strictEqual(P.landing(s, S.O0, 4.5).y, 0, 'partly over the edge still lands');
  assert.strictEqual(P.landing(s, S.O0, 3).y, 0, 'overlapping the edge by 0.06 lands');
  assert.strictEqual(P.landing(s, S.O0, 10.5).y, 0);
  for (const x of [0, 2.9, 2.92, 11.1, 13.5, 14]) {        // 2.9 and 11.1 merely touch the platform edge
    const v = P.landing(s, S.O0, x);
    assert.deepStrictEqual(v, { y: null, void: true, primary: null, supports: [], warnings: ['void'] }, 'void at ' + x);
  }
  assert.strictEqual(P.guideTarget(s, S.O0, 7), null, 'platform is not a guide target');
  assert.strictEqual(P.guideTarget(s, S.O0, 0), null, 'void is not a guide target');
}

// ---- 2. Stepped surface: exact landing heights ------------------------------------------
{
  const ph = TT.Physics.create();
  const i0 = put(ph, 'I0', 5, 0);    // [5,9] x [0,1]
  const o0 = put(ph, 'O0', 5, 1);    // [5,7] x [1,3]
  const i1 = put(ph, 'I1', 10, 0);   // [10,11] x [0,4]
  const s = P.buildSurface(ph, {});
  const y = (id, x) => P.landing(s, S[id], x).y;
  // hand-checked: skyline is 0 on [4.9,5], 3 on [5,7], 1 on [7,9], 0 on [9,10], 4 on [10,11], 0 on [11,11.1]
  assert.strictEqual(y('T0', 5), 3);
  assert.strictEqual(y('T0', 6.5), 3);
  assert.strictEqual(y('T0', 7), 1);
  assert.strictEqual(y('T0', 8), 4);
  assert.strictEqual(y('T2', 7), 1);     // bottom [1,0,1]: the middle cell sits on the I0
  assert.strictEqual(y('T2', 8), 3);     // ...or the right arm hooks onto the I1 top
  assert.strictEqual(y('T2', 4), 3);
  assert.strictEqual(y('J0', 4), 3);     // column [4,5] only grazes the platform
  assert.strictEqual(y('J1', 8), 1);     // bottom [0,2]
  assert.strictEqual(y('J1', 9), 2);     // its top-right arm hooks onto the I1 top
  assert.strictEqual(y('J2', 5), 2);     // bottom [1,1,0]: top row rests on the O
  assert.strictEqual(y('J3', 9), 4);
  assert.strictEqual(y('L2', 6), 3);     // bottom [0,1,1]
  assert.strictEqual(y('L2', 7), 1);
  assert.strictEqual(y('L3', 9), 4);     // bottom [2,0]
  assert.strictEqual(y('L3', 4), 3);
  assert.strictEqual(y('S0', 7), 1);     // bottom [0,0,1]
  assert.strictEqual(y('S0', 8), 3);
  assert.strictEqual(y('S1', 8.5), 4);   // bottom [1,0]: column [9.5,10.5] reaches the I1 top
  assert.strictEqual(y('Z0', 6), 2);     // bottom [1,0,0]

  // brute force: exact interval maths over every shape and half-grid position
  const boxes = [{ x0: PX0, x1: PX1, top: 0 }];
  for (const b of [i0, o0, i1]) {
    const p = b.body.getPosition();
    for (const [cx, cy] of b.cells) boxes.push({ x0: p.x + cx, x1: p.x + cx + 1, top: p.y + cy + 1 });
  }
  for (const id of ALL_SHAPES) {
    const shape = S[id];
    for (let x = 0; x <= FW - shape.w; x += 0.5) {
      let want = -Infinity;
      for (let j = 0; j < shape.w; j++) {
        const a = x + j + 0.04, b = x + j + 0.96;
        let top = -Infinity;
        for (const bx of boxes) if (bx.x0 < b && bx.x1 > a && bx.top > top) top = bx.top;
        want = Math.max(want, top - shape.bottom[j]);
      }
      const L = P.landing(s, shape, x);
      if (want === -Infinity) assert.ok(L.void && L.y === null, id + ' void at ' + x);
      else assert.strictEqual(L.y, want, id + ' at ' + x);
    }
  }
  // supports / primary
  const L = P.landing(s, S.T0, 5);
  assert.strictEqual(L.primary, o0);
  assert.deepStrictEqual(L.supports, [o0]);

  // the prediction matches Box2D: drop pieces that rest stably and compare
  for (const [id, x, want] of [['T0', 5, 3], ['J2', 5, 2], ['O0', 7, 1], ['I1', 9, 0], ['S0', 7, 1]]) {
    const ph2 = TT.Physics.create();
    put(ph2, 'I0', 5, 0); put(ph2, 'O0', 5, 1); put(ph2, 'I1', 10, 0);
    const s2 = P.buildSurface(ph2, {});
    assert.strictEqual(P.landing(s2, S[id], x).y, want);
    const b = ph2.createBlock({ typeKey: 'normal', shapeId: id }, x, want + 4);
    settle(ph2, 1.5);
    near(b.body.getPosition().y, want, 0.03, id + ' rests at the predicted height');
    near(b.body.getPosition().x, x, 0.03, id + ' stays at x');
  }
}

// ---- 3. Support ordering: sample count, then higher top, then lower id ------------------
{
  const ph = TT.Physics.create();
  const a = put(ph, 'O0', 5, 0);     // [5,7]
  const b = put(ph, 'O0', 7, 0);     // [7,9]
  const s = P.buildSurface(ph, {});
  let L = P.landing(s, S.I0, 5.5);   // ~45 samples on A, ~60 on B
  assert.strictEqual(L.y, 2);
  assert.deepStrictEqual(L.supports, [b, a]);
  L = P.landing(s, S.I0, 5);         // 60 / 60 -> lower id
  assert.deepStrictEqual(L.supports, [a, b]);

  const ph2 = TT.Physics.create();
  put(ph2, 'P1', 5, 0); const u1 = put(ph2, 'P1', 5, 1);
  const m = put(ph2, 'P1', 6, 0);
  put(ph2, 'P1', 7, 0); const u2 = put(ph2, 'P1', 7, 1);
  const s2 = P.buildSurface(ph2, {});
  L = P.landing(s2, S.T2, 5);        // bottom [1,0,1]: all three columns touch at y = 1
  assert.strictEqual(L.y, 1);
  assert.deepStrictEqual(L.supports, [u1, u2, m], 'equal counts: higher top first, then lower id');
}

// ---- 4. Drifted support: the half grid AND the block's corners -------------------------
{
  const ph = TT.Physics.create();
  const a = put(ph, 'O0', 7.27, 0);       // top corners at x = 7.27, 8.27, 9.27
  const s = P.buildSurface(ph, {});
  const expectO = halfGrid(2).concat([5.27, 6.27, 7.27, 8.27, 9.27], platformAligned(2)).sort((p, q) => p - q);
  nearList(Array.from(P.candidates(s, S.O0, 'assisted')), expectO, 1e-9, 'O0 drifted candidates');
  // a T0 (3 wide): its left edge, both inner boundaries and its right edge on each corner...
  const t = P.candidates(s, S.T0, 'assisted');
  for (const c of [7.27, 8.27, 9.27]) {
    for (let j = 0; j <= 3; j++) assert.ok(has(t, c - j), 'T0 boundary ' + j + ' on the corner at ' + c + ' (x = ' + (c - j).toFixed(2) + ')');
  }
  // ...and the half-block grid over the block as well (no more hidden half steps)
  for (const g of [5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9]) assert.ok(has(t, g), 'T0 half grid over the block: ' + g);
  assert.strictEqual(P.landing(s, S.T0, 7.5).primary, a, 'a half-grid spot that lands on the drifted block');
  assert.strictEqual(P.landing(s, S.T0, 6.27).primary, a, 'an inner-boundary spot that lands on it');
  for (const id of ALL_SHAPES) {
    const shape = S[id];
    const cand = P.candidates(s, shape, 'assisted');
    checkAssisted(ph, s, shape, cand, id + ' drift');
    assert.ok(cand.filter((x) => P.landing(s, shape, x).primary === a && Math.abs(frac(x) - 0.27) < 1e-6).length >= 1, id + ' has corner spots on the block');
    assert.ok(cand.filter((x) => P.landing(s, shape, x).primary === a && onHalf(x)).length >= 1, id + ' has half-grid spots on the block');
    assert.deepStrictEqual(Array.from(P.candidates(s, shape, 'fixed')), halfGrid(shape.w), id + ' fixed ignores drift');
  }
  assert.strictEqual(P.candidates(s, S.O0, 'assisted'), P.candidates(s, S.O0, 'assisted'), 'cached per surface');
  assert.ok(Object.isFrozen(P.candidates(s, S.O0, 'assisted')) && Object.isFrozen(P.candidates(s, S.O0, 'fixed')), 'frozen');

  // a block that really drifted under physics (dynamic, at rest, touched): its corners follow the body
  const ph2 = TT.Physics.create();
  const d = ph2.createBlock({ typeKey: 'normal', shapeId: 'I0' }, 6.13, 0.2);
  settle(ph2, 1);
  d.touched = true;
  const s2 = P.buildSurface(ph2, {});
  near(frac(d.body.getPosition().x), 0.13, 0.01, 'the body drifted');
  const cand2 = P.candidates(s2, S.T0, 'assisted');
  checkAssisted(ph2, s2, S.T0, cand2, 'physics drift');
  const want2 = alignedTo(refCorners(ph2, s2).slice(2), 3);
  const onD = cand2.filter((x) => P.landing(s2, S.T0, x).primary === d && !onHalf(x) && want2.some((v) => Math.abs(v - x) < 1e-6));
  assert.ok(onD.length >= 4 && onD.every((x) => Math.abs(frac(x) - 0.13) < 0.01), 'T0 corner spots on the drifted I0: ' + onD);
}

// ---- 4b. Merging: closer than CANDIDATE_MERGE is one spot ---------------------------------
{
  // a corner-aligned position replaces a half-grid one that close
  const ph = TT.Physics.create();
  put(ph, 'O0', 7.012, 0);
  const c = P.candidates(P.buildSurface(ph, {}), S.O0, 'assisted');
  for (const x of [5.012, 6.012, 7.012, 8.012, 9.012]) assert.ok(has(c, x), 'corner-aligned ' + x + ' kept: ' + c);
  for (const x of [5, 6, 7, 8, 9]) assert.ok(!has(c, x), 'half grid ' + x + ' merged into ' + (x + 0.012));
  assert.ok(has(c, 6.5) && has(c, 7.5) && has(c, 9.1), 'farther ones stay (9.1 is 0.088 from 9.012)');
  for (let i = 1; i < c.length; i++) assert.ok(c[i] - c[i - 1] >= MERGE - 1e-9, 'merged spacing');
  // the threshold: 0.07 merges, 0.1 does not
  const ph2 = TT.Physics.create();
  put(ph2, 'O0', 7.07, 0);
  const c2 = P.candidates(P.buildSurface(ph2, {}), S.O0, 'assisted');
  assert.ok(has(c2, 7.07) && !has(c2, 7) && has(c2, 7.5), '0.07 apart: one spot');
  const ph3 = TT.Physics.create();
  put(ph3, 'O0', 7.1, 0);
  const c3 = P.candidates(P.buildSurface(ph3, {}), S.O0, 'assisted');
  assert.ok(has(c3, 7.1) && has(c3, 7), '0.1 apart: two spots');

  // near-duplicate corners of two blocks: the block the piece would land on wins
  const ph4 = TT.Physics.create();
  const A = put(ph4, 'O0', 5.5, 0), B = put(ph4, 'O0', 7.54, 0);   // A's right side and B's left side 0.04 apart
  const s4 = P.buildSurface(ph4, {});
  const c4 = P.candidates(s4, S.O0, 'assisted');
  checkAssisted(ph4, s4, S.O0, c4, 'two blocks');
  assert.ok(has(c4, 7.54) && !has(c4, 7.5), 'on B: flush with B (7.54), not with A\'s side (7.5)');
  assert.strictEqual(P.landing(s4, S.O0, 7.54).primary, B);
  assert.ok(has(c4, 5.5) && !has(c4, 5.54), 'on A: flush with A (5.5), not with B\'s side (5.54)');
  assert.strictEqual(P.landing(s4, S.O0, 5.5).primary, A);
  for (const x of [8.54, 9.54]) assert.ok(has(c4, x) && !has(c4, x - 0.04), 'B\'s corner ' + x + ' beats the half grid');

  // a plank drifted 0.05 on a block: the plank's corners win, the covered ones below are merged
  const ph5 = TT.Physics.create();
  put(ph5, 'I0', 5, 0);
  const plank = put(ph5, 'I0', 5.05, 1);
  const s5 = P.buildSurface(ph5, {});
  const c5 = P.candidates(s5, S.O0, 'assisted');
  checkAssisted(ph5, s5, S.O0, c5, 'drifted plank');
  for (const x of [4.05, 5.05, 6.05, 7.05]) {
    assert.ok(has(c5, x) && !has(c5, x - 0.05), 'plank-aligned ' + x + ', not ' + (x - 0.05));
    assert.strictEqual(P.landing(s5, S.O0, x).primary, plank);
  }
  assert.ok(has(c5, 3.05) && !has(c5, 3), 'beside the tower: the higher (visible) corner beats the covered one');
  // a block buried under another one adds no corners
  const ph6 = TT.Physics.create();
  put(ph6, 'O0', 6.3, 0);
  put(ph6, 'I0', 5.6, 2);                  // covers the O from 6.3 to 8.3 completely
  const s6 = P.buildSurface(ph6, {});
  const c6 = P.candidates(s6, S.O0, 'assisted');
  checkAssisted(ph6, s6, S.O0, c6, 'buried block');
  assert.ok(!c6.some((x) => Math.abs(frac(x) - 0.3) < 1e-6), 'no corners of the buried O: ' + c6);
  for (const x of [3.6, 4.6, 5.6, 6.6, 7.6, 8.6, 9.6]) assert.ok(has(c6, x), 'plank corner spot ' + x);
}

// ---- 5. Tilted supports -------------------------------------------------------------------
{
  // a clearly tilted block: the world x of its top corners, and the half grid on top of it too
  const ph = TT.Physics.create();
  const t = put(ph, 'I0', 6.13, 0.5, { angle: 0.3 });
  const s = P.buildSurface(ph, {});
  // TL and TR of every (top-exposed) cell: [x, y]
  const tops = ph.cellQuads(t).flatMap((q) => [[q.pts[6], q.pts[7]], [q.pts[4], q.pts[5]]]);
  for (const id of ['O0', 'T0', 'I0', 'P1']) {
    const cand = P.candidates(s, S[id], 'assisted');
    checkAssisted(ph, s, S[id], cand, id + ' tilted support');
    assert.ok(cand.some((x) => onHalf(x) && P.landing(s, S[id], x).primary === t), id + ' half-grid spot on the tilted block');
    const spots = cand.filter((x) => !onHalf(x) && P.landing(s, S[id], x).primary === t);
    assert.ok(spots.length >= 2, id + ' corner spots on the tilted block: ' + spots);
  }
  // its corners are cos(0.3) apart, so spots on neighbouring corners merge: the higher corner wins
  const o = P.candidates(s, S.O0, 'assisted');
  const hi = tops.reduce((a, b) => (b[1] > a[1] ? b : a));
  for (let j = 0; j <= 2; j++) assert.ok(has(o, hi[0] - j), 'O0 boundary ' + j + ' exactly on the highest corner ' + hi[0].toFixed(4));
  for (const [cx] of tops) {
    for (let j = 0; j <= 2; j++) assert.ok(o.some((x) => Math.abs(x + j - cx) < MERGE), 'O0 boundary ' + j + ' on (or merged near) the corner at ' + cx.toFixed(4));
  }  // the skyline follows the exact rotated top edge
  const q = ph.cellQuads(t)[3];             // rightmost cell: its TR corner is the peak
  const peak = q.pts[5];
  let maxSky = -Infinity;
  for (let k = 0; k < s.n; k++) maxSky = Math.max(maxSky, s.skyline[k]);
  near(maxSky, peak, 0.35 / 32 + 1e-4, 'skyline peak');
  near(s.top, maxSky, 0, 'surface.top');

  // a slight tilt: its corners are slightly less than a cell apart, near-duplicates merge
  const ph2 = TT.Physics.create();
  const t2 = put(ph2, 'I0', 6.2, 0, { angle: 0.1 });
  const s2 = P.buildSurface(ph2, {});
  const cand = P.candidates(s2, S.O0, 'assisted');
  checkAssisted(ph2, s2, S.O0, cand, 'slight tilt');
  const tl = ph2.cellQuads(t2)[0].pts[6];                          // top-left corner of the left cell
  const atTl = cand.filter((x) => Math.abs(x - tl) < MERGE && !onHalf(x));
  assert.ok(atTl.length === 1 && P.landing(s2, S.O0, atTl[0]).primary === t2, 'one spot flush with its top-left corner area: ' + atTl);
  assert.ok(Math.abs(atTl[0] - tl) < 0.02 && has(cand, 6), '...within 0.02 of it, and the grid spot 0.1 to the left stays');
  const onT = cand.filter((x) => !onHalf(x) && P.landing(s2, S.O0, x).primary === t2);
  assert.ok(onT.length >= 3, 'corner spots on the slightly tilted block: ' + onT);

  // a block lying on its side (quarter turn): its world-top faces give the corners
  const ph3 = TT.Physics.create();
  const side = put(ph3, 'I1', 10.3, 0, { angle: Math.PI / 2 });   // covers [6.3, 10.3] x [0, 1]
  const s3 = P.buildSurface(ph3, {});
  const c3 = P.candidates(s3, S.O0, 'assisted');
  checkAssisted(ph3, s3, S.O0, c3, 'quarter turn');
  nearList(c3.filter((x) => Math.abs(frac(x) - 0.3) < 1e-6), [4.3, 5.3, 6.3, 7.3, 8.3, 9.3, 10.3], 1e-9, 'quarter-turned block');
  assert.strictEqual(P.landing(s3, S.O0, 7.3).primary, side);
  near(P.landing(s3, S.O0, 7.3).y, 1, 1e-6, 'lands on its side');
  // upside down (half turn) and the other quarter turn: corners on the world-top faces too
  for (const [id, angle, x0, want] of [['T0', Math.PI, 9.4, [6.4, 7.4, 8.4, 9.4]], ['J1', -Math.PI / 2, 6.6, [6.6, 7.6, 8.6, 9.6]]]) {
    const ph4 = TT.Physics.create();
    put(ph4, id, x0, 2, { angle });
    const s4 = P.buildSurface(ph4, {});
    const c4 = P.candidates(s4, S.O0, 'assisted');
    checkAssisted(ph4, s4, S.O0, c4, id + ' turned ' + angle.toFixed(2));
    const xs = refCorners(ph4, s4).slice(2).sort((p, q) => p - q);
    nearList(xs.filter((x, i) => !i || x - xs[i - 1] > 1e-6), want, 1e-9, id + ' turned: reference top corners');
    const f = frac(want[0]);
    nearList(c4.filter((x) => Math.abs(frac(x) - f) < 1e-6), [want[0] - 2, want[0] - 1].concat(want), 1e-9, id + ' turned: corner spots');
  }
}

// ---- 6. Exact upper envelope of a rotated block ----------------------------------------------
{
  const ph = TT.Physics.create();
  const px = 8, py = 0.5;
  const d = put(ph, 'O0', px, py, { angle: Math.PI / 4 });  // a 2x2 diamond, top corner at (px, py + 2*sqrt2)
  const s = P.buildSurface(ph, {});
  const r2 = Math.SQRT2;
  let checked = 0;
  for (let k = 0; k < s.n; k++) {
    const x = P.sampleX(k);
    if (x <= px - r2 || x >= px + r2) continue;
    near(s.skyline[k], py + 2 * r2 - Math.abs(x - px), 1e-5, 'diamond envelope at ' + x);
    assert.strictEqual(s.owner[k], d);
    checked++;
  }
  assert.ok(checked > 80);
}

// ---- 6b. Rasteriser vs brute force: any shape at any angle ------------------------------------
{
  const rand = TT.RNG.mulberry32(99);
  // exact top of a convex quad on the vertical line at x (max over the edges spanning x)
  const quadTop = (pts, x) => {
    let top = -Infinity;
    for (let i = 0; i < 8; i += 2) {
      const ax = pts[i], ay = pts[i + 1], bx = pts[(i + 2) & 7], by = pts[((i + 2) & 7) + 1];
      if (Math.abs(bx - ax) < 1e-12 || x < Math.min(ax, bx) || x > Math.max(ax, bx)) continue;
      top = Math.max(top, ay + (x - ax) * (by - ay) / (bx - ax));
    }
    return top;
  };
  for (let n = 0; n < 60; n++) {
    const ph = TT.Physics.create();
    const id = ALL_SHAPES[n % ALL_SHAPES.length];
    const angle = n < 4 ? [0, Math.PI / 2, -Math.PI, 2 * Math.PI + 0.2][n] : (rand() * 2 - 1) * Math.PI * 1.5;
    const b = put(ph, id, 3 + rand() * 8, 2 + rand() * 3, { angle });
    const s = P.buildSurface(ph, {});
    const quads = ph.cellQuads(b);
    const flat = Math.abs(P.tiltOf(angle)) < 1e-3;
    for (let k = 0; k < s.n; k++) {
      const x = P.sampleX(k);
      let want = (x > PX0 && x < PX1) ? 0 : -Infinity;
      for (const q of quads) want = Math.max(want, quadTop(q.pts, x));
      if (want === -Infinity) { assert.strictEqual(s.skyline[k], -Infinity, id + ' empty at ' + x); continue; }
      near(s.skyline[k], want, flat ? 2e-3 : 1e-4, id + ' angle ' + angle.toFixed(3) + ' at x ' + x.toFixed(4));
      if (want > 1e-3) assert.strictEqual(s.owner[k], b);
    }
  }
}

// ---- 7. Fixed mode, stepping, snapping, manual, clamp -----------------------------------------
{
  const ph = TT.Physics.create();
  put(ph, 'O0', 7.27, 0);
  const s = P.buildSurface(ph, {});
  const cand = P.candidates(s, S.O0, 'assisted');
  // walk right through every candidate, then back, stopping at the ends
  let x = cand[0];
  const right = [x];
  for (;;) { const nx = P.stepX(s, S.O0, 'assisted', x, +1, 0.05); if (nx === x) break; right.push(nx); x = nx; }
  assert.deepStrictEqual(right, Array.from(cand));
  const left = [x];
  for (;;) { const nx = P.stepX(s, S.O0, 'assisted', x, -1, 0.05); if (nx === x) break; left.push(nx); x = nx; }
  assert.deepStrictEqual(left, Array.from(cand).reverse());
  assert.strictEqual(P.stepX(s, S.O0, 'assisted', cand[cand.length - 1], +1, 0.05), cand[cand.length - 1]);
  assert.strictEqual(P.stepX(s, S.O0, 'assisted', cand[0], -1, 0.05), cand[0]);
  assert.ok(cand[0] === 0 && cand[cand.length - 1] === 14, 'the walk spans the field');
  // the union in order: grid, platform edge, grid, block corners, grid...
  let at = 4.5;
  const seq = [];
  for (let i = 0; i < 16; i++) seq.push(+(at = P.stepX(s, S.O0, 'assisted', at, +1)).toFixed(4));
  assert.deepStrictEqual(seq, [4.9, 5, 5.27, 5.5, 6, 6.27, 6.5, 7, 7.27, 7.5, 8, 8.27, 8.5, 9, 9.1, 9.27], 'stepping right');
  at = 9.5;
  seq.length = 0;
  for (let i = 0; i < 6; i++) seq.push(+(at = P.stepX(s, S.O0, 'assisted', at, -1)).toFixed(4));
  assert.deepStrictEqual(seq, [9.27, 9.1, 9, 8.5, 8.27, 8], 'stepping left');
  near(P.stepX(s, S.O0, 'assisted', 5, +1), 5.27, 1e-9, 'assisted step onto the drifted block\'s corner');
  near(P.stepX(s, S.O0, 'assisted', 5.27, +1), 5.5, 1e-9, '...then the half grid');
  near(P.stepX(s, S.O0, 'assisted', 5.29, -1), 5.27, 1e-9, 'a spot 0.02 away is the next step');
  near(P.stepX(s, S.O0, 'assisted', 5.275, -1), 5, 1e-9, 'one within 0.01 is skipped');
  // fixed: half-block steps; "beyond" means by more than 0.01
  assert.strictEqual(P.stepX(s, S.O0, 'fixed', 7, +1), 7.5);
  assert.strictEqual(P.stepX(s, S.O0, 'fixed', 7.005, +1), 7.5);
  assert.strictEqual(P.stepX(s, S.O0, 'fixed', 7.2, -1), 7);
  assert.strictEqual(P.stepX(s, S.O0, 'fixed', 7.009, -1), 6.5);
  assert.strictEqual(P.stepX(s, S.O0, 'fixed', 14, +1), 14);
  assert.strictEqual(P.stepX(s, S.O0, 'fixed', 0, -1), 0);
  // snap: nearest, tie -> lower x
  assert.strictEqual(P.snapX(s, S.O0, 'fixed', 7.25), 7);
  assert.strictEqual(P.snapX(s, S.O0, 'fixed', 7.26), 7.5);
  assert.strictEqual(P.snapX(s, S.O0, 'fixed', -5), 0);
  assert.strictEqual(P.snapX(s, S.O0, 'fixed', 99), 14);
  near(P.snapX(s, S.O0, 'assisted', 7.1), 7, 1e-9, 'assisted snap to the half grid');
  near(P.snapX(s, S.O0, 'assisted', 7.2), 7.27, 1e-9, 'assisted snap to a corner');
  near(P.snapX(s, S.O0, 'assisted', 5.6), 5.5, 1e-9, 'assisted snap over the block');
  near(P.snapX(s, S.O0, 'assisted', 4.93), 4.9, 1e-9, 'assisted snap to the platform edge');
  near(P.snapX(s, S.O0, 'assisted', 4.97), 5, 1e-9, '...or the grid next to it');
  near(P.snapX(s, S.O0, 'assisted', -3), 0, 1e-12, 'assisted snap clamps');
  near(P.snapX(s, S.O0, 'assisted', 30), 14, 1e-12);
  // always the nearest candidate, the lower one on a tie
  const rnd = TT.RNG.mulberry32(5);
  for (let i = 0; i < 400; i++) {
    const x = -1 + rnd() * 18;
    let best = cand[0];
    for (const c of cand) if (Math.abs(c - x) < Math.abs(best - x) - 1e-9) best = c;
    assert.strictEqual(P.snapX(s, S.O0, 'assisted', x), best, 'nearest to ' + x);
  }
  // manual: one pixel per step, clamped; snap = clamp
  near(P.stepX(s, S.O0, 'manual', 7, +1, 0.05), 7.05, 1e-12, 'manual right');
  near(P.stepX(s, S.O0, 'manual', 7, -1, 0.05), 6.95, 1e-12, 'manual left');
  assert.strictEqual(P.stepX(s, S.O0, 'manual', 13.99, +1, 0.05), 14);
  assert.strictEqual(P.stepX(s, S.O0, 'manual', 0.01, -1, 0.05), 0);
  assert.strictEqual(P.snapX(s, S.O0, 'manual', 7.123), 7.123);
  assert.strictEqual(P.snapX(s, S.O0, 'manual', 20), 14);
  // clamp: [0, FIELD_WIDTH - w]
  assert.strictEqual(P.clampX(S.I0, 13), 12);
  assert.strictEqual(P.clampX(S.P1, 15.5), 15);
  assert.strictEqual(P.clampX(S.I1, -0.3), 0);
  assert.strictEqual(P.clampX(S.T0, 6.4), 6.4);
}

// ---- 8. Warnings: void, mine, horizon (final position and swept) --------------------------
{
  const ph = TT.Physics.create();
  const mine = put(ph, 'O0', 5, 0, { typeKey: 'mine' });   // [5,7] x [0,2]
  put(ph, 'O0', 9, 0);                                      // [9,11] x [0,2]
  const hazards = {
    mines: new Set([mine.id]),
    horizons: [
      { minX: 8.05, maxX: 8.95, minY: 0.05, maxY: 0.95, hole: null },   // beside [9,11], left
      { minX: 8.05, maxX: 8.95, minY: 1.05, maxY: 1.95, hole: null },
      { minX: 9.05, maxX: 9.95, minY: 5.05, maxY: 5.95, hole: null }    // high up, only hit by a sweep
    ]
  };
  const s = P.buildSurface(ph, { hazards });
  assert.strictEqual(s.hazards, hazards);
  const w = (x, fromY) => P.landing(s, S.O0, x, fromY).warnings;
  assert.deepStrictEqual(w(5), ['mine']);
  assert.deepStrictEqual(w(6), ['mine'], 'any support that is a mine');
  assert.deepStrictEqual(w(5, 12), ['mine'], 'sweep clear of every horizon');
  assert.deepStrictEqual(w(7), ['horizon'], 'final cells beside the hole');
  assert.deepStrictEqual(w(9), []);
  assert.deepStrictEqual(w(9, 12), ['horizon'], 'swept through a horizon');
  assert.deepStrictEqual(w(9, 2), [], 'no sweep when starting at the landing height');
  assert.deepStrictEqual(w(0), ['void']);
  assert.deepStrictEqual(w(0, 12), ['void']);
  // without hazards nothing is flagged
  assert.deepStrictEqual(P.landing(P.buildSurface(ph, {}), S.O0, 5).warnings, []);
}

// ---- 8b. Warnings: spikes and glass (any support), every accepted container ---------------
{
  const ph = TT.Physics.create();
  const sp = put(ph, 'O0', 5, 0, { typeKey: 'spikes' });   // [5,7] x [0,2]
  const mine = put(ph, 'P1', 7, 0, { typeKey: 'mine' });   // [7,8] x [0,1]
  const gl = put(ph, 'O0', 9, 0, { typeKey: 'glass' });    // [9,11] x [0,2]; [8,9] is bare platform
  const w = (hazards, id, x) => P.landing(P.buildSurface(ph, { hazards }), S[id], x).warnings;
  const containers = [
    { spikes: new Set([sp.id]), glass: new Set([gl.id]), mines: new Set([mine.id]), horizons: [] },   // what effects hands over
    { spikes: new Set([sp]), glass: new Set([gl]), mines: new Set([mine]) },                         // Sets of blocks
    { spikes: [sp.id], glass: [gl.id], mines: [mine.id] },                                           // id arrays
    { spikes: [sp], glass: [gl], mines: [mine] }                                                     // block arrays
  ];
  for (let i = 0; i < containers.length; i++) {
    const hz = containers[i], at = ' (container ' + i + ')';
    assert.deepStrictEqual(w(hz, 'O0', 5), ['spikes'], 'on the spikes' + at);
    assert.deepStrictEqual(w(hz, 'O0', 6), ['spikes'], 'half on the spikes, the mine column is lower' + at);
    assert.deepStrictEqual(w(hz, 'O0', 9), ['glass'], 'on the glass' + at);
    assert.deepStrictEqual(w(hz, 'O0', 8.5), ['glass'], 'partly on the glass' + at);
    assert.deepStrictEqual(w(hz, 'I0', 5.5), ['spikes', 'glass'], 'bridging both' + at);
    assert.deepStrictEqual(w(hz, 'J2', 5), ['mine', 'spikes'], 'resting on the spikes and the mine' + at);
    assert.deepStrictEqual(w(hz, 'O0', 7), ['mine'], 'flush beside the spikes is safe' + at);
    assert.deepStrictEqual(w(hz, 'P1', 8), [], 'bare platform between them' + at);
    assert.deepStrictEqual(w(hz, 'O0', 0), ['void'], 'void' + at);
  }
  // the platform pseudo-block (id 0) is never a hazard; empty containers flag nothing
  assert.deepStrictEqual(w({ spikes: new Set([0]), glass: [0] }, 'P1', 8), []);
  assert.deepStrictEqual(w({ spikes: new Set(), glass: [] }, 'O0', 5), []);
  assert.deepStrictEqual(w({ mines: new Set(), horizons: [] }, 'O0', 5), [], 'older hazard objects without spikes/glass');
}

// ---- 9. Guided-fall target -----------------------------------------------------------------
{
  const ph = TT.Physics.create();
  const b = ph.createBlock({ typeKey: 'normal', shapeId: 'I0' }, 6, 0.3);
  settle(ph, 1);
  b.touched = true;
  const s = P.buildSurface(ph, {});
  const L = P.landing(s, S.O0, 7);
  const g = P.guideTarget(s, S.O0, 7);
  assert.ok(g && g.block === b, 'primary block');
  assert.strictEqual(L.primary, b);
  assert.strictEqual(Object.getPrototypeOf(g.local), Object.prototype, 'plain {x, y} copy');
  const wp = b.body.getWorldPoint(g.local);
  near(wp.x, 7, 1e-9, 'local maps back to x');
  near(wp.y, L.y, 1e-9, 'local maps back to y');
  // when the support drifts during the fall, the target follows it
  const p0 = b.body.getPosition().clone(), a0 = b.body.getAngle();
  b.body.setTransform({ x: p0.x + 0.3, y: p0.y }, a0);
  near(b.body.getWorldPoint(g.local).x, 7.3, 1e-9, 'target follows the support');
  // the frame is the snapshot's: drift between the build and the drop is followed as well
  const g2 = P.guideTarget(s, S.O0, 7);
  near(b.body.getWorldPoint(g2.local).x, 7.3, 1e-9, 'snapshot frame');
  b.body.setTransform({ x: p0.x + 0.1, y: p0.y }, a0 + 0.05);   // rotate about the origin too
  const wp2 = b.body.getWorldPoint(g2.local);
  near(wp2.x, 7.1 + (7 - p0.x) * (Math.cos(0.05) - 1) - (L.y - p0.y) * Math.sin(0.05), 1e-9, 'rigid follow (x)');
  assert.strictEqual(P.guideTarget(s, S.O0, 10), null, 'platform only');
  assert.strictEqual(P.guideTarget(s, S.O0, 13), null, 'void');
  // a tilted primary is still a guide target
  const ph2 = TT.Physics.create();
  const t = put(ph2, 'I0', 6, 0.5, { angle: 0.3 });
  const g3 = P.guideTarget(P.buildSurface(ph2, {}), S.O0, 7.5);
  assert.ok(g3 && g3.block === t, 'tilted primary');
}

// ---- 10. buildSurface: what is included, versions, reuse -----------------------------------
{
  const ph = TT.Physics.create();
  const stat = put(ph, 'O0', 5, 0);
  const rest = ph.createBlock({ typeKey: 'normal', shapeId: 'O0' }, 9, 0.2);
  settle(ph, 1);
  const fly = ph.createBlock({ typeKey: 'normal', shapeId: 'O0' }, 7, 6);  // not touched yet
  const owners = (s) => new Set(s.owner.filter(Boolean));
  let s = P.buildSurface(ph, {});
  assert.ok(owners(s).has(stat), 'static blocks are included');
  assert.ok(!owners(s).has(rest), 'untouched movers are not');
  assert.ok(!owners(s).has(fly));
  rest.touched = true;
  fly.touched = true;
  fly.body.setLinearVelocity({ x: 0, y: -3 });
  const v1 = s.version;
  const s2 = P.buildSurface(ph, { reuse: s });
  assert.strictEqual(s2, s, 'reuse returns the same surface');
  assert.ok(s2.version > v1, 'version increases on every build');
  assert.ok(owners(s2).has(rest), 'touched slow movers are included');
  assert.ok(!owners(s2).has(fly), 'fast movers are not');
  fly.body.setLinearVelocity({ x: 1, y: -1.5 });
  s = P.buildSurface(ph, { reuse: s2 });
  assert.ok(owners(s).has(fly), 'slow enough now');
  s = P.buildSurface(ph, { reuse: s, exclude: new Set([fly, stat]) });
  assert.ok(!owners(s).has(fly) && !owners(s).has(stat) && owners(s).has(rest), 'exclude');
  s = P.buildSurface(ph, { reuse: s, exclude: [fly] });
  assert.ok(!owners(s).has(fly) && owners(s).has(stat), 'exclude given as an array');
  ph.removeBlock(rest, 'test');
  const s3 = P.buildSurface(ph, {});
  assert.ok(s3 !== s && s3.version > s.version, 'fresh surface without reuse');
  assert.ok(!owners(s3).has(rest), 'removed blocks are gone');
  // the candidates cache belongs to one build
  const c1 = P.candidates(s3, S.T0, 'assisted');
  P.buildSurface(ph, { reuse: s3 });
  assert.notStrictEqual(P.candidates(s3, S.T0, 'assisted'), c1, 'cache dropped on rebuild');
  // landing() keeps no state between calls
  const a1 = P.landing(s3, S.I0, 4), b1 = P.landing(s3, S.T2, 9), a2 = P.landing(s3, S.I0, 4);
  assert.deepStrictEqual(a1, a2);
  assert.notDeepStrictEqual(a1, b1);
}

// ---- 11. A small real tower: rules hold and predictions match Box2D ------------------------
{
  // x span of the skyline samples the piece would rest on
  const contactSpan = (s, shape, x, y) => {
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < s.n; k++) {
      const sx = P.sampleX(k), j = Math.floor(sx - x);
      if (j < 0 || j >= shape.w || sx < x + j + 0.04 || sx > x + j + 0.96) continue;
      if (s.skyline[k] >= y + shape.bottom[j] - 0.03) { lo = Math.min(lo, sx); hi = Math.max(hi, sx); }
    }
    return [lo, hi];
  };
  const ph = TT.Physics.create();
  const gen = TT.Generator.create('PLACEMENT7', { enabledTypes: [] });
  const rand = TT.RNG.mulberry32(7);
  let s = P.buildSurface(ph, {});
  let drops = 0, checked = 0, err = 0;
  for (let i = 0; i < 24; i++) {
    const spec = gen.next(0);
    const shape = S[spec.shapeId];
    const cand = P.candidates(s, shape, 'assisted');
    checkAssisted(ph, s, shape, cand, 'tower drop ' + i + ' ' + shape.id);
    // only spots where the piece's centre of mass is over what it lands on
    const pool = cand.filter((x) => {
      const L = P.landing(s, shape, x);
      if (L.void) return false;
      const [lo, hi] = contactSpan(s, shape, x, L.y), com = x + shape.com.x;
      return com > lo + 0.2 && com < hi - 0.2;
    });
    if (!pool.length) continue;
    const x = pool[Math.floor(rand() * pool.length)];
    const L = P.landing(s, shape, x);
    const b = ph.createBlock(spec, x, (s.top > 0 ? s.top : 0) + 3);
    settle(ph, 1.5);
    drops++;
    const p = b.body.getPosition();
    if (Math.abs(b.body.getAngle()) < 0.01 && Math.abs(p.x - x) < 0.02) {
      near(p.y, L.y, 0.03, 'drop ' + i + ' ' + shape.id + ' at ' + x + ' rests where predicted');
      assert.ok(ph.touching(b).some((t) => t.other === L.primary), 'drop ' + i + ' rests on the predicted primary');
      err = Math.max(err, Math.abs(p.y - L.y));
      checked++;
    }
    // freeze the tower so later predictions are not disturbed by settling below
    for (const t of ph.movers.slice()) ph.makeStatic(t, 'petrified');
    s = P.buildSurface(ph, { reuse: s });
  }
  assert.ok(drops >= 20 && checked >= drops - 2, 'stable drops: ' + checked + '/' + drops);
  console.log('  landing vs Box2D: ' + checked + '/' + drops + ' drops checked, max |dy| = ' + err.toFixed(4) + ' m, tower ' + s.top.toFixed(1) + ' m');
}

// ---- 12. Performance: 500-block tower -----------------------------------------------------
{
  const ph = TT.Physics.create();
  const ids = TT.TETROMINO_IDS;
  for (let i = 0; i < 500; i++) {
    const shape = S[ids[i % ids.length]];
    const x = 5 + ((i * 7) % (13 - 2 * shape.w)) * 0.5 + (i % 5) * 0.013;
    const angle = i % 3 === 0 ? ((i % 7) - 3) * 0.01 : 0;   // a third slightly tilted (slow path)
    const b = ph.createBlock({ typeKey: 'normal', shapeId: shape.id }, x, i * 0.8, { angle });
    ph.makeStatic(b, 'petrified');
  }
  let s = P.buildSurface(ph, {});
  for (let i = 0; i < 50; i++) s = P.buildSurface(ph, { reuse: s });    // warm-up (JIT)
  const N = 300;
  let t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) s = P.buildSurface(ph, { reuse: s });
  const reuseMs = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) P.buildSurface(ph, {});
  const freshMs = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  // assisted candidates for every shape (the cache is dropped by each build): the first call
  // after a build also collects the surface's corners
  const R = 30;
  const candTimes = () => {
    let first = 0, all = 0;
    for (let r = 0; r < R; r++) {
      s = P.buildSurface(ph, { reuse: s });
      const t1 = process.hrtime.bigint();
      P.candidates(s, S.T0, 'assisted');
      const t2 = process.hrtime.bigint();
      for (const id of ALL_SHAPES) P.candidates(s, S[id], 'assisted');
      first += Number(t2 - t1) / 1e6;
      all += Number(process.hrtime.bigint() - t1) / 1e6;
    }
    return [first / R, all / R / ALL_SHAPES.length];
  };
  candTimes();                                                            // warm-up (JIT)
  const [firstMs, candMs] = candTimes();
  for (const id of ['O0', 'T0', 'I0', 'S1']) checkAssisted(ph, s, S[id], P.candidates(s, S[id], 'assisted'), '500-block tower ' + id);
  t0 = process.hrtime.bigint();
  let sink = 0;
  for (let i = 0; i < 20000; i++) sink += P.landing(s, S.T0, (i % 27) * 0.5).y || 0;
  const landUs = Number(process.hrtime.bigint() - t0) / 1e3 / 20000;
  assert.ok(sink > 0 && s.top > 300);
  // worst case: a ragged top layer across the whole field (drifted, some tilted) owning the skyline
  for (let i = 0; i < 12; i++) {
    const b = ph.createBlock({ typeKey: 'normal', shapeId: ids[(i * 5) % ids.length] }, i * 1.31 + 0.037 * (i % 4), 401 + (i % 3) * 0.7,
      { angle: i % 4 === 1 ? 0.08 : i % 4 === 3 ? -0.02 : 0 });
    ph.makeStatic(b, 'petrified');
  }
  candTimes();
  const [firstWide, candWide] = candTimes();
  const owners = new Set(s.owner.filter((o) => o && !o.isPlatform)).size;
  assert.ok(owners >= 10, 'the top layer owns the skyline (' + owners + ' blocks)');
  for (const id of ['O0', 'T0', 'I0', 'S1']) checkAssisted(ph, s, S[id], P.candidates(s, S[id], 'assisted'), 'ragged top ' + id);
  console.log('  buildSurface, 500 blocks: ' + reuseMs.toFixed(3) + ' ms (reuse), ' + freshMs.toFixed(3) + ' ms (fresh); ' +
    'assisted candidates ' + candMs.toFixed(3) + ' ms/shape (first after a build ' + firstMs.toFixed(3) + ' ms), ragged top of ' + owners +
    ' blocks ' + candWide.toFixed(3) + ' ms/shape (first ' + firstWide.toFixed(3) + ' ms); landing ' + landUs.toFixed(2) + ' us');
  assert.ok(reuseMs < 2, 'buildSurface must stay well under 2 ms (got ' + reuseMs.toFixed(3) + ')');
  assert.ok(freshMs < 2, 'fresh buildSurface under 2 ms (got ' + freshMs.toFixed(3) + ')');
  for (const [v, what] of [[candMs, 'per shape'], [firstMs, 'first after a build'], [candWide, 'ragged top, per shape'], [firstWide, 'ragged top, first']]) {
    assert.ok(v < 0.5, 'assisted candidates well under 1 ms (' + what + ': ' + v.toFixed(3) + ' ms)');
  }
}

console.log('placement ok');
