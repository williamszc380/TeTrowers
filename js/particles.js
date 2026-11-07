/* TeTrowers — pooled particle system (purely cosmetic).
 *
 * A fixed-capacity structure-of-arrays pool: updating and drawing never allocate, and a full
 * pool drops new particles instead of growing. Particle sprites are pre-rendered once per
 * colour and shared by all instances.
 * Particles live in world units (cells, y up); draw(ctx, view) maps them to device pixels:
 *   view = { ox, oy, ppu, dpr, w, h }
 *   screenX = ox + x * ppu, screenY = oy - y * ppu
 * (ox, oy = device-pixel position of the world origin, ppu = device pixels per cell,
 *  w, h = canvas size in device pixels for culling). Text sizes are CSS px.
 * Cosmetic randomness uses Math.random; it never touches gameplay state.
 *
 * burst(kind, x, y, opts) kinds and their opts (all optional):
 *   dust      { impact (m/s), w (spread width), count, color }
 *   explosion { radius, count }
 *   smoke     { radius, count, color }
 *   shards    { w, h, count, color | colors, speed }
 *   swirl     { radius, count, colors, dir (+1 ccw / -1 cw) }   spirals inward to (x, y)
 *   drip      { w, count, colors }
 *   sparkle   { w, h, count, color | colors, speed, size, life }
 *   leaf      { count, colors }
 *   text      { text, color, size (CSS px), icon ('heart' | 'shield'), life, rise }
 *   ring      { radius, color, life, width (cells), delay (s) }       expanding outline ring
 *   attract   { tx, ty, count, colors, size, life, bend }           sparkles fly from (x, y) to (tx, ty)
 *   glass     { w, h, count, colors, speed }                        translucent glass slivers + glints
 *   pop       { w, h, count, colors }                               puncture: flash, ring, radial shards
 */
(function (TT) {
  'use strict';
  const C = TT.CONFIG;

  const CAPACITY = (C.PARTICLE_CAPACITY != null ? C.PARTICLE_CAPACITY : 640);
  const DEBRIS_GRAVITY = (C.PARTICLE_GRAVITY != null ? C.PARTICLE_GRAVITY : 18); // cells/s^2

  const SPRITE = 64;
  const TAU = Math.PI * 2;
  const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  const NO_OPTS = Object.freeze({});

  // Internal kinds; the public burst() kinds map onto one or more of these
  const DUST = 0, SMOKE = 1, FLASH = 2, FIRE = 3, RING = 4, SHARD = 5, SWIRL = 6, DRIP = 7, SPARKLE = 8, LEAF = 9, TEXT = 10,
    ATTRACT = 11, GLASS = 12;
  // Draw layer per kind: 0 = smoke (back), 1 = normal blend, 2 = additive glow, 3 = text (front)
  const LAYER = new Uint8Array([1, 0, 2, 1, 2, 1, 1, 2, 2, 1, 3, 2, 1]);
  const ICON_NONE = 0, ICON_HEART = 1, ICON_SHIELD = 2;
  const GLASS_COLORS = ['rgba(255,150,172,0.62)', 'rgba(226,90,114,0.58)', 'rgba(255,196,210,0.62)', 'rgba(190,48,78,0.55)'];
  const GLASS_EDGE = 'rgba(255,238,243,0.9)';

  function rand(a, b) { return a + (b - a) * Math.random(); }
  function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  // ---- Shared sprites ---------------------------------------------------------------
  function makeCanvas(w, h) {
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      return c;
    }
    return new OffscreenCanvas(w, h);
  }

  function rgbOf(hex) {
    let h = String(hex).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    return isNaN(n) ? [255, 255, 255] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
  function mixRgb(c, d, t) { return [Math.round(c[0] + (d[0] - c[0]) * t), Math.round(c[1] + (d[1] - c[1]) * t), Math.round(c[2] + (d[2] - c[2]) * t)]; }

  function softSprite(c) {
    const cv = makeCanvas(SPRITE, SPRITE), g = cv.getContext('2d'), r = SPRITE / 2;
    const grad = g.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0, rgba(c, 1));
    grad.addColorStop(0.3, rgba(c, 0.78));
    grad.addColorStop(0.65, rgba(c, 0.24));
    grad.addColorStop(1, rgba(c, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, SPRITE, SPRITE);
    return cv;
  }

  function starSprite(c) {
    const cv = makeCanvas(SPRITE, SPRITE), g = cv.getContext('2d'), r = SPRITE / 2;
    const glow = g.createRadialGradient(r, r, 0, r, r, r * 0.6);
    glow.addColorStop(0, rgba(c, 0.85));
    glow.addColorStop(1, rgba(c, 0));
    g.fillStyle = glow;
    g.fillRect(0, 0, SPRITE, SPRITE);
    const w = r * 0.13;
    g.fillStyle = rgba(c, 1);
    g.beginPath(); g.moveTo(r, 1); g.lineTo(r + w, r); g.lineTo(r, SPRITE - 1); g.lineTo(r - w, r); g.closePath(); g.fill();
    g.beginPath(); g.moveTo(1, r); g.lineTo(r, r - w); g.lineTo(SPRITE - 1, r); g.lineTo(r, r + w); g.closePath(); g.fill();
    g.fillStyle = '#ffffff';
    g.beginPath(); g.arc(r, r, r * 0.13, 0, TAU); g.fill();
    return cv;
  }

  function leafSprite(c) {
    const W = SPRITE, H = SPRITE / 2, cv = makeCanvas(W, H), g = cv.getContext('2d');
    g.translate(W / 2, H / 2);
    g.beginPath();
    g.moveTo(-W * 0.46, 0);
    g.quadraticCurveTo(-W * 0.05, -H * 0.66, W * 0.46, 0);
    g.quadraticCurveTo(-W * 0.05, H * 0.66, -W * 0.46, 0);
    g.closePath();
    const grad = g.createLinearGradient(0, -H / 2, 0, H / 2);
    grad.addColorStop(0, rgba(mixRgb(c, [255, 255, 255], 0.35), 1));
    grad.addColorStop(1, rgba(c, 1));
    g.fillStyle = grad;
    g.fill();
    g.strokeStyle = rgba(mixRgb(c, [0, 0, 0], 0.45), 0.9);
    g.lineWidth = 1.6;
    g.beginPath(); g.moveTo(-W * 0.44, 0); g.lineTo(W * 0.38, 0); g.stroke();
    return cv;
  }

  const sprites = new Map();
  function sprite(type, color) {
    const key = type + color;
    let s = sprites.get(key);
    if (!s) {
      const c = rgbOf(color);
      s = type === 's' ? softSprite(c) : type === 'k' ? starSprite(c) : leafSprite(c);
      sprites.set(key, s);
    }
    return s;
  }

  // Heart / shield icons (centred on 0,0, size = width in px), shared with the renderer
  function heartPath(g, cx, cy, s) {
    g.beginPath();
    g.moveTo(cx, cy + 0.4 * s);
    g.bezierCurveTo(cx - 0.62 * s, cy + 0.0 * s, cx - 0.5 * s, cy - 0.52 * s, cx, cy - 0.2 * s);
    g.bezierCurveTo(cx + 0.5 * s, cy - 0.52 * s, cx + 0.62 * s, cy + 0.0 * s, cx, cy + 0.4 * s);
    g.closePath();
  }
  function shieldPath(g, cx, cy, s) {
    g.beginPath();
    g.moveTo(cx, cy - 0.48 * s);
    g.quadraticCurveTo(cx + 0.24 * s, cy - 0.34 * s, cx + 0.42 * s, cy - 0.36 * s);
    g.quadraticCurveTo(cx + 0.44 * s, cy + 0.22 * s, cx, cy + 0.5 * s);
    g.quadraticCurveTo(cx - 0.44 * s, cy + 0.22 * s, cx - 0.42 * s, cy - 0.36 * s);
    g.quadraticCurveTo(cx - 0.24 * s, cy - 0.34 * s, cx, cy - 0.48 * s);
    g.closePath();
  }

  // ---- Pool ---------------------------------------------------------------------------
  class Particles {
    constructor(capacity) {
      const n = Math.max(16, (capacity | 0) || CAPACITY);
      this.capacity = n;
      this.count = 0;
      this.time = 0;
      this.kind = new Uint8Array(n);
      this.x = new Float32Array(n); this.y = new Float32Array(n);
      this.vx = new Float32Array(n); this.vy = new Float32Array(n);
      this.life = new Float32Array(n); this.max = new Float32Array(n);
      this.size = new Float32Array(n);
      this.rot = new Float32Array(n); this.vr = new Float32Array(n);
      this.drag = new Float32Array(n); this.grav = new Float32Array(n);
      this.p0 = new Float32Array(n); this.p1 = new Float32Array(n); this.p2 = new Float32Array(n);
      this.img = new Array(n).fill(null);
      this.color = new Array(n).fill(null);
      this.text = new Array(n).fill(null);
      this._fonts = new Map();
    }

    clear() {
      for (let i = 0; i < this.count; i++) { this.img[i] = null; this.color[i] = null; this.text[i] = null; }
      this.count = 0;
    }

    // Returns the new particle's slot, or -1 when the pool is full (unless forced)
    _add(kind, x, y, vx, vy, life, size, force) {
      if (this.count >= this.capacity) {
        if (!force) return -1;
        this._kill(0);
      }
      const i = this.count++;
      this.kind[i] = kind;
      this.x[i] = x; this.y[i] = y; this.vx[i] = vx; this.vy[i] = vy;
      this.life[i] = life; this.max[i] = life; this.size[i] = size;
      this.rot[i] = 0; this.vr[i] = 0; this.drag[i] = 0; this.grav[i] = 0;
      this.p0[i] = 0; this.p1[i] = 0; this.p2[i] = 0;
      this.img[i] = null; this.color[i] = null; this.text[i] = null;
      return i;
    }

    // Swap-remove: the last live particle takes slot i
    _kill(i) {
      const j = --this.count;
      if (i !== j) {
        this.kind[i] = this.kind[j];
        this.x[i] = this.x[j]; this.y[i] = this.y[j]; this.vx[i] = this.vx[j]; this.vy[i] = this.vy[j];
        this.life[i] = this.life[j]; this.max[i] = this.max[j]; this.size[i] = this.size[j];
        this.rot[i] = this.rot[j]; this.vr[i] = this.vr[j]; this.drag[i] = this.drag[j]; this.grav[i] = this.grav[j];
        this.p0[i] = this.p0[j]; this.p1[i] = this.p1[j]; this.p2[i] = this.p2[j];
        this.img[i] = this.img[j]; this.color[i] = this.color[j]; this.text[i] = this.text[j];
      }
      this.img[j] = null; this.color[j] = null; this.text[j] = null;
    }

    burst(kind, x, y, opts) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
      const o = opts || NO_OPTS;
      switch (kind) {
        case 'dust': return this._dust(x, y, o);
        case 'explosion': return this._explosion(x, y, o);
        case 'smoke': return this._smoke(x, y, o);
        case 'shards': case 'shard': return this._shards(x, y, o);
        case 'swirl': return this._swirl(x, y, o);
        case 'drip': case 'drips': return this._drips(x, y, o);
        case 'sparkle': case 'sparkles': return this._sparkles(x, y, o);
        case 'leaf': case 'leaves': return this._leaves(x, y, o);
        case 'text': return this._text(x, y, o);
        case 'ring': return this._ring(x, y, o);
        case 'attract': return this._attract(x, y, o);
        case 'glass': return this._glass(x, y, o);
        case 'pop': return this._pop(x, y, o);
        default: return 0;
      }
    }

    _dust(x, y, o) {
      const k = clamp01(o.impact != null ? (o.impact - 1) / 9 : 0.5);
      const n = o.count != null ? o.count : Math.round(4 + 12 * k);
      const w = o.w != null ? o.w : 1;
      const img = sprite('s', o.color || '#c9bfb2');
      let made = 0;
      for (let j = 0; j < n; j++) {
        const px = x + (Math.random() - 0.5) * w;
        const side = px < x ? -1 : 1;
        const sp = rand(0.5, 2.4) * (0.5 + k);
        const i = this._add(DUST, px, y + Math.random() * 0.12, side * sp, rand(0.15, 0.9) * (0.4 + k),
          rand(0.45, 0.85), rand(0.35, 0.6) * (0.75 + 0.6 * k));
        if (i < 0) break;
        this.drag[i] = 3.2; this.grav[i] = -0.6; this.img[i] = img;
        made++;
      }
      return made;
    }

    _explosion(x, y, o) {
      const R = o.radius || 3;
      const s = R / 3;
      let made = 0;
      let i = this._add(FLASH, x, y, 0, 0, 0.3, R * 1.6);
      if (i >= 0) { this.img[i] = sprite('s', '#ff9f43'); made++; }
      i = this._add(FLASH, x, y, 0, 0, 0.16, R * 0.8);
      if (i >= 0) { this.img[i] = sprite('s', '#fff1c1'); made++; }
      i = this._add(RING, x, y, 0, 0, 0.42, R * 1.05);
      if (i >= 0) { this.color[i] = '#ffb36b'; made++; }
      const fire = ['#ffd166', '#ffb03a', '#ff8a2a', '#ff5a24', '#e23b1d'];
      const n = o.count || 30;
      for (let j = 0; j < n; j++) {
        const a = Math.random() * TAU, sp = rand(2, 8.5) * s;
        i = this._add(FIRE, x + Math.cos(a) * 0.3, y + Math.sin(a) * 0.3, Math.cos(a) * sp, Math.sin(a) * sp + 1.5 * s,
          rand(0.3, 0.65), rand(0.55, 1.1) * s);
        if (i < 0) break;
        this.drag[i] = 3.4; this.grav[i] = 2; this.img[i] = sprite('s', pick(fire));
        made++;
      }
      const ember = sprite('k', '#ffc861');
      for (let j = 0; j < 12; j++) {
        const a = Math.random() * TAU, sp = rand(4, 11) * s;
        i = this._add(SPARKLE, x, y, Math.cos(a) * sp, Math.abs(Math.sin(a)) * sp + 2, rand(0.5, 1.0), rand(0.22, 0.36));
        if (i < 0) break;
        this.drag[i] = 1.4; this.grav[i] = DEBRIS_GRAVITY * 0.6; this.img[i] = ember; this.rot[i] = Math.random() * TAU;
        made++;
      }
      return made;
    }

    _smoke(x, y, o) {
      const r = o.radius != null ? o.radius : 1;
      const n = o.count || 10;
      const img = sprite('s', o.color || '#2b2931');
      let made = 0;
      for (let j = 0; j < n; j++) {
        const i = this._add(SMOKE, x + (Math.random() - 0.5) * r, y + (Math.random() - 0.5) * r * 0.6,
          (Math.random() - 0.5) * 1.6, rand(0.5, 1.4), rand(0.9, 1.7), rand(0.9, 1.6) * Math.max(0.7, r * 0.5));
        if (i < 0) break;
        this.drag[i] = 1.1; this.grav[i] = -0.5; this.img[i] = img;
        made++;
      }
      return made;
    }

    _shards(x, y, o) {
      const n = o.count || 10, w = o.w || 1, h = o.h || 1, speed = o.speed || 1;
      const colors = o.colors || [o.color || '#a39f97'];
      let made = 0;
      for (let j = 0; j < n; j++) {
        const a = Math.random() * TAU, sp = rand(1.5, 6) * speed;
        const i = this._add(SHARD, x + (Math.random() - 0.5) * w, y + (Math.random() - 0.5) * h,
          Math.cos(a) * sp, Math.abs(Math.sin(a)) * sp * 0.8 + 1.5, rand(0.55, 1.0), rand(0.1, 0.24));
        if (i < 0) break;
        this.rot[i] = Math.random() * TAU; this.vr[i] = rand(-14, 14);
        this.grav[i] = DEBRIS_GRAVITY; this.drag[i] = 0.6; this.color[i] = pick(colors);
        made++;
      }
      return made;
    }

    _swirl(x, y, o) {
      const n = o.count || 22, R = o.radius || 1.3, dir = o.dir || -1;
      const colors = o.colors || ['#ff3d2e', '#8a1020', '#2a0a14'];
      let made = 0;
      for (let j = 0; j < n; j++) {
        const i = this._add(SWIRL, x, y, 0, 0, rand(0.5, 0.85), rand(0.18, 0.34));
        if (i < 0) break;
        this.p0[i] = R * rand(0.55, 1.1); this.p1[i] = Math.random() * TAU; this.p2[i] = dir * rand(6, 10);
        this.img[i] = sprite('s', pick(colors));
        made++;
      }
      return made;
    }

    _drips(x, y, o) {
      const n = o.count || 7, w = o.w || 1;
      const colors = o.colors || ['#ffb347', '#ff6a1a', '#ffd166'];
      let made = 0;
      for (let j = 0; j < n; j++) {
        const i = this._add(DRIP, x + (Math.random() - 0.5) * w, y - Math.random() * 0.2,
          (Math.random() - 0.5) * 0.4, -rand(0.2, 1.2), rand(0.6, 1.1), rand(0.14, 0.24));
        if (i < 0) break;
        this.grav[i] = 10; this.drag[i] = 0.3; this.img[i] = sprite('s', pick(colors));
        made++;
      }
      return made;
    }

    _sparkles(x, y, o) {
      const n = o.count || 10, w = o.w != null ? o.w : 1, h = o.h != null ? o.h : 1;
      const speed = o.speed || 1, size = o.size || 1, life = o.life || 1;
      const colors = o.colors || [o.color || '#ffffff'];
      let made = 0;
      for (let j = 0; j < n; j++) {
        const i = this._add(SPARKLE, x + (Math.random() - 0.5) * w, y + (Math.random() - 0.5) * h,
          (Math.random() - 0.5) * 0.8 * speed, rand(0.2, 1.1) * speed, rand(0.5, 1.1) * life, rand(0.3, 0.55) * size);
        if (i < 0) break;
        this.drag[i] = 1.6; this.grav[i] = -0.2; this.rot[i] = Math.random() * TAU;
        this.img[i] = sprite('k', pick(colors));
        made++;
      }
      return made;
    }

    _leaves(x, y, o) {
      const n = o.count || 6;
      const colors = o.colors || ['#5fd36f', '#3aa953', '#8be27a'];
      let made = 0;
      for (let j = 0; j < n; j++) {
        const i = this._add(LEAF, x, y, rand(-1.6, 1.6), rand(0.6, 2.2), rand(0.9, 1.5), rand(0.32, 0.46));
        if (i < 0) break;
        this.grav[i] = 3; this.drag[i] = 1.8; this.rot[i] = Math.random() * TAU; this.vr[i] = rand(-5, 5);
        this.img[i] = sprite('l', pick(colors));
        made++;
      }
      return made;
    }

    _text(x, y, o) {
      const i = this._add(TEXT, x, y, 0, o.rise != null ? o.rise : 1.8, o.life || 1.4, o.size || 20, true);
      this.drag[i] = 1.4;
      this.text[i] = o.text != null ? String(o.text) : '';
      this.color[i] = o.color || '#ffffff';
      this.p0[i] = o.icon === 'heart' ? ICON_HEART : o.icon === 'shield' ? ICON_SHIELD : ICON_NONE;
      this.p1[i] = -1; // text width / font px, measured on first draw
      return 1;
    }

    // p0 = line width (cells, 0 = default), p1 = delay (s) before it starts growing
    _ring(x, y, o) {
      const delay = Math.max(0, o.delay || 0);
      const i = this._add(RING, x, y, 0, 0, (o.life || 0.45) + delay, o.radius || 1);
      if (i < 0) return 0;
      this.color[i] = o.color || '#ffffff';
      this.p0[i] = o.width || 0;
      this.p1[i] = delay;
      return 1;
    }

    // Analytic flight from (x, y) to (p0, p1), bowed sideways by p2 (fraction of the distance)
    _attract(x, y, o) {
      if (!Number.isFinite(o.tx) || !Number.isFinite(o.ty)) return 0;
      const n = o.count || 5, size = o.size || 1, life = o.life || 1, bend = o.bend != null ? o.bend : 0.35;
      const colors = o.colors || [o.color || '#ffffff'];
      let made = 0;
      for (let j = 0; j < n; j++) {
        const i = this._add(ATTRACT, x + (Math.random() - 0.5) * 0.4, y + (Math.random() - 0.5) * 0.4, 0, 0,
          rand(0.32, 0.55) * life, rand(0.28, 0.46) * size);
        if (i < 0) break;
        this.p0[i] = o.tx + (Math.random() - 0.5) * 0.5;
        this.p1[i] = o.ty + (Math.random() - 0.5) * 0.5;
        this.p2[i] = bend * rand(-1, 1);
        this.rot[i] = Math.random() * TAU;
        this.img[i] = sprite('k', pick(colors));
        made++;
      }
      return made;
    }

    _glass(x, y, o) {
      const n = o.count || 14, w = o.w || 1, h = o.h || 1, speed = o.speed || 1;
      const colors = o.colors || GLASS_COLORS;
      let made = 0;
      for (let j = 0; j < n; j++) {
        const a = Math.random() * TAU, sp = rand(1.2, 5.5) * speed;
        const i = this._add(GLASS, x + (Math.random() - 0.5) * w, y + (Math.random() - 0.5) * h,
          Math.cos(a) * sp, Math.abs(Math.sin(a)) * sp * 0.7 + 1.2, rand(0.6, 1.1), rand(0.14, 0.34));
        if (i < 0) break;
        this.rot[i] = Math.random() * TAU; this.vr[i] = rand(-9, 9);
        this.grav[i] = DEBRIS_GRAVITY; this.drag[i] = 0.5; this.color[i] = pick(colors);
        this.p0[i] = Math.random() * TAU;
        made++;
      }
      const glint = sprite('k', '#ffffff');
      for (let j = 0; j < 5; j++) {
        const i = this._add(SPARKLE, x + (Math.random() - 0.5) * w, y + (Math.random() - 0.5) * h,
          (Math.random() - 0.5) * 1.5, rand(0.3, 1.4), rand(0.3, 0.6), rand(0.3, 0.5));
        if (i < 0) break;
        this.drag[i] = 2; this.rot[i] = Math.random() * TAU; this.img[i] = glint;
        made++;
      }
      return made;
    }

    // Puncture: a hot white flash, a tight ring and shards flying out radially
    _pop(x, y, o) {
      const w = o.w || 1, h = o.h || 1, R = Math.max(w, h);
      const colors = o.colors || ['#a39f97', '#c9c5bc', '#6f6b64'];
      let made = 0;
      let i = this._add(FLASH, x, y, 0, 0, 0.18, 0.6 + R * 0.35);
      if (i >= 0) { this.img[i] = sprite('s', '#fff2f0'); made++; }
      i = this._add(RING, x, y, 0, 0, 0.3, 0.7 + R * 0.45);
      if (i >= 0) { this.color[i] = '#ffd9d4'; this.p0[i] = 0.12; made++; }
      const n = o.count || 16;
      for (let j = 0; j < n; j++) {
        const a = (j / n) * TAU + Math.random() * 0.4, sp = rand(3.5, 8.5);
        i = this._add(SHARD, x + Math.cos(a) * w * 0.3, y + Math.sin(a) * h * 0.3,
          Math.cos(a) * sp, Math.sin(a) * sp + 1, rand(0.4, 0.75), rand(0.1, 0.2));
        if (i < 0) break;
        this.rot[i] = Math.random() * TAU; this.vr[i] = rand(-16, 16);
        this.grav[i] = DEBRIS_GRAVITY; this.drag[i] = 1.2; this.color[i] = pick(colors);
        made++;
      }
      return made;
    }

    update(dt) {
      if (!(dt > 0) || !this.count) return;
      this.time += dt;
      for (let i = 0; i < this.count; i++) {
        const life = this.life[i] - dt;
        if (life <= 0) { this._kill(i); i--; continue; }
        this.life[i] = life;
        const k = this.kind[i];
        if (k === SWIRL || k === FLASH || k === RING || k === ATTRACT) continue; // analytic motion
        let vx = this.vx[i], vy = this.vy[i] - this.grav[i] * dt;
        const d = this.drag[i];
        if (d > 0) { const f = 1 / (1 + d * dt); vx *= f; vy *= f; }
        this.vx[i] = vx; this.vy[i] = vy;
        this.x[i] += vx * dt; this.y[i] += vy * dt;
        this.rot[i] += this.vr[i] * dt;
      }
    }

    draw(ctx, view) {
      if (!this.count) return;
      const ox = view.ox, oy = view.oy, ppu = view.ppu, dpr = view.dpr || 1, W = view.w, H = view.h;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      for (let layer = 0; layer < 4; layer++) {
        ctx.globalCompositeOperation = layer === 2 ? 'lighter' : 'source-over';
        for (let i = 0; i < this.count; i++) {
          if (LAYER[this.kind[i]] === layer) this._drawOne(ctx, i, ox, oy, ppu, dpr, W, H);
        }
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    _drawOne(ctx, i, ox, oy, ppu, dpr, W, H) {
      const k = this.kind[i];
      const t = 1 - this.life[i] / this.max[i]; // 0 -> 1 over the lifetime
      let x = this.x[i], y = this.y[i];
      if (k === SWIRL) {
        const r = this.p0[i] * Math.pow(1 - t, 1.3);
        const a = this.p1[i] + this.p2[i] * t * this.max[i];
        x += Math.cos(a) * r; y += Math.sin(a) * r;
      } else if (k === ATTRACT) {
        const u = 1 - (1 - t) * (1 - t), dx = this.p0[i] - x, dy = this.p1[i] - y;
        const b = this.p2[i] * Math.sin(Math.PI * u);
        x += dx * u - dy * b; y += dy * u + dx * b;
      }
      const sx = ox + x * ppu, sy = oy - y * ppu;
      if (k === TEXT) { this._drawText(ctx, i, t, sx, sy, dpr, W, H); return; }
      const s = this.size[i] * ppu;
      const m = s * 2.5;
      if (sx < -m || sx > W + m || sy < -m || sy > H + m) return;
      const img = this.img[i];
      switch (k) {
        case DUST: {
          const ss = s * (1 + 0.9 * t);
          ctx.globalAlpha = 0.55 * (1 - t) * (1 - t);
          ctx.drawImage(img, sx - ss / 2, sy - ss / 2, ss, ss);
          break;
        }
        case SMOKE: {
          const ss = s * (1 + 1.4 * t);
          ctx.globalAlpha = 0.5 * Math.min(1, t * 6) * (1 - t);
          ctx.drawImage(img, sx - ss / 2, sy - ss / 2, ss, ss);
          break;
        }
        case FLASH: {
          const ss = s * (0.55 + 0.6 * t);
          ctx.globalAlpha = (1 - t) * (1 - t);
          ctx.drawImage(img, sx - ss / 2, sy - ss / 2, ss, ss);
          break;
        }
        case FIRE: {
          const ss = s * (1 - 0.6 * t);
          ctx.globalAlpha = Math.min(1, (1 - t) * 1.8);
          ctx.drawImage(img, sx - ss / 2, sy - ss / 2, ss, ss);
          break;
        }
        case RING: {
          const delay = this.p1[i];
          let rt = t;
          if (delay > 0) {
            const age = this.max[i] - this.life[i];
            if (age < delay) break;
            rt = (age - delay) / (this.max[i] - delay);
          }
          ctx.globalAlpha = 0.7 * (1 - rt);
          ctx.strokeStyle = this.color[i];
          ctx.lineWidth = Math.max(1, ppu * (this.p0[i] || 0.22) * (1 - rt));
          ctx.beginPath();
          ctx.arc(sx, sy, s * (0.25 + 0.75 * Math.sqrt(rt)), 0, TAU);
          ctx.stroke();
          break;
        }
        case SHARD: {
          const a = this.rot[i];
          ctx.globalAlpha = Math.min(1, (1 - t) * 2.5);
          ctx.fillStyle = this.color[i];
          ctx.beginPath();
          ctx.moveTo(sx + Math.cos(a) * s, sy + Math.sin(a) * s);
          ctx.lineTo(sx + Math.cos(a + 2.3) * s * 0.8, sy + Math.sin(a + 2.3) * s * 0.8);
          ctx.lineTo(sx + Math.cos(a + 4.0) * s * 0.9, sy + Math.sin(a + 4.0) * s * 0.9);
          ctx.closePath();
          ctx.fill();
          break;
        }
        case SWIRL: {
          const ss = s * (1 - 0.6 * t);
          ctx.globalAlpha = Math.min(1, t * 6) * (1 - t * t * t);
          ctx.drawImage(img, sx - ss / 2, sy - ss / 2, ss, ss);
          break;
        }
        case DRIP: {
          ctx.globalAlpha = Math.min(1, (1 - t) * 2);
          ctx.drawImage(img, sx - s / 2, sy - s, s, s * 2);
          break;
        }
        case SPARKLE: {
          const tw = 0.75 + 0.25 * Math.sin(this.time * 22 + this.rot[i]);
          const ss = s * tw * Math.sin(Math.PI * Math.min(1, 0.15 + t * 0.85));
          if (ss <= 0.5) break;
          ctx.globalAlpha = Math.min(1, (1 - t) * 2);
          ctx.drawImage(img, sx - ss / 2, sy - ss / 2, ss, ss);
          break;
        }
        case LEAF: {
          const c = Math.cos(this.rot[i]), n = Math.sin(this.rot[i]);
          ctx.globalAlpha = Math.min(1, (1 - t) * 3);
          ctx.setTransform(c, n, -n, c, sx, sy);
          ctx.drawImage(img, -s / 2, -s / 4, s, s / 2);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          break;
        }
        case ATTRACT: {
          const ss = s * (0.55 + 0.45 * Math.sin(Math.PI * t)) * (0.8 + 0.2 * Math.sin(this.time * 25 + this.rot[i]));
          ctx.globalAlpha = Math.min(1, t * 8, (1 - t) * 3);
          ctx.drawImage(img, sx - ss / 2, sy - ss / 2, ss, ss);
          break;
        }
        case GLASS: {
          // thin translucent sliver with a bright edge; it flashes white when it faces the light
          const a = this.rot[i], fade = Math.min(1, (1 - t) * 2.5);
          ctx.globalAlpha = fade;
          ctx.beginPath();
          ctx.moveTo(sx + Math.cos(a) * s * 1.4, sy + Math.sin(a) * s * 1.4);
          ctx.lineTo(sx + Math.cos(a + 2.7) * s * 0.55, sy + Math.sin(a + 2.7) * s * 0.55);
          ctx.lineTo(sx + Math.cos(a + 3.7) * s * 0.75, sy + Math.sin(a + 3.7) * s * 0.75);
          ctx.closePath();
          ctx.fillStyle = this.color[i];
          ctx.fill();
          ctx.strokeStyle = GLASS_EDGE;
          ctx.lineWidth = Math.max(1, dpr * 0.75);
          ctx.stroke();
          const glint = Math.sin(a * 2 + this.p0[i]);
          if (glint > 0.7) {
            ctx.globalAlpha = fade * (glint - 0.7) * 3.3;
            ctx.fillStyle = '#ffffff';
            ctx.fill();
          }
          break;
        }
      }
    }

    _font(px) {
      let f = this._fonts.get(px);
      if (!f) { f = '800 ' + px + 'px ' + FONT_FAMILY; this._fonts.set(px, f); }
      return f;
    }

    _drawText(ctx, i, t, sx, sy, dpr, W, H) {
      const px = Math.max(8, Math.round(this.size[i] * dpr));
      if (sx < -px * 6 || sx > W + px * 6 || sy < -px * 2 || sy > H + px * 2) return;
      const str = this.text[i];
      const icon = this.p0[i];
      ctx.font = this._font(px);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      if (this.p1[i] < 0) this.p1[i] = str ? ctx.measureText(str).width / px : 0;
      const tw = this.p1[i] * px;
      const iconW = icon ? px * 0.95 : 0;
      const gap = icon && str ? px * 0.1 : 0;
      const x0 = -(tw + gap + iconW) / 2;
      const pop = t < 0.12 ? 0.6 + 0.4 * (t / 0.12) : 1;
      ctx.globalAlpha = t > 0.6 ? (1 - t) / 0.4 : 1;
      ctx.setTransform(pop, 0, 0, pop, sx, sy);
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(2, px * 0.18);
      ctx.strokeStyle = 'rgba(12,10,24,0.9)';
      ctx.fillStyle = this.color[i];
      if (str) { ctx.strokeText(str, x0, 0); ctx.fillText(str, x0, 0); }
      if (icon) {
        const cx = x0 + tw + gap + iconW / 2;
        if (icon === ICON_HEART) heartPath(ctx, cx, px * 0.04, iconW); else shieldPath(ctx, cx, 0, iconW);
        ctx.stroke();
        ctx.fill();
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
  }

  Particles.create = (capacity) => new Particles(capacity);
  Particles.heartPath = heartPath;
  Particles.shieldPath = shieldPath;
  TT.Particles = Particles;
})(typeof window !== 'undefined' ? (window.TT = window.TT || {}) : (global.TT = global.TT || {}));
