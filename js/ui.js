/* TeTrowers — DOM user interface: screens, HUD, batch tray and toasts.
 *
 * Created once by main.js (TT.UI.create(app)). Screens are the static <section data-screen>
 * elements of index.html, shown as a stack (title > settings, pause > how to play, ...).
 * The HUD reads the bound game's public fields once per frame and touches the DOM only when
 * a displayed value changed, so a running game costs a few comparisons per frame. The same goes
 * for the drag cues, which mirror TT.Input's `cue`: the lifted slot, the tray turning into a red
 * "Release to cancel" target while the block in hand is outside the playfield (the renderer greys
 * the piece out and hides its ghost meanwhile, see renderer.setDragCue), a short buzz on entering
 * that zone, "Cancelled" plus a soft sound when a drag is let go there, and "Dropping when ready"
 * by the piece.
 * Special blocks explain themselves: a "?" badge on each special block in the tray opens that
 * block's card, and the "?" button in the HUD opens the explorer of every special block (both pause
 * the game like the odds panel; main.js showPanel).
 * Also home of TT.Storage and the best-score / seen-type records: every localStorage access
 * is wrapped in try/catch with an in-memory fallback, so private browsing still works.
 */
(function (TT) {
  'use strict';
  const C = TT.CONFIG;
  const { clamp, formatTime } = TT.Util;

  const TOAST_TIME = (C.TOAST_TIME != null ? C.TOAST_TIME : 4.5);      // s a toast stays up
  const TOAST_MAX = (C.TOAST_MAX != null ? C.TOAST_MAX : 3);           // toasts visible at once
  // Playfields shorter than this (CSS px) show one compact single-line toast at a time
  const TOAST_COMPACT_H = (C.TOAST_COMPACT_H != null ? C.TOAST_COMPACT_H : 600);
  const TOAST_GAP_MS = 350;     // pause before a waiting toast takes a free spot
  const TOAST_CLEAR = 6;        // CSS px kept between toasts and the hovering piece / landing ghost
  const CONFIRM_TIME = (C.CONFIRM_TIME != null ? C.CONFIRM_TIME : 3);  // s an armed "press again" button waits
  const SHARE_URL = (C.SHARE_URL != null ? C.SHARE_URL : 'https://williamszc380.github.io/TeTrowers/');
  const PREVIEW_MAX_DPR = 2;
  const LIST_PREVIEW_CELL = 13; // CSS px per cell in the codex / toggle lists (tray slots fit a 4x4 piece)
  const ODDS_PREVIEW_CELL = 8;  // ...in the odds panel rows
  const EXPLORE_PREVIEW_CELL = 11;  // ...in the special-block explorer
  const INFO_PREVIEW_CELL = 26;     // ...and on a block's card
  const CUE_GAP = 8;            // CSS px between the hovering piece and the "Dropping when ready" cue
  const CANCEL_BUZZ_MS = (C.CANCEL_BUZZ_MS != null ? C.CANCEL_BUZZ_MS : 10);   // vibration on entering the cancel zone
  const CANCELLED_MS = 800;     // the "Cancelled" flash in the tray
  const DRAG_TIP = '#drag';     // Seen key of the one-time "how to drop" tip
  // ms the game-over buttons ignore presses (the player may still be hammering Space / Enter)
  const OVER_GUARD_MS = (C.OVER_GUARD_MS != null ? C.OVER_GUARD_MS : 800);
  const GUARD = 'tetrowersGuard';   // history.state flag of the Back guard entry
  const GUARD_LEAVE_MS = 2000;      // our own history.back() must report back within this

  const MODE_INFO = Object.freeze({
    assisted: { name: 'Assisted', hint: 'Half-block steps plus spots flush with the corners below; guides the falling block onto its target.' },
    fixed: { name: 'Fixed', hint: 'Half-block steps, no help while falling.' },
    manual: { name: 'Manual', hint: 'Pixel-precise: tap for one pixel, hold to slide.' }
  });

  const CATEGORY_TEXT = { positive: 'Good block', negative: 'Bad block', normal: 'Normal block' };
  const GAME_ACTIONS = new Set(['mode', 'slot']);
  // Tall panels opened over a run (main.js showPanel): they clear the toasts, which would cover their header
  const PLAY_PANELS = new Set(['odds', 'explore', 'blockinfo']);
  const CUE_TEXT = {
    field: 'Let go to drop · drag back here to cancel',
    cancel: '✕ Release to cancel'
  };
  const CANCELLED_TEXT = 'Cancelled';

  // Preview shapes for the codex and toggle lists (every block is a tetromino)
  const SAMPLE_SHAPES = {
    normal: 'L0', steel: 'O0', vine: 'S0', crystal: 'T0', frost: 'J0', magnet: 'L0',
    rubber: 'S0', oil: 'Z0', glass: 'J0', mine: 'T2', magma: 'O0', spikes: 'I0',
    anvil: 'T0', blackhole: 'O0'
  };

  // ---- Storage -------------------------------------------------------------------------
  const KEYS = Object.freeze({
    settings: 'tetrowers.settings', best: 'tetrowers.best', seen: 'tetrowers.seen', pending: 'tetrowers.pending'
  });
  const memory = Object.create(null); // this session's values; used when localStorage is unavailable

  const Storage = {
    KEYS,
    read(key, fallback) {
      let raw = null;
      if (key in memory) raw = memory[key];
      else {
        try { raw = window.localStorage.getItem(key); } catch (err) { raw = null; }
      }
      if (raw == null) return fallback;
      try { return JSON.parse(raw); } catch (err) { return fallback; }
    },
    write(key, value) {
      let raw;
      try { raw = JSON.stringify(value); } catch (err) { return false; }
      memory[key] = raw;
      try { window.localStorage.setItem(key, raw); return true; } catch (err) { return false; }
    },
    remove(key) {
      delete memory[key];
      try { window.localStorage.removeItem(key); return true; } catch (err) { return false; }
    }
  };

  const round1 = (h) => Math.round((h || 0) * 10) / 10;
  const fmtM = (h) => round1(h).toFixed(1) + ' m';
  const fmtPct = (p) => (Math.max(0, p || 0) * 100).toFixed(1) + '%';  // every odds figure on screen
  const recordKey = (seed, rules) => seed + '|' + (rules || '');

  // Best heights per "SEED|rules" (seeds may contain '|', rules never do)
  const Records = {
    all() {
      const v = Storage.read(KEYS.best, null);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    },
    get(seed, rules) {
      const r = this.all()[recordKey(seed, rules)];
      return r && typeof r.height === 'number' && isFinite(r.height) ? r : null;
    },
    // Highest record for one block set, across all seeds
    top(rules) {
      const all = this.all();
      let best = null;
      for (const key of Object.keys(all)) {
        const r = all[key];
        const i = key.lastIndexOf('|');
        if (!r || typeof r.height !== 'number' || i < 0 || key.slice(i + 1) !== (rules || '')) continue;
        if (!best || r.height > best.height) best = { seed: key.slice(0, i), height: r.height, time: r.time, date: r.date };
      }
      return best;
    },
    // Store a run's best height. Returns { isNew (seed record), isTop (best for this block set), previous }
    submit(summary) {
      const height = round1(summary.bestHeight);
      const previous = this.get(summary.seed, summary.rules);
      const top = this.top(summary.rules);
      const isNew = height > 0 && (!previous || height > previous.height);
      if (isNew) {
        const all = this.all();
        all[recordKey(summary.seed, summary.rules)] = {
          height, time: Math.round(summary.elapsed || 0), date: new Date().toISOString()
        };
        Storage.write(KEYS.best, all);
      }
      return { isNew, isTop: height > 0 && (!top || height > top.height), previous: previous ? previous.height : null };
    },
    // A run still in progress when the page is hidden or closed (the OS may kill it there). Kept
    // apart from the records, so the run's own game-over badge still compares against the old best.
    savePending(summary) {
      if (!summary || !(summary.bestHeight > 0)) return false;
      return Storage.write(KEYS.pending, {
        seed: summary.seed, rules: summary.rules || '', bestHeight: summary.bestHeight, elapsed: summary.elapsed || 0
      });
    },
    clearPending() { Storage.remove(KEYS.pending); },
    // At start-up: a run that never ended normally (killed, swiped away, Back) still counts
    flushPending() {
      const p = Storage.read(KEYS.pending, null);
      Storage.remove(KEYS.pending);
      if (!p || typeof p.seed !== 'string' || !p.seed || typeof p.rules !== 'string' ||
          !(p.bestHeight > 0) || !isFinite(p.bestHeight)) return null;
      return this.submit({ seed: p.seed, rules: p.rules, bestHeight: p.bestHeight, elapsed: +p.elapsed || 0 });
    }
  };

  // Special types the player has already been introduced to
  const Seen = {
    _set: null,
    _load() {
      if (!this._set) {
        const a = Storage.read(KEYS.seen, []);
        this._set = new Set(Array.isArray(a) ? a.filter((k) => typeof k === 'string') : []);
      }
      return this._set;
    },
    has(key) { return this._load().has(key); },
    add(key) {
      const s = this._load();
      if (s.has(key)) return false;
      s.add(key);
      Storage.write(KEYS.seen, Array.from(s));
      return true;
    }
  };

  // ---- Text helpers ----------------------------------------------------------------------
  function categoryClass(type) {
    const c = type && type.category;
    return c === 'positive' ? 'cat-positive' : c === 'negative' ? 'cat-negative' : 'cat-normal';
  }

  function rulesOf(enabledKeys) { return TT.Generator.rulesKey(new Set(enabledKeys)); }

  function rulesLabel(rules) {
    if (!rules) return 'all special blocks';
    const off = rules.replace(/^no:/, '').split(',').filter(Boolean);
    if (off.length >= TT.SPECIAL_KEYS.length) return 'no special blocks';
    if (off.length > 3) return off.length + ' special blocks off';
    return 'without ' + off.map((k) => (TT.BLOCK_TYPES[k] ? TT.BLOCK_TYPES[k].name : k)).join(', ');
  }

  function unlockLabel(type) {
    return type.unlock > 0 ? 'Appears from ' + type.unlock + ' m' : 'Appears from the start';
  }

  function isSpecial(key) {
    const t = TT.BLOCK_TYPES[key];
    return !!t && (t.category === 'positive' || t.category === 'negative');
  }

  // A special type in the next deal (o = Generator.typeOdds): 'on' (it can be dealt), 'off' (switched
  // off in Special Blocks) or 'locked' (best height below its unlock), and the text shown for it
  function typeState(o, enabled, key) {
    return o.types[key] != null ? 'on' : !enabled.has(key) ? 'off' : 'locked';
  }

  function typeOddsText(o, enabled, key) {
    const state = typeState(o, enabled, key);
    return state === 'on' ? fmtPct(o.types[key]) : state === 'off' ? 'off' : 'unlocks at ' + TT.BLOCK_TYPES[key].unlock + ' m';
  }

  function shareLink(seed) {
    let base = SHARE_URL;
    try {
      if (location.protocol === 'https:') base = location.origin + location.pathname;
    } catch (err) { /* keep the canonical URL */ }
    return base + '?seed=' + encodeURIComponent(seed);
  }

  function resultText(s) {
    const rules = s.rules ? ' (' + rulesLabel(s.rules) + ')' : '';
    return 'TeTrowers - seed ' + s.seed + rules + ': ' + fmtM(s.bestHeight) + ' in ' + formatTime(s.elapsed) + '\n' + shareLink(s.seed);
  }

  function legacyCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    let ok = false;
    try { ta.select(); ok = document.execCommand('copy'); } catch (err) { ok = false; }
    ta.remove();
    return ok;
  }

  function isTyping(t) {
    return !!t && (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' ||
      (t.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|range|color)$/i.test(t.type)));
  }

  // ---- DOM helpers -------------------------------------------------------------------------
  function make(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function icon(id, cls) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'icon' + (cls ? ' ' + cls : ''));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(NS, 'use');
    use.setAttribute('href', '#' + id);
    svg.appendChild(use);
    return svg;
  }

  // ---- Block previews -----------------------------------------------------------------------
  const warned = new Set();
  function warnOnce(what, err) {
    if (warned.has(what)) return;
    warned.add(what);
    if (typeof console !== 'undefined') console.warn('[TT.UI] ' + what + ' failed, using fallback', err);
  }

  function previewDpr() { return Math.min(window.devicePixelRatio || 1, PREVIEW_MAX_DPR); }

  // Draw a block spec into a canvas sized by CSS. Returns false while the canvas has no layout.
  // opts: { cell } CSS px per cell (default: fit a 4x4 piece)
  function drawPreview(canvas, spec, opts) {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return false;
    const dpr = previewDpr();
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, bw, bh);
    if (!spec) return true;
    const R = TT.Renderer;
    if (R && typeof R.drawPreview === 'function') {
      try {
        R.drawPreview(canvas, spec, Object.assign({ dpr }, opts));
        return true;
      } catch (err) {
        warnOnce('Renderer.drawPreview', err);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
    fallbackPreview(ctx, canvas.width, canvas.height, spec, opts && opts.cell > 0 ? opts.cell * dpr : 0);
    return true;
  }

  // Simple bevelled cells in the type's colours (used only if the renderer is unavailable)
  function fallbackPreview(ctx, W, H, spec, cellPx) {
    const type = TT.BLOCK_TYPES[spec.typeKey] || TT.BLOCK_TYPES.normal;
    const shape = TT.SHAPES[spec.shapeId] || TT.SHAPES.T0;
    const fit = Math.floor(Math.min(W / shape.w, H / shape.h));
    const cell = Math.max(3, Math.min(fit, Math.round(cellPx) || Math.floor(Math.min(W, H) / 4.4)));
    const ox = Math.round((W - shape.w * cell) / 2);
    const oy = Math.round((H - shape.h * cell) / 2);
    const base = (spec.typeKey === 'normal' && TT.NORMAL_TINTS[shape.family]) || type.colors.base;
    const bevel = Math.max(1, Math.round(cell * 0.14));
    for (const [cx, cy] of shape.cells) {
      const x = ox + cx * cell, y = oy + (shape.h - 1 - cy) * cell;
      ctx.fillStyle = type.colors.dark;
      ctx.fillRect(x, y, cell, cell);
      ctx.fillStyle = type.colors.light;
      ctx.fillRect(x, y, cell - bevel, cell - bevel);
      ctx.fillStyle = base;
      ctx.fillRect(x + bevel, y + bevel, cell - 2 * bevel, cell - 2 * bevel);
    }
  }

  function sampleSpec(key) {
    const type = TT.BLOCK_TYPES[key];
    return { n: -1, typeKey: key, shapeId: (type && type.shape) || SAMPLE_SHAPES[key] || 'T0' };
  }

  // Odds panel rows: positive group then negative group, each in unlock order
  function byUnlock(keys) {
    return keys.slice().sort((a, b) => TT.BLOCK_TYPES[a].unlock - TT.BLOCK_TYPES[b].unlock);
  }

  function setText(nodes, text) {
    for (const n of nodes) if (n.textContent !== text) n.textContent = text;
  }

  // ---- UI ------------------------------------------------------------------------------------
  class UI {
    constructor(app) {
      this.app = app;
      this.root = document.getElementById('app');
      this.game = null;
      this.stack = [];          // open screens, top last: { name, el, from }
      this.hud = {};            // values currently shown in the HUD
      this.hearts = [];
      this._dirtyPreviews = true;
      this._inert = null;
      this._summary = null;
      this._overAt = -Infinity;
      this._oddsSig = null;     // what the odds displays currently show
      this._toasts = [];        // toasts on screen (not leaving), oldest first
      this._toastQueue = [];    // new-block intros waiting for a free spot (toast opts)
      this._toastNext = 0;      // performance.now() before which no waiting toast is shown
      this._toastTop = null;    // toasts at the top of the playfield (else the bottom); null = undecided
      this._toastH = -1;        // height of the toast stack, -1 = measure again
      this._compact = false;    // short playfield: one compact toast at a time
      this._stageH = 0;
      this._stageW = 0;
      this._cueW = 0;           // measured size of the "Dropping when ready" cue (0 = measure again)
      this._cueH = 0;
      this._cancelledTimer = 0; // ends the "Cancelled" flash
      this._chipClear = 0;      // px the portrait odds chip covers at the bottom of the playfield
      this._info = null;        // the block on the card: { key, spec }
      this._exploreRows = [];   // explorer rows (odds rows too, see _syncOdds)
      this._pt = { x: 0, y: 0 };

      const q = (sel) => this.root.querySelector(sel);
      this.screens = {};
      for (const s of this.root.querySelectorAll('[data-screen]')) {
        this.screens[s.dataset.screen] = s;
        s.hidden = true;
      }
      this.el = {
        stage: q('#stage'), hudTop: q('#hud-top'), hudTray: q('#hud-tray'), toasts: q('#toasts'), oddsChip: q('#odds-chip'),
        lives: q('#hud-lives'), height: q('#hud-height'), best: q('#hud-best'), desc: q('#hud-desc'),
        trayCue: q('#tray-cue'), dropCue: q('#drop-cue'), dropCueBar: q('#drop-cue .cue-bar i'),
        modeBtns: Array.from(this.root.querySelectorAll('.hud [data-action="mode"]')),
        modeNames: Array.from(this.root.querySelectorAll('.hud .mode-name')),
        milestone: q('#hud-milestone'), seed: q('#hud-seed'),
        titleBest: q('#title-best'), play: q('#btn-play'), playUrl: q('#btn-play-url'), playUrlSeed: q('#play-url-seed'),
        dailySub: q('#daily-sub'), blocksSub: q('#blocks-sub'), version: q('#version'),
        seedForm: q('#seed-form'), seedInput: q('#seed-input'), seedBest: q('#seed-best'), seedRules: q('#seed-rules'),
        typeGroups: q('#type-groups'), blocksSummary: q('#blocks-summary'), codex: q('#codex'),
        modeHint: q('#mode-hint'), vibrationHint: q('#vibration-hint'), pauseInfo: q('#pause-info'),
        overHeight: q('#over-height'), overBadge: q('#over-badge'), overTime: q('#over-time'),
        overDrops: q('#over-drops'), overLost: q('#over-lost'), overSeed: q('#over-seed'),
        overPrev: q('#over-prev'), copyBtn: q('#btn-copy'), copyFallback: q('#copy-fallback'),
        sameSeed: Array.from(this.root.querySelectorAll('[data-setting="restartSameSeed"]')),
        sameSeedVal: Array.from(this.root.querySelectorAll('[data-same-seed]')),
        exploreBody: q('#explore-body'),
        info: {
          panel: q('#info-panel'), canvas: q('#info-canvas'), cat: q('#info-cat'), name: q('#info-name'),
          desc: q('#info-desc'), unlock: q('#info-unlock'), odds: q('#info-odds'), note: q('#info-note'), all: q('#info-all')
        }
      };
      this.slots = Array.from(this.root.querySelectorAll('.slot')).map((btn) => ({
        btn,
        canvas: btn.querySelector('.slot-canvas'),
        name: btn.querySelector('.slot-name'),
        cat: btn.querySelector('.slot-cat'),
        help: this.root.querySelector('[data-help="' + btn.dataset.slot + '"]'),   // its "?" badge
        spec: undefined, used: null, sel: null, helpKey: undefined   // what the slot currently shows
      }));

      this.el.version.textContent = 'v' + C.VERSION;
      for (const n of this.root.querySelectorAll('[data-c]')) {
        if (C[n.dataset.c] != null) n.textContent = String(C[n.dataset.c]);
      }
      this.el.shield = make('span', 'shield-badge');
      this.el.shield.appendChild(icon('i-shield'));
      this.el.shield.hidden = true;
      this._buildHearts(C.MAX_LIVES);
      this._buildTypeLists();
      this._buildOdds();
      this._wire();
    }

    // ---- game binding & per-frame HUD sync -----------------------------------------------
    bindGame(game) {
      this.game = game;
      this.hud = {};
      for (const s of this.slots) { s.spec = undefined; s.used = null; s.sel = null; s.helpKey = undefined; }
      this.root.classList.toggle('no-game', !game);
      const seedEl = this.el.seed;
      seedEl.textContent = '';
      if (game) seedEl.append('Seed ', make('b', '', game.seed), ' · ' + rulesLabel(game.rules));
      this._clearDragCues();
      // The previous run's toasts (and intros still waiting) go with it; warnings stay
      this._toastQueue.length = 0;
      for (const t of this._toasts.slice()) if (t._opts.kind !== 'warn') this._dropToast(t);
      // Dragging is the only way to drop by touch or mouse: say so once
      if (game && !Seen.has(DRAG_TIP)) {
        Seen.add(DRAG_TIP);
        this.toast({ id: 'drag-tip', title: 'Drag a block onto the playfield', text: 'Or drag on the playfield. Let go there to drop it, or drag back to the tray to cancel.', time: 7 });
      }
    }

    update() {
      const g = this.game;
      if (!g) return;
      const h = this.hud;
      const e = this.el;

      if (h.lives !== g.lives || h.shield !== g.shield || h.maxLives !== g.maxLives) {
        if (h.maxLives !== g.maxLives && g.maxLives !== this.hearts.length) this._buildHearts(g.maxLives);
        if (h.lives != null) {
          if (g.lives < h.lives || (h.shield && !g.shield)) this._flash(e.lives, 'is-hit');
          else if (g.lives > h.lives || (g.shield && !h.shield)) this._flash(e.lives, 'is-gain');
        }
        for (let i = 0; i < this.hearts.length; i++) this.hearts[i].classList.toggle('is-empty', i >= g.lives);
        e.shield.hidden = !g.shield;
        e.lives.setAttribute('aria-label', 'Lives: ' + g.lives + ' of ' + g.maxLives + (g.shield ? ', shield active' : ''));
        h.lives = g.lives; h.shield = g.shield; h.maxLives = g.maxLives;
      }

      const hNow = Math.round(g.height * 10), hBest = Math.round(g.bestHeight * 10);
      if (h.height !== hNow) { e.height.textContent = (hNow / 10).toFixed(1) + ' m'; h.height = hNow; }
      if (h.best !== hBest) { e.best.textContent = (hBest / 10).toFixed(1) + ' m'; h.best = hBest; }

      if (h.mode !== g.mode) {
        const info = MODE_INFO[g.mode] || { name: String(g.mode), hint: '' };
        for (const n of e.modeNames) n.textContent = info.name;
        for (const b of e.modeBtns) b.setAttribute('aria-label', 'Placement mode: ' + info.name + '. Press to change.');
        if (h.mode != null && !this.stack.length) this.toast({ id: 'mode', title: info.name + ' mode', text: info.hint, time: 2.2 });
        h.mode = g.mode;
      }

      if (h.round !== g.round) { h.round = g.round; this._introduce(g.batch); }
      let allDrawn = true;
      for (let i = 0; i < this.slots.length; i++) {
        if (!this._syncSlot(this.slots[i], g.batch[i] || null, g.selected === i)) allDrawn = false;
      }
      if (allDrawn) this._dirtyPreviews = false;

      const p = g.piece;
      const descKey = p ? p.spec.typeKey : g.ending || g.state === 'over' ? '#end' : '#wait';
      if (h.desc !== descKey) {
        h.desc = descKey;
        const d = e.desc;
        d.className = 'hud-desc ' + (p ? categoryClass(p.type) : '');
        d.textContent = '';
        if (p && p.type) d.append(make('b', '', p.type.name), ' — ' + p.type.desc);
        else d.textContent = descKey === '#end' ? 'The tower has fallen.' : 'Next blocks are on their way…';
      }

      this._syncDrag(g);

      // game.odds is replaced whenever best height rises; the DOM changes only when a shown value does
      if (h.odds !== g.odds) { h.odds = g.odds; this._syncOdds(); }

      const full = g.lives >= g.maxLives;
      if (h.mile !== g.nextMilestone || h.full !== full) {
        const m = e.milestone;
        m.textContent = '';
        m.append(icon('i-heart'), full ? 'Lives full · next milestone ' : 'Next life at ', make('b', '', g.nextMilestone + ' m'));
        h.mile = g.nextMilestone;
        h.full = full;
      }
      this._updateToasts(g);
    }

    // Returns false if the preview could not be drawn yet (canvas without layout)
    _syncSlot(slot, b, selected) {
      const spec = b ? b.spec : null;  // spec objects are stable for the lifetime of a batch
      let ok = true;
      if (slot.spec !== spec || this._dirtyPreviews) {
        const type = spec ? TT.BLOCK_TYPES[spec.typeKey] : null;
        ok = drawPreview(slot.canvas, spec);
        slot.spec = ok ? spec : undefined;
        slot.name.textContent = type ? type.name : '';
        slot.cat.textContent = type ? (CATEGORY_TEXT[type.category] || '') : '';
        slot.btn.classList.remove('cat-positive', 'cat-negative', 'cat-normal');
        if (type) slot.btn.classList.add(categoryClass(type));
        slot.btn.classList.toggle('is-empty', !b);
        const n = slot.btn.dataset.slot;
        slot.btn.setAttribute('aria-label', 'Block ' + (Number(n) + 1) + (type ? ': ' + type.name : ''));
      }
      const used = !b || b.used;
      if (slot.used !== used) {
        slot.btn.classList.toggle('is-used', used);
        slot.used = used;
      }
      if (slot.sel !== selected) {
        slot.btn.classList.toggle('is-selected', selected);
        slot.btn.setAttribute('aria-pressed', String(selected));
        slot.sel = selected;
      }
      // The "?" badge: on a special block that is still to be placed
      const helpKey = !used && isSpecial(spec.typeKey) ? spec.typeKey : '';
      if (slot.helpKey !== helpKey) this._syncHelp(slot, helpKey);
      return ok;
    }

    _syncHelp(slot, key) {
      slot.helpKey = key;
      const h = slot.help;
      if (!h) return;
      h.hidden = !key;
      h.classList.remove('cat-positive', 'cat-negative');
      if (!key) return;
      const type = TT.BLOCK_TYPES[key];
      h.classList.add(categoryClass(type));
      const label = 'What does ' + type.name + ' do?';
      h.setAttribute('aria-label', label);
      h.title = label;
    }

    // ---- drag cues (state from TT.Input) ----------------------------------------------------
    // The lifted slot. Over the playfield the tray shows a calm hint; anywhere else (where letting
    // go cancels) it turns into a red "Release to cancel" target, the piece is greyed out and
    // crossed (renderer.setDragCue) and the phone buzzes once on the way in. A drag let go there
    // flashes "Cancelled" with a soft sound. "Dropping when ready" sits by the piece while a drop waits.
    _syncDrag(g) {
      const c = this.app && this.app.input ? this.app.input.cue : null;
      const h = this.hud, e = this.el;
      const lifted = c ? c.slot : -1, zone = (c && c.zone) || '', queued = !!(c && c.queued);
      const cancels = c ? c.cancels | 0 : 0;
      if (h.lifted !== lifted) {
        for (let i = 0; i < this.slots.length; i++) this.slots[i].btn.classList.toggle('is-lifted', i === lifted);
        h.lifted = lifted;
      }
      if (h.zone !== zone) {
        if (zone === 'cancel' && h.zone === 'field') this._buzz(CANCEL_BUZZ_MS);
        if (zone) this._endCancelled();
        e.hudTray.classList.toggle('is-dragging', zone === 'field');
        e.hudTray.classList.toggle('is-cancel', zone === 'cancel');
        this.root.classList.toggle('is-dragging', !!zone);
        this.root.classList.toggle('is-drag-cancel', zone === 'cancel');
        if (zone) e.trayCue.textContent = CUE_TEXT[zone] || '';
        this._rendererCue(zone);
        h.zone = zone;
      }
      if (h.cancels !== cancels) {
        if (h.cancels != null && cancels > h.cancels && !zone) this._flashCancelled();
        h.cancels = cancels;
      }
      if (h.queued !== queued) {
        e.dropCue.hidden = !queued;
        h.queued = queued;
        h.cueX = NaN; h.cueY = NaN; h.cueP = NaN;
        this._cueW = 0;
      }
      if (queued) this._placeDropCue(g);
    }

    // Centred above the hovering piece (below it when the piece is at the top of the playfield),
    // with the drop readiness as a thin bar
    _placeDropCue(g) {
      const h = this.hud, e = this.el, box = e.dropCue;
      if (!this._cueW) { this._cueW = box.offsetWidth; this._cueH = box.offsetHeight; }
      const w = this._cueW, r = this.app.renderer, p = g.piece;
      let x = this._stageW / 2, y = CUE_GAP;
      if (r && p && p.shape && r.scale > 0 && typeof r.worldToScreen === 'function') {
        const top = r.worldToScreen(p.x + p.shape.w / 2, p.y + p.shape.h, this._pt);
        x = top.x;
        y = top.y - CUE_GAP - this._cueH;
        if (y < CUE_GAP) y = r.worldToScreen(0, p.y, this._pt).y + CUE_GAP;
      }
      x = Math.round(clamp(x - w / 2, 4, Math.max(4, this._stageW - w - 4)));
      y = Math.round(y);
      if (x !== h.cueX || y !== h.cueY) {
        box.style.transform = 'translate(' + x + 'px, ' + y + 'px)';
        h.cueX = x;
        h.cueY = y;
      }
      const prog = Math.round(clamp(g.readyProgress || 0, 0, 1) * 50) / 50;
      if (prog !== h.cueP) { e.dropCueBar.style.transform = 'scaleX(' + prog + ')'; h.cueP = prog; }
    }

    _clearDragCues() {
      const e = this.el;
      for (const s of this.slots) s.btn.classList.remove('is-lifted');
      e.hudTray.classList.remove('is-dragging', 'is-cancel');
      this.root.classList.remove('is-dragging', 'is-drag-cancel');
      this._endCancelled();
      this._rendererCue('');
      e.dropCue.hidden = true;
    }

    // The renderer greys out and crosses the piece (and hides its ghost) while letting go would cancel
    _rendererCue(zone) {
      const r = this.app && this.app.renderer;
      if (r && typeof r.setDragCue === 'function') r.setDragCue({ active: !!zone, cancel: zone === 'cancel' });
    }

    _buzz(ms) {
      const a = this.app && this.app.audio;
      if (a && typeof a.vibrate === 'function') a.vibrate(ms, 0);   // off when vibration is off in Settings
    }

    // "Cancelled" in the tray for a moment, with a soft sound: the drag was let go outside the playfield
    _flashCancelled() {
      const e = this.el;
      e.trayCue.textContent = CANCELLED_TEXT;
      e.hudTray.classList.remove('is-cancelled');
      void e.hudTray.offsetWidth;   // restart the animation
      e.hudTray.classList.add('is-cancelled');
      clearTimeout(this._cancelledTimer);
      this._cancelledTimer = setTimeout(() => this._endCancelled(), CANCELLED_MS);
      this._sfx('cancel');
    }

    _endCancelled() {
      clearTimeout(this._cancelledTimer);
      this._cancelledTimer = 0;
      this.el.hudTray.classList.remove('is-cancelled');
    }

    // First-time "new block" toasts; a type counts as seen once its toast is actually shown
    _introduce(batch) {
      if (!batch) return;
      for (const slot of batch) {
        const type = TT.BLOCK_TYPES[slot.spec.typeKey];
        if (!type || (type.category !== 'positive' && type.category !== 'negative')) continue;
        if (Seen.has(type.key) || this._toastQueue.some((o) => o.intro === type.key)) continue;
        this.toast({ title: 'New block: ' + type.name, text: type.desc, kind: type.category, spec: slot.spec, time: 6.5, intro: type.key });
      }
    }

    _buildHearts(n) {
      const box = this.el.lives;
      box.textContent = '';
      this.hearts = [];
      for (let i = 0; i < n; i++) {
        const s = icon('i-heart', 'heart');
        box.appendChild(s);
        this.hearts.push(s);
      }
      box.appendChild(this.el.shield);
    }

    // Restartable one-shot CSS animation
    _flash(node, cls) {
      node.classList.remove(cls);
      void node.offsetWidth;
      node.classList.add(cls);
      clearTimeout(node['_t' + cls]);
      node['_t' + cls] = setTimeout(() => node.classList.remove(cls), 700);
    }

    // Called by main.js when the playfield/tray layout or the device pixel ratio changed
    onLayout() {
      this._dirtyPreviews = true;
      const top = this.top();
      if (top && (top.name === 'blocks' || top.name === 'howto' || top.name === 'odds' || top.name === 'explore')) this._drawPreviews(top.el);
      if (top && top.name === 'blockinfo') this._drawInfo();
      // Toasts: compact on short playfields, and kept above the portrait odds chip
      const st = this.el.stage.getBoundingClientRect(), chip = this.el.oddsChip.getBoundingClientRect();
      this._stageH = st.height;
      this._stageW = st.width;
      this._cueW = 0;      // measure the drop cue again
      this._chipClear = chip.height > 0 ? Math.max(0, Math.round(st.bottom - chip.top)) : 0;
      this.el.toasts.style.setProperty('--chip-clear', this._chipClear + 'px');
      const compact = st.height > 0 && st.height < TOAST_COMPACT_H;
      if (compact !== this._compact) {
        this._compact = compact;
        this.el.toasts.classList.toggle('is-compact', compact);
        this._trimToasts();
        for (const t of this._toasts) if (t._canvas) drawPreview(t._canvas, t._opts.spec);
      }
      this._toastH = -1;
    }

    // ---- toasts ---------------------------------------------------------------------------
    // opts: { title, text, kind: 'info' | 'positive' | 'negative' | 'warn', spec, time (s), id,
    //         intro: type key of a first-time "new block" toast (it waits for a free spot instead of
    //         pushing other toasts out) }
    // Toasts never catch pointer events; a press on the playfield dismisses them.
    toast(opts) {
      const o = opts || {};
      if (o.id) {
        const old = this._toasts.find((t) => t._opts.id === o.id);
        if (old) this._dropToast(old);
      }
      if (o.intro && (this._toastQueue.length || this._toasts.length >= this._toastMax())) {
        this._toastQueue.push(o);
        return null;
      }
      return this._showToast(o);
    }

    _toastMax() { return this._compact ? 1 : TOAST_MAX; }

    _showToast(o) {
      const t = make('div', 'toast toast-' + (o.kind || 'info'));
      t._opts = o;
      if (o.spec) { t._canvas = make('canvas', 'toast-canvas'); t.appendChild(t._canvas); }
      const body = make('div', 'toast-body');
      if (o.title) body.appendChild(make('strong', '', o.title));
      if (o.text) body.appendChild(make('span', '', o.text));
      t.appendChild(body);
      this.el.toasts.appendChild(t);
      this._toasts.push(t);
      if (t._canvas) drawPreview(t._canvas, o.spec);
      if (o.intro) Seen.add(o.intro);
      this._trimToasts();
      t._timer = setTimeout(() => this._closeToast(t), (o.time || TOAST_TIME) * 1000);
      this._toastH = -1;
      return t;
    }

    // Over the limit the oldest toast goes (an intro goes back to the front of the queue)
    _trimToasts() {
      while (this._toasts.length > this._toastMax()) {
        const old = this._toasts[0];
        if (old._opts.intro) this._toastQueue.unshift(old._opts);
        this._dropToast(old);
      }
    }

    _closeToast(t) {
      const i = this._toasts.indexOf(t);
      if (i < 0) return;
      this._toasts.splice(i, 1);
      clearTimeout(t._timer);
      t.classList.add('is-leaving');
      setTimeout(() => { t.remove(); this._toastH = -1; }, 220);
      this._toastNext = performance.now() + TOAST_GAP_MS;
    }

    _dropToast(t) {
      const i = this._toasts.indexOf(t);
      if (i >= 0) this._toasts.splice(i, 1);
      clearTimeout(t._timer);
      t.remove();
      this._toastH = -1;
    }

    // Once per frame: a waiting intro takes a free spot (not behind a menu); toasts dodge the
    // piece and its ghost
    _updateToasts(g) {
      if (this._toastQueue.length && !this.stack.length && this._toasts.length < this._toastMax() &&
          performance.now() >= this._toastNext) this._showToast(this._toastQueue.shift());
      if (this._toasts.length) this._placeToasts(g);
      else this._toastTop = null;
    }

    // The first press on the playfield clears the toasts out of the way (warnings stay)
    _dismissToasts() {
      for (const t of this._toasts.slice()) if (t._opts.kind !== 'warn') this._closeToast(t);
    }

    // Toasts sit at the top of the playfield while that leaves the hovering piece and its landing
    // ghost uncovered (early in a run the tower is low), else at the bottom (the camera follows a
    // tall tower up, so its top and the piece are high on screen). Switches only when the current
    // side would cover them and the other side would not.
    _placeToasts(g) {
      const r = this.app.renderer, p = g.piece;
      if (!r || !p || !p.shape || !(r.scale > 0) || !(this._stageH > 0) || typeof r.worldToScreen !== 'function') return;
      if (this._toastH < 0) this._toastH = this.el.toasts.offsetHeight;
      const need = this._toastH + TOAST_CLEAR;
      const pieceTop = r.worldToScreen(0, p.y + p.shape.h, this._pt).y;
      const gh = g.ghost;
      const low = r.worldToScreen(0, gh && !gh.void && Number.isFinite(gh.y) ? gh.y : p.y, this._pt).y;
      const topFree = pieceTop >= need;
      const bottomFree = low <= this._stageH - this._chipClear - need;
      let atTop = this._toastTop;
      if (atTop == null) atTop = topFree || !bottomFree;
      else if (atTop ? !topFree && bottomFree : topFree && !bottomFree) atTop = !atTop;
      if (atTop !== this._toastTop) {
        this._toastTop = atTop;
        this.el.toasts.classList.toggle('at-top', atTop);
      }
    }

    // ---- screens --------------------------------------------------------------------------
    show(name, opts) {
      const screen = this.screens[name];
      if (!screen) return;
      if (opts && opts.replace) this._clearStack();
      const top = this.top();
      if (top && top.name === name) { this._prepare(name); return; }
      if (top) top.el.hidden = true;
      this.stack.push({ name, el: screen, from: document.activeElement });
      screen.hidden = false;
      if (PLAY_PANELS.has(name) && this._toasts.length) this._dismissToasts();
      const panel = screen.querySelector('.panel');
      if (panel) panel.scrollTop = 0;
      this._prepare(name);
      this._syncInert();
      this._focusInitial(screen);
      this._navigated();
      this._wake();
    }

    back() {
      const cur = this.stack.pop();
      if (!cur) return;
      cur.el.hidden = true;
      const next = this.top();
      if (next) {
        next.el.hidden = false;
        this._prepare(next.name);
      }
      this._syncInert();
      if (next) {
        if (cur.from && next.el.contains(cur.from) && cur.from.getClientRects().length) cur.from.focus({ preventScroll: true });
        else this._focusInitial(next.el);
      } else if (!this.game) {
        this.show('title');
      } else if (this.game.state === 'paused') {
        this.app.resume(); // a panel opened straight from play (the odds) closed: back to the game
      }
      this._navigated();
      this._wake();
    }

    closeAll() {
      this._clearStack();
      this._syncInert();
      const a = document.activeElement;
      if (a && a !== document.body && typeof a.blur === 'function') a.blur();
      this._navigated();
    }

    top() { return this.stack.length ? this.stack[this.stack.length - 1] : null; }
    isMenuOpen() { return this.stack.length > 0; }

    _clearStack() {
      while (this.stack.length) this.stack.pop().el.hidden = true;
    }

    _syncInert() {
      const open = this.stack.length > 0;
      if (open === this._inert) return;
      this._inert = open;
      this.root.classList.toggle('menu-open', open);
      for (const n of [this.el.stage, this.el.hudTop, this.el.hudTray]) {
        if (open) n.setAttribute('inert', ''); else n.removeAttribute('inert');
      }
    }

    _focusInitial(screen) {
      const target = Array.from(screen.querySelectorAll('[data-autofocus]')).find((n) => n.getClientRects().length) ||
        this._focusables(screen)[0];
      if (target) target.focus({ preventScroll: true });
    }

    _focusables(container) {
      return Array.from(container.querySelectorAll('button, input, textarea, [tabindex]:not([tabindex="-1"])'))
        .filter((n) => !n.disabled && (n.type !== 'radio' || n.checked) && n.getClientRects().length);
    }

    _prepare(name) {
      switch (name) {
        case 'title': this._prepTitle(); break;
        case 'seed': this._prepSeed(); break;
        case 'blocks': this._syncTypes(); this._drawPreviews(this.screens.blocks); break;
        case 'howto': this._drawPreviews(this.screens.howto); break;
        case 'settings': this.syncSettings(); break;
        case 'pause': this._prepPause(); break;
        case 'odds': this._syncOdds(); this._drawPreviews(this.screens.odds); break;
        case 'explore': this._syncOdds(); this._drawPreviews(this.screens.explore); break;
        case 'blockinfo': this._prepInfo(); break;
        default: break;
      }
    }

    _prepTitle() {
      const app = this.app, e = this.el;
      const rules = rulesOf(app.settings.enabledTypes);
      const top = Records.top(rules);
      e.titleBest.textContent = '';
      if (top) e.titleBest.append('Best ', make('b', '', fmtM(top.height)), ' on seed ', make('b', '', top.seed));
      else e.titleBest.textContent = 'No tower yet. How high can you build?';
      if (rules) e.titleBest.append(' (custom block set)');
      e.playUrl.hidden = !app.urlSeed;
      e.playUrlSeed.textContent = app.urlSeed || '';
      e.play.classList.toggle('btn-primary', !app.urlSeed); // one primary action at a time
      const daily = TT.RNG.dailySeed();
      const rec = Records.get(daily, rules);
      e.dailySub.textContent = rec ? 'today ' + fmtM(rec.height) : daily;
      const n = app.settings.enabledTypes.length, total = TT.SPECIAL_KEYS.length;
      e.blocksSub.textContent = n === total ? 'all on' : n + ' of ' + total + ' on';
    }

    _prepSeed() {
      const inp = this.el.seedInput;
      if (!inp.value && this.app.urlSeed) inp.value = this.app.urlSeed;
      this._seedHint();
      this.el.seedRules.textContent = 'Your block set: ' + rulesLabel(rulesOf(this.app.settings.enabledTypes)) +
        '. You can change it under Special Blocks.';
    }

    _seedHint() {
      const seed = TT.RNG.normalizeSeed(this.el.seedInput.value);
      const rec = seed ? Records.get(seed, rulesOf(this.app.settings.enabledTypes)) : null;
      this.el.seedBest.textContent = !seed ? 'Leave it empty for a random seed.'
        : rec ? 'Your best on ' + seed + ': ' + fmtM(rec.height) : 'No record on this seed yet.';
    }

    _prepPause() {
      for (const b of this.screens.pause.querySelectorAll('.is-armed')) this._disarm(b);
      this._syncOdds(); // the "Block odds" button shows good / bad
      const g = this.game;
      const info = this.el.pauseInfo;
      info.textContent = '';
      if (!g) return;
      this._syncRestart(g.seed);
      info.append('Seed ', make('b', '', g.seed), ' · best ' + fmtM(g.bestHeight) + ' · ' + formatTime(g.elapsed));
      if (g.rules) {
        const label = rulesLabel(g.rules);
        info.append(make('br'), label.charAt(0).toUpperCase() + label.slice(1));
      }
    }

    // "Same seed" beside Restart (pause menu) and Play again (game over): one saved setting for both,
    // labelled with the seed it would replay. Unticked, they start a new random seed.
    _syncRestart(seed) {
      const on = !!this.app.settings.restartSameSeed;
      for (const c of this.el.sameSeed) c.checked = on;
      if (seed != null) setText(this.el.sameSeedVal, '(' + seed + ')');
    }

    syncSettings() {
      const s = this.app.settings;
      const scr = this.screens.settings;
      for (const r of scr.querySelectorAll('input[name="set-mode"]')) r.checked = r.value === s.mode;
      for (const c of scr.querySelectorAll('[data-setting]')) c.checked = !!s[c.dataset.setting];
      const info = MODE_INFO[s.mode] || { hint: '' };
      this.el.modeHint.textContent = info.hint + ' New games start in this mode; Ctrl or the mode button switches it while playing.';
      const canVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
      this.el.vibrationHint.textContent = canVibrate ? 'Haptic feedback on phones that support it.' : 'Not supported by this browser.';
    }

    showGameOver(summary, result) {
      const r = result || {};
      const e = this.el;
      this._summary = summary;
      e.overHeight.textContent = round1(summary.bestHeight).toFixed(1);
      if (r.isTop) { e.overBadge.textContent = 'New best'; e.overBadge.className = 'badge'; e.overBadge.hidden = false; }
      else if (r.isNew && r.previous != null) { e.overBadge.textContent = 'Seed record'; e.overBadge.className = 'badge is-seed'; e.overBadge.hidden = false; }
      else e.overBadge.hidden = true;
      const st = summary.stats || {};
      e.overTime.textContent = formatTime(summary.elapsed);
      e.overDrops.textContent = String(st.drops != null ? st.drops : summary.turn || 0);
      e.overLost.textContent = String(st.lost || 0);
      e.overSeed.textContent = '';
      e.overSeed.append('Seed ', make('b', '', summary.seed), ' · ' + rulesLabel(summary.rules));
      e.overPrev.textContent = r.previous == null ? ''
        : (r.isNew ? 'Previous best on this seed: ' : 'Your best on this seed: ') + fmtM(r.previous);
      e.overPrev.hidden = r.previous == null;
      e.copyFallback.hidden = true;
      e.copyBtn.textContent = 'Copy result';
      e.copyBtn.classList.remove('is-done');
      this._syncRestart(summary.seed);
      this._overAt = performance.now();
      this.show('over', { replace: true });
    }

    // ---- special blocks & codex ---------------------------------------------------------------
    _buildTypeLists() {
      const groups = [
        { cat: 'positive', keys: TT.POSITIVE_KEYS, title: 'Positive', sub: 'Cold colours. They help you.' },
        { cat: 'negative', keys: TT.NEGATIVE_KEYS, title: 'Negative', sub: 'Warm colours. They get in your way.' }
      ];
      const box = this.el.typeGroups;
      box.textContent = '';
      for (const g of groups) {
        const sec = make('section', 'type-group group-' + g.cat);
        const head = make('div', 'group-head');
        const h3 = make('h3', '', g.title);
        h3.appendChild(make('small', '', g.sub));
        const btns = make('div', 'group-btns');
        for (const on of [true, false]) {
          const b = make('button', 'btn btn-small', on ? 'All on' : 'All off');
          b.type = 'button';
          b.dataset.action = 'types-all';
          b.dataset.group = g.cat;
          b.dataset.on = on ? '1' : '0';
          b.setAttribute('aria-label', (on ? 'Enable' : 'Disable') + ' all ' + g.title.toLowerCase() + ' blocks');
          btns.appendChild(b);
        }
        head.append(h3, btns);
        const list = make('ul', 'type-list');
        for (const key of g.keys) {
          const li = make('li');
          li.appendChild(this._typeRow(key, true));
          list.appendChild(li);
        }
        sec.append(head, list);
        box.appendChild(sec);
      }

      const codex = this.el.codex;
      codex.textContent = '';
      const sections = [['Normal', ['normal']], ['Positive (cold)', TT.POSITIVE_KEYS], ['Negative (warm)', TT.NEGATIVE_KEYS]];
      for (const [title, keys] of sections) {
        const sec = make('div', 'codex-group');
        sec.appendChild(make('h4', '', title));
        for (const key of keys) sec.appendChild(this._typeRow(key, false));
        codex.appendChild(sec);
      }
    }

    _typeRow(key, withSwitch) {
      const type = TT.BLOCK_TYPES[key];
      const row = make(withSwitch ? 'label' : 'div', 'type-row ' + categoryClass(type));
      const cv = make('canvas', 'type-canvas');
      cv.dataset.preview = key;
      const text = make('span', 'type-text');
      text.append(make('span', 'type-name', type.name), make('span', 'type-desc', type.desc));
      if (type.category !== 'normal') text.appendChild(make('span', 'type-unlock', unlockLabel(type)));
      row.append(cv, text);
      if (withSwitch) {
        const sw = make('input', 'switch');
        sw.type = 'checkbox';
        sw.setAttribute('role', 'switch');
        sw.setAttribute('aria-label', type.name);
        sw.dataset.typeToggle = key;
        row.appendChild(sw);
      }
      return row;
    }

    _drawPreviews(container) {
      const dpr = String(previewDpr());
      if (container.dataset.drawnDpr === dpr) return;
      let ok = true;
      for (const cv of container.querySelectorAll('canvas[data-preview]')) {
        const cell = Number(cv.dataset.cell) || LIST_PREVIEW_CELL;
        if (!drawPreview(cv, sampleSpec(cv.dataset.preview), { cell })) ok = false;
      }
      if (ok) container.dataset.drawnDpr = dpr;
    }

    _syncTypes() {
      const enabled = new Set(this.app.settings.enabledTypes);
      for (const sw of this.el.typeGroups.querySelectorAll('[data-type-toggle]')) {
        const on = enabled.has(sw.dataset.typeToggle);
        sw.checked = on;
        sw.closest('.type-row').classList.toggle('is-off', !on);
      }
      const n = enabled.size, total = TT.SPECIAL_KEYS.length;
      this.el.blocksSummary.textContent = n === total
        ? 'All ' + total + ' special blocks are on: the standard set. Scores are compared per seed and block set.'
        : n + ' of ' + total + ' special blocks on. Scores are compared per seed and block set, so this set keeps its own records.';
    }

    _setGroup(cat, on) {
      const keys = cat === 'positive' ? TT.POSITIVE_KEYS : TT.NEGATIVE_KEYS;
      const enabled = new Set(this.app.settings.enabledTypes);
      for (const k of keys) { if (on) enabled.add(k); else enabled.delete(k); }
      this.app.setEnabledTypes(TT.SPECIAL_KEYS.filter((k) => enabled.has(k)));
      this._syncTypes();
    }

    // ---- block odds (portrait chip, wide sidebar, pause menu, odds panel, explorer) --------------
    // Every [data-odds] node in index.html, plus the odds panel and explorer rows built here, is
    // filled by _syncOdds.
    _buildOdds() {
      this._exploreRows = this._buildExplorer();
      const rows = this._exploreRows.slice();
      // Two columns on wide panels: summary + good blocks | bad blocks (stacked when narrow)
      const groups = [
        { cat: 'positive', title: 'Good blocks', keys: TT.POSITIVE_KEYS, total: 'pos', box: this.root.querySelector('#odds-col-good') },
        { cat: 'negative', title: 'Bad blocks', keys: TT.NEGATIVE_KEYS, total: 'neg', box: this.root.querySelector('#odds-col-bad') }
      ];
      for (const gr of groups) {
        const sec = make('section', 'odds-group group-' + gr.cat);
        const h3 = make('h3', '', gr.title);
        const total = make('b');
        total.dataset.odds = gr.total;
        h3.appendChild(total);
        const list = make('ul', 'odds-list');
        for (const key of byUnlock(gr.keys)) {
          const type = TT.BLOCK_TYPES[key];
          const li = make('li', 'odds-row ' + categoryClass(type));
          const cv = make('canvas', 'odds-canvas');
          cv.dataset.preview = key;
          cv.dataset.cell = String(ODDS_PREVIEW_CELL);
          const val = make('span', 'odds-val');
          li.append(cv, make('span', 'odds-name', type.name), val);
          list.appendChild(li);
          rows.push({ key, li, val, text: null, state: null });
        }
        sec.append(h3, list);
        gr.box.appendChild(sec);
      }
      const nodes = (k) => Array.from(this.root.querySelectorAll('[data-odds="' + k + '"]'));
      this.oddsEl = {
        pos: nodes('pos'), neg: nodes('neg'), normal: nodes('normal'), next: nodes('next'),
        bars: Array.from(this.root.querySelectorAll('.odds-bar')).map((b) => Array.from(b.querySelectorAll('.odds-seg'))),
        buttons: Array.from(this.root.querySelectorAll('.hud [data-action="odds"]')),
        foot: this.root.querySelector('#odds-foot'),
        rows
      };
    }

    // The odds on show: the bound game's (exactly what its next deal uses), else a new run's
    _currentOdds() {
      const g = this.game;
      if (g && g.odds) return { o: g.odds, enabled: g.enabledTypes };
      const enabled = new Set((this.app.settings && this.app.settings.enabledTypes) || TT.SPECIAL_KEYS);
      return { o: TT.Generator.typeOdds(0, enabled), enabled };
    }

    _syncOdds() {
      const { o, enabled } = this._currentOdds();
      const d = this.oddsEl;
      const pos = fmtPct(o.pos), neg = fmtPct(o.neg), normal = fmtPct(o.normal);
      // Per type: its share, 'off' (switched off in Special Blocks) or not unlocked yet
      const rowText = d.rows.map((r) => typeOddsText(o, enabled, r.key));
      const sig = [pos, neg, normal, o.next ? o.next.key + '@' + o.next.unlock : ''].concat(rowText).join('|');
      if (sig === this._oddsSig) return;
      this._oddsSig = sig;
      setText(d.pos, pos);
      setText(d.neg, neg);
      setText(d.normal, normal);
      for (const [sp, sn, sg] of d.bars) {
        sp.style.flexGrow = String(o.pos); sp.hidden = !(o.pos > 0);
        sn.style.flexGrow = String(o.normal); sn.hidden = !(o.normal > 0);
        sg.style.flexGrow = String(o.neg); sg.hidden = !(o.neg > 0);
      }
      const nextType = o.next ? TT.BLOCK_TYPES[o.next.key] : null;
      for (const n of d.next) {
        n.textContent = '';
        n.hidden = !nextType;
        if (nextType) n.append('Next new block: ', make('b', categoryClass(nextType), nextType.name), ' at ' + o.next.unlock + ' m');
      }
      const label = 'Block odds: good ' + pos + ', bad ' + neg + '. Show the odds of every block.';
      for (const b of d.buttons) b.setAttribute('aria-label', label);
      let anyOff = false;
      d.rows.forEach((r, i) => {
        const text = rowText[i];
        const state = typeState(o, enabled, r.key);
        if (state === 'off') anyOff = true;
        if (r.text !== text) { r.val.textContent = text; r.text = text; }
        if (r.state !== state) {
          if (r.state) r.li.classList.remove('is-' + r.state);
          r.li.classList.add('is-' + state);
          r.state = state;
        }
      });
      d.foot.hidden = !anyOff;
    }

    // ---- special-block explorer ("?" button) and block cards ("?" badge on a block) ------------
    // Good then bad blocks, each in unlock order: preview, name, rule, unlock height and the odds
    // (kept up to date by _syncOdds). A row opens that block's card.
    _buildExplorer() {
      const rows = [];
      const box = this.el.exploreBody;
      if (!box) return rows;
      box.textContent = '';
      for (const gr of [
        { cat: 'positive', title: 'Good blocks', keys: TT.POSITIVE_KEYS, total: 'pos' },
        { cat: 'negative', title: 'Bad blocks', keys: TT.NEGATIVE_KEYS, total: 'neg' }
      ]) {
        const sec = make('section', 'odds-group explore-group group-' + gr.cat);
        const h3 = make('h3', '', gr.title);
        const total = make('b');
        total.dataset.odds = gr.total;
        h3.appendChild(total);
        const list = make('ul', 'explore-list');
        for (const key of byUnlock(gr.keys)) {
          const type = TT.BLOCK_TYPES[key];
          const btn = make('button', 'explore-row ' + categoryClass(type));
          btn.type = 'button';
          btn.dataset.action = 'explore-row';
          btn.dataset.key = key;
          const cv = make('canvas', 'explore-canvas');
          cv.dataset.preview = key;
          cv.dataset.cell = String(EXPLORE_PREVIEW_CELL);
          const val = make('span', 'explore-val');
          const head = make('span', 'explore-head');
          head.append(make('span', 'explore-name', type.name), val);
          const text = make('span', 'explore-text');
          text.append(head, make('span', 'explore-desc', type.desc), make('span', 'explore-unlock', unlockLabel(type)));
          btn.append(cv, text);
          const li = make('li');
          li.appendChild(btn);
          list.appendChild(li);
          rows.push({ key, li: btn, val, text: null, state: null });
        }
        sec.append(h3, list);
        box.appendChild(sec);
      }
      return rows;
    }

    // Which block the next card shows (main.js showBlockInfo). spec: the dealt block, else a sample
    setBlockInfo(key, spec) {
      if (!isSpecial(key)) return false;
      this._info = { key, spec: spec && spec.typeKey === key ? spec : sampleSpec(key) };
      return true;
    }

    _prepInfo() {
      const info = this._info, n = this.el.info;
      if (!info) return;
      const type = TT.BLOCK_TYPES[info.key];
      const { o, enabled } = this._currentOdds();
      const state = typeState(o, enabled, info.key);
      n.panel.classList.remove('cat-positive', 'cat-negative');
      n.panel.classList.add(categoryClass(type));
      n.cat.textContent = CATEGORY_TEXT[type.category];
      n.name.textContent = type.name;
      n.desc.textContent = type.desc;
      n.unlock.textContent = type.unlock > 0 ? 'From ' + type.unlock + ' m' : 'From the start';
      n.odds.textContent = typeOddsText(o, enabled, info.key);
      n.odds.classList.toggle('is-dim', state !== 'on');
      n.note.textContent = state === 'on' ? 'The chance that a block dealt at your best height is ' + type.name + '.'
        : state === 'off' ? 'Switched off for this run under Special Blocks.'
          : 'It starts to appear once your best height reaches ' + type.unlock + ' m.';
      n.all.hidden = this._below('explore');   // opened from the list: Close goes back to it
      this._drawInfo();
    }

    _drawInfo() {
      if (this._info) drawPreview(this.el.info.canvas, this._info.spec, { cell: INFO_PREVIEW_CELL });
    }

    // A screen of that name is open under the top one
    _below(name) {
      return this.stack.slice(0, -1).some((s) => s.name === name);
    }

    // The "?" badge on a block in the tray: that block's card. A second finger while a block is
    // being dragged is ignored, like everywhere else.
    _slotInfo(t) {
      const g = this.game, input = this.app.input;
      if (!g || (input && typeof input.isPressing === 'function' && input.isPressing())) return;
      const b = g.batch[Number(t.dataset.help)];
      if (b && !b.used) this.app.showBlockInfo(b.spec.typeKey, b.spec);
    }

    // The full list. From a card it takes the card's place with that block marked (or, when the
    // card was opened from the list, goes back to it).
    _explore() {
      const top = this.top();
      if (top && top.name === 'blockinfo') {
        if (this._below('explore')) { this.back(); return; }
        const key = this._info ? this._info.key : null;
        this.stack.pop();
        top.el.hidden = true;
        this.show('explore');
        this._markRow(key, true);
        return;
      }
      this._markRow(null);
      this.app.showExplorer();
    }

    // A row of the explorer: its card on top (Close comes back here, with the row marked)
    _rowInfo(key) {
      this._markRow(key);
      this.app.showBlockInfo(key);
    }

    _markRow(key, reveal) {
      for (const r of this._exploreRows) {
        const on = r.key === key;
        r.li.classList.toggle('is-current', on);
        if (on && reveal && typeof r.li.scrollIntoView === 'function') r.li.scrollIntoView({ block: 'center' });
      }
    }

    // ---- events ---------------------------------------------------------------------------
    _wire() {
      const root = this.root;
      root.addEventListener('click', (ev) => this._onClick(ev));
      root.addEventListener('change', (ev) => this._onChange(ev));
      this.el.stage.addEventListener('pointerdown', () => { if (this._toasts.length) this._dismissToasts(); });
      // In-game buttons never keep focus, or Space / Enter would also press them
      for (const hud of [this.el.hudTop, this.el.hudTray]) {
        hud.addEventListener('mousedown', (ev) => { if (ev.target.closest('button')) ev.preventDefault(); });
      }
      window.addEventListener('keydown', (ev) => this._onKey(ev));
      this.el.seedForm.addEventListener('submit', (ev) => {
        ev.preventDefault();
        const seed = TT.RNG.normalizeSeed(this.el.seedInput.value) || TT.RNG.randomSeed();
        this.el.seedInput.blur();
        this.app.startGame({ seed });
      });
      this.el.seedInput.addEventListener('input', () => this._seedHint());
    }

    _onClick(ev) {
      const t = ev.target.closest('[data-action]');
      if (!t || !this.root.contains(t)) return;
      // A pointer press on a block in the tray is TT.Input's (it selects on pointerdown and may turn
      // into a drag), so its click does nothing more. Keyboard activation (detail 0) selects.
      if (t.dataset.action === 'slot' && ev.detail > 0) return;
      this._run(t.dataset.action, t);
      if (ev.detail > 0 && t.closest('.hud')) t.blur();
    }

    _onChange(ev) {
      const t = ev.target;
      if (t.dataset.setting) {
        const key = t.dataset.setting;
        this.app.setSetting(key, !!t.checked);
        // Every box bound to this setting (both "Same seed" boxes) shows what was stored
        for (const c of this.root.querySelectorAll('[data-setting="' + key + '"]')) c.checked = !!this.app.settings[key];
      } else if (t.name === 'set-mode' && t.checked) { this.app.setSetting('mode', t.value); this.syncSettings(); }
      else if (t.dataset.typeToggle) {
        const enabled = new Set(this.app.settings.enabledTypes);
        if (t.checked) enabled.add(t.dataset.typeToggle); else enabled.delete(t.dataset.typeToggle);
        this.app.setEnabledTypes(TT.SPECIAL_KEYS.filter((k) => enabled.has(k)));
        this._syncTypes();
      }
      this._sfx('click');
      this._wake();
    }

    _run(action, t) {
      const app = this.app, g = this.game;
      if (performance.now() - this._overAt < OVER_GUARD_MS && t.closest('[data-screen="over"]')) return;
      switch (action) {
        case 'play': app.startGame({ seed: TT.RNG.randomSeed() }); break;
        case 'play-url': app.startGame({ seed: app.urlSeed }); break;
        case 'daily': app.startGame({ seed: TT.RNG.dailySeed() }); break;
        case 'open': this.show(t.dataset.target); break;
        case 'odds': app.showOdds(); break;
        case 'explore': this._explore(); break;
        case 'explore-row': this._rowInfo(t.dataset.key); break;
        case 'block-info': this._slotInfo(t); break;
        case 'back': this.back(); break;
        case 'seed-random': this.el.seedInput.value = TT.RNG.randomSeed(); this._seedHint(); break;
        case 'resume': app.resume(); break;
        case 'restart': if (this._confirmed(t)) app.restart(); break;   // follows the "Same seed" box
        case 'quit': if (this._confirmed(t)) app.quitToMenu(); break;
        case 'menu': app.quitToMenu(); break;
        case 'copy': this._copyResult(t); break;
        case 'types-all': this._setGroup(t.dataset.group, t.dataset.on === '1'); break;
        case 'pause': app.togglePause(); break;
        case 'mode': if (g) g.cycleMode(); break;
        case 'slot': if (g) g.selectSlot(Number(t.dataset.slot)); break;
        default: break;
      }
      if (!GAME_ACTIONS.has(action)) this._sfx('click'); // game actions have their own sounds
      this._wake();
    }

    // Destructive buttons with data-confirm need a second press while a run is in progress
    _confirmed(btn) {
      const g = this.game;
      if (!btn.dataset.confirm || !g || g.turn === 0 || g.state === 'over') return true;
      if (btn.classList.contains('is-armed')) { this._disarm(btn); return true; }
      btn._label = btn.textContent;
      btn.textContent = btn.dataset.confirm;
      btn.classList.add('is-armed');
      btn._armTimer = setTimeout(() => this._disarm(btn), CONFIRM_TIME * 1000);
      return false;
    }

    _disarm(btn) {
      if (!btn.classList.contains('is-armed')) return;
      clearTimeout(btn._armTimer);
      btn.textContent = btn._label;
      btn.classList.remove('is-armed');
    }

    async _copyResult(btn) {
      const s = this._summary;
      if (!s) return;
      const text = resultText(s);
      let ok = false;
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text);
          ok = true;
        }
      } catch (err) { ok = false; }
      if (!ok) ok = legacyCopy(text);
      const fb = this.el.copyFallback;
      if (ok) {
        fb.hidden = true;
        btn.textContent = 'Copied!';
        btn.classList.add('is-done');
        clearTimeout(btn._doneTimer);
        btn._doneTimer = setTimeout(() => { btn.textContent = 'Copy result'; btn.classList.remove('is-done'); }, 2000);
      } else {
        fb.value = text;
        fb.hidden = false;
        fb.focus();
        fb.select();
        btn.textContent = 'Copy the text below';
      }
    }

    _onKey(ev) {
      if (ev.defaultPrevented || !this.stack.length) return;
      const top = this.top();
      if (ev.key === 'Escape' || ev.key === 'Esc') {
        if (top.name === 'pause') { ev.preventDefault(); this.app.resume(); }
        else if (top.name !== 'title' && top.name !== 'over') { ev.preventDefault(); this.back(); }
        return;
      }
      if (isTyping(ev.target) || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      // P toggles pause, O the odds panel and ? / H the special-block explorer, from the menus they
      // belong to as well (the explorer and a block's card pause the game like the odds panel)
      const inPlay = top.name === 'pause' || top.name === 'odds' || top.name === 'explore' || top.name === 'blockinfo';
      if ((ev.key === 'p' || ev.key === 'P') && inPlay) {
        ev.preventDefault();
        if (!ev.repeat) this.app.resume();
        return;
      }
      if ((ev.key === 'o' || ev.key === 'O') && (top.name === 'pause' || top.name === 'odds')) {
        ev.preventDefault();
        if (!ev.repeat) { if (top.name === 'odds') this.back(); else this.app.showOdds(); }
        return;
      }
      if ((ev.key === '?' || ev.key === 'h' || ev.key === 'H') && inPlay) {
        ev.preventDefault();
        if (!ev.repeat) { if (top.name === 'explore') this.back(); else this._explore(); }
        return;
      }
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        if (ev.target && ev.target.type === 'radio') return; // radio groups use arrows natively
        ev.preventDefault();
        const items = this._focusables(top.el);
        if (!items.length) return;
        const i = items.indexOf(document.activeElement);
        const d = ev.key === 'ArrowDown' ? 1 : -1;
        const next = i < 0 ? (d > 0 ? items[0] : items[items.length - 1]) : items[(i + d + items.length) % items.length];
        next.focus();
      }
    }

    _wake() {
      if (this.app && typeof this.app.wake === 'function') this.app.wake();
    }

    // The screen stack changed (main.js keeps the Back guard in step)
    _navigated() {
      if (this.app && typeof this.app.navigated === 'function') this.app.navigated();
    }

    _sfx(name) {
      if (this.app && typeof this.app.sfx === 'function') this.app.sfx(name);
    }
  }

  // ---- Back button / back gesture ----------------------------------------------------------
  // While Back should stay in the app (a run, or a menu open over the title), one extra history
  // entry, the guard, sits on top of the page's own. Back pops it: onBack() closes the top screen
  // or pauses, then sync() pushes a new guard if one is still wanted. A guard no longer wanted is
  // taken down with history.back(), whose popstate is ignored. The URL never changes, so this also
  // works from file://.
  class BackGuard {
    // opts: { history, wanted() -> bool, onBack() }
    constructor(opts) {
      this.history = opts.history;
      this.wanted = opts.wanted;
      this.onBack = opts.onBack;
      this.active = false;     // the current history entry is our guard
      this.leaving = false;    // our own history.back() is on its way
      this.off = false;        // the history API does not work here: Back simply leaves
      this._timer = 0;
      const st = this.history.state;
      // Reloaded on a guard entry: it belonged to the previous page, so it is a plain entry now
      if (st && st[GUARD]) {
        try { this.history.replaceState(null, ''); } catch (err) { /* harmless */ }
      }
    }

    sync() {
      if (this.leaving || this.off) return;
      const want = !!this.wanted();
      if (want === this.active) return;
      if (want) {
        try {
          this.history.pushState({ [GUARD]: true }, '');
          this.active = true;
        } catch (err) { this.off = true; }
        return;
      }
      this.active = false;
      this.leaving = true;
      this._timer = setTimeout(() => { this.off = true; this.leaving = false; }, GUARD_LEAVE_MS);
      this.history.back();
    }

    // window 'popstate'
    onPopState(ev) {
      if (this.off) return;
      const guard = !!(ev && ev.state && ev.state[GUARD]);
      const own = this.leaving;
      clearTimeout(this._timer);
      this.leaving = false;
      this.active = guard;
      if (!own && !guard) this.onBack();   // Back popped the guard (a step forward onto one needs nothing)
      this.sync();
    }
  }

  TT.Storage = Storage;
  TT.UI = {
    UI, create: (app) => new UI(app),
    Storage, Records, Seen, MODE_INFO, BackGuard,
    rulesLabel, resultText, shareLink, drawPreview, isTyping, formatPct: fmtPct
  };
})(typeof window !== 'undefined' ? (window.TT = window.TT || {}) : (global.TT = global.TT || {}));
