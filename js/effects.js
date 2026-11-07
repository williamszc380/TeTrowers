/* TeTrowers — special block behaviours (docs/ARCHITECTURE.md §3 and §5).
 *
 * A handler table keyed by typeKey plus the dispatchers game.js calls. Everything runs
 * with the world UNLOCKED (after world.step), so handlers may create, destroy, shatter,
 * freeze and weld directly. An earlier record of the same batch may already have
 * destroyed, shattered or frozen any block, so handlers always re-check `dead` and the
 * body type, and every handler is idempotent (game.js calls onFirstTouch AND onContact
 * with the same record).
 *
 * Per-block state lives in block.fx (the renderer reads it):
 *   vine      welds: [{x, y, partner, joint}] local anchors, pruned once the partner is gone
 *   mine      armed, lit, fuse (s left), ignoreIds   crystal, frost   used
 *   anvil     impactUntil (game time)                glass            armed, ignoreIds
 *   blackhole active, horizonCells: [[cx, cy]], graceUntil (physics step), spared: Set<id>
 *   spikes    active, ignoreIds                      magma            turnsLeft
 *   magnet    used, pullUntil (game time), targets: [id], gridAngle, pull: [block] still pulled
 * Mine, glass and spikes may hold restingIds (Set<id>) until they arm (rememberResting).
 * Lit fuses, pulling magnets, magma, holes, mines, spikes, glass and welded vines are also
 * tracked per physics world (WeakMap), so update / onTurnStart / hazards never scan the whole tower.
 */
(function (TT) {
  'use strict';
  const C = TT.CONFIG;
  const { clamp } = TT.Util;
  const HALF_PI = Math.PI / 2;

  // Tunables not in config.js
  const MINE_TRIGGER_NY = (C.MINE_TRIGGER_NY != null ? C.MINE_TRIGGER_NY : 0.5);   // normal y (mine -> other) that counts as "on top"
  const ON_TOP_NY = (C.ON_TOP_NY != null ? C.ON_TOP_NY : 0.5);                     // same for glass and spikes
  const ANVIL_HIT_NY = (C.ANVIL_HIT_NY != null ? C.ANVIL_HIT_NY : 0.5);            // -normal y (anvil -> other) that counts as "below"
  const CENTROID_FALLBACK = (C.CENTROID_FALLBACK != null ? C.CENTROID_FALLBACK : 0.25); // above/below test when a record has no normal
  const EXPLODE_MIN_DIST = (C.EXPLODE_MIN_DIST != null ? C.EXPLODE_MIN_DIST : 0.3);
  const EXPLODE_SPIN = (C.EXPLODE_SPIN != null ? C.EXPLODE_SPIN : 1.5);             // rad/s, max cosmetic spin change at the centre
  const NEIGHBOUR_GAP = (C.NEIGHBOUR_GAP != null ? C.NEIGHBOUR_GAP : 0.08);         // visual gap that still counts as touching (vine, frost)
  const NEIGHBOUR_MIN_FACE = (C.NEIGHBOUR_MIN_FACE != null ? C.NEIGHBOUR_MIN_FACE : 0.25); // shared face length a flush neighbour needs
  const NEIGHBOUR_MAX_SPEED = (C.NEIGHBOUR_MAX_SPEED != null ? C.NEIGHBOUR_MAX_SPEED : 0.5); // m/s; faster blocks are only grabbed via real contact
  const HORIZON_SPARE_MARGIN = (C.HORIZON_SPARE_MARGIN != null ? C.HORIZON_SPARE_MARGIN : 0.05);
  const MAGNET_DONE_DIST = (C.MAGNET_DONE_DIST != null ? C.MAGNET_DONE_DIST : 0.01);    // m; a pulled block this close to its spot...
  const MAGNET_DONE_ANGLE = (C.MAGNET_DONE_ANGLE != null ? C.MAGNET_DONE_ANGLE : 0.005); // rad; ...and this straight is let go
  const MAGNET_PIVOT_TILT = (C.MAGNET_PIVOT_TILT != null ? C.MAGNET_PIVOT_TILT : 0.2);  // rad; see pullTargets()

  // ---- Helpers ------------------------------------------------------------------------
  function now(game) { return typeof game.time === 'number' ? game.time : game.physics.time; }

  function emit(game, name, payload) { if (game.emit) game.emit(name, payload); }

  function bump(game, key, n) {
    const s = game.stats;
    if (s) s[key] = (s[key] || 0) + (n == null ? 1 : n);
  }

  // World centre of a block's cells. Body.getWorldCenter() is the body ORIGIN for static
  // bodies (Box2D zeroes their mass data), so frozen blocks need the shape centroid.
  function centroid(block) {
    const p = block.body.getWorldPoint(block.shape.com);
    return { x: p.x, y: p.y };
  }

  // y of a record's contact normal, oriented from `self` to the other side (null if unknown)
  function normalY(rec, selfIsA) {
    const n = rec.normal;
    return n ? (selfIsA ? n.y : -n.y) : null;
  }

  // Is `other` on top of `self` in this contact? (centroid test when the record has no normal)
  function onTop(game, self, other, rec, selfIsA, minNy) {
    const ny = normalY(rec, selfIsA);
    return ny != null ? ny > minNy : centroid(other).y > game.physics.bounds(self).maxY - CENTROID_FALLBACK;
  }

  // Rotation away from the nearest quarter turn (a quarter-turned cell is square again)
  function quarterTilt(angle) { return angle - HALF_PI * Math.round(angle / HALF_PI); }

  const worlds = new WeakMap();
  function registry(physics) {
    let r = worlds.get(physics);
    if (!r) {
      r = {
        fuses: new Set(), magnets: new Set(), magma: new Set(), holes: new Set(), mines: new Set(),
        spikes: new Set(), glass: new Set(), vines: new Set(), weldsVersion: -1
      };
      worlds.set(physics, r);
    }
    return r;
  }

  function atRest(block) {
    if (block.body.isStatic()) return true;
    if (block.dropped && !block.touched) return false; // still falling from the hover line
    const v = block.body.getLinearVelocity();
    return Math.abs(v.x) + Math.abs(v.y) + Math.abs(block.body.getAngularVelocity()) < NEIGHBOUR_MAX_SPEED;
  }

  function solidTouching(c) { return c.isTouching() && !c.getFixtureA().isSensor() && !c.getFixtureB().isSensor(); }

  // y of a contact's normal, oriented away from `body` (null without a manifold)
  function contactNormalY(c, body) {
    const wm = c.getWorldManifold(null);
    if (!wm) return null;
    return c.getFixtureA().getBody() === body ? wm.normal.y : -wm.normal.y;
  }

  // Live blocks other than `block` (and the platform) with a fixture near its bounds
  function nearBlocks(physics, block, margin) {
    const bb = physics.bounds(block);
    const near = new Set();
    physics.world.queryAABB({ lowerBound: { x: bb.minX - margin, y: bb.minY - margin }, upperBound: { x: bb.maxX + margin, y: bb.maxY + margin } }, (f) => {
      const ud = f.getUserData();
      const o = ud && ud.kind === 'solid' ? ud.block : null;
      if (o && o !== block && !o.isPlatform && !o.dead) near.add(o);
      return true;
    });
    return near;
  }

  // Visual cells of `o` flush against cells of `block` (collision side faces are inset by
  // CELL_INSET, so flush side-by-side neighbours never touch in Box2D). Calls fn(face, x, y)
  // per pair: face of block's cell it sits on, in block's frame (0 +x, 1 -x, 2 +y, 3 -y), and
  // the world midpoint of the two cell centres.
  function flushCells(physics, block, o, fn) {
    const body = block.body;
    const p = body.getPosition(), a = body.getAngle();
    const cos = Math.cos(a), sin = Math.sin(a);
    const reach = 1 + NEIGHBOUR_GAP, side = 1 - NEIGHBOUR_MIN_FACE;
    for (const q of physics.cellQuads(o)) {
      const dx = q.x - p.x, dy = q.y - p.y;
      const lx = dx * cos + dy * sin, ly = dy * cos - dx * sin; // o's cell centre in block's frame
      for (const cell of block.cells) {
        const cx = cell[0] + 0.5, cy = cell[1] + 0.5;
        const ox = lx - cx, oy = ly - cy, ax = Math.abs(ox), ay = Math.abs(oy);
        let face = -1;
        if (ax >= ay) { if (ax <= reach && ay <= side) face = ox > 0 ? 0 : 1; }
        else if (ay <= reach && ax <= side) face = oy > 0 ? 2 : 3;
        if (face >= 0) fn(face, (p.x + cx * cos - cy * sin + q.x) / 2, (p.y + cx * sin + cy * cos + q.y) / 2);
      }
    }
  }

  // Everything `block` touches: Box2D contacts (blocks and the platform, with the contact
  // point) plus resting blocks whose visual cells are flush with its cells, which never
  // register as contacts side by side even though they visibly touch. -> [{ other, point | null }]
  function neighbours(physics, block) {
    const out = [];
    const seen = new Set();
    for (const t of physics.touching(block)) {
      if (t.other.dead || seen.has(t.other)) continue;
      seen.add(t.other);
      out.push({ other: t.other, point: t.point });
    }
    for (const o of nearBlocks(physics, block, NEIGHBOUR_GAP)) {
      if (seen.has(o) || !atRest(o)) continue;
      let sx = 0, sy = 0, k = 0;
      flushCells(physics, block, o, (face, x, y) => { sx += x; sy += y; k++; });
      if (k) out.push({ other: o, point: { x: sx / k, y: sy / k } });
    }
    return out;
  }

  // Ids of the blocks resting on top of `block` right now. They landed before it armed, so
  // they never trigger it: freezing/petrifying either body re-creates their contact later,
  // and that is not a landing. Counts every touching solid contact whose normal (block ->
  // other) points up, not only the first one per neighbour, plus resting blocks with a cell
  // flush on top of one of its cells: that needs no contact, which a freeze destroys until
  // the next step (or until a sleeping neighbour wakes). Includes fx.restingIds.
  function restingOn(physics, block, minNy) {
    const ids = block.fx.restingIds || new Set();
    block.fx.restingIds = null;
    const body = block.body;
    for (let ce = body.getContactList(); ce; ce = ce.next) {
      if (!solidTouching(ce.contact)) continue;
      const other = ce.other.getUserData();
      if (other && !other.isPlatform && contactNormalY(ce.contact, body) > minNy) ids.add(other.id);
    }
    const a = body.getAngle(), sin = Math.sin(a), cos = Math.cos(a);
    const faceNy = [sin, -sin, cos, -cos]; // world normal y of the +x, -x, +y, -y cell faces
    for (const o of nearBlocks(physics, block, NEIGHBOUR_GAP)) {
      if (ids.has(o.id) || !atRest(o)) continue;
      let top = false;
      flushCells(physics, block, o, (face) => { if (faceNy[face] > minNy) top = true; });
      if (top) ids.add(o.id);
    }
    return ids;
  }

  // Mine, glass and spikes arm when they settle (or are frozen) and ignore what rests on them
  // then. Making a body static destroys its contacts, so right before frost or steel freezes
  // `block`, each of them in contact with it that has not armed yet remembers which of the
  // two rests on top (restingOn() adds these).
  const ARM_NY = { mine: MINE_TRIGGER_NY, glass: ON_TOP_NY, spikes: ON_TOP_NY };
  function unarmed(b) { return ARM_NY[b.typeKey] != null && !b.fx.armed && !b.fx.active; }
  function remember(hazard, id) { (hazard.fx.restingIds || (hazard.fx.restingIds = new Set())).add(id); }
  function rememberResting(block) {
    if (block.dead || block.isPlatform) return;
    const body = block.body, self = unarmed(block);
    for (let ce = body.getContactList(); ce; ce = ce.next) {
      if (!solidTouching(ce.contact)) continue;
      const other = ce.other.getUserData();
      const ny = other && !other.isPlatform && !other.dead ? contactNormalY(ce.contact, body) : null;
      if (ny == null) continue;
      if (self && ny > ARM_NY[block.typeKey]) remember(block, other.id);
      if (unarmed(other) && -ny > ARM_NY[other.typeKey]) remember(other, block.id);
    }
  }

  // Shatter into rubble, emit + count. Returns the number of parts (0 if nothing happened).
  // Rubble continues a fall in progress (game.js fallTurn / fallMoved: whose turn a loss costs).
  function shatterBlock(game, block, cause) {
    const c = centroid(block);
    const parts = game.physics.shatter(block);
    if (!parts.length || parts[0] === block) return 0;
    if (block.fallTurn != null) for (const p of parts) { p.fallTurn = block.fallTurn; p.fallMoved = block.fallMoved; }
    emit(game, 'shatter', { x: c.x, y: c.y, count: parts.length, cause });
    bump(game, 'shattered');
    return parts.length;
  }

  // ---- Mine ---------------------------------------------------------------------------
  function lightMine(game, mine) {
    const fx = mine.fx;
    fx.lit = true;
    fx.fuse = C.MINE_FUSE;
    registry(game.physics).fuses.add(mine);
    const c = centroid(mine);
    emit(game, 'fuse', { block: mine, x: c.x, y: c.y });
  }

  function detonate(game, mine) {
    const c = centroid(mine);
    explode(game, c.x, c.y, { exclude: mine });
    game.physics.removeBlock(mine, 'exploded');
    bump(game, 'exploded');
  }

  // ---- Anvil --------------------------------------------------------------------------
  // Shatter `other` if it is a dynamic multi-cell block below the anvil. Mines detonate,
  // spikes pop the anvil and armed glass breaks by itself instead (their own handlers see
  // the anvil above them); single cells cannot break further.
  function smash(game, anvil, other, ny) {
    if (!other || other.isPlatform || other.dead || anvil.dead) return;
    const k = other.typeKey;
    if (k === 'mine' || k === 'anvil' || k === 'spikes' || (k === 'glass' && other.fx.armed) || other.cells.length <= 1) return;
    if (!other.body.isDynamic()) return;
    const below = ny != null ? ny < -ANVIL_HIT_NY
      : centroid(other).y < game.physics.bounds(anvil).minY + CENTROID_FALLBACK;
    if (below) shatterBlock(game, other, 'anvil');
  }

  function impactActive(game, anvil) {
    const until = anvil.fx.impactUntil;
    return until != null && now(game) <= until;
  }

  // ---- Magnet -------------------------------------------------------------------------
  // Dynamic blocks with a cell centre within MAGNET_RADIUS of one of the magnet's cell
  // centres, turned at most MAGNET_MAX_TILT away from its grid (modulo quarter turns).
  // A piece still falling from the hover line is not part of the tower yet.
  function magnetTargets(physics, magnet) {
    const R = C.MAGNET_RADIUS, R2 = R * R;
    const mq = physics.cellQuads(magnet);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const q of mq) {
      if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x;
      if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y;
    }
    const near = new Set();
    physics.world.queryAABB({ lowerBound: { x: minX - R, y: minY - R }, upperBound: { x: maxX + R, y: maxY + R } }, (f) => {
      const ud = f.getUserData();
      const b = ud && ud.kind === 'solid' ? ud.block : null;
      if (b && b !== magnet && !b.isPlatform && !b.dead) near.add(b);
      return true;
    });
    const ma = magnet.body.getAngle();
    const out = [];
    for (const b of near) {
      if (!b.body.isDynamic() || (b.dropped && !b.touched)) continue;
      if (Math.abs(quarterTilt(b.body.getAngle() - ma)) > C.MAGNET_MAX_TILT) continue;
      let hit = false;
      for (const q of physics.cellQuads(b)) {
        for (let i = 0; i < mq.length && !hit; i++) {
          const dx = q.x - mq[i].x, dy = q.y - mq[i].y;
          hit = dx * dx + dy * dy <= R2;
        }
        if (hit) break;
      }
      if (hit) out.push(b);
    }
    return out.sort((a, b) => a.id - b.id);
  }

  function magnetPulling(game, magnet) {
    const fx = magnet.fx;
    return !!(fx.pull && fx.pull.length) && now(game) < fx.pullUntil;
  }

  // Set a block's horizontal and angular velocity, keeping its vertical velocity
  const vel = { x: 0, y: 0 };
  function steer(body, vx, w) {
    vel.x = vx;
    vel.y = body.getLinearVelocity().y;
    body.setLinearVelocity(vel);
    body.setAngularVelocity(w);
  }

  // Steer each pulled block toward its grid-aligned pose: angle -> the magnet's angle at
  // activation + the nearest k quarter turns (following its current angle would feed back:
  // turning a block that rests on the magnet tips the magnet, which turns the target...);
  // x -> the body origin the block will have once straight, snapped to the nearest lattice
  // column of the magnet's CURRENT pose, local y kept. Only horizontal and angular velocity
  // are set; gravity and contacts keep the vertical. A block that got there is let go.
  // Velocities are set once per frame, and over the frame's substeps friction takes up to
  // FRICTION * GRAVITY * h off a sliding block per substep (a small correction would never
  // move it at all), so that loss is added on top: the frame's AVERAGE speed is the
  // proportional one.
  function pullTargets(physics, magnet, dt) {
    const fx = magnet.fx, list = fx.pull, a0 = fx.gridAngle;
    const mb = magnet.body;
    const mp = mb.getPosition(), ma = mb.getAngle();
    const cos = Math.cos(ma), sin = Math.sin(ma);
    const gain = C.MAGNET_GAIN, cap = C.MAGNET_MAX_SPEED;
    const h = 1 / C.PHYSICS_HZ, t = clamp(dt || 0, 0, C.MAX_SUBSTEPS * h);
    const slip = C.FRICTION * C.GRAVITY * (t + h) / 2;
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i], body = b.body;
      if (b.dead || !body.isDynamic()) { list.splice(i, 1); continue; }
      const a = body.getAngle();
      const da = a0 + HALF_PI * Math.round((a - a0) / HALF_PI) - a;
      // Pivot of the turn: the angular pull turns a clearly tilted block about its centre of
      // mass, but a nearly straight one settles by tipping over its lowest corner. The pivot
      // slides between the two as the tilt shrinks, so the target never jumps.
      const p = body.getPosition(), c = body.getWorldCenter();
      let lowX = c.x, lowY = Infinity;
      for (const q of physics.cellQuads(b)) {
        const pts = q.pts;
        for (let k = 1; k < 8; k += 2) if (pts[k] < lowY) { lowY = pts[k]; lowX = pts[k - 1]; }
      }
      const s = Math.max(0, 1 - Math.abs(da) / MAGNET_PIVOT_TILT);
      const pivX = c.x + (lowX - c.x) * s, pivY = c.y + (lowY - c.y) * s;
      const rx = p.x - pivX, ry = p.y - pivY, cd = Math.cos(da), sd = Math.sin(da);
      const ox = pivX + rx * cd - ry * sd, oy = pivY + rx * sd + ry * cd;   // origin once straight
      const dx = ox - mp.x, dy = oy - mp.y;
      const lx = Math.round(dx * cos + dy * sin), ly = dy * cos - dx * sin;
      const err = mp.x + lx * cos - ly * sin - ox;
      if (Math.abs(err) < MAGNET_DONE_DIST && Math.abs(da) < MAGNET_DONE_ANGLE) {
        steer(body, 0, 0);
        list.splice(i, 1);
        continue;
      }
      steer(body, clamp(err * gain + Math.sign(err) * slip, -cap, cap), clamp(da * gain, -cap, cap));
      body.setAwake(true);
    }
  }

  // The pull is over: stop the corrective motion of blocks that did not get there (on an
  // oil slick they would otherwise keep sliding)
  function letGo(list) {
    for (const b of list) if (!b.dead && b.body.isDynamic()) steer(b.body, 0, 0);
  }

  // ---- Black hole ---------------------------------------------------------------------
  // Neighbour cells beside every side face, per shape (shapes are immutable)
  const horizonCache = new Map();
  function horizonCellsOf(shape) {
    let cells = horizonCache.get(shape.id);
    if (!cells) {
      const occ = new Set(shape.cells.map((c) => c[0] + ',' + c[1]));
      const seen = new Set();
      cells = [];
      for (const [cx, cy] of shape.cells) {
        for (const nx of [cx - 1, cx + 1]) {
          const k = nx + ',' + cy;
          if (occ.has(k) || seen.has(k)) continue;
          seen.add(k);
          cells.push(Object.freeze([nx, cy]));
        }
      }
      cells = Object.freeze(cells);
      horizonCache.set(shape.id, cells);
    }
    return cells;
  }

  // World AABBs of a hole's horizon squares (a square of half-size h rotated by a has an
  // AABB of half-extent h * (|cos a| + |sin a|) around its rotated centre)
  function horizonBoxes(hole, margin, out) {
    const body = hole.body;
    const p = body.getPosition(), a = body.getAngle();
    const cos = Math.cos(a), sin = Math.sin(a);
    const e = C.HORIZON_SIZE / 2 * (Math.abs(cos) + Math.abs(sin)) + margin;
    for (const [cx, cy] of hole.fx.horizonCells) {
      const lx = cx + 0.5, ly = cy + 0.5;
      const x = p.x + lx * cos - ly * sin, y = p.y + lx * sin + ly * cos;
      out.push({ minX: x - e, maxX: x + e, minY: y - e, maxY: y + e, hole });
    }
    return out;
  }

  function overlapsBox(physics, block, box) {
    for (const q of physics.cellQuads(block)) {
      if (q.maxX > box.minX && q.minX < box.maxX && q.maxY > box.minY && q.minY < box.maxY) return true;
    }
    return false;
  }

  // Spare every block already overlapping a horizon at activation. Box2D only evaluates a
  // contact once one of its bodies is awake and dynamic, so a sleeping neighbour of a
  // static (frozen) hole would report its begin-contact long after the grace window.
  function spareOverlapping(physics, hole) {
    const spared = hole.fx.spared;
    for (const box of horizonBoxes(hole, HORIZON_SPARE_MARGIN, [])) {
      physics.world.queryAABB({ lowerBound: { x: box.minX, y: box.minY }, upperBound: { x: box.maxX, y: box.maxY } }, (f) => {
        const ud = f.getUserData();
        const b = ud && ud.kind === 'solid' ? ud.block : null;
        if (b && b !== hole && !b.isPlatform && !b.dead && !spared.has(b.id) && overlapsBox(physics, b, box)) spared.add(b.id);
        return true;
      });
    }
  }

  // ---- Handler table ------------------------------------------------------------------
  // settle(game, block) · firstTouch(game, block, rec|null)
  // contact(game, self, other, rec, selfIsA) · canPetrify(game, block) -> bool
  const HANDLERS = {
    steel: {
      settle(game, block) {
        rememberResting(block);
        if (!game.physics.makeStatic(block, 'steel')) return;
        const c = centroid(block);
        emit(game, 'freeze', { blocks: [block], source: 'steel', x: c.x, y: c.y });
        bump(game, 'frozen');
      }
    },

    vine: {
      settle(game, vine) {
        const fx = vine.fx;
        if (fx.welds) return;
        const physics = game.physics;
        const welds = [], points = [];
        for (const { other, point } of neighbours(physics, vine)) {
          if (other.dead || (vine.body.isStatic() && other.body.isStatic())) continue;
          let pt = point;
          if (!pt) {
            const c = centroid(vine);
            const oc = other.isPlatform ? { x: c.x, y: other.top } : centroid(other);
            pt = { x: (c.x + oc.x) / 2, y: (c.y + oc.y) / 2 };
          }
          const joint = physics.weld(vine, other, pt);
          if (!joint) continue;
          const lp = vine.body.getLocalPoint(pt);
          welds.push({ x: lp.x, y: lp.y, partner: other, joint });
          points.push({ x: pt.x, y: pt.y });
        }
        fx.welds = welds;
        if (welds.length) {
          registry(physics).vines.add(vine); // so update() drops anchors whose partner is gone
          emit(game, 'weld', { block: vine, points });
          bump(game, 'welded', welds.length);
        }
      }
    },

    crystal: {
      settle(game, block) {
        if (block.fx.used) return;
        block.fx.used = true;
        if (!game.gainLife('crystal')) game.addShield();
      }
    },

    frost: {
      settle(game, frost) {
        if (frost.fx.used) return;
        frost.fx.used = true;
        const physics = game.physics;
        // Collect first: making a body static destroys its contact list
        const targets = neighbours(physics, frost);
        rememberResting(frost);
        for (const { other } of targets) rememberResting(other);
        const blocks = [];
        if (physics.makeStatic(frost, 'frost')) blocks.push(frost);
        for (const { other } of targets) {
          if (!other.isPlatform && physics.makeStatic(other, 'frost')) blocks.push(other);
        }
        if (!blocks.length) return;
        const c = centroid(frost);
        emit(game, 'freeze', { blocks, source: 'frost', x: c.x, y: c.y });
        bump(game, 'frozen', blocks.length);
      }
    },

    crumble: {
      firstTouch(game, block) { shatterBlock(game, block, 'crumble'); }
    },

    magnet: {
      settle(game, magnet) {
        const fx = magnet.fx;
        if (fx.used) return;
        fx.used = true;
        const targets = magnetTargets(game.physics, magnet);
        fx.targets = targets.map((b) => b.id);
        fx.pullUntil = now(game) + C.MAGNET_TIME;
        fx.gridAngle = magnet.body.getAngle();
        fx.pull = targets;
        if (targets.length) registry(game.physics).magnets.add(magnet);
        const c = centroid(magnet);
        emit(game, 'magnet', { block: magnet, x: c.x, y: c.y, count: targets.length });
        bump(game, 'magnetized', targets.length);
      },
      canPetrify: (game, magnet) => !magnetPulling(game, magnet)
    },

    mine: {
      settle(game, mine) {
        const fx = mine.fx;
        if (fx.armed) return;
        fx.armed = true;
        fx.lit = false;
        fx.ignoreIds = restingOn(game.physics, mine, MINE_TRIGGER_NY);
        registry(game.physics).mines.add(mine);
        emit(game, 'mineArmed', { block: mine });
      },
      contact(game, mine, other, rec, selfIsA) {
        const fx = mine.fx;
        if (!fx.armed || fx.lit || rec.sensor || other.isPlatform || other.dead) return;
        if (fx.ignoreIds && fx.ignoreIds.has(other.id)) return;
        if (onTop(game, mine, other, rec, selfIsA, MINE_TRIGGER_NY)) lightMine(game, mine);
      },
      canPetrify: (game, mine) => !mine.fx.lit
    },

    // Breaks into rubble (keeping its look) the first time a block lands on it once armed.
    // Static (frozen / petrified) glass is immune: physics.shatter refuses static bodies.
    glass: {
      settle(game, glass) {
        const fx = glass.fx;
        if (fx.armed) return;
        fx.armed = true;
        fx.ignoreIds = restingOn(game.physics, glass, ON_TOP_NY);
        registry(game.physics).glass.add(glass);
      },
      contact(game, glass, other, rec, selfIsA) {
        const fx = glass.fx;
        if (!fx.armed || rec.sensor || other.isPlatform || other.dead || !other.body.isDynamic()) return;
        if (fx.ignoreIds.has(other.id) || !onTop(game, glass, other, rec, selfIsA, ON_TOP_NY)) return;
        shatterBlock(game, glass, 'glass');
      }
    },

    // Destroys whatever lands on top of it (not lost: no life). Static spikes still work.
    spikes: {
      settle(game, spikes) {
        const fx = spikes.fx;
        if (fx.active) return;
        fx.active = true;
        fx.ignoreIds = restingOn(game.physics, spikes, ON_TOP_NY);
        registry(game.physics).spikes.add(spikes);
      },
      contact(game, spikes, other, rec, selfIsA) {
        const fx = spikes.fx;
        if (!fx.active || rec.sensor || other.isPlatform || other.dead || !other.body.isDynamic()) return;
        if (fx.ignoreIds.has(other.id) || !onTop(game, spikes, other, rec, selfIsA, ON_TOP_NY)) return;
        const c = centroid(other);
        emit(game, 'pop', { block: other, x: c.x, y: c.y, spikes }); // before removal: renderer needs its look
        game.physics.removeBlock(other, 'popped');
        bump(game, 'popped');
      }
    },

    magma: {
      settle(game, block) {
        if (block.fx.turnsLeft != null) return;
        block.fx.turnsLeft = C.MAGMA_TURNS;
        registry(game.physics).magma.add(block);
      }
    },

    anvil: {
      firstTouch(game, anvil, rec) {
        anvil.fx.impactUntil = now(game) + C.ANVIL_IMPACT_WINDOW;
        if (rec) {
          if (rec.sensor) return;
          if (rec.a === anvil) smash(game, anvil, rec.b, normalY(rec, true));
          else if (rec.b === anvil) smash(game, anvil, rec.a, normalY(rec, false));
        } else {
          for (const t of game.physics.touching(anvil)) smash(game, anvil, t.other, t.normal ? t.normal.y : null);
        }
      },
      contact(game, anvil, other, rec, selfIsA) {
        if (!rec.sensor && impactActive(game, anvil)) smash(game, anvil, other, normalY(rec, selfIsA));
      },
      canPetrify: (game, anvil) => !impactActive(game, anvil)
    },

    blackhole: {
      settle(game, hole) {
        const fx = hole.fx;
        if (fx.active) return;
        const physics = game.physics;
        const cells = horizonCellsOf(hole.shape);
        const h = C.HORIZON_SIZE / 2;
        physics.addSensors(hole, cells.map(([x, y]) => ({ x0: x + 0.5 - h, y0: y + 0.5 - h, x1: x + 0.5 + h, y1: y + 0.5 + h })), 'horizon');
        fx.horizonCells = cells;
        fx.active = true;
        fx.graceUntil = physics.stepCount + C.HORIZON_GRACE_STEPS;
        fx.spared = new Set();
        spareOverlapping(physics, hole);
        // Awake, so overlaps report their begin-contact within the grace substeps
        if (!hole.body.isStatic()) hole.body.setAwake(true);
        registry(physics).holes.add(hole);
      },
      contact(game, hole, other, rec, selfIsA) {
        if (!rec.sensor) return;
        if ((selfIsA ? rec.tagA : rec.tagB) !== 'horizon' || (selfIsA ? rec.kindB : rec.kindA) !== 'solid') return;
        const fx = hole.fx;
        if (!fx.active || other.isPlatform || other.dead || other === hole || other.typeKey === 'blackhole') return;
        if (!other.body.isDynamic() || fx.spared.has(other.id)) return;
        const physics = game.physics;
        if (physics.stepCount <= fx.graceUntil) { fx.spared.add(other.id); return; }
        const c = centroid(other);
        emit(game, 'swallow', { block: other, x: c.x, y: c.y, hole }); // before removal: renderer needs its look
        physics.removeBlock(other, 'swallowed');
        bump(game, 'swallowed');
      },
      canPetrify: (game, hole) => !(hole.fx.active && game.physics.stepCount <= hole.fx.graceUntil)
    }
  };
  for (const k of Object.keys(HANDLERS)) Object.freeze(HANDLERS[k]);
  Object.freeze(HANDLERS);

  // ---- Dispatchers (called by game.js) ------------------------------------------------
  function onFirstTouch(game, block, info) {
    if (!block || block.dead || block.isPlatform) return;
    const h = HANDLERS[block.typeKey];
    if (h && h.firstTouch) h.firstTouch(game, block, info || null);
  }

  function onContact(game, rec) {
    if (!rec || !rec.a || !rec.b) return;
    const a = rec.a, b = rec.b;
    let h = !a.dead && !a.isPlatform && HANDLERS[a.typeKey];
    if (h && h.contact) h.contact(game, a, b, rec, true);
    h = !b.dead && !b.isPlatform && HANDLERS[b.typeKey]; // evaluated after a's handler, which may have killed b
    if (h && h.contact) h.contact(game, b, a, rec, false);
  }

  function onSettle(game, block) {
    if (!block || block.dead || block.isPlatform) return;
    const h = HANDLERS[block.typeKey];
    if (h && h.settle) h.settle(game, block);
  }

  function onTurnStart(game) {
    const physics = game.physics;
    const r = registry(physics);
    for (const set of [r.holes, r.mines, r.spikes, r.glass]) for (const b of set) if (b.dead) set.delete(b);
    const magma = r.magma;
    for (const m of magma) {
      if (m.dead) { magma.delete(m); continue; }
      if (m.fx.turnsLeft == null) continue;
      m.fx.turnsLeft--;
      if (m.fx.turnsLeft > 0) continue;
      magma.delete(m);
      const c = centroid(m);
      emit(game, 'melt', { block: m, x: c.x, y: c.y });
      physics.removeBlock(m, 'melted');
      bump(game, 'melted');
    }
  }

  function hasJoint(body, joint) {
    for (let je = body.getJointList(); je; je = je.next) if (je.joint === joint) return true;
    return false;
  }

  function update(game, dt) {
    const r = registry(game.physics);
    const fuses = r.fuses, magnets = r.magnets, vines = r.vines;
    // A weld dies with its partner (shattered, popped, swallowed, melted, lost...): drop its
    // anchor so the vine stops drawing it. Blocks only die when physics.version changes.
    if (vines.size && r.weldsVersion !== game.physics.version) {
      r.weldsVersion = game.physics.version;
      for (const v of vines) {
        const w = v.fx.welds;
        if (!v.dead) for (let i = w.length - 1; i >= 0; i--) if (w[i].partner.dead || !hasJoint(v.body, w[i].joint)) w.splice(i, 1);
        if (v.dead || !w.length) vines.delete(v);
      }
    }
    for (const mine of fuses) {
      if (mine.dead) { fuses.delete(mine); continue; }
      mine.fx.fuse -= dt;
      if (mine.fx.fuse > 0) continue;
      fuses.delete(mine);
      detonate(game, mine);
    }
    for (const m of magnets) {
      const on = !m.dead && magnetPulling(game, m);
      if (on) pullTargets(game.physics, m, dt);
      else letGo(m.fx.pull);
      if (!on || !m.fx.pull.length) { magnets.delete(m); m.fx.pull = null; }
    }
  }

  // Radial blast: dv = impulse * (1 - d/R) on every live dynamic block within R, pushed
  // away from (x, y) with an upward bias. opts: { radius, impulse, exclude: block }.
  // Static blocks are not pushed; nothing is marked lost here (game.js detects falls).
  function explode(game, x, y, opts) {
    const o = opts || {};
    const R = o.radius != null ? o.radius : C.MINE_RADIUS;
    const impulse = o.impulse != null ? o.impulse : C.MINE_IMPULSE;
    let pushed = 0;
    if (R > 0) {
      for (const b of game.physics.blocksInRadius(x, y, R)) {
        if (b.dead || b === o.exclude) continue;
        const body = b.body;
        if (!body.isDynamic()) continue;
        const c = body.getWorldCenter();
        const dx = c.x - x, dy = c.y - y;
        const fall = 1 - Math.max(EXPLODE_MIN_DIST, Math.sqrt(dx * dx + dy * dy)) / R;
        if (fall <= 0) continue;
        let ux = dx, uy = dy + C.MINE_UPWARD_BIAS;
        const len = Math.sqrt(ux * ux + uy * uy);
        if (len < 1e-6) { ux = 0; uy = 1; } else { ux /= len; uy /= len; }
        const j = impulse * fall * body.getMass();
        body.applyLinearImpulse({ x: ux * j, y: uy * j }, { x: c.x, y: c.y }, true);
        body.setAngularVelocity(body.getAngularVelocity() + (Math.random() * 2 - 1) * EXPLODE_SPIN * fall); // cosmetic
        pushed++;
      }
    }
    emit(game, 'explode', { x, y, radius: R });
    return pushed;
  }

  function canPetrify(game, block) {
    if (!block || block.dead) return false;
    const h = HANDLERS[block.typeKey];
    return h && h.canPetrify ? !!h.canPetrify(game, block) : true;
  }

  // For placement warnings: horizon squares of live active holes (world AABBs) and the
  // ids of live armed mines, live active spikes and live armed glass that can still break
  // (frozen glass is immune, so it leaves the registry for good).
  function hazards(game) {
    const r = registry(game.physics);
    const horizons = [];
    const mines = new Set(), spikes = new Set(), glass = new Set();
    for (const hole of r.holes) {
      if (hole.dead) r.holes.delete(hole);
      else if (hole.fx.active) horizonBoxes(hole, 0, horizons);
    }
    for (const mine of r.mines) {
      if (mine.dead) r.mines.delete(mine);
      else if (mine.fx.armed) mines.add(mine.id);
    }
    for (const s of r.spikes) {
      if (s.dead) r.spikes.delete(s);
      else if (s.fx.active) spikes.add(s.id);
    }
    for (const g of r.glass) {
      if (g.dead || g.body.isStatic()) r.glass.delete(g);
      else if (g.fx.armed) glass.add(g.id);
    }
    return { horizons, mines, spikes, glass };
  }

  TT.Effects = {
    HANDLERS,
    onFirstTouch, onContact, onSettle, onTurnStart, update,
    explode, canPetrify, hazards,
    centroid, neighbours
  };
})(typeof window !== 'undefined' ? (window.TT = window.TT || {}) : (global.TT = global.TT || {}));
