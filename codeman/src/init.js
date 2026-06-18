/* ---------- INIT ---------- */

// Footer version label — sourced from version.js (the single version source of
// truth, also read by sw.js for the cache name). Guarded for load-order safety.
(function showVersion() {
  const el = document.getElementById('appVersion');
  if (el && self.CODEMAN_VERSION) el.textContent = 'v' + self.CODEMAN_VERSION;
  // Desktop wrapper only: surface which server (or offline-only) is active — answers
  // "which library am I looking at?" now that the offline cache is namespaced per
  // server. window.CODEMAN_SERVER_URL is injected by the Electron preload; in a plain
  // browser it's undefined, so this stays hidden (no markup change for web users).
  if (el && typeof window.CODEMAN_SERVER_URL === 'string') {
    let host = 'Offline-only';
    try { if (window.CODEMAN_SERVER_URL.trim()) host = new URL(window.CODEMAN_SERVER_URL).host; } catch (e) { host = window.CODEMAN_SERVER_URL; }
    el.textContent += ' · ' + host;
    el.title = window.CODEMAN_SERVER_URL.trim() ? ('Connected to ' + window.CODEMAN_SERVER_URL) : 'Offline-only (this Mac)';
  }
})();

// Register the Service Worker so the app can BOOT offline (it caches the shell;
// data still flows through the IndexedDB layer in offline.js). Scope = codeman/.
// Wrapped so a SW failure never blocks the app on browsers that lack support.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
  });
}

(async () => {
  await loadTree();
  renderPage();
  await restoreOpenTabs();
})();
