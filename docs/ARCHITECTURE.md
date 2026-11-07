# TeTrowers — Architecture & Module Contracts

TeTrowers is a single-player, physics-based tower-stacking game. You drop tetromino blocks
(never rotated) onto a 6-wide platform and build as high as you can. Special blocks help (cold
colours) or hurt (warm colours); the bad ones become more likely the higher you build, so every run
ends. It runs in desktop and Android browsers, works offline as a PWA, and is hosted on GitHub Pages.

This document is the **contract** between modules. Names, fields and semantics here are binding.

---------------------------------------------------------------------------------------------------

## 1. Ground rules

* **No build step, no bundler, no npm runtime deps.** Plain classic `<script>` files that work from
  `file://` (double-click `index.html`) *and* from `https://williamszc380.github.io/TeTrowers/`.
  Therefore: no ES modules, no `fetch()` of local files, **relative paths only** (`js/x.js`, never `/js/x.js`).
* Every file is an IIFE that extends the global namespace:
  ```js
  (function (TT) {
    'use strict';
    ...
  })(typeof window !== 'undefined' ? (window.TT = window.TT || {}) : (global.TT = global.TT || {}));
  ```
* **DOM-free core**: `config, util, rng, shapes, blocktypes, generator, physics, effects, placement, game`
  must never touch `window.document`, `localStorage`, `requestAnimationFrame`, canvas, audio at load
  time *or* at runtime. They are loaded in Node by `tests/load-core.js` for unit tests and `tools/sim.js`.
* Style: 2-space indent, single quotes, semicolons, `const`/`let`, ES2020 (classes, arrow fns, optional
  chaining is OK). Comment density like the existing files: a header comment per file, short comments
  on non-obvious logic only.
* Physics library: `planck.js 1.5.0` (Box2D port) vendored at `js/lib/planck.min.js`, global `planck`.
* Performance is a feature (target: 500 placed blocks without stutter on a mid-range Android phone).
  See §9.

### Script load order (index.html, and `CORE_FILES` in tests/load-core.js for the first 10)
```
js/lib/planck.min.js
js/config.js  js/util.js  js/rng.js  js/shapes.js  js/blocktypes.js  js/generator.js
js/physics.js  js/effects.js  js/placement.js  js/game.js
js/particles.js  js/render.js  js/audio.js  js/input.js  js/ui.js  js/main.js
```

### File ownership
| File(s) | Status |
|---|---|
| `js/config.js, util.js, rng.js, shapes.js, blocktypes.js, generator.js, physics.js`, `tests/load-core.js` | **Done — read them, do not edit.** Need a new constant? Define it at the top of your own module as `const X = (C.X != null ? C.X : default);` and mention it in your report. |
| `js/game.js` | Game state machine (written by the lead) |
| `js/effects.js` | Special block behaviours |
| `js/placement.js` | Landing prediction, snapping, assisted mode |
| `js/render.js, js/particles.js` | Canvas renderer + FX |
| `js/audio.js` | Synthesised sound |
| `index.html, css/style.css, js/ui.js, js/input.js, js/main.js` | DOM UI, controls, app bootstrap |
| `sw.js, manifest.webmanifest, icons/*, tools/*, README.md, .nojekyll, .gitignore, *.bat` | Packaging & tools |

---------------------------------------------------------------------------------------------------

## 2. World model

* 1 world unit = 1 cell = 1 metre. **y points up.** Field (where pieces can be dropped) is
  `x ∈ [0, FIELD_WIDTH=16]`. Platform is static, `x ∈ [5, 11]`, top at `y = 0`, 6 deep.
* A piece's local origin is its **min cell corner** (bottom-left of its bounding box). A cell `[cx, cy]`
  occupies `[cx, cx+1] × [cy, cy+1]` locally. Body position = world position of that origin.
* Canvas has y down: renderer maps `screenY = originY - (worldY - camBottom) * scale`, and a body angle
  `a` is drawn with `ctx.rotate(-a)`.
* Blocks are lost when their highest point is below `LOST_Y (-2)` or their centre leaves
  `[-LOST_X_MARGIN, FIELD_WIDTH + LOST_X_MARGIN]`.

### Block object (created by `physics.createBlock`, see js/physics.js)
```
id, n (generator index or -1), typeKey, type (BLOCK_TYPES entry), shapeId, shape, cells,
look (visual style key; rubble keeps the look of what it shattered from), tint (normal blocks: neutral
family tint hex; rubble: inherited), cracked (bool, rubble), body (planck.Body), isPlatform:false,
dropped, dropTime, dropTurn, touched, touchTime,          // set by game
settled, stillTime, settledFor, activated,                // set by game
fallTurn, fallMoved   // set by game (absent until first set): turn in which the block was last set in
                      // motion, null once calm again; time it last moved clearly. Rubble inherits both.
frozen: null | 'steel' | 'frost' | 'petrified',          // set via physics.makeStatic
dead, deathReason ('lost'|'swallowed'|'exploded'|'melted'|'shattered'|...),
fx: {}      // per-type state, OWNED BY effects.js (renderer reads it, see §4)
guide       // assisted guided-fall state, owned by game.js
lastVel     // velocity before the latest substep (impact strength)
```
`physics.platform` is a pseudo-block `{ id: 0, isPlatform: true, typeKey: 'platform', body, frozen: 'platform', x0, x1, top }`.

### Physics API (implemented — read js/physics.js for details)
`TT.Physics.create()` → `physics` with: `world, blocks[], movers[] (non-static live blocks), platform,
time, stepCount, version, createBlock(spec, x, y, opts), removeBlock(block, reason),
makeStatic(block, reason), weld(a, b, worldPoint), addSensors(block, rects, tag), shatter(block, force),
step(dt, {beforeSubstep, afterSubstep}), drainContacts(), touching(block), cellQuads(block),
bounds(block), blocksInRadius(x, y, r), anyAwake()`.

* **Never mutate the world from a planck callback.** Contacts are queued; game.js drains them after each
  substep and hands them to effects.js, at which point the world is unlocked and effects may freely
  create/destroy/shatter/freeze/weld. Always check `block.dead` — an earlier event may have killed it.
* **Never use `fixture.getAABB()` for gameplay geometry** — it is Box2D's *fattened* broadphase box
  (+0.1 m). Use `physics.cellQuads(block)` / `physics.bounds(block)` (exact, cached while still).
* Collision shapes are deliberately forgiving: outer side faces are inset 0.02 per side and convex outer
  corners chamfered 0.06; visual cells remain exact unit squares.

---------------------------------------------------------------------------------------------------

## 3. Game rules (authoritative)

1. **Batches.** Each round deals `BATCH_SIZE = 3` blocks (generator, using the run's best height at deal
   time). The player may place them in any order. When all 3 are used, the next batch is dealt as soon
   as the drop is ready again. Portrait screens show the batch tray at the bottom; wide screens on the right.
2. **Shapes** are the 19 fixed tetromino orientations, uniformly random. No rotation. Pebble is 1×1.
3. **Categories by height** (`Generator.odds(h)`, h = floor(best height)): negative 5% → 70% (+1.1%/m),
   positive 22% → 4% (−0.45%/m), the rest normal. Types unlock at heights (see blocktypes.js).
   Special types can be individually disabled in the main menu (all enabled by default); a disabled
   pick is re-rolled among enabled types of that category, or becomes normal if none are enabled.
4. **Placement modes** (Ctrl cycles assisted → fixed → manual; default assisted):
   * **assisted** — left/right step between positions where the piece's cell grid lines up with the grid
     of the block it would land on (so edges are flush even when the tower has drifted). Where it would
     land on nothing / only the platform / a block tilted more than `ALIGN_MAX_TILT`, it uses half-block
     steps. On release, x is first re-snapped against a fresh surface (the one it was chosen on can be
     `SURFACE_INTERVAL` old). Then the falling piece is **guided**: until first contact its horizontal
     velocity = the landing spot's own velocity (feed-forward) + `GUIDE_GAIN` × the distance to it, at
     most `GUIDE_MAX_SPEED`, so if the block below shifts or keeps drifting during the fall the piece
     still lands where intended (user requirement: no "clipping a pixel" and missing the slot). If the
     support drifts further than `GUIDE_MAX_CORRECTION` or is destroyed, guidance stops and the
     horizontal velocity is reset to 0 in that substep: the piece falls straight down from there.
   * **fixed** — half-block steps (`FIXED_STEP = 0.5`), no guidance.
   * **manual** — pixel-precise: a key tap moves one screen pixel (`game.pixelSize` world units), holding
     slides and accelerates; a dragged block follows the pointer to the pixel. No guidance.
5. **Dropping.** Space / Enter, or letting go of a block dragged out of the tray over the playfield
   (touch and mouse alike; see §7 `TT.Input`), releases the piece from the hover line (`DROP_GAP`
   above the tower top, never below `MIN_HOVER_Y`). Falling speed is capped at
   `MAX_FALL_SPEED` until first contact. The next drop is allowed once the previous block has settled,
   or `READY_AFTER_TOUCH` s after it first touched something, or it died, or `READY_MAX` s passed (and at
   least `READY_MIN` s after the drop) — **and** no other block is still in motion (see rule 6: set in
   motion and not yet calm for `FALL_END_TIME`; the just-dropped piece counts once it has touched
   something). That extra wait is capped at `READY_FALL_MAX` (10) s after the drop, so it can never
   lock; `readyProgress` stays ≤ 0.99 meanwhile. The next piece can be positioned meanwhile. `ready`
   fires once per turn and never during the game-over delay.
6. **Turns & lives.** A *turn* runs from one drop to the next. 3 lives (max 3). **All blocks lost
   because of one turn cost at most one life** (or consume the shield), however long they take to fall:
   every loss is charged to the turn in which the block was set in motion — `block.fallTurn`, recorded
   when a block starts to move clearly (speed |vx|+|vy|+|w| > `UNSETTLE_SPEED`) and kept through
   tumbles, glances and bounces until it has been calm for `FALL_END_TIME` (0.5) s or settles — and each
   turn is charged at most once (a set of charged turns). A block lost without such a record is charged
   to the current turn. With the readiness wait of rule 5 a collapse plays out within the turn that
   caused it, so one drop normally never costs two hearts. Turn 0 (before the first drop) costs
   nothing. Swallowed / exploded / melted / popped blocks are *not* lost. At 0 lives the run ends (game
   over after ~1.5 s so the collapse plays out).
7. **Recovery.** Every time best height passes a multiple of `LIFE_MILESTONE` (10 m) the player gains a
   life (up to max). Crystal Heart gives +1 life, or a shield at full lives.
8. **Height.** Current height = top of the highest settled block (static blocks count immediately).
   Best height only counts blocks settled for ≥ `HEIGHT_SETTLE_TIME`. Score = best height.
9. **Petrify.** Settled blocks more than `PETRIFY_DEPTH` (14) below the tower top for `PETRIFY_TIME`
   become static (drawn slightly desaturated). Keeps 500-block towers fair and cheap.
10. **Seeds.** Single player; seeds let people compare scores. Same seed + same block set ⇒ same blocks.
    Random seeds are 6 chars (`RNG.randomSeed()`), daily seed `RNG.dailySeed()`, any text is accepted.
    `?seed=XXXX` in the URL pre-selects a seed.

### Special blocks (behaviour implemented in effects.js)
| key | category | behaviour |
|---|---|---|
| steel | + | On settle: becomes static (`makeStatic(b,'steel')`). |
| vine | + | On settle: welds itself to every block (and the platform) it touches. `fx.welds = [{x, y, partner, joint}]`: local anchor points for drawing, with the welded block and the joint. An anchor is dropped (in `Effects.update`, whenever `physics.version` changed) once its partner is dead or its joint is gone, so the renderer can draw every entry. |
| crystal | + | On settle: `game.gainLife('crystal')`, else `game.addShield()`. `fx.used = true`. |
| frost | + | On settle: becomes static ('frost') and freezes every dynamic block it touches ('frost'). |
| pebble | − | 1×1 cell (shape forced). No behaviour. |
| crumble | − | On first touch: shatters itself into 1×1 rubble. |
| oil | − | Friction 0 (material). No behaviour. |
| mine | − | On settle: `fx.armed = true`. When a non-sensor contact begins with a block **above** it (normal from mine to other has y > 0.5) it lights: `fx.fuse = MINE_FUSE`; when the fuse runs out it explodes (`Effects.explode`) and is removed ('exploded'). Static blocks are not pushed. Blocks already resting on top at arming are ignored for good (`fx.ignoreIds`): every touching solid contact with an upward normal (not just the first per neighbour), plus resting blocks with a cell flush on top of one of its cells (no contact needed: freezing either body destroys it). Before frost or steel freezes anything, each unarmed mine / glass / spikes in contact records what rests on it (`fx.restingIds`), so a block frozen before it settles still ignores its lid. |
| magma | − | On settle: `fx.turnsLeft = MAGMA_TURNS`. At each turn start (drop) it decrements; at 0 it is removed ('melted'). Works even if frozen. |
| anvil | − | Density 4. On first touch, and for `ANVIL_IMPACT_WINDOW` s after, every dynamic block it touches **below** it (normal y < −0.5) is shattered (`physics.shatter`). Mines are not shattered (they detonate instead). |
| blackhole | − | On settle: adds horizon sensors (tag `'horizon'`) one cell wide beside every side face of its cells (`HORIZON_SIZE` square, centred in the neighbour cell). Blocks overlapping at activation (first `HORIZON_GRACE_STEPS` substeps) are spared forever (`fx.spared` Set of ids). Afterwards any dynamic, non-blackhole block touching a horizon is swallowed (removed 'swallowed', no life lost). `fx.active = true`, `fx.horizonCells = [[cx, cy], ...]` local neighbour cells for drawing. |
| magnet | + | On settle: for `MAGNET_TIME` s pulls every dynamic, alive block with a cell centre within `MAGNET_RADIUS` of the magnet's cells (and tilted ≤ `MAGNET_MAX_TILT` from the magnet's grid, modulo quarter turns) onto the magnet's grid: horizontal velocity and angular velocity are steered toward the nearest grid-aligned pose (x snapped to the magnet's lattice, angle snapped to the magnet's angle + k·90°); vertical motion is left to gravity/contacts. Gain `MAGNET_GAIN`, cap `MAGNET_MAX_SPEED`. Emits `magnet {block, x, y, count}`; `fx.used = true`, `fx.pullUntil`, `fx.targets` (ids). |
| rubber | − | Material only: restitution 0.55 (Box2D mixes restitution with max(), so blocks landing on rubber bounce too). No handler. |
| glass | − | On settle: `fx.armed = true` (blocks already resting on top at that moment are ignored, exactly as for the mine). When a non-sensor contact begins with a dynamic block **above** it (normal glass→other y > 0.5), the glass shatters into 1×1 rubble (`physics.shatter`; static glass is immune) and emits `shatter {x, y, count, cause: 'glass'}`. |
| spikes | − | On settle: `fx.active = true` (blocks already resting on top are ignored, exactly as for the mine). When a non-sensor contact begins with a dynamic block **above** it (normal spikes→other y > 0.5), that block is destroyed ('popped', no life lost): emit `pop {block, x, y, spikes}` BEFORE removing it. Works when static. |
| rubble | internal | Output of shattering; no behaviour. |

---------------------------------------------------------------------------------------------------

## 4. `js/game.js` — `TT.Game`

`const game = TT.Game.create({ seed, mode, enabledTypes })` (also `new TT.Game.Game(opts)`).
`seed` any string (normalised via `RNG.normalizeSeed`; empty ⇒ random), `mode` default `'assisted'`,
`enabledTypes` iterable of special keys (default all).

**Readable state** (other modules treat these as read-only):
```
seed, rules ('' or 'no:...'), enabledTypes (Set), generator
state: 'playing' | 'paused' | 'over'
mode: 'assisted' | 'fixed' | 'manual'
lives, maxLives, shield (bool)
height, bestHeight (m), towerTop (world y), nextMilestone (m)
turn (drops so far), round (1-based batch number)
batch: [{ spec: {n, typeKey, shapeId}, used: bool }, ...]  or [] while the next batch is pending
selected: slot index or -1
piece: null | { spec, shape, type, x, y }   // hovering piece: x = origin x, y = bottom y (world)
ghost: null | { x, y, void, warnings: [...'void'|'mine'|'horizon'], supportId }
canDrop (bool), readyProgress (0..1)
hoverY (eased hover bottom y)
pixelSize (world units per CSS px; renderer sets via setPixelSize)
physics (TT.Physics instance), time (physics time, s), elapsed (play time, s)
odds (TT.Generator.typeOdds(bestHeight, enabledTypes): { neg, pos, normal, types: {key: p}, next: {key, unlock} | null }
      — the exact odds the next deal uses; a category with no enabled+unlocked type counts as 0)
stats: { drops, lost, livesLost, swallowed, exploded, shattered, melted, frozen, welded }
```
**Methods**
```
update(dt)                 // advance simulation; no-op unless state === 'playing' (or 'over' winding down)
moveStep(dir)              // dir -1 | +1: assisted = next aligned spot, fixed = 0.5, manual = 1 pixel
moveBy(dx)                 // continuous (manual hold-slide / manual drag); clamped
setTargetX(x)              // pointer aim (tray drag, playfield drag): snap per mode (assisted: nearest valid, fixed: 0.5 grid, manual: raw)
selectNext() / selectSlot(i)
drop() → bool
cycleMode() / setMode(mode)
pause() / resume() / togglePause()
setPixelSize(px)
gainLife(reason) → bool    // used by effects (crystal) and milestones
addShield() → bool
emit(name, payload) / on(name, fn) → unsubscribe
summary() → { seed, rules, bestHeight, height, elapsed, turn, stats, lives }
destroy()
```
### Events (`game.on(name, fn)`) — payloads
| event | payload |
|---|---|
| `newBatch` | `{ batch, round }` |
| `select` | `{ index, spec }` |
| `move` | `{ x }` (only when x actually changed) |
| `mode` | `{ mode }` |
| `drop` | `{ block, x, y }` |
| `land` | `{ block, x, y, impact }` (first touch; impact = speed m/s before contact) |
| `settle` | `{ block }` (first settle) |
| `ready` | `{}` (drop allowed again; once per turn, never during the game-over delay) |
| `blockLost` | `{ block, x, y }` |
| `lifeLost` | `{ lives, x, y }` |
| `shieldUsed` | `{ x, y }` |
| `lifeGained` | `{ lives, reason: 'milestone' | 'crystal' }` |
| `shield` | `{ active: true }` |
| `milestone` | `{ height }` |
| `height` | `{ height, best }` (best increased) |
| `explode` | `{ x, y, radius }` |
| `fuse` | `{ block, x, y }` |
| `mineArmed` | `{ block }` |
| `shatter` | `{ x, y, count, cause: 'anvil' | 'crumble' | 'glass' }` |
| `swallow` | `{ block, x, y, hole }` (`hole` = the black hole block) |
| `freeze` | `{ blocks, source: 'steel' | 'frost', x, y }` |
| `weld` | `{ block, points: [{x, y}] }` (world points) |
| `melt` | `{ block, x, y }` |
| `magnet` | `{ block, x, y, count }` (count = blocks being pulled) |
| `pop` | `{ block, x, y, spikes }` (a block destroyed by landing on spikes; emitted before removal) |
| `deny` | `{}` (drop pressed while not ready) |
| `petrify` | `{ block }` |
| `pause` / `resume` | `{}` |
| `gameOver` | `summary()` |

---------------------------------------------------------------------------------------------------

## 5. `js/effects.js` — `TT.Effects`

All functions receive the game (`game.physics`, `game.time`, `game.emit`, `game.gainLife`,
`game.addShield`, `game.turn`, `game.stats`). Called by game.js:
```
onFirstTouch(game, block, info)   // block.touched just became true; info = contact record or null
onContact(game, info)             // every drained contact record (world unlocked)
onSettle(game, block)             // first settle; game sets block.activated = true before calling
onTurnStart(game)                 // at each drop, before the new body exists (magma countdown)
update(game, dt)                  // once per frame after physics (fuses, timers)
explode(game, x, y, opts)         // radial blast: dv = MINE_IMPULSE*(1-d/R) on dynamic blocks, upward bias
canPetrify(game, block) → bool    // veto (e.g. a lit mine)
hazards(game) → { horizons: [{minX,maxX,minY,maxY, hole}], mines: Set<id>, spikes: Set<id>, glass: Set<id> }  // for placement
```
Contact record (from physics): `{ a, b, kindA, kindB, tagA, tagB, sensor, normal (a→b) | null, point | null, time }`.
Effects emit the gameplay events listed in §4 (`explode, fuse, mineArmed, shatter, swallow, freeze,
weld, melt`) and bump `game.stats`.

---------------------------------------------------------------------------------------------------

## 6. `js/placement.js` — `TT.Placement`

Pure functions over a **surface snapshot** (no world mutation).
```
buildSurface(physics, opts) → surface
    opts: { exclude: Set<block>|null, hazards: {horizons, mines} | null }
    Includes the platform, static blocks and movers that have touched && speed < 2 m/s.
    Builds a fine skyline (SAMPLES_PER_CELL = 32 samples per cell over x ∈ [-1, FIELD_WIDTH+1]):
    skyline[k] = highest top surface at that x (exact top edge of rotated quads), owner[k] = block.
    surface.version increments on each build.
landing(surface, shape, x) → { y, void, primary, supports, warnings }
    y = origin y at which the piece rests (max over its columns of surface - column bottom);
    primary = support block with the most overlap among those at the contact height;
    warnings ⊂ ['void', 'mine', 'horizon', 'spikes', 'glass'] ('spikes'/'glass': a support id is in
    hazards.spikes / hazards.glass — the piece would be destroyed / would shatter the glass).
candidates(surface, shape, mode) → sorted x[]   // 'assisted' | 'fixed'; cached per (surface.version, shape.id, mode)
stepX(surface, shape, mode, x, dir, pixelSize) → x
snapX(surface, shape, mode, x) → x
clampX(shape, x) → x                          // [0, FIELD_WIDTH - shape.w]
guideTarget(surface, shape, x) → { block, local: {x, y} } | null   // assisted guided fall target
```
Assisted validity: a candidate x is valid if (a) the primary support is a block with |angle| ≤
`ALIGN_MAX_TILT` and the piece grid is aligned with that block's grid (`ALIGN_EPS`), or (b) there is no
such support (void / platform / tilted) and x is on the half-block grid. Candidate seeds: half-grid
positions plus `edge + k` for each support block's cell edge.

---------------------------------------------------------------------------------------------------

## 7. Presentation modules

### `js/render.js` — `TT.Renderer`
```
const r = new TT.Renderer(canvas, { reducedMotion })
r.setGame(game)              // subscribes to game events for particles/shake; null to detach
r.resize(cssW, cssH, dpr)    // dpr capped at MAX_DPR; calls game.setPixelSize(1/scale)
r.render(dt)                 // draw one frame
r.isAnimating() → bool       // particles/shake/camera still moving (for idle throttling)
r.screenToWorld(px, py) / r.worldToScreen(x, y)
r.scale                      // CSS px per cell
TT.Renderer.drawPreview(canvas, spec, opts)   // static helper: draws a block spec centred in a small canvas (batch slots, codex)
```
* View is `VIEW_CELLS_WIDE` (18) cells wide; on wide canvases at least `VIEW_MIN_ROWS` rows tall.
  Camera eases so the hovering piece and ~2 cells above it stay in view; never shows below y ≈ −4.
* Draws: sky gradient that darkens toward space with altitude (stars at height), platform + pillar,
  height ruler on the side, next-milestone dashed line ("+♥ 20 m"), best-height marker, blocks (per-type
  look + icons: rivets, leaf, snow, heart, mine with blinking light, flame + magma countdown number,
  anvil, swirl, drop, pebble, cracks), frozen/petrified overlays, vine tendrils at `fx.welds`, black-hole
  horizon swirl at `fx.horizonCells` when `fx.active`, lit-mine flashing, the hovering piece, the ghost
  (outline at landing, red with an icon when warnings include void/mine/horizon), particles, screen shake.
* **Culling is mandatory**: only blocks whose `physics.bounds()` intersect the view are drawn, so cost is
  bounded by the view size, not the tower height (500+ blocks). Cell sprites are pre-rendered per
  (look, tint, cracked, scale) and blitted with the body transform. Optionally, static blocks may be
  cached into chunk canvases (`STATIC_CHUNK_ROWS` rows, small LRU) if measurement shows a win; animated
  overlays (magma number, lit mine, horizon swirl) are always drawn per frame on top.

### `js/particles.js` — `TT.Particles`
Pooled particle system: `burst(kind, x, y, opts)`, `update(dt)`, `draw(ctx, view)`, `count`.
Kinds: dust, explosion, smoke, shards, swirl, drip, sparkle, leaf, text (floating "+♥", "-♥", "SHIELD").

### `js/audio.js` — `TT.Audio`
WebAudio synthesis only (no audio files). `TT.Audio.init()`, `unlock()` (call from a user gesture),
`setMuted(b)`, `isMuted()`, `play(name, opts)`, `attach(game)` (subscribe to events), `detach()`.

### `js/input.js` — `TT.Input`
`TT.Input.create({ canvas, tray, getGame, getRenderer, isBlocked, onPause, onOdds, onMute, onActivity })`;
`update(dt)` once per frame (after `game.update`), `isActive()`, `releaseAll()` / `reset()`, `destroy()`,
`cue` (read-only, polled by ui.js every frame): `{ slot: lifted slot | -1, zone: 'field' | 'cancel' | '',
queued: bool }`. Also exported: `TT.Input.keyAction(e)`, `TT.Input.selectPrev(game)`.

Keyboard: ←/→ move (assisted/fixed: tap = one step, hold repeats after `KEY_REPEAT_DELAY` every
`KEY_REPEAT_RATE`; manual: tap = 1 px, hold slides from `MANUAL_SPEED_MIN` to `MANUAL_SPEED_MAX` cells/s),
↓ next unused block (`game.selectNext()`), ↑ previous unused block (wrapping; `selectPrev`), each once per
press (OS auto-repeat ignored), Space / Enter / NumpadEnter drop, Ctrl tapped alone cycles mode, Esc / P
pause, O odds, M mute, 1-3 select slot. ↓ never drops. Space / Enter on a control with keyboard focus
(`:focus-visible`) or in a text field press that control instead; a control focused by a mouse or touch
press never keeps the keys (a press on the playfield also blurs it). Nothing drops while paused, over or
with a menu open.

Pointer — **drag and drop from the tray is the only pointer way to drop**, identical for mouse, touch and
pen (pointer events; moves are coalesced and applied once per frame in `update`, the zone under the
pointer comes from `document.elementFromPoint`: the canvas = playfield, inside `tray` = tray, else out):
* A press on a `[data-slot]` button in `tray` selects that slot at once (`game.selectSlot`; a tap ends
  there and never drops) and takes pointer capture. Once its *path length* reaches `DRAG_START_PX` (8 CSS
  px) the block is lifted (`cue.slot`). Over the playfield the piece follows the pointer sideways,
  `game.setTargetX(worldX − piece.shape.w / 2)` (it stays on the hover line); over the tray or anywhere
  else (`cue.zone = 'cancel'`) it is back at its pick-up x.
* Letting go over the playfield aims at the release point and drops (`game.drop()`). When the drop is not
  allowed yet (`!game.canDrop`), it is queued instead (`cue.queued`, no `deny`): `update` drops it once
  `canDrop` turns true, provided the same piece object is still in hand. Any new tray press or drag, a
  key move / selection, another selection made elsewhere (the piece object changes), pause, a menu or
  `releaseAll` cancels the queued drop; a plain tap on the playfield does not.
* Letting go anywhere else (tray, HUD, sidebar, outside the window), `pointercancel`, a lost capture of the
  slot itself, window blur or the page being hidden cancel: nothing drops, the piece goes back to its
  pick-up x. A press on a used / empty slot does nothing at all.
* A drag that starts on the playfield moves the piece relative to where it was when the drag began
  (`game.setTargetX(pieceX + dx / scale)`) and **never drops**; a tap or click on the playfield does nothing.
* One gesture at a time: other pointers are ignored while a press is active (multi-touch).
* Only presses with the primary button / a touch / a pen contact play, and only as described above: a
  pointer that is merely moving changes nothing. The context menu is suppressed on the canvas and the
  slots (long presses).
`preventDefault` on game keys; `touch-action: none` on the canvas and the slots.

### `index.html`, `css/style.css`, `js/ui.js`, `js/main.js` — `TT.UI`, `TT.App`
Screens: title (Play, Daily Challenge, Enter Seed, Special Blocks, How to Play, Settings, best score),
seed entry, special-blocks toggles (grouped positive/negative with previews + descriptions, All on/off,
default all on), how-to-play (controls + rules + block codex), settings (default mode, sound, vibration,
ghost preview, reduced motion), HUD (lives + shield, height/best, mode button, pause, odds, seed),
batch tray (3 big slots with previews, at least 64 px each way on phones, selected highlight, used
dimmed, the selected block's description), a drag hint and key hints in the wide sidebar
(keys hidden on touch-only devices and below 720 px of height, the drag hint below 560 px), pause overlay
(resume, block odds, **Restart** + "Same seed" box, how to play, settings, quit to menu), game-over (best
height, time, drops, seed + rules, new best, **Play again** + "Same seed" box, copy result, menu),
first-time "new block" toasts and a one-time "Drag a block onto the playfield" tip (`Seen` key `#drag`).
Drag cues (ui.js mirrors `input.cue`, touching the DOM only on change): the lifted slot gets `.is-lifted`
(dashed outline); `#hud-tray` gets `.is-dragging` over the playfield ("Let go over the playfield to drop
it · drag back here to cancel") or `.is-cancel` elsewhere ("Release to cancel", tray highlighted), shown
in `#tray-cue` over the description; `.app.is-dragging` sets the grabbing cursor; `#drop-cue` ("Dropping
when ready" + a `readyProgress` bar) is placed above the hovering piece (below it when there is no room)
while a drop is queued. Slot clicks with `detail > 0` are TT.Input's; keyboard activation selects.
Restart / Play again start a **new random seed** by default, keeping the run's mode and block set. The
"Same seed (SEED)" checkbox beside each of them (unticked by default) replays the current seed instead; both
boxes are bound to the saved setting `settings.restartSameSeed` (`data-setting="restartSameSeed"`; settings
saved before it existed load as `false`). Restart mid-run (turn > 0) needs a second press (`data-confirm`).
Layout: portrait ⇒ tray at the bottom; aspect ≥ 1 ⇒ sidebar on the right. Safe-area insets respected.
`TT.App` = `{ settings, game, renderer, audio, input, ui, startGame(opts), restart(opts), quitToMenu(),
loadSettings(), lockPortrait(), ... }`; `restart({ sameSeed })`: `sameSeed` (boolean) overrides the
setting, otherwise the setting decides.
Portrait lock: at boot, whenever a game starts and when the page becomes visible again, `lockPortrait()`
calls `screen.orientation.lock('portrait-primary')` (rejection swallowed) if the page runs as an
installed app (`display-mode` standalone, fullscreen or minimal-ui) on a touch device (`maxTouchPoints`
or `any-pointer: coarse`); anywhere else (desktop, browser tab, file://) it does nothing. The manifest's
`orientation: portrait-primary` does the same for the installed app.
Main loop: rAF, `game.update(dt)`, `input.update(dt)`, `ui.update(dt)`, then `renderer.render(dt)`; when
nothing is awake/animating and no input (nor a queued drop) for 2 s, render at `IDLE_FPS`; pause
automatically on `visibilitychange`.
Storage (all wrapped in try/catch): `tetrowers.settings`, `tetrowers.best` (`{"SEED|rules": {height, time, date}}`),
`tetrowers.seen` (type keys already introduced, and `#drag` once the drag tip was shown). `?debug=1` shows
FPS / bodies / awake / step ms.

### Packaging
`manifest.webmanifest` (relative `start_url: "./"`, `scope: "./"`, display standalone, icons 192/512 +
maskable), `sw.js` (cache-first precache of every file, registered only on http(s)). **`sw.js` has its
own `VERSION` constant, which names its cache and must always equal `CONFIG.VERSION` in js/config.js:
bump both for every release.** Browsers only install a new worker when the bytes of `sw.js` change, so
a release that bumps only config.js never reaches installed copies; `tests/foundation.test.js` fails
when the two differ. `.nojekyll`, `tools/serve.js` (static server on 0.0.0.0 for LAN phone testing, prints URLs),
`Play TeTrowers.bat` (opens the game in an Edge/Chrome app window on Windows), `tools/sim.js`
(headless balancing runs), README with how to play / run / deploy.

---------------------------------------------------------------------------------------------------

## 8. Testing hooks
* `node tests/run.js` runs every `tests/*.test.js` (plain `node:assert`; no frameworks).
* In the browser, `window.TT.App` exposes the live app; `TT.App.game` the current game. Automated tests
  drive it through the public game methods and keyboard events.

## 9. Performance rules
* Physics: 120 Hz substeps, 20/10 iterations (measured: 60 Hz/10 iterations collapses tall stacks).
  Only `physics.movers` are iterated per frame; static geometry is cached; petrify keeps movers few.
* Surface/candidates are rebuilt only when `physics.version` changes or movers moved (≤ 10 Hz while
  things are awake), never per frame by default.
* Renderer: chunk-cache static blocks, cull, pre-render cell sprites per (look, tint, scale), cap DPR at
  2, idle throttle. No per-frame allocations in hot loops where avoidable (reuse arrays).
