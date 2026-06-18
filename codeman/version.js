// Single source of truth for the app version.
// Loaded as a classic script in index.html (sets window.CODEMAN_VERSION) AND via
// importScripts() in sw.js (sets the worker-scope global). `self` resolves to the
// right global in both contexts. The footer (src/init.js) and the service-worker
// cache name (sw.js) both read this — bump it once per release.
self.CODEMAN_VERSION = '1.4.1';
