/* ---------- CodeMan SERVICE WORKER ----------

   Lets CodeMan BOOT with the NAS unreachable. The browser can't fetch the app
   shell (index.html / src/*.js / style.css / vendor/prism) when you're away from
   home, so this worker caches it and serves it offline. Data persistence is a
   separate layer (see src/offline.js — IndexedDB mirror + write-queue); the SW
   only handles the *code*, not the JSON.

   Strategy = NETWORK-FIRST with a cache fallback for same-origin static assets:
     - Online: always fetch fresh and refresh the cache. This preserves the app's
       `?v=Date.now()` cache-bust intent (edits are NEVER served stale on the LAN).
     - Offline: fetch throws → serve the cached copy (matched IGNORING the `?v`
       query), and fall back to the cached index.html for navigations.
   `api.php` is deliberately NOT intercepted: online it hits the NAS, offline the
   request fails and the app's own offline layer takes over (cache reads + queued
   writes). Bump CACHE_VERSION on each release to evict the old shell. */

const CACHE_VERSION = 'codeman-v3.1.0';

// Precached on install so the very first offline boot works even if a given
// asset was never re-requested online. Grammars autoloaded by Prism on demand
// get runtime-cached as you browse (cache.put in the fetch handler).
const SHELL = [
  './',
  'index.html',
  'style.css',
  'favicon.svg',
  'manifest.webmanifest',
  'src/core.js',
  'src/tree.js',
  'src/editor.js',
  'src/features.js',
  'src/ui.js',
  'src/offline.js',
  'src/init.js',
  'vendor/prism/themes/prism-tomorrow.min.css',
  'vendor/prism/components/prism-core.min.js',
  'vendor/prism/plugins/autoloader/prism-autoloader.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // allSettled: one missing asset must not abort the whole precache. `reload`
    // bypasses the HTTP cache so we store the freshest copy at install time.
    await Promise.allSettled(SHELL.map((u) => cache.add(new Request(u, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Normalize our own versioned assets to a stable cache key so the `?v=<ts>`
// loader doesn't pile up a new cached copy of every module on each page load.
function cacheKey(url, req) {
  if (/\.(?:js|css)$/.test(url.pathname)) return url.origin + url.pathname;
  return req;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                 // never touch writes
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // leave cross-origin alone
  if (url.pathname.endsWith('/api.php')) return;     // data: handled by offline.js

  e.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    try {
      const res = await fetch(req);
      // Cache successful same-origin responses for offline use.
      if (res && res.ok && res.type === 'basic') cache.put(cacheKey(url, req), res.clone());
      return res;
    } catch (err) {
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const shell = (await cache.match('index.html', { ignoreSearch: true }))
          || (await cache.match('./', { ignoreSearch: true }));
        if (shell) return shell;
      }
      throw err;
    }
  })());
});

// Lets the page trigger an immediate activation after an update.
self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });
