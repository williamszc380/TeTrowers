#!/usr/bin/env node
/* TeTrowers launcher behind ./run, run.cmd and `npm start`.
 * Starts tools/serve.js, waits for its URL and opens the game in an app-style
 * Chrome/Edge window (or the default browser). Ctrl+C stops the server.
 *
 *   ./run [port] [--no-open] [--browser]
 *     port        first port to try (default 8080; serve.js moves on if it is busy)
 *     --no-open   only start the server
 *     --browser   open a normal browser tab instead of an app window
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const noOpen = argv.includes('--no-open');
const asTab = argv.includes('--browser');
const port = argv.find((a) => /^\d+$/.test(a));
const serveJs = path.join(__dirname, 'serve.js');

function openUrl(url) {
  const detached = { detached: true, stdio: 'ignore' };
  if (process.platform === 'win32') {
    const env = process.env;
    const candidates = [
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
      env.ProgramFiles && path.join(env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'),
      env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Google/Chrome/Application/chrome.exe'),
      env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe'),
      env.ProgramFiles && path.join(env.ProgramFiles, 'Microsoft/Edge/Application/msedge.exe')
    ];
    const exe = !asTab && candidates.find((p) => p && fs.existsSync(p));
    if (exe) spawn(exe, ['--app=' + url, '--window-size=1280,800'], detached).unref();
    else spawn('cmd', ['/c', 'start', '', url], detached).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [url], detached).unref();
  } else {
    spawn('xdg-open', [url], detached).unref();
  }
  console.log('Opened ' + url);
}

if (!fs.existsSync(serveJs)) {
  // No server available: the game also runs straight from the file system
  const file = 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/').replace(/ /g, '%20');
  console.log('tools/serve.js not found - opening index.html directly.');
  if (!noOpen) openUrl(file);
  process.exit(0);
}

const server = spawn(process.execPath, [serveJs].concat(port ? [port] : []), { cwd: ROOT, stdio: ['inherit', 'pipe', 'inherit'] });
let opened = noOpen;
const fallback = setTimeout(() => {
  if (!opened) { opened = true; openUrl('http://localhost:' + (port || 8080) + '/'); }
}, 4000);
server.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  if (opened) return;
  const m = String(chunk).match(/http:\/\/(?:localhost|127\.0\.0\.1):(\d+)/);
  if (m) {
    opened = true;
    clearTimeout(fallback);
    openUrl('http://localhost:' + m[1] + '/');
  }
});
server.on('exit', (code) => { clearTimeout(fallback); process.exit(code || 0); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.kill(); process.exit(0); });
