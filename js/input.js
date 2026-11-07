/* TeTrowers — keyboard and pointer input (TT.Input).
 *
 * Keyboard (window): Left/Right move with our own repeat (the OS auto-repeat is ignored),
 * Up next block, Down/Space drop, Ctrl tapped on its own (not as part of a shortcut) cycles the
 * placement mode, Esc/P pause, O block odds, M mute, 1-3 pick a slot. Pointer on the canvas
 * (touch + mouse): a horizontal drag moves the piece relative to where it was when the drag began
 * (1:1 in world space), a quick downward swipe drops, plain taps do nothing.
 * Game keys are captured (preventDefault) only while a game is live and no menu covers it.
 * update(dt) is called once per frame by the main loop for hold / repeat timing.
 */
(function (TT) {
  'use strict';
  const C = TT.CONFIG;
  const { clamp } = TT.Util;

  const SWIPE_MIN_PX = (C.SWIPE_MIN_PX != null ? C.SWIPE_MIN_PX : 60);     // downward travel of a drop swipe
  const SWIPE_MAX_MS = (C.SWIPE_MAX_MS != null ? C.SWIPE_MAX_MS : 350);    // ...completed within this time
  const DRAG_START_PX = (C.DRAG_START_PX != null ? C.DRAG_START_PX : 8);   // travel before a gesture picks its axis
  const MAX_REPEATS_PER_FRAME = 3;

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function keyAction(e) {
    switch (e.key) {
      case 'ArrowLeft': case 'Left': return 'left';
      case 'ArrowRight': case 'Right': return 'right';
      case 'ArrowUp': case 'Up': return 'next';
      case 'ArrowDown': case 'Down': case ' ': case 'Spacebar': return 'drop';
      case 'Control': return 'mode';
      case 'Escape': case 'Esc': case 'p': case 'P': return 'pause';
      case 'o': case 'O': return 'odds';
      case 'm': case 'M': return 'mute';
      default: break;
    }
    // Digits by physical key so AZERTY and the numpad work too
    switch (e.code) {
      case 'Space': return 'drop';
      case 'Digit1': case 'Numpad1': return 'slot0';
      case 'Digit2': case 'Numpad2': return 'slot1';
      case 'Digit3': case 'Numpad3': return 'slot2';
      default: break;
    }
    if (e.key === '1' || e.key === '2' || e.key === '3') return 'slot' + (Number(e.key) - 1);
    return null;
  }

  // Actions that still work while Ctrl is held (Ctrl+P, Ctrl+1, ... belong to the browser)
  const CTRL_OK = new Set(['left', 'right', 'next', 'drop', 'mode']);

  function isTyping(t) {
    return !!t && (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' ||
      (t.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|range|color)$/i.test(t.type)));
  }

  function isControl(t) {
    return !!t && (t.tagName === 'BUTTON' || t.tagName === 'A' || t.tagName === 'INPUT' || t.getAttribute('role') === 'button');
  }

  class Input {
    // opts: { canvas, getGame(), getRenderer(), isBlocked() -> bool (a menu is open),
    //         onPause(), onOdds(), onMute(), onActivity() }
    constructor(opts) {
      this.opts = opts || {};
      this.canvas = this.opts.canvas || null;
      this.held = [];          // held arrow keys, most recent last: { code, dir, t0, next, mode }
      this.ptr = null;         // active pointer gesture
      this.ctrl = null;        // Ctrl is down: { chord } (chord: something else happened meanwhile)
      this.lastInput = 0;
      this._handlers = [];

      const chord = () => { if (this.ctrl) this.ctrl.chord = true; };
      this._listen(window, 'keydown', (e) => this._keyDown(e));
      this._listen(window, 'keyup', (e) => this._keyUp(e));
      this._listen(window, 'pointerdown', chord, true);            // Ctrl+click
      this._listen(window, 'wheel', chord, { passive: true });     // Ctrl+wheel zoom
      this._listen(window, 'blur', () => this.releaseAll());
      this._listen(document, 'visibilitychange', () => { if (document.hidden) this.releaseAll(); });
      if (this.canvas) {
        this.canvas.style.touchAction = 'none';
        this._listen(this.canvas, 'pointerdown', (e) => this._pointerDown(e));
        this._listen(this.canvas, 'pointermove', (e) => this._pointerMove(e));
        this._listen(this.canvas, 'pointerup', (e) => this._pointerUp(e, false));
        this._listen(this.canvas, 'pointercancel', (e) => this._pointerUp(e, true));
        this._listen(this.canvas, 'lostpointercapture', (e) => { if (this.ptr && e.pointerId === this.ptr.id) this.ptr = null; });
        this._listen(this.canvas, 'contextmenu', (e) => e.preventDefault());
      }
    }

    _listen(target, type, fn, opts) {
      target.addEventListener(type, fn, opts);
      this._handlers.push([target, type, fn, opts]);
    }

    destroy() {
      this.releaseAll();
      for (const [target, type, fn, opts] of this._handlers) target.removeEventListener(type, fn, opts);
      this._handlers = [];
    }

    // True while keys are held or a pointer gesture is in progress (keeps the loop at full rate)
    isActive() { return this.held.length > 0 || !!this.ptr; }

    releaseAll() {
      this.held.length = 0;
      this.ctrl = null;
      if (this.ptr) {
        const id = this.ptr.id;
        this.ptr = null;
        try { this.canvas.releasePointerCapture(id); } catch (err) { /* already released */ }
      }
    }

    reset() { this.releaseAll(); }

    _game() { return this.opts.getGame ? this.opts.getGame() : null; }

    _live(game) {
      return !!game && game.state === 'playing' && !game.ending && !(this.opts.isBlocked && this.opts.isBlocked());
    }

    _activity() {
      this.lastInput = now();
      if (this.opts.onActivity) this.opts.onActivity();
    }

    // ---- keyboard ---------------------------------------------------------------------
    _keyDown(e) {
      this._activity();
      // Any other key while Ctrl is down makes it a shortcut (Ctrl+=, Ctrl+Tab, and AltGr, which
      // Windows sends as Ctrl then AltGraph), so releasing Ctrl will not cycle the mode
      if (this.ctrl && e.key !== 'Control' && !e.repeat) this.ctrl.chord = true;
      if (e.defaultPrevented || e.altKey || e.metaKey || isTyping(e.target)) return;
      const action = keyAction(e);
      if (!action || (e.ctrlKey && !CTRL_OK.has(action))) return;
      // Space on a button the player tabbed to presses that button, it does not drop
      if (action === 'drop' && e.key !== 'ArrowDown' && e.key !== 'Down' && isControl(e.target)) return;
      const game = this._game();
      const live = this._live(game);
      if (action === 'mute') {
        if (live) e.preventDefault();
        if (!e.repeat && this.opts.onMute) this.opts.onMute();
        return;
      }
      if (!live) return;
      e.preventDefault();
      if (action === 'left' || action === 'right') {
        this._press(e, action === 'left' ? -1 : 1, game);
        return;
      }
      if (e.repeat) return;
      switch (action) {
        case 'next': game.selectNext(); break;
        case 'drop': game.drop(); break;
        case 'mode': if (!this.ctrl) this.ctrl = { chord: false }; break; // cycles on release (_keyUp)
        case 'pause':
          this.releaseAll();
          if (this.opts.onPause) this.opts.onPause();
          break;
        case 'odds':
          this.releaseAll();
          if (this.opts.onOdds) this.opts.onOdds();
          break;
        default: game.selectSlot(Number(action.slice(4))); break;
      }
    }

    _press(e, dir, game) {
      const code = e.code || e.key;
      const known = this.held.find((h) => h.code === code);
      if (known && e.repeat) return; // our own repeat timing replaces the OS one
      if (known) this.held.splice(this.held.indexOf(known), 1);
      this.held.push({ code, dir, t0: now(), next: C.KEY_REPEAT_DELAY, mode: game.mode });
      game.moveStep(dir);
    }

    _keyUp(e) {
      if (e.key === 'Control') {
        const c = this.ctrl;
        this.ctrl = null;
        const game = this._game();
        if (c && !c.chord && this._live(game)) game.cycleMode();
        return;
      }
      const code = e.code || e.key;
      const wasActive = this.held.length && this.held[this.held.length - 1].code === code;
      for (let i = this.held.length - 1; i >= 0; i--) {
        if (this.held[i].code === code) this.held.splice(i, 1);
      }
      // The other arrow is still down: it takes over with a fresh hold delay (no extra step)
      if (wasActive && this.held.length) {
        const h = this.held[this.held.length - 1];
        h.t0 = now();
        h.next = C.KEY_REPEAT_DELAY;
      }
    }

    update(dt) {
      const h = this.held.length ? this.held[this.held.length - 1] : null;
      if (!h) return;
      const game = this._game();
      if (!this._live(game)) { this.held.length = 0; return; }
      // The mode changed mid-hold: start the hold over (no burst of catch-up steps, no instant top speed)
      if (h.mode !== game.mode) {
        h.mode = game.mode;
        h.t0 = now();
        h.next = C.KEY_REPEAT_DELAY;
        return;
      }
      const t = (now() - h.t0) / 1000;
      if (game.mode === 'manual') {
        const slide = t - C.MANUAL_HOLD_DELAY;
        if (slide <= 0) return;
        // Ease-in: slow and precise at first, then fast for long distances
        const k = clamp(slide / C.MANUAL_ACCEL_TIME, 0, 1);
        const speed = C.MANUAL_SPEED_MIN + (C.MANUAL_SPEED_MAX - C.MANUAL_SPEED_MIN) * k * k;
        game.moveBy(h.dir * speed * Math.min(dt, slide));
      } else {
        let n = 0;
        while (t >= h.next && n < MAX_REPEATS_PER_FRAME) {
          game.moveStep(h.dir);
          h.next += C.KEY_REPEAT_RATE;
          n++;
        }
        if (t >= h.next) h.next = t + C.KEY_REPEAT_RATE; // after a hitch, do not replay the backlog
      }
    }

    // ---- pointer ----------------------------------------------------------------------
    _pointerDown(e) {
      this._activity();
      if (this.ptr || (e.pointerType === 'mouse' && e.button !== 0)) return;
      const game = this._game();
      if (!this._live(game)) return;
      e.preventDefault();
      const piece = game.piece;
      this.ptr = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: now(), axis: null, piece, pieceX: piece ? piece.x : 0 };
      try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* moves still arrive over the canvas */ }
    }

    _pointerMove(e) {
      const p = this.ptr;
      if (!p || e.pointerId !== p.id) return;
      this._activity();
      const game = this._game();
      if (!this._live(game)) return;
      const dx = e.clientX - p.x0, dy = e.clientY - p.y0;
      if (!p.axis) {
        if (Math.abs(dx) < DRAG_START_PX && Math.abs(dy) < DRAG_START_PX) return;
        p.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
      }
      // A slow vertical gesture is no longer a swipe: let it steer
      if (p.axis === 'y' && Math.abs(dx) >= DRAG_START_PX && now() - p.t0 > SWIPE_MAX_MS) p.axis = 'x';
      if (p.axis !== 'x') return;
      const piece = game.piece;
      if (!piece) return;
      if (piece !== p.piece) {
        // A new piece appeared mid-drag: continue relative to it from here
        p.piece = piece;
        p.pieceX = piece.x;
        p.x0 = e.clientX;
        return;
      }
      const r = this.opts.getRenderer ? this.opts.getRenderer() : null;
      const scale = r && r.scale > 0 ? r.scale : 1 / (game.pixelSize || 1 / 40);
      game.setTargetX(p.pieceX + dx / scale);
    }

    _pointerUp(e, cancelled) {
      const p = this.ptr;
      if (!p || e.pointerId !== p.id) return;
      this.ptr = null;
      this._activity();
      if (cancelled || p.axis === 'x') return;
      const dx = e.clientX - p.x0, dy = e.clientY - p.y0;
      const game = this._game();
      if (dy > SWIPE_MIN_PX && Math.abs(dy) > 2 * Math.abs(dx) && now() - p.t0 < SWIPE_MAX_MS && this._live(game)) {
        game.drop();
      }
    }
  }

  TT.Input = { Input, create: (opts) => new Input(opts), keyAction };
})(typeof window !== 'undefined' ? (window.TT = window.TT || {}) : (global.TT = global.TT || {}));
