---
name: run-tetrowers
description: Launch, play and verify TeTrowers, the browser game in this repo. Use for /run, ./run, "start / play / open the game", taking screenshots, or checking that a change works in the real game. Starts the local server and opens the game window, or drives the game headlessly with tools/smoke.js.
---

# Running TeTrowers

TeTrowers is a static browser game: no build step, no runtime dependencies. Run everything
from the repository root.

## Launch it for the user to play

1. Start the launcher **in the background** (it keeps a server running):
   `node tools/run.js` — the same thing `./run` (Git Bash / PowerShell), `run` (cmd) and `npm start` do.
   It starts `tools/serve.js` on port 8080 (or the next free port), prints the localhost URL and the
   LAN URLs, and opens the game in a Chrome/Edge app window.
   Options: a port number, `--no-open` (server only), `--browser` (normal tab instead of an app window).
2. Tell the user the `http://localhost:PORT/` URL and the LAN URL(s) — a phone on the same Wi-Fi can
   open the LAN URL to play on Android.
3. Leave it running while they play; stop the background task when they are done or ask.

Without Node the game still runs: open `index.html` directly (file:// is supported) or double-click
`Play TeTrowers.bat`.

## Verify a change in the real game (headless)

1. Once per clone: `npm install` (dev-only dependency `puppeteer-core`; it drives the installed Chrome
   or Edge, override with `CHROME_PATH`).
2. `node tools/smoke.js` — opens the game in a phone-portrait (412x860) and a desktop (1280x720)
   viewport, plays about 12 drops with real key presses, saves screenshots to `tools/out/`, and prints
   the game state plus any console errors. Exit code 1 means errors or the game did not run.
   Options: `--url http://localhost:8080/`, `--drops 20`, `--seed ABC`, `--only portrait|landscape`, `--headed`.
3. Look at the screenshots in `tools/out/` (Read tool) before claiming anything about the visuals.

Driving it yourself in page context: `TT.App.startGame({ seed: 'ABC' })`; `TT.App.game` exposes
`state, turn, round, lives, height, bestHeight, mode, batch, piece, physics`. Keys: ArrowLeft/ArrowRight
move, ArrowUp switch block, ArrowDown or Space drop, Control placement mode, Escape pause.
`?debug=1` in the URL shows FPS and physics stats.

## Other checks

- Unit tests (Node, no browser): `node tests/run.js`
- Balancing / performance (bot plays full games): `node tools/sim.js --runs 8`
