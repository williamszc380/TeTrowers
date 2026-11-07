/* TeTrowers — physics core (planck.js wrapper).
 *
 * Owns the Box2D world, the platform, every block body and its exact world geometry.
 * RULES (Box2D): never create/destroy bodies, fixtures or joints, or change body type,
 * while world.isLocked() (i.e. inside contact callbacks). Contact callbacks therefore
 * only RECORD events into a queue; the game drains it after each substep and acts then.
 *
 * Performance model: settled blocks deep in the tower are made static ("petrified"),
 * so the solver only ever works on the top band of the tower. Static/sleeping bodies
 * also keep cached world geometry, so per-frame scans cost almost nothing for them.
 */
(function (TT) {
  'use strict';
  const C = TT.CONFIG;
  const pl = (typeof planck !== 'undefined') ? planck
    : (typeof window !== 'undefined' && window.planck) ? window.planck
      : (typeof global !== 'undefined' ? global.planck : null);
  if (!pl) throw new Error('planck.js must be loaded before physics.js');

  const SKIN = pl.Settings.polygonRadius; // Box2D polygon skin; subtracted so solids are exactly 1 tall

  // ---- Forgiving collision polygons -------------------------------------------------
  // Each shape rectangle becomes one convex polygon: skin removed on every side, outer
  // left/right faces inset by CELL_INSET, and every CONVEX outer corner chamfered so a
  // near miss slides into place instead of snagging on a corner pixel. Corners where two
  // rectangles of the same piece meet stay square, so faces have no internal notches.
  function rectPolygon(shape, r, inset, chamfer) {
    const occ = new Set(shape.cells.map((c) => c[0] + ',' + c[1]));
    const has = (x, y) => occ.has(x + ',' + y);
    const convex = (px, py) =>
      (has(px - 1, py - 1) ? 1 : 0) + (has(px, py - 1) ? 1 : 0) + (has(px - 1, py) ? 1 : 0) + (has(px, py) ? 1 : 0) === 1;

    let leftExt = true, rightExt = true;
    for (let y = r.y0; y < r.y1; y++) {
      if (has(r.x0 - 1, y)) leftExt = false;
      if (has(r.x1, y)) rightExt = false;
    }
    const xl = r.x0 + SKIN + (leftExt ? inset : 0);
    const xr = r.x1 - SKIN - (rightExt ? inset : 0);
    const yb = r.y0 + SKIN;
    const yt = r.y1 - SKIN;
    const c = Math.min(chamfer, (xr - xl) * 0.3, (yt - yb) * 0.3);
    const cBL = convex(r.x0, r.y0) ? c : 0;
    const cBR = convex(r.x1, r.y0) ? c : 0;
    const cTR = convex(r.x1, r.y1) ? c : 0;
    const cTL = convex(r.x0, r.y1) ? c : 0;

    const pts = [];
    const add = (x, y) => {
      const last = pts[pts.length - 1];
      if (!last || Math.abs(last.x - x) > 1e-6 || Math.abs(last.y - y) > 1e-6) pts.push({ x, y });
    };
    add(xl + cBL, yb); add(xr - cBR, yb);
    add(xr, yb + cBR); add(xr, yt - cTR);
    add(xr - cTR, yt); add(xl + cTL, yt);
    add(xl, yt - cTL); add(xl, yb + cBL);
    const first = pts[0], last = pts[pts.length - 1];
    if (Math.abs(first.x - last.x) < 1e-6 && Math.abs(first.y - last.y) < 1e-6) pts.pop();
    return new pl.Polygon(pts);
  }

  // Polygon cache per shape id (shapes are immutable, so polygons can be shared)
  const polygonCache = new Map();
  function shapePolygons(shape) {
    let polys = polygonCache.get(shape.id);
    if (!polys) {
      polys = shape.rects.map((r) => rectPolygon(shape, r, C.CELL_INSET, C.CHAMFER));
      polygonCache.set(shape.id, polys);
    }
    return polys;
  }

  // ---- Physics world ------------------------------------------------------------------
  class PhysicsWorld {
    constructor() {
      this.world = new pl.World({ gravity: { x: 0, y: -C.GRAVITY }, allowSleep: true });
      this.blocks = [];       // live blocks in creation order
      this.movers = [];       // live blocks whose body is not static
      this.nextId = 1;
      this.time = 0;
      this.stepCount = 0;
      this.version = 0;       // bumps whenever blocks are added/removed/frozen
      this._acc = 0;
      this._contacts = [];
      this.platform = this._createPlatform();
      this.world.on('begin-contact', (c) => this._onBeginContact(c));
    }

    _createPlatform() {
      const x0 = C.PLATFORM_X0, x1 = C.PLATFORM_X1, top = C.PLATFORM_TOP, depth = C.PLATFORM_DEPTH;
      const body = this.world.createBody({ type: 'static', position: { x: 0, y: 0 } });
      // Chamfer only the two top corners (bottom is never touched)
      const c = C.CHAMFER;
      const yt = top - SKIN, yb = top - depth, xl = x0 + SKIN, xr = x1 - SKIN;
      const poly = new pl.Polygon([{ x: xl, y: yb }, { x: xr, y: yb }, { x: xr, y: yt - c }, { x: xr - c, y: yt }, { x: xl + c, y: yt }, { x: xl, y: yt - c }]);
      const platform = {
        id: 0, isPlatform: true, typeKey: 'platform', type: null, body, dead: false, frozen: 'platform',
        x0, x1, top, cells: [], fx: {}
      };
      body.createFixture(poly, { friction: C.FRICTION, density: 0, userData: { block: platform, kind: 'solid' } });
      body.setUserData(platform);
      return platform;
    }

    // spec: { typeKey, shapeId, n? }. (x, y) = world position of the piece's local origin
    // (its min cell corner). opts: { angle, vx, vy, w, look, cracked, tint }
    createBlock(spec, x, y, opts) {
      this._assertUnlocked('createBlock');
      const o = opts || {};
      const type = TT.BLOCK_TYPES[spec.typeKey];
      const shape = TT.SHAPES[spec.shapeId];
      if (!type || !shape) throw new Error('Unknown block spec ' + JSON.stringify(spec));
      const body = this.world.createBody({
        type: 'dynamic',
        position: { x, y },
        angle: o.angle || 0,
        linearVelocity: { x: o.vx || 0, y: o.vy || 0 },
        angularVelocity: o.w || 0,
        linearDamping: C.LINEAR_DAMPING,
        angularDamping: C.ANGULAR_DAMPING,
        allowSleep: true
      });
      const block = {
        id: this.nextId++,
        n: spec.n == null ? -1 : spec.n,
        typeKey: spec.typeKey,
        type,
        shapeId: shape.id,
        shape,
        cells: shape.cells,
        look: o.look || spec.typeKey,                  // visual style key (rubble keeps its origin's)
        tint: o.tint || (spec.typeKey === 'normal' ? TT.NORMAL_TINTS[shape.family] : null),
        cracked: !!o.cracked,
        body,
        isPlatform: false,
        dropped: false, dropTime: -1, dropTurn: -1,
        touched: false, touchTime: -1,
        settled: false, stillTime: 0, settledFor: 0, activated: false,
        frozen: null,                                  // 'steel' | 'frost' | 'petrified' once static
        dead: false, deathReason: null,
        fx: {},                                        // per-type state, owned by effects.js
        guide: null,                                   // assisted guided-fall state, owned by game.js
        lastVel: { x: o.vx || 0, y: o.vy || 0 },
        _q: null, _qx: NaN, _qy: NaN, _qa: NaN         // cached world geometry
      };
      for (const poly of shapePolygons(shape)) {
        body.createFixture(poly, {
          density: type.density, friction: type.friction, restitution: type.restitution,
          userData: { block, kind: 'solid' }
        });
      }
      body.setUserData(block);
      this.blocks.push(block);
      this.movers.push(block);
      this.version++;
      return block;
    }

    removeBlock(block, reason) {
      if (!block || block.dead || block.isPlatform) return;
      this._assertUnlocked('removeBlock');
      block.dead = true;
      block.deathReason = reason || 'removed';
      this.world.destroyBody(block.body); // also destroys its joints and contacts
      removeFrom(this.blocks, block);
      removeFrom(this.movers, block);
      this.version++;
    }

    // Freeze a block in place. reason: 'steel' | 'frost' | 'petrified'
    makeStatic(block, reason) {
      if (!block || block.dead || block.isPlatform || block.body.isStatic()) return false;
      this._assertUnlocked('makeStatic');
      block.body.setLinearVelocity({ x: 0, y: 0 });
      block.body.setAngularVelocity(0);
      block.body.setStatic();
      block.frozen = reason || 'frozen';
      block.lastVel = { x: 0, y: 0 };
      removeFrom(this.movers, block);
      this.version++;
      return true;
    }

    // Rigid weld between two blocks (or a block and the platform) at a world point
    weld(a, b, worldPoint) {
      this._assertUnlocked('weld');
      if (!a || !b || a === b || a.dead || b.dead) return null;
      if (a.body.isStatic() && b.body.isStatic()) return null;
      return this.world.createJoint(new pl.WeldJoint({ frequencyHz: 0, dampingRatio: 0, collideConnected: false }, a.body, b.body, worldPoint));
    }

    // Sensor rectangles in the block's local cell frame: [{x0, y0, x1, y1}], tagged
    addSensors(block, rects, tag) {
      this._assertUnlocked('addSensors');
      const out = [];
      for (const r of rects) {
        const poly = new pl.Polygon([{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }]);
        out.push(block.body.createFixture(poly, { isSensor: true, density: 0, userData: { block, kind: 'sensor', tag } }));
      }
      return out;
    }

    // Break a block into 1x1 'rubble' blocks that keep its exact pose and motion.
    // Static blocks are immune unless force is set. Returns the new blocks.
    shatter(block, force) {
      if (!block || block.dead || block.isPlatform) return [];
      if (block.body.isStatic() && !force) return [];
      if (block.cells.length <= 1 && block.typeKey === 'rubble') return [block];
      this._assertUnlocked('shatter');
      const body = block.body;
      const angle = body.getAngle();
      const v = body.getLinearVelocity();
      const w = body.isStatic() ? 0 : body.getAngularVelocity();
      const wc = body.getWorldCenter();
      const vx0 = body.isStatic() ? 0 : v.x, vy0 = body.isStatic() ? 0 : v.y;
      const parts = [];
      const poses = block.cells.map(([cx, cy]) => ({
        o: body.getWorldPoint({ x: cx, y: cy }),
        c: body.getWorldPoint({ x: cx + 0.5, y: cy + 0.5 })
      }));
      const look = block.look, tint = block.tint, n = block.n, dropTurn = block.dropTurn;
      this.removeBlock(block, 'shattered');
      for (const { o, c } of poses) {
        const part = this.createBlock({ typeKey: 'rubble', shapeId: 'P1', n }, o.x, o.y, {
          angle, w, look, tint, cracked: true,
          vx: vx0 - w * (c.y - wc.y),
          vy: vy0 + w * (c.x - wc.x)
        });
        part.dropped = true; part.touched = true; part.activated = true; part.dropTurn = dropTurn;
        part.touchTime = this.time; part.dropTime = this.time;
        parts.push(part);
      }
      return parts;
    }

    // Advance by a frame's dt using fixed substeps. hooks: { beforeSubstep(h), afterSubstep(h) }
    step(dt, hooks) {
      this._acc += Math.min(Math.max(dt, 0), C.MAX_FRAME_DT);
      const h = 1 / C.PHYSICS_HZ;
      let n = 0;
      while (this._acc >= h - 1e-9 && n < C.MAX_SUBSTEPS) {
        if (hooks && hooks.beforeSubstep) hooks.beforeSubstep(h);
        for (const b of this.movers) {
          const v = b.body.getLinearVelocity();
          b.lastVel.x = v.x; b.lastVel.y = v.y;
        }
        this.world.step(h, C.VEL_ITERS, C.POS_ITERS);
        this._acc -= h;
        this.time += h;
        this.stepCount++;
        n++;
        if (hooks && hooks.afterSubstep) hooks.afterSubstep(h);
      }
      if (n === C.MAX_SUBSTEPS && this._acc > h) this._acc = 0; // too slow: drop the backlog
      return n;
    }

    // Contact events recorded since the last drain:
    // { a, b, kindA, kindB, tagA, tagB, sensor, normal (a->b) | null, point | null, time }
    drainContacts() {
      const out = this._contacts;
      this._contacts = [];
      return out;
    }

    _onBeginContact(contact) {
      const fa = contact.getFixtureA(), fb = contact.getFixtureB();
      const ua = fa.getUserData(), ub = fb.getUserData();
      if (!ua || !ub) return;
      const sensor = fa.isSensor() || fb.isSensor();
      let normal = null, point = null;
      if (!sensor) {
        const wm = contact.getWorldManifold(null);
        if (wm) {
          normal = { x: wm.normal.x, y: wm.normal.y };
          const count = wm.pointCount != null ? wm.pointCount : (wm.points ? wm.points.length : 0);
          if (count > 0) {
            let px = 0, py = 0;
            for (let i = 0; i < count; i++) { px += wm.points[i].x; py += wm.points[i].y; }
            point = { x: px / count, y: py / count };
          }
        }
      }
      this._contacts.push({
        a: ua.block, b: ub.block, kindA: ua.kind, kindB: ub.kind,
        tagA: ua.tag || null, tagB: ub.tag || null, sensor, normal, point, time: this.time
      });
    }

    // Blocks currently touching `block` through solid fixtures:
    // [{ other, normal (from block to other), point }]
    touching(block) {
      const out = [];
      if (!block || block.dead) return out;
      for (let ce = block.body.getContactList(); ce; ce = ce.next) {
        const c = ce.contact;
        if (!c.isTouching()) continue;
        const fa = c.getFixtureA(), fb = c.getFixtureB();
        if (fa.isSensor() || fb.isSensor()) continue;
        const other = ce.other && ce.other.getUserData();
        if (!other) continue;
        const wm = c.getWorldManifold(null);
        let normal = null, point = null;
        if (wm) {
          const flip = fa.getBody() !== block.body; // manifold normal points from A to B
          normal = { x: flip ? -wm.normal.x : wm.normal.x, y: flip ? -wm.normal.y : wm.normal.y };
          const count = wm.pointCount != null ? wm.pointCount : (wm.points ? wm.points.length : 0);
          if (count > 0) {
            let px = 0, py = 0;
            for (let i = 0; i < count; i++) { px += wm.points[i].x; py += wm.points[i].y; }
            point = { x: px / count, y: py / count };
          }
        }
        if (!out.some((t) => t.other === other)) out.push({ other, normal, point });
      }
      return out;
    }

    // Exact world geometry of each visual cell (unit squares, NOT the inset collision
    // shapes). Cached while the body has not moved.
    // [{ cx, cy, pts: [x0,y0, x1,y1, x2,y2, x3,y3] (BL, BR, TR, TL), minX, maxX, minY, maxY, x, y }]
    cellQuads(block) {
      const body = block.body;
      const p = body.getPosition();
      const a = body.getAngle();
      if (block._q && p.x === block._qx && p.y === block._qy && a === block._qa) return block._q;
      const cos = Math.cos(a), sin = Math.sin(a);
      const q = block._q && block._q.length === block.cells.length ? block._q : block.cells.map(() => ({ pts: new Array(8) }));
      for (let i = 0; i < block.cells.length; i++) {
        const cx = block.cells[i][0], cy = block.cells[i][1];
        const quad = q[i];
        const pts = quad.pts;
        const lx = [cx, cx + 1, cx + 1, cx], ly = [cy, cy, cy + 1, cy + 1];
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let k = 0; k < 4; k++) {
          const wx = p.x + lx[k] * cos - ly[k] * sin;
          const wy = p.y + lx[k] * sin + ly[k] * cos;
          pts[k * 2] = wx; pts[k * 2 + 1] = wy;
          if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
          if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
        }
        quad.cx = cx; quad.cy = cy;
        quad.minX = minX; quad.maxX = maxX; quad.minY = minY; quad.maxY = maxY;
        quad.x = p.x + (cx + 0.5) * cos - (cy + 0.5) * sin;
        quad.y = p.y + (cx + 0.5) * sin + (cy + 0.5) * cos;
      }
      block._q = q; block._qx = p.x; block._qy = p.y; block._qa = a;
      return q;
    }

    // Exact (not Box2D's fattened) bounds of a block's visual cells
    bounds(block) {
      const q = this.cellQuads(block);
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const c of q) {
        if (c.minX < minX) minX = c.minX; if (c.maxX > maxX) maxX = c.maxX;
        if (c.minY < minY) minY = c.minY; if (c.maxY > maxY) maxY = c.maxY;
      }
      return { minX, maxX, minY, maxY };
    }

    // Live blocks with any cell centre within r of (x, y). Uses the broadphase.
    blocksInRadius(x, y, r) {
      const found = new Set();
      this.world.queryAABB({ lowerBound: { x: x - r, y: y - r }, upperBound: { x: x + r, y: y + r } }, (fixture) => {
        const ud = fixture.getUserData();
        if (ud && ud.block && !ud.block.isPlatform && !ud.block.dead) found.add(ud.block);
        return true;
      });
      const out = [];
      for (const b of found) {
        for (const c of this.cellQuads(b)) {
          if ((c.x - x) * (c.x - x) + (c.y - y) * (c.y - y) <= r * r) { out.push(b); break; }
        }
      }
      return out;
    }

    anyAwake() {
      for (const b of this.movers) if (b.body.isAwake()) return true;
      return false;
    }

    _assertUnlocked(what) {
      if (this.world.isLocked()) throw new Error('physics.' + what + '() called while the world is locked (inside a contact callback)');
    }
  }

  function removeFrom(arr, item) {
    const i = arr.indexOf(item);
    if (i >= 0) arr.splice(i, 1);
  }

  TT.Physics = { PhysicsWorld, create: () => new PhysicsWorld(), rectPolygon, SKIN };
})(typeof window !== 'undefined' ? (window.TT = window.TT || {}) : (global.TT = global.TT || {}));
