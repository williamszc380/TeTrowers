/* TeTrowers — canvas renderer.
 *
 * Draws one frame from the game's read-only state (ARCHITECTURE.md §4, §7): an altitude-
 * shifting sky (mountains and clouds near the ground, stars higher up), the platform, every
 * visible block, per-frame animated overlays (mine lights, magma countdown, vine welds,
 * black-hole horizons), the hovering piece with its ghost and warnings, particles, a height
 * ruler and the next life milestone. Game events drive particles and screen shake.
 *
 * Every block reads as one piece: it is painted as a single sprite with a dark outline round
 * its silhouette (the union of its cells), a bevel along that silhouette only, a texture that
 * runs on across its cells, faint inner seams, and its type icon once, on the cell nearest its
 * centre of mass. Plain stone also varies its tint a little per block.
 *
 * Performance model (500+ block towers on phones):
 *  - The world scale is a whole number N of device pixels per cell, and unrotated bodies are
 *    pixel-snapped, so pre-rendered piece sprites blit 1:1 (crisp and cheap).
 *  - A whole piece is painted once per (N, shape, look, tint, variant, cracked, overlay, state)
 *    into an LRU-capped cache, so drawing a block is one drawImage. Textures come from seamless
 *    tiles painted once per (look, N), so a new sprite is cheap to make as well. Painting is
 *    budgeted per frame: after a resize, blocks keep their old sprite (scaled) until repainted.
 *  - Static blocks live in a y-sorted index rebuilt only when physics.version changes, so
 *    culling costs O(log n + visible); movers are culled with a bounding circle.
 *  - The backdrop (sky gradient, stars, mountains, clouds) is composed into one opaque canvas
 *    that is repainted only when the camera moves: a still frame pays one blit for it, which
 *    matters for fill-rate-bound phone GPUs and software canvases alike.
 *  - Gradients, patterns and dash arrays are built on resize; the per-frame path creates no
 *    objects.
 */
(function (TT) {
  'use strict';
  const C = TT.CONFIG;
  const { clamp, damp } = TT.Util;

  const CAMERA_MIN_BOTTOM = (C.CAMERA_MIN_BOTTOM != null ? C.CAMERA_MIN_BOTTOM : -4);  // lowest world y ever shown
  const CAMERA_HEADROOM = (C.CAMERA_HEADROOM != null ? C.CAMERA_HEADROOM : 2);         // cells kept above the piece
  const SHAKE_DECAY = (C.SHAKE_DECAY != null ? C.SHAKE_DECAY : 7);                      // 1/s
  const SHAKE_MAX = (C.SHAKE_MAX != null ? C.SHAKE_MAX : 16);                           // CSS px
  const RENDER_SNAP_ANGLE = (C.RENDER_SNAP_ANGLE != null ? C.RENDER_SNAP_ANGLE : 0.002); // rad: drawn unrotated below this
  const SPRITE_CACHE_MAX = (C.SPRITE_CACHE_MAX != null ? C.SPRITE_CACHE_MAX : 360);        // piece sprites kept (LRU)...
  const SPRITE_CACHE_BYTES = (C.SPRITE_CACHE_BYTES != null ? C.SPRITE_CACHE_BYTES : 24e6);  // ...in at most this much memory
  const SPRITE_PAINT_MS = (C.SPRITE_PAINT_MS != null ? C.SPRITE_PAINT_MS : 4);              // per frame, when a fallback exists

  const TAU = Math.PI * 2;
  const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  const EMPTY = Object.freeze([]);
  const NO_DASH = [];
  const SPIKE_H = 0.28;        // spikes protrude this far (cells) above every open top face
  const MAX_EXTENT = 4.4 + SPIKE_H; // tallest possible visual extent (a tilted I piece, spikes included)
  const CULL_MARGIN = 1.2;     // cells; also covers black-hole horizons beside a block
  const VANISH_MAX = 24;
  const PREVIEW_FIT = 4.4;     // drawPreview: cells across the smaller canvas side
  const MAGNET_RADIUS = (C.MAGNET_RADIUS != null ? C.MAGNET_RADIUS : 2.5);
  const MAGNET_TIME = (C.MAGNET_TIME != null ? C.MAGNET_TIME : 0.6);
  const SQUASH_TIME = 0.5;     // s a rubber block wobbles after landing
  const OUTLINE = 0.065;       // piece outline (cells, at least 1.5 device px), drawn inside the silhouette
  const TINT_VARIANTS = 6;     // plain stone tint steps
  const TEX_VARIANTS = 3;      // texture offsets per special look
  const TILE_CELLS = 4;        // texture tile side in cells: at least the longest piece
  const TILE_MAX = 64;         // texture tiles kept (one per look and cell size; LRU)

  // Sky colour by altitude (m): twilight blue near the ground -> indigo -> near-black space
  const SKY = [
    [-8, '#36467c'], [0, '#2d3b6e'], [12, '#253263'], [30, '#1c2554'], [50, '#151b44'],
    [85, '#0e1132'], [125, '#08091c'], [180, '#040511'], [240, '#03030a']
  ];
  const SKY_ALT0 = -10, SKY_ALT1 = 260;
  const FOG = [41, 53, 95];
  const FOG_TOP = -0.35, FOG_BOTTOM = -3.4;
  const STARS_A = [28, 62];     // sparse stars fade in over this altitude range (view centre)
  const STARS_B = [92, 135];    // dense stars
  const CLOUDS_FADE = [22, 50];
  const MOUNTAINS_FADE = [14, 36];
  const CLOUD_PARALLAX = 0.55;
  const STAR_TILE = 280;        // CSS px

  const ANIMATED = Object.freeze({ mine: true, magma: true, vine: true, blackhole: true, magnet: true });
  const GLOW = Object.freeze({
    positive: 'rgba(150,228,255,0.8)', negative: 'rgba(255,150,100,0.8)',
    normal: 'rgba(255,255,255,0.6)', internal: 'rgba(255,255,255,0.6)'
  });

  // ---- Colour helpers ---------------------------------------------------------------------
  const WHITE = [255, 255, 255], BLACK = [0, 0, 0];
  function rgbOf(hex) {
    let h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    return isNaN(n) ? [160, 160, 160] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function mix(c, d, t) {
    return [Math.round(c[0] + (d[0] - c[0]) * t), Math.round(c[1] + (d[1] - c[1]) * t), Math.round(c[2] + (d[2] - c[2]) * t)];
  }
  function grey(c) { const l = Math.round(c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11); return [l, l, l]; }
  function css(c) { return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; }
  function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (+a).toFixed(3) + ')'; }
  function hex(c) { return '#' + ((1 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]).toString(16).slice(1); }
  function smoothstep(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function toHsl(c) {
    const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    if (d < 1e-6) return [0, 0, l];
    const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, d / (1 - Math.abs(2 * l - 1)), l];
  }
  function fromHsl(h, s, l) {
    const a = s * Math.min(l, 1 - l);
    const f = (n) => { const k = (n + h * 12) % 12; return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255); };
    return [f(0), f(8), f(4)];
  }

  // Plain stone varies per block so neighbouring stones never blend: [lightness, hue (deg),
  // saturation] steps, saturation kept low so no stone reads as cold or warm. Consecutive
  // generator indices step through them, so blocks dropped one after another always differ.
  const TINT_STEPS = [[0, 0, 0], [0.055, 8, 0.01], [-0.045, -7, 0], [0.03, -12, 0.012], [-0.06, 10, -0.008], [0.045, -4, -0.004]];
  function varyTint(c, tv) {
    const st = TINT_STEPS[tv % TINT_VARIANTS];
    if (!st[0] && !st[1] && !st[2]) return c;
    const h = toHsl(c);
    return fromHsl((h[0] + st[1] / 360 + 1) % 1, clamp(h[1] + st[2], 0, 0.13), clamp(h[2] + st[0], 0.05, 0.95));
  }
  function tintVariant(look, n, id) {
    if (look !== 'normal') return 0;
    const k = n >= 0 ? n : (id | 0);
    return ((k % TINT_VARIANTS) + TINT_VARIANTS) % TINT_VARIANTS;
  }
  // Texture offset: stone follows its tint step; rubble varies by id (siblings of one block differ)
  function texVariant(look, cracked, n, id) {
    if (cracked) return ((id | 0) % TEX_VARIANTS + TEX_VARIANTS) % TEX_VARIANTS;
    if (look === 'normal') return tintVariant(look, n, id);
    const k = n >= 0 ? n : (id | 0);
    return ((k % TEX_VARIANTS) + TEX_VARIANTS) % TEX_VARIANTS;
  }

  const palettes = new Map();
  const SPENT = [120, 130, 150];   // a used crystal fades toward slate
  function palette(look, tint, cracked, tv, spent) {
    const key = look + '|' + (tint || '') + '|' + (tv || 0) + (cracked ? '|c' : '') + (spent ? '|s' : '');
    let p = palettes.get(key);
    if (p) return p;
    const type = TT.BLOCK_TYPES[look];
    let base, light, dark, accent;
    if (!type || look === 'normal' || spent) {
      base = spent ? mix(rgbOf(type.colors.base), SPENT, 0.55) : rgbOf(tint || TT.BLOCK_TYPES.normal.colors.base);
      if (tv) base = varyTint(base, tv);
      light = mix(base, WHITE, 0.42); dark = mix(base, BLACK, 0.42); accent = mix(base, BLACK, 0.2);
    } else {
      base = rgbOf(type.colors.base); light = rgbOf(type.colors.light);
      dark = rgbOf(type.colors.dark); accent = rgbOf(type.colors.accent);
    }
    if (cracked && !(ART[look] && ART[look].broken)) {
      const k = (c, t) => mix(mix(c, grey(c), 0.3), BLACK, t);
      base = k(base, 0.24); light = k(light, 0.3); dark = k(dark, 0.2); accent = k(accent, 0.2);
    }
    p = { base, light, dark, accent, edge: mix(dark, BLACK, 0.45) };
    palettes.set(key, p);
    return p;
  }

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  // ---- Shape geometry (silhouette, seams, corners, centre cell, bounding circle) -----------
  const geoms = new Map();
  function shapeGeom(shape) {
    let geom = geoms.get(shape.id);
    if (geom) return geom;
    const occ = new Set(shape.cells.map((c) => c[0] + ',' + c[1]));
    // Counter-clockwise boundary edges (y up); edges shared by two cells are skipped
    const next = new Map();
    for (const [x, y] of shape.cells) {
      if (!occ.has(x + ',' + (y - 1))) next.set(x + ',' + y, [x + 1, y]);
      if (!occ.has((x + 1) + ',' + y)) next.set((x + 1) + ',' + y, [x + 1, y + 1]);
      if (!occ.has(x + ',' + (y + 1))) next.set((x + 1) + ',' + (y + 1), [x, y + 1]);
      if (!occ.has((x - 1) + ',' + y)) next.set(x + ',' + (y + 1), [x, y]);
    }
    const loop = [];
    const start = next.keys().next().value;
    let key = start;
    for (let guard = 0; guard < 64; guard++) {
      const [px, py] = key.split(',').map(Number);
      loop.push([px, py]);
      const n = next.get(key);
      key = n[0] + ',' + n[1];
      if (key === start) break;
    }
    // silhouette corners, each with its inward diagonal (y up) and whether it is convex
    const outline = [], corners = [];
    for (let i = 0; i < loop.length; i++) {
      const a = loop[(i + loop.length - 1) % loop.length], b = loop[i], c = loop[(i + 1) % loop.length];
      const d1x = Math.sign(b[0] - a[0]), d1y = Math.sign(b[1] - a[1]), d2x = Math.sign(c[0] - b[0]), d2y = Math.sign(c[1] - b[1]);
      const turn = d1x * d2y - d1y * d2x;
      if (!turn) continue;
      outline.push(b[0], b[1]);
      corners.push(turn > 0 ? { x: b[0], y: b[1], ix: d2x - d1x, iy: d2y - d1y, convex: true }
        : { x: b[0], y: b[1], ix: d1x - d2x, iy: d1y - d2y, convex: false });
    }
    // inner seams: cell edges shared by two cells of the piece, [x0, y0, x1, y1] each
    const seams = [];
    for (const [x, y] of shape.cells) {
      if (occ.has((x + 1) + ',' + y)) seams.push(x + 1, y, x + 1, y + 1);
      if (occ.has(x + ',' + (y + 1))) seams.push(x, y + 1, x + 1, y + 1);
    }
    let centre = 0, best = Infinity, radius = 0;
    shape.cells.forEach(([x, y], i) => {
      const d = (x + 0.5 - shape.com.x) ** 2 + (y + 0.5 - shape.com.y) ** 2;
      if (d < best - 1e-9) { best = d; centre = i; }
      for (let k = 0; k < 4; k++) {
        radius = Math.max(radius, Math.hypot(x + (k & 1) - shape.com.x, y + (k >> 1) - shape.com.y));
      }
    });
    // cells whose upper neighbour is not part of the piece (spikes grow there)
    const open = Uint8Array.from(shape.cells, ([x, y]) => (occ.has(x + ',' + (y + 1)) ? 0 : 1));
    geom = { outline: Float32Array.from(outline), corners, seams, centre, radius, com: shape.com, open };
    geoms.set(shape.id, geom);
    return geom;
  }

  // Silhouette path with the shape origin at device px (X, Y), y up
  function addOutline(g, geom, X, Y, N) {
    const o = geom.outline;
    g.moveTo(X + o[0] * N, Y - o[1] * N);
    for (let i = 2; i < o.length; i += 2) g.lineTo(X + o[i] * N, Y - o[i + 1] * N);
    g.closePath();
  }
  function traceOutline(g, geom, X, Y, N) {
    g.beginPath();
    addOutline(g, geom, X, Y, N);
  }
  function outlineWidth(N) { return Math.max(1.5, N * OUTLINE); }

  // ---- Drawing helpers ----------------------------------------------------------------------
  function quad(g, x0, y0, x1, y1, x2, y2, x3, y3) {
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.lineTo(x2, y2); g.lineTo(x3, y3); g.closePath(); g.fill();
  }
  function dot(g, x, y, r) { g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); }
  function tri(g, x0, y0, x1, y1, x2, y2) {
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.lineTo(x2, y2); g.closePath(); g.fill();
  }
  function rivet(g, x, y, r, p) {
    g.fillStyle = rgba(p.dark, 0.7);
    dot(g, x + r * 0.3, y + r * 0.4, r);
    const grd = g.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
    grd.addColorStop(0, css(mix(p.light, WHITE, 0.6)));
    grd.addColorStop(1, css(p.accent));
    g.fillStyle = grd;
    dot(g, x, y, r);
  }
  function leafShape(g, x, y, L, a, fill, vein, w) {
    g.save();
    g.translate(x, y);
    g.rotate(a);
    g.beginPath();
    g.moveTo(-L, 0);
    g.quadraticCurveTo(0, -L * 0.72, L, 0);
    g.quadraticCurveTo(0, L * 0.72, -L, 0);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
    g.strokeStyle = vein;
    g.lineWidth = w;
    g.beginPath(); g.moveTo(-L * 0.9, 0); g.lineTo(L * 0.75, 0); g.stroke();
    g.restore();
  }

  // ---- Seamless texture tiles ---------------------------------------------------------------
  // One T x T tile per (look, N), T = TILE_CELLS cells. A feature with bounds [x0, x1] x [y0, y1]
  // is drawn again shifted by T wherever it crosses an edge, so the tile repeats without seams;
  // pieces sample it at a per-variant offset, so the texture runs on across a piece's cells.
  function wrapped(T, x0, y0, x1, y1, draw) {
    for (let dy = -T; dy <= T; dy += T) {
      if (y1 + dy < 0 || y0 + dy > T) continue;
      for (let dx = -T; dx <= T; dx += T) if (x1 + dx >= 0 && x0 + dx <= T) draw(dx, dy);
    }
  }
  function specks(g, T, rng, n, r0, r1, colors) {
    for (let i = 0; i < n; i++) {
      const x = rng() * T, y = rng() * T, r = r0 + rng() * (r1 - r0);
      g.fillStyle = colors[Math.floor(rng() * colors.length)];
      wrapped(T, x - r, y - r, x + r, y + r, (dx, dy) => dot(g, x + dx, y + dy, r));
    }
  }
  // Soft round patches; cols = [[r, g, b, alpha], ...]
  function blobs(g, T, rng, n, r0, r1, cols) {
    for (let i = 0; i < n; i++) {
      const x = rng() * T, y = rng() * T, r = r0 + rng() * (r1 - r0), c = cols[Math.floor(rng() * cols.length)];
      wrapped(T, x - r, y - r, x + r, y + r, (dx, dy) => {
        const grd = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
        grd.addColorStop(0, rgba(c, c[3]));
        grd.addColorStop(1, rgba(c, 0));
        g.fillStyle = grd;
        g.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
      });
    }
  }
  // Random walk polyline [x0, y0, x1, y1, ...]
  function walk(rng, x, y, a, steps, len, turn) {
    const pts = [x, y];
    for (let i = 0; i < steps; i++) {
      a += (rng() - 0.5) * turn;
      const l = len * (0.6 + rng() * 0.8);
      x += Math.cos(a) * l; y += Math.sin(a) * l;
      pts.push(x, y);
    }
    return pts;
  }
  function strokeLines(g, T, lines, w, color, ox, oy) {
    const sx = ox || 0, sy = oy || 0;
    g.beginPath();
    for (const pts of lines) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < pts.length; i += 2) {
        x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]);
        y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]);
      }
      wrapped(T, x0 - w, y0 - w, x1 + w, y1 + w, (dx, dy) => {
        g.moveTo(pts[0] + dx + sx, pts[1] + dy + sy);
        for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i] + dx + sx, pts[i + 1] + dy + sy);
      });
    }
    g.lineWidth = w;
    g.strokeStyle = color;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.stroke();
  }
  // Rows (or columns) of brushing, each with its own random tone
  function brushed(g, T, rng, step, vertical, light, dark, la, da) {
    const w = Math.max(1, Math.round(step * 0.5));
    for (let k = 0; k < T; k += step) {
      g.fillStyle = rng() < 0.5 ? rgba(light, la * (0.35 + rng() * 0.65)) : rgba(dark, da * (0.35 + rng() * 0.65));
      if (vertical) g.fillRect(k, 0, w, T); else g.fillRect(0, k, T, w);
    }
  }
  // Faint wavy bands across the tile (periodic, so they wrap)
  function strata(g, T, N, rng, n, w, colors) {
    for (let i = 0; i < n; i++) {
      const y = rng() * T, k = 1 + Math.floor(rng() * 2), ph = rng() * TAU, A = N * (0.03 + rng() * 0.05);
      const pts = [];
      for (let x = 0; x <= T + 0.5; x += N / 4) pts.push(x, y + A * Math.sin(TAU * k * x / T + ph));
      strokeLines(g, T, [pts], w, colors[i % colors.length]);
    }
  }
  // Jittered periodic lattice of k x k points; at(i, j) for 0 <= i, j <= k (wrapped past the edge)
  function lattice(T, k, rng, jitter, half) {
    const s = T / k, P = [];
    for (let j = 0; j < k; j++) {
      for (let i = 0; i < k; i++) P.push([(i + half + (rng() - 0.5) * jitter) * s, (j + half + (rng() - 0.5) * jitter) * s]);
    }
    return (i, j) => { const q = P[(j % k) * k + (i % k)]; return [q[0] + (i >= k ? T : 0), q[1] + (j >= k ? T : 0)]; };
  }

  // Stone: neutral grain over the block's own tint (white and black only, so one tile serves every
  // tint): soft mottling, faint strata, salt-and-pepper speckle and a few hairline cracks
  function tileStone(g, T, N, u, p, rng) {
    blobs(g, T, rng, 16, N * 0.3, N * 0.8, [[255, 255, 255, 0.09], [0, 0, 0, 0.09]]);
    strata(g, T, N, rng, 4, Math.max(1, u * 0.9), ['rgba(0,0,0,0.06)', 'rgba(255,255,255,0.07)']);
    specks(g, T, rng, 320, u * 0.45, u * 1.05, ['rgba(0,0,0,0.2)', 'rgba(0,0,0,0.11)', 'rgba(255,255,255,0.22)', 'rgba(255,255,255,0.11)']);
    specks(g, T, rng, 26, u * 1.1, u * 1.8, ['rgba(0,0,0,0.1)', 'rgba(255,255,255,0.1)']);
    const cracks = [];
    for (let i = 0; i < 5; i++) cracks.push(walk(rng, rng() * T, rng() * T, rng() * TAU, 3 + Math.floor(rng() * 3), N * 0.15, 1.3));
    const w = Math.max(1, u * 0.8);
    strokeLines(g, T, cracks, w, 'rgba(255,255,255,0.16)', w, w);
    strokeLines(g, T, cracks, w, 'rgba(0,0,0,0.3)');
  }

  // Steel: brushed metal, a few long scratches along the grain
  function tileSteel(g, T, N, u, p, rng) {
    g.fillStyle = css(p.base);
    g.fillRect(0, 0, T, T);
    brushed(g, T, rng, Math.max(1, Math.round(u * 1.1)), false, WHITE, p.dark, 0.2, 0.15);
    const lines = [];
    for (let i = 0; i < 8; i++) {
      const x = rng() * T, y = rng() * T, a = (rng() - 0.5) * 0.12, l = N * (0.8 + rng() * 1.6);
      lines.push([x, y, x + Math.cos(a) * l, y + Math.sin(a) * l]);
    }
    strokeLines(g, T, lines.slice(0, 5), Math.max(1, u * 0.6), 'rgba(255,255,255,0.45)');
    strokeLines(g, T, lines.slice(5), Math.max(1, u * 0.6), rgba(p.dark, 0.3));
  }

  // Vine: wandering stems with small leaves along them and a little mottling
  function tileVine(g, T, N, u, p, rng) {
    g.fillStyle = css(p.base);
    g.fillRect(0, 0, T, T);
    blobs(g, T, rng, 12, N * 0.3, N * 0.7, [p.dark.concat(0.22), p.light.concat(0.14)]);
    const stems = [];
    for (let i = 0; i < 6; i++) stems.push(walk(rng, rng() * T, rng() * T, rng() * TAU, 6, N * 0.3, 1.1));
    strokeLines(g, T, stems, Math.max(1, u * 1.3), rgba(p.dark, 0.45));
    const vein = rgba(p.dark, 0.45), w = Math.max(1, u * 0.6);
    for (const st of stems) {
      for (let i = 2; i < st.length - 2; i += 2) {
        if (rng() < 0.3) continue;
        const a = Math.atan2(st[i + 1] - st[i - 1], st[i] - st[i - 2]) + (rng() < 0.5 ? 1 : -1) * (0.7 + rng() * 0.5);
        const L = N * (0.12 + rng() * 0.09), x = st[i] + Math.cos(a) * L, y = st[i + 1] + Math.sin(a) * L;
        const fill = rng() < 0.55 ? rgba(p.light, 0.5) : rgba(mix(p.base, p.dark, 0.45), 0.6);
        wrapped(T, x - L, y - L, x + L, y + L, (dx, dy) => leafShape(g, x + dx, y + dy, L, a, fill, vein, w));
      }
    }
  }

  // Ice: frosty clouds and a crackle network
  function tileIce(g, T, N, u, p, rng) {
    g.fillStyle = rgba(p.base, 0.9);
    g.fillRect(0, 0, T, T);
    blobs(g, T, rng, 12, N * 0.3, N * 0.8, [[255, 255, 255, 0.25], p.dark.concat(0.14)]);
    const k = 5, at = lattice(T, k, rng, 0.75, 0.5), sz = T / k, lines = [];
    for (let j = 0; j < k; j++) {
      for (let i = 0; i < k; i++) {
        const a = at(i, j);
        for (const [di, dj, pr] of [[1, 0, 0.7], [0, 1, 0.7], [1, 1, 0.3]]) {
          if (rng() > pr) continue;
          const b = at(i + di, j + dj);
          lines.push([a[0], a[1], (a[0] + b[0]) / 2 + (rng() - 0.5) * sz * 0.3, (a[1] + b[1]) / 2 + (rng() - 0.5) * sz * 0.3, b[0], b[1]]);
        }
      }
    }
    strokeLines(g, T, lines, Math.max(1, u * 1.6), rgba(p.dark, 0.22), 1, 1);
    strokeLines(g, T, lines, Math.max(1, u * 0.8), 'rgba(255,255,255,0.65)');
    specks(g, T, rng, 70, u * 0.4, u * 0.9, ['rgba(255,255,255,0.6)', 'rgba(255,255,255,0.32)']);
  }

  // Crystal: a faceted gem, triangles in lighter and darker blues with bright edges
  function tileGem(g, T, N, u, p, rng) {
    const k = 5, at = lattice(T, k, rng, 0.6, 0);
    g.lineJoin = 'round';
    g.lineWidth = Math.max(1, u * 0.7);
    g.strokeStyle = rgba(p.light, 0.4);
    for (let j = 0; j < k; j++) {
      for (let i = 0; i < k; i++) {
        const A = at(i, j), B = at(i + 1, j), Q = at(i + 1, j + 1), D = at(i, j + 1);
        const tris = rng() < 0.5 ? [[A, B, Q], [A, Q, D]] : [[A, B, D], [B, Q, D]];
        for (const t of tris) {
          const sh = rng();
          g.fillStyle = css(sh < 0.55 ? mix(p.base, p.light, 0.05 + sh * 0.8) : mix(p.base, p.dark, (sh - 0.55) * 1.1));
          const x0 = Math.min(t[0][0], t[1][0], t[2][0]), x1 = Math.max(t[0][0], t[1][0], t[2][0]);
          const y0 = Math.min(t[0][1], t[1][1], t[2][1]), y1 = Math.max(t[0][1], t[1][1], t[2][1]);
          wrapped(T, x0, y0, x1, y1, (dx, dy) => {
            g.beginPath();
            g.moveTo(t[0][0] + dx, t[0][1] + dy); g.lineTo(t[1][0] + dx, t[1][1] + dy); g.lineTo(t[2][0] + dx, t[2][1] + dy);
            g.closePath();
            g.fill();
            g.stroke();
          });
        }
      }
    }
  }

  // Magnet: machined indigo enamel, fine turning lines
  function tileMagnet(g, T, N, u, p, rng) {
    g.fillStyle = css(p.base);
    g.fillRect(0, 0, T, T);
    blobs(g, T, rng, 8, N * 0.4, N * 0.9, [p.light.concat(0.1), p.dark.concat(0.14)]);
    brushed(g, T, rng, Math.max(2, Math.round(u * 2)), false, WHITE, p.dark, 0.08, 0.16);
    const lines = [];
    for (let i = 0; i < 5; i++) {
      const x = rng() * T, y = rng() * T, l = N * (0.5 + rng());
      lines.push([x, y, x + l, y + (rng() - 0.5) * N * 0.06]);
    }
    strokeLines(g, T, lines, Math.max(1, u * 0.6), rgba(p.light, 0.3));
  }

  // Rubber: matte, a dense fine grain and soft unevenness
  function tileRubber(g, T, N, u, p, rng) {
    g.fillStyle = css(p.base);
    g.fillRect(0, 0, T, T);
    blobs(g, T, rng, 12, N * 0.3, N * 0.7, [p.light.concat(0.14), p.dark.concat(0.12)]);
    specks(g, T, rng, 760, u * 0.35, u * 0.75, [rgba(p.dark, 0.14), rgba(p.dark, 0.08), rgba(p.light, 0.12)]);
  }

  // Oil: near-black with iridescent patches and soft glossy streaks running '/'
  function tileOil(g, T, N, u, p, rng) {
    g.fillStyle = css(p.base);
    g.fillRect(0, 0, T, T);
    blobs(g, T, rng, 9, N * 0.4, N * 0.9, [p.accent.concat(0.13), [96, 64, 150, 0.12], p.light.concat(0.12)]);
    for (let i = 0; i < 5; i++) {
      const x = rng() * T, w = N * (0.06 + rng() * 0.16), a = 0.04 + rng() * 0.06;
      for (let k = 0; k < 3; k++) strokeLines(g, T, [[x, T, x + T, 0]], w * (1 - k * 0.32), rgba(WHITE, a));
    }
  }

  // Ruby glass: translucent, faint inner streaks and a few bubbles
  function tileGlass(g, T, N, u, p, rng) {
    const ruby = mix(p.base, [200, 0, 40], 0.5);
    g.fillStyle = rgba(ruby, 0.58);
    g.fillRect(0, 0, T, T);
    blobs(g, T, rng, 8, N * 0.4, N * 0.9, [mix(p.light, ruby, 0.4).concat(0.14), mix(p.dark, BLACK, 0.2).concat(0.14)]);
    g.lineWidth = Math.max(1, u * 0.6);
    g.strokeStyle = 'rgba(255,220,228,0.4)';
    for (let i = 0; i < 12; i++) {
      const x = rng() * T, y = rng() * T, r = u * (0.7 + rng() * 0.9);
      wrapped(T, x - r, y - r, x + r, y + r, (dx, dy) => { g.beginPath(); g.arc(x + dx, y + dy, r, 0, TAU); g.stroke(); });
    }
  }

  // Mine: red painted plate, worn and scratched
  function tileMine(g, T, N, u, p, rng) {
    g.fillStyle = css(p.base);
    g.fillRect(0, 0, T, T);
    blobs(g, T, rng, 12, N * 0.3, N * 0.7, [p.dark.concat(0.2), p.light.concat(0.12)]);
    specks(g, T, rng, 140, u * 0.4, u * 0.9, [rgba(p.dark, 0.2), rgba(p.light, 0.16)]);
    const lines = [];
    for (let i = 0; i < 8; i++) lines.push(walk(rng, rng() * T, rng() * T, rng() * TAU, 2, N * 0.14, 0.6));
    strokeLines(g, T, lines, Math.max(1, u * 0.6), rgba(p.light, 0.3));
  }

  // Magma: dark crust plates split by glowing cracks (a wide soft pass, a bright one, a hot core)
  function tileMagma(g, T, N, u, p, rng) {
    g.fillStyle = css(mix(p.base, p.dark, 0.32));
    g.fillRect(0, 0, T, T);
    g.fillStyle = rgba(p.dark, 0.42);
    for (let i = 0; i < 16; i++) {
      const x = rng() * T, y = rng() * T, r = N * (0.18 + rng() * 0.2), rot = rng() * 3;
      wrapped(T, x - r, y - r, x + r, y + r, (dx, dy) => { g.beginPath(); g.ellipse(x + dx, y + dy, r, r * 0.7, rot, 0, TAU); g.fill(); });
    }
    const lines = [];
    for (let i = 0; i < 7; i++) lines.push(walk(rng, rng() * T, rng() * T, rng() * TAU, 6, N * 0.24, 1.3));
    strokeLines(g, T, lines, Math.max(2, u * 3.4), rgba(p.light, 0.32));
    strokeLines(g, T, lines, Math.max(1, u * 1.7), rgba(p.light, 0.9));
    strokeLines(g, T, lines, Math.max(1, u * 0.75), css(p.accent));
  }

  // Anvil: hammered iron, dimples shaded at the top left and lit at the bottom right
  function tileIron(g, T, N, u, p, rng) {
    g.fillStyle = css(p.base);
    g.fillRect(0, 0, T, T);
    blobs(g, T, rng, 8, N * 0.4, N * 0.8, [p.light.concat(0.12), [0, 0, 0, 0.16]]);
    for (let i = 0; i < 80; i++) {
      const x = rng() * T, y = rng() * T, r = N * (0.08 + rng() * 0.1);
      wrapped(T, x - r, y - r, x + r, y + r, (dx, dy) => {
        const grd = g.createLinearGradient(x + dx - r, y + dy - r, x + dx + r, y + dy + r);
        grd.addColorStop(0, 'rgba(0,0,0,0.36)');
        grd.addColorStop(0.55, 'rgba(0,0,0,0)');
        grd.addColorStop(1, rgba(mix(p.light, WHITE, 0.25), 0.3));
        g.fillStyle = grd;
        dot(g, x + dx, y + dy, r);
      });
    }
  }

  // Spikes: dark crimson metal, vertical brushing and scratches
  function tileSpikes(g, T, N, u, p, rng) {
    g.fillStyle = css(mix(p.base, p.dark, 0.28));
    g.fillRect(0, 0, T, T);
    blobs(g, T, rng, 10, N * 0.3, N * 0.8, [p.dark.concat(0.25), p.light.concat(0.08)]);
    brushed(g, T, rng, Math.max(1, Math.round(u * 1.2)), true, p.light, BLACK, 0.1, 0.12);
    const lines = [];
    for (let i = 0; i < 7; i++) lines.push(walk(rng, rng() * T, rng() * T, rng() * TAU, 2, N * 0.16, 0.5));
    strokeLines(g, T, lines, Math.max(1, u * 0.6), rgba(p.light, 0.28));
  }

  // Black hole: near-black, faint purple dust and swirling streaks
  function tileVoid(g, T, N, u, p, rng) {
    g.fillStyle = css(p.base);
    g.fillRect(0, 0, T, T);
    blobs(g, T, rng, 9, N * 0.4, N * 0.9, [p.light.concat(0.3), [70, 24, 100, 0.22]]);
    const arcs = [];
    for (let i = 0; i < 6; i++) {
      const cx = rng() * T, cy = rng() * T, r0 = N * (0.2 + rng() * 0.3), a0 = rng() * TAU, pts = [];
      for (let j = 0; j <= 10; j++) { const a = a0 + j * 0.32, r = r0 * (1 + j * 0.09); pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
      arcs.push(pts);
    }
    strokeLines(g, T, arcs, Math.max(1, u * 1.1), rgba(p.accent, 0.17));
    specks(g, T, rng, 150, u * 0.3, u * 0.8, ['rgba(255,200,230,0.28)', 'rgba(180,140,255,0.22)', rgba(p.accent, 0.3)]);
  }

  // Pebble: clay grain and small pits
  function tileClay(g, T, N, u, p, rng) {
    g.fillStyle = css(p.base);
    g.fillRect(0, 0, T, T);
    blobs(g, T, rng, 12, N * 0.3, N * 0.7, [p.light.concat(0.14), p.dark.concat(0.14)]);
    specks(g, T, rng, 280, u * 0.4, u * 0.9, [rgba(p.light, 0.24), rgba(p.dark, 0.24), rgba(p.dark, 0.12)]);
    specks(g, T, rng, 30, u * 0.9, u * 1.5, [rgba(p.dark, 0.18)]);
  }

  // Crumble: sandstone, wavy strata, sand grain and a few deep cracks
  function tileSand(g, T, N, u, p, rng) {
    g.fillStyle = css(mix(p.base, p.light, 0.14));
    g.fillRect(0, 0, T, T);
    strata(g, T, N, rng, 8, Math.max(1, u * 1.4), [rgba(p.dark, 0.14), rgba(p.dark, 0.09), rgba(p.light, 0.2)]);
    specks(g, T, rng, 340, u * 0.3, u * 0.7, [rgba(p.light, 0.45), rgba(p.dark, 0.3)]);
    const cracks = [];
    for (let i = 0; i < 4; i++) cracks.push(walk(rng, rng() * T, rng() * T, rng() * TAU, 4, N * 0.16, 1.2));
    const w = Math.max(1, u * 1.1);
    strokeLines(g, T, cracks, w, rgba(p.light, 0.35), w * 0.8, w * 0.8);
    strokeLines(g, T, cracks, w, rgba(p.accent, 0.5));
  }

  const tiles = new Map();
  let tileBytes = 0;
  function textureTile(N, look, spent) {
    const art = ART[look] || ART.normal, name = art.tileKey || look;
    const key = N + '|' + name + (spent ? '|s' : '');
    let t = tiles.get(key);
    if (t) {
      tiles.delete(key);   // most recently used last
      tiles.set(key, t);
      return t;
    }
    if (tiles.size >= TILE_MAX) {
      const k0 = tiles.keys().next().value, t0 = tiles.get(k0);
      tileBytes -= t0.width * t0.height * 4;
      t0.width = t0.height = 0;
      tiles.delete(k0);
    }
    const T = TILE_CELLS * N;
    t = makeCanvas(T, T);
    art.tile(t.getContext('2d'), T, N, N / 32, palette(look, null, false, 0, spent), TT.RNG.mulberry32(TT.RNG.hashString(name) + (spent ? 31 : 0)));
    tiles.set(key, t);
    tileBytes += T * T * 4;
    return t;
  }

  // ---- Icons (one cell, origin at its top-left corner) ----------------------------------------
  function iconLeaf(g, N, u, p) {
    g.save();
    g.translate(N / 2, N / 2);
    g.rotate(-Math.PI / 4);
    const L = N * 0.37, W = N * 0.17;
    g.beginPath();
    g.moveTo(-L, 0);
    g.quadraticCurveTo(-L * 0.1, -W * 1.9, L, 0);
    g.quadraticCurveTo(-L * 0.1, W * 1.9, -L, 0);
    g.closePath();
    g.fillStyle = rgba(p.light, 0.92);
    g.fill();
    g.strokeStyle = css(p.dark);
    g.lineWidth = Math.max(1, u * 1.1);
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(-L * 1.05, 0); g.lineTo(L * 0.8, 0);
    for (let k = -1; k <= 1; k++) {
      const x = k * L * 0.36 - L * 0.08;
      g.moveTo(x, 0); g.lineTo(x + L * 0.24, -W * 0.75);
      g.moveTo(x, 0); g.lineTo(x + L * 0.24, W * 0.75);
    }
    g.stroke();
    g.restore();
  }

  function snowflake(g, cx, cy, r, w, color) {
    g.strokeStyle = color;
    g.lineWidth = w;
    g.lineCap = 'round';
    g.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = k * Math.PI / 3 - Math.PI / 2, c = Math.cos(a), s = Math.sin(a);
      g.moveTo(cx, cy); g.lineTo(cx + c * r, cy + s * r);
      const bx = cx + c * r * 0.55, by = cy + s * r * 0.55, br = r * 0.34;
      g.moveTo(bx, by); g.lineTo(bx + Math.cos(a - 0.8) * br, by + Math.sin(a - 0.8) * br);
      g.moveTo(bx, by); g.lineTo(bx + Math.cos(a + 0.8) * br, by + Math.sin(a + 0.8) * br);
    }
    g.stroke();
  }
  function iconSnow(g, N, u, p) {
    snowflake(g, N / 2, N / 2, N * 0.31, Math.max(1.2, u * 2.6), rgba(p.dark, 0.45));
    snowflake(g, N / 2, N / 2, N * 0.31, Math.max(1, u * 1.5), 'rgba(255,255,255,0.97)');
  }

  function iconHeart(g, N, u, p, rng, flag) {
    const spent = flag === 1;
    TT.Particles.heartPath(g, N / 2, N * 0.53, N * 0.5);
    g.fillStyle = spent ? 'rgba(220,228,245,0.3)' : css(p.accent);
    g.fill();
    g.strokeStyle = spent ? 'rgba(30,40,70,0.35)' : rgba(p.dark, 0.85);
    g.lineWidth = Math.max(1, u * 0.9);
    g.stroke();
    if (!spent) {
      g.fillStyle = '#ffffff';
      dot(g, N * 0.4, N * 0.44, Math.max(0.8, u * 1.4));
    }
  }

  function iconPebble(g, N, u, p) {
    const cx = N / 2, cy = N * 0.54, rx = N * 0.25, ry = N * 0.19;
    g.fillStyle = rgba(p.dark, 0.6);
    g.beginPath(); g.ellipse(cx + u * 0.8, cy + ry * 0.45, rx, ry * 0.85, 0, 0, TAU); g.fill();
    const grd = g.createRadialGradient(cx - rx * 0.35, cy - ry * 0.55, 1, cx, cy, rx * 1.05);
    grd.addColorStop(0, css(p.accent));
    grd.addColorStop(0.55, css(p.light));
    grd.addColorStop(1, css(mix(p.base, p.dark, 0.15)));
    g.fillStyle = grd;
    g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, TAU); g.fill();
    g.strokeStyle = rgba(p.dark, 0.7);
    g.lineWidth = Math.max(1, u * 0.8);
    g.stroke();
  }

  // Jagged crack lines from a centre point to the edges; light pass offset for a chiselled look
  function crackLines(g, N, u, p, rng, color, count) {
    const cx = N * (0.38 + rng() * 0.24), cy = N * (0.38 + rng() * 0.24);
    const lines = [];
    for (let k = 0; k < count; k++) {
      const a = k * TAU / count + rng() * 1.1;
      const pts = [cx, cy];
      let r = 0;
      while (r < N * 0.75) {
        r += N * (0.14 + rng() * 0.12);
        const j = (rng() - 0.5) * 0.7;
        pts.push(cx + Math.cos(a + j) * r, cy + Math.sin(a + j) * r);
      }
      lines.push(pts);
    }
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const w = Math.max(1, u * 1.3);
    for (let pass = 0; pass < 2; pass++) {
      g.strokeStyle = pass ? color : rgba(p.light, 0.35);
      g.lineWidth = w;
      const off = pass ? 0 : Math.max(1, u * 0.8);
      g.beginPath();
      for (const pts of lines) {
        g.moveTo(pts[0] + off, pts[1] + off);
        for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i] + off, pts[i + 1] + off);
      }
      g.stroke();
    }
  }
  function iconCrumble(g, N, u, p, rng) {
    crackLines(g, N, u, p, rng, css(p.accent), 3);
    g.fillStyle = rgba(p.accent, 0.55);
    const s = N * 0.2;
    quad(g, N, N, N - s, N, N - s * 0.4, N - s * 0.5, N, N - s);
  }
  function iconRubble(g, N, u, p, rng) { crackLines(g, N, u, p, rng, rgba(mix(p.dark, BLACK, 0.5), 0.9), 3); }

  function dropPath(g, cx, cy, s) {
    g.beginPath();
    g.moveTo(cx, cy - s);
    g.bezierCurveTo(cx + s * 0.25, cy - s * 0.55, cx + s * 0.62, cy - s * 0.15, cx + s * 0.62, cy + s * 0.22);
    g.arc(cx, cy + s * 0.22, s * 0.62, 0, Math.PI, false);
    g.bezierCurveTo(cx - s * 0.62, cy - s * 0.15, cx - s * 0.25, cy - s * 0.55, cx, cy - s);
    g.closePath();
  }
  function iconDrop(g, N, u, p) {
    const cx = N / 2, cy = N * 0.5, s = N * 0.3;
    dropPath(g, cx, cy, s);
    const grd = g.createLinearGradient(cx - s, cy - s, cx + s, cy + s);
    grd.addColorStop(0, '#3c3c48');
    grd.addColorStop(1, '#030304');
    g.fillStyle = grd;
    g.fill();
    g.strokeStyle = rgba(p.accent, 0.95);
    g.lineWidth = Math.max(1, u * 1.1);
    g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.75)';
    g.beginPath(); g.ellipse(cx - s * 0.25, cy + s * 0.05, s * 0.12, s * 0.22, -0.4, 0, TAU); g.fill();
  }

  function iconMine(g, N, u, p) {
    const cx = N / 2, cy = N / 2, R = N * 0.22;
    g.fillStyle = css(mix(p.dark, BLACK, 0.45));
    for (let k = 0; k < 8; k++) {
      const a = k * Math.PI / 4;
      g.beginPath();
      g.moveTo(cx + Math.cos(a - 0.3) * R * 0.9, cy + Math.sin(a - 0.3) * R * 0.9);
      g.lineTo(cx + Math.cos(a) * R * 1.55, cy + Math.sin(a) * R * 1.55);
      g.lineTo(cx + Math.cos(a + 0.3) * R * 0.9, cy + Math.sin(a + 0.3) * R * 0.9);
      g.closePath();
      g.fill();
    }
    const grd = g.createRadialGradient(cx - R * 0.35, cy - R * 0.35, R * 0.1, cx, cy, R);
    grd.addColorStop(0, '#5a1814');
    grd.addColorStop(1, '#1a0504');
    g.fillStyle = grd;
    dot(g, cx, cy, R);
    g.fillStyle = '#4a120e';
    dot(g, cx, cy, R * 0.48);
    g.fillStyle = 'rgba(255,190,170,0.35)';
    dot(g, cx - R * 0.16, cy - R * 0.16, R * 0.16);
  }

  function flamePath(g, cx, cy, s) {
    g.beginPath();
    g.moveTo(cx, cy - s * 0.62);
    g.bezierCurveTo(cx + s * 0.18, cy - s * 0.32, cx + s * 0.46, cy - s * 0.12, cx + s * 0.36, cy + s * 0.2);
    g.bezierCurveTo(cx + s * 0.28, cy + s * 0.46, cx - s * 0.28, cy + s * 0.46, cx - s * 0.36, cy + s * 0.2);
    g.bezierCurveTo(cx - s * 0.44, cy - s * 0.05, cx - s * 0.12, cy - s * 0.24, cx, cy - s * 0.62);
    g.closePath();
  }
  function iconFlame(g, N, u, p, rng, flag) {
    if (flag === 1) return;
    const cx = N / 2, cy = N * 0.52, s = N * 0.62;
    flamePath(g, cx, cy, s);
    g.fillStyle = css(mix(p.dark, BLACK, 0.15));
    g.fill();
    flamePath(g, cx, cy + s * 0.04, s * 0.82);
    g.fillStyle = css(p.light);
    g.fill();
    flamePath(g, cx, cy + s * 0.14, s * 0.46);
    g.fillStyle = css(p.accent);
    g.fill();
  }

  function iconAnvil(g, N, u, p) {
    const s = N * 0.38, cx = N / 2, cy = N * 0.52;
    const P = (x, y) => [cx + x * s, cy + y * s];
    g.beginPath();
    g.moveTo(...P(-0.98, -0.5));
    g.lineTo(...P(0.82, -0.5));
    g.lineTo(...P(0.82, -0.18));
    g.lineTo(...P(0.4, -0.06));
    g.lineTo(...P(0.3, 0.32));
    g.lineTo(...P(0.66, 0.52));
    g.lineTo(...P(0.66, 0.7));
    g.lineTo(...P(-0.52, 0.7));
    g.lineTo(...P(-0.52, 0.52));
    g.lineTo(...P(-0.2, 0.32));
    g.lineTo(...P(-0.26, -0.06));
    g.quadraticCurveTo(...P(-0.72, -0.12), ...P(-0.98, -0.5));
    g.closePath();
    g.fillStyle = '#121216';
    g.fill();
    g.strokeStyle = rgba(p.accent, 0.75);
    g.lineWidth = Math.max(1, u * 0.9);
    g.stroke();
    g.strokeStyle = rgba(mix(p.light, WHITE, 0.3), 0.9);
    g.beginPath(); g.moveTo(...P(-0.9, -0.46)); g.lineTo(...P(0.78, -0.46)); g.stroke();
  }

  function iconRing(g, N, u, p) {
    const cx = N / 2, cy = N / 2, rx = N * 0.37, ry = N * 0.14, tilt = -0.42;
    const ringBack = () => { g.beginPath(); g.ellipse(cx, cy, rx, ry, tilt, Math.PI, TAU); };
    const ringFront = () => { g.beginPath(); g.ellipse(cx, cy, rx, ry, tilt, 0, Math.PI); };
    const grd = g.createLinearGradient(cx - rx, cy, cx + rx, cy);
    grd.addColorStop(0, '#ffb25a');
    grd.addColorStop(0.5, css(p.accent));
    grd.addColorStop(1, '#ff7a3a');
    g.lineCap = 'round';
    for (const draw of [ringBack, null, ringFront]) {
      if (!draw) {
        g.fillStyle = '#000000';
        dot(g, cx, cy, N * 0.15);
        g.strokeStyle = rgba(p.accent, 0.9);
        g.lineWidth = Math.max(1, u * 0.9);
        g.beginPath(); g.arc(cx, cy, N * 0.15, 0, TAU); g.stroke();
        continue;
      }
      g.strokeStyle = rgba(p.accent, 0.3);
      g.lineWidth = Math.max(2, u * 4.5);
      draw(); g.stroke();
      g.strokeStyle = grd;
      g.lineWidth = Math.max(1, u * 1.8);
      draw(); g.stroke();
    }
  }

  // U opening upward: legs run from y = top down to the bend centre cy
  function horseshoePath(g, cx, cy, R, r, top) {
    g.beginPath();
    g.moveTo(cx - R, top);
    g.lineTo(cx - R, cy);
    g.arc(cx, cy, R, Math.PI, 0, true);
    g.lineTo(cx + R, top);
    g.lineTo(cx + r, top);
    g.lineTo(cx + r, cy);
    g.arc(cx, cy, r, 0, Math.PI, false);
    g.lineTo(cx - r, top);
    g.closePath();
  }
  // Tilted 45 degrees (poles to the upper right) so it reads as an object, not a letter U
  function iconMagnet(g, N, u, p) {
    const cx = N / 2, cy = N * 0.48, R = N * 0.285, r = N * 0.11, top = N * 0.17, tip = N * 0.16;
    const ink = css(mix(p.dark, BLACK, 0.6)), lw = Math.max(1, u * 1.2);
    const tilt = (dx, dy) => {
      g.translate(N / 2 + dx, N / 2 + dy);
      g.rotate(Math.PI / 4);
      g.translate(-N / 2, -N / 2);
    };
    g.save();
    tilt(u * 0.9, u * 1.3);
    horseshoePath(g, cx, cy, R, r, top);
    g.fillStyle = rgba(mix(p.dark, BLACK, 0.5), 0.55);
    g.fill();
    g.restore();
    g.save();
    tilt(0, 0);
    horseshoePath(g, cx, cy, R, r, top);
    const body = g.createLinearGradient(cx - R, 0, cx + R, 0);
    body.addColorStop(0, '#2d389c');
    body.addColorStop(0.5, '#1b2270');
    body.addColorStop(1, '#10154a');
    g.fillStyle = body;
    g.fill();
    g.lineJoin = 'round';
    g.strokeStyle = ink;
    g.lineWidth = lw;
    g.stroke();
    // rim light along the left leg and round the bend
    g.strokeStyle = rgba(p.light, 0.8);
    g.lineWidth = Math.max(1, u * 0.9);
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(cx - R + lw * 1.4, top + tip + lw);
    g.lineTo(cx - R + lw * 1.4, cy);
    g.arc(cx, cy, R - lw * 1.4, Math.PI, Math.PI * 0.6, true);
    g.stroke();
    g.lineCap = 'butt';
    // silver pole tips
    const w = R - r;
    for (let k = 0; k < 2; k++) {
      const x0 = k ? cx + r : cx - R;
      const sg = g.createLinearGradient(x0, 0, x0 + w, 0);
      sg.addColorStop(0, '#ffffff');
      sg.addColorStop(0.45, css(p.accent));
      sg.addColorStop(1, css(mix(p.accent, BLACK, 0.32)));
      g.fillStyle = sg;
      g.fillRect(x0, top, w, tip);
      g.strokeStyle = ink;
      g.lineWidth = lw;
      g.strokeRect(x0, top, w, tip);
    }
    g.restore();
  }

  // 'bounce': two red chevrons pointing up
  function iconBounce(g, N, u, p) {
    const chev = (y) => {
      g.beginPath();
      g.moveTo(N * 0.28, y + N * 0.13);
      g.lineTo(N * 0.5, y - N * 0.06);
      g.lineTo(N * 0.72, y + N * 0.13);
    };
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const y of [N * 0.36, N * 0.6]) {
      g.strokeStyle = css(mix(p.accent, BLACK, 0.5));
      g.lineWidth = Math.max(2, u * 5);
      chev(y); g.stroke();
      g.strokeStyle = css(p.accent);
      g.lineWidth = Math.max(1, u * 3);
      chev(y); g.stroke();
    }
    g.lineCap = 'butt';
  }

  // Ruby glass: a four-point glint; flag 1 = armed, a faint hairline crack from an edge
  function iconGlass(g, N, u, p, rng, flag) {
    const cx = N * 0.5, cy = N * 0.5, R = N * 0.3, r = N * 0.045;
    const star = () => {
      g.beginPath();
      g.moveTo(cx, cy - R);
      g.quadraticCurveTo(cx + r, cy - r, cx + R, cy);
      g.quadraticCurveTo(cx + r, cy + r, cx, cy + R);
      g.quadraticCurveTo(cx - r, cy + r, cx - R, cy);
      g.quadraticCurveTo(cx - r, cy - r, cx, cy - R);
      g.closePath();
    };
    g.fillStyle = rgba(mix(p.dark, BLACK, 0.3), 0.45);
    g.translate(u, u * 1.2);
    star(); g.fill();
    g.translate(-u, -u * 1.2);
    g.fillStyle = 'rgba(255,242,246,0.95)';
    star(); g.fill();
    if (flag !== 1) return;
    const fromRight = rng() < 0.5;
    let x = fromRight ? N : N * (0.45 + rng() * 0.35), y = fromRight ? N * (0.45 + rng() * 0.35) : N;
    g.strokeStyle = 'rgba(255,236,241,0.7)';
    g.lineWidth = Math.max(1, u * 0.7);
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(x, y);
    let bx = 0, by = 0;
    for (let k = 0; k < 4; k++) {
      x += (fromRight ? -1 : (rng() - 0.5) * 0.9) * N * (0.09 + rng() * 0.06);
      y += (fromRight ? (rng() - 0.5) * 0.9 : -1) * N * (0.09 + rng() * 0.06);
      g.lineTo(x, y);
      if (k === 1) { bx = x; by = y; }
    }
    g.moveTo(bx, by);
    g.lineTo(bx + (fromRight ? -0.4 : 0.6) * N * 0.14, by + (fromRight ? 0.6 : -0.4) * N * 0.14);
    g.stroke();
  }
  function glints(g, N) {
    g.fillStyle = 'rgba(255,255,255,0.3)';
    quad(g, N * 0.12, N * 0.4, N * 0.4, N * 0.12, N * 0.6, N * 0.12, N * 0.12, N * 0.6);
    g.fillStyle = 'rgba(255,255,255,0.6)';
    quad(g, N * 0.12, N * 0.68, N * 0.68, N * 0.12, N * 0.75, N * 0.12, N * 0.12, N * 0.75);
  }
  // Glass rubble: shard cracks radiating from an impact point (the shard is one cell)
  function rubbleGlass(g, N, u, p, rng) {
    glints(g, N);
    const cx = N * (0.3 + rng() * 0.4), cy = N * (0.3 + rng() * 0.4);
    const lines = [];
    const n = 5 + Math.floor(rng() * 2);
    for (let k = 0; k < n; k++) {
      const a = k * TAU / n + rng() * 0.7;
      const pts = [cx, cy];
      let r = 0;
      while (r < N * 0.8) {
        r += N * (0.12 + rng() * 0.14);
        const j = (rng() - 0.5) * 0.5;
        pts.push(cx + Math.cos(a + j) * r, cy + Math.sin(a + j) * r);
      }
      lines.push(pts);
    }
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (let pass = 0; pass < 2; pass++) {
      g.strokeStyle = pass ? 'rgba(255,240,244,0.9)' : rgba(p.dark, 0.55);
      g.lineWidth = Math.max(1, u * (pass ? 0.8 : 1.6));
      g.beginPath();
      for (const pts of lines) {
        g.moveTo(pts[0], pts[1]);
        for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
      }
      g.stroke();
    }
    // a ring of tiny fractures round the impact point
    g.strokeStyle = 'rgba(255,240,244,0.55)';
    g.lineWidth = Math.max(1, u * 0.6);
    g.beginPath(); g.arc(cx, cy, N * 0.1, 0, TAU); g.stroke();
  }
  // Chip a corner off a glass shard (after the outline, so the edge does not cover the gap)
  function chipGlass(g, N, u, rng) {
    const k = Math.floor(rng() * 4), s = N * (0.2 + rng() * 0.12);
    const x0 = k & 1 ? N : 0, y0 = k & 2 ? N : 0, sx = k & 1 ? -1 : 1, sy = k & 2 ? -1 : 1;
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = '#000000';
    tri(g, x0, y0, x0 + sx * s, y0, x0, y0 + sy * s * (0.6 + rng() * 0.4));
    g.globalCompositeOperation = 'source-over';
  }

  // A pyramid stud seen head-on: a spike pointing out of the face, red at the point
  function iconStud(g, N, u, p) {
    const cx = N / 2, cy = N * 0.52, h = N * 0.245, d = Math.max(1, u * 1.4);
    const sil = p.accent;
    g.fillStyle = 'rgba(0,0,0,0.38)';
    quad(g, cx - h + d, cy - h + d, cx + h + d, cy - h + d, cx + h + d, cy + h + d, cx - h + d, cy + h + d);
    g.fillStyle = css(mix(sil, WHITE, 0.4)); tri(g, cx - h, cy - h, cx + h, cy - h, cx, cy);
    g.fillStyle = css(mix(sil, BLACK, 0.1)); tri(g, cx - h, cy - h, cx - h, cy + h, cx, cy);
    g.fillStyle = css(mix(sil, BLACK, 0.4)); tri(g, cx + h, cy - h, cx + h, cy + h, cx, cy);
    g.fillStyle = css(mix(sil, BLACK, 0.58)); tri(g, cx - h, cy + h, cx + h, cy + h, cx, cy);
    g.fillStyle = css(p.light);
    dot(g, cx, cy, Math.max(0.9, N * 0.045));
    g.strokeStyle = css(mix(p.dark, BLACK, 0.5));
    g.lineWidth = Math.max(1, u * 0.9);
    g.strokeRect(cx - h, cy - h, h * 2, h * 2);
  }

  const strips = new Map();
  // One cell's worth of spikes (3 teeth): silver facets with red tips; active = bright tips.
  // Bottom `bleed` px overlap the cell's top edge so the teeth sit on it.
  function spikeStrip(N, active) {
    const key = N * 2 + (active ? 1 : 0);
    let c = strips.get(key);
    if (c) return c;
    if (strips.size > 16) strips.clear();
    const S = Math.round(N * SPIKE_H), bleed = Math.max(1, Math.round(N * 0.06));
    c = makeCanvas(N, S + bleed);
    const g = c.getContext('2d');
    const n = 3, w = N / n, gap = Math.max(0.5, w * 0.05), top = Math.max(0.5, N / 64), base = S + bleed, tipK = 0.42;
    const lightF = g.createLinearGradient(0, top, 0, base);
    lightF.addColorStop(0, '#ffffff');
    lightF.addColorStop(1, '#c4bfc2');
    const darkF = g.createLinearGradient(0, top, 0, base);
    darkF.addColorStop(0, '#b3acaf');
    darkF.addColorStop(1, '#5f585c');
    const tipL = active ? '#ff3a3a' : '#8a3a3e', tipR = active ? '#c8000f' : '#5a2024';
    for (let k = 0; k < n; k++) {
      const xl = k * w + gap, xr = (k + 1) * w - gap, xm = (xl + xr) / 2;
      const yt = top + (base - top) * tipK, ht = (xm - xl) * tipK;
      g.fillStyle = lightF; tri(g, xm, top, xl, base, xm, base);
      g.fillStyle = darkF; tri(g, xm, top, xm, base, xr, base);
      g.fillStyle = tipL; tri(g, xm, top, xm - ht, yt, xm, yt);
      g.fillStyle = tipR; tri(g, xm, top, xm, yt, xm + ht, yt);
      g.strokeStyle = 'rgba(28,4,8,0.85)';
      g.lineWidth = Math.max(1, N / 40);
      g.lineJoin = 'round';
      g.beginPath(); g.moveTo(xl, base); g.lineTo(xm, top); g.lineTo(xr, base); g.stroke();
      if (active) {
        // a hot glint down the lit edge of each point
        g.strokeStyle = 'rgba(255,214,206,0.95)';
        g.lineWidth = Math.max(1, N / 48);
        g.beginPath(); g.moveTo(xm - ht * 0.15, top + (yt - top) * 0.25); g.lineTo(xm - ht * 0.7, yt + (base - yt) * 0.1); g.stroke();
      }
    }
    strips.set(key, c);
    return c;
  }
  // Spikes on every open top face; a cell's top-left corner is at (x0 + cx*N, y0 - (cy+1)*N)
  function drawSpikeStrips(g, cells, open, N, x0, y0, strip) {
    const S = Math.round(N * SPIKE_H);
    for (let i = 0; i < cells.length; i++) {
      if (open[i]) g.drawImage(strip, x0 + cells[i][0] * N, y0 - (cells[i][1] + 1) * N - S);
    }
  }

  // ---- Piece art ------------------------------------------------------------------------------
  // q = { g, N, u, s (outline px), p (palette), rng, geom, shape, W, H, top (spike room), Y0 }:
  // the piece's local origin (bottom-left, y up) is at canvas (0, Y0), its cells span
  // [0, W] x [top, Y0], and every step below is clipped to the silhouette.

  // Band along the faces looking away from (dx, dy): the piece minus itself shifted by (dx, dy)
  function band(q, dx, dy, style) {
    const g = q.g, N = q.N;
    g.beginPath();
    g.rect(-N, -N, q.W + 2 * N, q.Y0 + 2 * N);
    addOutline(g, q.geom, dx, q.Y0 + dy, N);
    g.fillStyle = style;
    g.fill('evenodd');
  }
  // Bevel along the silhouette only (inner seams get none): lit top/left faces, shaded bottom/right
  function bevel(q, lt) {
    const N = q.N, s = q.s, hi = lt.hiC || q.p.light, sh = lt.shC || q.p.dark;
    const soft = lt.soft != null ? lt.soft : 0.13, hard = s + Math.max(1, N * 0.045);
    if (soft > 0) {
      const d = s + N * soft;
      band(q, 0, d, rgba(hi, lt.hi * 0.4));
      band(q, d, 0, rgba(hi, lt.hi * 0.28));
      band(q, 0, -d, rgba(sh, lt.sh * 0.42));
      band(q, -d, 0, rgba(sh, lt.sh * 0.32));
    }
    band(q, 0, hard, rgba(hi, lt.hi));
    band(q, hard, 0, rgba(hi, lt.hi * 0.7));
    band(q, 0, -hard, rgba(sh, lt.sh));
    band(q, -hard, 0, rgba(sh, lt.sh * 0.75));
  }
  // Stroke of width w just inside the silhouette (the clip removes the outer half)
  function strokeInside(q, style, w) {
    const g = q.g;
    traceOutline(g, q.geom, 0, q.Y0, q.N);
    g.lineWidth = w * 2;
    g.lineJoin = 'miter';
    g.strokeStyle = style;
    g.stroke();
  }
  // Faint seams between the cells of one piece: a dark hairline with a light one beside it
  function drawSeams(q, a) {
    const g = q.g, N = q.N, sm = q.geom.seams, w = Math.max(1, Math.round(N / 44));
    const dark = rgba(q.p.dark, a), light = rgba(q.p.light, a * 0.5);
    for (let i = 0; i < sm.length; i += 4) {
      const x = sm[i] * N, y = q.Y0 - sm[i + 3] * N;   // top / left end of the seam
      if (sm[i] === sm[i + 2]) {
        g.fillStyle = dark; g.fillRect(x - w, y, w, N);
        g.fillStyle = light; g.fillRect(x, y, w, N);
      } else {
        g.fillStyle = dark; g.fillRect(x, y - w, N, w);
        g.fillStyle = light; g.fillRect(x, y, N, w);
      }
    }
  }
  // Broad diagonal light over the whole piece, plus an optional bright streak (metal, gloss)
  function sheen(q, light, streak) {
    const g = q.g, W = q.W, top = q.top, H = q.H;
    const d = Math.max(W, H) / 2, cx = W / 2, cy = top + H / 2;
    const grd = g.createLinearGradient(cx - d, cy - d, cx + d, cy + d);
    grd.addColorStop(0, rgba(WHITE, light));
    grd.addColorStop(0.5, rgba(WHITE, 0));
    grd.addColorStop(1, rgba(BLACK, light * 0.6));
    g.fillStyle = grd;
    g.fillRect(0, top, W, H);
    if (!(streak > 0)) return;
    const st = g.createLinearGradient(cx - d, cy - d, cx + d, cy + d);
    st.addColorStop(0.3, rgba(WHITE, 0));
    st.addColorStop(0.4, rgba(WHITE, streak));
    st.addColorStop(0.5, rgba(WHITE, 0));
    g.fillStyle = st;
    g.fillRect(0, top, W, H);
  }
  // Long '/' glints across the piece, measured from the left end of its top row
  function pieceGlints(q, list) {
    const g = q.g, N = q.N, top = q.top, L = 8 * N;
    let ax = Infinity;
    for (const c of q.shape.cells) if (c[1] === q.shape.h - 1 && c[0] < ax) ax = c[0];
    const x0 = ax * N;
    for (const [a, w, alpha] of list) {
      g.fillStyle = rgba(WHITE, alpha);
      quad(g, x0 + a * N, top, x0 + (a + w) * N, top, x0 + (a + w) * N - L, top + L, x0 + a * N - L, top + L);
    }
  }
  function cornerRivets(q, r, inset, p) {
    for (const k of q.geom.corners) if (k.convex) rivet(q.g, k.x * q.N + k.ix * inset, q.Y0 - k.y * q.N - k.iy * inset, r, p);
  }

  function pieceSteel(q) {
    sheen(q, 0.4, 0.4);
    cornerRivets(q, Math.max(1.1, q.u * 2.1), q.N * 0.21, q.p);
  }
  function pieceIce(q) {
    sheen(q, 0.35, 0);
    pieceGlints(q, [[0.08, 0.5, 0.18], [0.72, 0.1, 0.22]]);
  }
  function pieceGem(q) { sheen(q, 0.32, 0.22); }
  function pieceMagnet(q) { sheen(q, 0.22, 0.16); }
  function pieceMine(q) {
    const p = q.p;
    sheen(q, 0.16, 0);
    cornerRivets(q, Math.max(0.8, q.u * 1.4), q.N * 0.17, { dark: p.dark, light: p.light, accent: mix(p.dark, BLACK, 0.3) });
  }
  function pieceOil(q) {
    const g = q.g, W = q.W, top = q.top, H = q.H;
    const R = Math.min(Math.max(W, H) * 0.55, q.N * 1.6), x = W * 0.8, y = top + H * 0.84;
    const r = g.createRadialGradient(x, y, 0, x, y, R);
    r.addColorStop(0, rgba(q.p.accent, 0.3));
    r.addColorStop(1, rgba(q.p.accent, 0));
    g.fillStyle = r;
    g.fillRect(0, top, W, H);
    sheen(q, 0.12, 0.3);
  }
  // Black hole: the dark gathers into a core on the centre cell (the ring icon sits on it)
  function pieceVoid(q) {
    const g = q.g, N = q.N, cc = q.shape.cells[q.geom.centre];
    const x = (cc[0] + 0.5) * N, y = q.Y0 - (cc[1] + 0.5) * N, R = N * 1.8;
    const r = g.createRadialGradient(x, y, 0, x, y, R);
    r.addColorStop(0, 'rgba(0,0,0,0.95)');
    r.addColorStop(0.4, 'rgba(0,0,0,0.55)');
    r.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = r;
    g.fillRect(0, q.top, q.W, q.H);
  }
  // Anvil: a warm forge glow just inside the outer edge
  function pieceIron(q) {
    strokeInside(q, rgba(q.p.accent, 0.13), q.s + q.N * 0.18);
    strokeInside(q, rgba(q.p.accent, 0.2), q.s + q.N * 0.07);
  }
  // Ruby glass: light top-left to deep bottom-right, long glints, a denser rim with a pink edge
  function pieceGlass(q) {
    const g = q.g, N = q.N, W = q.W, top = q.top, H = q.H, p = q.p;
    const deep = mix(p.dark, BLACK, 0.2), ruby = mix(p.base, [200, 0, 40], 0.5);
    const d = Math.max(W, H) / 2, cx = W / 2, cy = top + H / 2;
    const grd = g.createLinearGradient(cx - d, cy - d, cx + d, cy + d);
    grd.addColorStop(0, rgba(mix(p.light, ruby, 0.45), 0.4));
    grd.addColorStop(0.45, rgba(ruby, 0));
    grd.addColorStop(1, rgba(deep, 0.5));
    g.fillStyle = grd;
    g.fillRect(0, top, W, H);
    pieceGlints(q, [[0.3, 0.22, 0.26], [0.66, 0.08, 0.55], [1.9, 0.14, 0.18]]);
    const e = Math.max(2, Math.round(N * 0.12));
    strokeInside(q, 'rgba(255,150,175,0.35)', q.s + e + Math.max(1, Math.round(q.u * 0.8)));
    strokeInside(q, rgba(deep, 0.42), q.s + e);
  }

  const LIGHT = { hi: 0.42, sh: 0.32, top: 0.1, bottom: 0.12, seam: 0.2 };
  const ART = {
    normal: { tile: tileStone, tileKey: 'stone', base: true },
    rubble: { tile: tileStone, tileKey: 'stone', base: true },
    steel: { tile: tileSteel, piece: pieceSteel, light: { hi: 0.6, sh: 0.32, top: 0.04, bottom: 0.1, seam: 0.15 } },
    vine: { tile: tileVine, icon: iconLeaf },
    frost: {
      tile: tileIce, icon: iconSnow, piece: pieceIce, edge: (p) => css(mix(p.dark, BLACK, 0.42)),
      light: { hi: 0.7, sh: 0.3, hiC: WHITE, top: 0.08, bottom: 0.06, seam: 0.14 }
    },
    crystal: {
      tile: tileGem, icon: iconHeart, piece: pieceGem, edge: (p) => css(mix(p.dark, BLACK, 0.35)),
      light: { hi: 0.5, sh: 0.4, top: 0.06, bottom: 0.1, seam: 0 }
    },
    pebble: { tile: tileClay, icon: iconPebble },
    crumble: { tile: tileSand, icon: iconCrumble },
    oil: {
      tile: tileOil, icon: iconDrop, piece: pieceOil, rim: (p) => rgba(mix(p.light, WHITE, 0.25), 0.6),
      light: { hi: 0.55, sh: 0.5, top: 0.06, bottom: 0.12, seam: 0.12 }
    },
    mine: { tile: tileMine, icon: iconMine, piece: pieceMine },
    magma: { tile: tileMagma, icon: iconFlame, light: { hi: 0.35, sh: 0.4, top: 0.06, bottom: 0.16, seam: 0.16 } },
    anvil: {
      tile: tileIron, icon: iconAnvil, piece: pieceIron, rim: (p) => rgba(mix(p.light, WHITE, 0.2), 0.55),
      light: { hi: 0.5, sh: 0.45, top: 0.06, bottom: 0.14, seam: 0.14 }
    },
    blackhole: {
      tile: tileVoid, icon: iconRing, piece: pieceVoid, rim: (p) => rgba(p.accent, 0.6),
      light: { hi: 0.45, sh: 0.4, top: 0.04, bottom: 0.1, seam: 0.1 }
    },
    magnet: { tile: tileMagnet, icon: iconMagnet, piece: pieceMagnet },
    rubber: { tile: tileRubber, icon: iconBounce, light: { hi: 0.42, sh: 0.34, soft: 0.22, top: 0.08, bottom: 0.12, seam: 0.16 } },
    glass: {
      tile: tileGlass, icon: iconGlass, piece: pieceGlass, edge: (p) => rgba(mix(p.dark, BLACK, 0.3), 0.92),
      broken: rubbleGlass, chip: chipGlass,
      light: { hi: 0.85, sh: 0.5, hiC: [255, 228, 235], shC: [255, 170, 190], soft: 0, top: 0, bottom: 0, seam: 0.1 }
    },
    spikes: { tile: tileSpikes, icon: iconStud, rim: (p) => rgba(mix(p.light, WHITE, 0.2), 0.4) }
  };

  // Frozen by frost: icy tint and frosted outer corners (the bright rim is drawn with the outline)
  const FROST_RIM = 'rgba(225,248,255,0.85)';
  function frostOverlay(q) {
    const g = q.g, N = q.N, rng = q.rng, s = N * 0.3;
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = 'rgba(170,226,255,0.34)';
    g.fillRect(0, q.top, q.W, q.H);
    g.fillStyle = 'rgba(238,250,255,0.9)';
    for (const k of q.geom.corners) {
      if (!k.convex) continue;
      const x0 = k.x * N, y0 = q.Y0 - k.y * N, sx = k.ix, sy = -k.iy;
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x0 + sx * s * (0.8 + rng() * 0.4), y0);
      g.lineTo(x0 + sx * s * 0.45, y0 + sy * s * 0.28);
      g.lineTo(x0 + sx * s * 0.5, y0 + sy * s * 0.5);
      g.lineTo(x0 + sx * s * 0.28, y0 + sy * s * 0.45);
      g.lineTo(x0, y0 + sy * s * (0.8 + rng() * 0.4));
      g.closePath();
      g.fill();
    }
    g.globalCompositeOperation = 'source-over';
  }
  // Petrified: partially desaturated and slightly darker (subtle on purpose)
  function petrifyOverlay(q) {
    const g = q.g;
    g.globalCompositeOperation = 'saturation';
    g.globalAlpha = 0.45;
    g.fillStyle = '#808080';
    g.fillRect(0, q.top, q.W, q.H);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = 'rgba(16,18,30,0.14)';
    g.fillRect(0, q.top, q.W, q.H);
    g.globalCompositeOperation = 'source-over';
  }

  // State flags (bits): 1 crystal spent, 2 magma counting down (its number replaces the flame),
  // 4 glass armed (hairline crack), 8 spikes active (bright tips). Overlays: 1 frost, 2 petrified.
  function iconFlag(look, flags) {
    return (look === 'crystal' && (flags & 1)) || (look === 'magma' && (flags & 2)) || (look === 'glass' && (flags & 4)) ? 1 : 0;
  }

  function paintPiece(N, shape, look, tint, cracked, tv, xv, overlay, flags) {
    const art = ART[look] || ART.normal;
    const spent = look === 'crystal' && !cracked && (flags & 1) !== 0;
    const p = palette(look, tint, cracked, tv, spent);
    const geom = shapeGeom(shape), u = N / 32, s = outlineWidth(N);
    const top = look === 'spikes' && !cracked ? Math.round(N * SPIKE_H) : 0;
    const W = shape.w * N, H = shape.h * N, Y0 = top + H;
    const c = makeCanvas(W, Y0), g = c.getContext('2d');
    const rng = TT.RNG.mulberry32(TT.RNG.hashString(look + shape.id) + xv * 7919 + (cracked ? 104729 : 0));
    const lt = art.light || LIGHT;
    const q = { g, N, u, s, p, rng, geom, shape, W, H, top, Y0 };
    g.save();
    traceOutline(g, geom, 0, Y0, N);
    g.clip();
    // surface: the look's seamless texture (over a flat tint for stone), sampled at an offset
    // that depends on the variant and the shape, so no two neighbours repeat the same stamp
    if (art.base) { g.fillStyle = css(p.base); g.fillRect(0, top, W, H); }
    const tile = textureTile(N, look, spent), T = tile.width, hs = TT.RNG.hashString(shape.id);
    const ox = Math.floor((((xv + 1) * 0.618034 + (hs % 997) / 997) % 1) * T);
    const oy = Math.floor((((xv + 1) * 0.381966 + (hs % 991) / 991) % 1) * T);
    for (let y = top - oy; y < Y0; y += T) for (let x = -ox; x < W; x += T) g.drawImage(tile, x, y);
    if (cracked && !art.base && !art.broken) {
      // rubble keeps the look it came from, darker and greyer
      g.globalCompositeOperation = 'saturation';
      g.globalAlpha = 0.3;
      g.fillStyle = '#808080';
      g.fillRect(0, top, W, H);
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
      g.fillStyle = 'rgba(0,0,0,0.24)';
      g.fillRect(0, top, W, H);
    }
    if (art.piece) art.piece(q);
    // one soft light over the whole piece: brighter top, darker foot
    const lg = g.createLinearGradient(0, top, 0, Y0);
    lg.addColorStop(0, rgba(WHITE, lt.top));
    lg.addColorStop(0.5, rgba(WHITE, 0));
    lg.addColorStop(1, rgba(BLACK, lt.bottom));
    g.fillStyle = lg;
    g.fillRect(0, top, W, H);
    if (lt.seam) drawSeams(q, lt.seam);
    // the type icon once, on the cell nearest the centre of mass (rubble: its cracks)
    const cc = shape.cells[geom.centre];
    g.translate(cc[0] * N, Y0 - (cc[1] + 1) * N);
    if (cracked) (art.broken || iconRubble)(g, N, u, p, rng);
    else if (art.icon) art.icon(g, N, u, p, rng, iconFlag(look, flags));
    g.setTransform(1, 0, 0, 1, 0, 0);
    bevel(q, lt);
    if (overlay === 1) frostOverlay(q);
    const rim = overlay === 1 ? FROST_RIM : art.rim ? art.rim(p) : null;
    if (rim) strokeInside(q, rim, s + Math.max(1, Math.round(u * 1.2)));
    strokeInside(q, art.edge ? art.edge(p) : css(p.edge), s);
    if (overlay === 2) petrifyOverlay(q);
    g.restore();
    if (cracked && art.chip) art.chip(g, N, u, rng);
    if (top) drawSpikeStrips(g, shape.cells, geom.open, N, 0, Y0, spikeStrip(N, (flags & 8) !== 0));
    return c;
  }

  // ---- Piece sprite cache (LRU by count and pixel memory) -----------------------------------
  const sprites = new Map();     // key -> { key, N, canvas, dx, dy, bytes, used }
  let spriteBytes = 0, spriteClock = 1;
  // Over a cap, drop the least recently drawn sprites; whatever was drawn this frame or the last
  // one stays, so the caps are soft and a view needing more sprites never thrashes. keepN (after
  // a resize): drop every sprite and tile of another cell size instead, nothing draws them again.
  function trimSprites(keepN) {
    if (keepN) {
      for (const e of Array.from(sprites.values())) if (e.N !== keepN) dropSprite(e);
      for (const [k, t] of Array.from(tiles)) {
        if (k.startsWith(keepN + '|')) continue;
        tileBytes -= t.width * t.height * 4;
        t.width = t.height = 0;
        tiles.delete(k);
      }
      return;
    }
    if (sprites.size <= SPRITE_CACHE_MAX && spriteBytes <= SPRITE_CACHE_BYTES) return;
    const list = [];
    for (const e of sprites.values()) if (e.used < spriteClock - 1) list.push(e);
    list.sort((a, b) => a.used - b.used);
    for (let i = 0; i < list.length; i++) {
      if (sprites.size <= SPRITE_CACHE_MAX * 0.85 && spriteBytes <= SPRITE_CACHE_BYTES * 0.85) break;
      dropSprite(list[i]);
    }
  }
  function dropSprite(e) {
    sprites.delete(e.key);
    spriteBytes -= e.bytes;
    e.canvas.width = e.canvas.height = 0;
    e.canvas = null;
  }
  // peek: only look it up (null if it would have to be painted)
  function pieceSprite(N, shape, look, tint, cracked, tv, xv, overlay, flags, peek) {
    const key = N + '|' + shape.id + '|' + look + '|' + (tint || '') + '|' + tv + '|' + xv + '|' + (cracked ? 1 : 0) + '|' + overlay + '|' + flags;
    let e = sprites.get(key);
    if (!e) {
      if (peek) return null;
      const c = paintPiece(N, shape, look, tint, cracked, tv, xv, overlay, flags);
      e = { key, N, canvas: c, dx: 0, dy: -c.height, bytes: c.width * c.height * 4, used: spriteClock };
      sprites.set(key, e);
      spriteBytes += e.bytes;
      trimSprites();
    }
    e.used = spriteClock;
    return e;
  }
  function spriteStats() {
    return { sprites: sprites.size, spriteBytes, tiles: tiles.size, tileBytes, masks: masks.size };
  }

  // Additive flash inside a piece's silhouette (inset by the outline, which stays dark),
  // brightest on the centre cell: a lit mine, magma about to melt
  const masks = new Map();
  const MASK_STOPS = {
    lit: [[0, [255, 246, 208], 1], [0.35, [255, 122, 58], 0.85], [1, [255, 48, 24], 0.45]],
    magma: [[0, [255, 240, 168], 1], [0.4, [255, 138, 42], 0.7], [1, [255, 106, 26], 0.35]]
  };
  function glowMask(N, shape, kind) {
    const key = N + '|' + shape.id + '|' + kind;
    let c = masks.get(key);
    if (c) return c;
    if (masks.size >= 48) masks.clear();
    const geom = shapeGeom(shape), W = shape.w * N, H = shape.h * N;
    c = makeCanvas(W, H);
    const g = c.getContext('2d');
    traceOutline(g, geom, 0, H, N);
    g.clip();
    const cc = shape.cells[geom.centre], x = (cc[0] + 0.5) * N, y = H - (cc[1] + 0.5) * N;
    const grd = g.createRadialGradient(x, y, 0, x, y, N * 2.2);
    for (const [t, col, a] of MASK_STOPS[kind]) grd.addColorStop(t, rgba(col, a));
    g.fillStyle = grd;
    g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'destination-out';
    traceOutline(g, geom, 0, H, N);
    g.lineWidth = outlineWidth(N) * 2;
    g.stroke();
    masks.set(key, c);
    return c;
  }

  // Vine welds, baked per vine: at each anchor a pair of leaves just inside the vine and a thin
  // tendril hooking over the seam onto the partner, so the dark line between the pieces stays
  function paintWelds(N, shape, welds) {
    const geom = shapeGeom(shape), pad = Math.round(N * 0.5), u = N / 32;
    const c = makeCanvas(shape.w * N + pad * 2, shape.h * N + pad * 2), g = c.getContext('2d');
    const Y0 = pad + shape.h * N, o = geom.outline, n = o.length / 2, at = [];
    for (let i = 0; i < welds.length; i++) {
      const w = welds[i];
      if (!w) continue;
      // nearest silhouette edge and its outward normal (the outline runs counter-clockwise, y up)
      let best = Infinity, px = w.x, py = w.y, nx = 0, ny = 1;
      for (let k = 0; k < n; k++) {
        const ax = o[k * 2], ay = o[k * 2 + 1], bx = o[((k + 1) % n) * 2], by = o[((k + 1) % n) * 2 + 1];
        const qx = clamp(w.x, Math.min(ax, bx), Math.max(ax, bx)), qy = clamp(w.y, Math.min(ay, by), Math.max(ay, by));
        const d = (qx - w.x) * (qx - w.x) + (qy - w.y) * (qy - w.y);
        if (d < best) { best = d; px = qx; py = qy; nx = Math.sign(by - ay); ny = -Math.sign(bx - ax); }
      }
      at.push(pad + px * N, Y0 - py * N, nx, -ny);
    }
    g.save();
    traceOutline(g, geom, pad, Y0, N);
    g.clip();
    for (let i = 0; i < at.length; i += 4) {
      const a = Math.atan2(at[i + 3], at[i + 2]) + Math.PI, L = N * 0.15;
      for (let side = -1; side <= 1; side += 2) {
        const b = a + side * 0.8;
        leafShape(g, at[i] + Math.cos(b) * L * 1.15, at[i + 1] + Math.sin(b) * L * 1.15, L, b, '#74de82', '#1d6831', Math.max(1, u * 0.7));
      }
    }
    g.restore();
    g.lineCap = 'round';
    for (let i = 0; i < at.length; i += 4) {
      const x = at[i], y = at[i + 1], nx = at[i + 2], ny = at[i + 3], tx = -ny, ty = nx;
      const x1 = x + nx * N * 0.2 + tx * N * 0.06, y1 = y + ny * N * 0.2 + ty * N * 0.06, r = N * 0.055;
      const a0 = Math.atan2(-ty, -tx);
      for (let pass = 0; pass < 2; pass++) {
        g.strokeStyle = pass ? '#6ad87a' : '#123f20';
        g.lineWidth = pass ? Math.max(1, N * 0.03) : Math.max(2, N * 0.07);
        g.beginPath();
        g.moveTo(x - nx * N * 0.1, y - ny * N * 0.1);
        g.quadraticCurveTo(x + tx * N * 0.14, y + ty * N * 0.14, x1, y1);
        g.arc(x1 + tx * r, y1 + ty * r, r, a0, a0 + Math.PI * 1.5);
        g.stroke();
      }
    }
    return { canvas: c, pad, Y0, n: welds.length, gen: -1 };
  }

  // ---- FX sprites (per cell size) ---------------------------------------------------------
  function glowSprite(S, core, outer) {
    const c = makeCanvas(S, S), g = c.getContext('2d'), r = c.width / 2;
    const co = rgbOf(core), ou = rgbOf(outer);
    const grd = g.createRadialGradient(r, r, 0, r, r, r);
    grd.addColorStop(0, rgba(co, 1));
    grd.addColorStop(0.16, rgba(co, 0.92));
    grd.addColorStop(0.4, rgba(ou, 0.45));
    grd.addColorStop(1, rgba(ou, 0));
    g.fillStyle = grd;
    g.fillRect(0, 0, c.width, c.height);
    return c;
  }

  function vortexSprite(N) {
    const c = makeCanvas(N, N), g = c.getContext('2d'), r = c.width / 2;
    const grd = g.createRadialGradient(r, r, 0, r, r, r);
    grd.addColorStop(0, 'rgba(0,0,0,0.95)');
    grd.addColorStop(0.3, 'rgba(16,0,5,0.85)');
    grd.addColorStop(0.7, 'rgba(95,8,18,0.42)');
    grd.addColorStop(1, 'rgba(160,14,26,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, c.width, c.height);
    g.lineCap = 'round';
    for (let k = 0; k < 3; k++) {
      let px = 0, py = 0;
      for (let j = 0; j <= 40; j++) {
        const t = j / 40;
        const a = k * TAU / 3 + t * Math.PI * 2.1;
        const rr = r * 0.97 * (1 - t) + r * 0.05;
        const x = r + Math.cos(a) * rr, y = r + Math.sin(a) * rr;
        if (j > 0) {
          g.strokeStyle = 'rgba(255,' + Math.round(40 + 90 * (1 - t)) + ',' + Math.round(30 + 30 * (1 - t)) + ',' +
            (0.9 * Math.min(1, (1 - t) * 1.4) * Math.min(1, t * 5 + 0.25)).toFixed(3) + ')';
          g.lineWidth = Math.max(1, N * 0.09 * (1 - t * 0.75));
          g.beginPath(); g.moveTo(px, py); g.lineTo(x, y); g.stroke();
        }
        px = x; py = y;
      }
    }
    return c;
  }

  function digitSprite(N, d) {
    const c = makeCanvas(N, N), g = c.getContext('2d');
    const s = String(d);
    g.font = '900 ' + Math.round(N * 0.78) + 'px ' + FONT_FAMILY;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = Math.max(2, N * 0.13);
    g.strokeStyle = 'rgba(60,10,0,0.95)';
    g.strokeText(s, N / 2, N * 0.55);
    g.fillStyle = '#fff4bd';
    g.fillText(s, N / 2, N * 0.55);
    return c;
  }

  // The hovering piece: the very sprite it will have once dropped, in a halo of its category
  // colour with a light rim just outside the outline
  function buildPieceSprite(N, typeKey, shape, v) {
    const type = TT.BLOCK_TYPES[typeKey] || TT.BLOCK_TYPES.normal;
    const cracked = type.key === 'rubble';
    const look = cracked || !ART[type.key] ? 'normal' : type.key;
    const tint = look === 'normal' ? TT.NORMAL_TINTS[shape.family] : null;
    const spr = pieceSprite(N, shape, look, tint, cracked, tintVariant(look, v, 0), texVariant(look, cracked, v, 0), 0, 0).canvas;
    const pad = Math.max(3, Math.round(N * 0.42)), geom = shapeGeom(shape);
    const c = makeCanvas(spr.width + pad * 2, spr.height + pad * 2), g = c.getContext('2d');
    const oy = pad + spr.height;   // canvas y of the piece's local origin (its bottom edge)
    const glow = GLOW[type.category] || GLOW.normal;
    g.save();
    g.shadowColor = glow;
    g.shadowBlur = pad * 0.85;
    g.fillStyle = glow;
    traceOutline(g, geom, pad, oy, N);
    g.fill();
    g.restore();
    traceOutline(g, geom, pad, oy, N);
    g.strokeStyle = 'rgba(255,255,255,0.8)';
    g.lineWidth = Math.max(2, Math.round(N / 11));
    g.lineJoin = 'miter';
    g.stroke();
    // keep only the halo and the rim: translucent cells (glass) must show the sky
    g.globalCompositeOperation = 'destination-out';
    traceOutline(g, geom, pad, oy, N);
    g.fill();
    g.globalCompositeOperation = 'source-over';
    g.drawImage(spr, pad, pad);
    return { canvas: c, pad, oy, typeKey, shape, v, gen: -1 };
  }

  const ghostColorCache = new Map();
  function ghostColors(typeKey, shape) {
    const key = typeKey === 'normal' ? 'normal' + shape.family : typeKey;
    let gc = ghostColorCache.get(key);
    if (!gc) {
      const p = typeKey === 'normal' ? palette('normal', TT.NORMAL_TINTS[shape.family], false) : palette(typeKey, null, false);
      gc = { fill: rgba(p.base, 0.15), stroke: rgba(mix(p.light, WHITE, 0.35), 0.78) };
      ghostColorCache.set(key, gc);
    }
    return gc;
  }

  // ---- Background layers (built on resize) ------------------------------------------------
  function starTile(T, count, dpr, seed, bright) {
    const c = makeCanvas(T, T), g = c.getContext('2d');
    const rng = TT.RNG.mulberry32(seed);
    for (let i = 0; i < count; i++) {
      const x = rng() * T, y = rng() * T;
      const r = (bright ? 0.55 + rng() * 0.85 : 0.35 + rng() * 0.45) * dpr;
      const a = (bright ? 0.45 + rng() * 0.55 : 0.25 + rng() * 0.5).toFixed(2);
      const tint = rng();
      g.fillStyle = tint < 0.15 ? 'rgba(255,224,190,' + a + ')' : tint < 0.38 ? 'rgba(190,210,255,' + a + ')' : 'rgba(255,255,255,' + a + ')';
      dot(g, x, y, r);
      if (bright && rng() < 0.1) {
        g.strokeStyle = 'rgba(220,230,255,' + (a * 0.45).toFixed(2) + ')';
        g.lineWidth = Math.max(0.5, dpr * 0.5);
        g.beginPath();
        g.moveTo(x - r * 4, y); g.lineTo(x + r * 4, y);
        g.moveTo(x, y - r * 4); g.lineTo(x, y + r * 4);
        g.stroke();
      }
    }
    return c;
  }

  function mountainLayer(W, H, N, seed, top, bottom, amp) {
    const c = makeCanvas(W, H), g = c.getContext('2d');
    const rng = TT.RNG.mulberry32(seed);
    const f = [0.16, 0.37, 0.83, 1.9], a = [0.3, 0.17, 0.07, 0.025];
    const ph = f.map(() => rng() * TAU);
    const ridge = (x) => {
      let y = 0.5;
      for (let k = 0; k < f.length; k++) y += a[k] * amp * Math.sin((x / N) * f[k] + ph[k]);
      return H * (1 - clamp(y, 0.06, 0.98));
    };
    g.beginPath();
    g.moveTo(0, H);
    const step = Math.max(2, Math.round(N / 6));
    for (let x = 0; x <= W + step; x += step) g.lineTo(x, ridge(x));
    g.lineTo(W, H);
    g.closePath();
    const grd = g.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, top);
    grd.addColorStop(1, bottom);
    g.fillStyle = grd;
    g.fill();
    // faint rim light along the ridge
    g.strokeStyle = 'rgba(150,170,230,0.12)';
    g.lineWidth = Math.max(1, N / 24);
    g.beginPath();
    for (let x = 0; x <= W + step; x += step) { const y = ridge(x) + g.lineWidth; if (x) g.lineTo(x, y); else g.moveTo(x, y); }
    g.stroke();
    return c;
  }

  // Soft twilight cloud: puffs along a flat base, biggest in the middle
  function cloudSprite(wCells, hCells, N, seed) {
    const W = Math.round(wCells * N), H = Math.round(hCells * N);
    const c = makeCanvas(W, H), g = c.getContext('2d');
    const rng = TT.RNG.mulberry32(seed);
    const base = H * 0.74, n = 6 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const r = H * (0.2 + 0.32 * Math.sin(Math.PI * t)) * (0.8 + rng() * 0.4);
      const x = W * (0.1 + 0.8 * t) + (rng() - 0.5) * r * 0.5, y = base - r * 0.5;
      const grd = g.createRadialGradient(x, y - r * 0.2, 0, x, y, r * 1.25);
      grd.addColorStop(0, 'rgba(158,172,228,0.5)');
      grd.addColorStop(0.55, 'rgba(132,148,210,0.3)');
      grd.addColorStop(1, 'rgba(118,134,198,0)');
      g.fillStyle = grd;
      g.fillRect(x - r * 1.3, y - r * 1.3, r * 2.6, r * 2.6);
    }
    g.globalCompositeOperation = 'destination-out';
    const flat = g.createLinearGradient(0, base - H * 0.08, 0, base + H * 0.22);
    flat.addColorStop(0, 'rgba(0,0,0,0)');
    flat.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = flat;
    g.fillRect(0, base - H * 0.08, W, H);
    g.globalCompositeOperation = 'source-over';
    return c;
  }

  function platformSprite(N, cells, depth) {
    const W = Math.round(cells * N), H = Math.round(depth * N);
    const c = makeCanvas(W, H), g = c.getContext('2d');
    const u = N / 32;
    const slab = Math.round(N * 0.8);
    const pg = g.createLinearGradient(0, 0, W, 0);
    pg.addColorStop(0, '#495164');
    pg.addColorStop(0.5, '#3b4253');
    pg.addColorStop(1, '#2c313f');
    g.fillStyle = pg;
    g.fillRect(0, slab, W, H - slab);
    // masonry courses
    const course = Math.round(N * 0.75), lw = Math.max(1, Math.round(u));
    for (let row = 0, y = slab; y < H; row++, y += course) {
      g.fillStyle = 'rgba(14,16,24,0.55)';
      g.fillRect(0, y + course - lw, W, lw);
      g.fillStyle = 'rgba(160,172,200,0.08)';
      g.fillRect(0, y + course, W, lw);
      g.fillStyle = 'rgba(14,16,24,0.5)';
      for (let x = (row % 2 ? N * 0.75 : 0) + N * 1.5; x < W; x += N * 1.5) g.fillRect(Math.round(x), y, lw, course);
    }
    g.fillStyle = 'rgba(255,255,255,0.06)';
    g.fillRect(0, slab, Math.max(1, Math.round(u * 2)), H - slab);
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(W - Math.max(1, Math.round(u * 2)), slab, Math.max(1, Math.round(u * 2)), H - slab);
    // top slab
    const sg = g.createLinearGradient(0, 0, 0, slab);
    sg.addColorStop(0, '#8790a3');
    sg.addColorStop(0.18, '#6c7588');
    sg.addColorStop(1, '#4d5466');
    g.fillStyle = sg;
    g.fillRect(0, 0, W, slab);
    const rng = TT.RNG.mulberry32(77);
    for (let i = 0; i < cells * 12; i++) {
      g.fillStyle = rng() < 0.5 ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.12)';
      dot(g, rng() * W, slab * (0.25 + rng() * 0.65), Math.max(0.6, u * (0.4 + rng() * 0.7)));
    }
    g.fillStyle = 'rgba(16,18,26,0.45)';
    for (let x = N * 2; x < W - 1; x += N * 2) g.fillRect(Math.round(x), Math.round(slab * 0.2), lw, slab);
    g.fillStyle = 'rgba(214,222,238,0.9)';
    g.fillRect(0, 0, W, Math.max(1, Math.round(u * 1.4)));
    g.fillStyle = 'rgba(8,10,16,0.7)';
    g.fillRect(0, slab - lw, W, Math.max(1, Math.round(u * 1.5)));
    // fade the pillar out toward its foot (the fog takes over)
    g.globalCompositeOperation = 'destination-in';
    const fade = g.createLinearGradient(0, 0, 0, H);
    fade.addColorStop(0, 'rgba(0,0,0,1)');
    fade.addColorStop(0.4, 'rgba(0,0,0,1)');
    fade.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = fade;
    g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'source-over';
    return c;
  }

  const byMinY = (a, b) => a.minY - b.minY;

  // ---- Renderer ---------------------------------------------------------------------------
  class Renderer {
    // opts: { reducedMotion, showGhost } (both may be changed later via setOptions)
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false });
      this.options = Object.assign({ reducedMotion: false, showGhost: true }, opts || {});
      this.particles = new TT.Particles();
      this.game = null;
      this._unsubs = [];
      this.cssW = 0; this.cssH = 0; this.dpr = 1; this.pxW = 0; this.pxH = 0;
      this.N = 0;                   // device px per cell (integer)
      this.scale = 1;               // CSS px per cell
      this._fieldX = 0;             // device px of world x = 0
      this.camBottom = CAMERA_MIN_BOTTOM;
      this.camTarget = CAMERA_MIN_BOTTOM;
      this._snapCamera = true;
      this.shakeMag = 0; this.shakeX = 0; this.shakeY = 0;
      this.time = 0;
      this._gen = 0;                // bumps when the cell size changes (sprite caches)
      this._bg = null;
      this._fx = null;
      this._info = new WeakMap();   // block -> { sig, gen, sprites, geom, animated }
      this._entries = [];           // pooled static index entries
      this._sorted = [];
      this._staticCount = 0;
      this._indexPhysics = null;
      this._indexVersion = -1;
      this._anim = [];
      this._vanish = [];
      this._vanishCount = 0;
      this._pieceSprites = new Map();
      this._paintUntil = 0;         // performance.now() deadline for painting sprites this frame
      this._lagging = 0;            // blocks drawn with a stand-in sprite this frame
      this._purgeN = 0;             // cell size whose leftovers to drop once nothing lags
      this._pc = null;
      this._fonts = new Map();
      this._labels = [];
      this._ms = { m: NaN, full: null, text: '', w: 0, px: 0 };
      this._tmp = { x: 0, y: 0 };
      this.view = { ox: 0, oy: 0, ppu: 1, dpr: 1, w: 1, h: 1, left: 0, right: 0, bottom: 0, top: 0 };
      this.stats = { drawn: 0, cells: 0, statics: 0, movers: 0, sprites: 0, spriteBytes: 0 };
    }

    setOptions(o) { if (o) Object.assign(this.options, o); }

    setGame(game) {
      for (const off of this._unsubs) { try { off(); } catch (err) { /* ignore */ } }
      this._unsubs.length = 0;
      this.game = game || null;
      this.particles.clear();
      for (const r of this._vanish) { r.active = false; r.block = null; }
      this._vanishCount = 0;
      this.shakeMag = 0; this.shakeX = 0; this.shakeY = 0;
      this._indexPhysics = null;
      this._indexVersion = -1;
      this._staticCount = 0;
      this._snapCamera = true;
      if (!game) return;
      const on = (name, fn) => {
        if (typeof game.on !== 'function') return;
        const bound = fn.bind(this);
        const off = game.on(name, bound);
        this._unsubs.push(typeof off === 'function' ? off : () => { if (typeof game.off === 'function') game.off(name, bound); });
      };
      on('land', this._onLand);
      on('explode', this._onExplode);
      on('shatter', this._onShatter);
      on('swallow', this._onSwallow);
      on('melt', this._onMelt);
      on('freeze', this._onFreeze);
      on('weld', this._onWeld);
      on('fuse', this._onFuse);
      on('mineArmed', this._onMineArmed);
      on('lifeLost', this._onLifeLost);
      on('lifeGained', this._onLifeGained);
      on('shieldUsed', this._onShieldUsed);
      on('shield', this._onShield);
      on('milestone', this._onMilestone);
      on('blockLost', this._onBlockLost);
      on('magnet', this._onMagnet);
      on('pop', this._onPop);
      if (this.N && typeof game.setPixelSize === 'function') game.setPixelSize(1 / this.scale);
    }

    resize(cssW, cssH, dpr) {
      const d = clamp(+dpr || (typeof window !== 'undefined' && window.devicePixelRatio) || 1, 0.5, C.MAX_DPR);
      const w = Math.max(1, +cssW || 1), h = Math.max(1, +cssH || 1);
      const pxW = Math.max(1, Math.round(w * d)), pxH = Math.max(1, Math.round(h * d));
      const pixelSize = () => { if (this.game && typeof this.game.setPixelSize === 'function') this.game.setPixelSize(1 / this.scale); };
      // Unchanged size (callers may resize on every layout event): keep every cache
      if (this._bg && pxW === this.pxW && pxH === this.pxH && d === this.dpr &&
        this.canvas.width === pxW && this.canvas.height === pxH) {
        this.cssW = w; this.cssH = h;
        pixelSize();
        return;
      }
      if (this.canvas.width !== pxW) this.canvas.width = pxW;
      if (this.canvas.height !== pxH) this.canvas.height = pxH;
      const first = !this.N;
      this.cssW = w; this.cssH = h; this.dpr = d; this.pxW = pxW; this.pxH = pxH;
      const N = Math.max(6, Math.floor(Math.min(pxW / C.VIEW_CELLS_WIDE, pxH / C.VIEW_MIN_ROWS)));
      if (N !== this.N) {
        this.N = N;
        this._gen++;
        this._fx = null;
        this._pieceSprites.clear();
        this._pc = null;
        this._purgeN = N;   // old-size sprites stand in (scaled) until the new ones are painted
      }
      this.scale = N / d;
      this._fieldX = Math.round((pxW - C.FIELD_WIDTH * N) / 2);
      this._buildBackground();
      if (first) this._snapCamera = true;
      pixelSize();
    }

    _autoSize() {
      const c = this.canvas;
      const laidOut = c.clientWidth > 0 && c.clientHeight > 0;
      const dpr = laidOut ? ((typeof window !== 'undefined' && window.devicePixelRatio) || 1) : 1;
      this.resize(laidOut ? c.clientWidth : c.width, laidOut ? c.clientHeight : c.height, dpr);
    }

    _buildBackground() {
      const ctx = this.ctx, N = this.N, W = this.pxW, H = this.pxH, dpr = this.dpr;
      const bg = {};
      // Sky, stars, mountains and clouds are composed into one opaque canvas that is repainted
      // only when the camera moves, so a still frame pays a single blit for the whole backdrop.
      bg.cache = makeCanvas(W, H);
      bg.cacheCtx = bg.cache.getContext('2d', { alpha: false });
      bg.cacheCam = NaN;
      const g = bg.cacheCtx;
      bg.sky = g.createLinearGradient(0, 0, 0, 1);
      for (const [alt, col] of SKY) bg.sky.addColorStop((alt - SKY_ALT0) / (SKY_ALT1 - SKY_ALT0), col);
      bg.starTile = Math.max(64, Math.round(STAR_TILE * dpr));
      bg.starsA = g.createPattern(starTile(bg.starTile, 46, dpr, 11, true), 'repeat');
      bg.starsB = g.createPattern(starTile(bg.starTile, 110, dpr, 23, false), 'repeat');
      const mh = Math.round(clamp(H * 0.34, 4 * N, 10 * N));
      bg.mountFar = mountainLayer(W, mh, N, 101, '#29355f', '#2c3a6a', 1);
      bg.mountNear = mountainLayer(W, Math.round(mh * 0.62), N, 202, '#18203d', '#222c52', 0.9);
      bg.clouds = [
        { img: cloudSprite(6, 1.6, N, 1), x: 0.12, alt: 7, alpha: 0.75 },
        { img: cloudSprite(4.5, 1.3, N, 2), x: 0.78, alt: 15, alpha: 0.6 },
        { img: cloudSprite(7, 1.8, N, 3), x: 0.3, alt: 24, alpha: 0.55 },
        { img: cloudSprite(5, 1.4, N, 4), x: 0.9, alt: 33, alpha: 0.5 }
      ];
      bg.fog = ctx.createLinearGradient(0, 0, 0, 1);
      bg.fog.addColorStop(0, rgba(FOG, 0));
      bg.fog.addColorStop(0.5, rgba(FOG, 0.62));
      bg.fog.addColorStop(1, rgba(FOG, 0.95));
      bg.fogSolid = rgba(FOG, 0.95);
      bg.platform = platformSprite(N, C.PLATFORM_X1 - C.PLATFORM_X0, C.PLATFORM_DEPTH);
      bg.dashMilestone = [Math.round(7 * dpr), Math.round(5 * dpr)];
      bg.dashVoid = [Math.round(5 * dpr), Math.round(4 * dpr)];
      this._bg = bg;
    }

    _fxSprites() {
      if (this._fx) return this._fx;
      const N = this.N;
      this._fx = {
        glowArmed: glowSprite(N * 0.85, '#ffe8a0', '#ff4a24'),
        vortex: vortexSprite(N),
        glowField: glowSprite(N * 0.8, '#eef1ff', '#5566ff'),
        glowPole: glowSprite(N * 2.2, '#c9d1ff', '#3d4fe0'),
        dashField: [Math.max(2, Math.round(N * 0.2)), Math.max(2, Math.round(N * 0.17))],
        digits: []
      };
      return this._fx;
    }

    _digit(d) {
      const fx = this._fxSprites();
      return fx.digits[d] || (fx.digits[d] = digitSprite(this.N, d));
    }

    _font(px, weight) {
      const key = px * 1000 + weight;
      let f = this._fonts.get(key);
      if (!f) { f = weight + ' ' + px + 'px ' + FONT_FAMILY; this._fonts.set(key, f); }
      return f;
    }

    // ---- Frame ----------------------------------------------------------------------------
    render(dt) {
      if (!this.N) this._autoSize();
      const ctx = this.ctx, game = this.game;
      spriteClock++;
      this._paintUntil = performance.now() + SPRITE_PAINT_MS;
      this._lagging = 0;
      dt = dt > 0 ? Math.min(dt, 0.1) : 0;
      const fxDt = game && game.state === 'paused' ? 0 : dt;
      this.time += fxDt;
      const P = game && game.physics ? game.physics : null;
      if (P) this._syncIndex(P);
      this._updateCamera(dt);
      this._updateShake(fxDt);
      this.particles.update(fxDt);
      this._updateVanish(fxDt);

      const N = this.N, W = this.pxW, H = this.pxH, v = this.view;
      v.ox = Math.round(this._fieldX + this.shakeX * this.dpr);
      v.oy = Math.round(H + this.camBottom * N + this.shakeY * this.dpr);
      v.ppu = N; v.dpr = this.dpr; v.w = W; v.h = H;
      v.left = -v.ox / N; v.right = (W - v.ox) / N;
      v.top = v.oy / N; v.bottom = (v.oy - H) / N;
      this.stats.drawn = 0; this.stats.cells = 0;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      this._drawBackground(ctx);
      if (game) this._drawMilestoneLine(ctx, v, game);
      this._drawPlatform(ctx, v, P);
      if (P) {
        this._drawBlocks(ctx, v, P);
        this._drawAnimated(ctx, v);
      }
      this._drawVanish(ctx, v);
      this._drawFog(ctx, v);
      if (game) this._drawPieceAndGhost(ctx, v, game);
      this.particles.draw(ctx, v);
      this._drawRuler(ctx, v, game);
      if (game) this._drawMilestoneLabel(ctx, v, game);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      if (this._purgeN && !this._lagging) {
        trimSprites(this._purgeN);
        this._purgeN = 0;
      }
      this.stats.sprites = sprites.size;
      this.stats.spriteBytes = spriteBytes;
    }

    isAnimating() {
      return this.particles.count > 0 || this.shakeMag > 0 || this._vanishCount > 0 ||
        Math.abs(this.camBottom - this.camTarget) * this.N > 0.5;
    }

    // CSS px relative to the canvas <-> world units (shake excluded)
    screenToWorld(px, py, out) {
      const o = out || {};
      o.x = (px * this.dpr - this._fieldX) / this.N;
      o.y = this.camBottom + (this.pxH - py * this.dpr) / this.N;
      return o;
    }

    worldToScreen(x, y, out) {
      const o = out || {};
      o.x = (this._fieldX + x * this.N) / this.dpr;
      o.y = (this.pxH - (y - this.camBottom) * this.N) / this.dpr;
      return o;
    }

    shake(px) {
      if (this.options.reducedMotion) return;
      this.shakeMag = Math.min(SHAKE_MAX, Math.max(this.shakeMag, px));
    }

    destroy() { this.setGame(null); }

    _updateCamera(dt) {
      const game = this.game;
      const rows = this.pxH / this.N;
      let top = rows + CAMERA_MIN_BOTTOM;
      if (game) {
        const piece = game.piece;
        let y = game.hoverY;
        if (!Number.isFinite(y)) y = piece && Number.isFinite(piece.y) ? piece.y : (+game.towerTop || 0) + C.DROP_GAP;
        // room for the tallest unplaced piece of the batch, so switching blocks never moves the camera
        let h = piece && piece.shape ? piece.shape.h : 2;
        const batch = game.batch;
        if (batch) {
          for (let i = 0; i < batch.length; i++) {
            const slot = batch[i], shape = slot && !slot.used && slot.spec ? TT.SHAPES[slot.spec.shapeId] : null;
            if (shape && shape.h > h) h = shape.h;
          }
        }
        top = y + h + CAMERA_HEADROOM;
      }
      this.camTarget = Math.max(CAMERA_MIN_BOTTOM, top - rows);
      if (this._snapCamera) { this.camBottom = this.camTarget; this._snapCamera = false; }
      else this.camBottom = damp(this.camBottom, this.camTarget, C.CAMERA_LERP, dt);
      if (Math.abs(this.camBottom - this.camTarget) * this.N < 0.25) this.camBottom = this.camTarget;
    }

    _updateShake(dt) {
      if (this.options.reducedMotion) this.shakeMag = 0;
      if (this.shakeMag <= 0) { this.shakeX = 0; this.shakeY = 0; return; }
      if (!(dt > 0)) return;
      this.shakeMag *= Math.exp(-SHAKE_DECAY * dt);
      if (this.shakeMag < 0.3) { this.shakeMag = 0; this.shakeX = 0; this.shakeY = 0; return; }
      const t = this.time;
      this.shakeX = this.shakeMag * (Math.sin(t * 61.3) * 0.6 + Math.sin(t * 23.7 + 1.7) * 0.4);
      this.shakeY = this.shakeMag * (Math.sin(t * 47.9 + 0.5) * 0.6 + Math.sin(t * 31.1 + 2.3) * 0.4);
    }

    // ---- Background -----------------------------------------------------------------------
    // The backdrop is not shaken; only the world layer is
    _drawBackground(ctx) {
      const bg = this._bg;
      if (!(Math.abs(this.camBottom - bg.cacheCam) * this.N < 0.5)) {
        this._paintBackground(bg.cacheCtx, this.camBottom);
        bg.cacheCam = this.camBottom;
      }
      ctx.drawImage(bg.cache, 0, 0);
    }

    _paintBackground(g, cam) {
      const bg = this._bg, N = this.N, W = this.pxW, H = this.pxH;
      const oy = H + cam * N, rows = H / N, mid = cam + rows / 2;
      // The sky gradient lives in altitude space; map the visible altitudes onto the screen
      const span = SKY_ALT1 - SKY_ALT0;
      const uTop = (cam + rows - SKY_ALT0) / span, uBot = (cam - SKY_ALT0) / span;
      g.setTransform(W, 0, 0, -span * N, 0, oy - SKY_ALT0 * N);
      g.fillStyle = bg.sky;
      g.fillRect(0, uBot - 0.01, 1, uTop - uBot + 0.02);
      g.setTransform(1, 0, 0, 1, 0, 0);

      const sa = smoothstep(STARS_A[0], STARS_A[1], mid), sb = smoothstep(STARS_B[0], STARS_B[1], mid);
      if (sa > 0.01) this._paintStars(g, bg.starsA, sa, 0.12, cam);
      if (sb > 0.01) this._paintStars(g, bg.starsB, sb * 0.85, 0.06, cam);

      const lift = cam - CAMERA_MIN_BOTTOM;
      const ma = 1 - smoothstep(MOUNTAINS_FADE[0], MOUNTAINS_FADE[1], mid);
      if (ma > 0.01) {
        g.globalAlpha = ma;
        const yb = H + lift * N * 0.3;
        if (yb - bg.mountFar.height < H) g.drawImage(bg.mountFar, 0, Math.round(yb - bg.mountFar.height));
      }
      const ca = 1 - smoothstep(CLOUDS_FADE[0], CLOUDS_FADE[1], mid);
      if (ca > 0.01) {
        for (let i = 0; i < bg.clouds.length; i++) {
          const c = bg.clouds[i], img = c.img;
          const y = oy - (c.alt + lift * (1 - CLOUD_PARALLAX)) * N - img.height / 2;
          if (y > H || y + img.height < 0) continue;
          g.globalAlpha = ca * c.alpha;
          g.drawImage(img, Math.round(c.x * W - img.width / 2), Math.round(y));
        }
      }
      if (ma > 0.01) {
        g.globalAlpha = ma;
        const yb = H + lift * N * 0.55;
        if (yb - bg.mountNear.height < H) g.drawImage(bg.mountNear, 0, Math.round(yb - bg.mountNear.height));
      }
      g.globalAlpha = 1;
    }

    _paintStars(g, pattern, alpha, parallax, cam) {
      const T = this._bg.starTile;
      const off = (((cam * this.N * parallax) % T) + T) % T;
      g.globalAlpha = alpha;
      g.fillStyle = pattern;
      g.setTransform(1, 0, 0, 1, 0, off);
      g.fillRect(0, -off, this.pxW, this.pxH);
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1;
    }

    _drawPlatform(ctx, v, P) {
      const pf = P && P.platform;
      const x0 = pf ? pf.x0 : C.PLATFORM_X0, top = pf ? pf.top : C.PLATFORM_TOP;
      const img = this._bg.platform;
      const X = Math.round(v.ox + x0 * this.N), Y = Math.round(v.oy - top * this.N);
      if (Y >= v.h || Y + img.height <= 0) return;
      ctx.drawImage(img, X, Y);
    }

    _drawFog(ctx, v) {
      const N = this.N;
      const y0 = v.oy - FOG_TOP * N, y1 = v.oy - FOG_BOTTOM * N;
      if (y0 >= v.h) return;
      ctx.setTransform(v.w, 0, 0, y1 - y0, 0, y0);
      ctx.fillStyle = this._bg.fog;
      ctx.fillRect(0, 0, 1, 1);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (y1 < v.h) {
        ctx.fillStyle = this._bg.fogSolid;
        ctx.fillRect(0, Math.floor(y1), v.w, v.h - Math.floor(y1));
      }
    }

    // ---- Blocks ---------------------------------------------------------------------------
    _syncIndex(P) {
      if (this._indexPhysics === P && this._indexVersion === P.version) return;
      this._indexPhysics = P;
      this._indexVersion = P.version;
      const entries = this._entries, sorted = this._sorted;
      let n = 0;
      for (const b of P.blocks) {
        if (b.dead || !b.body.isStatic()) continue;
        const e = entries[n] || (entries[n] = { b: null, minX: 0, maxX: 0, minY: 0, maxY: 0 });
        const q = P.cellQuads(b);
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < q.length; i++) {
          const c = q[i];
          if (c.minX < minX) minX = c.minX;
          if (c.maxX > maxX) maxX = c.maxX;
          if (c.minY < minY) minY = c.minY;
          if (c.maxY > maxY) maxY = c.maxY;
        }
        e.b = b; e.minX = minX; e.maxX = maxX; e.minY = minY;
        e.maxY = b.typeKey === 'spikes' ? maxY + SPIKE_H : maxY;
        sorted[n] = e;
        n++;
      }
      for (let i = n; i < entries.length && entries[i].b; i++) entries[i].b = null;
      sorted.length = n;
      sorted.sort(byMinY);
      this._staticCount = n;
      this.stats.statics = n;
    }

    // Per-block render state; the piece sprite is refetched only when the block's look state
    // (overlay, flags), the cell size or the cached sprite itself (LRU eviction) changes. Once
    // this frame's paint budget is spent, a block that still has its previous sprite keeps it
    // (drawn scaled after a resize) and tries again next frame: no hitch when many change at once.
    _blockInfo(b) {
      let info = this._info.get(b);
      const fx = b.fx, key = b.typeKey;
      const overlay = b.frozen === 'petrified' ? 2 : (b.frozen === 'frost' && b.look !== 'frost') ? 1 : 0;
      const flags = fx ? (key === 'crystal' && fx.used ? 1 : 0) | (key === 'magma' && fx.turnsLeft != null ? 2 : 0) |
        (key === 'glass' && fx.armed ? 4 : 0) | (key === 'spikes' && fx.active ? 8 : 0) : 0;
      const sig = overlay | (flags << 2);
      if (info && info.sig === sig && info.gen === this._gen && info.sprite.canvas) return info;
      if (!info) {
        info = { sig: -1, gen: -1, sprite: null, geom: null, animated: false, reach: 0, weld: null, squash: 0, squashAt: 0 };
        this._info.set(b, info);
      }
      const look = ART[b.look] ? b.look : ART[key] ? key : 'normal';
      const cracked = !!b.cracked || key === 'rubble';
      const standIn = info.sprite && info.sprite.canvas ? info.sprite : null;
      const s = pieceSprite(this.N, b.shape, look, b.tint, cracked, tintVariant(look, b.n, b.id),
        texVariant(look, cracked, b.n, b.id), overlay, !cracked && look === key ? flags : 0,
        standIn !== null && performance.now() > this._paintUntil);
      if (!s) {
        this._lagging++;
        return info;
      }
      info.sprite = s;
      info.sig = sig;
      info.gen = this._gen;
      info.geom = shapeGeom(b.shape);
      info.animated = !!ANIMATED[key];
      info.reach = info.geom.radius + (key === 'spikes' ? SPIKE_H : 0);
      return info;
    }

    // A piece sprite with its local origin at (x, y); a stand-in of another cell size is scaled
    _blit(ctx, s, x, y) {
      s.used = spriteClock;
      if (s.N === this.N) ctx.drawImage(s.canvas, s.dx + x, s.dy + y);
      else {
        const k = this.N / s.N;
        ctx.drawImage(s.canvas, s.dx * k + x, s.dy * k + y, s.canvas.width * k, s.canvas.height * k);
      }
    }

    // Body transform in device px: local (x, -y) * N maps onto the screen
    _bodyTransform(ctx, v, b) {
      const body = b.body, p = body.getPosition();
      let a = body.getAngle();
      const X = v.ox + p.x * this.N, Y = v.oy - p.y * this.N;
      if (a > Math.PI || a < -Math.PI) a -= TAU * Math.round(a / TAU);
      if (a > -RENDER_SNAP_ANGLE && a < RENDER_SNAP_ANGLE) ctx.setTransform(1, 0, 0, 1, Math.round(X), Math.round(Y));
      else {
        const c = Math.cos(a), s = Math.sin(a);
        ctx.setTransform(c, -s, s, c, X, Y);
      }
    }

    // One blit per block: the whole piece (spikes included) is a single sprite
    _drawBlock(ctx, v, b, info) {
      this._bodyTransform(ctx, v, b);
      if (info.squash) this._squash(ctx, info);
      this._blit(ctx, info.sprite, 0, 0);
      if (info.animated) this._anim.push(b);
      this.stats.drawn++;
      this.stats.cells += b.cells.length;
    }

    // Rubber landing wobble: squash and stretch about the block's bottom, decaying quickly
    _squash(ctx, info) {
      const k = this.time - info.squashAt;
      if (!(k >= 0 && k < SQUASH_TIME)) { info.squash = 0; return; }
      const s = info.squash * Math.exp(-k * 7) * Math.cos(k * 28);
      const sx = 1 + s * 0.6, sy = 1 - s;
      ctx.transform(sx, 0, 0, sy, info.geom.com.x * this.N * (1 - sx), 0);
    }

    _drawBlocks(ctx, v, P) {
      this._anim.length = 0;
      const L = v.left - CULL_MARGIN, R = v.right + CULL_MARGIN, B = v.bottom - CULL_MARGIN, T = v.top + CULL_MARGIN;
      const sorted = this._sorted, n = this._staticCount;
      // first static entry that could reach the view (bounds are at most MAX_EXTENT tall)
      let lo = 0, hi = n;
      const key = B - MAX_EXTENT;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid].minY < key) lo = mid + 1; else hi = mid;
      }
      for (let i = lo; i < n; i++) {
        const e = sorted[i];
        if (e.minY > T) break;
        if (e.maxY < B || e.maxX < L || e.minX > R || e.b.dead) continue;
        this._drawBlock(ctx, v, e.b, this._blockInfo(e.b));
      }
      const movers = P.movers;
      let m = 0;
      for (let i = 0; i < movers.length; i++) {
        const b = movers[i];
        if (b.dead) continue;
        const info = this._blockInfo(b);
        const g = info.geom, p = b.body.getPosition(), a = b.body.getAngle();
        const c = Math.cos(a), s = Math.sin(a);
        const cx = p.x + c * g.com.x - s * g.com.y, cy = p.y + s * g.com.x + c * g.com.y, r = info.reach;
        if (cx + r < L || cx - r > R || cy + r < B || cy - r > T) continue;
        this._drawBlock(ctx, v, b, info);
        m++;
      }
      this.stats.movers = m;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    _drawAnimated(ctx, v) {
      const list = this._anim;
      if (!list.length) return;
      const fx = this._fxSprites();
      const now = this.game ? +this.game.time || 0 : 0;
      for (let i = 0; i < list.length; i++) {
        const b = list[i], f = b.fx;
        if (!f || b.dead) continue;
        switch (b.typeKey) {
          case 'blackhole': if (f.active && f.horizonCells && f.horizonCells.length) this._drawHorizon(ctx, v, b, f.horizonCells, fx); break;
          case 'vine': if (f.welds && f.welds.length) this._drawWelds(ctx, v, b, f.welds); break;
          case 'magma': if (f.turnsLeft != null) this._drawMagma(ctx, v, b, f.turnsLeft); break;
          case 'mine': if (f.armed || f.lit) this._drawMineLights(ctx, v, b, !!f.lit, fx); break;
          case 'magnet': if (f.pullUntil > now) this._drawMagnetPull(ctx, v, b, f, f.pullUntil - now, fx); break;
        }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    _drawHorizon(ctx, v, b, cells, fx) {
      const N = this.N, img = fx.vortex;
      const pulse = 0.93 + 0.07 * Math.sin(this.time * 3.3 + b.id);
      const s = N * 0.98 * pulse;
      for (let i = 0; i < cells.length; i++) {
        const hc = cells[i];
        if (!hc) continue;
        this._bodyTransform(ctx, v, b);
        const x = (hc[0] + 0.5) * N, y = -(hc[1] + 0.5) * N;
        ctx.globalAlpha = 1;
        ctx.fillStyle = 'rgba(255,40,30,0.12)';
        ctx.fillRect(x - N * 0.45, y - N * 0.45, N * 0.9, N * 0.9);
        ctx.translate(x, y);
        ctx.rotate(-this.time * 2.4 - i * 1.3);
        ctx.globalAlpha = 0.95;
        ctx.drawImage(img, -s / 2, -s / 2, s, s);
      }
      ctx.globalAlpha = 1;
    }

    // Welds are baked per vine (re-baked when one is dropped) and blitted with the vine
    _drawWelds(ctx, v, b, welds) {
      const info = this._info.get(b);
      if (!info) return;
      let w = info.weld;
      if (!w || w.n !== welds.length || w.gen !== this._gen) {
        w = info.weld = paintWelds(this.N, b.shape, welds);
        w.gen = this._gen;
      }
      this._bodyTransform(ctx, v, b);
      ctx.drawImage(w.canvas, -w.pad, -w.Y0);
    }

    _drawMagma(ctx, v, b, turnsLeft) {
      const info = this._info.get(b);
      const cell = b.cells[info ? info.geom.centre : 0];
      const N = this.N, d = clamp(Math.round(turnsLeft), 0, 9);
      this._bodyTransform(ctx, v, b);
      const x = (cell[0] + 0.5) * N, y = -(cell[1] + 0.5) * N;
      if (d <= 1) {
        // about to melt: the whole piece pulses, inside its outline
        const m = glowMask(N, b.shape, 'magma');
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.4 + 0.35 * Math.sin(this.time * 7);
        ctx.drawImage(m, 0, -m.height);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
      }
      ctx.drawImage(this._digit(d), x - N / 2, y - N / 2);
    }

    // Magnet pull (MAGNET_TIME s after it settles): the magnet and every pulled block glow
    // indigo, linked by flowing field arcs. Pulled blocks are dynamic, so only movers are
    // searched, and only while a pull is running.
    _drawMagnetPull(ctx, v, b, f, left, fx) {
      const N = this.N, P = this.game.physics, t = this.time;
      const fade = clamp(left / 0.16, 0, 1) * clamp((MAGNET_TIME - left) / 0.08 + 0.3, 0, 1);
      if (!(fade > 0)) return;
      const body = b.body, p = body.getPosition(), a = body.getAngle(), com = b.shape.com;
      const c = Math.cos(a), s = Math.sin(a);
      const MX = v.ox + (p.x + c * com.x - s * com.y) * N, MY = v.oy - (p.y + s * com.x + c * com.y) * N;
      const pulse = 0.75 + 0.25 * Math.sin(t * 18);
      ctx.globalCompositeOperation = 'lighter';
      const pole = fx.glowPole, ps = pole.width;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = fade * 0.55 * pulse;
      ctx.drawImage(pole, MX - ps / 2, MY - ps / 2);
      this._glowOutline(ctx, v, b, fade * 0.8 * pulse);
      const ids = f.targets, movers = P.movers;
      if (!ids || !ids.length) { ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; return; }
      const dash = fx.dashField, period = dash[0] + dash[1], glow = fx.glowField, gs = glow.width;
      for (let k = 0; k < movers.length; k++) {
        const o = movers[k];
        if (o === b || o.dead || ids.indexOf(o.id) < 0) continue;
        this._glowOutline(ctx, v, o, fade * (0.6 + 0.3 * Math.sin(t * 16 + k)));
        const op = o.body.getPosition(), oa = o.body.getAngle(), oc = Math.cos(oa), os = Math.sin(oa), ocom = o.shape.com;
        const TX = v.ox + (op.x + oc * ocom.x - os * ocom.y) * N, TY = v.oy - (op.y + os * ocom.x + oc * ocom.y) * N;
        const dx = TX - MX, dy = TY - MY;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        for (let side = -1; side <= 1; side += 2) {
          const bend = side * (0.26 + 0.07 * Math.sin(t * 7 + k * 1.7));
          const qx = (MX + TX) / 2 - dy * bend, qy = (MY + TY) / 2 + dx * bend;
          ctx.beginPath();
          ctx.moveTo(TX, TY);
          ctx.quadraticCurveTo(qx, qy, MX, MY);
          ctx.globalAlpha = fade * 0.4;
          ctx.strokeStyle = '#4d5fff';
          ctx.lineWidth = Math.max(2, N * 0.14);
          ctx.stroke();
          ctx.setLineDash(dash);
          ctx.lineDashOffset = -((t * N * 3) % period);
          ctx.globalAlpha = fade * 0.95;
          ctx.strokeStyle = '#dfe4ff';
          ctx.lineWidth = Math.max(1, N * 0.05);
          ctx.stroke();
          ctx.setLineDash(NO_DASH);
          // a bead of light running from the block to the magnet
          const u = (t * 1.7 + k * 0.37 + (side > 0 ? 0.5 : 0)) % 1, w = 1 - u;
          const bx = w * w * TX + 2 * w * u * qx + u * u * MX, by = w * w * TY + 2 * w * u * qy + u * u * MY;
          ctx.globalAlpha = fade * Math.sin(Math.PI * u);
          ctx.drawImage(glow, bx - gs / 2, by - gs / 2);
        }
      }
      ctx.lineDashOffset = 0;
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }

    // Additive indigo outline round a block (caller sets the composite mode)
    _glowOutline(ctx, v, b, alpha) {
      const N = this.N, geom = shapeGeom(b.shape);
      this._bodyTransform(ctx, v, b);
      traceOutline(ctx, geom, 0, 0, N);
      ctx.lineJoin = 'round';
      ctx.globalAlpha = alpha * 0.6;
      ctx.strokeStyle = '#5566ff';
      ctx.lineWidth = Math.max(2, N * 0.16);
      ctx.stroke();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = '#c9d1ff';
      ctx.lineWidth = Math.max(1, N * 0.05);
      ctx.stroke();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    // The mine's light blinks on its icon (the centre cell); once lit the whole piece flashes,
    // inside its outline
    _drawMineLights(ctx, v, b, lit, fx) {
      const N = this.N, info = this._info.get(b);
      const cell = b.cells[info ? info.geom.centre : 0];
      let k;
      if (lit) k = Math.sin(this.time * TAU * 8) > 0 ? 1 : 0.3;
      else {
        const ph = ((this.time + b.id * 0.37) % 1.4) / 1.4;
        k = ph < 0.14 ? 1 : ph < 0.42 ? 1 - ((ph - 0.14) / 0.28) * 0.85 : 0.15;
      }
      this._bodyTransform(ctx, v, b);
      ctx.globalCompositeOperation = 'lighter';
      if (lit) {
        const m = glowMask(N, b.shape, 'lit');
        ctx.globalAlpha = k * 0.9;
        ctx.drawImage(m, 0, -m.height);
      }
      const img = fx.glowArmed, s = img.width;
      ctx.globalAlpha = k;
      ctx.drawImage(img, (cell[0] + 0.5) * N - s / 2, -(cell[1] + 0.5) * N - s / 2);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }

    // ---- Vanishing blocks (swallowed / melted / lost keep fading for a moment) -----------
    _addVanish(b, kind, tx, ty) {
      if (!b || !b.body || !b.cells || !b.shape) return;
      let rec = null;
      for (const r of this._vanish) if (!r.active) { rec = r; break; }
      if (!rec) {
        if (this._vanish.length >= VANISH_MAX) return;
        rec = {};
        this._vanish.push(rec);
      }
      const body = b.body, p = body.getPosition(), a = body.getAngle(), lv = body.getLinearVelocity();
      const com = b.shape.com, c = Math.cos(a), s = Math.sin(a);
      rec.active = true;
      rec.kind = kind;
      rec.t = 0;
      rec.dur = kind === 'swallow' ? 0.5 : kind === 'melt' ? 0.75 : kind === 'pop' ? 0.14 : 0.4;
      rec.cx = rec.sx = p.x + c * com.x - s * com.y;
      rec.cy = rec.sy = p.y + s * com.x + c * com.y;
      rec.tx = tx != null ? tx : rec.cx;
      rec.ty = ty != null ? ty : rec.cy;
      rec.a = a;
      rec.vx = lv.x; rec.vy = lv.y;
      rec.block = b;
      this._vanishCount++;
    }

    _updateVanish(dt) {
      if (!this._vanishCount || !(dt > 0)) return;
      for (const r of this._vanish) {
        if (!r.active) continue;
        r.t += dt;
        if (r.t >= r.dur) {
          r.active = false; r.block = null;
          this._vanishCount--;
          continue;
        }
        if (r.kind === 'lost') {
          r.vy -= C.GRAVITY * dt;
          r.cx += r.vx * dt; r.cy += r.vy * dt;
        }
      }
    }

    _drawVanish(ctx, v) {
      if (!this._vanishCount) return;
      const N = this.N;
      for (const r of this._vanish) {
        if (!r.active) continue;
        const k = r.t / r.dur;
        let x = r.cx, y = r.cy, a = r.a, sc = 1, alpha = 1 - k;
        if (r.kind === 'swallow') {
          const e = k * k;
          x = r.sx + (r.tx - r.sx) * e; y = r.sy + (r.ty - r.sy) * e;
          a += e * 5; sc = 1 - e * 0.95; alpha = 1 - e * 0.5;
        } else if (r.kind === 'melt') {
          y -= 0.45 * k; sc = 1 - 0.18 * k;
        } else if (r.kind === 'pop') {
          sc = 1 + 0.35 * k; alpha = (1 - k) * (1 - k);
        }
        const c = Math.cos(a) * sc, s = Math.sin(a) * sc;
        ctx.setTransform(c, -s, s, c, v.ox + x * N, v.oy - y * N);
        const b = r.block, com = b.shape.com, spr = this._blockInfo(b).sprite;
        for (let pass = 0; pass < (r.kind === 'melt' ? 2 : 1); pass++) {
          ctx.globalAlpha = pass ? alpha * k * 0.8 : alpha;
          if (pass) ctx.globalCompositeOperation = 'lighter';
          this._blit(ctx, spr, -com.x * N, com.y * N);
          ctx.globalCompositeOperation = 'source-over';
        }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
    }

    // ---- Hovering piece & ghost -----------------------------------------------------------
    // n: the piece's generator index, so it looks exactly like the block it becomes
    _pieceSprite(typeKey, shape, n) {
      const pc = this._pc, v = n >= 0 ? n % (TINT_VARIANTS * TEX_VARIANTS) : 0;
      if (pc && pc.typeKey === typeKey && pc.shape === shape && pc.v === v && pc.gen === this._gen) return pc;
      const key = typeKey + '|' + shape.id + '|' + v;
      let ps = this._pieceSprites.get(key);
      if (!ps || ps.gen !== this._gen) {
        ps = buildPieceSprite(this.N, typeKey, shape, v);
        ps.gen = this._gen;
        if (this._pieceSprites.size > 16) this._pieceSprites.clear();
        this._pieceSprites.set(key, ps);
      }
      this._pc = ps;
      return ps;
    }

    _drawPieceAndGhost(ctx, v, game) {
      const piece = game.piece;
      if (!piece || game.state === 'over') return;
      const spec = piece.spec || EMPTY;
      const typeKey = spec.typeKey || (piece.type && piece.type.key) || 'normal';
      const shape = piece.shape || TT.SHAPES[spec.shapeId];
      if (!shape) return;
      const N = this.N;
      const px = +piece.x || 0;
      const py = Number.isFinite(game.hoverY) ? game.hoverY : (+piece.y || 0);
      const o = this.options;
      if (game.ghost && o.showGhost !== false && o.ghost !== false && o.ghostPreview !== false) {
        this._drawGhost(ctx, v, game.ghost, shape, typeKey, px, py);
      }
      const ps = this._pieceSprite(typeKey, shape, spec.n);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = game.canDrop === false ? 0.38 + 0.3 * clamp(+game.readyProgress || 0, 0, 1) : 1;
      ctx.drawImage(ps.canvas, Math.round(v.ox + px * N) - ps.pad, Math.round(v.oy - py * N) - ps.oy);
      ctx.globalAlpha = 1;
    }

    _drawGhost(ctx, v, g, shape, typeKey, px, py) {
      const N = this.N, dpr = this.dpr, geom = shapeGeom(shape);
      const warn = g.warnings || EMPTY;
      const isVoid = !!g.void || warn.indexOf('void') >= 0;
      const mine = warn.indexOf('mine') >= 0, horizon = warn.indexOf('horizon') >= 0;
      const spikes = warn.indexOf('spikes') >= 0, glass = warn.indexOf('glass') >= 0;
      const gx = Number.isFinite(g.x) ? g.x : px;
      const landed = !isVoid && Number.isFinite(g.y) && g.y < py && g.y + shape.h > v.bottom;
      const thin = Math.max(1, Math.round(dpr)), half = (thin % 2) / 2;
      ctx.setTransform(1, 0, 0, 1, 0, 0);

      // faint guide lines from the piece's outer edges down to the ghost (or the view bottom)
      const w1 = shape.w - 1;
      const topL = py + shape.bottom[0], topR = py + shape.bottom[w1];
      const endL = landed ? g.y + shape.top[0] : v.bottom, endR = landed ? g.y + shape.top[w1] : v.bottom;
      ctx.strokeStyle = isVoid ? 'rgba(255,96,86,0.25)' : 'rgba(255,255,255,0.14)';
      ctx.lineWidth = thin;
      ctx.beginPath();
      if (endL < topL) {
        ctx.moveTo(Math.round(v.ox + px * N) + half, v.oy - topL * N);
        ctx.lineTo(Math.round(v.ox + gx * N) + half, v.oy - endL * N);
      }
      if (endR < topR) {
        ctx.moveTo(Math.round(v.ox + (px + shape.w) * N) - half, v.oy - topR * N);
        ctx.lineTo(Math.round(v.ox + (gx + shape.w) * N) - half, v.oy - endR * N);
      }
      ctx.stroke();

      if (landed) {
        const X = Math.round(v.ox + gx * N), Y = Math.round(v.oy - g.y * N);
        const gc = ghostColors(typeKey, shape);
        let stroke = gc.stroke, fill = gc.fill, lw = Math.max(1, Math.round(1.5 * dpr));
        const heavy = Math.max(2, Math.round(2 * dpr));
        if (horizon) { stroke = '#ff3d2e'; fill = 'rgba(255,61,46,0.18)'; lw = heavy; }
        else if (spikes) { stroke = '#ff3b47'; fill = 'rgba(255,59,71,0.2)'; lw = heavy; }
        else if (mine) { stroke = '#ffa31a'; fill = 'rgba(255,163,26,0.18)'; lw = heavy; }
        else if (glass) { stroke = '#ff8fb1'; fill = 'rgba(255,143,177,0.18)'; lw = heavy; }
        ctx.lineJoin = 'round';
        if (spikes) this._drawGhostBroken(ctx, X, Y, shape, geom, fill, stroke, lw);
        else {
          traceOutline(ctx, geom, X, Y, N);
          ctx.fillStyle = fill;
          ctx.fill();
          ctx.strokeStyle = stroke;
          ctx.lineWidth = lw;
          ctx.stroke();
        }
        if (horizon) this._drawSwirlMark(ctx, X + geom.com.x * N, Y - geom.com.y * N, N);
        // one badge per hazard, in a row above the ghost
        const nb = (spikes ? 1 : 0) + (mine ? 1 : 0) + (glass ? 1 : 0);
        if (nb) {
          const step = N * 0.72, by = Y - shape.h * N - N * 0.42;
          let bx = X + shape.w * N / 2 - (nb - 1) * step / 2;
          if (spikes) { this._drawBadge(ctx, bx, by, N, 'spikes'); bx += step; }
          if (mine) { this._drawBadge(ctx, bx, by, N, 'mine'); bx += step; }
          if (glass) this._drawBadge(ctx, bx, by, N, 'glass');
        }
      }

      if (isVoid) {
        const cx = Math.round(v.ox + (px + shape.w / 2) * N) + half;
        const yEnd = v.h - N * 0.95;
        const y0 = v.oy - py * N;
        if (yEnd > y0) {
          ctx.setLineDash(this._bg.dashVoid);
          ctx.strokeStyle = 'rgba(255,72,62,0.9)';
          ctx.lineWidth = Math.max(1, Math.round(1.5 * dpr));
          ctx.beginPath(); ctx.moveTo(cx, y0 + N * 0.15); ctx.lineTo(cx, yEnd); ctx.stroke();
          ctx.setLineDash(NO_DASH);
        }
        const s = N * 0.3, yx = v.h - N * 0.55;
        ctx.strokeStyle = 'rgba(20,6,10,0.75)';
        ctx.lineWidth = Math.max(3, Math.round(4.5 * dpr));
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(cx - s, yx - s); ctx.lineTo(cx + s, yx + s); ctx.moveTo(cx + s, yx - s); ctx.lineTo(cx - s, yx + s);
        ctx.stroke();
        ctx.strokeStyle = '#ff483e';
        ctx.lineWidth = Math.max(2, Math.round(2.5 * dpr));
        ctx.stroke();
        ctx.lineCap = 'butt';
      }
    }

    // Ghost of a piece that would be destroyed (spikes): its cells drawn bursting apart
    _drawGhostBroken(ctx, X, Y, shape, geom, fill, stroke, lw) {
      const N = this.N, cells = shape.cells, com = geom.com, h = N * 0.42;
      ctx.lineWidth = lw;
      for (let i = 0; i < cells.length; i++) {
        const cx = cells[i][0] + 0.5, cy = cells[i][1] + 0.5;
        const ox = cx + (cx - com.x) * 0.2, oy = cy + (cy - com.y) * 0.2 + 0.05;
        const a = ((i * 7 + 3) % 5 - 2) * 0.1;
        const c = Math.cos(a), s = Math.sin(a);
        ctx.setTransform(c, s, -s, c, X + ox * N, Y - oy * N);
        ctx.fillStyle = fill;
        ctx.fillRect(-h, -h, h * 2, h * 2);
        ctx.strokeStyle = stroke;
        ctx.strokeRect(-h, -h, h * 2, h * 2);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    // Round hazard badge: mine '!', spikes (three teeth), glass (a crack)
    _drawBadge(ctx, x, y, N, kind) {
      const r = N * 0.3;
      ctx.fillStyle = kind === 'spikes' ? '#ff3b47' : kind === 'glass' ? '#ff8fb1' : '#ffa31a';
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
      ctx.strokeStyle = kind === 'mine' ? 'rgba(40,14,0,0.85)' : 'rgba(46,4,12,0.85)';
      ctx.lineWidth = Math.max(1, N * 0.045);
      ctx.stroke();
      const ink = kind === 'mine' ? '#2a1000' : '#2e030b';
      ctx.fillStyle = ink;
      if (kind === 'mine') {
        ctx.fillRect(x - r * 0.14, y - r * 0.62, r * 0.28, r * 0.78);
        ctx.beginPath(); ctx.arc(x, y + r * 0.44, r * 0.16, 0, TAU); ctx.fill();
      } else if (kind === 'spikes') {
        const w = r * 0.5, base = y + r * 0.46;
        ctx.beginPath();
        for (let k = -1; k <= 1; k++) {
          const cx = x + k * w;
          ctx.moveTo(cx - w * 0.5, base);
          ctx.lineTo(cx, y - r * (k ? 0.36 : 0.62));
          ctx.lineTo(cx + w * 0.5, base);
          ctx.closePath();
        }
        ctx.fill();
      } else {
        // the disc cracked right through: a jagged line rim to rim plus one branch
        ctx.save();
        ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.clip();
        ctx.strokeStyle = ink;
        ctx.lineWidth = Math.max(1.5, N * 0.055);
        ctx.lineJoin = 'miter';
        ctx.beginPath();
        ctx.moveTo(x + r * 0.12, y - r * 0.99);
        ctx.lineTo(x - r * 0.2, y - r * 0.42);
        ctx.lineTo(x + r * 0.22, y - r * 0.08);
        ctx.lineTo(x - r * 0.14, y + r * 0.36);
        ctx.lineTo(x + r * 0.06, y + r * 0.99);
        ctx.moveTo(x + r * 0.22, y - r * 0.08);
        ctx.lineTo(x + r * 0.62, y + r * 0.1);
        ctx.lineTo(x + r * 1.05, y - r * 0.05);
        ctx.stroke();
        ctx.restore();
      }
    }

    _drawSwirlMark(ctx, x, y, N) {
      const r = N * 0.42, rot = -this.time * 3;
      ctx.strokeStyle = '#ff3d2e';
      ctx.lineWidth = Math.max(1.5, N * 0.08);
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let j = 0; j <= 28; j++) {
        const t = j / 28, a = t * TAU * 1.6 + rot, rr = r * (0.12 + 0.88 * t);
        const X = x + Math.cos(a) * rr, Y = y + Math.sin(a) * rr;
        if (j) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
      }
      ctx.stroke();
      ctx.lineCap = 'butt';
    }

    // ---- Ruler & milestone ----------------------------------------------------------------
    _rulerX(v) { return Math.max(0, v.ox - this.N); }

    _drawRuler(ctx, v, game) {
      const N = this.N, dpr = this.dpr;
      const x0 = this._rulerX(v);
      const lo = Math.max(0, Math.ceil(v.bottom)), hi = Math.floor(v.top);
      const lw = Math.max(1, Math.round(dpr)), half = (lw % 2) / 2;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(206,218,255,0.34)';
      ctx.lineWidth = lw;
      ctx.beginPath();
      for (let m = lo; m <= hi; m++) {
        const y = Math.round(v.oy - m * N) + half;
        ctx.moveTo(x0, y);
        ctx.lineTo(x0 + (m % 5 === 0 ? N * 0.4 : N * 0.18), y);
      }
      ctx.stroke();
      const fpx = Math.round(clamp(this.scale * 0.44, 9, 13) * dpr);
      ctx.font = this._font(fpx, 600);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(214,224,255,0.62)';
      const best = game ? +game.bestHeight || 0 : -1;
      for (let m = Math.ceil(lo / 5) * 5; m <= hi; m += 5) {
        if (best > 0 && Math.abs(m - best) < 0.6) continue;
        const label = this._labels[m] || (this._labels[m] = String(m));
        ctx.fillText(label, x0 + N * 0.46, Math.round(v.oy - m * N) + dpr * 0.5);
      }
      if (!game) return;
      // best height: gold pennant; current height: small white notch
      const h = +game.height || 0;
      const tri = N * 0.3;
      if (h > 0 && Math.abs(h - best) > 0.15) {
        const y = v.oy - h * N;
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.beginPath(); ctx.moveTo(x0, y - tri * 0.4); ctx.lineTo(x0 + tri * 0.75, y); ctx.lineTo(x0, y + tri * 0.4); ctx.closePath(); ctx.fill();
      }
      if (best > 0) {
        const y = Math.round(v.oy - best * N);
        ctx.fillStyle = '#ffcf4a';
        ctx.fillRect(x0, y - lw, N * 0.62, lw * 2);
        ctx.beginPath(); ctx.moveTo(x0, y - tri * 0.55); ctx.lineTo(x0 + tri, y); ctx.lineTo(x0, y + tri * 0.55); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = 'rgba(40,24,0,0.6)';
        ctx.lineWidth = lw;
        ctx.stroke();
      }
    }

    _milestoneState(game) {
      const m = +game.nextMilestone;
      if (!(m > 0)) return null;
      const full = game.maxLives != null && game.lives >= game.maxLives;
      const ms = this._ms;
      if (ms.m !== m || ms.full !== full) {
        ms.m = m; ms.full = full;
        ms.text = full ? m + ' m' : '+1 life at ' + m + ' m';
        ms.w = 0;
      }
      return ms;
    }

    _drawMilestoneLine(ctx, v, game) {
      const ms = this._milestoneState(game);
      if (!ms) return;
      const N = this.N, dpr = this.dpr;
      const Y = Math.round(v.oy - ms.m * N);
      if (Y < -N || Y > v.h + N) return;
      const lw = Math.max(1, Math.round(1.5 * dpr)), half = (lw % 2) / 2;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.setLineDash(this._bg.dashMilestone);
      ctx.lineWidth = lw;
      ctx.strokeStyle = ms.full ? 'rgba(255,190,205,0.26)' : 'rgba(255,112,142,0.72)';
      ctx.beginPath();
      ctx.moveTo(this._rulerX(v) + N * 0.7, Y + half);
      ctx.lineTo(v.w, Y + half);
      ctx.stroke();
      ctx.setLineDash(NO_DASH);
    }

    _drawMilestoneLabel(ctx, v, game) {
      const ms = this._milestoneState(game);
      if (!ms) return;
      const N = this.N, dpr = this.dpr;
      const Y = Math.round(v.oy - ms.m * N);
      if (Y < -N || Y > v.h + N) return;
      const fpx = Math.round(clamp(this.scale * 0.5, 10, 14) * dpr);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.font = this._font(fpx, 700);
      if (!ms.w || ms.px !== fpx) { ms.w = ctx.measureText(ms.text).width; ms.px = fpx; }
      const heart = fpx * 1.05, gap = fpx * 0.35, padX = fpx * 0.5;
      const w = padX * 2 + heart + gap + ms.w, h = fpx * 1.6;
      const xr = Math.min(v.w - 4 * dpr, v.ox + C.FIELD_WIDTH * N);
      const x = xr - w, y = Y - h - 3 * dpr;
      ctx.globalAlpha = ms.full ? 0.55 : 1;
      ctx.fillStyle = 'rgba(12,14,34,0.62)';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, h / 2); else ctx.rect(x, y, w, h);
      ctx.fill();
      const hx = x + padX + heart / 2, hy = y + h / 2;
      TT.Particles.heartPath(ctx, hx, hy + heart * 0.04, heart);
      if (ms.full) {
        ctx.strokeStyle = '#ffb3c4';
        ctx.lineWidth = Math.max(1, dpr * 1.2);
        ctx.stroke();
      } else {
        ctx.fillStyle = '#ff5f7e';
        ctx.fill();
      }
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = ms.full ? '#e6e9f5' : '#ffe1e8';
      ctx.fillText(ms.text, hx + heart / 2 + gap, hy + dpr * 0.5);
      ctx.globalAlpha = 1;
    }

    // ---- Game events -> FX ----------------------------------------------------------------
    _visiblePos(x, y) {
      const v = this.view, o = this._tmp, m = 1.4;
      const game = this.game;
      const fx = Number.isFinite(x) ? x : C.FIELD_WIDTH / 2;
      const fy = Number.isFinite(y) ? y : (game && Number.isFinite(game.towerTop) ? game.towerTop + 1 : 2);
      o.x = clamp(fx, v.left + m, Math.max(v.left + m, v.right - m));
      o.y = clamp(fy, v.bottom + m, Math.max(v.bottom + m, v.top - m));
      return o;
    }

    _blockBox(b) {
      const P = this.game && this.game.physics;
      if (!P || !b || !b.body) return null;
      return P.bounds(b);
    }

    _recent(typeKey) {
      const P = this.game && this.game.physics;
      if (!P) return null;
      const list = P.blocks;
      for (let i = list.length - 1, n = 0; i >= 0 && n < 80; i--, n++) if (list[i].typeKey === typeKey) return list[i];
      return null;
    }

    _onLand(e) {
      const b = e && e.block, bb = this._blockBox(b);
      const impact = +e.impact || 0;
      if (!bb) return;
      if (b.typeKey === 'rubber' && impact > 2 && this.N && !this.options.reducedMotion) {
        const info = this._blockInfo(b);
        info.squash = clamp(impact / 9, 0.35, 1) * 0.17;
        info.squashAt = this.time;
      }
      if (impact < 1.2) return;
      this.particles.burst('dust', (bb.minX + bb.maxX) / 2, bb.minY, { impact, w: bb.maxX - bb.minX });
      if (b.typeKey === 'anvil') this.shake(Math.min(9, 2 + impact * 0.5));
    }

    _onExplode(e) {
      const R = +e.radius || C.MINE_RADIUS;
      this.particles.burst('explosion', e.x, e.y, { radius: R });
      this.particles.burst('smoke', e.x, e.y, { radius: R * 0.55, count: 12 });
      this.shake(7 + R * 2);
    }

    _onShatter(e) {
      let look = e.look || (e.block && e.block.look) || (e.cause === 'glass' ? 'glass' : null);
      let tint = e.tint || (e.block && e.block.tint) || null;
      const P = this.game && this.game.physics;
      if (!look && P && Number.isFinite(e.x)) {
        let best = null, bd = Infinity;
        for (const b of P.blocksInRadius(e.x, e.y, 2.2)) {
          if (b.typeKey !== 'rubble') continue;
          const p = b.body.getPosition(), d = (p.x - e.x) * (p.x - e.x) + (p.y - e.y) * (p.y - e.y);
          if (d < bd) { bd = d; best = b; }
        }
        if (best) { look = best.look; tint = best.tint; }
      }
      if (!look) look = e.cause === 'crumble' ? 'crumble' : 'normal';
      if (look === 'glass') {
        // translucent slivers that glint, no stone dust
        this.particles.burst('glass', e.x, e.y, { count: clamp((+e.count || 4) * 5, 12, 32), w: 1.6, h: 1 });
        if (e.cause === 'anvil') this.shake(5);
        return;
      }
      const pal = palette(ART[look] ? look : 'normal', tint, false);
      const n = clamp((+e.count || 4) * 3, 6, 30);
      this.particles.burst('shards', e.x, e.y, { count: n, w: 1.6, h: 1, colors: [hex(pal.base), hex(pal.light), hex(pal.dark)] });
      this.particles.burst('dust', e.x, e.y - 0.4, { impact: 6, w: 1.6, count: 6 });
      if (e.cause === 'anvil') this.shake(5);
    }

    _onSwallow(e) {
      const b = e.block;
      let x = e.x, y = e.y;
      const bb = this._blockBox(b);
      if (bb && !Number.isFinite(x)) { x = (bb.minX + bb.maxX) / 2; y = (bb.minY + bb.maxY) / 2; }
      const hole = e.hole && e.hole.body ? e.hole.body.getWorldCenter() : null;
      if (hole && Number.isFinite(x)) { x += (hole.x - x) * 0.35; y += (hole.y - y) * 0.35; }
      if (!Number.isFinite(x)) return;
      const pal = b ? palette(ART[b.look] ? b.look : 'normal', b.tint, !!b.cracked) : null;
      this.particles.burst('swirl', x, y, { radius: 1.5, count: 26, colors: pal ? [hex(pal.base), hex(pal.light), '#ff3d2e', '#5a0b14'] : undefined });
      if (b) this._addVanish(b, 'swallow', x, y);
    }

    _onMelt(e) {
      const b = e.block, bb = this._blockBox(b);
      if (bb) {
        const cx = (bb.minX + bb.maxX) / 2;
        this.particles.burst('drip', cx, bb.minY + 0.2, { w: bb.maxX - bb.minX, count: 3 + 2 * b.cells.length });
        this.particles.burst('smoke', cx, (bb.minY + bb.maxY) / 2, { radius: 0.9, count: 5, color: '#3a2c2a' });
        this._addVanish(b, 'melt');
      } else if (Number.isFinite(e.x)) {
        this.particles.burst('drip', e.x, e.y, { w: 1.5 });
      }
    }

    _onFreeze(e) {
      const list = e.blocks;
      if (!list) return;
      const colors = ['#ffffff', '#e8fbff', '#9fe2f5'];
      for (const b of list) {
        if (!b || !b.body) continue;
        const c = b.body.getWorldCenter();
        this.particles.burst('sparkle', c.x, c.y, { count: 6, w: 1.6, h: 1.6, colors });
      }
    }

    _onWeld(e) {
      const pts = e.points || EMPTY;
      for (const p of pts) this.particles.burst('leaf', p.x, p.y, { count: 2 });
      if (!pts.length && e.block && e.block.body) {
        const c = e.block.body.getWorldCenter();
        this.particles.burst('leaf', c.x, c.y, { count: 4 });
      }
    }

    _onFuse(e) {
      const b = e.block;
      const c = b && b.body ? b.body.getWorldCenter() : e;
      if (Number.isFinite(c.x)) this.particles.burst('sparkle', c.x, c.y, { count: 6, w: 1.2, h: 1, colors: ['#ffd166', '#ff7a2a'], speed: 2 });
    }

    _onMineArmed(e) {
      const b = e.block;
      if (!b || !b.body) return;
      const c = b.body.getWorldCenter();
      this.particles.burst('sparkle', c.x, c.y, { count: 3, w: 1, h: 0.8, colors: ['#ff6b5a'], size: 0.7 });
    }

    _onLifeLost(e) {
      const p = this._visiblePos(e.x, e.y);
      this.particles.burst('text', p.x, p.y, { text: '−', icon: 'heart', color: '#ff3d55', size: 28 });
      this.shake(6);
    }

    _onLifeGained(e) {
      let x = e.x, y = e.y;
      if (!Number.isFinite(x)) {
        if (e.reason === 'crystal') {
          const b = this._recent('crystal');
          if (b) { const c = b.body.getWorldCenter(); x = c.x; y = c.y + 1; }
        } else {
          x = C.FIELD_WIDTH / 2;
          y = (+(e.height || (this.game && this.game.bestHeight)) || 0) + 0.8;
        }
      }
      const p = this._visiblePos(x, y);
      this.particles.burst('text', p.x, p.y, { text: '+', icon: 'heart', color: '#ff6f8e', size: 28 });
      this.particles.burst('sparkle', p.x, p.y, { count: 8, w: 1.4, h: 0.8, colors: ['#ffb3c4', '#ffffff'] });
    }

    _onShieldUsed(e) {
      const p = this._visiblePos(e.x, e.y);
      this.particles.burst('text', p.x, p.y, { text: 'SHIELD', icon: 'shield', color: '#9fdcff', size: 22 });
      this.particles.burst('sparkle', p.x, p.y, { count: 10, w: 2, h: 1, colors: ['#9fdcff', '#ffffff'] });
      this.shake(3);
    }

    _onShield() {
      const b = this._recent('crystal');
      const c = b ? b.body.getWorldCenter() : null;
      const p = this._visiblePos(c ? c.x : NaN, c ? c.y + 1 : NaN);
      this.particles.burst('text', p.x, p.y, { text: '+', icon: 'shield', color: '#9fdcff', size: 26 });
      this.particles.burst('sparkle', p.x, p.y, { count: 8, w: 1.4, h: 0.8, colors: ['#9fdcff', '#ffffff'] });
    }

    _onMilestone(e) {
      const h = +e.height;
      if (!Number.isFinite(h)) return;
      const colors = ['#ffd166', '#fff1b8', '#ff8fab'];
      for (let x = 1; x < C.FIELD_WIDTH; x += 2) this.particles.burst('sparkle', x, h, { count: 3, w: 2, h: 0.3, colors, speed: 1.4 });
    }

    _onBlockLost(e) {
      if (e.block) this._addVanish(e.block, 'lost');
    }

    // Magnet settles: an indigo field pulse plus sparks streaking out to every pulled block
    _onMagnet(e) {
      const b = e && e.block;
      let x = e.x, y = e.y;
      if ((!Number.isFinite(x) || !Number.isFinite(y)) && b && b.body && !b.dead) {
        const c = b.body.getWorldPoint(b.shape.com);
        x = c.x; y = c.y;
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      this.particles.burst('ring', x, y, { radius: MAGNET_RADIUS + 0.8, color: '#7584ff', life: 0.55, width: 0.2 });
      this.particles.burst('ring', x, y, { radius: MAGNET_RADIUS * 0.8, color: '#dfe4ff', life: 0.42, width: 0.09, delay: 0.1 });
      this.particles.burst('sparkle', x, y, { count: 5, w: 1.2, h: 1, colors: ['#c9d1ff', '#ffffff'], size: 0.8 });
      const ids = b && b.fx && b.fx.targets, P = this.game && this.game.physics;
      if (!ids || !ids.length || !P) return;
      const colors = ['#aab4ff', '#dfe4ff', '#ffffff'];
      for (const o of P.movers) {
        if (o === b || o.dead || ids.indexOf(o.id) < 0) continue;
        const c = o.body.getWorldPoint(o.shape.com);
        this.particles.burst('attract', x, y, { tx: c.x, ty: c.y, count: 4, colors });
      }
    }

    // A block landed on spikes: puncture burst in its colours, a quick swell-and-vanish, 'POP'
    _onPop(e) {
      const b = e && e.block, bb = this._blockBox(b);
      let x = e.x, y = e.y, w = 1, h = 1;
      if (bb) { x = (bb.minX + bb.maxX) / 2; y = (bb.minY + bb.maxY) / 2; w = bb.maxX - bb.minX; h = bb.maxY - bb.minY; }
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const pal = b ? palette(ART[b.look] ? b.look : 'normal', b.tint, !!b.cracked) : null;
      const colors = pal ? [hex(pal.base), hex(pal.light), hex(pal.dark)] : undefined;
      this.particles.burst('pop', x, y, { w, h, colors, count: clamp(8 + (b && b.cells ? b.cells.length : 1) * 3, 10, 22) });
      if (b && !b.dead) this._addVanish(b, 'pop');
      const p = this._visiblePos(x, y + h * 0.5 + 0.35);
      this.particles.burst('text', p.x, p.y, { text: 'POP', color: '#ff7676', size: 20, life: 0.85, rise: 2.4 });
      this.shake(2.5);
    }
  }

  // Draw a block spec centred in a small canvas (batch tray, codex). Works without a game.
  // opts: { cell (CSS px per cell; default fits a 4x4 piece), dpr, width, height (CSS px) }
  // The backing store is sized to width/height when given, else to the element's CSS size.
  function drawPreview(canvas, spec, opts) {
    if (!canvas || !spec) return 0;
    const o = opts || {};
    const type = TT.BLOCK_TYPES[spec.typeKey] || TT.BLOCK_TYPES.normal;
    const shape = TT.SHAPES[spec.shapeId] || TT.SHAPES[type.shape || 'T0'];
    const dpr = clamp(+o.dpr || (typeof window !== 'undefined' && window.devicePixelRatio) || 1, 1, C.MAX_DPR);
    let cw = 0, ch = 0;
    if (o.width > 0 && o.height > 0) { cw = o.width; ch = o.height; }
    else if (canvas.clientWidth > 0 && canvas.clientHeight > 0) { cw = canvas.clientWidth; ch = canvas.clientHeight; }
    if (cw) {
      const w = Math.round(cw * dpr), h = Math.round(ch * dpr);
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
    }
    const W = canvas.width, H = canvas.height;
    const rise = type.key === 'spikes' ? SPIKE_H : 0;   // spikes stick out above the top row
    let cell = o.cell > 0 ? Math.round(o.cell * dpr) : Math.floor(Math.min(W, H) / PREVIEW_FIT);
    cell = Math.max(2, Math.min(cell, Math.floor(W / shape.w), Math.floor(H / (shape.h + rise))));
    const g = canvas.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, W, H);
    const cracked = type.key === 'rubble';
    const look = cracked || !ART[type.key] ? 'normal' : type.key;
    const tint = look === 'normal' ? TT.NORMAL_TINTS[shape.family] : null;
    const n = spec.n >= 0 ? spec.n : 0;   // a dealt block previews exactly as it will look
    const spr = pieceSprite(cell, shape, look, tint, cracked, tintVariant(look, n, 0), texVariant(look, cracked, n, 0), 0, look === 'spikes' ? 8 : 0);
    const x0 = Math.round((W - shape.w * cell) / 2), y0 = Math.round((H - (shape.h - rise) * cell) / 2);
    g.drawImage(spr.canvas, x0, y0 + shape.h * cell - spr.canvas.height);
    spr.used = 0;   // the pixels are copied: first to go when the cache is full
    return cell / dpr;
  }

  Renderer.drawPreview = drawPreview;
  Renderer.spriteStats = spriteStats;   // { sprites, spriteBytes, tiles, tileBytes, masks }
  TT.Renderer = Renderer;
})(typeof window !== 'undefined' ? (window.TT = window.TT || {}) : (global.TT = global.TT || {}));
