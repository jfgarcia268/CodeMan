/* ---------- INIT ---------- */

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
