/* TeTrowers — synthesised sound effects and haptics (TT.Audio).
 * WebAudio synthesis only, no audio files: oscillators and one shared noise buffer shaped
 * by filters and envelopes, every sound routed through master gain -> compressor -> output.
 * The AudioContext is created lazily on the first user gesture (browsers refuse to start
 * audio before one), and every call is a silent no-op where WebAudio is missing (Node, old
 * browsers). Frequent sounds are short, quiet and rate-limited so they stay pleasant over
 * hundreds of drops; every play varies its pitch slightly.
 */
(function (TT) {
  'use strict';
  const C = TT.CONFIG || {};

  const AUDIO_VOLUME = (C.AUDIO_VOLUME != null ? C.AUDIO_VOLUME : 0.8);            // default master volume 0..1
  const AUDIO_MAX_VOICES = (C.AUDIO_MAX_VOICES != null ? C.AUDIO_MAX_VOICES : 24);   // sounds playing at once
  const AUDIO_PAN = (C.AUDIO_PAN != null ? C.AUDIO_PAN : 0.35);                     // stereo spread across the field
  const HAPTIC_LIFE_MS = (C.HAPTIC_LIFE_MS != null ? C.HAPTIC_LIFE_MS : 120);
  const HAPTIC_EXPLODE_MS = (C.HAPTIC_EXPLODE_MS != null ? C.HAPTIC_EXPLODE_MS : 60);
  const HAPTIC_LAND_MS = (C.HAPTIC_LAND_MS != null ? C.HAPTIC_LAND_MS : 15);
  const HAPTIC_LAND_IMPACT = (C.HAPTIC_LAND_IMPACT != null ? C.HAPTIC_LAND_IMPACT : 18); // m/s x mass factor = "heavy"
  const HAPTIC_POP_MS = (C.HAPTIC_POP_MS != null ? C.HAPTIC_POP_MS : 25);
  const HAPTIC_GLASS_MS = (C.HAPTIC_GLASS_MS != null ? C.HAPTIC_GLASS_MS : 20);
  const FIELD_WIDTH = C.FIELD_WIDTH || 16;
  const FALL_SPEED = C.MAX_FALL_SPEED || 9;
  const SOFT_IMPACT = (C.SOFT_LAND_IMPACT != null ? C.SOFT_LAND_IMPACT : 2.5); // what a gentle touchdown reports
  const SOFT_TAP_MAX = 4;            // m/s; weightless blocks landing slower than this tap instead of thud
  const FUSE_TIME = C.MINE_FUSE || 0.35;
  const MILESTONE_LIFE_DELAY = 0.42; // s; the milestone life chime lands inside the fanfare's last chord

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  const later = typeof queueMicrotask === 'function' ? queueMicrotask : (fn) => Promise.resolve().then(fn);

  // ---- Synth kit ------------------------------------------------------------------
  // Building blocks bound to one (live or offline) context. Every scheduled source is
  // reported to the kit so the voice knows when it has finished.
  function makeKit(c, noiseBuf) {
    const K = { c, last: null, end: 0 };

    function track(src, end) {
      if (end > K.end) { K.end = end; K.last = src; }
    }

    // Gain with a linear attack, optional hold and an exponential decay to silence
    function env(dest, t, a, hold, d, v) {
      const g = c.createGain();
      const p = g.gain;
      const peak = Math.max(v, 0.0002);
      p.setValueAtTime(0, t);
      p.linearRampToValueAtTime(peak, t + a);
      if (hold > 0) p.setValueAtTime(peak, t + a + hold);
      p.exponentialRampToValueAtTime(0.0001, t + a + hold + d);
      g.connect(dest);
      return g;
    }

    // Low-frequency oscillator added onto an AudioParam (vibrato, tremolo). With depth1 > 0
    // the depth glides exponentially to depth1 by `end` (a wobble that dies away).
    K.lfo = function (param, t, end, rate, depth, type, depth1) {
      const o = c.createOscillator();
      o.type = type || 'sine';
      o.frequency.value = rate;
      const g = c.createGain();
      if (depth1 > 0 && depth > 0) {
        g.gain.setValueAtTime(depth, t);
        g.gain.exponentialRampToValueAtTime(depth1, end);
      } else {
        g.gain.value = depth;
      }
      o.connect(g);
      g.connect(param);
      o.start(t);
      o.stop(end);
      track(o, end);
    };

    // Oscillator note. f1/glide: exponential pitch glide; vib: { rate, depth (Hz), depth1, type }
    K.tone = function (dest, t, { f, f1 = 0, glide = 0, type = 'sine', a = 0.005, hold = 0, d = 0.2, v = 0.1, vib = null }) {
      const g = env(dest, t, a, hold, d, v);
      const o = c.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f, t);
      if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + (glide || a + hold + d));
      o.connect(g);
      const end = t + a + hold + d + 0.03;
      o.start(t);
      o.stop(end);
      track(o, end);
      if (vib) K.lfo(o.frequency, t, end, vib.rate, vib.depth, vib.type, vib.depth1);
      return end;
    };

    // Filtered noise burst; f -> f1 sweeps the filter over the whole envelope
    K.hiss = function (dest, t, { type = 'bandpass', f = 1000, f1 = 0, q = 1, a = 0.005, hold = 0, d = 0.2, v = 0.1 }) {
      const g = env(dest, t, a, hold, d, v);
      const flt = c.createBiquadFilter();
      flt.type = type;
      flt.Q.value = q;
      flt.frequency.setValueAtTime(f, t);
      if (f1) flt.frequency.exponentialRampToValueAtTime(f1, t + a + hold + d);
      flt.connect(g);
      const src = c.createBufferSource();
      src.buffer = noiseBuf;
      src.loop = true;
      src.connect(flt);
      const end = t + a + hold + d + 0.03;
      src.start(t, Math.random() * 0.8);
      src.stop(end);
      track(src, end);
      return end;
    };

    // Shared filter stage for several notes of one sound
    K.filter = function (dest, { type = 'lowpass', f = 2000, q = 0.7, f1 = 0, t0 = 0, t1 = 0 }) {
      const flt = c.createBiquadFilter();
      flt.type = type;
      flt.Q.value = q;
      flt.frequency.setValueAtTime(f, t0);
      if (f1 && t1 > t0) flt.frequency.exponentialRampToValueAtTime(f1, t1);
      flt.connect(dest);
      return flt;
    };

    return K;
  }

  function makeNoise(c) {
    const len = Math.floor(c.sampleRate); // 1 s, looped
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  // master gain -> gentle compressor (keeps stacked booms from clipping) -> output
  function makeMaster(c) {
    const gain = c.createGain();
    try {
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.knee.value = 10;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.2;
      gain.connect(comp);
      comp.connect(c.destination);
    } catch (err) {
      gain.connect(c.destination);
    }
    return gain;
  }

  // ---- Sounds ---------------------------------------------------------------------
  // Each entry: fn(K, out, t, o) schedules the sound at context time t into `out`
  // (o.p = pitch multiplier). gap = min seconds between plays; rate/cap = token bucket
  // for bursts; prio 0 = expendable, 1 = normal, 2 = always plays; vary = pitch jitter.

  // Landing character per block type: body pitch, knock brightness, optional ring partials
  const MATERIALS = {
    normal: { pitch: 1, cut: 900, body: 1, knock: 1 },
    oil: { pitch: 0.9, cut: 600, body: 0.9, knock: 0.5 },
    vine: { pitch: 0.95, cut: 650, body: 0.85, knock: 0.7 },
    magma: { pitch: 0.9, cut: 750, body: 0.9, knock: 0.7 },
    steel: { pitch: 1.05, cut: 1500, body: 0.9, knock: 0.8, ring: [1180, 1730], ringD: 0.14, ringV: 0.035 },
    crystal: { pitch: 1.1, cut: 1200, body: 0.8, knock: 0.7, ring: [1975, 2960], ringD: 0.28, ringV: 0.03 },
    frost: { pitch: 1.1, cut: 1300, body: 0.8, knock: 0.7, ring: [2350, 3130], ringD: 0.16, ringV: 0.03 },
    magnet: { pitch: 1, cut: 1300, body: 0.95, knock: 0.85, ring: [790, 1380], ringD: 0.1, ringV: 0.035 },
    rubber: { pitch: 0.8, cut: 420, body: 0.7, knock: 0.3 },   // dull thud; the boing is its own sound
    glass: { pitch: 1.2, cut: 2100, body: 0.6, knock: 0.85, ring: [2489, 3729], ringD: 0.16, ringV: 0.025 },
    spikes: { pitch: 0.95, cut: 1250, body: 0.95, knock: 0.9, ring: [1397, 2093], ringD: 0.07, ringV: 0.025 },
    mine: { pitch: 1, cut: 1100, body: 0.9, knock: 0.8, ring: [610, 905], ringD: 0.09, ringV: 0.04 },
    anvil: { pitch: 0.6, cut: 700, body: 1.25, knock: 1.2, ring: [311, 447, 703, 1046], ringD: 0.45, ringV: 0.05 },
    blackhole: { pitch: 0.55, cut: 450, body: 1.1, knock: 0.5 }
  };

  const SLOT_NOTES = [587.33, 659.25, 783.99];          // D5 E5 G5: one per batch slot
  const MODE_NOTES = {
    assisted: [523.25, 783.99],                          // rising
    fixed: [587.33, 587.33],                             // level
    manual: [783.99, 587.33]                             // falling
  };
  const BATCH_STEPS = [0, 2, 4, 7, 9, 7, 4, 2];          // pentatonic walk so batches don't repeat one chime

  function massOf(block) {
    if (!block || !block.cells) return 4;
    const density = block.type && block.type.density != null ? block.type.density : 1;
    return block.cells.length * density;
  }
  const massFactor = (block) => clamp(Math.sqrt(massOf(block) / 4), 0.5, 2); // 1 = plain tetromino
  const isHeavy = (block) => !!(block && block.type && block.type.heavy);   // falls with full weight (anvil)

  function brass(K, dest, t, f, hold, d, v) {
    K.tone(dest, t, { f, type: 'sawtooth', a: 0.015, hold, d, v });
    K.tone(dest, t, { f: f / 2, type: 'triangle', a: 0.015, hold, d, v: v * 0.6 });
  }

  const SOUNDS = {
    // Soft whoosh as the piece is released
    drop: { gap: 0.05, fn(K, out, t, o) {
      K.hiss(out, t, { type: 'bandpass', f: 1100 * o.p, f1: 420 * o.p, q: 1.1, a: 0.045, d: 0.2, v: 0.22 });
      K.tone(out, t, { f: 300 * o.p, f1: 160 * o.p, a: 0.03, d: 0.16, v: 0.035 });
    } },

    // Thud scaled by impact speed and mass, coloured by the block's material
    land: { gap: 0.03, rate: 8, cap: 4, prio: 0, vary: 0.05, fn(K, out, t, o) {
      const impact = typeof o.impact === 'number' ? o.impact : FALL_SPEED * 0.8;
      const s = clamp(impact / FALL_SPEED, 0, 1.25) * massFactor(o.block);
      if (s < 0.05) return;
      const g = Math.min(1, s * s);   // quiet for small impacts
      const m = MATERIALS[o.typeKey || (o.block && o.block.typeKey)] || MATERIALS.normal;
      const p = o.p * m.pitch * (1.15 - 0.15 * Math.min(1.4, s)); // heavier sounds lower
      K.tone(out, t, { f: 150 * p, f1: 52 * p, glide: 0.08, a: 0.002, d: 0.12 + 0.1 * g, v: 0.5 * g * m.body });
      K.hiss(out, t, { type: 'lowpass', f: m.cut * (0.55 + 0.45 * g), q: 0.5, a: 0.001, d: 0.045 + 0.05 * g, v: 0.3 * g * m.knock });
      if (m.ring) {
        for (let i = 0; i < m.ring.length; i++) {
          K.tone(out, t, { f: m.ring[i] * o.p, a: 0.001, d: m.ringD * (1 - i * 0.15), v: m.ringV * g });
        }
      }
    } },

    // Weightless touchdown: a soft "set down" tap (a muted knock and a tiny contact click),
    // coloured by the material; no thud, since nothing that glides down has any weight
    set: { gap: 0.03, rate: 8, cap: 4, prio: 0, vary: 0.06, fn(K, out, t, o) {
      const m = MATERIALS[o.typeKey || (o.block && o.block.typeKey)] || MATERIALS.normal;
      const impact = typeof o.impact === 'number' ? o.impact : SOFT_IMPACT;
      const g = clamp(impact / SOFT_IMPACT, 0.7, 1.4);           // 1 for an ordinary touchdown
      const p = o.p * m.pitch / Math.sqrt(massFactor(o.block)); // bigger blocks tap lower
      K.tone(out, t, { f: 330 * p, f1: 230 * p, glide: 0.04, a: 0.0015, d: 0.06, v: 0.2 * g * m.body });
      K.tone(out, t, { f: 165 * p, a: 0.002, d: 0.05, v: 0.08 * g * m.body });
      K.hiss(out, t, { type: 'bandpass', f: m.cut * 2 * o.p, q: 0.9, a: 0.0008, d: 0.016, v: 0.12 * g * m.knock });
      if (m.ring) {
        for (let i = 0; i < m.ring.length; i++) {
          K.tone(out, t, { f: m.ring[i] * o.p, a: 0.001, d: m.ringD * 0.5 * (1 - i * 0.15), v: m.ringV * 0.45 * g });
        }
      }
    } },

    // Rubber: the pitch springs up, then wobbles and settles like a spring. Harder impacts
    // spring higher and wobble longer; heavier blocks boing lower.
    boing: { gap: 0.08, rate: 4, cap: 2, vary: 0.05, fn(K, out, t, o) {
      const impact = typeof o.impact === 'number' ? o.impact : FALL_SPEED * 0.8;
      const s = clamp(impact / FALL_SPEED, 0, 1.2);
      if (!(s >= 0.12)) return;
      const g = Math.min(1, s);
      const f = 150 * o.p / Math.sqrt(massFactor(o.block));
      const top = f * (1.7 + 0.5 * g);
      const d = 0.2 + 0.18 * g;
      const wob = top * (0.05 + 0.07 * g);
      const rate = 12 + 3 * g;
      const lp = K.filter(out, { type: 'lowpass', f: 1500 + 1300 * g, f1: 650, q: 2.5, t0: t, t1: t + 0.05 + d });
      K.tone(lp, t, { f, f1: top, glide: 0.055, type: 'triangle', a: 0.003, hold: 0.02, d, v: 0.18 * g, vib: { rate, depth: wob, depth1: wob * 0.08 } });
      K.tone(lp, t, { f: f / 2, f1: top / 2, glide: 0.055, a: 0.003, hold: 0.02, d: d * 0.75, v: 0.09 * g, vib: { rate, depth: wob / 2, depth1: wob * 0.04 } });
    } },

    select: { gap: 0.03, prio: 0, fn(K, out, t, o) {
      const f = (SLOT_NOTES[o.index] || SLOT_NOTES[1]) * o.p;
      K.tone(out, t, { f, f1: f * 1.05, glide: 0.05, type: 'triangle', a: 0.004, d: 0.08, v: 0.13 });
      K.tone(out, t, { f: f * 2, a: 0.002, d: 0.05, v: 0.03 });
    } },

    // Very subtle tick per step
    move: { gap: 0.035, prio: 0, vary: 0.06, fn(K, out, t, o) {
      K.tone(out, t, { f: 1700 * o.p, f1: 1150 * o.p, glide: 0.015, type: 'triangle', a: 0.001, d: 0.02, v: 0.07 });
    } },

    mode: { gap: 0.06, fn(K, out, t, o) {
      const notes = MODE_NOTES[o.mode] || MODE_NOTES.assisted;
      for (let i = 0; i < notes.length; i++) {
        K.tone(out, t + i * 0.07, { f: notes[i] * o.p, type: 'triangle', a: 0.004, d: 0.09, v: 0.07 });
      }
    } },

    // Tiny click: the next drop is allowed
    ready: { gap: 0.12, prio: 0, vary: 0.04, fn(K, out, t, o) {
      K.tone(out, t, { f: 1320 * o.p, f1: 990 * o.p, glide: 0.025, type: 'triangle', a: 0.002, d: 0.035, v: 0.085 });
    } },

    lifeLost: { gap: 0.3, prio: 2, vary: 0.01, fn(K, out, t, o) {
      const lp = K.filter(out, { type: 'lowpass', f: 1800, q: 0.5, t0: t });
      const notes = [440, 349.23, 261.63];
      for (let i = 0; i < notes.length; i++) {
        K.tone(lp, t + i * 0.11, { f: notes[i] * o.p, type: 'triangle', a: 0.006, d: 0.22, v: 0.16 });
      }
      K.tone(out, t, { f: 95, f1: 42, glide: 0.25, a: 0.004, d: 0.32, v: 0.35 });
      K.hiss(out, t, { type: 'lowpass', f: 1200, f1: 300, a: 0.003, d: 0.3, v: 0.12 });
    } },

    lifeGained: { gap: 0.25, prio: 2, vary: 0.01, fn(K, out, t, o) {
      const notes = [523.25, 659.25, 783.99, 1046.5];
      for (let i = 0; i < notes.length; i++) {
        K.tone(out, t + i * 0.065, { f: notes[i] * o.p, type: 'triangle', a: 0.005, d: 0.3, v: 0.08 });
        K.tone(out, t + i * 0.065, { f: notes[i] * 2 * o.p, a: 0.005, d: 0.18, v: 0.025 });
      }
      K.tone(out, t + 0.26, { f: 2093 * o.p, a: 0.01, d: 0.4, v: 0.03, vib: { rate: 7, depth: 12 } });
    } },

    // Shimmering rise: a shield is up
    shield: { gap: 0.25, prio: 2, fn(K, out, t, o) {
      K.tone(out, t, { f: 330 * o.p, f1: 990 * o.p, glide: 0.28, a: 0.03, hold: 0.12, d: 0.25, v: 0.06 });
      K.tone(out, t, { f: 333 * o.p, f1: 1000 * o.p, glide: 0.28, type: 'triangle', a: 0.03, hold: 0.12, d: 0.25, v: 0.05 });
      K.hiss(out, t, { type: 'bandpass', f: 2500, f1: 7000, q: 2, a: 0.12, d: 0.25, v: 0.05 });
      K.tone(out, t + 0.28, { f: 1318.5 * o.p, a: 0.004, d: 0.45, v: 0.06 });
      K.tone(out, t + 0.28, { f: 1975.5 * o.p, a: 0.004, d: 0.35, v: 0.03 });
    } },

    // Deflecting ring: the shield took the hit
    shieldUsed: { gap: 0.25, prio: 2, fn(K, out, t, o) {
      K.hiss(out, t, { type: 'highpass', f: 2500, q: 0.7, a: 0.001, d: 0.06, v: 0.2 });
      const partials = [880, 1245, 1793];
      for (let i = 0; i < partials.length; i++) {
        const f = partials[i] * o.p;
        K.tone(out, t, { f, f1: f * 0.94, glide: 0.3, a: 0.002, d: 0.35 - i * 0.07, v: 0.09 });
      }
      K.tone(out, t, { f: 620 * o.p, f1: 260 * o.p, glide: 0.18, type: 'triangle', a: 0.003, d: 0.2, v: 0.09 });
    } },

    // Boom: sub drop + closing noise + a few late debris crackles
    explode: { gap: 0.06, prio: 2, vary: 0.06, fn(K, out, t, o) {
      K.tone(out, t, { f: 120 * o.p, f1: 36 * o.p, glide: 0.3, a: 0.003, d: 0.55, v: 0.75 });
      K.hiss(out, t, { type: 'lowpass', f: 2600 * o.p, f1: 160, q: 0.4, a: 0.004, d: 0.75, v: 0.6 });
      K.hiss(out, t, { type: 'highpass', f: 2600, q: 0.5, a: 0.001, d: 0.1, v: 0.18 });
      for (let i = 0; i < 4; i++) {
        K.hiss(out, t + rand(0.08, 0.43), { type: 'bandpass', f: rand(1500, 4000), q: 3, a: 0.001, d: 0.03, v: 0.05 });
      }
    } },

    // Sizzle for exactly the fuse time, with a faint rising whine
    fuse: { gap: 0.15, fn(K, out, t, o) {
      const dur = Math.max(0.2, FUSE_TIME);
      const trem = K.c.createGain();
      trem.gain.value = 0.55;
      trem.connect(out);
      K.lfo(trem.gain, t, t + dur + 0.1, 31, 0.45, 'square');
      K.hiss(trem, t, { type: 'bandpass', f: 4800 * o.p, f1: 7500 * o.p, q: 1.4, a: 0.02, hold: dur - 0.08, d: 0.06, v: 0.11 });
      K.tone(out, t, { f: 880 * o.p, f1: 1760 * o.p, glide: dur, type: 'triangle', a: 0.02, hold: dur - 0.08, d: 0.05, v: 0.018 });
    } },

    // Crack + crunch + debris ticks (more pieces, more ticks)
    shatter: { gap: 0.05, rate: 10, cap: 4, fn(K, out, t, o) {
      const n = clamp(Math.round(1 + (o.count || 4) / 2), 2, 6);
      K.hiss(out, t, { type: 'highpass', f: 1800 * o.p, q: 0.8, a: 0.001, d: 0.035, v: 0.45 });
      K.hiss(out, t, { type: 'bandpass', f: 800 * o.p, q: 1, a: 0.002, d: 0.11, v: 0.25 });
      for (let i = 0; i < n; i++) {
        K.hiss(out, t + rand(0.025, 0.185), { type: 'bandpass', f: rand(2200, 5400) * o.p, q: 5, a: 0.001, d: rand(0.02, 0.045), v: rand(0.12, 0.2) });
      }
      if (o.cause === 'anvil') K.tone(out, t, { f: 90, f1: 40, glide: 0.15, a: 0.002, d: 0.2, v: 0.3 });
    } },

    // Ruby glass breaking: a bright crack, the pane's ring, then tinkling shards that thin out
    glass: { gap: 0.05, rate: 6, cap: 3, fn(K, out, t, o) {
      const n = clamp(Math.round(3 + (o.count || 4) * 1.2), 5, 9);
      K.hiss(out, t, { type: 'highpass', f: 2800 * o.p, q: 0.7, a: 0.0005, d: 0.035, v: 0.3 });
      K.hiss(out, t, { type: 'bandpass', f: 5200 * o.p, q: 1.2, a: 0.001, d: 0.1, v: 0.1 });
      const ring = [1975.5, 3048, 4186];
      for (let i = 0; i < ring.length; i++) {
        K.tone(out, t, { f: ring[i] * o.p, a: 0.0008, d: 0.3 - i * 0.07, v: 0.03 });
      }
      for (let i = 0; i < n; i++) {
        const dt = 0.03 + Math.pow(i / n, 1.4) * 0.38 + rand(0, 0.025);
        const f = rand(2400, 6200) * o.p;
        const v = rand(0.035, 0.06) * (1 - dt);
        K.tone(out, t + dt, { f, a: 0.0015, d: rand(0.035, 0.09), v });
        if (i < 3) K.tone(out, t + dt, { f: f * 1.48, a: 0.0015, d: 0.04, v: v * 0.4 });
      }
    } },

    // Spikes puncture a block: a sharp prick, a burst of air and a short low thump
    pop: { gap: 0.04, rate: 8, cap: 3, vary: 0.06, fn(K, out, t, o) {
      const m = massFactor(o.block);
      const p = o.p / Math.sqrt(m);
      K.hiss(out, t, { type: 'highpass', f: 3800 * o.p, q: 0.8, a: 0.0005, d: 0.02, v: 0.3 });
      K.tone(out, t, { f: 2600 * o.p, f1: 2250 * o.p, glide: 0.05, a: 0.0005, d: 0.06, v: 0.03 });
      K.hiss(out, t + 0.003, { type: 'bandpass', f: 1700 * p, f1: 420 * p, q: 1.2, a: 0.001, d: 0.085, v: 0.6 });
      K.tone(out, t + 0.003, { f: 240 * p, f1: 62 * p, glide: 0.07, a: 0.001, d: 0.09, v: 0.3 * Math.min(1.3, m) });
    } },

    // Descending wobble with an in-rushing hiss
    swallow: { gap: 0.08, fn(K, out, t, o) {
      const lp = K.filter(out, { type: 'lowpass', f: 1600, f1: 260, q: 1, t0: t, t1: t + 0.6 });
      K.tone(lp, t, { f: 520 * o.p, f1: 65 * o.p, glide: 0.55, type: 'triangle', a: 0.02, d: 0.55, v: 0.13, vib: { rate: 9, depth: 20 } });
      K.hiss(out, t, { type: 'bandpass', f: 2200, f1: 350, q: 2, a: 0.18, d: 0.1, v: 0.06 });
    } },

    // Frost: icy chime with crystallising crackle. Steel: a short metallic lock.
    freeze: { gap: 0.06, fn(K, out, t, o) {
      if (o.source === 'steel') {
        K.tone(out, t, { f: 190 * o.p, f1: 120 * o.p, glide: 0.06, a: 0.002, d: 0.08, v: 0.2 });
        const partials = [1020, 1530, 2210];
        for (let i = 0; i < partials.length; i++) {
          K.tone(out, t + 0.005, { f: partials[i] * o.p, a: 0.001, d: 0.12 - i * 0.025, v: 0.035 });
        }
        K.hiss(out, t, { type: 'highpass', f: 3200, a: 0.001, d: 0.015, v: 0.1 });
        return;
      }
      const notes = [1567.98, 2093, 2637];
      for (let i = 0; i < notes.length; i++) {
        K.tone(out, t + i * 0.035, { f: notes[i] * o.p, a: 0.002, d: 0.5 - i * 0.08, v: 0.05 });
      }
      K.tone(out, t + 0.02, { f: 3136 * o.p, a: 0.002, d: 0.25, v: 0.02, vib: { rate: 6, depth: 15 } });
      K.hiss(out, t, { type: 'highpass', f: 5200, q: 0.7, a: 0.03, d: 0.16, v: 0.06 });
    } },

    // Organic rustle of leaves plus a soft stretching creak
    weld: { gap: 0.06, fn(K, out, t, o) {
      const n = 5 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        K.hiss(out, t + rand(0, 0.22), { type: 'bandpass', f: rand(1100, 3300) * o.p, q: 2.5, a: 0.004, d: rand(0.03, 0.08), v: rand(0.15, 0.24) });
      }
      K.tone(out, t, { f: 260 * o.p, f1: 390 * o.p, glide: 0.12, type: 'triangle', a: 0.02, d: 0.12, v: 0.05 });
    } },

    // Magnet engages: a metallic click, then a short electric hum that rises while it pulls
    magnet: { gap: 0.15, vary: 0.02, fn(K, out, t, o) {
      const n = Math.max(0, Math.floor(+o.count || 0));
      const g = n ? Math.min(1, 0.8 + 0.05 * n) : 0.6; // softer when there is nothing to pull
      const dur = 0.45;
      K.hiss(out, t, { type: 'bandpass', f: 3200 * o.p, q: 1.5, a: 0.0005, d: 0.012, v: 0.28 });
      const partials = [1490, 2210, 3370];
      for (let i = 0; i < partials.length; i++) {
        K.tone(out, t, { f: partials[i] * o.p, a: 0.0008, d: 0.08 - i * 0.02, v: 0.04 });
      }
      const lp = K.filter(out, { type: 'lowpass', f: 500, f1: 1700, q: 2, t0: t, t1: t + dur });
      const trem = K.c.createGain();
      trem.gain.value = 0.8;
      trem.connect(lp);
      K.lfo(trem.gain, t, t + dur + 0.05, 33, 0.2);
      K.tone(trem, t + 0.01, { f: 110 * o.p, f1: 220 * o.p, glide: dur, type: 'sawtooth', a: 0.08, hold: dur - 0.2, d: 0.12, v: 0.075 * g });
      K.tone(trem, t + 0.01, { f: 220 * o.p, f1: 440 * o.p, glide: dur, a: 0.08, hold: dur - 0.2, d: 0.12, v: 0.05 * g });
    } },

    // Steam hiss with popping bubbles
    melt: { gap: 0.1, fn(K, out, t, o) {
      K.hiss(out, t, { type: 'highpass', f: 3600, q: 0.5, a: 0.05, hold: 0.15, d: 0.4, v: 0.05 });
      const n = 4 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        const f = rand(170, 330) * o.p;
        K.tone(out, t + rand(0.02, 0.52), { f, f1: f * 2.6, glide: 0.04, a: 0.003, d: 0.05, v: rand(0.07, 0.11) });
      }
    } },

    // Short brass fanfare: C-E-G run into a held C major chord
    milestone: { gap: 0.5, prio: 2, vary: 0, fn(K, out, t) {
      const lp = K.filter(out, { type: 'lowpass', f: 2400, q: 0.6, t0: t });
      const run = [523.25, 659.25, 783.99];
      for (let i = 0; i < run.length; i++) brass(K, lp, t + i * 0.1, run[i], 0, 0.12, 0.07);
      const chord = [1046.5, 783.99, 659.25];
      for (let i = 0; i < chord.length; i++) brass(K, lp, t + 0.3, chord[i], 0.16, 0.5, 0.06);
    } },

    // Slow descending phrase settling onto a low C
    gameOver: { gap: 1, prio: 2, vary: 0, fn(K, out, t) {
      const lp = K.filter(out, { type: 'lowpass', f: 1500, q: 0.5, t0: t });
      const notes = [392, 329.63, 261.63];
      for (let i = 0; i < notes.length; i++) {
        K.tone(lp, t + i * 0.3, { f: notes[i], type: 'triangle', a: 0.01, d: 0.45, v: 0.095 });
        K.tone(lp, t + i * 0.3, { f: notes[i] * 1.003, type: 'sawtooth', a: 0.01, d: 0.35, v: 0.018 });
      }
      K.tone(lp, t + 0.9, { f: 130.81, type: 'triangle', a: 0.02, hold: 0.25, d: 1.1, v: 0.12 });
      K.tone(lp, t + 0.9, { f: 196, a: 0.02, hold: 0.25, d: 0.9, v: 0.045 });
      K.hiss(out, t, { type: 'lowpass', f: 600, f1: 200, q: 0.3, a: 0.4, d: 1.2, v: 0.02 });
    } },

    // UI button
    click: { gap: 0.025, prio: 0, vary: 0.04, fn(K, out, t, o) {
      K.tone(out, t, { f: 1500 * o.p, f1: 950 * o.p, glide: 0.02, a: 0.001, d: 0.028, v: 0.14 });
      K.hiss(out, t, { type: 'highpass', f: 4000, a: 0.001, d: 0.008, v: 0.05 });
    } },

    // Short quiet descending blip: a drag was let go outside the playfield, nothing dropped
    cancel: { gap: 0.12, rate: 3, cap: 2, vary: 0.03, fn(K, out, t, o) {
      K.tone(out, t, { f: 740 * o.p, f1: 392 * o.p, glide: 0.09, type: 'triangle', a: 0.004, d: 0.1, v: 0.075 });
      K.tone(out, t, { f: 1480 * o.p, f1: 784 * o.p, glide: 0.06, a: 0.002, d: 0.05, v: 0.012 });
    } },

    // Soft two-pulse buzz: not allowed (yet)
    deny: { gap: 0.15, vary: 0.02, fn(K, out, t, o) {
      const lp = K.filter(out, { type: 'lowpass', f: 900, q: 0.7, t0: t });
      K.tone(lp, t, { f: 196 * o.p, type: 'sawtooth', a: 0.004, hold: 0.04, d: 0.05, v: 0.045 });
      K.tone(lp, t + 0.1, { f: 165 * o.p, type: 'sawtooth', a: 0.004, hold: 0.05, d: 0.06, v: 0.045 });
    } },

    // Soft two-note chime; the root walks a pentatonic scale from batch to batch
    newBatch: { gap: 0.2, vary: 0.005, fn(K, out, t, o) {
      const round = Math.max(1, Math.floor(o.round || 1));
      const f = 659.25 * Math.pow(2, BATCH_STEPS[(round - 1) % BATCH_STEPS.length] / 12) * o.p;
      K.tone(out, t, { f, a: 0.008, d: 0.32, v: 0.055 });
      K.tone(out, t + 0.07, { f: f * 1.5, a: 0.008, d: 0.36, v: 0.04 });
      K.tone(out, t + 0.07, { f: f * 3, a: 0.004, d: 0.12, v: 0.01 });
    } }
  };
  const SOUND_NAMES = Object.freeze(Object.keys(SOUNDS));

  // ---- Engine ---------------------------------------------------------------------
  let Ctor;                  // AudioContext constructor; null = no WebAudio here
  let ctx = null, master = null, kit = null;
  let inited = false, muted = false, volume = clamp(AUDIO_VOLUME, 0, 1), haptics = true;
  let unlockedOnce = false, primed = false, unlockAt = -1e9, suspendedByUs = false;
  const live = [];                         // end times (context s) of sounds still playing
  const lastPlay = Object.create(null);    // name -> wall ms of the last accepted play
  const buckets = Object.create(null);     // name -> { tokens, at }
  let vibUntil = 0, vibPrio = -1;

  function findCtor() {
    if (Ctor !== undefined) return Ctor;
    Ctor = (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) || null;
    return Ctor;
  }

  function hasActivation() {
    const ua = typeof navigator !== 'undefined' ? navigator.userActivation : null;
    return ua ? !!ua.hasBeenActive : true;
  }

  function ensureContext() {
    if (ctx) return ctx;
    const Ctx = findCtor();
    if (!Ctx) return null;
    try {
      ctx = new Ctx({ latencyHint: 'interactive' });
    } catch (err) {
      try { ctx = new Ctx(); } catch (err2) { Ctor = null; return null; }
    }
    try {
      // iOS/Safari: mix with the player's own music and respect the silent switch
      if (typeof navigator !== 'undefined' && navigator.audioSession) navigator.audioSession.type = 'ambient';
    } catch (err) { /* optional API */ }
    master = makeMaster(ctx);
    kit = makeKit(ctx, makeNoise(ctx));
    applyVolume(true);
    return ctx;
  }

  function tryResume() {
    if (!ctx || typeof ctx.resume !== 'function') return;
    try {
      const r = ctx.resume();
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch (err) { /* ignore */ }
  }

  function applyVolume(instant) {
    if (!ctx || !master) return;
    const target = muted ? 0 : volume * volume; // perceptual curve
    const p = master.gain;
    if (instant) { p.value = target; return; }
    try {
      p.cancelScheduledValues(ctx.currentTime);
      p.setTargetAtTime(target, ctx.currentTime, 0.03);
    } catch (err) { p.value = target; }
  }

  // True when a sound scheduled now will be heard promptly
  function canPlay() {
    if (!ctx) {
      if (!unlockedOnce && !hasActivation()) return false;
      if (!ensureContext()) return false;
    }
    if (ctx.state === 'running') return true;
    if (ctx.state === 'closed') return false;
    // suspended / interrupted: ask to resume, but only queue sounds right after a gesture
    // so a context that stays suspended can't pile up a burst of stale sounds
    tryResume();
    return nowMs() - unlockAt < 800;
  }

  function activeVoices(now) {
    for (let i = live.length - 1; i >= 0; i--) if (live[i] <= now) live.splice(i, 1);
    return live.length;
  }

  function admit(name, def) {
    const now = nowMs();
    if (def.gap && now - (lastPlay[name] || -1e9) < def.gap * 1000) return false;
    const prio = def.prio != null ? def.prio : 1;
    if (prio < 2 && activeVoices(ctx.currentTime) >= AUDIO_MAX_VOICES * (prio === 0 ? 0.5 : 1)) return false;
    if (def.rate) {
      const b = buckets[name] || (buckets[name] = { tokens: def.cap, at: now });
      b.tokens = Math.min(def.cap, b.tokens + (now - b.at) / 1000 * def.rate);
      b.at = now;
      if (b.tokens < 1) return false;
      b.tokens -= 1;
    }
    lastPlay[name] = now;
    return true;
  }

  function voiceOptions(def, opts) {
    const o = Object.assign({}, opts);
    const jitter = def.vary != null ? def.vary : 0.03;
    o.p = (o.pitch > 0 ? o.pitch : 1) * (1 + (Math.random() * 2 - 1) * jitter);
    o.vol = o.volume != null ? clamp(+o.volume || 0, 0, 2) : 1;
    o.pan = typeof o.x === 'number' && isFinite(o.x) ? clamp(o.x / FIELD_WIDTH * 2 - 1, -1, 1) * AUDIO_PAN : 0;
    return o;
  }

  // One sound on its own bus (gain [-> panner] -> dest). Returns null if nothing was scheduled.
  function buildVoice(K, dest, def, t, o) {
    const c = K.c;
    const out = c.createGain();
    out.gain.value = o.vol;
    let tail = out;
    if (o.pan && typeof c.createStereoPanner === 'function') {
      tail = c.createStereoPanner();
      tail.pan.value = o.pan;
      out.connect(tail);
    }
    tail.connect(dest);
    const v = { out, tail, last: null, end: 0 };
    K.last = null;
    K.end = 0;
    try {
      def.fn(K, out, t, o);
    } catch (err) {
      disconnectVoice(v);
      throw err;
    }
    v.last = K.last;
    v.end = K.end;
    if (!v.last) { disconnectVoice(v); return null; }
    return v;
  }

  function disconnectVoice(v) {
    try { v.out.disconnect(); } catch (err) { /* already gone */ }
    if (v.tail !== v.out) { try { v.tail.disconnect(); } catch (err) { /* already gone */ } }
  }

  // ---- Public API -------------------------------------------------------------------
  function init() {
    if (inited) return api;
    inited = true;
    findCtor();
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      // Any user gesture unlocks (and later re-resumes) audio, even if the UI forgets to
      const onGesture = () => { unlock(); };
      for (const type of ['pointerdown', 'pointerup', 'touchend', 'mousedown', 'keydown', 'click']) {
        window.addEventListener(type, onGesture, { capture: true, passive: true });
      }
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibility);
    }
    return api;
  }

  // Call from a user gesture. Creates/resumes the context; cheap to call repeatedly.
  function unlock() {
    try {
      unlockedOnce = true;
      unlockAt = nowMs();
      if (muted && !ctx) return false; // nothing to unlock yet; the next gesture after unmuting will
      if (!ensureContext()) return false;
      if (ctx.state !== 'running') tryResume();
      if (!primed) {
        // iOS: a buffer started inside the gesture unlocks output for the page's lifetime
        const src = ctx.createBufferSource();
        src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        src.connect(ctx.destination);
        src.start(0);
        primed = true;
      }
      return true;
    } catch (err) {
      return false;
    }
  }

  // Suspend while the page is hidden (battery); resume when it comes back
  function onVisibility() {
    if (!ctx) return;
    try {
      if (document.hidden) {
        if (ctx.state === 'running' && typeof ctx.suspend === 'function') {
          suspendedByUs = true;
          const r = ctx.suspend();
          if (r && typeof r.catch === 'function') r.catch(() => {});
        }
      } else if (suspendedByUs) {
        suspendedByUs = false;
        tryResume();
      }
    } catch (err) { /* ignore */ }
  }

  function setMuted(b) {
    muted = !!b;
    applyVolume(false);
    return muted;
  }

  function isMuted() { return muted; }

  function setVolume(v) {
    const n = Number(v);
    if (isFinite(n)) volume = clamp(n, 0, 1);
    applyVolume(false);
    return volume;
  }

  function getVolume() { return volume; }

  function setHaptics(b) {
    haptics = !!b;
    if (!haptics) {
      try { if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(0); } catch (err) { /* ignore */ }
      vibUntil = 0;
    }
    return haptics;
  }

  function getHaptics() { return haptics; }

  // Vibrate (ms or pattern) if haptics are on. A weaker buzz never cuts a stronger one short.
  function vibrate(pattern, prio) {
    if (!haptics || typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false;
    if (!hasActivation()) return false; // browsers block (and warn) before the first tap
    const p = prio || 0;
    const now = nowMs();
    if (now < vibUntil && p <= vibPrio) return false;
    const ms = Array.isArray(pattern) ? pattern.reduce((a, b) => a + b, 0) : +pattern || 0;
    if (ms <= 0) return false;
    try {
      if (navigator.vibrate(pattern)) {
        vibUntil = now + ms + 30;
        vibPrio = p;
        return true;
      }
    } catch (err) { /* ignore */ }
    return false;
  }

  // Play a named sound. opts: { x (world x, pans), pitch, volume, delay (s), ...sound specific:
  // impact + block | typeKey (land, set), impact + block (boing), index (select), mode (mode),
  // round (newBatch), count + cause (shatter), count (glass, magnet), block (pop),
  // source (freeze) }. Returns true if it was scheduled.
  function play(name, opts) {
    try {
      const def = SOUNDS[name];
      if (!def || muted) return false;
      if (!canPlay() || !admit(name, def)) return false;
      const o = voiceOptions(def, opts);
      const t = ctx.currentTime + 0.005 + clamp(+o.delay || 0, 0, 5);
      const v = buildVoice(kit, master, def, t, o);
      if (!v) return false;
      live.push(v.end);
      v.last.onended = () => disconnectVoice(v);
      return true;
    } catch (err) {
      return false;
    }
  }

  // Renders one sound offline (tests / tooling); resolves to an AudioBuffer or null
  function renderOffline(name, opts, seconds) {
    try {
      const Off = typeof window !== 'undefined' && (window.OfflineAudioContext || window.webkitOfflineAudioContext);
      const def = SOUNDS[name];
      if (!Off || !def) return Promise.resolve(null);
      const rate = 44100;
      const oc = new Off(2, Math.ceil(rate * (seconds || 2.5)), rate);
      const out = makeMaster(oc);
      out.gain.value = volume * volume;
      const o = voiceOptions(def, opts);
      buildVoice(makeKit(oc, makeNoise(oc)), out, def, 0.01 + clamp(+o.delay || 0, 0, 5), o);
      const r = oc.startRendering();
      if (r && typeof r.then === 'function') return r;
      return new Promise((resolve) => { oc.oncomplete = (e) => resolve(e.renderedBuffer); });
    } catch (err) {
      return Promise.resolve(null);
    }
  }

  // ---- Game events ------------------------------------------------------------------
  let game = null;
  let subs = [];
  const seen = Object.create(null);   // event name -> wall ms it last arrived
  const since = (name) => nowMs() - (seen[name] || -1e9);
  let readyPending = false, lastMoveAt = -1e9, lastMoveDetent = NaN;

  function flushReady() {
    if (!readyPending) return;
    readyPending = false;
    play('ready');
  }

  // How loud a landing boings: 1 for a rubber block, 0.75 for a block landing on rubber
  // (Box2D mixes restitution with max(), so it bounces too), 0 when no rubber is involved
  function rubberBounce(block, g) {
    if (!block || muted) return 0;
    if (block.typeKey === 'rubber') return 1;
    const P = g && g.physics;
    if (!P || typeof P.touching !== 'function') return 0;
    try {
      const list = P.touching(block);
      for (let i = 0; i < list.length; i++) {
        const other = list[i] && list[i].other;
        if (other && other.typeKey === 'rubber') return 0.75;
      }
    } catch (err) { /* contact query failed: no boing */ }
    return 0;
  }

  const HANDLERS = {
    newBatch(p) {
      readyPending = false; // the chime already says "go"
      play('newBatch', { round: p.round });
    },
    // The game re-selects a slot right after every drop and deal; only player picks click
    select(p) {
      if (since('drop') < 90 || since('newBatch') < 90) return;
      play('select', { index: p.index });
    },
    move(p, g) {
      const now = nowMs();
      const x = p.x;
      if (g && g.mode === 'manual') {
        // Holding slides a pixel per frame: tick on half-cell detents, or for an isolated tap
        const detent = Math.floor((x || 0) * 2);
        const isolated = now - lastMoveAt > 180;
        lastMoveAt = now;
        if (!isolated && detent === lastMoveDetent) return;
        lastMoveDetent = detent;
        play('move', { x, volume: 0.75 });
        return;
      }
      lastMoveAt = now;
      play('move', { x });
    },
    mode(p) { play('mode', { mode: p.mode }); },
    drop(p) { play('drop', { x: p.x }); },
    // Weightless blocks set down with a soft tap; the anvil (or anything that hit fast) thuds
    land(p, g) {
      const impact = typeof p.impact === 'number' ? p.impact : FALL_SPEED * 0.8;
      const heavy = isHeavy(p.block);
      play(!heavy && impact < SOFT_TAP_MAX ? 'set' : 'land', { x: p.x, impact, block: p.block });
      const spring = rubberBounce(p.block, g);
      if (spring) play('boing', { x: p.x, impact, block: p.block, volume: spring });
      // Only heavy landings buzz, and an anvil always lands with its full weight
      if (heavy || impact * massFactor(p.block) >= HAPTIC_LAND_IMPACT) vibrate(HAPTIC_LAND_MS, 0);
    },
    // Deferred to the end of the frame: 'ready' and 'newBatch' often arrive together
    ready() {
      if (readyPending) return;
      readyPending = true;
      later(flushReady);
    },
    lifeLost(p) {
      play('lifeLost', { x: p.x, lives: p.lives });
      vibrate(HAPTIC_LIFE_MS, 2);
    },
    shieldUsed(p) { play('shieldUsed', { x: p.x }); },
    lifeGained(p) { play('lifeGained', { delay: p.reason === 'milestone' ? MILESTONE_LIFE_DELAY : 0 }); },
    shield() { play('shield'); },
    milestone(p) { play('milestone', { height: p.height }); },
    explode(p) {
      play('explode', { x: p.x, radius: p.radius });
      vibrate(HAPTIC_EXPLODE_MS, 1);
    },
    fuse(p) { play('fuse', { x: p.x }); },
    // Ruby glass breaks with its own tinkle; a block smashed by an anvil cracks. Sized by the
    // broken block's cells (p.block, still alive when the event fires).
    shatter(p) {
      const count = p.block && p.block.cells ? p.block.cells.length : p.count;
      if (p.cause === 'glass') {
        play('glass', { x: p.x, count });
        vibrate(HAPTIC_GLASS_MS, 1);
        return;
      }
      play('shatter', { x: p.x, count, cause: p.cause });
    },
    pop(p) {
      play('pop', { x: p.x, block: p.block });
      vibrate(HAPTIC_POP_MS, 1);
    },
    magnet(p) { play('magnet', { x: p.x, count: p.count }); },
    swallow(p) { play('swallow', { x: p.x }); },
    freeze(p) { play('freeze', { x: p.x, source: p.source }); },
    weld(p) {
      const pts = Array.isArray(p.points) ? p.points : [];
      let x;
      if (pts.length) { x = 0; for (const q of pts) x += (q && q.x) || 0; x /= pts.length; }
      play('weld', { x });
    },
    melt(p) { play('melt', { x: p.x }); },
    gameOver() { play('gameOver'); },
    deny() { play('deny'); }
  };

  // Subscribe to a game's events (replacing any previous game); null just detaches
  function attach(g) {
    detach();
    if (!g || typeof g.on !== 'function') return false;
    init();
    game = g;
    for (const name of Object.keys(HANDLERS)) {
      const fn = (payload) => {
        seen[name] = nowMs();
        try { HANDLERS[name](payload || {}, g); } catch (err) { /* sound must never break the game */ }
      };
      const off = g.on(name, fn);
      subs.push(typeof off === 'function' ? off : () => { if (typeof g.off === 'function') g.off(name, fn); });
    }
    return true;
  }

  function detach() {
    for (const off of subs) { try { off(); } catch (err) { /* ignore */ } }
    subs = [];
    game = null;
    readyPending = false;
  }

  function isAvailable() { return !!findCtor(); }
  function getState() { return ctx ? ctx.state : (findCtor() ? 'locked' : 'unavailable'); }
  function attachedGame() { return game; }

  const api = {
    init, unlock, setMuted, isMuted, setVolume, getVolume, setHaptics, getHaptics, vibrate,
    play, attach, detach, attachedGame, isAvailable, getState, renderOffline, SOUND_NAMES
  };
  TT.Audio = api;
})(typeof window !== 'undefined' ? (window.TT = window.TT || {}) : (global.TT = global.TT || {}));
