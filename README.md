# TeTrowers

Build the tallest tower you can by dropping tetromino blocks from the sky onto a small platform.
Real 2D physics, blocks that are never rotated, and special blocks that help or hurt. The good
ones get rarer and the bad ones more common the higher you build, so every run ends sooner or
later. Each loss comes from your own decisions, plus a little bad luck.

**Play online: <https://williamszc380.github.io/TeTrowers/>**

It runs in desktop browsers and in Chrome on Android, works offline once installed, and needs
no downloads, accounts or build step.

---

## Contents

- [How to play](#how-to-play)
- [Controls](#controls)
- [Placement modes](#placement-modes)
- [Rules](#rules)
- [Special blocks](#special-blocks)
- [Seeds and comparing scores](#seeds-and-comparing-scores)
- [Running it](#running-it)
- [Publishing on GitHub Pages](#publishing-on-github-pages)
- [Releasing an update](#releasing-an-update)
- [Tuning and developer tools](#tuning-and-developer-tools)
- [Project structure](#project-structure)
- [Credits](#credits)

---

## How to play

1. Each round deals you **3 blocks**. They are shown at the bottom on portrait screens and on the
   right on wide screens. Place them in any order.
2. Move the hovering block left and right, then drop it. It falls onto the 6-wide platform (or onto
   your tower) and the physics takes over. Blocks are **never rotated**, and all 19 tetromino
   orientations are equally likely.
3. Your score is the **best height** your tower reaches. You have 3 lives. When the last one is gone
   the run is over.

**Cold** colours (white, green, blue, indigo) are good blocks. **Warm** colours (red, orange,
amber, black) are bad blocks. The first time a new special block appears, a short note explains
it. All of them are listed under *How to Play → Block codex* in the game.

The **Good** and **Bad** figures on screen are the current odds that a block you are dealt is a
good or a bad special block. Tap them (or press <kbd>O</kbd>) to see the odds of every block and
which block unlocks next.

## Controls

| Action | Keyboard | Touch |
|---|---|---|
| Move the block | <kbd>←</kbd> <kbd>→</kbd> (hold to repeat) | Drag anywhere on the playfield |
| Switch block | <kbd>↑</kbd>, or <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> to pick a slot | Tap a block in the tray |
| Drop | <kbd>↓</kbd> or <kbd>Space</kbd> | **Drop** button, or a quick swipe down |
| Placement mode | <kbd>Ctrl</kbd> (cycles assisted → fixed → manual) | Mode button |
| Pause | <kbd>Esc</kbd> or <kbd>P</kbd> | Pause button |
| Block odds | <kbd>O</kbd> | Tap the Good / Bad odds |
| Sound on/off | <kbd>M</kbd> | Settings |

The ring around the Drop button shows when the next drop is ready. You can line up the next block
while you wait. Opening the block odds during play pauses the game until you close the panel.

## Placement modes

| Mode | How it moves |
|---|---|
| **Assisted** (default) | Steps between the spots where the block will sit flush with the block it lands on, even when the tower has drifted a little. Over empty space, the bare platform or a steeply tilted block it uses half-block steps. While falling, the block follows its target, so a support that shifts slightly can't make it clip a corner and miss. |
| **Fixed** | Half-block steps. No help while falling. |
| **Manual** | Pixel-precise. A key tap moves one pixel, holding slides faster and faster, and dragging is 1:1. No help while falling. |

The starting mode can be set in *Settings*.

## Rules

- **Batches.** 3 blocks per round. The next round is dealt once all three are down and the drop is
  ready again.
- **Dropping.** The next drop is allowed once the previous block has settled, 1.2 s after it first
  touched something, or once it is gone. The longest wait is 4 s and the shortest 0.3 s.
- **Turns and lives.** A turn runs from one drop to the next. The first block that falls off the
  tower during a turn costs a life (or uses up your shield); further losses in the same turn are
  free. Blocks that are swallowed, blown up, melted or destroyed by spikes don't cost lives. You
  have 3 lives at most.
- **Milestones.** Every time your best height passes a multiple of **8 m**, you get a life back
  (up to 3). A dashed line on the playfield marks the next milestone.
- **Height.** The current height is the top of your highest settled block. The best height (your
  score) only counts blocks that have stayed settled for a moment.
- **The higher, the meaner.** Each block is normal, good or bad. Bad blocks start at 5% and rise
  by 0.9% per metre, up to 70%. Good blocks start at 22% and fall by 0.35% per metre, down to 4%.
  Within its kind each special block has its own weight, and some only start to appear above a
  certain height (see the table below).
- **Odds on screen.** The HUD always shows the current odds of a good and of a bad block at your
  best height. *Block odds* (tap the odds, press <kbd>O</kbd>, or use the button in the pause
  menu) breaks them down per block, with the normal-block share and the next block to unlock.
  These are exactly the odds the next deal uses, including your choice of enabled blocks.
- **Petrify.** Blocks that sit more than 10 m below the top of the tower for 2 s turn to stone
  (drawn slightly faded) and never move again. The base of a tall tower becomes solid ground,
  which keeps long runs fair and fast.

## Special blocks

| Block | Kind | Appears from | What it does |
|---|---|---|---|
| Steel | good (white) | start | Locks in place once it settles. Nothing can move it. |
| Vine | good (green) | start | When it settles it grabs every block it touches and holds them together. |
| Crystal Heart | good (blue) | 4 m | Settle it safely to restore a life. At full lives it gives a shield instead. |
| Magnet | good (indigo) | 6 m | When it settles it pulls nearby blocks straight and snaps them onto its grid. |
| Frost | good (ice blue) | 8 m | When it settles it freezes itself and every block it touches solid. |
| Pebble | bad (rust red) | start | Just one tiny cell. |
| Crumble | bad (orange) | start | Falls apart into single cells the moment it lands. |
| Rubber | bad (amber) | 3 m | Bouncy. It bounces when it lands, and so does anything dropped on it. |
| Oil Slick | bad (black) | 6 m | Frictionless. It slides, and anything on it slides too. |
| Ruby Glass | bad (ruby red) | 8 m | Looks solid, but shatters into loose cells the first time a block lands on it. |
| Mine | bad (red) | 10 m | Arms when it settles. Explodes when a block lands on top of it. |
| Magma | bad (orange) | 15 m | Melts away 3 drops after it settles. Do not lean on it. |
| Spikes | bad (dark crimson) | 18 m | Its top is spiked: any block that lands on it is destroyed. Build beside it, never on it. |
| Anvil | bad (black) | 20 m | Very heavy. Shatters the blocks it lands on into single cells. |
| Black Hole | bad (black) | 25 m | Swallows any block that touches its sides. Build on top, never beside. |

Plain grey **Stone** blocks are the normal ones. **Rubble** is the loose single cells left behind
when a block shatters. A shield (from a Crystal Heart at full lives) absorbs the next life you
would lose. A block destroyed by spikes is gone but costs no life.

**Choosing the block set.** *Special Blocks* in the main menu turns each special block on or off
(all are on by default, with *All on* / *All off* shortcuts). If a disabled block would have been
dealt, another enabled block of the same kind is picked instead, or a normal block if none is left.
The odds on screen take this into account.

## Seeds and comparing scores

Every run has a seed. The same seed with the same block set deals the same blocks at the same
heights, so you and your friends can compete fairly.

- **Play**: a new random 6-character seed.
- **Daily Challenge**: one seed per calendar day, the same for everyone.
- **Enter Seed**: any text up to 32 characters (case and extra spaces don't matter).
- **Links**: `https://williamszc380.github.io/TeTrowers/?seed=K7QP2M` opens the game with that seed
  ready to play. *Copy result* on the game-over screen copies your height, time and such a link.

Turning special blocks off changes the deal, so it counts as different rules. The game-over screen
lists the seed together with any blocks that were off, and best heights are saved separately for
each seed and block set. Only compare scores that have the same seed **and** the same set. Best
heights and settings are stored in your browser on that device.

## Running it

The game is a static web page with no dependencies, so it runs straight from this folder.
[Node.js](https://nodejs.org) (18 or newer, LTS recommended) is only needed for the local server
and the developer tools. Run every command from the project folder.

### Start the game

| How | What happens |
|---|---|
| Double-click **`Play TeTrowers.bat`** (Windows) | Opens the game in an app-style window in Microsoft Edge or Google Chrome, or in your default browser if neither is installed. No server and no Node.js needed. Double-clicking `index.html` works too. |
| Double-click **`Start Server.bat`** (Windows) | Starts the local server on port 8080 (or the next free port), opens the game in your default browser and prints your network addresses. Close the window to stop it. |
| `./run` in Git Bash or PowerShell, `run` in cmd | Starts the same server and opens the game in a Chrome or Edge app window. Add a port number, `--no-open` (server only) or `--browser` (a normal tab instead of an app window). <kbd>Ctrl</kbd>+<kbd>C</kbd> stops it. Without Node.js it opens `index.html` instead. `./run` also works in a macOS or Linux shell. |
| `npm start` | The same as `./run`. |
| `/run` in [Claude Code](https://claude.com/claude-code) | Claude starts the server and opens the game for you, following the project skill in `.claude/skills/run-tetrowers` (you can also call it as `/run-tetrowers`). Ask it to check a change and it plays the game headlessly and looks at screenshots. |

Everything works offline from the folder, but installing as an app and the offline cache need the
server (or the online version).

### Phones and installing as an app

The server prints the addresses it can be reached at, for example:

```
  On this computer:   http://localhost:8080/
  On your network:    http://192.168.1.23:8080/   (Wi-Fi)
```

- **Android phone on the same Wi-Fi:** open the network address in Chrome. If it doesn't load,
  allow Node.js through the Windows Firewall for private networks (Windows asks the first time).
  Browsers only allow app install and offline mode over `https` or `localhost`, so use the
  GitHub Pages address to install it on the phone.
- **Install on the PC:** with the game open at `http://localhost:8080/` in Edge or Chrome, use the
  install icon in the address bar (or the browser menu → *Apps* / *Install TeTrowers*). The
  installed app keeps working when the server is stopped.
- **Another port:** `"Start Server.bat" 3000`, `./run 3000` or `node tools/serve.js 3000`.

### Tests and tools

| Command | What it does |
|---|---|
| `npm test` | Unit tests for the game logic (`node tests/run.js`). No browser needed. |
| `npm run smoke` | Browser smoke test (`node tools/smoke.js`). It plays a few drops with real key presses in a phone-sized and a desktop-sized window, saves screenshots to `tools/out/`, and fails if the page logs an error. Run `npm install` once first: it installs the dev-only `puppeteer-core`, which drives your installed Chrome or Edge (or set `CHROME_PATH`). |
| `npm run sim` | Headless balancing runs with a bot (`node tools/sim.js`). Pass options after `--`, for example `npm run sim -- --runs 8`. |
| `npm run serve` | Only the local server (`node tools/serve.js`), without opening a browser. |
| `npm run icons` | Redraws the app icons in `icons/` (`node tools/make-icons.js`). |

## Publishing on GitHub Pages

1. Create a repository named **`TeTrowers`** on the `williamszc380` GitHub account and push this
   folder to its `main` branch (`index.html` must be at the top level).
2. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, then pick
   branch **`main`** and folder **`/ (root)`** and press **Save**.
3. After a minute or two the game is live at **<https://williamszc380.github.io/TeTrowers/>**.

There is nothing to build. The empty `.nojekyll` file makes Pages serve every file as-is, and
`node_modules/` (developer tooling only) is git-ignored. Every path in the game is relative, so it
works from the `/TeTrowers/` subpath as well as from `file://`.

**On Android:** open the address in Chrome, then use the menu (⋮) → **Add to Home screen** /
**Install app**. TeTrowers then starts full-screen from its own icon and plays offline.

## Releasing an update

Installed copies serve the game from their offline cache, so they only update when the
**version** changes. For every release:

1. Bump `VERSION` in **`js/config.js`** *and* in **`sw.js`** to the same new value (for example
   `1.0.1`; the offline cache is named `tetrowers-<version>`).
2. Commit and push to `main`.

The next time an installed copy is opened online, it downloads the new files in the background.
The new version is used from the following launch (or after a reload). If you forget to bump
`sw.js`, phones keep the old version.

When the game is served from `localhost` or a private network address, the service worker fetches
fresh files first and only falls back to its cache offline, so local edits show up on a normal
reload. On GitHub Pages it serves from its cache first, which makes start-up fast and works offline.

## Tuning and developer tools

- **Gameplay numbers** (physics, drop timing, placement modes, lives and milestones, the good/bad
  odds by height, special block strengths) all live in **`js/config.js`**. Block colours, physics
  materials, weights within their kind, and the heights they appear from are in
  **`js/blocktypes.js`**. The odds shown in the game are computed from the same numbers
  (`typeOdds` in `js/generator.js`), so they always match what is dealt.
- **Balancing:** `npm run sim -- --runs 8` (or `node tools/sim.js --runs 8`) plays complete runs
  headlessly with a heuristic bot (real physics, real rules) and reports how long they last.
  `--set KEY=VALUE,...` tries config overrides without editing files. See the top of
  `tools/sim.js` for all options.
- **Debug overlay:** add `?debug=1` to the URL to see FPS, block counts and frame timings.
- **Module contracts:** `docs/ARCHITECTURE.md` describes how the modules fit together.

## Project structure

```
index.html              page: screens, HUD and batch tray
css/style.css           layout (portrait: tray at the bottom, wide: sidebar on the right) and theme
js/lib/planck.min.js    planck.js 1.5.0 physics engine (MIT, see js/lib/LICENSE.txt)
js/config.js            every tunable number, and VERSION
js/util.js, rng.js      helpers; seeded randomness
js/shapes.js            the 19 tetromino orientations and the 1x1 pebble
js/blocktypes.js        block catalogue: names, rules text, colours, physics, unlock heights
js/generator.js         seeded block generator and odds by height
js/physics.js           physics world, platform, blocks, exact geometry
js/effects.js           what the special blocks do
js/placement.js         landing prediction, snapping, assisted mode
js/game.js              game rules: turns, lives, height, milestones, batches
js/particles.js         particle effects
js/render.js            canvas renderer
js/audio.js             synthesised sound effects (WebAudio, no audio files) and vibration
js/input.js             keyboard, mouse and touch
js/ui.js, main.js       menus and HUD; app start-up and main loop
sw.js                   service worker (offline cache)
manifest.webmanifest    app manifest (name, colours, icons)
icons/                  app icons (generated by tools/make-icons.js)
tools/serve.js          static server for local and LAN testing
tools/run.js            launcher behind ./run, run.cmd and npm start
tools/sim.js            headless balancing simulator
tools/smoke.js          headless browser smoke test
tools/make-icons.js     icon generator
tests/                  unit tests (npm test)
docs/ARCHITECTURE.md    module contracts for developers
run, run.cmd            launchers: ./run (Git Bash, PowerShell, macOS/Linux) and run (cmd)
package.json            npm scripts (start, test, smoke, sim, serve, icons); dev-only puppeteer-core
Play TeTrowers.bat      Windows: play in an app window, no server
Start Server.bat        Windows: start the local server and open the game
.claude/skills/         Claude Code project skill (run-tetrowers) behind /run
```

## Credits

- Physics: [planck.js](https://github.com/piqnt/planck.js) by Erin Catto and Ali Shakiba, a
  JavaScript port of Box2D, used under the MIT License (`js/lib/LICENSE.txt`).
- All sounds are synthesised live in the browser and the icons are drawn by
  `tools/make-icons.js`. There are no third-party assets.
