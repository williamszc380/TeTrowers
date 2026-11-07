/* TeTrowers — central tuning constants.
 * Units: 1 world unit = 1 block cell = 1 metre of tower height. y points UP.
 * Every gameplay number lives here so balancing never requires touching logic code.
 */
(function (TT) {
  'use strict';

  TT.CONFIG = Object.freeze({
    VERSION: '1.1.0',         // keep in sync with VERSION in sw.js (installed copies update on change)

    // ---- Field -------------------------------------------------------------
    FIELD_WIDTH: 16,          // blocks may be dropped with x in [0, FIELD_WIDTH]
    PLATFORM_X0: 5,           // initial platform spans x in [5, 11] (6 wide, centred)
    PLATFORM_X1: 11,
    PLATFORM_TOP: 0,          // platform top surface y
    PLATFORM_DEPTH: 6,        // collision depth of the platform pillar
    LOST_Y: -2,               // a block whose highest point drops below this is lost
    LOST_X_MARGIN: 12,        // ...or whose centre leaves [-margin, FIELD_WIDTH + margin]

    // ---- Physics (planck.js / Box2D) -----------------------------------------
    GRAVITY: 25,
    PHYSICS_HZ: 120,          // fixed substep rate (2 substeps per 60 fps frame)
    VEL_ITERS: 20,            // tested: 60 Hz / 10 iters collapses tall stacks, this does not
    POS_ITERS: 10,
    MAX_SUBSTEPS: 6,          // per frame; backlog beyond this is dropped (no spiral of death)
    MAX_FRAME_DT: 0.1,
    FRICTION: 0.7,
    DENSITY: 1,
    RESTITUTION: 0,
    LINEAR_DAMPING: 0,
    ANGULAR_DAMPING: 0.3,       // tipped blocks settle instead of rolling off the tower
    MAX_FALL_SPEED: 9,        // terminal velocity of a falling (not yet landed) block

    // Forgiving collision geometry (visuals stay exactly 1x1 per cell)
    CELL_INSET: 0.02,         // outer left/right faces are inset by this much per side
    CHAMFER: 0.06,            // convex outer corners are cut by this much

    // ---- Drop / hover ---------------------------------------------------------
    DROP_GAP: 3.5,            // hovering piece bottom sits this far above the tower top
    MIN_HOVER_Y: 5,
    HOVER_RISE_SPEED: 8,      // cells/s the hover line eases upward
    HOVER_FALL_SPEED: 4,      // cells/s it eases downward (after collapses)
    DROP_START_SPEED: 2,      // initial downward speed given on release

    // ---- Placement modes ------------------------------------------------------
    MODES: ['assisted', 'fixed', 'manual'],
    DEFAULT_MODE: 'assisted',
    FIXED_STEP: 0.5,          // half-block granularity
    ALIGN_EPS: 0.03,          // tolerance for "aligned with the block below"
    ALIGN_MAX_TILT: 0.15,     // rad; supports tilted more than this are not aligned to
    MANUAL_HOLD_DELAY: 0.22,  // s before a held key starts sliding in manual mode
    MANUAL_SPEED_MIN: 1.5,    // cells/s when sliding starts
    MANUAL_SPEED_MAX: 10,     // cells/s after accelerating
    MANUAL_ACCEL_TIME: 0.8,   // s to reach max speed
    KEY_REPEAT_DELAY: 0.17,   // s, assisted/fixed auto-repeat
    KEY_REPEAT_RATE: 0.055,   // s between repeats

    // Assisted "guided fall": the falling block tracks its target support if it drifts
    GUIDE_GAIN: 12,           // 1/s proportional gain on horizontal error
    GUIDE_MAX_SPEED: 4,       // m/s horizontal correction speed cap
    GUIDE_MAX_CORRECTION: 1.0,// abort guidance if the support drifted further than this

    // ---- Settling / height ----------------------------------------------------
    SETTLE_SPEED: 0.08,       // |v| + |w| below this counts as still
    UNSETTLE_SPEED: 0.5,      // a settled block only counts as moving again above this (hysteresis)
    SETTLE_TIME: 0.4,         // s still before a block is "settled" (effects fire once)
    HEIGHT_SETTLE_TIME: 0.75, // s settled before a block counts toward best height
    PETRIFY_DEPTH: 10,        // settled blocks whose top is this far below the tower top...
    PETRIFY_TIME: 2.0,        // ...for this long become static (stability + performance)

    // ---- Turn flow ------------------------------------------------------------
    READY_MIN: 0.3,           // s after a drop before the next drop is allowed
    READY_AFTER_TOUCH: 1.2,   // s after the dropped block first touches something
    READY_MAX: 4.0,           // s after a drop: always ready
    BATCH_SIZE: 3,

    // ---- Lives ----------------------------------------------------------------
    START_LIVES: 3,
    MAX_LIVES: 3,
    LIFE_MILESTONE: 8,        // +1 life every time best height passes a multiple of this

    // ---- Difficulty (h = floor(best height in m)) -----------------------------
    NEG_BASE: 0.05,
    NEG_PER_M: 0.009,
    NEG_MAX: 0.70,
    POS_BASE: 0.22,
    POS_PER_M: 0.0035,
    POS_MIN: 0.04,

    // ---- Special block effects ------------------------------------------------
    MINE_FUSE: 0.35,          // s between trigger and blast
    MINE_RADIUS: 3.0,
    MINE_IMPULSE: 7,          // velocity change (m/s) at the blast centre, linear falloff
    MINE_UPWARD_BIAS: 0.35,
    ANVIL_IMPACT_WINDOW: 0.12,// s after first touch during which touched blocks below shatter
    MAGMA_TURNS: 3,           // drops after settling before magma melts away
    HORIZON_SIZE: 0.9,        // black-hole side sensor size (cells)
    HORIZON_GRACE_STEPS: 2,   // substeps after activation during which overlaps are spared
    MAGNET_RADIUS: 2.5,       // blocks with a cell centre this close to the magnet's cells are pulled
    MAGNET_TIME: 0.6,         // s the alignment pull lasts after the magnet settles
    MAGNET_GAIN: 10,          // 1/s proportional gain toward the aligned pose
    MAGNET_MAX_SPEED: 2,      // m/s (and rad/s) cap on the corrective motion
    MAGNET_MAX_TILT: 0.4,     // rad; blocks tilted further than this from the grid are left alone
    HAPTIC_LAND_IMPACT: 18,   // only heavy landings (e.g. an anvil) vibrate the phone

    // ---- Presentation ---------------------------------------------------------
    VIEW_CELLS_WIDE: 18,      // field width + 1 cell margin each side
    VIEW_MIN_ROWS: 21,        // never show fewer rows than this (wide screens see more tower)
    CAMERA_LERP: 4,           // 1/s
    MAX_DPR: 2,
    STATIC_CHUNK_ROWS: 16,    // renderer caches static blocks in chunks of this many rows
    IDLE_FPS: 20              // render rate when nothing moves and no input
  });
})(typeof window !== 'undefined' ? (window.TT = window.TT || {}) : (global.TT = global.TT || {}));
