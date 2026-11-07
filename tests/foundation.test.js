/* Foundation modules: shapes, block types, generator determinism/odds, physics primitives,
 * release version. */
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

// No 1x1 blocks in play: every type is dealt as a tetromino; 'P1' is only a test probe
const REMOVED = ['pebble', 'crumble', 'rubble'];
for (const k of REMOVED) assert.ok(!(k in TT.BLOCK_TYPES), k + ' is gone');
assert.ok(!TT.TETROMINO_IDS.includes('P1'), 'P1 is never dealt');
assert.strictEqual(TT.SHAPES.P1.cells.length, 1, 'P1 stays as a test probe');
for (const k of Object.keys(TT.BLOCK_TYPES)) {
  const t = TT.BLOCK_TYPES[k];
  assert.ok(t.shape == null, k + ' forces no shape');
  assert.ok(['normal', 'positive', 'negative'].includes(t.category), k + ' category ' + t.category);
}
assert.deepStrictEqual(TT.SPECIAL_KEYS, ['steel', 'vine', 'crystal', 'frost', 'magnet',
  'rubber', 'oil', 'glass', 'mine', 'magma', 'spikes', 'anvil', 'blackhole']);
const dealt = new Set();
for (const [seed, enabledTypes] of [['TETRA', undefined], ['tetra 2', undefined], ['TETRA3', ['rubber', 'anvil', 'glass']]]) {
  const gen = TT.Generator.create(seed, { enabledTypes });
  for (const h of [0, 2, 3, 8, 15, 25, 40, 60, 80]) {
    for (let i = 0; i < 1000; i++) {
      const s = gen.next(h);
      assert.ok(TT.TETROMINO_IDS.includes(s.shapeId), 'tetromino at ' + h + ' m, got ' + s.shapeId);
      assert.ok(TT.BLOCK_TYPES[s.typeKey] && !REMOVED.includes(s.typeKey), 'type at ' + h + ' m: ' + s.typeKey);
      dealt.add(s.typeKey);
    }
  }
}
assert.deepStrictEqual(Array.from(dealt).sort(), ['normal'].concat(TT.SPECIAL_KEYS).sort(), 'every type was dealt');

// Physics: O piece lands flat on the platform; static conversion; nothing breaks blocks into cells
const P = TT.Physics.create();
assert.strictEqual(P.shatter, undefined, 'physics has no shatter');
// The platform spans the configured bounds (a little over 6 wide, edges off the integer grid)
const PC = TT.CONFIG;
assert.ok(P.platform.x0 === PC.PLATFORM_X0 && P.platform.x1 === PC.PLATFORM_X1 && PC.PLATFORM_X1 - PC.PLATFORM_X0 > 6);
const o = P.createBlock({ typeKey: 'normal', shapeId: 'O0' }, 7, 3);
const rim = P.createBlock({ typeKey: 'normal', shapeId: 'O0' }, PC.PLATFORM_X1 - 2, 3); // flush with the right edge
for (let i = 0; i < 240; i++) P.step(1 / 120);
const bo = P.bounds(o);
assert.ok(Math.abs(bo.minY - 0) < 0.03, 'O rests on platform, minY=' + bo.minY);
assert.ok(Math.abs(bo.minX - 7) < 0.01, 'O did not drift');
const br = P.bounds(rim);
assert.ok(Math.abs(br.minY) < 0.03 && Math.abs(br.maxX - PC.PLATFORM_X1) < 0.01, 'an O flush with the edge rests on it');
P.removeBlock(rim, 'lost');
assert.strictEqual(o.tint, TT.NORMAL_TINTS.O);
assert.ok(P.makeStatic(o, 'steel') && o.body.isStatic() && o.frozen === 'steel');
assert.ok(!P.movers.includes(o));
P.removeBlock(o, 'smashed');
assert.ok(o.dead && o.deathReason === 'smashed' && !P.blocks.includes(o));
console.log('foundation ok');
