/* TeTrowers — seeded block generator.
 * Block n of a run is decided by three independent counter-based rolls
 * (shape, category, type) plus the run's best height when its batch is dealt.
 * Same seed + same enabled-type set + same heights => same blocks, so seeds are fair to
 * compare. Heights are floored to whole metres so float noise can't flip a roll.
 */
(function (TT) {
  'use strict';
  const C = TT.CONFIG;
  const { clamp } = TT.Util;

  const CH_SHAPE = 1, CH_CATEGORY = 2, CH_TYPE = 3;

  function odds(bestHeight) {
    const h = Math.max(0, Math.floor(bestHeight || 0));
    const neg = clamp(C.NEG_BASE + C.NEG_PER_M * h, 0, C.NEG_MAX);
    const pos = clamp(C.POS_BASE - C.POS_PER_M * h, C.POS_MIN, 1 - neg);
    return { neg, pos, normal: Math.max(0, 1 - neg - pos) };
  }

  // What the next deal will actually use at this height with this enabled set: category odds
  // (a category with no enabled+unlocked type folds into normal), per-type odds, and the
  // next type still to unlock. { neg, pos, normal, types: {key: p}, next: {key, unlock} | null }
  function typeOdds(bestHeight, enabled) {
    const h = Math.max(0, Math.floor(bestHeight || 0));
    const o = odds(h);
    const en = enabled ? (enabled instanceof Set ? enabled : new Set(enabled)) : new Set(TT.SPECIAL_KEYS);
    const types = {};
    let neg = 0, pos = 0;
    for (const [keys, p, isNeg] of [[TT.NEGATIVE_KEYS, o.neg, true], [TT.POSITIVE_KEYS, o.pos, false]]) {
      const pool = keys.filter((k) => en.has(k) && TT.BLOCK_TYPES[k].unlock <= h);
      let total = 0;
      for (const k of pool) total += TT.BLOCK_TYPES[k].weight;
      for (const k of pool) types[k] = p * TT.BLOCK_TYPES[k].weight / total;
      if (pool.length) { if (isNeg) neg = p; else pos = p; }
    }
    let next = null;
    for (const k of TT.SPECIAL_KEYS) {
      const u = TT.BLOCK_TYPES[k].unlock;
      if (en.has(k) && u > h && (!next || u < next.unlock)) next = { key: k, unlock: u };
    }
    return { neg, pos, normal: Math.max(0, 1 - neg - pos), types, next };
  }

  // '' when every special type is enabled, otherwise e.g. 'no:anvil,mine'
  function rulesKey(enabled) {
    const off = TT.SPECIAL_KEYS.filter((k) => !enabled.has(k)).sort();
    return off.length ? 'no:' + off.join(',') : '';
  }

  function pickWeighted(keys, roll) {
    let total = 0;
    for (const k of keys) total += TT.BLOCK_TYPES[k].weight;
    let acc = 0;
    const target = roll * total;
    for (const k of keys) {
      acc += TT.BLOCK_TYPES[k].weight;
      if (target < acc) return k;
    }
    return keys[keys.length - 1];
  }

  class Generator {
    // options.enabledTypes: iterable of special type keys that may appear (default: all)
    constructor(seed, options) {
      const opts = options || {};
      this.seed = TT.RNG.normalizeSeed(seed);
      this.seedU32 = TT.RNG.hashString(this.seed);
      this.enabled = new Set(opts.enabledTypes ? Array.from(opts.enabledTypes) : TT.SPECIAL_KEYS);
      this.rules = rulesKey(this.enabled);
      this.index = 0; // global block counter for this run
    }

    // Decide block n at height bestHeight (pure — does not advance the counter)
    specAt(n, bestHeight) {
      const h = Math.max(0, Math.floor(bestHeight || 0));
      const o = odds(h);
      const rShape = TT.RNG.hash01(this.seedU32, n, CH_SHAPE);
      const rCat = TT.RNG.hash01(this.seedU32, n, CH_CATEGORY);
      const rType = TT.RNG.hash01(this.seedU32, n, CH_TYPE);

      let category = 'normal';
      if (rCat < o.neg) category = 'negative';
      else if (rCat < o.neg + o.pos) category = 'positive';

      let typeKey = 'normal';
      if (category !== 'normal') {
        const pool = (category === 'negative' ? TT.NEGATIVE_KEYS : TT.POSITIVE_KEYS)
          .filter((k) => this.enabled.has(k) && TT.BLOCK_TYPES[k].unlock <= h);
        if (pool.length) typeKey = pickWeighted(pool, rType);
      }

      const type = TT.BLOCK_TYPES[typeKey];
      const shapeId = type.shape || TT.TETROMINO_IDS[Math.min(TT.TETROMINO_IDS.length - 1, Math.floor(rShape * TT.TETROMINO_IDS.length))];
      return { n, typeKey, shapeId };
    }

    next(bestHeight) { return this.specAt(this.index++, bestHeight); }

    nextBatch(bestHeight) {
      const batch = [];
      for (let i = 0; i < C.BATCH_SIZE; i++) batch.push(this.next(bestHeight));
      return batch;
    }
  }

  TT.Generator = { Generator, odds, typeOdds, rulesKey, create: (seed, options) => new Generator(seed, options) };
})(typeof window !== 'undefined' ? (window.TT = window.TT || {}) : (global.TT = global.TT || {}));
