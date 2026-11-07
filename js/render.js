/* TeTrowers — canvas renderer.
 *
 * Draws one frame from the game's read-only state (ARCHITECTURE.md §4, §7): an altitude-
 * shifting sky (mountains and clouds near the ground, stars higher up), the platform, every
 * visible block, per-frame animated overlays (mine lights, magma countdown, vine welds,
 * black-hole horizons), the hovering piece with its ghost and warnings, particles, a height
 * ruler and the next life milestone. Game events drive particles and screen shake.
 *
 * Performance model (500+ block towers on phones):
 *  - The world scale is a whole number N of device pixels per cell, and unrotated bodies are
 *    pixel-snapped, so pre-rendered cell sprites blit 1:1 (crisp and cheap).
 *  - Cell art is painted once per (N, look, tint, cracked, variant, overlay) and cached.
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
  const SPRITE_CACHE_MAX = (C.SPRITE_CACHE_MAX != null ? C.SPRITE_CACHE_MAX : 600);

  const TAU = Math.PI * 2;
  const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  const EMPTY = Object.freeze([]);
  const NO_DASH = [];
  const VARIANTS = 3;          // texture variants for speckled / cracked cells
  const SPIKE_H = 0.28;        // spikes protrude this far (cells) above every open top face
  const MAX_EXTENT = 4.4 + SPIKE_H; // tallest possible visual extent (a tilted I piece, spikes included)
  const CULL_MARGIN = 1.2;     // cells; also covers black-hole horizons beside a block
  const VANISH_MAX = 24;
  const PREVIEW_FIT = 4.4;     // drawPreview: cells across the smaller canvas side
  const MAGNET_RADIUS = (C.MAGNET_RADIUS != null ? C.MAGNET_RADIUS : 2.5);
  const MAGNET_TIME = (C.MAGNET_TIME != null ? C.MAGNET_TIME : 0.6);
  const SQUASH_TIME = 0.5;     // s a rubber block wobbles after landing

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
  const TEXTURED = Object.freeze({ normal: true, rubble: true, crumble: true, pebble: true, glass: true });
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
  function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
  function hex(c) { return '#' + ((1 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]).toString(16).slice(1); }
  function smoothstep(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

  const palettes = new Map();
  function palette(look, tint, cracked) {
    const key = look + '|' + (tint || '') + (cracked ? '|c' : '');
    let p = palettes.get(key);
    if (p) return p;
    const type = TT.BLOCK_TYPES[look];
    let base, light, dark, accent;
    if (!type || look === 'normal') {
      base = rgbOf(tint || TT.BLOCK_TYPES.normal.colors.base);
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

  // ---- Shape geometry (outline polygon, centre cell, bounding circle) --------------------
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
    const outline = [];
    for (let i = 0; i < loop.length; i++) {
      const a = loop[(i + loop.length - 1) % loop.length], b = loop[i], c = loop[(i + 1) % loop.length];
      if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) !== 0) outline.push(b[0], b[1]);
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
    geom = { outline: Float32Array.from(outline), centre, radius, com: shape.com, open };
    geoms.set(shape.id, geom);
    return geom;
  }

  // Outline path with the shape origin at device px (X, Y), y up
  function traceOutline(g, geom, X, Y, N) {
    const o = geom.outline;
    g.beginPath();
    g.moveTo(X + o[0] * N, Y - o[1] * N);
    for (let i = 2; i < o.length; i += 2) g.lineTo(X + o[i] * N, Y - o[i + 1] * N);
    g.closePath();
  }

  function variantFor(look, cracked, seed) {
    if (!cracked && !TEXTURED[look]) return 0;
    return (Math.imul(seed + 0x2f, 0x9e3779b1) >>> 24) % VARIANTS;
  }

  // ---- Cell art ---------------------------------------------------------------------------
  // Each look paints a face (texture) and an icon; rubble ("cracked") paints the darkened face
  // plus cracks and no icon. Overlays: 1 = frost-frozen, 2 = petrified. flag: crystal 1 = heart
  // spent; magma 1 = plain centre cell (the countdown number is drawn there per frame).
  function quad(g, x0, y0, x1, y1, x2, y2, x3, y3) {
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.lineTo(x2, y2); g.lineTo(x3, y3); g.closePath(); g.fill();
  }
  function dot(g, x, y, r) { g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); }
  function vgrad(g, N, top, bottom) {
    const grd = g.createLinearGradient(0, 0, 0, N);
    grd.addColorStop(0, css(top));
    grd.addColorStop(1, css(bottom));
    g.fillStyle = grd;
    g.fillRect(0, 0, N, N);
  }
  function speckle(g, N, u, p, rng, n, r0, r1, la, da) {
    for (let i = 0; i < n; i++) {
      const x = N * (0.13 + rng() * 0.74), y = N * (0.13 + rng() * 0.74);
      g.fillStyle = rng() < 0.5 ? rgba(p.light, la) : rgba(p.dark, da);
      dot(g, x, y, Math.max(0.6, u * (r0 + rng() * (r1 - r0))));
    }
  }
  function bevel(g, N, p, la, da) {
    const b = Math.max(1, Math.round(N * 0.09));
    g.fillStyle = rgba(p.light, la); quad(g, 0, 0, N, 0, N - b, b, b, b);
    g.fillStyle = rgba(p.light, la * 0.6); quad(g, 0, 0, b, b, b, N - b, 0, N);
    g.fillStyle = rgba(p.dark, da); quad(g, 0, N, b, N - b, N - b, N - b, N, N);
    g.fillStyle = rgba(p.dark, da * 0.75); quad(g, N, 0, N, N, N - b, N - b, N - b, b);
  }
  function outline(g, N, color) {
    const w = Math.max(1, Math.round(N / 34));
    g.strokeStyle = color;
    g.lineWidth = w;
    g.strokeRect(w / 2, w / 2, N - w, N - w);
  }
  function frameStd(g, N, u, p) { bevel(g, N, p, 0.55, 0.55); outline(g, N, css(p.edge)); }
  function frameDark(g, N, u, p) { bevel(g, N, p, 0.6, 0.6); outline(g, N, rgba(mix(p.light, WHITE, 0.2), 0.95)); }
  function frameIce(g, N, u, p) { bevel(g, N, { light: WHITE, dark: p.dark }, 0.5, 0.45); outline(g, N, rgba(p.dark, 0.95)); }
  function frameGem(g, N, u, p) { outline(g, N, css(mix(p.dark, BLACK, 0.35))); }
  function frameVoid(g, N, u, p) { bevel(g, N, p, 0.5, 0.5); outline(g, N, rgba(p.accent, 0.7)); }

  function rivet(g, x, y, r, p) {
    g.fillStyle = rgba(p.dark, 0.7);
    dot(g, x + r * 0.3, y + r * 0.4, r);
    const grd = g.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
    grd.addColorStop(0, css(mix(p.light, WHITE, 0.6)));
    grd.addColorStop(1, css(p.accent));
    g.fillStyle = grd;
    dot(g, x, y, r);
  }

  function faceStone(g, N, u, p, rng) {
    vgrad(g, N, mix(p.base, p.light, 0.18), mix(p.base, p.dark, 0.14));
    speckle(g, N, u, p, rng, 14, 0.5, 1.0, 0.4, 0.3);
    g.strokeStyle = rgba(p.dark, 0.2);
    g.lineWidth = Math.max(1, u * 0.7);
    const x = N * (0.2 + rng() * 0.4), y = N * (0.3 + rng() * 0.45);
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + N * (0.12 + rng() * 0.14), y - N * (0.03 + rng() * 0.07)); g.stroke();
  }

  function faceSteel(g, N, u, p, rng) {
    const grd = g.createLinearGradient(0, 0, N, N);
    grd.addColorStop(0, css(mix(p.base, p.light, 0.65)));
    grd.addColorStop(0.55, css(p.base));
    grd.addColorStop(1, css(mix(p.base, p.dark, 0.5)));
    g.fillStyle = grd;
    g.fillRect(0, 0, N, N);
    const step = Math.max(1, Math.round(u * 1.1));
    for (let y = 0; y < N; y += step) {
      g.fillStyle = rng() < 0.5 ? rgba(WHITE, (0.05 + rng() * 0.14).toFixed(3)) : rgba(p.dark, (0.04 + rng() * 0.1).toFixed(3));
      g.fillRect(0, y, N, Math.max(1, Math.round(step * 0.5)));
    }
    const sh = g.createLinearGradient(0, 0, N, N);
    sh.addColorStop(0.3, 'rgba(255,255,255,0)');
    sh.addColorStop(0.42, 'rgba(255,255,255,0.4)');
    sh.addColorStop(0.54, 'rgba(255,255,255,0)');
    g.fillStyle = sh;
    g.fillRect(0, 0, N, N);
  }
  function iconRivets(g, N, u, p) {
    const r = Math.max(1.1, u * 2.2), o = N * 0.24;
    rivet(g, o, o, r, p); rivet(g, N - o, o, r, p); rivet(g, o, N - o, r, p); rivet(g, N - o, N - o, r, p);
  }

  function faceVine(g, N, u, p, rng) {
    vgrad(g, N, mix(p.base, p.light, 0.15), mix(p.base, p.dark, 0.3));
    g.strokeStyle = rgba(p.dark, 0.28);
    g.lineWidth = Math.max(1, u * 0.8);
    g.beginPath();
    for (let i = 0; i < 4; i++) {
      const x = N * (0.1 + rng() * 0.8);
      g.moveTo(x, 0);
      g.quadraticCurveTo(x + N * (rng() - 0.5) * 0.5, N * 0.5, x + N * (rng() - 0.5) * 0.3, N);
    }
    g.stroke();
  }
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

  function faceIce(g, N, u, p) {
    const grd = g.createLinearGradient(0, 0, N * 0.35, N);
    grd.addColorStop(0, rgba(p.light, 0.92));
    grd.addColorStop(0.5, rgba(p.base, 0.82));
    grd.addColorStop(1, rgba(p.dark, 0.86));
    g.fillStyle = grd;
    g.fillRect(0, 0, N, N);
    g.fillStyle = 'rgba(255,255,255,0.26)';
    quad(g, 0, N * 0.62, N * 0.62, 0, N * 0.78, 0, 0, N * 0.78);
    g.fillStyle = 'rgba(255,255,255,0.14)';
    quad(g, N * 0.3, N, N, N * 0.3, N, N * 0.4, N * 0.4, N);
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
    snowflake(g, N / 2, N / 2, N * 0.31, Math.max(1.2, u * 2.6), rgba(p.dark, 0.35));
    snowflake(g, N / 2, N / 2, N * 0.31, Math.max(1, u * 1.5), 'rgba(255,255,255,0.97)');
  }

  function faceGem(g, N, u, p, rng, flag) {
    const P = flag === 1 ? palette('normal', hex(mix(p.base, [120, 130, 150], 0.55)), false) : p;
    const t = Math.round(N * 0.25);
    g.fillStyle = css(mix(P.light, P.base, 0.1)); quad(g, 0, 0, N, 0, N - t, t, t, t);
    g.fillStyle = css(mix(P.base, P.dark, 0.4)); quad(g, N, 0, N, N, N - t, N - t, N - t, t);
    g.fillStyle = css(mix(P.dark, BLACK, 0.12)); quad(g, 0, N, t, N - t, N - t, N - t, N, N);
    g.fillStyle = css(mix(P.base, P.light, 0.4)); quad(g, 0, 0, t, t, t, N - t, 0, N);
    const grd = g.createLinearGradient(t, t, N - t, N - t);
    grd.addColorStop(0, css(mix(P.base, P.light, 0.5)));
    grd.addColorStop(1, css(mix(P.base, P.dark, 0.15)));
    g.fillStyle = grd;
    g.fillRect(t, t, N - 2 * t, N - 2 * t);
    g.strokeStyle = rgba(P.light, 0.55);
    g.lineWidth = Math.max(1, u * 0.7);
    g.beginPath();
    g.moveTo(0, 0); g.lineTo(t, t); g.moveTo(N, 0); g.lineTo(N - t, t);
    g.moveTo(0, N); g.lineTo(t, N - t); g.moveTo(N, N); g.lineTo(N - t, N - t);
    g.stroke();
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

  function faceClay(g, N, u, p, rng) {
    vgrad(g, N, mix(p.base, p.light, 0.14), mix(p.base, p.dark, 0.22));
    speckle(g, N, u, p, rng, 10, 0.4, 0.9, 0.3, 0.3);
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

  function faceSand(g, N, u, p, rng) {
    vgrad(g, N, mix(p.base, p.light, 0.28), mix(p.base, p.dark, 0.12));
    g.fillStyle = rgba(p.dark, 0.13);
    for (let i = 0; i < 3; i++) g.fillRect(0, Math.round(N * (0.24 + i * 0.25 + rng() * 0.05)), N, Math.max(1, Math.round(u)));
    speckle(g, N, u, p, rng, 20, 0.3, 0.7, 0.45, 0.3);
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

  function faceOil(g, N, u, p) {
    vgrad(g, N, mix(p.base, p.light, 0.35), p.dark);
    const r = g.createRadialGradient(N * 0.8, N * 0.85, 0, N * 0.8, N * 0.85, N * 0.8);
    r.addColorStop(0, rgba(p.accent, 0.5));
    r.addColorStop(1, rgba(p.accent, 0));
    g.fillStyle = r;
    g.fillRect(0, 0, N, N);
    const s = g.createLinearGradient(0, 0, N, N);
    s.addColorStop(0.1, 'rgba(255,255,255,0)');
    s.addColorStop(0.2, 'rgba(255,255,255,0.3)');
    s.addColorStop(0.28, 'rgba(255,255,255,0)');
    g.fillStyle = s;
    g.fillRect(0, 0, N, N);
  }
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

  function faceMine(g, N, u, p) {
    vgrad(g, N, mix(p.base, p.light, 0.22), mix(p.base, p.dark, 0.3));
    const r = Math.max(0.8, u * 1.3), o = N * 0.15;
    const rp = { dark: p.dark, light: p.light, accent: mix(p.dark, BLACK, 0.3) };
    rivet(g, o, o, r, rp); rivet(g, N - o, o, r, rp); rivet(g, o, N - o, r, rp); rivet(g, N - o, N - o, r, rp);
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

  function faceMagma(g, N, u, p, rng) {
    vgrad(g, N, mix(p.base, p.light, 0.12), mix(p.base, p.dark, 0.45));
    // darker crust plates
    g.fillStyle = rgba(p.dark, 0.38);
    for (let i = 0; i < 3; i++) {
      const x = N * rng(), y = N * rng(), r = N * (0.16 + rng() * 0.14);
      g.beginPath(); g.ellipse(x, y, r, r * 0.7, rng() * 3, 0, TAU); g.fill();
    }
    // glowing cracks: wide soft pass then bright core
    const lines = [];
    for (let k = 0; k < 2; k++) {
      const pts = [];
      const horizontal = rng() < 0.5;
      let a = rng() * N;
      for (let s = 0; s <= 4; s++) {
        const b = (s / 4) * N;
        a = clamp(a + (rng() - 0.5) * N * 0.45, N * 0.1, N * 0.9);
        if (horizontal) pts.push(b, a); else pts.push(a, b);
      }
      lines.push(pts);
    }
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const passes = [[3.4, rgba(p.light, 0.35)], [1.8, rgba(p.light, 0.9)], [0.8, css(p.accent)]];
    for (const [w, col] of passes) {
      g.strokeStyle = col;
      g.lineWidth = Math.max(1, u * w);
      g.beginPath();
      for (const pts of lines) {
        g.moveTo(pts[0], pts[1]);
        for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
      }
      g.stroke();
    }
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

  function faceIron(g, N, u, p) {
    vgrad(g, N, mix(p.base, p.light, 0.25), mix(p.base, p.dark, 0.45));
    const e = N * 0.17;
    const edges = [[0, 0, 0, e, 0, 0, N, e], [0, N, 0, N - e, 0, N - e, N, e], [0, 0, e, 0, 0, 0, e, N], [N, 0, N - e, 0, N - e, 0, e, N]];
    for (const [x0, y0, x1, y1, rx, ry, rw, rh] of edges) {
      const grd = g.createLinearGradient(x0, y0, x1, y1);
      grd.addColorStop(0, rgba(p.accent, 0.6));
      grd.addColorStop(1, rgba(p.accent, 0));
      g.fillStyle = grd;
      g.fillRect(rx, ry, rw, rh);
    }
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

  function faceVoid(g, N, u, p) {
    const grd = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N * 0.72);
    grd.addColorStop(0, '#000000');
    grd.addColorStop(0.55, css(p.base));
    grd.addColorStop(1, css(mix(p.light, BLACK, 0.15)));
    g.fillStyle = grd;
    g.fillRect(0, 0, N, N);
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

  function roundRectPath(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
  function tri(g, x0, y0, x1, y1, x2, y2) {
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.lineTo(x2, y2); g.closePath(); g.fill();
  }

  // Magnet: indigo enamel with a dark horseshoe and bright silver poles
  function faceMagnet(g, N, u, p) {
    vgrad(g, N, mix(p.base, p.light, 0.3), mix(p.base, p.dark, 0.32));
    const step = Math.max(2, Math.round(u * 2));
    g.fillStyle = 'rgba(255,255,255,0.05)';
    for (let y = step; y < N; y += step * 2) g.fillRect(0, y, N, Math.max(1, Math.round(step / 2)));
    const sh = g.createLinearGradient(0, 0, N, N);
    sh.addColorStop(0.18, 'rgba(255,255,255,0)');
    sh.addColorStop(0.32, 'rgba(255,255,255,0.16)');
    sh.addColorStop(0.46, 'rgba(255,255,255,0)');
    g.fillStyle = sh;
    g.fillRect(0, 0, N, N);
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

  // Rubber: a soft rounded pad inside a dark seam, with a rim highlight and a sheen
  function faceRubber(g, N, u, p) {
    g.fillStyle = css(mix(p.dark, BLACK, 0.3));
    g.fillRect(0, 0, N, N);
    const i = Math.max(1, Math.round(N * 0.03)), w = N - 2 * i;
    roundRectPath(g, i, i, w, w, N * 0.17);
    const grd = g.createLinearGradient(0, i, 0, N - i);
    grd.addColorStop(0, css(mix(p.light, p.base, 0.15)));
    grd.addColorStop(0.5, css(p.base));
    grd.addColorStop(1, css(mix(p.base, p.dark, 0.4)));
    g.fillStyle = grd;
    g.fill();
    g.save();
    g.clip();
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.lineWidth = Math.max(1, u * 1.4);
    roundRectPath(g, i + u, i + u, w - 2 * u, w - 2 * u, N * 0.15);
    g.stroke();
    g.restore();
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.beginPath(); g.ellipse(N * 0.3, N * 0.17, N * 0.14, N * 0.045, -0.15, 0, TAU); g.fill();
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

  // Ruby glass: translucent (the sky shows through), denser rim, diagonal glints, bright edges.
  // flag 1 = armed: a faint hairline crack. Rubble keeps the glass and gets shard cracks.
  function faceGlass(g, N, u, p) {
    const ruby = mix(p.base, [200, 0, 40], 0.5), deep = mix(p.dark, BLACK, 0.2);
    g.fillStyle = rgba(ruby, 0.58);
    g.fillRect(0, 0, N, N);
    const grd = g.createLinearGradient(0, 0, N, N);
    grd.addColorStop(0, rgba(mix(p.light, ruby, 0.45), 0.4));
    grd.addColorStop(0.45, rgba(ruby, 0));
    grd.addColorStop(1, rgba(deep, 0.55));
    g.fillStyle = grd;
    g.fillRect(0, 0, N, N);
    const e = Math.max(2, Math.round(N * 0.12));
    g.strokeStyle = rgba(deep, 0.42);
    g.lineWidth = e;
    g.strokeRect(e / 2, e / 2, N - e, N - e);
    g.strokeStyle = 'rgba(255,150,175,0.35)';
    g.lineWidth = Math.max(1, u * 0.8);
    g.strokeRect(e, e, N - 2 * e, N - 2 * e);
  }
  function glints(g, N, u) {
    g.fillStyle = 'rgba(255,255,255,0.3)';
    quad(g, N * 0.12, N * 0.4, N * 0.4, N * 0.12, N * 0.6, N * 0.12, N * 0.12, N * 0.6);
    g.fillStyle = 'rgba(255,255,255,0.6)';
    quad(g, N * 0.12, N * 0.68, N * 0.68, N * 0.12, N * 0.75, N * 0.12, N * 0.12, N * 0.75);
    g.fillStyle = 'rgba(255,255,255,0.22)';
    quad(g, N * 0.5, N * 0.88, N * 0.88, N * 0.5, N * 0.88, N * 0.56, N * 0.56, N * 0.88);
  }
  function iconGlass(g, N, u, p, rng, flag) {
    glints(g, N, u);
    if (flag !== 1) return;
    // hairline from an edge toward the middle, with one short branch
    const fromRight = rng() < 0.5;
    let x = fromRight ? N : N * (0.45 + rng() * 0.35), y = fromRight ? N * (0.45 + rng() * 0.35) : N;
    g.strokeStyle = 'rgba(255,236,241,0.6)';
    g.lineWidth = Math.max(1, u * 0.6);
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
  function frameGlass(g, N, u, p) {
    const w = Math.max(1, Math.round(N / 34)), h = w * 1.5;
    g.lineWidth = w;
    g.strokeStyle = rgba(mix(p.dark, BLACK, 0.3), 0.92);
    g.strokeRect(w / 2, w / 2, N - w, N - w);
    g.strokeStyle = 'rgba(255,228,235,0.95)';
    g.beginPath(); g.moveTo(h, N - h); g.lineTo(h, h); g.lineTo(N - h, h); g.stroke();
    g.strokeStyle = 'rgba(255,170,190,0.5)';
    g.beginPath(); g.moveTo(N - h, h); g.lineTo(N - h, N - h); g.lineTo(h, N - h); g.stroke();
  }
  function rubbleGlass(g, N, u, p, rng) {
    glints(g, N, u);
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
  // Chip a corner off a glass shard (after the frame, so the bevel does not cover the gap)
  function chipGlass(g, N, u, rng) {
    const k = Math.floor(rng() * 4), s = N * (0.2 + rng() * 0.12);
    const x0 = k & 1 ? N : 0, y0 = k & 2 ? N : 0, sx = k & 1 ? -1 : 1, sy = k & 2 ? -1 : 1;
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = '#000000';
    tri(g, x0, y0, x0 + sx * s, y0, x0, y0 + sy * s * (0.6 + rng() * 0.4));
    g.globalCompositeOperation = 'source-over';
  }

  // Spikes: dark crimson plate with a silver stud; the actual spikes are a separate strip
  // sprite drawn above every open top face (spikeStrip) so they can protrude from the cell.
  function faceSpikes(g, N, u, p) {
    vgrad(g, N, mix(p.base, p.light, 0.08), mix(p.dark, BLACK, 0.15));
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
  function frameNone() {}

  const ART = {
    normal: { face: faceStone, icon: null, frame: frameStd },
    rubble: { face: faceStone, icon: null, frame: frameStd },
    steel: { face: faceSteel, icon: iconRivets, frame: frameStd },
    vine: { face: faceVine, icon: iconLeaf, frame: frameStd },
    frost: { face: faceIce, icon: iconSnow, frame: frameIce },
    crystal: { face: faceGem, icon: iconHeart, frame: frameGem },
    pebble: { face: faceClay, icon: iconPebble, frame: frameStd },
    crumble: { face: faceSand, icon: iconCrumble, frame: frameStd },
    oil: { face: faceOil, icon: iconDrop, frame: frameDark },
    mine: { face: faceMine, icon: iconMine, frame: frameStd },
    magma: { face: faceMagma, icon: iconFlame, frame: frameStd },
    anvil: { face: faceIron, icon: iconAnvil, frame: frameDark },
    blackhole: { face: faceVoid, icon: iconRing, frame: frameVoid },
    magnet: { face: faceMagnet, icon: iconMagnet, frame: frameStd },
    rubber: { face: faceRubber, icon: iconBounce, frame: frameNone },
    glass: { face: faceGlass, icon: iconGlass, frame: frameGlass, broken: rubbleGlass, chip: chipGlass },
    spikes: { face: faceSpikes, icon: iconStud, frame: frameStd }
  };

  // Frozen by frost: icy tint, frosted corners, bright rim
  function frostOverlay(g, N, u, rng) {
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = 'rgba(170,226,255,0.34)';
    g.fillRect(0, 0, N, N);
    g.fillStyle = 'rgba(238,250,255,0.9)';
    const s = N * 0.3;
    for (let k = 0; k < 4; k++) {
      const sx = k & 1 ? -1 : 1, sy = k & 2 ? -1 : 1, x0 = k & 1 ? N : 0, y0 = k & 2 ? N : 0;
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
    const w = Math.max(1, Math.round(u * 1.2));
    g.strokeStyle = 'rgba(225,248,255,0.85)';
    g.lineWidth = w;
    g.strokeRect(w * 1.5, w * 1.5, N - w * 3, N - w * 3);
  }
  // Petrified: partially desaturated and slightly darker (subtle on purpose)
  function petrifyOverlay(g, N) {
    g.globalCompositeOperation = 'saturation';
    g.globalAlpha = 0.45;
    g.fillStyle = '#808080';
    g.fillRect(0, 0, N, N);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = 'rgba(16,18,30,0.14)';
    g.fillRect(0, 0, N, N);
    g.globalCompositeOperation = 'source-over';
  }

  function paintCell(g, N, look, tint, cracked, variant, overlay, flag) {
    const art = ART[look] || ART.normal;
    const pal = palette(ART[look] ? look : 'normal', tint, cracked);
    const u = N / 32;
    const rng = TT.RNG.mulberry32(TT.RNG.hashString(look) + variant * 7919 + (cracked ? 104729 : 0));
    art.face(g, N, u, pal, rng, flag);
    if (cracked || look === 'rubble') (art.broken || iconRubble)(g, N, u, pal, rng);
    else if (art.icon) art.icon(g, N, u, pal, rng, flag);
    art.frame(g, N, u, pal);
    if (cracked && art.chip) art.chip(g, N, u, rng);
    if (overlay === 1) frostOverlay(g, N, u, rng);
    else if (overlay === 2) petrifyOverlay(g, N);
  }

  const spriteCache = new Map();
  function cellSprite(N, look, tint, cracked, variant, overlay, flag) {
    const key = N + '|' + look + '|' + (tint || '') + '|' + (cracked ? 1 : 0) + variant + overlay + flag;
    let s = spriteCache.get(key);
    if (!s) {
      if (spriteCache.size >= SPRITE_CACHE_MAX) {
        const keep = N + '|';
        for (const k of spriteCache.keys()) if (!k.startsWith(keep)) spriteCache.delete(k);
        if (spriteCache.size >= SPRITE_CACHE_MAX) spriteCache.clear();
      }
      s = makeCanvas(N, N);
      paintCell(s.getContext('2d'), N, look, tint, cracked, variant, overlay, flag);
      spriteCache.set(key, s);
    }
    return s;
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

  function weldSprite(S) {
    const c = makeCanvas(S, S), g = c.getContext('2d'), r = c.width / 2;
    g.translate(r, r);
    g.strokeStyle = '#2b8c43';
    g.lineWidth = Math.max(1, S * 0.07);
    g.lineCap = 'round';
    g.beginPath(); g.arc(S * 0.02, 0, S * 0.17, 0.3, 4.4); g.stroke();
    for (const a of [-0.7, 2.5]) {
      g.save();
      g.rotate(a);
      g.translate(S * 0.24, 0);
      const L = S * 0.24, W = S * 0.12;
      g.beginPath();
      g.moveTo(-L, 0);
      g.quadraticCurveTo(0, -W * 1.8, L, 0);
      g.quadraticCurveTo(0, W * 1.8, -L, 0);
      g.closePath();
      g.fillStyle = '#74de82';
      g.fill();
      g.strokeStyle = '#1d6831';
      g.lineWidth = Math.max(1, S * 0.035);
      g.stroke();
      g.beginPath(); g.moveTo(-L * 0.9, 0); g.lineTo(L * 0.7, 0); g.stroke();
      g.restore();
    }
    g.fillStyle = '#1d6831';
    dot(g, 0, 0, S * 0.08);
    return c;
  }

  function buildPieceSprite(N, typeKey, shape) {
    const type = TT.BLOCK_TYPES[typeKey] || TT.BLOCK_TYPES.normal;
    const pad = Math.max(3, Math.round(N * 0.42));
    const c = makeCanvas(shape.w * N + pad * 2, shape.h * N + pad * 2), g = c.getContext('2d');
    const geom = shapeGeom(shape);
    const glow = GLOW[type.category] || GLOW.normal;
    const oy = pad + shape.h * N;
    g.save();
    g.shadowColor = glow;
    g.shadowBlur = pad * 0.85;
    g.fillStyle = glow;
    traceOutline(g, geom, pad, oy, N);
    g.fill();
    g.restore();
    // keep only the halo: translucent cells (glass) must show the sky, not the glow fill
    g.globalCompositeOperation = 'destination-out';
    traceOutline(g, geom, pad, oy, N);
    g.fill();
    g.globalCompositeOperation = 'source-over';
    const look = type.key === 'rubble' ? 'normal' : type.key;
    const tint = look === 'normal' ? TT.NORMAL_TINTS[shape.family] : null;
    shape.cells.forEach(([cx, cy], i) => {
      g.drawImage(cellSprite(N, look, tint, type.key === 'rubble', variantFor(look, false, 977 + i * 31), 0, 0),
        pad + cx * N, pad + (shape.h - 1 - cy) * N);
    });
    g.strokeStyle = 'rgba(255,255,255,0.8)';
    g.lineWidth = Math.max(1, Math.round(N / 22));
    g.lineJoin = 'round';
    traceOutline(g, geom, pad, oy, N);
    g.stroke();
    if (type.key === 'spikes') drawSpikeStrips(g, shape.cells, geom.open, N, pad, oy, spikeStrip(N, false));
    return { canvas: c, pad, typeKey, shape, gen: -1 };
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
      this._pc = null;
      this._fonts = new Map();
      this._labels = [];
      this._ms = { m: NaN, full: null, text: '', w: 0, px: 0 };
      this._tmp = { x: 0, y: 0 };
      this.view = { ox: 0, oy: 0, ppu: 1, dpr: 1, w: 1, h: 1, left: 0, right: 0, bottom: 0, top: 0 };
      this.stats = { drawn: 0, cells: 0, statics: 0, movers: 0 };
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
        glowLit: glowSprite(N * 1.7, '#fff6d0', '#ff3018'),
        glowMagma: glowSprite(N * 1.5, '#fff0a8', '#ff6a1a'),
        vortex: vortexSprite(N),
        weld: weldSprite(N * 0.72),
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

    _blockInfo(b) {
      let info = this._info.get(b);
      const fx = b.fx, key = b.typeKey;
      const overlay = b.frozen === 'petrified' ? 2 : (b.frozen === 'frost' && b.look !== 'frost') ? 1 : 0;
      const flags = (key === 'crystal' && fx && fx.used ? 1 : 0) | (key === 'magma' && fx && fx.turnsLeft != null ? 2 : 0) |
        (key === 'glass' && fx && fx.armed ? 4 : 0);
      const sig = overlay | (flags << 2);
      if (info && info.sig === sig && info.gen === this._gen) return info;
      if (!info) {
        info = { sig: -1, gen: -1, sprites: [], geom: null, animated: false, reach: 0, spikes: null, stripOff: null, stripOn: null, squash: 0, squashAt: 0 };
        this._info.set(b, info);
      }
      info.sig = sig;
      info.gen = this._gen;
      info.geom = shapeGeom(b.shape);
      info.animated = !!ANIMATED[key];
      // spikes: open top faces carry a strip of teeth that sticks out of the cell
      info.spikes = key === 'spikes' ? info.geom.open : null;
      info.stripOff = info.spikes ? spikeStrip(this.N, false) : null;
      info.stripOn = info.spikes ? spikeStrip(this.N, true) : null;
      info.reach = info.geom.radius + (info.spikes ? SPIKE_H : 0);
      const look = b.look || key;
      const cracked = !!b.cracked || key === 'rubble';
      const cells = b.cells;
      info.sprites.length = cells.length;
      for (let i = 0; i < cells.length; i++) {
        let flag = 0;
        if (!cracked && look === key) {
          if (look === 'crystal' && (flags & 1)) flag = 1;
          if (look === 'magma' && (flags & 2) && i === info.geom.centre) flag = 1;
          if (look === 'glass' && (flags & 4)) flag = 1;
        }
        info.sprites[i] = cellSprite(this.N, look, b.tint, cracked, variantFor(look, cracked, b.id * 31 + i), overlay, flag);
      }
      return info;
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

    _drawBlock(ctx, v, b, info) {
      this._bodyTransform(ctx, v, b);
      if (info.squash) this._squash(ctx, info);
      const N = this.N, cells = b.cells, spr = info.sprites;
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        ctx.drawImage(spr[i], cell[0] * N, -(cell[1] + 1) * N);
      }
      if (info.spikes) drawSpikeStrips(ctx, cells, info.spikes, N, 0, 0, b.fx && b.fx.active ? info.stripOn : info.stripOff);
      if (info.animated) this._anim.push(b);
      this.stats.drawn++;
      this.stats.cells += cells.length;
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
          case 'vine': if (f.welds && f.welds.length) this._drawWelds(ctx, v, b, f.welds, fx); break;
          case 'magma': if (f.turnsLeft != null) this._drawMagma(ctx, v, b, f.turnsLeft, fx); break;
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

    _drawWelds(ctx, v, b, welds, fx) {
      const N = this.N, img = fx.weld, s = img.width;
      for (let i = 0; i < welds.length; i++) {
        const w = welds[i];
        if (!w) continue;
        this._bodyTransform(ctx, v, b);
        ctx.translate(w.x * N, -w.y * N);
        ctx.rotate(i * 2.399 + b.id);
        ctx.drawImage(img, -s / 2, -s / 2);
      }
    }

    _drawMagma(ctx, v, b, turnsLeft, fx) {
      const info = this._info.get(b);
      const cell = b.cells[info ? info.geom.centre : 0];
      const N = this.N, d = clamp(Math.round(turnsLeft), 0, 9);
      this._bodyTransform(ctx, v, b);
      const x = (cell[0] + 0.5) * N, y = -(cell[1] + 0.5) * N;
      if (d <= 1) {
        const g = fx.glowMagma, s = g.width;
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.4 + 0.35 * Math.sin(this.time * 7);
        ctx.drawImage(g, x - s / 2, y - s / 2);
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

    _drawMineLights(ctx, v, b, lit, fx) {
      const N = this.N;
      let k, img;
      if (lit) {
        k = Math.sin(this.time * TAU * 8) > 0 ? 1 : 0.3;
        img = fx.glowLit;
      } else {
        const ph = ((this.time + b.id * 0.37) % 1.4) / 1.4;
        k = ph < 0.14 ? 1 : ph < 0.42 ? 1 - ((ph - 0.14) / 0.28) * 0.85 : 0.15;
        img = fx.glowArmed;
      }
      this._bodyTransform(ctx, v, b);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = k;
      const s = img.width;
      for (let i = 0; i < b.cells.length; i++) {
        const cell = b.cells[i];
        ctx.drawImage(img, (cell[0] + 0.5) * N - s / 2, -(cell[1] + 0.5) * N - s / 2);
      }
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
        const b = r.block, com = b.shape.com, cells = b.cells, info = this._blockInfo(b), spr = info.sprites;
        for (let pass = 0; pass < (r.kind === 'melt' ? 2 : 1); pass++) {
          ctx.globalAlpha = pass ? alpha * k * 0.8 : alpha;
          if (pass) ctx.globalCompositeOperation = 'lighter';
          for (let i = 0; i < cells.length; i++) ctx.drawImage(spr[i], (cells[i][0] - com.x) * N, (com.y - cells[i][1] - 1) * N);
          if (info.spikes && !pass) drawSpikeStrips(ctx, cells, info.spikes, N, -com.x * N, com.y * N, info.stripOff);
          ctx.globalCompositeOperation = 'source-over';
        }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
    }

    // ---- Hovering piece & ghost -----------------------------------------------------------
    _pieceSprite(typeKey, shape) {
      const pc = this._pc;
      if (pc && pc.typeKey === typeKey && pc.shape === shape && pc.gen === this._gen) return pc;
      const key = typeKey + '|' + shape.id;
      let ps = this._pieceSprites.get(key);
      if (!ps || ps.gen !== this._gen) {
        ps = buildPieceSprite(this.N, typeKey, shape);
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
      const ps = this._pieceSprite(typeKey, shape);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = game.canDrop === false ? 0.38 + 0.3 * clamp(+game.readyProgress || 0, 0, 1) : 1;
      ctx.drawImage(ps.canvas, Math.round(v.ox + px * N) - ps.pad, Math.round(v.oy - (py + shape.h) * N) - ps.pad);
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
    const look = cracked ? 'normal' : type.key;
    const tint = look === 'normal' ? TT.NORMAL_TINTS[shape.family] : null;
    const x0 = Math.round((W - shape.w * cell) / 2), y0 = Math.round((H - (shape.h - rise) * cell) / 2);
    shape.cells.forEach(([cx, cy], i) => {
      g.drawImage(cellSprite(cell, look, tint, cracked, variantFor(look, cracked, 977 + i * 31), 0, 0),
        x0 + cx * cell, y0 + (shape.h - 1 - cy) * cell);
    });
    if (rise) drawSpikeStrips(g, shape.cells, shapeGeom(shape).open, cell, x0, y0 + shape.h * cell, spikeStrip(cell, true));
    return cell / dpr;
  }

  Renderer.drawPreview = drawPreview;
  TT.Renderer = Renderer;
})(typeof window !== 'undefined' ? (window.TT = window.TT || {}) : (global.TT = global.TT || {}));
