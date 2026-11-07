/* TeTrowers — keyboard, mouse and touch input (TT.Input).
 *
 * Keyboard (window): Left/Right move with our own repeat (the OS auto-repeat is ignored), Down picks
 * the next block and Up the previous one (once per press), Space/Enter drop, Ctrl tapped on its own
 * (not as part of a shortcut) cycles the placement mode, Esc/P pause, O block odds, ? or H the
 * special-block explorer, M mute, 1-3 pick a slot. Space and Enter on a control the player reached
 * with the keyboard press that control.
 * Pointer (mouse, touch and pen behave the same): a drag that starts on a tray slot picks that block
 * up, a drag that starts on the playfield takes the block that is already selected. Either way the
 * block is in hand: over the playfield the hovering piece follows the pointer, and letting go there
 * drops it. Over the tray, the HUD or outside the window (the cancel zone) the piece is back where it
 * was picked up, and letting go there drops nothing. Let go before the drop is allowed, the drop
 * waits until it is (any new drag, selection, key move, pause or menu cancels it). A tap never
 * drops: on a slot it only selects it, on the playfield it does nothing. A press on the "?" badge
 * of a block ([data-help], ui.js opens the block's card on its click) is not ours at all.
 * Game keys are captured (preventDefault) only while a game is live and no menu covers it.
 * update(dt) is called once per frame by the main loop: hold / repeat timing, the latest pointer
 * position (moves are coalesced to one aim per frame) and the waiting drop. `cue` tells ui.js what
 * to show: the lifted slot, where the drag is ('field' | 'cancel'), whether a drop is waiting and
 * how many drags were let go in the cancel zone so far.
 */
(function (TT) {
  'use strict';
  const C = TT.CONFIG;
  const { clamp } = TT.Util;

  const DRAG_START_PX = (C.DRAG_START_PX != null ? C.DRAG_START_PX : 8);   // pointer travel that makes a press a drag
  const MAX_REPEATS_PER_FRAME = 3;

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function keyAction(e) {
    switch (e.key) {
      case 'ArrowLeft': case 'Left': return 'left';
      case 'ArrowRight': case 'Right': return 'right';
      case 'ArrowDown': case 'Down': return 'next';
      case 'ArrowUp': case 'Up': return 'prev';
      case ' ': case 'Spacebar': case 'Enter': return 'drop';
      case 'Control': return 'mode';
      case 'Escape': case 'Esc': case 'p': case 'P': return 'pause';
      case 'o': case 'O': return 'odds';
      case '?': case 'h': case 'H': return 'help';
      case 'm': case 'M': return 'mute';
      default: break;
    }
    // Digits by physical key so AZERTY and the numpad work too
    switch (e.code) {
      case 'Space': case 'NumpadEnter': return 'drop';
      case 'Digit1': case 'Numpad1': return 'slot0';
      case 'Digit2': case 'Numpad2': return 'slot1';
      case 'Digit3': case 'Numpad3': return 'slot2';
      default: break;
    }
    if (e.key === '1' || e.key === '2' || e.key === '3') return 'slot' + (Number(e.key) - 1);
    return null;
  }

  // Actions that still work while Ctrl is held (Ctrl+P, Ctrl+1, ... belong to the browser)
  const CTRL_OK = new Set(['left', 'right', 'next', 'prev', 'drop', 'mode']);

  function isTyping(t) {
    return !!t && (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' ||
      (t.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|range|color)$/i.test(t.type)));
  }

  function isControl(t) {
    return !!t && (t.tagName === 'BUTTON' || t.tagName === 'A' || t.tagName === 'INPUT' ||
      (typeof t.getAttribute === 'function' && t.getAttribute('role') === 'button'));
  }

  // A control the player reached with the keyboard (it shows the focus ring): Space and Enter press
  // it. A control left focused by a mouse or touch press does not keep the keys from the game.
  function keyboardFocused(t) {
    if (!isControl(t)) return false;
    try { return t.matches(':focus-visible'); } catch (err) { return true; } // no :focus-visible: play safe
  }

  function blurActive() {
    const a = typeof document !== 'undefined' ? document.activeElement : null;
    if (a && a !== document.body && typeof a.blur === 'function') a.blur();
  }

  function slotButton(t) {
    return t && typeof t.closest === 'function' ? t.closest('[data-slot]') : null;
  }

  // The "?" badge in a slot's corner: a button of its own that explains the block
  function helpBadge(t) {
    return t && typeof t.closest === 'function' ? t.closest('[data-help]') : null;
  }

  // The previous unused slot, wrapping (the counterpart of game.selectNext)
  function selectPrev(game) {
    const b = game.batch, n = b.length;
    const from = game.selected < 0 ? 0 : game.selected;
    for (let k = 1; k < n; k++) {
      const i = (from - k + n) % n;
      if (!b[i].used) return game.selectSlot(i);
    }
    return false;
  }

  class Input {
    // opts: { canvas, tray (the batch tray; its [data-slot] buttons are dragged onto the playfield),
    //         getGame(), getRenderer(), isBlocked() -> bool (a menu is open),
    //         onPause(), onOdds(), onHelp(), onMute(), onActivity() }
    constructor(opts) {
      this.opts = opts || {};
      this.canvas = this.opts.canvas || null;
      this.tray = this.opts.tray || null;
      this.held = [];          // held arrow keys, most recent last: { code, dir, t0, next, mode }
      this.ptr = null;         // the press in progress, on a tray slot ('tray') or the playfield ('canvas')
      this.queued = null;      // a drop let go before it was allowed: { game, piece }
      // Read by ui.js every frame. cancels: drags let go in the cancel zone so far (it only grows)
      this.cue = { slot: -1, zone: '', queued: false, cancels: 0 };
      this.ctrl = null;        // Ctrl is down: { chord } (chord: something else happened meanwhile)
      this.lastInput = 0;
      this._pt = { x: 0, y: 0 };
      this._handlers = [];

      const chord = () => { if (this.ctrl) this.ctrl.chord = true; };
      this._listen(window, 'keydown', (e) => this._keyDown(e));
      this._listen(window, 'keyup', (e) => this._keyUp(e));
      this._listen(window, 'pointerdown', chord, true);            // Ctrl+click
      this._listen(window, 'wheel', chord, { passive: true });     // Ctrl+wheel zoom
      this._listen(window, 'blur', () => this.releaseAll());
      this._listen(document, 'visibilitychange', () => { if (document.hidden) this.releaseAll(); });
      // A press is followed on window: a block dragged out of the tray travels over the whole page
      this._listen(window, 'pointermove', (e) => this._pointerMove(e), { passive: true });
      this._listen(window, 'pointerup', (e) => this._pointerUp(e, false));
      this._listen(window, 'pointercancel', (e) => this._pointerUp(e, true));
      const lost = (e) => {
        const p = this.ptr;
        if (p && e.pointerId === p.id && e.target === p.el) this._endPress();
      };
      if (this.canvas) {
        const c = this.canvas;
        c.style.touchAction = 'none';
        this._listen(c, 'pointerdown', (e) => this._pointerDown(e, 'canvas'));
        this._listen(c, 'lostpointercapture', lost);
        this._listen(c, 'contextmenu', (e) => e.preventDefault());   // no long-press menu mid-drag
      }
      if (this.tray) {
        this._listen(this.tray, 'pointerdown', (e) => this._pointerDown(e, 'tray'));
        this._listen(this.tray, 'lostpointercapture', lost);
        this._listen(this.tray, 'contextmenu', (e) => { if (slotButton(e.target) || helpBadge(e.target)) e.preventDefault(); });
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

    // True while keys are held, a pointer gesture is in progress or a drop waits (full frame rate)
    isActive() { return this.held.length > 0 || !!this.ptr || !!this.queued; }

    // True while a press (tap or drag) is in progress: other buttons ignore extra fingers meanwhile
    isPressing() { return !!this.ptr; }

    releaseAll() {
      this.held.length = 0;
      this.ctrl = null;
      this._cancelQueued();
      if (this.ptr) this._endPress();
    }

    reset() { this.releaseAll(); }

    _game() { return this.opts.getGame ? this.opts.getGame() : null; }

    _renderer() { return this.opts.getRenderer ? this.opts.getRenderer() : null; }

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
      // Space / Enter on a button the player tabbed to press that button
      if (action === 'drop' && keyboardFocused(e.target)) return;
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
        this._cancelQueued();
        this._press(e, action === 'left' ? -1 : 1, game);
        return;
      }
      if (e.repeat) return;   // one block switch or drop per press
      switch (action) {
        case 'next': this._cancelQueued(); game.selectNext(); break;
        case 'prev': this._cancelQueued(); selectPrev(game); break;
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
        case 'help':
          this.releaseAll();
          if (this.opts.onHelp) this.opts.onHelp();
          break;
        default: this._cancelQueued(); game.selectSlot(Number(action.slice(4))); break;
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
      this._updateQueued();
      const p = this.ptr;
      if (p) {
        const g = this._game();
        if (!this._live(g)) this._endPress();
        else if (p.dirty) { p.dirty = false; this._aim(g, p); }
      }
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

    // ---- waiting drop -----------------------------------------------------------------
    // Fires once the game allows the drop, as long as the same piece is still the one in hand
    _updateQueued() {
      const q = this.queued;
      if (!q) return;
      const g = this._game();
      if (g !== q.game || g.piece !== q.piece || !this._live(g)) { this._cancelQueued(); return; }
      if (!g.canDrop) return;
      this._cancelQueued();
      g.drop();
    }

    _cancelQueued() {
      this.queued = null;
      this.cue.queued = false;
    }

    // ---- pointer ----------------------------------------------------------------------
    // src: 'tray' (a press on the tray, used only on a slot) or 'canvas' (on the playfield)
    _pointerDown(e, src) {
      this._activity();
      // The "?" badge on a block opens its card (ui.js): never a pick, a drag, a drop or a cancel
      if (src === 'tray' && helpBadge(e.target)) {
        if (this.ptr && this.ptr.id === e.pointerId) this._endPress();   // its release never reached us
        return;
      }
      const game = this._game();
      if (!this._live(game)) return;
      let el = this.canvas, slot = -1;
      if (src === 'canvas') {
        e.preventDefault();
        blurActive(); // the keys go back to the game, not to a button clicked earlier
      } else {
        el = slotButton(e.target);
        if (!el) return;
        slot = Number(el.dataset.slot);
      }
      if (this.ptr && this.ptr.id === e.pointerId) this._endPress(); // its release never reached us
      if (this.ptr || e.button !== 0) return;                         // extra fingers are ignored
      // out: the block in hand was aimed over the playfield (homeX: where it was picked up);
      // done: it was let go there (dropped or waiting); cancelled: it was let go in the cancel zone
      const p = this.ptr = {
        id: e.pointerId, src, el, slot, mouse: e.pointerType === 'mouse',
        path: 0, drag: false, dead: false, dirty: false, out: false, done: false, cancelled: false, homeX: 0,
        x: e.clientX, y: e.clientY
      };
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* moves still arrive on window */ }
      if (src === 'tray') {
        // A press on a block is a new selection: it cancels a waiting drop and picks the block
        // at once (a tap ends there); a used or empty slot gives a press that does nothing
        this._cancelQueued();
        p.dead = !this._hold(game, p);
      } else {
        // A drag on the playfield takes the block that is selected now (a tap does nothing)
        p.slot = game.piece ? game.selected : -1;
        p.dead = p.slot < 0;
      }
    }

    _pointerMove(e) {
      const p = this.ptr;
      if (!p || e.pointerId !== p.id) return;
      if (p.mouse && e.buttons === 0) { this._endPress(); return; } // released where we could not see it
      this._activity();
      this._track(p, e.clientX, e.clientY);
    }

    _pointerUp(e, cancelled) {
      const p = this.ptr;
      if (!p || e.pointerId !== p.id) return;
      this._activity();
      const game = this._game();
      if (!cancelled && this._live(game)) {
        this._track(p, e.clientX, e.clientY);
        if (p.drag && !p.dead) {
          // The block in hand drops where it is let go over the playfield; anywhere else nothing drops
          if (this._zone(p.x, p.y) !== 'field') p.cancelled = true;
          else if (this._hold(game, p)) {
            this._aimAt(game, p.x, p.y);
            p.done = true;
            if (game.canDrop) game.drop();
            else if (game.piece) { this.queued = { game, piece: game.piece }; this.cue.queued = true; }
          }
        }
      }
      this._endPress();
    }

    // A block in hand that does not drop goes back to where it was picked up
    _endPress() {
      const p = this.ptr;
      this.ptr = null;
      this.cue.slot = -1;
      this.cue.zone = '';
      if (!p) return;
      if (p.out && !p.done) {
        const g = this._game();
        if (this._live(g)) this._putBack(g, p);
      }
      if (p.cancelled) this.cue.cancels++;
      if (p.el) {
        try { p.el.releasePointerCapture(p.id); } catch (err) { /* already released */ }
      }
    }

    // Path length, not displacement: a drag that wiggles back to where it began is still a drag
    _track(p, x, y) {
      const dx = x - p.x, dy = y - p.y;
      p.x = x;
      p.y = y;
      p.path += Math.sqrt(dx * dx + dy * dy);
      p.dirty = true;
      if (!p.drag && p.path >= DRAG_START_PX) this._startDrag(p);
    }

    _startDrag(p) {
      p.drag = true;
      this._cancelQueued();   // a new drag replaces a waiting drop
      if (p.dead) return;
      const game = this._game();
      if (!this._live(game) || !this._hold(game, p)) { p.dead = true; return; }
      this.cue.slot = p.slot;   // the block is in hand: lifted out of its slot
      this.cue.zone = this._zone(p.x, p.y) === 'field' ? 'field' : 'cancel';
      p.homeX = game.piece.x;
    }

    // The block in hand stays the selected one (a key or the game may have switched meanwhile)
    _hold(game, p) {
      if (game.selected === p.slot && game.piece) return true;
      if (game.selectSlot(p.slot)) return true;
      if (this.cue.slot === p.slot) { this.cue.slot = -1; this.cue.zone = ''; }
      return false;
    }

    // Once per frame with the latest position: the block in hand follows the pointer while it is
    // over the playfield and is back at its pick-up spot anywhere else (where letting go cancels)
    _aim(game, p) {
      if (!p.drag || p.dead) return;
      const over = this._zone(p.x, p.y) === 'field';
      this.cue.zone = over ? 'field' : 'cancel';
      if (!over) { this._putBack(game, p); return; }
      if (!this._hold(game, p)) { p.dead = true; return; }
      p.out = true;
      this._aimAt(game, p.x, p.y);
    }

    _putBack(game, p) {
      if (!p.out) return;
      p.out = false;
      if (game.selected === p.slot) game.setTargetX(p.homeX);
    }

    // Piece centre under the pointer (only x: the piece stays on the hover line)
    _aimAt(game, x, y) {
      const r = this._renderer(), piece = game.piece;
      if (!piece || !r || typeof r.screenToWorld !== 'function' || !this.canvas) return;
      const rect = this.canvas.getBoundingClientRect();
      game.setTargetX(r.screenToWorld(x - rect.left, y - rect.top, this._pt).x - piece.shape.w / 2);
    }

    // What is under the pointer: 'field' (the playfield itself), 'tray' or 'out' (HUD, sidebar
    // top, outside the window, ...). Overlays that ignore the pointer (toasts, cues) are see-through.
    _zone(x, y) {
      const c = this.canvas;
      if (!c) return 'out';
      if (typeof document !== 'undefined' && typeof document.elementFromPoint === 'function') {
        const hit = document.elementFromPoint(x, y);
        if (hit === c) return 'field';
        return hit && this.tray && this.tray.contains(hit) ? 'tray' : 'out';
      }
      const r = c.getBoundingClientRect();
      return x >= r.left && x < r.right && y >= r.top && y < r.bottom ? 'field' : 'out';
    }
  }

  TT.Input = { Input, create: (opts) => new Input(opts), keyAction, selectPrev };
})(typeof window !== 'undefined' ? (window.TT = window.TT || {}) : (global.TT = global.TT || {}));
