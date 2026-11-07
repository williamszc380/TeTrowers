/* Foundation modules: shapes, generator determinism/odds, physics primitives, release version. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const TT = require('./load-core')({ only: ['js/config.js', 'js/util.js', 'js/rng.js', 'js/shapes.js', 'js/blocktypes.js', 'js/generator.js', 'js/physics.js'] });

// The service worker names its cache after its own VERSION; only a changed sw.js makes
// installed copies fetch a release, so it must be bumped together with CONFIG.VERSION
const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
const swVersion = /\bconst\s+VERSION\s*=\s*(['"])([^'"]+)\1/.exec(sw);
assert.ok(swVersion, 'sw.js declares const VERSION');
assert.strictEqual(swVersion[2], TT.CONFIG.VERSION, 'sw.js VERSION must equal CONFIG.VERSION (js/config.js)');

// Shapes: 19 tetromino orientations, each decomposed into <= 2 rectangles covering exactly its cells
assert.strictEqual(TT.TETROMINO_IDS.length, 19);
for (const id of Object.keys(TT.SHAPES)) {
  const s = TT.SHAPES[id];
  const area = s.rects.reduce((a, r) => a + (r.x1 - r.x0) * (r.y1 - r.y0), 0);
  assert.strictEqual(area, s.cells.length, id + ' rect area');
  assert.ok(s.rects.length <= 2, id + ' rect count');
  for (const [x, y] of s.cells) assert.ok(x >= 0 && y >= 0 && x < s.w && y < s.h, id + ' normalised');
}

// Generator: deterministic, case-insensitive, odds monotonic, disabled types honoured
const a = TT.Generator.create('Seed 1'), b = TT.Generator.create('  seed   1 ');
for (let i = 0; i < 200; i++) assert.deepStrictEqual(a.next(i / 4), b.next(i / 4));
let prev = TT.Generator.odds(0);
for (let h = 1; h <= 120; h++) {
  const o = TT.Generator.odds(h);
  assert.ok(o.neg >= prev.neg && o.pos <= prev.pos, 'odds monotonic at ' + h);
  assert.ok(Math.abs(o.neg + o.pos + o.normal - 1) < 1e-9);
  prev = o;
}
const only = TT.Generator.create('x', { enabledTypes: ['steel'] });
for (let i = 0; i < 2000; i++) {
  const s = only.next(40);
  assert.ok(s.typeKey === 'normal' || s.typeKey === 'steel', 'only steel/normal, got ' + s.typeKey);
}
assert.strictEqual(TT.Generator.create('x').rules, '');
assert.ok(only.rules.startsWith('no:'));
// pebble always gets the 1x1 shape
const g = TT.Generator.create('pebbles');
for (let i = 0; i < 3000; i++) { const s = g.next(50); if (s.typeKey === 'pebble') assert.strictEqual(s.shapeId, 'P1'); }

// Physics: O piece lands flat on the platform; shatter keeps pose; static conversion
const P = TT.Physics.create();
const o = P.createBlock({ typeKey: 'normal', shapeId: 'O0' }, 7, 3);
for (let i = 0; i < 240; i++) P.step(1 / 120);
const bo = P.bounds(o);
assert.ok(Math.abs(bo.minY - 0) < 0.03, 'O rests on platform, minY=' + bo.minY);
assert.ok(Math.abs(bo.minX - 7) < 0.01, 'O did not drift');
const parts = P.shatter(o);
assert.strictEqual(parts.length, 4);
assert.ok(o.dead && o.deathReason === 'shattered');
for (const p of parts) assert.strictEqual(p.typeKey, 'rubble');
for (let i = 0; i < 240; i++) P.step(1 / 120);
assert.ok(parts.every((p) => P.bounds(p).minY > -0.05), 'rubble stays on platform');
assert.ok(P.makeStatic(parts[0], 'steel') && parts[0].body.isStatic() && parts[0].frozen === 'steel');
assert.ok(!P.movers.includes(parts[0]));
console.log('foundation ok');
