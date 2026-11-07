/* TeTrowers — game state machine.
 *
 * One Game = one run on one seed. It owns the physics world and turns player intent
 * (move / select / drop / mode) into world changes, and world changes into rules:
 * turns, lives, settling, petrify, height, milestones, batches. Presentation modules
 * read its fields and listen to its events (see docs/ARCHITECTURE.md §4); they never
 * mutate it except through the public methods.
 *
 * Frame order (update):
 *   physics substeps (falling-block guidance before each, contact processing after each)
 *   -> effects timers -> settle/fall/lost/petrify tracking -> height & milestones
 *   -> drop readiness -> batch dealing -> hover line -> placement surface & ghost
 */
(function (TT) {
  'use strict';
  const C = TT.CONFIG;
  const { clamp, Emitter } = TT.Util;

  const SURFACE_INTERVAL = 0.1;  // s between placement-surface rebuilds while blocks move
  const PETRIFY_INTERVAL = 0.25; // s between petrify sweeps
  const ENDING_DELAY = 1.5;      // s between the last life lost and 'gameOver'
  const OVER_SIM_TIME = 6;       // s the world keeps simulating behind the game-over screen
  const FALL_END_TIME = (C.FALL_END_TIME != null ? C.FALL_END_TIME : 0.5);   // s calm (speed <= UNSETTLE_SPEED) that end a fall
  const READY_FALL_MAX = (C.READY_FALL_MAX != null ? C.READY_FALL_MAX : 10); // s after a drop: ready even while blocks still fall

  class Game {
    constructor(options) {
      const o = options || {};
      const seed = TT.RNG.normalizeSeed(o.seed) || TT.RNG.randomSeed();
      this.generator = TT.Generator.create(seed, { enabledTypes: o.enabledTypes });
      this.seed = this.generator.seed;
      this.rules = this.generator.rules;
      this.enabledTypes = this.generator.enabled;
      this.events = new Emitter();
      this.physics = TT.Physics.create();

      this.state = 'playing';
      this.mode = C.MODES.includes(o.mode) ? o.mode : C.DEFAULT_MODE;
      this.lives = C.START_LIVES;
      this.maxLives = C.MAX_LIVES;
      this.shield = false;
      this.height = 0;
      this.bestHeight = 0;
      this.towerTop = C.PLATFORM_TOP;
      this.nextMilestone = C.LIFE_MILESTONE;
      this.turn = 0;
      this.round = 0;
      this.batch = [];
      this.selected = -1;
      this.piece = null;
      this.ghost = null;
      this.canDrop = false;
      this.readyProgress = 1;
      this.hoverY = Math.max(C.MIN_HOVER_Y, C.PLATFORM_TOP + C.DROP_GAP);
      this.pixelSize = 1 / 40;
      this.time = 0;
      this.elapsed = 0;
      this.odds = TT.Generator.typeOdds(0, this.enabledTypes);
      this.ending = false;
      this.stats = { drops: 0, lost: 0, livesLost: 0, swallowed: 0, popped: 0, exploded: 0, shattered: 0, melted: 0, frozen: 0, welded: 0, magnetized: 0 };

      this._lastDropped = null;
      this._ready = true;
      this._falling = false;         // a mover other than the falling new piece is still in motion
      this._chargedTurns = new Set(); // turns whose falls already cost a life (or the shield)
      this._pendingBatch = true;     // first batch is dealt on the first update, after listeners attach
      this._endTimer = 0;
      this._overTime = 0;
      this._lastCenter = C.FIELD_WIDTH / 2;
      this._rawX = null;
      this._surface = null;
      this._surfaceVersion = -1;
      this._surfaceAge = Infinity;
      this._exclude = new Set();
      this._moving = true;
      this._staticTop = C.PLATFORM_TOP;
      this._staticTopVersion = -1;
      this._petrifyTimer = 0;
      this._scratch = [];
      this._hooks = {
        beforeSubstep: () => this._beforeSubstep(),
        afterSubstep: () => this._afterSubstep()
      };

      // Blocks frozen by another block before they ever settled still get their own effect
      // (e.g. a moving mine frozen by frost must still arm).
      this.on('freeze', (p) => {
        for (const b of p.blocks || []) {
          if (b && !b.dead && !b.isPlatform) {
            b.settled = true;
            if (!b.activated) this._activate(b);
          }
        }
      });
    }

    // ---- events ---------------------------------------------------------------------
    on(name, fn) { return this.events.on(name, fn); }
    off(name, fn) { this.events.off(name, fn); }
    emit(name, payload) { this.events.emit(name, payload || {}); }

    // ---- main update ----------------------------------------------------------------
    update(dt) {
      if (this.state === 'paused' || !this.physics) return;
      dt = Math.min(Math.max(dt || 0, 0), C.MAX_FRAME_DT);
      if (this.state === 'over') {
        if (this._overTime >= OVER_SIM_TIME) return;
        this._overTime += dt;
      } else if (!this.ending) {
        this.elapsed += dt;
      }

      this.physics.step(dt, this._hooks);
      this.time = this.physics.time;
      TT.Effects.update(this, dt);
      this._trackBlocks(dt);
      this._updateHeight();
      if (this.state === 'over') return;

      if (this.ending) {
        this._endTimer -= dt;
        if (this._endTimer <= 0) {
          this.state = 'over';
          this.emit('gameOver', this.summary());
        }
        return;
      }
      this._updateReady();
      if (this._pendingBatch && this._ready) this._dealBatch();
      this._updateHover(dt);
      this._refreshPlacement(dt);
      this.canDrop = this._ready && !!this.piece && this.state === 'playing' && !this.ending;
    }

    // Before every substep: cap the falling speed of dropped-but-not-landed blocks and
    // apply the assisted-mode guided fall (track the target support if it drifts).
    _beforeSubstep() {
      const movers = this.physics.movers;
      for (let i = 0; i < movers.length; i++) {
        const b = movers[i];
        if (!b.dropped || b.touched) continue;
        const body = b.body;
        const v = body.getLinearVelocity();
        let vx = v.x, vy = v.y, changed = false;
        if (vy < -C.MAX_FALL_SPEED) { vy = -C.MAX_FALL_SPEED; changed = true; }
        const g = b.guide;
        if (g) {
          const sb = g.block.dead ? null : g.block.body;
          const want = sb && sb.getWorldPoint(g.local);
          if (!want || Math.abs(want.x - g.startWant) > C.GUIDE_MAX_CORRECTION) {
            // Support gone or drifted too far: drop the chase speed (a piece is released with
            // none) and fall straight down from here
            b.guide = null;
            vx = 0;
          } else {
            // Feed-forward of the landing spot's own velocity, plus a pull toward it
            vx = clamp(sb.getLinearVelocityFromWorldPoint(want).x + (want.x - body.getPosition().x) * C.GUIDE_GAIN,
              -C.GUIDE_MAX_SPEED, C.GUIDE_MAX_SPEED);
          }
          changed = true;
        }
        if (changed) body.setLinearVelocity({ x: vx, y: vy });
      }
    }

    // After every substep: the world is unlocked, so contact consequences happen here.
    _afterSubstep() {
      const recs = this.physics.drainContacts();
      for (let i = 0; i < recs.length; i++) {
        const r = recs[i];
        if (!r.sensor) {
          this._markTouch(r.a, r);
          this._markTouch(r.b, r);
        }
        TT.Effects.onContact(this, r);
      }
    }

    _markTouch(b, rec) {
      if (!b || b.isPlatform || b.dead || b.touched || !b.dropped) return;
      b.touched = true;
      b.touchTime = this.physics.time;
      b.guide = null;
      const bb = this.physics.bounds(b);
      this.emit('land', { block: b, x: (bb.minX + bb.maxX) / 2, y: bb.minY, impact: Math.hypot(b.lastVel.x, b.lastVel.y) });
      TT.Effects.onFirstTouch(this, b, rec);
    }

    _activate(b) {
      b.activated = true;
      this.emit('settle', { block: b });
      TT.Effects.onSettle(this, b);
    }

    // Settling, falls, lost blocks and petrify. Iterates movers only (static blocks never
    // move).
    _trackBlocks(dt) {
      const P = this.physics;
      const list = this._scratch;
      list.length = 0;
      for (let i = 0; i < P.movers.length; i++) list.push(P.movers[i]);
      const dropped = this._lastDropped;
      const now = P.time;
      let moving = false, falling = false;

      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        if (b.dead || b.body.isStatic()) continue;
        const body = b.body;
        const bb = P.bounds(b);
        const cx = (bb.minX + bb.maxX) / 2;
        if (bb.maxY < C.LOST_Y || cx < -C.LOST_X_MARGIN || cx > C.FIELD_WIDTH + C.LOST_X_MARGIN) {
          this._loseBlock(b, cx, bb);
          continue;
        }
        // Hysteresis: settling needs real stillness, but a settled block only counts as
        // moving again when it clearly moves, so small wobbles don't flicker the height.
        let speed = 0;
        if (body.isAwake()) {
          moving = true;
          const v = body.getLinearVelocity();
          speed = Math.abs(v.x) + Math.abs(v.y) + Math.abs(body.getAngularVelocity());
        }
        if (b.settled) {
          if (speed > C.UNSETTLE_SPEED) {
            b.settled = false;
            b.settledFor = 0;
            b.stillTime = 0;
          } else {
            b.settledFor += dt;
          }
        } else if (b.touched && speed < C.SETTLE_SPEED) {
          b.stillTime += dt;
          if (b.stillTime >= C.SETTLE_TIME) {
            b.settled = true;
            b.settledFor = 0;
            b.fallTurn = null; // at rest again: a later fall is a new one
            if (!b.activated) this._activate(b);
          }
        } else {
          b.stillTime = 0;
        }
        // A block set in motion (falling, knocked, tumbling off an edge) remembers the turn
        // that happened in until it has been calm for FALL_END_TIME (or settled). If it is
        // lost, that turn pays, however long the fall takes. Until then it also holds the
        // next drop back, so a collapse plays out within the turn that caused it.
        if (speed > C.UNSETTLE_SPEED) {
          if (b.fallTurn == null) b.fallTurn = this.turn;
          b.fallMoved = now;
        } else if (b.fallTurn != null && !(now - b.fallMoved < FALL_END_TIME)) {
          b.fallTurn = null;
        }
        if (b.fallTurn != null && (b !== dropped || b.touched)) falling = true;
      }
      this._moving = moving;
      this._falling = falling;

      this._petrifyTimer += dt;
      if (this._petrifyTimer >= PETRIFY_INTERVAL && this.state !== 'over') {
        this._petrifyTimer = 0;
        const limit = this.towerTop - C.PETRIFY_DEPTH;
        for (let i = 0; i < list.length; i++) {
          const b = list[i];
          if (b.dead || b.body.isStatic() || !b.settled || b.settledFor < C.PETRIFY_TIME) continue;
          if (P.bounds(b).maxY < limit && TT.Effects.canPetrify(this, b)) {
            P.makeStatic(b, 'petrified');
            this.emit('petrify', { block: b });
          }
        }
      }
    }

    _loseBlock(b, cx, bb) {
      const x = clamp(cx, -1, C.FIELD_WIDTH + 1);
      const y = Math.max(bb.maxY, C.LOST_Y);
      this.emit('blockLost', { block: b, x, y });
      this.physics.removeBlock(b, 'lost');
      this.stats.lost++;
      // One life per turn, however many blocks fall because of it: a fall counts for the
      // turn it began in, even when the block reaches the bottom turns later
      const turn = b.fallTurn != null ? b.fallTurn : this.turn;
      if (turn > 0 && !this._chargedTurns.has(turn) && !this.ending && this.state === 'playing') {
        this._chargedTurns.add(turn);
        this._loseLife(x, y);
      }
    }

    _loseLife(x, y) {
      if (this.shield) {
        this.shield = false;
        this.emit('shieldUsed', { x, y });
        return;
      }
      this.lives = Math.max(0, this.lives - 1);
      this.stats.livesLost++;
      this.emit('lifeLost', { lives: this.lives, x, y });
      if (this.lives <= 0) this._beginEnding();
    }

    _beginEnding() {
      this.ending = true;
      this._endTimer = ENDING_DELAY;
      this.piece = null;
      this.ghost = null;
      this.selected = -1;
      this.canDrop = false;
    }

    _updateHeight() {
      const P = this.physics;
      if (this._staticTopVersion !== P.version) {
        let top = C.PLATFORM_TOP;
        for (let i = 0; i < P.blocks.length; i++) {
          const b = P.blocks[i];
          if (!b.body.isStatic()) continue;
          b.settled = true;
          const y = P.bounds(b).maxY;
          if (y > top) top = y;
        }
        this._staticTop = top;
        this._staticTopVersion = P.version;
      }
      let top = this._staticTop;
      let best = this._staticTop;
      for (let i = 0; i < P.movers.length; i++) {
        const b = P.movers[i];
        if (b.dead || !b.settled) continue;
        const y = P.bounds(b).maxY;
        if (y > top) top = y;
        if (b.settledFor >= C.HEIGHT_SETTLE_TIME && y > best) best = y;
      }
      this.towerTop = top;
      this.height = Math.max(0, top - C.PLATFORM_TOP);
      const bestNow = Math.max(0, best - C.PLATFORM_TOP);
      if (bestNow > this.bestHeight + 1e-6 && this.state !== 'over') {
        this.bestHeight = bestNow;
        this.odds = TT.Generator.typeOdds(this.bestHeight, this.enabledTypes);
        this.emit('height', { height: this.height, best: this.bestHeight });
        while (this.bestHeight >= this.nextMilestone) {
          const h = this.nextMilestone;
          this.nextMilestone += C.LIFE_MILESTONE;
          this.emit('milestone', { height: h });
          this.gainLife('milestone');
        }
      }
    }

    _updateReady() {
      const b = this._lastDropped;
      let ready = true;
      let progress = 1;
      if (b) {
        const now = this.physics.time;
        const t = now - b.dropTime;
        if (t < C.READY_MIN) ready = false;
        else if (b.dead || t >= C.READY_MAX) ready = true;
        else ready = b.touched && (b.settled || b.body.isStatic() || now - b.touchTime >= C.READY_AFTER_TOUCH);
        // ...and only once nothing else is still in motion (capped, so it never locks)
        if (ready && this._falling && t < READY_FALL_MAX) ready = false;
        if (!ready) {
          const touchP = b.touched ? (now - b.touchTime) / C.READY_AFTER_TOUCH : 0;
          progress = clamp(Math.max(t / C.READY_MAX, touchP), 0, 0.99);
        }
      }
      if (ready && b) this._lastDropped = null;
      if (ready && !this._ready) {
        this._ready = true;
        this.emit('ready', {});
      }
      this._ready = ready;
      this.readyProgress = progress;
    }

    _dealBatch() {
      const specs = this.generator.nextBatch(this.bestHeight);
      this.batch = specs.map((spec) => ({ spec, used: false }));
      this.round++;
      this._pendingBatch = false;
      this.emit('newBatch', { batch: this.batch, round: this.round });
      this.selectSlot(0);
    }

    _updateHover(dt) {
      const P = this.physics;
      let target = Math.max(C.MIN_HOVER_Y, this.towerTop + C.DROP_GAP);
      // Stay clear of anything still airborne above the tower (blast debris), except the
      // block that was just dropped from the hover line itself.
      for (let i = 0; i < P.movers.length; i++) {
        const b = P.movers[i];
        if (b.settled || (b === this._lastDropped && !b.touched)) continue;
        const t = P.bounds(b).maxY + 1;
        if (t > target) target = t;
      }
      if (target > this.hoverY) this.hoverY = Math.min(target, this.hoverY + C.HOVER_RISE_SPEED * dt);
      else this.hoverY = Math.max(target, this.hoverY - C.HOVER_FALL_SPEED * dt);
      if (this.piece) this.piece.y = this.hoverY;
    }

    // ---- placement surface & ghost -------------------------------------------------
    _getSurface(fresh) {
      const P = this.physics;
      if (!this._surface || this._surfaceVersion !== P.version || (fresh && this._moving)) this._rebuildSurface();
      return this._surface;
    }

    _rebuildSurface() {
      const P = this.physics;
      this._exclude.clear();
      const ld = this._lastDropped;
      if (ld && !ld.dead && !ld.touched) this._exclude.add(ld);
      this._surface = TT.Placement.buildSurface(P, {
        exclude: this._exclude,
        hazards: TT.Effects.hazards(this),
        reuse: this._surface
      });
      this._surfaceVersion = P.version;
      this._surfaceAge = 0;
    }

    _refreshPlacement(dt) {
      this._surfaceAge += dt;
      const stale = !this._surface || this._surfaceVersion !== this.physics.version ||
        (this._moving && this._surfaceAge >= SURFACE_INTERVAL);
      if (!stale) return;
      this._rebuildSurface();
      if (this.piece) {
        // Keep the piece on a valid spot (assisted: still flush with a drifting support)
        if (this.mode !== 'manual') {
          this.piece.x = TT.Placement.snapX(this._surface, this.piece.shape, this.mode, this.piece.x);
          this._rawX = null;
        }
        this._updateGhost();
      }
    }

    _updateGhost() {
      const p = this.piece;
      if (!p) { this.ghost = null; return; }
      const L = TT.Placement.landing(this._getSurface(), p.shape, p.x, this.hoverY);
      this.ghost = {
        x: p.x,
        y: L.void ? null : L.y,
        void: !!L.void,
        warnings: L.warnings || [],
        supportId: L.primary ? L.primary.id : null
      };
    }

    _canControl() {
      return this.state === 'playing' && !this.ending && !!this.piece;
    }

    _setX(nx) {
      const p = this.piece;
      if (Math.abs(nx - p.x) < 1e-9) return false;
      p.x = nx;
      this._lastCenter = nx + p.shape.w / 2;
      this._updateGhost();
      this.emit('move', { x: nx });
      return true;
    }

    // ---- player actions -------------------------------------------------------------
    moveStep(dir) {
      if (!this._canControl()) return false;
      const d = dir < 0 ? -1 : 1;
      const shape = this.piece.shape;
      this._rawX = null;
      const nx = this.mode === 'manual'
        ? TT.Placement.clampX(shape, this.piece.x + d * this.pixelSize)
        : TT.Placement.stepX(this._getSurface(), shape, this.mode, this.piece.x, d, this.pixelSize);
      return this._setX(nx);
    }

    moveBy(dx) {
      if (!this._canControl() || !dx) return false;
      if (this.mode === 'manual') return this._setX(TT.Placement.clampX(this.piece.shape, this.piece.x + dx));
      if (this._rawX == null) this._rawX = this.piece.x;
      this._rawX = TT.Placement.clampX(this.piece.shape, this._rawX + dx);
      return this._setX(TT.Placement.snapX(this._getSurface(), this.piece.shape, this.mode, this._rawX));
    }

    setTargetX(x) {
      if (!this._canControl() || !isFinite(x)) return false;
      const shape = this.piece.shape;
      const nx = this.mode === 'manual'
        ? TT.Placement.clampX(shape, x)
        : TT.Placement.snapX(this._getSurface(), shape, this.mode, x);
      return this._setX(nx);
    }

    selectSlot(i) {
      if (this.state !== 'playing' || this.ending) return false;
      const slot = this.batch[i];
      if (!slot || slot.used) return false;
      const shape = TT.SHAPES[slot.spec.shapeId];
      const center = this.piece ? this.piece.x + this.piece.shape.w / 2 : this._lastCenter;
      this.selected = i;
      this.piece = { spec: slot.spec, shape, type: TT.BLOCK_TYPES[slot.spec.typeKey], x: 0, y: this.hoverY };
      this._rawX = null;
      const raw = TT.Placement.clampX(shape, center - shape.w / 2);
      this.piece.x = this.mode === 'manual' ? raw : TT.Placement.snapX(this._getSurface(), shape, this.mode, raw);
      this._updateGhost();
      this.canDrop = this._ready && !this.ending;
      this.emit('select', { index: i, spec: slot.spec });
      return true;
    }

    selectNext() {
      if (!this.batch.length) return false;
      const n = this.batch.length;
      for (let k = 1; k < n; k++) {
        const i = ((this.selected < 0 ? -1 : this.selected) + k + n) % n;
        if (!this.batch[i].used) return this.selectSlot(i);
      }
      return false;
    }

    drop() {
      if (!this._canControl() || !this._ready) {
        if (this.state === 'playing' && !this.ending) this.emit('deny', {});
        return false;
      }
      const piece = this.piece;
      const slotIndex = this.selected;
      this.turn++;
      this.stats.drops++;
      TT.Effects.onTurnStart(this); // e.g. magma melts — before the new body exists

      let guide = null;
      if (this.mode === 'assisted') {
        // x was chosen against a surface up to SURFACE_INTERVAL old: re-snap it onto the fresh
        // one first, so the guide starts from where a drifting support is now
        const surface = this._getSurface(true);
        piece.x = TT.Placement.snapX(surface, piece.shape, this.mode, piece.x);
        const g = TT.Placement.guideTarget(surface, piece.shape, piece.x);
        if (g && g.block && !g.block.dead) {
          guide = { block: g.block, local: { x: g.local.x, y: g.local.y }, startWant: g.block.body.getWorldPoint(g.local).x };
        }
      }
      const x = piece.x;
      const y = this.hoverY;
      const block = this.physics.createBlock(piece.spec, x, y, { vy: -C.DROP_START_SPEED });
      block.dropped = true;
      block.dropTime = this.physics.time;
      block.dropTurn = this.turn;
      block.guide = guide;
      this._lastDropped = block;
      this._ready = false;
      this.canDrop = false;
      this.readyProgress = 0;
      this.batch[slotIndex].used = true;
      this.emit('drop', { block, x, y });

      // Next piece: the next unused slot after this one, else wait for a new batch
      this.piece = null;
      this.selected = -1;
      const n = this.batch.length;
      let next = -1;
      for (let k = 1; k <= n; k++) {
        const i = (slotIndex + k) % n;
        if (!this.batch[i].used) { next = i; break; }
      }
      this._lastCenter = x + piece.shape.w / 2;
      if (next >= 0) this.selectSlot(next);
      else { this.ghost = null; this._pendingBatch = true; }
      return true;
    }

    setMode(mode) {
      if (!C.MODES.includes(mode) || mode === this.mode) return false;
      this.mode = mode;
      this._rawX = null;
      if (this.piece && mode !== 'manual') {
        this.piece.x = TT.Placement.snapX(this._getSurface(), this.piece.shape, mode, this.piece.x);
      }
      this._updateGhost();
      this.emit('mode', { mode });
      return true;
    }

    cycleMode() {
      const i = C.MODES.indexOf(this.mode);
      return this.setMode(C.MODES[(i + 1) % C.MODES.length]);
    }

    pause() {
      if (this.state !== 'playing') return false;
      this.state = 'paused';
      this.emit('pause', {});
      return true;
    }

    resume() {
      if (this.state !== 'paused') return false;
      this.state = 'playing';
      this.emit('resume', {});
      return true;
    }

    togglePause() { return this.state === 'paused' ? this.resume() : this.pause(); }

    setPixelSize(px) { if (px > 0 && isFinite(px)) this.pixelSize = px; }

    // ---- used by effects ---------------------------------------------------------------
    gainLife(reason) {
      if (this.lives <= 0 || this.lives >= this.maxLives || this.ending) return false;
      this.lives++;
      this.emit('lifeGained', { lives: this.lives, reason });
      return true;
    }

    addShield() {
      if (this.shield || this.ending) return false;
      this.shield = true;
      this.emit('shield', { active: true });
      return true;
    }

    summary() {
      return {
        seed: this.seed,
        rules: this.rules,
        bestHeight: this.bestHeight,
        height: this.height,
        elapsed: this.elapsed,
        turn: this.turn,
        round: this.round,
        lives: this.lives,
        stats: Object.assign({}, this.stats)
      };
    }

    destroy() {
      this.events = new Emitter();
      this.state = this.state === 'over' ? 'over' : 'paused';
    }
  }

  TT.Game = { Game, create: (options) => new Game(options) };
})(typeof window !== 'undefined' ? (window.TT = window.TT || {}) : (global.TT = global.TT || {}));
