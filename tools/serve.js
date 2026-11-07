#!/usr/bin/env node
/* TeTrowers — tiny static file server for local and LAN testing (no dependencies).
 * Serves the project folder on every network interface, so a phone on the same Wi-Fi
 * can open the game too.
 *
 *   node tools/serve.js [port] [--open]
 *
 * Default port 8080; if it is busy the next free one is used. --open launches the default
 * browser at the localhost URL once the server is listening. Responses are sent with
 * Cache-Control: no-cache so edits show up on a normal reload. Only files inside the
 * project are served (no directory listings, no dotfiles such as .git).
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = fs.realpathSync(path.resolve(__dirname, '..'));
const args = process.argv.slice(2);
const OPEN = args.includes('--open');
const portArg = args.find((a) => /^\d+$/.test(a));
const START_PORT = portArg ? Number(portArg) : 8080;
const MAX_TRIES = 20;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2'
};

const caseFold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
function insideRoot(p) {
  const a = caseFold(p), r = caseFold(ROOT);
  return a === r || a.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

function send(res, status, text, headers) {
  const body = Buffer.from(text + '\n', 'utf8');
  res.writeHead(status, Object.assign({
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache'
  }, headers));
  res.end(res.req.method === 'HEAD' ? undefined : body);
  return status;
}

// Map a URL path to a file inside ROOT, or return an HTTP status explaining why not
function resolve(urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch (err) {
    return { status: 400 };
  }
  if (rel.includes('\0') || rel.includes(':')) return { status: 400 };   // NUL, drive letters, NTFS streams
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if (parts.some((p) => p.startsWith('.'))) return { status: 403 };      // '..' and dotfiles such as .git
  const file = path.resolve(ROOT, ...parts);
  if (!insideRoot(file)) return { status: 403 };
  return { file };
}

function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (err) {
    return send(res, 400, 'Bad request');
  }
  const r = resolve(url.pathname);
  if (!r.file) return send(res, r.status, r.status === 403 ? 'Forbidden' : 'Bad request');

  let real, stat;
  try {
    real = fs.realpathSync(r.file);          // symlinks / junctions must not lead outside
    if (!insideRoot(real)) return send(res, 403, 'Forbidden');
    stat = fs.statSync(real);
    if (stat.isDirectory()) {
      if (!url.pathname.endsWith('/')) {     // relative links need the trailing slash
        res.writeHead(301, { Location: url.pathname + '/' + url.search, 'Cache-Control': 'no-cache' });
        res.end();
        return 301;
      }
      real = path.join(real, 'index.html');
      stat = fs.statSync(real);
    }
    if (!stat.isFile()) return send(res, 404, 'Not found');
  } catch (err) {
    return send(res, 404, 'Not found');
  }

  res.writeHead(200, {
    'Content-Type': MIME[path.extname(real).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  });
  if (req.method === 'HEAD') { res.end(); return 200; }
  const stream = fs.createReadStream(real);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
  return 200;
}

function log(req, status) {
  const t = new Date().toTimeString().slice(0, 8);
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  console.log(t + '  ' + status + '  ' + req.method + ' ' + req.url + '  ' + ip);
}

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const a of ifaces[name] || []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (v4 && !a.internal && !a.address.startsWith('169.254.')) out.push({ name, address: a.address });
    }
  }
  return out;
}

function openBrowser(url) {
  try {
    const child = process.platform === 'win32'
      ? spawn('cmd.exe', ['/c', 'start', '""', url], { windowsVerbatimArguments: true, stdio: 'ignore', detached: true, windowsHide: true })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch (err) { /* the URL is printed; open it by hand */ }
}

function start(port, triesLeft) {
  const server = http.createServer((req, res) => {
    let status;
    try {
      status = handle(req, res);
    } catch (err) {
      status = res.headersSent ? 500 : send(res, 500, 'Server error');
    }
    log(req, status);
  });
  server.once('error', (err) => {
    if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && triesLeft > 0) {
      console.log('Port ' + port + ' is busy, trying ' + (port + 1) + '...');
      start(port + 1, triesLeft - 1);
      return;
    }
    console.error('Could not start the server: ' + err.message);
    process.exit(1);
  });
  server.listen(port, '0.0.0.0', () => {
    const local = 'http://localhost:' + port + '/';
    console.log('');
    console.log('  TeTrowers is being served from ' + ROOT);
    console.log('');
    console.log('  On this computer:   ' + local);
    const lan = lanAddresses();
    for (const a of lan) console.log('  On your network:    http://' + a.address + ':' + port + '/   (' + a.name + ')');
    if (lan.length) {
      console.log('');
      console.log('  Phone: join the same Wi-Fi and open the network address in Chrome.');
      console.log('  If it does not load, allow Node.js through the Windows Firewall (private networks).');
    }
    console.log('');
    console.log('  Press Ctrl+C to stop.');
    console.log('');
    if (OPEN) openBrowser(local);
    process.once('SIGINT', () => { console.log('Stopped.'); server.close(); process.exit(0); });
  });
}

start(START_PORT, MAX_TRIES);
