/* TeTrowers — app bootstrap and main loop (TT.App).
 *
 * Wires the modules together: persisted settings, renderer, audio, input, UI and the
 * current game. Each animation frame runs game.update(dt), input.update(dt), ui.update()
 * and renderer.render(dt). When nothing moves and nobody has touched anything for
 * IDLE_AFTER seconds the loop drops to IDLE_FPS, and on high refresh-rate screens ticks
 * closer than FRAME_MIN_MS are skipped, so a quiet tower costs almost nothing.
 * Optional modules (renderer, audio) are guarded: a failure there never breaks the page.
 * Phones: the system Back button / gesture closes the top screen or pauses (TT.UI.BackGuard)
 * instead of leaving, a run that is hidden, killed or closed still has its best height saved, and
 * the installed app stays upright (portrait lock, on top of the manifest's orientation).
 */
(function (TT) {
  'use strict';
  const C = TT.CONFIG;

  const IDLE_FPS = C.IDLE_FPS || 20;
  const IDLE_AFTER = (C.IDLE_AFTER != null ? C.IDLE_AFTER : 2);          // s without input before throttling
  const FRAME_MIN_MS = (C.FRAME_MIN_MS != null ? C.FRAME_MIN_MS : 9);    // skip rAF ticks closer than this (120+ Hz)
  const MAX_DT = C.MAX_FRAME_DT || 0.1;
  const DEBUG_INTERVAL = 500;                                             // ms between debug overlay refreshes

  const App = {
    settings: null, game: null, renderer: null, audio: null, input: null, ui: null,
    urlSeed: '', debug: false,
    startGame, restart, quitToMenu, pause, resume, togglePause, showOdds,
    setSetting, setEnabledTypes, toggleMute, wake, sfx, navigated, loadSettings, lockPortrait
  };

  // The special types of the first release. Settings saved without knownTypes knew only these,
  // so every type added since then starts enabled for those players too.
  const FIRST_TYPES = ['steel', 'vine', 'crystal', 'frost', 'pebble', 'crumble', 'oil', 'mine', 'magma', 'anvil', 'blackhole'];
  TT.App = App;

  let lastActivity = 0;
  let lastFrame = 0;
  let idleNow = false;
  let lastHoverY = NaN;
  let gameUnsubs = [];
  let recorded = false;            // the current run's best height is already stored
  let pendingSaved = false;        // ...or waits in the pending snapshot (page hidden / closed)
  let backGuard = null;
  let size = { w: 0, h: 0, dpr: 0 };
  let lastUnlock = -Infinity;
  const reported = new Set();
  const dbg = { el: null, frames: 0, upd: 0, ren: 0, since: 0 };

  function report(what, err) {
    if (reported.has(what)) return;
    reported.add(what);
    if (typeof console !== 'undefined') console.error('[TT] ' + what + ' failed', err);
  }

  function safe(what, fn) {
    try { return fn(); } catch (err) { report(what, err); return undefined; }
  }

  function wake() { lastActivity = performance.now(); }

  // ---- settings ---------------------------------------------------------------------------
  function defaultSettings() {
    let reduced = false;
    try { reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (err) { reduced = false; }
    return {
      mode: C.DEFAULT_MODE, sound: true, vibration: true, ghost: true, reducedMotion: reduced,
      restartSameSeed: false,   // "Same seed" beside Restart / Play again: off = a new random seed
      enabledTypes: TT.SPECIAL_KEYS.slice()
    };
  }

  function loadSettings() {
    const s = defaultSettings();
    const saved = TT.Storage.read(TT.Storage.KEYS.settings, null);
    if (!saved || typeof saved !== 'object') return s;
    if (C.MODES.includes(saved.mode)) s.mode = saved.mode;
    for (const k of ['sound', 'vibration', 'ghost', 'reducedMotion', 'restartSameSeed']) {
      if (typeof saved[k] === 'boolean') s[k] = saved[k];
    }
    if (Array.isArray(saved.enabledTypes)) {
      // Types added by a later version (absent from knownTypes) start enabled
      const known = new Set(Array.isArray(saved.knownTypes) ? saved.knownTypes : FIRST_TYPES);
      s.enabledTypes = TT.SPECIAL_KEYS.filter((k) => saved.enabledTypes.includes(k) || !known.has(k));
    }
    return s;
  }

  function saveSettings() {
    const s = App.settings;
    TT.Storage.write(TT.Storage.KEYS.settings, {
      mode: s.mode, sound: s.sound, vibration: s.vibration, ghost: s.ghost, reducedMotion: s.reducedMotion,
      restartSameSeed: s.restartSameSeed, enabledTypes: s.enabledTypes.slice(), knownTypes: TT.SPECIAL_KEYS.slice()
    });
  }

  // key: 'mode' | 'sound' | 'vibration' | 'ghost' | 'reducedMotion' | 'restartSameSeed'
  function setSetting(key, value) {
    const s = App.settings;
    if (!(key in s) || key === 'enabledTypes') return;
    if (key === 'mode') {
      if (!C.MODES.includes(value)) return;
      if (App.game) App.game.setMode(value); // chosen explicitly (settings), so it applies to this run too
    } else {
      value = !!value;
    }
    if (s[key] === value) return;
    s[key] = value;
    saveSettings();
    applySettings();
    if (key === 'sound' && value) { lastUnlock = -Infinity; unlockAudio(); } // still inside the user's gesture
  }

  function setEnabledTypes(keys) {
    const set = new Set(keys || []);
    App.settings.enabledTypes = TT.SPECIAL_KEYS.filter((k) => set.has(k));
    saveSettings();
  }

  function rendererOptions() {
    return { reducedMotion: !!App.settings.reducedMotion, showGhost: !!App.settings.ghost };
  }

  function applySettings() {
    const s = App.settings;
    const a = App.audio;
    if (a) {
      if (typeof a.setMuted === 'function') safe('audio.setMuted', () => a.setMuted(!s.sound));
      if (typeof a.setHaptics === 'function') safe('audio.setHaptics', () => a.setHaptics(!!s.vibration));
    }
    const r = App.renderer;
    if (r && typeof r.setOptions === 'function') safe('renderer.setOptions', () => r.setOptions(rendererOptions()));
    document.documentElement.classList.toggle('reduced-motion', !!s.reducedMotion);
    wake();
  }

  function toggleMute() {
    setSetting('sound', !App.settings.sound);
    App.ui.syncSettings();
    App.ui.toast({ id: 'sound', title: App.settings.sound ? 'Sound on' : 'Sound off', time: 1.6 });
  }

  // ---- game lifecycle ---------------------------------------------------------------------
  // opts: { seed, mode, enabledTypes } — missing values come from the settings
  function startGame(opts) {
    const o = opts || {};
    if (!TT.Game || typeof TT.Game.create !== 'function') {
      App.ui.toast({ title: 'The game could not load', text: 'Please reload the page.', kind: 'warn' });
      return null;
    }
    recordRun();
    teardownGame();
    let game;
    try {
      game = TT.Game.create({
        seed: o.seed,
        mode: C.MODES.includes(o.mode) ? o.mode : App.settings.mode,
        enabledTypes: o.enabledTypes || App.settings.enabledTypes
      });
    } catch (err) {
      console.error('[TT] could not start a game', err);
      App.ui.bindGame(null);
      App.ui.show('title', { replace: true });
      App.ui.toast({ title: 'The game could not start', text: String((err && err.message) || err), kind: 'warn' });
      return null;
    }
    App.game = game;
    recorded = false;
    gameUnsubs.push(game.on('gameOver', (summary) => onGameOver(game, summary)));
    if (App.renderer) safe('renderer.setGame', () => App.renderer.setGame(game));
    App.ui.bindGame(game);   // shows the HUD, which shrinks the stage...
    applyResize(true);       // ...so size the playfield before the first frame
    if (App.audio && typeof App.audio.attach === 'function') safe('audio.attach', () => App.audio.attach(game));
    App.ui.closeAll();
    App.input.reset();
    lockPortrait();
    wake();
    return game;
  }

  // Restart / Play again: a new random seed, or the same one when "Same seed" is ticked
  // (opts.sameSeed overrides the setting). The placement mode and block set carry over.
  function restart(opts) {
    const g = App.game;
    if (!g) return startGame({});
    const o = opts || {};
    const same = typeof o.sameSeed === 'boolean' ? o.sameSeed : !!App.settings.restartSameSeed;
    let seed = g.seed;
    for (let i = 0; !same && seed === g.seed && i < 8; i++) seed = TT.RNG.randomSeed();
    return startGame({ seed, mode: g.mode, enabledTypes: Array.from(g.enabledTypes || []) });
  }

  function quitToMenu() {
    recordRun();
    teardownGame();
    if (App.renderer) safe('renderer.setGame', () => App.renderer.setGame(null));
    App.ui.bindGame(null);
    applyResize(true);
    App.input.reset();
    App.ui.show('title', { replace: true });
    wake();
  }

  function teardownGame() {
    const g = App.game;
    if (!g) return;
    for (const off of gameUnsubs) safe('unsubscribe', off);
    gameUnsubs = [];
    if (App.audio && typeof App.audio.detach === 'function') safe('audio.detach', () => App.audio.detach());
    safe('game.destroy', () => g.destroy());
    App.game = null;
  }

  function onGameOver(game, summary) {
    if (game !== App.game) return;
    const result = recordRun(summary);
    App.input.releaseAll();
    App.ui.showGameOver(summary, result);
  }

  // Store the current run's best height once (at game over, or when leaving a run early)
  function recordRun(summary) {
    const g = App.game;
    if (!g || recorded) return null;
    if (pendingSaved) { TT.UI.Records.clearPending(); pendingSaved = false; }
    const s = summary || g.summary();
    if (!(s.bestHeight > 0)) return null;
    recorded = true;
    return TT.UI.Records.submit(s);
  }

  // The page is hidden or going away, and the OS may kill it there without another word: keep the
  // live run's best as a pending snapshot. The next start submits it unless recordRun ran first.
  function savePending() {
    const g = App.game;
    if (g && !recorded && TT.UI.Records.savePending(g.summary())) pendingSaved = true;
  }

  // ---- Back button --------------------------------------------------------------------------
  // Back stays in the app while a run exists or a menu is open over the title
  function wantsGuard() {
    const top = App.ui.top();
    return !!App.game || (!!top && top.name !== 'title');
  }

  // Back (the guard entry was popped): close the top screen, or pause the running game
  function onBack() {
    const top = App.ui.top();
    if (top && top.name === 'over') quitToMenu();
    else if (top && top.name !== 'title') App.ui.back();
    else if (!top) pause();
    wake();
  }

  function navigated() {
    if (backGuard) backGuard.sync();
  }

  function pause() {
    const g = App.game;
    if (!g || g.state !== 'playing' || !g.pause()) return false;
    App.input.releaseAll();
    App.ui.show('pause', { replace: true });
    return true;
  }

  function resume() {
    const g = App.game;
    App.ui.closeAll();
    if (g && g.state === 'paused') g.resume();
    wake();
  }

  function togglePause() {
    const g = App.game;
    if (!g) return;
    if (g.state === 'playing') pause();
    else if (g.state === 'paused') resume();
  }

  // Odds panel (chip, sidebar, pause menu, O key). Opened from play it pauses the game, and
  // closing it resumes (ui.back); opened from the pause menu it returns there.
  function showOdds() {
    const g = App.game;
    if (!g) return false;
    if (g.state === 'paused') {
      App.ui.show('odds');
      return true;
    }
    if (g.state !== 'playing' || g.ending || !g.pause()) return false;
    App.input.releaseAll();
    App.ui.show('odds', { replace: true });
    return true;
  }

  // ---- layout -------------------------------------------------------------------------------
  function applyResize(force) {
    const stage = document.getElementById('stage');
    const rect = stage.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    const dpr = window.devicePixelRatio || 1;
    if (!(w > 0 && h > 0)) return;
    const changed = w !== size.w || h !== size.h || dpr !== size.dpr;
    if (!changed && !force) return;
    size = { w, h, dpr };
    if (App.renderer) safe('renderer.resize', () => App.renderer.resize(w, h, dpr));
    if (changed) App.ui.onLayout();
    wake();
  }

  // Installed on a phone or tablet (home-screen app), the game stays upright whatever the sensor
  // says. Browsers only allow the lock there; anywhere else it is skipped or simply refused.
  function lockPortrait() {
    try {
      const o = typeof screen !== 'undefined' ? screen.orientation : null;
      const mm = typeof window !== 'undefined' ? window.matchMedia : null;
      if (!o || typeof o.lock !== 'function' || typeof mm !== 'function') return false;
      const app = ['standalone', 'fullscreen', 'minimal-ui'].some((m) => mm.call(window, '(display-mode: ' + m + ')').matches);
      const touch = (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) || mm.call(window, '(any-pointer: coarse)').matches;
      if (!app || !touch) return false;
      const p = o.lock('portrait-primary');
      if (p && typeof p.catch === 'function') p.catch(() => {});
      return true;
    } catch (err) {
      return false;
    }
  }

  // ---- main loop ------------------------------------------------------------------------------
  function isIdle(now) {
    if (now - lastActivity < IDLE_AFTER * 1000) return false;
    if (App.input.isActive()) return false;
    const r = App.renderer;
    if (r && typeof r.isAnimating === 'function') {
      let animating = false;
      try { animating = !!r.isAnimating(); } catch (err) { report('renderer.isAnimating', err); }
      if (animating) return false;
    }
    const g = App.game;
    if (g && (g.state === 'playing' || g.state === 'over')) {
      if (g.state === 'playing' && (g.ending || !g.canDrop)) return false;   // a turn is resolving
      if (g.physics && g.physics.anyAwake()) return false;
      if (g.hoverY !== lastHoverY) { lastHoverY = g.hoverY; return false; } // hover line still easing
    }
    return true;
  }

  function frame(now) {
    requestAnimationFrame(frame);
    const since = lastFrame ? now - lastFrame : 1000 / 60;
    if (since < FRAME_MIN_MS) return;
    idleNow = isIdle(now);
    if (idleNow && since < 1000 / IDLE_FPS - 1) return;
    lastFrame = now;
    const dt = Math.min(since / 1000, MAX_DT);

    const g = App.game;
    const t0 = performance.now();
    if (g) {
      try { g.update(dt); } catch (err) { report('game.update', err); }
    }
    const t1 = performance.now();
    try { App.input.update(dt); } catch (err) { report('input.update', err); }
    try { App.ui.update(dt); } catch (err) { report('ui.update', err); }
    const t2 = performance.now();
    if (App.renderer) {
      try { App.renderer.render(dt); } catch (err) { report('renderer.render', err); }
    }
    if (dbg.el) debugSample(now, t1 - t0, performance.now() - t2);
  }

  function debugSample(now, updMs, renMs) {
    dbg.frames++;
    dbg.upd += updMs;
    dbg.ren += renMs;
    if (!dbg.since) dbg.since = now;
    const span = now - dbg.since;
    if (span < DEBUG_INTERVAL) return;
    const P = App.game && App.game.physics;
    let awake = 0;
    if (P) for (const b of P.movers) if (b.body.isAwake()) awake++;
    dbg.el.textContent =
      'FPS ' + (dbg.frames * 1000 / span).toFixed(0) + (idleNow ? ' (idle)' : '') + '\n' +
      'blocks ' + (P ? P.blocks.length : 0) + '  movers ' + (P ? P.movers.length : 0) + '  awake ' + awake + '\n' +
      'update ' + (dbg.upd / dbg.frames).toFixed(2) + ' ms  render ' + (dbg.ren / dbg.frames).toFixed(2) + ' ms';
    dbg.frames = 0; dbg.upd = 0; dbg.ren = 0; dbg.since = now;
  }

  // ---- audio, visibility, service worker ------------------------------------------------------
  function initAudio() {
    const a = TT.Audio;
    if (!a || (typeof a !== 'object' && typeof a !== 'function')) return null;
    if (typeof a.init === 'function') safe('audio.init', () => a.init());
    return a;
  }

  // Browsers only start audio from a user gesture. Retried on every gesture until it works,
  // then at most once a second (it also re-resumes a context the OS suspended).
  function unlockAudio() {
    const a = App.audio;
    if (!a || typeof a.unlock !== 'function') return;
    const t = performance.now();
    if (t - lastUnlock < 1000) return;
    if (safe('audio.unlock', () => a.unlock())) lastUnlock = t;
  }

  function onGesture() {
    wake();
    unlockAudio();
  }

  // UI sound effect (menu clicks); silent when audio is missing or muted
  function sfx(name) {
    const a = App.audio;
    if (a && typeof a.play === 'function') safe('audio.play', () => a.play(name));
  }

  function onVisibility() {
    if (document.hidden) {
      App.input.releaseAll();
      pause();
      savePending();
    } else {
      lockPortrait();   // the OS may have dropped the lock while the app was in the background
      wake();
    }
  }

  function registerServiceWorker() {
    if (!/^http/.test(location.protocol) || !('serviceWorker' in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register('sw.js').catch((err) => {
        if (App.debug) console.warn('[TT] service worker not registered', err);
      });
    };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }

  function readUrlParams() {
    let params = null;
    try { params = new URLSearchParams(location.search); } catch (err) { params = null; }
    const seed = params && params.get('seed');
    App.urlSeed = seed ? TT.RNG.normalizeSeed(seed) : '';
    App.debug = !!params && params.get('debug') === '1';
  }

  // ---- boot --------------------------------------------------------------------------------
  function boot() {
    readUrlParams();
    App.settings = loadSettings();
    document.documentElement.classList.toggle('reduced-motion', !!App.settings.reducedMotion);
    lockPortrait();

    const canvas = document.getElementById('game-canvas');
    if (typeof TT.Renderer === 'function') {
      try { App.renderer = new TT.Renderer(canvas, rendererOptions()); } catch (err) { report('renderer', err); App.renderer = null; }
    }
    App.audio = initAudio();
    App.ui = TT.UI.create(App);
    App.input = TT.Input.create({
      canvas,
      tray: document.getElementById('hud-tray'),
      getGame: () => App.game,
      getRenderer: () => App.renderer,
      isBlocked: () => App.ui.isMenuOpen(),
      onPause: togglePause,
      onOdds: showOdds,
      onMute: toggleMute,
      onActivity: wake
    });
    applySettings();

    window.addEventListener('pointerdown', onGesture, true);
    window.addEventListener('keydown', onGesture, true);
    window.addEventListener('pointermove', wake, { passive: true });
    window.addEventListener('wheel', wake, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', savePending);
    if (window.history && typeof window.history.pushState === 'function') {
      try {
        backGuard = new TT.UI.BackGuard({ history: window.history, wanted: wantsGuard, onBack });
        window.addEventListener('popstate', (ev) => backGuard.onPopState(ev));
      } catch (err) { report('history', err); backGuard = null; }
    }
    safe('records.flushPending', () => TT.UI.Records.flushPending()); // a run the OS killed last time

    const stage = document.getElementById('stage');
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => applyResize(false)).observe(stage);
    window.addEventListener('resize', () => applyResize(false));
    applyResize(true);

    if (App.debug) {
      dbg.el = document.getElementById('debug');
      dbg.el.hidden = false;
    }
    registerServiceWorker();
    App.ui.show('title');
    wake();
    requestAnimationFrame(frame);
  }

  function start() {
    try {
      boot();
    } catch (err) {
      console.error('[TT] boot failed', err);
      const box = document.createElement('div');
      box.className = 'noscript';
      box.textContent = 'TeTrowers could not start: ' + ((err && err.message) || err) + '. Please reload the page.';
      document.body.appendChild(box);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})(typeof window !== 'undefined' ? (window.TT = window.TT || {}) : (global.TT = global.TT || {}));
