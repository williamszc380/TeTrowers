/* TeTrowers — tiny shared helpers (no DOM access; safe to load in Node). */
(function (TT) {
  'use strict';

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  // Frame-rate independent exponential approach: rate in 1/s
  function damp(current, target, rate, dt) { return target + (current - target) * Math.exp(-rate * dt); }
  function approach(current, target, maxDelta) {
    return current < target ? Math.min(target, current + maxDelta) : Math.max(target, current - maxDelta);
  }

  // Minimal event emitter. Listener errors are caught so one bad subscriber
  // (e.g. audio on a locked AudioContext) can never break the game loop.
  class Emitter {
    constructor() { this._l = Object.create(null); }
    on(name, fn) { (this._l[name] || (this._l[name] = [])).push(fn); return () => this.off(name, fn); }
    off(name, fn) {
      const a = this._l[name];
      if (!a) return;
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    }
    emit(name, payload) {
      const a = this._l[name];
      if (a) {
        for (const fn of a.slice()) {
          try { fn(payload); } catch (err) { if (typeof console !== 'undefined') console.error('[TT] listener for "' + name + '" failed', err); }
        }
      }
      const any = this._l['*'];
      if (any) for (const fn of any.slice()) { try { fn(name, payload); } catch (err) { /* ignore */ } }
    }
  }

  function formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function formatHeight(m) { return (Math.max(0, m)).toFixed(1) + ' m'; }

  TT.Util = { clamp, lerp, damp, approach, Emitter, formatTime, formatHeight };
})(typeof window !== 'undefined' ? (window.TT = window.TT || {}) : (global.TT = global.TT || {}));
