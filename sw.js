/* TeTrowers — service worker: offline play and app install.
 * Precaches every file the game needs into a cache named after VERSION, then serves
 * same-origin GETs cache-first (network fallback; anything fetched is cached too) and
 * deletes this app's older caches on activate. Bump VERSION together with CONFIG.VERSION
 * in js/config.js for every release: the changed bytes make browsers install this worker
 * again, which downloads the new files. On localhost / private-network dev servers it is
 * network-first instead, so edits show on a normal reload while offline still works.
 * Every URL is relative to this file, so it works from the GitHub Pages subpath.
 */
'use strict';

const VERSION = '1.2.0';            // keep in sync with CONFIG.VERSION (js/config.js)
const CACHE_PREFIX = 'tetrowers-';
const CACHE = CACHE_PREFIX + VERSION;

// Required to start offline (script order as in index.html). Install fails if one is missing.
const CORE = [
  './',
  'index.html',
  'css/style.css',
  'js/lib/planck.min.js',
  'js/config.js', 'js/util.js', 'js/rng.js', 'js/shapes.js', 'js/blocktypes.js', 'js/generator.js',
  'js/physics.js', 'js/effects.js', 'js/placement.js', 'js/game.js',
  'js/particles.js', 'js/render.js', 'js/audio.js', 'js/input.js', 'js/ui.js', 'js/main.js'
];
// Nice to have offline; a missing one never blocks installation
const EXTRA = [
  'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png', 'icons/favicon-32.png'
];

const DEV_HOST = /^(localhost|127(\.\d+){3}|\[::1\]|10(\.\d+){3}|192\.168(\.\d+){2}|172\.(1[6-9]|2\d|3[01])(\.\d+){2})$|\.local$/;
const NETWORK_FIRST = DEV_HOST.test(self.location.hostname);

// cache: 'reload' bypasses the HTTP cache so a new version never precaches stale files
const fresh = (url) => new Request(url, { cache: 'reload' });

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(CORE.map(fresh));
    await Promise.all(EXTRA.map((url) => cache.add(fresh(url)).catch(() => {})));
    await Promise.all((await referencedByPage(cache)).map((url) => cache.add(fresh(url)).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Only this app's caches: every project on <user>.github.io shares one origin's CacheStorage
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(NETWORK_FIRST ? networkFirst(req) : cacheFirst(req));
});

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  // ignoreSearch: '?seed=ABC' links and '?v=' cache-busters still hit the precached files
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  try {
    return store(cache, req, await fetch(req));
  } catch (err) {
    return offline(cache, req);
  }
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    return store(cache, req, await fetch(req));
  } catch (err) {
    return (await cache.match(req, { ignoreSearch: true })) || offline(cache, req);
  }
}

function store(cache, req, res) {
  if (res.status === 200 && res.type === 'basic' && !res.redirected) cache.put(req, res.clone()).catch(() => {});
  return res;
}

async function offline(cache, req) {
  if (req.mode === 'navigate') {
    const page = await cache.match('index.html');
    if (page) return page;
  }
  return Response.error();
}

// Safety net: also precache any relative src/href in index.html that the lists above miss
async function referencedByPage(cache) {
  try {
    const res = await cache.match('index.html');
    if (!res) return [];
    const html = await res.text();
    const known = new Set(CORE.concat(EXTRA));
    const found = new Set();
    const re = /\s(?:src|href)\s*=\s*["']([^"'#?]+)/gi;
    let m;
    while ((m = re.exec(html))) {
      const url = m[1].trim().replace(/^\.\//, '');
      if (!url || /^([a-z][a-z0-9+.-]*:|\/)/i.test(url) || known.has(url)) continue;
      found.add(url);
    }
    return Array.from(found);
  } catch (err) {
    return [];
  }
}
