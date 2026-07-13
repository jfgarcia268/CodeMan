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

// Ask the browser to make our storage persistent (not evictable under storage
// pressure) — the offline IndexedDB mirror + write-queue + dead-letters must survive.
// Best-effort: unsupported browsers no-op, and it's granted heuristically (no prompt
// in practice). Especially important for the offline-only desktop wrapper, where
// IndexedDB is the ONLY copy of the library.
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

// Offline-only desktop nudge: with no server configured, this machine's IndexedDB is
// the ONLY copy of the library, so nudge an occasional backup (Export all). Web /
// server-backed users never see this — the server is their backup. Never modal; a
// dismissable toast, and "Don't remind me" silences it for good. Fires at most once
// per 14 days; the first launch just seeds the clock (no nag on an empty new library).
(function exportNudge() {
  try {
    if (typeof window.CODEMAN_SERVER_URL !== 'string' || window.CODEMAN_SERVER_URL !== '') return;
    if (localStorage.getItem('codeman.exportNudgeOff') === '1') return;
    const now = Date.now(), DAY = 86400000;
    const last = parseInt(localStorage.getItem('codeman.exportNudgeAt') || '0', 10) || 0;
    if (last && now - last < 14 * DAY) return;
    localStorage.setItem('codeman.exportNudgeAt', String(now)); // (re)start the clock
    if (!last) return;                                          // first run: seed only
    setTimeout(() => {
      const box = document.createElement('div'); box.className = 'nudge-toast';
      const msg = document.createElement('span'); msg.textContent = 'Back up your library — ';
      const act = document.createElement('button'); act.className = 'nudge-act'; act.textContent = 'Export all pages';
      act.onclick = () => { box.remove(); if (typeof exportAll === 'function') exportAll(); };
      // Two DISTINCT dismissals, so the permanent one can't be silenced by reflex:
      // "Don't remind me" is a labelled secondary text button (deliberate, sets the
      // permanent flag); the "✕" is a lightweight iconic close (this time only).
      const off = document.createElement('button'); off.className = 'nudge-off'; off.textContent = "Don't remind me";
      off.title = 'Stop showing this backup reminder';
      off.onclick = () => { box.remove(); try { localStorage.setItem('codeman.exportNudgeOff', '1'); } catch (e) {} };
      const x = document.createElement('button'); x.className = 'nudge-dismiss'; x.textContent = '✕'; x.title = 'Dismiss for now';
      x.setAttribute('aria-label', 'Dismiss for now');
      x.onclick = () => box.remove();
      box.append(msg, act, off, x);
      document.body.appendChild(box);
    }, 4000);
  } catch (e) {}
})();

(async () => {
  await loadTree();
  renderPage();
  await restoreOpenTabs();
})();
