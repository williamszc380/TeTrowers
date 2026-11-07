/* TeTrowers — placement: landing prediction, snapping and the assisted mode.
 *
 * Every function is pure over a SURFACE, a snapshot of the tower taken from the physics
 * world (which is never mutated): a skyline sampled SAMPLES_PER_CELL times per cell over
 * x in [-1, FIELD_WIDTH + 1]. Each sample holds the highest top surface above it (the
 * exact upper envelope of the rotated cells) and the block that owns that surface.
 *
 * Assisted mode offers the half-block grid plus every x where a column boundary of the piece
 * (x + j, j = 0..w) lies on a corner below it: the two top corners, at their world x (so
 * drifted and tilted blocks are followed), of each cell with no cell of its own block above
 * it, for every block that owns part of the skyline, and the platform's two edges. Positions
 * closer than CANDIDATE_MERGE (0.08) are one spot: a corner-aligned one beats a grid one; of
 * near-duplicate corner-aligned ones the one on a corner of the block the piece would land
 * on stays, else the one on the higher corner (a covered corner is lower), else the lower x.
 */
(function (TT) {
  'use strict';
  const C = TT.CONFIG;
  const { clamp } = TT.Util;

  const FIELD_WIDTH = C.FIELD_WIDTH;
  const GRID_STEP = C.FIXED_STEP;                     // the half-block grid
  const SAMPLES_PER_CELL = (C.SAMPLES_PER_CELL != null ? C.SAMPLES_PER_CELL : 32);
  const LANDING_EDGE = (C.LANDING_EDGE != null ? C.LANDING_EDGE : 0.04);     // neighbours merely touching a column don't count
  const SUPPORT_EPS = (C.SUPPORT_EPS != null ? C.SUPPORT_EPS : 0.03);        // contact tolerance for supports
  const SURFACE_MAX_SPEED = (C.SURFACE_MAX_SPEED != null ? C.SURFACE_MAX_SPEED : 2); // m/s; faster movers are not ground yet
  // Positions closer than this are one spot to the player; a corner-aligned one is kept
  const CANDIDATE_MERGE = (C.CANDIDATE_MERGE != null ? C.CANDIDATE_MERGE : 0.08);
  const SAME_EPS = 1e-6;                              // positions this close are the same one
  const STEP_EPS = 0.01;                              // stepX ignores candidates closer than this
  const FLAT_TILT = 1e-3;                             // rad; flatter cells are rasterised as boxes
  const DEFAULT_PIXEL = 1 / 32;                       // manual step until the renderer reports a pixel size
  const SKY_X0 = -1;
  const SKY_N = Math.round((FIELD_WIDTH + 2) * SAMPLES_PER_CELL);
  const HALF_PI = Math.PI / 2;

  let buildCount = 0;                                 // surface.version source (monotonic)

  function sampleX(k) { return SKY_X0 + (k + 0.5) / SAMPLES_PER_CELL; }

  // Signed rotation away from the nearest axis-aligned pose. A cell turned by a quarter
  // turn is square to the grid again, so a block lying on its side is still flat.
  function tiltOf(angle) { return angle - HALF_PI * Math.round(angle / HALF_PI); }

  // ---- Skyline rasterisation ----------------------------------------------------------
  function rasterSpan(sky, slots, x0, x1, top, slot) {
    let k0 = Math.ceil((x0 - SKY_X0) * SAMPLES_PER_CELL - 0.5);
    let k1 = Math.floor((x1 - SKY_X0) * SAMPLES_PER_CELL - 0.5);
    if (k0 < 0) k0 = 0;
    if (k1 >= SKY_N) k1 = SKY_N - 1;
    const t = Math.fround(top);
    for (let k = k0; k <= k1; k++) {
      if (t > sky[k]) { sky[k] = t; slots[k] = slot; }
    }
  }

  // Upper envelope of a counter-clockwise quad [BL, BR, TR, TL]: exactly the edges that
  // run right to left.
  function rasterQuad(sky, slots, pts, slot) {
    for (let i = 0; i < 8; i += 2) {
      const j = (i + 2) & 7;
      const ax = pts[i], ay = pts[i + 1], bx = pts[j], by = pts[j + 1];
      const dx = ax - bx;
      if (dx < 1e-9) continue;
      let k0 = Math.ceil((bx - SKY_X0) * SAMPLES_PER_CELL - 0.5);
      let k1 = Math.floor((ax - SKY_X0) * SAMPLES_PER_CELL - 0.5);
      if (k0 < 0) k0 = 0;
      if (k1 >= SKY_N) k1 = SKY_N - 1;
      const slope = (ay - by) / dx;
      for (let k = k0; k <= k1; k++) {
        const y = Math.fround(by + (sampleX(k) - bx) * slope);
        if (y > sky[k]) { sky[k] = y; slots[k] = slot; }
      }
    }
  }

  function rasterBlock(sky, slots, quads, angle, slot) {
    if (Math.abs(tiltOf(angle)) < FLAT_TILT) {
      for (let i = 0; i < quads.length; i++) {
        const q = quads[i];
        rasterSpan(sky, slots, q.minX, q.maxX, q.maxY, slot);
      }
    } else {
      for (let i = 0; i < quads.length; i++) rasterQuad(sky, slots, quads[i].pts, slot);
    }
  }

  // ---- Surface --------------------------------------------------------------------------
  function newSurface() {
    return {
      version: 0,
      x0: SKY_X0,
      samplesPerCell: SAMPLES_PER_CELL,
      n: SKY_N,
      skyline: new Float32Array(SKY_N),   // highest top surface per sample, -Infinity = nothing
      owner: new Array(SKY_N).fill(null), // block owning that surface (the platform pseudo-block too)
      top: -Infinity,                     // highest skyline value
      hazards: null,
      _slots: new Int32Array(SKY_N),      // sample -> index into _blocks, -1 = empty
      _blocks: [],                        // slot -> block; slot 0 is the platform
      _px: null, _py: null, _pa: null,    // slot -> body pose at build time
      _seen: null,                        // slot scratch for surfaceCorners()
      _pf: { x0: 0, x1: 0, top: 0 },      // the platform's edges (not on the integer grid)
      _corners: null,                     // lazily built, see surfaceCorners()
      _cand: new Map()                    // shape id -> assisted candidates
    };
  }

  function ensureSlots(s, n) {
    if (s._px && s._px.length >= n) return;
    let cap = 64;
    while (cap < n) cap *= 2;
    s._px = new Float64Array(cap);
    s._py = new Float64Array(cap);
    s._pa = new Float64Array(cap);
    s._seen = new Uint8Array(cap);
  }

  // opts: { exclude: Set<block> | null, hazards: { horizons, mines, spikes, glass } | null, reuse: surface | null }
  // With `reuse`, that surface object and its arrays are overwritten and returned.
  function buildSurface(physics, opts) {
    const o = opts || {};
    const exclude = !o.exclude ? null : typeof o.exclude.has === 'function' ? o.exclude : new Set(o.exclude);
    const r = o.reuse;
    const s = (r && r._slots && r.skyline && r.skyline.length === SKY_N) ? r : newSurface();
    const blocks = physics.blocks;
    ensureSlots(s, blocks.length + 1);
    const sky = s.skyline, slots = s._slots, list = s._blocks;
    const px = s._px, py = s._py, pa = s._pa;
    sky.fill(-Infinity);
    slots.fill(-1);

    const pf = physics.platform;
    list[0] = pf;
    px[0] = 0; py[0] = 0; pa[0] = 0;
    s._pf.x0 = pf.x0; s._pf.x1 = pf.x1; s._pf.top = pf.top;
    rasterSpan(sky, slots, pf.x0, pf.x1, pf.top, 0);
    let count = 1;
    const maxV2 = SURFACE_MAX_SPEED * SURFACE_MAX_SPEED;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.dead || (exclude && exclude.has(b))) continue;
      const body = b.body;
      if (!body.isStatic()) {
        if (!b.touched) continue;
        const v = body.getLinearVelocity();
        if (v.x * v.x + v.y * v.y >= maxV2) continue;
      }
      const p = body.getPosition(), a = body.getAngle();
      list[count] = b;
      px[count] = p.x; py[count] = p.y; pa[count] = a;
      rasterBlock(sky, slots, physics.cellQuads(b), a, count);
      count++;
    }
    list.length = count;

    const owner = s.owner;
    let top = -Infinity;
    for (let k = 0; k < SKY_N; k++) {
      const sl = slots[k];
      owner[k] = sl >= 0 ? list[sl] : null;
      if (sky[k] > top) top = sky[k];
    }
    s.top = top;
    s.hazards = o.hazards || null;
    s.version = ++buildCount;
    s._corners = null;
    s._cand.clear();
    return s;
  }

  // ---- Corners --------------------------------------------------------------------------
  // Local corners of the cell faces of a shape that look up in the world when its block is
  // turned by q quarter turns (world up = local +y, +x, -y, -x), except faces covered by a
  // cell of the same block: [x0, y0, x1, y1, ...], cached per (shape, q).
  const faceCache = new Map();
  function topCorners(shape, q) {
    const key = shape.id + '/' + q;
    let pts = faceCache.get(key);
    if (pts) return pts;
    const ux = q === 1 ? 1 : q === 3 ? -1 : 0, uy = q === 0 ? 1 : q === 2 ? -1 : 0;
    const cells = shape.cells;
    const has = (x, y) => cells.some((c) => c[0] === x && c[1] === y);
    const out = [];
    const add = (x, y) => {
      for (let i = 0; i < out.length; i += 2) if (out[i] === x && out[i + 1] === y) return;
      out.push(x, y);
    };
    for (let i = 0; i < cells.length; i++) {
      const cx = cells[i][0], cy = cells[i][1];
      if (has(cx + ux, cy + uy)) continue;
      add(cx + (1 + ux - uy) / 2, cy + (1 + uy + ux) / 2);   // both ends of the face toward (ux, uy)
      add(cx + (1 + ux + uy) / 2, cy + (1 + uy - ux) / 2);
    }
    pts = Object.freeze(out);
    faceCache.set(key, pts);
    return pts;
  }

  // The corners below, sorted by world x: the platform's edges, and the top corners of every
  // block that owns part of the skyline at its pose of the build -> { x: [], y: [], slot: [] }.
  // Built once per surface and shared by every shape.
  function surfaceCorners(s) {
    if (s._corners) return s._corners;
    const slots = s._slots, blocks = s._blocks, seen = s._seen, pf = s._pf;
    seen.fill(0, 0, blocks.length);
    const xs = [pf.x0, pf.x1], ys = [pf.top, pf.top], ss = [0, 0];
    for (let k = 0; k < SKY_N; k++) {
      const sl = slots[k];
      if (sl <= 0 || seen[sl]) continue;
      seen[sl] = 1;
      const a = s._pa[sl], cos = Math.cos(a), sin = Math.sin(a), px = s._px[sl], py = s._py[sl];
      const pts = topCorners(blocks[sl].shape, ((Math.round(a / HALF_PI) % 4) + 4) % 4);
      const n0 = xs.length;
      for (let i = 0; i < pts.length; i += 2) {
        const x = px + pts[i] * cos - pts[i + 1] * sin, y = py + pts[i] * sin + pts[i + 1] * cos;
        let j = n0;
        while (j < xs.length && Math.abs(xs[j] - x) > SAME_EPS) j++;
        if (j === xs.length) { xs.push(x); ys.push(y); ss.push(sl); } else if (y > ys[j]) ys[j] = y;
      }
    }
    const order = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
    s._corners = { x: order.map((i) => xs[i]), y: order.map((i) => ys[i]), slot: order.map((i) => ss[i]) };
    return s._corners;
  }

  // ---- Landing --------------------------------------------------------------------------
  // Scratch for computeLanding(); results stay valid until its next call.
  let colTop = new Float64Array(4), colK0 = new Int32Array(4), colK1 = new Int32Array(4);
  let supSlot, supCount, supTop;
  const probe = { y: null, isVoid: true, slot: -1, n: 0 };
  function ensureScratch(w) {
    if (supSlot && colTop.length >= w) return;
    const cols = Math.max(4, w), cap = cols * (SAMPLES_PER_CELL + 1);
    colTop = new Float64Array(cols); colK0 = new Int32Array(cols); colK1 = new Int32Array(cols);
    supSlot = new Int32Array(cap); supCount = new Int32Array(cap); supTop = new Float64Array(cap);
  }
  ensureScratch(4);

  // y = max over the piece's columns of (column top - lowest cell bottom of that column).
  // Supports are the owners of samples at the contact height, sorted: most contact
  // samples first, then the higher top, then the lower id (so supports[0] is primary).
  function computeLanding(s, shape, x) {
    const w = shape.w, bottom = shape.bottom, sky = s.skyline, slots = s._slots;
    ensureScratch(w);
    let y = -Infinity;
    for (let j = 0; j < w; j++) {
      let k0 = Math.ceil((x + j + LANDING_EDGE - SKY_X0) * SAMPLES_PER_CELL - 0.5);
      let k1 = Math.floor((x + j + 1 - LANDING_EDGE - SKY_X0) * SAMPLES_PER_CELL - 0.5);
      if (k0 < 0) k0 = 0;
      if (k1 >= SKY_N) k1 = SKY_N - 1;
      let top = -Infinity;
      for (let k = k0; k <= k1; k++) if (sky[k] > top) top = sky[k];
      colTop[j] = top; colK0[j] = k0; colK1[j] = k1;
      if (top - bottom[j] > y) y = top - bottom[j];
    }
    probe.n = 0; probe.slot = -1;
    if (y === -Infinity) { probe.isVoid = true; probe.y = null; return probe; }
    probe.isVoid = false; probe.y = y;

    let n = 0;
    for (let j = 0; j < w; j++) {
      const contact = y + bottom[j] - SUPPORT_EPS;
      if (colTop[j] < contact) continue;
      for (let k = colK0[j], k1 = colK1[j]; k <= k1; k++) {
        const h = sky[k];
        if (h < contact) continue;
        const sl = slots[k];
        let i = 0;
        while (i < n && supSlot[i] !== sl) i++;
        if (i === n) { supSlot[n] = sl; supCount[n] = 0; supTop[n] = h; n++; }
        supCount[i]++;
        if (h > supTop[i]) supTop[i] = h;
      }
    }
    const blocks = s._blocks;
    for (let i = 1; i < n; i++) {
      const sl = supSlot[i], c = supCount[i], t = supTop[i], id = blocks[sl].id;
      let j = i - 1;
      while (j >= 0) {
        const cj = supCount[j], tj = supTop[j];
        if (!(c > cj || (c === cj && (t > tj || (t === tj && id < blocks[supSlot[j]].id))))) break;
        supSlot[j + 1] = supSlot[j]; supCount[j + 1] = cj; supTop[j + 1] = tj;
        j--;
      }
      supSlot[j + 1] = sl; supCount[j + 1] = c; supTop[j + 1] = t;
    }
    probe.n = n;
    probe.slot = supSlot[0];
    return probe;
  }

  // Effects hands over hazard ids (mines, spikes, glass) in Sets; a Set of blocks or an
  // array of ids or blocks also works.
  function anyIn(set, supports) {
    const isSet = typeof set.has === 'function';
    for (let i = 0; i < supports.length; i++) {
      const b = supports[i];
      if (b.isPlatform) continue;
      if (isSet ? set.has(b.id) || set.has(b) : set.indexOf(b.id) >= 0 || set.indexOf(b) >= 0) return true;
    }
    return false;
  }

  // Any piece cell at its resting place, or swept down from fromY, overlapping a horizon
  function hitsHorizon(shape, x, y, fromY, horizons) {
    const lift = (fromY != null && fromY > y) ? fromY - y : 0;
    const cells = shape.cells;
    for (let h = 0; h < horizons.length; h++) {
      const a = horizons[h];
      for (let i = 0; i < cells.length; i++) {
        const cx = x + cells[i][0], cy = y + cells[i][1];
        if (cx < a.maxX && cx + 1 > a.minX && cy < a.maxY && cy + 1 + lift > a.minY) return true;
      }
    }
    return false;
  }

  // → { y (origin y at rest, null over the void), void, primary, supports, warnings }
  function landing(surface, shape, x, fromY) {
    const L = computeLanding(surface, shape, x);
    if (L.isVoid) return { y: null, void: true, primary: null, supports: [], warnings: ['void'] };
    const y = L.y, blocks = surface._blocks;
    const supports = new Array(L.n);
    for (let i = 0; i < L.n; i++) supports[i] = blocks[supSlot[i]];
    const warnings = [];
    const hz = surface.hazards;
    if (hz) {
      if (hz.mines && anyIn(hz.mines, supports)) warnings.push('mine');
      if (hz.horizons && hz.horizons.length && hitsHorizon(shape, x, y, fromY, hz.horizons)) warnings.push('horizon');
      if (hz.spikes && anyIn(hz.spikes, supports)) warnings.push('spikes');   // the piece would be destroyed
      if (hz.glass && anyIn(hz.glass, supports)) warnings.push('glass');      // it would shatter the glass
    }
    return { y, void: false, primary: supports[0], supports, warnings };
  }

  // ---- Candidates -----------------------------------------------------------------------
  const halfGridCache = new Map();                    // piece width -> frozen positions
  function halfGrid(w) {
    let list = halfGridCache.get(w);
    if (!list) {
      list = [];
      const max = FIELD_WIDTH - w;
      for (let i = 0; i * GRID_STEP <= max + 1e-9; i++) list.push(i * GRID_STEP);
      list = Object.freeze(list);
      halfGridCache.set(w, list);
    }
    return list;
  }

  // How a piece at x lines up: whether a column boundary of it is on a corner of the block it
  // would land on, and the highest corner one of its boundaries is on (-Infinity: none)
  const fit = { onSupport: 0, height: -Infinity };
  function cornerFit(s, shape, x) {
    const c = s._corners, cx = c.x, n = cx.length;
    const p = computeLanding(s, shape, x).slot;
    fit.onSupport = 0; fit.height = -Infinity;
    for (let j = 0; j <= shape.w; j++) {
      const t = x + j;
      let lo = 0, hi = n;
      while (lo < hi) { const m = (lo + hi) >> 1; if (cx[m] < t - SAME_EPS) lo = m + 1; else hi = m; }
      for (let i = lo; i < n && cx[i] <= t + SAME_EPS; i++) {
        if (c.slot[i] === p) fit.onSupport = 1;
        if (c.y[i] > fit.height) fit.height = c.y[i];
      }
    }
    return fit;
  }

  let posBuf = new Float64Array(256);                 // scratch: corner-aligned positions
  const clX = [], clOn = [], clH = [];                // scratch: one cluster of them

  // Near-duplicate positions pos[i0..i1) (sorted, each closer than CANDIDATE_MERGE to the
  // next) keep a spread no closer than that, preferring a corner of the block the piece
  // would land on, then the higher corner (a covered one is lower), then the lower x.
  function pickCluster(s, shape, pos, i0, i1, out) {
    clX.length = clOn.length = clH.length = 0;
    for (let i = i0; i < i1; i++) {
      if (clX.length && pos[i] - clX[clX.length - 1] < SAME_EPS) continue;
      const f = cornerFit(s, shape, pos[i]);
      clX.push(pos[i]); clOn.push(f.onSupport); clH.push(f.height);
    }
    const order = clX.map((_, i) => i).sort((a, b) => (clOn[b] - clOn[a]) || (clH[b] - clH[a]) || (clX[a] - clX[b]));
    const start = out.length;
    for (let o = 0; o < order.length; o++) {
      const x = clX[order[o]];
      let k = start;
      while (k < out.length && Math.abs(out[k] - x) >= CANDIDATE_MERGE) k++;
      if (k === out.length) out.push(x);
    }
  }

  // The half grid plus every position with a column boundary of the piece (0..w) on a
  // corner below; where a corner-aligned position and a grid one are closer than
  // CANDIDATE_MERGE, the corner-aligned one stays.
  function assistedCandidates(s, shape) {
    const w = shape.w, maxX = FIELD_WIDTH - w;
    const grid = halfGrid(w);
    const corners = surfaceCorners(s).x;
    const need = corners.length * (w + 1);
    if (posBuf.length < need) posBuf = new Float64Array(need * 2);
    let n = 0;
    for (let i = 0; i < corners.length; i++) {
      for (let j = 0; j <= w; j++) {
        const x = corners[i] - j;
        if (x > -SAME_EPS && x < maxX + SAME_EPS) posBuf[n++] = clamp(x, 0, maxX);
      }
    }
    if (!n) return grid;
    const pos = posBuf.subarray(0, n).sort();
    const aligned = [];
    for (let i = 0; i < n;) {
      let e = i + 1;
      while (e < n && pos[e] - pos[e - 1] < CANDIDATE_MERGE) e++;
      if (pos[e - 1] - pos[i] < SAME_EPS) aligned.push(pos[i]);
      else pickCluster(s, shape, pos, i, e, aligned);
      i = e;
    }
    aligned.sort((a, b) => a - b);

    const out = [];
    let k = 0;
    for (let i = 0; i < grid.length; i++) {
      const g = grid[i];
      while (k < aligned.length && aligned[k] < g) out.push(aligned[k++]);
      if ((k > 0 && g - aligned[k - 1] < CANDIDATE_MERGE) || (k < aligned.length && aligned[k] - g < CANDIDATE_MERGE)) continue;
      out.push(g);
    }
    while (k < aligned.length) out.push(aligned[k++]);
    return Object.freeze(out);
  }

  // Sorted x positions the piece may take. 'assisted' is cached on the surface (one build
  // = one version); any other mode gets the half-block grid. Arrays are frozen and shared.
  function candidates(surface, shape, mode) {
    if (mode !== 'assisted' || !surface) return halfGrid(shape.w);
    let list = surface._cand.get(shape.id);
    if (!list) {
      list = assistedCandidates(surface, shape);
      surface._cand.set(shape.id, list);
    }
    return list;
  }

  // ---- Movement -------------------------------------------------------------------------
  function clampX(shape, x) {
    if (Number.isNaN(x)) return 0;
    return clamp(x, 0, FIELD_WIDTH - shape.w);
  }

  function stepX(surface, shape, mode, x, dir, pixelSize) {
    if (mode === 'manual') return clampX(shape, x + dir * (pixelSize > 0 ? pixelSize : DEFAULT_PIXEL));
    const list = candidates(surface, shape, mode);
    if (dir > 0) {
      for (let i = 0; i < list.length; i++) if (list[i] > x + STEP_EPS) return list[i];
    } else if (dir < 0) {
      for (let i = list.length - 1; i >= 0; i--) if (list[i] < x - STEP_EPS) return list[i];
    }
    return x;
  }

  // Nearest candidate; on a tie the lower x
  function snapX(surface, shape, mode, x) {
    if (mode === 'manual') return clampX(shape, x);
    const list = candidates(surface, shape, mode);
    if (!list.length) return clampX(shape, x);
    let best = list[0], bestD = Math.abs(best - x);
    for (let i = 1; i < list.length; i++) {
      const d = Math.abs(list[i] - x);
      if (d < bestD - 1e-9) { best = list[i]; bestD = d; }
    }
    return best;
  }

  // Assisted guided fall: the landing point in the primary support's local frame, so the
  // game can follow that block (body.getWorldPoint(local).x) if it moves during the fall.
  // The frame is the block's pose when the surface was built, because x was chosen
  // against that snapshot: any drift since then is followed too.
  function guideTarget(surface, shape, x) {
    const L = computeLanding(surface, shape, x);
    const sl = L.slot;
    if (L.isVoid || sl <= 0) return null;
    const block = surface._blocks[sl];
    if (!block || block.isPlatform || block.dead) return null;
    const a = surface._pa[sl], cos = Math.cos(a), sin = Math.sin(a);
    const dx = x - surface._px[sl], dy = L.y - surface._py[sl];
    return { block, local: { x: cos * dx + sin * dy, y: cos * dy - sin * dx } };
  }

  TT.Placement = {
    buildSurface, landing, candidates, stepX, snapX, clampX, guideTarget,
    tiltOf, sampleX,
    SAMPLES_PER_CELL, SKY_X0, LANDING_EDGE, CANDIDATE_MERGE
  };
})(typeof window !== 'undefined' ? (window.TT = window.TT || {}) : (global.TT = global.TT || {}));
