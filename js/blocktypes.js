/* TeTrowers — block type catalogue.
 * Colour language: neutral stone = normal, COLD (white/green/blue) = positive,
 * WARM (red/orange/black) = negative. Behaviour lives in effects.js, keyed by `key`.
 *
 * Fields:
 *   key, name, category ('normal' | 'positive' | 'negative')
 *   desc        one-line rule text for the codex / first-seen toast
 *   colors      { base, light, dark, accent } hex strings used by the renderer & UI
 *   icon        renderer glyph id drawn on each cell (null = plain)
 *   density, friction, restitution   physics material
 *   weight      relative pick weight inside its category
 *   unlock      best height (m) from which the generator may produce it
 * Every type is dealt as a uniformly random tetromino orientation: no type forces a shape.
 */
(function (TT) {
  'use strict';

  const T = {};
  function def(o) {
    T[o.key] = Object.freeze(Object.assign({
      icon: null, density: 1, friction: TT.CONFIG.FRICTION, restitution: 0, weight: 1, unlock: 0, heavy: false
    }, o, { colors: Object.freeze(o.colors) }));
  }

  // ---- Normal --------------------------------------------------------------
  def({
    key: 'normal', name: 'Stone', category: 'normal',
    desc: 'A plain block. Stack it well.',
    colors: { base: '#a39f97', light: '#c9c5bc', dark: '#6f6b64', accent: '#8c877f' }
  });

  // ---- Positive (cold) ----------------------------------------------------
  def({
    key: 'steel', name: 'Steel', category: 'positive', icon: 'rivets',
    desc: 'Locks in place once it settles. Nothing can move it.',
    colors: { base: '#dde5ec', light: '#ffffff', dark: '#93a1ad', accent: '#6f7e8c' },
    density: 1.5, friction: 0.6, weight: 3, unlock: 0
  });
  def({
    key: 'vine', name: 'Vine', category: 'positive', icon: 'leaf',
    desc: 'When it settles it grabs every block it touches and holds them together.',
    colors: { base: '#3aa953', light: '#7fdc8e', dark: '#1d6831', accent: '#b4f07a' },
    friction: 0.9, weight: 3, unlock: 0
  });
  def({
    key: 'crystal', name: 'Crystal Heart', category: 'positive', icon: 'heart',
    desc: 'Settle it safely to restore a life. At full lives it gives a shield instead.',
    colors: { base: '#3b78f5', light: '#93b6ff', dark: '#1c3c93', accent: '#eaf2ff' },
    weight: 1.2, unlock: 4
  });
  def({
    key: 'frost', name: 'Frost', category: 'positive', icon: 'snow',
    desc: 'When it settles it freezes itself and every block it touches solid.',
    colors: { base: '#9fe2f5', light: '#e8fbff', dark: '#4ea7c7', accent: '#ffffff' },
    weight: 1.2, unlock: 8
  });
  def({
    key: 'magnet', name: 'Magnet', category: 'positive', icon: 'magnet',
    desc: 'When it settles it pulls nearby blocks straight and snaps them onto its grid.',
    colors: { base: '#4a58c4', light: '#8a95ea', dark: '#262f7a', accent: '#dfe6f2' },
    weight: 2, unlock: 6
  });

  // ---- Negative (warm) ----------------------------------------------------
  def({
    key: 'rubber', name: 'Rubber', category: 'negative', icon: 'bounce',
    desc: 'Bouncy and heavy: it drops with full weight and bounces when it lands.',
    colors: { base: '#efb42c', light: '#ffd979', dark: '#9a6a0c', accent: '#c0392b' },
    restitution: 0.55, weight: 2.5, unlock: 0, heavy: true
  });
  def({
    key: 'oil', name: 'Oil Slick', category: 'negative', icon: 'drop',
    desc: 'Frictionless. It slides, and anything on it slides too.',
    colors: { base: '#1a1a1f', light: '#4d4d58', dark: '#060607', accent: '#c4452f' },
    friction: 0, weight: 2, unlock: 6
  });
  def({
    key: 'glass', name: 'Ruby Glass', category: 'negative', icon: 'glass',
    desc: 'Looks solid, but shatters away the first time a block lands on it.',
    colors: { base: '#e25a72', light: '#ffb3c0', dark: '#8a1f36', accent: '#ffffff' },
    weight: 2, unlock: 8
  });
  def({
    key: 'mine', name: 'Mine', category: 'negative', icon: 'mine',
    desc: 'Arms when it settles. Explodes when a block lands on top of it.',
    colors: { base: '#d33a34', light: '#ff7b6c', dark: '#781713', accent: '#ffd166' },
    weight: 2.5, unlock: 10
  });
  def({
    key: 'magma', name: 'Magma', category: 'negative', icon: 'flame',
    desc: 'Melts away 3 drops after it settles. Do not lean on it.',
    colors: { base: '#ff6a1a', light: '#ffc14d', dark: '#9b2a05', accent: '#fff1a8' },
    weight: 2, unlock: 15
  });
  def({
    key: 'spikes', name: 'Spikes', category: 'negative', icon: 'spikes',
    desc: 'Its top is spiked: any block that lands on it is destroyed. Build beside it, never on it.',
    colors: { base: '#8e1d24', light: '#c94a4f', dark: '#4a0b0f', accent: '#e9e4e4' },
    weight: 2, unlock: 18
  });
  def({
    key: 'anvil', name: 'Anvil', category: 'negative', icon: 'anvil',
    desc: 'Very heavy. Smashes the blocks it lands on to dust.',
    colors: { base: '#3a3a41', light: '#6b6b76', dark: '#17171b', accent: '#ff5a2a' },
    density: 4, weight: 2, unlock: 20, heavy: true   // the one block that falls with full weight
  });
  def({
    key: 'blackhole', name: 'Black Hole', category: 'negative', icon: 'swirl',
    desc: 'Swallows any block that touches its sides. Build on top, never beside.',
    colors: { base: '#0c0710', light: '#3b1a2e', dark: '#000000', accent: '#ff3d2e' },
    density: 1.5, weight: 1.5, unlock: 25
  });

  // Normal blocks get a subtle neutral tint per tetromino family (saturation kept low
  // so no family reads as "cold" or "warm").
  const NORMAL_TINTS = Object.freeze({
    I: '#a8a398', O: '#9f9fa6', T: '#aaa095', S: '#9fa49b', Z: '#a69da3', J: '#9ba0a8', L: '#aca69b'
  });

  const SPECIAL_KEYS = Object.freeze(Object.keys(T).filter((k) => T[k].category === 'positive' || T[k].category === 'negative'));
  const POSITIVE_KEYS = Object.freeze(SPECIAL_KEYS.filter((k) => T[k].category === 'positive'));
  const NEGATIVE_KEYS = Object.freeze(SPECIAL_KEYS.filter((k) => T[k].category === 'negative'));

  TT.BLOCK_TYPES = Object.freeze(T);
  TT.NORMAL_TINTS = NORMAL_TINTS;
  TT.SPECIAL_KEYS = SPECIAL_KEYS;   // fixed order: positive then negative, as defined above
  TT.POSITIVE_KEYS = POSITIVE_KEYS;
  TT.NEGATIVE_KEYS = NEGATIVE_KEYS;
})(typeof window !== 'undefined' ? (window.TT = window.TT || {}) : (global.TT = global.TT || {}));
