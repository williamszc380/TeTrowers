/* TeTrowers — seeded randomness.
 * Gameplay randomness is counter-based: hash01(seed, n, channel) depends only on its inputs,
 * so two players on the same seed see the same rolls for the n-th block no matter how
 * they play. Cosmetic randomness (particles, shake) may use Math.random freely.
 */
(function (TT) {
  'use strict';

  const SEED_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion

  // murmur3 finaliser — good avalanche for 32-bit ints
  function fmix32(h) {
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
  }

  // FNV-1a over UTF-16 code units, then finalised
  function hashString(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return fmix32(h >>> 0);
  }

  // Uniform [0, 1) from (seed, index, channel)
  function hash01(seed, n, channel) {
    let h = (seed >>> 0) ^ Math.imul(n + 1, 0x9e3779b1) ^ Math.imul(channel + 1, 0x85ebca77);
    h = fmix32(h >>> 0);
    h = fmix32((h ^ Math.imul(n + 0x632be5ab, 0xc2b2ae3d)) >>> 0);
    return h / 4294967296;
  }

  // Small sequential PRNG for anything that wants a stream
  function mulberry32(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Seeds are case-insensitive, trimmed, inner whitespace collapsed
  function normalizeSeed(str) {
    return String(str == null ? '' : str).trim().replace(/\s+/g, ' ').toUpperCase().slice(0, 32);
  }

  function randomSeed() {
    let s = '';
    for (let i = 0; i < 6; i++) s += SEED_ALPHABET[Math.floor(Math.random() * SEED_ALPHABET.length)];
    return s;
  }

  // Same seed for everyone on a given local calendar day
  function dailySeed(date) {
    const d = date || new Date();
    const pad = (v) => String(v).padStart(2, '0');
    return 'D' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
  }

  TT.RNG = { fmix32, hashString, hash01, mulberry32, normalizeSeed, randomSeed, dailySeed, SEED_ALPHABET };
})(typeof window !== 'undefined' ? (window.TT = window.TT || {}) : (global.TT = global.TT || {}));
