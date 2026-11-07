/* TeTrowers — piece shapes.
 * All 19 fixed tetromino orientations (blocks are never rotated by the player) plus the
 * 1x1 pebble. Cells are [x, y] integer offsets, y UP, normalised so min x = min y = 0.
 * A cell [x, y] occupies the unit square [x, x+1] x [y, y+1] in the piece's local frame.
 */
(function (TT) {
  'use strict';

  // ASCII art, top row first. '#' = cell.
  const ART = {
    I0: ['####'],
    I1: ['#', '#', '#', '#'],
    O0: ['##', '##'],
    T0: ['.#.', '###'],
    T1: ['#.', '##', '#.'],
    T2: ['###', '.#.'],
    T3: ['.#', '##', '.#'],
    S0: ['.##', '##.'],
    S1: ['#.', '##', '.#'],
    Z0: ['##.', '.##'],
    Z1: ['.#', '##', '#.'],
    J0: ['#..', '###'],
    J1: ['##', '#.', '#.'],
    J2: ['###', '..#'],
    J3: ['.#', '.#', '##'],
    L0: ['..#', '###'],
    L1: ['#.', '#.', '##'],
    L2: ['###', '#..'],
    L3: ['##', '.#', '.#'],
    P1: ['#']
  };

  // Generator order — NEVER reorder: seeds map indices to these ids.
  const TETROMINO_IDS = ['I0', 'I1', 'O0', 'T0', 'T1', 'T2', 'T3', 'S0', 'S1', 'Z0', 'Z1',
    'J0', 'J1', 'J2', 'J3', 'L0', 'L1', 'L2', 'L3'];

  function cellsFromArt(rows) {
    const cells = [];
    const h = rows.length;
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < rows[r].length; c++) {
        if (rows[r][c] === '#') cells.push([c, h - 1 - r]);
      }
    }
    return cells;
  }

  // Decompose cells into few axis-aligned rectangles {x0, y0, x1, y1} (cell lattice).
  // Tries row-runs merged vertically and column-runs merged horizontally; keeps the
  // smaller set. Every tetromino ends up as 1 or 2 rectangles.
  function decompose(cells) {
    const key = (x, y) => x + ',' + y;
    const set = new Set(cells.map((c) => key(c[0], c[1])));

    function runs(horizontal) {
      const out = [];
      const done = new Set();
      const sorted = cells.slice().sort((a, b) => horizontal ? (a[1] - b[1]) || (a[0] - b[0]) : (a[0] - b[0]) || (a[1] - b[1]));
      for (const [x, y] of sorted) {
        if (done.has(key(x, y))) continue;
        // extend along the primary axis
        let len = 1;
        while (set.has(horizontal ? key(x + len, y) : key(x, y + len)) && !done.has(horizontal ? key(x + len, y) : key(x, y + len))) len++;
        // extend along the secondary axis while the whole run repeats
        let depth = 1;
        for (;;) {
          let ok = true;
          for (let i = 0; i < len; i++) {
            const k = horizontal ? key(x + i, y + depth) : key(x + depth, y + i);
            if (!set.has(k) || done.has(k)) { ok = false; break; }
          }
          // the run must not continue past its ends on that line, or merging would orphan cells
          if (ok) {
            const before = horizontal ? key(x - 1, y + depth) : key(x + depth, y - 1);
            const after = horizontal ? key(x + len, y + depth) : key(x + depth, y + len);
            if ((set.has(before) && !done.has(before)) || (set.has(after) && !done.has(after))) ok = false;
          }
          if (!ok) break;
          depth++;
        }
        for (let i = 0; i < len; i++) {
          for (let j = 0; j < depth; j++) done.add(horizontal ? key(x + i, y + j) : key(x + j, y + i));
        }
        out.push(horizontal
          ? { x0: x, y0: y, x1: x + len, y1: y + depth }
          : { x0: x, y0: y, x1: x + depth, y1: y + len });
      }
      return out;
    }

    const a = runs(true);
    const b = runs(false);
    return b.length < a.length ? b : a;
  }

  function buildShape(id) {
    const cells = cellsFromArt(ART[id]);
    let w = 0, h = 0;
    for (const [x, y] of cells) { w = Math.max(w, x + 1); h = Math.max(h, y + 1); }
    // Lowest cell bottom per column (for landing prediction) and highest cell top per column
    const bottom = new Array(w).fill(Infinity);
    const top = new Array(w).fill(-Infinity);
    for (const [x, y] of cells) { bottom[x] = Math.min(bottom[x], y); top[x] = Math.max(top[x], y + 1); }
    let cx = 0, cy = 0;
    for (const [x, y] of cells) { cx += x + 0.5; cy += y + 0.5; }
    return Object.freeze({
      id,
      family: id[0],
      cells: Object.freeze(cells.map((c) => Object.freeze(c))),
      w, h,
      rects: Object.freeze(decompose(cells)),
      bottom: Object.freeze(bottom),
      top: Object.freeze(top),
      com: Object.freeze({ x: cx / cells.length, y: cy / cells.length }) // centre of mass (uniform density)
    });
  }

  const SHAPES = {};
  for (const id of Object.keys(ART)) SHAPES[id] = buildShape(id);

  TT.SHAPES = Object.freeze(SHAPES);
  TT.TETROMINO_IDS = Object.freeze(TETROMINO_IDS);
  TT.Shapes = { decompose, cellsFromArt };
})(typeof window !== 'undefined' ? (window.TT = window.TT || {}) : (global.TT = global.TT || {}));
