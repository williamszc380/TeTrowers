#!/usr/bin/env node
/* TeTrowers — procedural app icons (no dependencies; PNG encoding via node's zlib).
 * Draws a small tower of bevelled tetromino blocks in the game's own colours (read from
 * js/blocktypes.js) on a dark navy-to-indigo sky, and writes:
 *   icons/icon-192.png, icons/icon-512.png   rounded square, transparent corners ("any")
 *   icons/icon-maskable-512.png              full bleed, art inside the 80% safe circle
 *   icons/apple-touch-icon.png  (180)        full bleed; iOS rounds the corners itself
 *   icons/favicon-32.png                     simplified art that stays legible at 32 px
 * Usage: node tools/make-icons.js [outDir]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'icons'));

require(path.join(ROOT, 'js/config.js'));
require(path.join(ROOT, 'js/blocktypes.js'));
const TYPES = global.TT.BLOCK_TYPES;
const TINTS = global.TT.NORMAL_TINTS;

// ---- colour helpers ----------------------------------------------------------------
function hex(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const WHITE = [1, 1, 1], BLACK = [0, 0, 0];

const SKY_TOP = hex('#2a1d6b');      // indigo
const SKY_BOTTOM = hex('#0f1730');   // navy (the manifest theme colour)
const GLOW = hex('#5a6fe0');
const SLAB = { base: hex('#535d7c'), light: hex('#7d88a8'), dark: hex('#2e3550') };
const PILLAR = hex('#262c45');

function palette(typeKey, family) {
  if (typeKey === 'normal') {
    const base = hex(TINTS[family] || TYPES.normal.colors.base);
    return { base, light: mix(base, WHITE, 0.4), dark: mix(base, BLACK, 0.38), accent: hex(TYPES.normal.colors.accent) };
  }
  const c = TYPES[typeKey].colors;
  return { base: hex(c.base), light: hex(c.light), dark: hex(c.dark), accent: hex(c.accent) };
}

// ---- raster (premultiplied float RGBA, y down) ------------------------------------
class Raster {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.d = new Float32Array(w * h * 4);
  }

  // Composite colour (rgb array or fn(x, y) -> rgb|null) with alpha (number or fn) over the
  // pixels in the box whose centres satisfy inside(x, y)
  paint(x0, y0, x1, y1, inside, rgb, alpha) {
    const X0 = Math.max(0, Math.floor(x0)), Y0 = Math.max(0, Math.floor(y0));
    const X1 = Math.min(this.w, Math.ceil(x1)), Y1 = Math.min(this.h, Math.ceil(y1));
    const d = this.d;
    for (let y = Y0; y < Y1; y++) {
      for (let x = X0; x < X1; x++) {
        const px = x + 0.5, py = y + 0.5;
        if (inside && !inside(px, py)) continue;
        const c = typeof rgb === 'function' ? rgb(px, py) : rgb;
        if (!c) continue;
        const a = alpha == null ? 1 : typeof alpha === 'function' ? alpha(px, py) : alpha;
        if (a <= 0) continue;
        const i = (y * this.w + x) * 4;
        d[i] = c[0] * a + d[i] * (1 - a);
        d[i + 1] = c[1] * a + d[i + 1] * (1 - a);
        d[i + 2] = c[2] * a + d[i + 2] * (1 - a);
        d[i + 3] = a + d[i + 3] * (1 - a);
      }
    }
  }

  // Keep only the pixels inside(x, y) (hard mask; antialiased by the downsample)
  clip(inside) {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (!inside(x + 0.5, y + 0.5)) this.d.fill(0, (y * this.w + x) * 4, (y * this.w + x) * 4 + 4);
      }
    }
  }

  // Box-filter down by k into 8-bit straight-alpha RGBA (tiny dither against banding)
  downsample(k) {
    const w = this.w / k, h = this.h / k;
    const out = Buffer.alloc(w * h * 4);
    const n = k * k;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let j = 0; j < k; j++) {
          let i = ((y * k + j) * this.w + x * k) * 4;
          for (let q = 0; q < k; q++, i += 4) { r += this.d[i]; g += this.d[i + 1]; b += this.d[i + 2]; a += this.d[i + 3]; }
        }
        const o = (y * w + x) * 4;
        const dither = ((x * 7 + y * 13) % 5) / 5 - 0.4;
        if (a > 0) {
          out[o] = clampByte(r / a * 255 + dither);
          out[o + 1] = clampByte(g / a * 255 + dither);
          out[o + 2] = clampByte(b / a * 255 + dither);
        }
        out[o + 3] = clampByte(a / n * 255);
      }
    }
    return { w, h, data: out };
  }
}
const clampByte = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

// ---- shapes (inside tests in pixel space) ------------------------------------------
const inRoundRect = (x0, y0, x1, y1, r) => (x, y) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
  const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
  return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r;
};
const inCircle = (cx, cy, r) => (x, y) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r;
// Classic heart curve (u^2 + v^2 - 1)^3 - u^2 v^3 <= 0, ~2.3 units wide
const inHeart = (cx, cy, s) => (x, y) => {
  const u = (x - cx) / s, v = -(y - cy) / s + 0.12;
  const a = u * u + v * v - 1;
  return a * a * a - u * u * v * v * v <= 0;
};
// Pointed leaf along the -45 degree diagonal
const inLeaf = (cx, cy, len, wid) => (x, y) => {
  const dx = x - cx, dy = y - cy;
  const u = (dx - dy) * Math.SQRT1_2, v = (dx + dy) * Math.SQRT1_2;
  const t = u / (len / 2);
  return Math.abs(t) <= 1 && Math.abs(v) <= (wid / 2) * (1 - t * t);
};

// ---- art ---------------------------------------------------------------------------
// Layouts in cell units, y up; the platform top is y = 0 and spans x in [0, cols].
const FULL = {
  cols: 6,
  pieces: [
    { type: 'normal', family: 'J', cells: [[0, 0], [1, 0], [2, 0], [0, 1]] },
    { type: 'normal', family: 'L', cells: [[3, 0], [4, 0], [5, 0], [5, 1]] },
    { type: 'steel', cells: [[1, 1], [2, 1], [1, 2], [2, 2]] },
    { type: 'vine', cells: [[3, 1], [4, 1], [3, 2], [4, 2]] },
    { type: 'crystal', cells: [[1, 3], [2, 3], [3, 3], [2, 4]] },
    { type: 'mine', cells: [[3, 6], [2, 7], [3, 7], [4, 7]], falling: true }
  ],
  top: 8
};
// Bigger cells, fewer of them: reads at favicon size
const MINI = {
  cols: 4,
  pieces: [
    { type: 'normal', family: 'L', cells: [[0, 0], [1, 0], [2, 0], [2, 1]] },
    { type: 'vine', cells: [[3, 0], [3, 1], [3, 2]] },
    { type: 'steel', cells: [[0, 1], [1, 1]] },
    { type: 'crystal', cells: [[1, 2], [2, 2]] },
    { type: 'mine', cells: [[2, 3]] }
  ],
  top: 4,
  plain: true
};

function background(R, glowX, glowY, glowR) {
  const S = R.w;
  R.paint(0, 0, R.w, R.h, null, (x, y) => {
    const t = Math.min(1, Math.max(0, (y / S) * 0.85 + (x / S) * 0.15));
    return mix(SKY_TOP, SKY_BOTTOM, t);
  });
  R.paint(glowX - glowR, glowY - glowR, glowX + glowR, glowY + glowR, null, GLOW, (x, y) => {
    const d = Math.hypot(x - glowX, y - glowY) / glowR;
    return d >= 1 ? 0 : 0.32 * (1 - d) * (1 - d);
  });
}

function stars(R, count, seed, maxY) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const S = R.w;
  for (let i = 0; i < count; i++) {
    const x = rnd() * S, y = rnd() * maxY, r = S * (0.003 + rnd() * 0.004), a = 0.35 + rnd() * 0.55;
    R.paint(x - r - 1, y - r - 1, x + r + 1, y + r + 1, inCircle(x, y, r), [0.9, 0.93, 1], a);
  }
}

function drawCell(R, x, y, s, pal, icon, plain) {
  const g = s * 0.045, b = s * 0.15, r = s * 0.09;
  const x0 = x + g, y0 = y + g, x1 = x + s - g, y1 = y + s - g, w = x1 - x0;
  const top = mix(pal.light, pal.base, 0.1), left = mix(pal.light, pal.base, 0.5);
  const right = mix(pal.dark, pal.base, 0.35), bottom = pal.dark;
  const faceTop = mix(pal.base, pal.light, 0.18), faceBottom = mix(pal.base, pal.dark, 0.14);
  R.paint(x0, y0, x1, y1, inRoundRect(x0, y0, x1, y1, r), (px, py) => {
    const u = px - x0, v = py - y0;
    const m = Math.min(u, v, w - u, w - v);
    if (m < b) {
      if (m === v) return top;
      if (m === u) return left;
      if (m === w - u) return right;
      return bottom;
    }
    return mix(faceTop, faceBottom, (v - b) / (w - 2 * b));
  });
  if (plain || !icon) return;
  const cx = x + s / 2, cy = y + s / 2;
  if (icon === 'rivets') {
    const o = s * 0.29, rr = s * 0.055;
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const rx = cx + dx * o, ry = cy + dy * o;
      R.paint(rx - rr * 2, ry - rr * 2, rx + rr * 2, ry + rr * 2, inCircle(rx, ry, rr), pal.dark);
      R.paint(rx - rr * 2, ry - rr * 2, rx + rr * 2, ry + rr * 2, inCircle(rx - rr * 0.35, ry - rr * 0.35, rr * 0.45), WHITE, 0.9);
    }
  } else if (icon === 'leaf') {
    R.paint(x, y, x + s, y + s, inLeaf(cx, cy, s * 0.52, s * 0.3), pal.accent);
    R.paint(x, y, x + s, y + s, (px, py) => {
      const dx = px - cx, dy = py - cy;
      return Math.abs((dx + dy) * Math.SQRT1_2) < s * 0.018 && Math.abs((dx - dy) * Math.SQRT1_2) < s * 0.2;
    }, pal.dark, 0.7);
  } else if (icon === 'heart') {
    R.paint(x, y, x + s, y + s, inHeart(cx, cy + s * 0.02, s * 0.17), pal.accent, 0.95);
  } else if (icon === 'mine') {
    const rr = s * 0.21;
    R.paint(x, y, x + s, y + s, (px, py) => {
      const dx = px - cx, dy = py - cy;
      if (dx * dx + dy * dy <= rr * rr) return true;
      // four short spikes
      const ax = Math.abs(dx), ay = Math.abs(dy);
      return (ax < s * 0.04 && ay < rr * 1.45) || (ay < s * 0.04 && ax < rr * 1.45);
    }, hex('#2a0a08'));
    R.paint(x, y, x + s, y + s, inCircle(cx - rr * 0.3, cy - rr * 0.3, rr * 0.36), pal.accent);
  }
}

// Places the layout so that cell size = c and the platform's top-left corner is (ox, oy)
function drawTower(R, L, c, ox, oy) {
  const px = (cx) => ox + cx * c;
  const py = (cy) => oy - cy * c;     // y up -> pixel y down
  // pillar and slab
  const slabH = c * 0.5;
  R.paint(px(0.85), oy + slabH * 0.6, px(L.cols - 0.85), R.h, null, (x, y) => mix(PILLAR, SKY_BOTTOM, Math.min(1, (y - oy) / (R.h - oy + 1) * 0.9)));
  const sx0 = px(-0.25), sx1 = px(L.cols + 0.25), sy0 = oy + c * 0.02, sy1 = oy + slabH;
  R.paint(sx0, sy0, sx1, sy1, inRoundRect(sx0, sy0, sx1, sy1, c * 0.08), (x, y) => {
    const v = (y - sy0) / (sy1 - sy0);
    return v < 0.22 ? SLAB.light : mix(SLAB.base, SLAB.dark, v);
  });
  // soft shadow of the falling piece's motion: faint streaks above it
  for (const p of L.pieces) {
    if (!p.falling) continue;
    let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [cx, cy] of p.cells) { minX = Math.min(minX, cx); maxX = Math.max(maxX, cx + 1); maxY = Math.max(maxY, cy + 1); }
    for (const fx of [minX + 0.3, (minX + maxX) / 2, maxX - 0.3]) {
      const x0 = px(fx) - c * 0.035, x1 = px(fx) + c * 0.035, yTop = py(maxY + 1.6), yBot = py(maxY) - c * 0.12;
      R.paint(x0, yTop, x1, yBot, inRoundRect(x0, yTop, x1, yBot, c * 0.035), WHITE, (x, y) => 0.22 * (y - yTop) / (yBot - yTop));
    }
  }
  for (const p of L.pieces) {
    const pal = palette(p.type, p.family);
    const icon = TYPES[p.type].icon;
    const glyph = icon === 'rivets' || icon === 'leaf' || icon === 'heart' || icon === 'mine' ? icon : null;
    drawBacking(R, p.cells, c, px, py, mix(pal.dark, BLACK, 0.3));
    for (const [cx, cy] of p.cells) drawCell(R, px(cx), py(cy + 1), c, pal, glyph, L.plain);
  }
}

// Dark fill under a piece's cells: the seams inside a piece show it instead of the sky,
// so each tetromino reads as one block. Outer edges keep the normal gap.
function drawBacking(R, cells, c, px, py, rgb) {
  const has = new Set(cells.map(([x, y]) => x + ',' + y));
  const g = c * 0.045;
  for (const [cx, cy] of cells) {
    const x0 = px(cx) + (has.has((cx - 1) + ',' + cy) ? 0 : g);
    const x1 = px(cx + 1) - (has.has((cx + 1) + ',' + cy) ? 0 : g);
    const y0 = py(cy + 1) + (has.has(cx + ',' + (cy + 1)) ? 0 : g);
    const y1 = py(cy) - (has.has(cx + ',' + (cy - 1)) ? 0 : g);
    R.paint(x0, y0, x1, y1, null, rgb);
  }
}

// Content extents in cell units (platform slab included, pillar excluded)
function extents(L) {
  return { x0: -0.25, x1: L.cols + 0.25, y0: -0.5, y1: L.top };
}

// Every outline point of the art in cell units (cell corners, slab corners, streak tops)
function contentPoints(L) {
  const pts = [[-0.25, 0], [L.cols + 0.25, 0], [-0.25, -0.5], [L.cols + 0.25, -0.5]];
  for (const p of L.pieces) {
    for (const [x, y] of p.cells) pts.push([x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]);
  }
  return pts;
}

// Best centre (cell units) and radius (cells) of the smallest circle around the content
function fitCircle(L) {
  const pts = contentPoints(L);
  const e = extents(L);
  let best = null;
  for (let i = 0; i <= 60; i++) {
    for (let j = 0; j <= 60; j++) {
      const cx = e.x0 + (e.x1 - e.x0) * (0.3 + 0.4 * i / 60);
      const cy = e.y0 + (e.y1 - e.y0) * (0.3 + 0.4 * j / 60);
      let r = 0;
      for (const [x, y] of pts) r = Math.max(r, Math.hypot(x - cx, y - cy));
      if (!best || r < best.r) best = { cx, cy, r };
    }
  }
  return best;
}

// mode: 'rounded' (transparent corners), 'bleed' (full square), 'maskable' (safe circle)
function render(size, mode, L, ss) {
  const S = size * ss;
  const R = new Raster(S, S);
  const e = extents(L);
  const w = e.x1 - e.x0, h = e.y1 - e.y0;
  let c, ox, oy;
  if (mode === 'maskable') {
    // the art must stay inside the central circle of radius 40% (the maskable safe zone)
    const fit = fitCircle(L);
    c = (S * 0.4 * 0.96) / fit.r;
    ox = S / 2 - fit.cx * c;
    oy = S / 2 + fit.cy * c;
  } else {
    // centre the content box; nudge down a touch so the pillar reads as "ground"
    c = Math.min((S * (mode === 'bleed' ? 0.72 : 0.77)) / h, (S * 0.82) / w);
    ox = S / 2 - (e.x0 + w / 2) * c;
    oy = S / 2 + (e.y0 + h / 2) * c + S * 0.02;
  }
  background(R, S / 2, oy - c * 2.2, S * 0.55);
  if (!L.plain) stars(R, mode === 'maskable' ? 10 : 14, size * 31 + 7, oy - c * 3.5);
  drawTower(R, L, c, ox, oy);
  if (mode === 'rounded') {
    const rr = S * 0.2;
    R.clip(inRoundRect(0, 0, S, S, rr));
  }
  return R.downsample(ss);
}

// ---- PNG encoding ------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// RGBA in -> PNG (RGB when fully opaque). Per-row adaptive filter, max deflate.
function encodePNG(w, h, rgba) {
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { opaque = false; break; }
  const bpp = opaque ? 3 : 4;
  const stride = w * bpp;
  const raw = Buffer.alloc((stride + 1) * h);
  let prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  const cand = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) for (let k = 0; k < bpp; k++) cur[x * bpp + k] = rgba[(y * w + x) * 4 + k];
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const out = cand[f];
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        let pred = 0;
        if (f === 1) pred = a;
        else if (f === 2) pred = b;
        else if (f === 3) pred = (a + b) >> 1;
        else if (f === 4) {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        const v = (cur[i] - pred) & 255;
        out[i] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) { bestSum = sum; best = f; }
    }
    raw[y * (stride + 1)] = best;
    cand[best].copy(raw, y * (stride + 1) + 1);
    const t = prev; prev = cur; cur = t;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;                    // bit depth
  ihdr[9] = opaque ? 2 : 6;       // RGB / RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---- main --------------------------------------------------------------------------
const ICONS = [
  { file: 'icon-192.png', size: 192, mode: 'rounded', layout: FULL, ss: 6 },
  { file: 'icon-512.png', size: 512, mode: 'rounded', layout: FULL, ss: 4 },
  { file: 'icon-maskable-512.png', size: 512, mode: 'maskable', layout: FULL, ss: 4 },
  { file: 'apple-touch-icon.png', size: 180, mode: 'bleed', layout: FULL, ss: 6 },
  { file: 'favicon-32.png', size: 32, mode: 'rounded', layout: MINI, ss: 8 }
];

if (require.main === module) {
  fs.mkdirSync(OUT, { recursive: true });
  for (const icon of ICONS) {
    const img = render(icon.size, icon.mode, icon.layout, icon.ss);
    const png = encodePNG(img.w, img.h, img.data);
    fs.writeFileSync(path.join(OUT, icon.file), png);
    console.log('wrote ' + path.relative(ROOT, path.join(OUT, icon.file)).replace(/\\/g, '/') + '  ' + img.w + 'x' + img.h + '  ' + png.length + ' bytes');
  }
}

module.exports = { render, encodePNG, ICONS };
