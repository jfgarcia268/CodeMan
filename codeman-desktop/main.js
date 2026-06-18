// CodeMan desktop wrapper (Electron).
//
// Runs a tiny localhost HTTP server inside the app that (a) serves the bundled
// CodeMan shell and (b) proxies /api.php to your CONFIGURED server. The renderer
// loads http://127.0.0.1:<port>/ — a real, stable same-origin context, exactly
// like being served by the server itself. Benefits:
//   • no file:// asset/cache-bust quirks, no document.write wipe
//   • api.php is proxied SERVER-SIDE → no browser CORS, no mixed-content, no cert
//   • offline.js's IndexedDB mirror + write-queue persist across launches because
//     the origin (fixed port) is stable
// When the server is unreachable the proxy returns 5xx → the existing offline
// layer takes over. The shell is always served locally, so the app cold-boots
// offline.
//
// The server URL is CONFIGURABLE at runtime (no rebuild): resolved as
//   CODEMAN_NAS_BASE env  >  saved settings (OS user-data dir)  >  config.js default
// Change it anytime via the "Server / Offline…" menu item; or pick "Use offline
// only" to run with no server. First launch with nothing configured opens setup.
const { app, BrowserWindow, shell, Menu, ipcMain, dialog } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

// Pin the app name so the user-data dir (where settings.json lives) is the same
// in dev and in the packaged app — otherwise dev uses the package "name".
app.setName('CodeMan');

const DEFAULT_SERVER_URL = require('./config').DEFAULT_SERVER_URL || '';
const BASE_PORT = 47615; // fixed → stable origin → offline cache persists across launches

const shellDir = app.isPackaged
  ? path.join(process.resourcesPath, 'codeman')
  : path.join(__dirname, '..', 'codeman');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon',
};

let serverUrl = '';    // '' means no server (offline-only or not yet configured)
let configured = false; // has the user chosen EITHER a server URL OR offline-only?
let port = 0;
let mainWin = null;
let settingsWin = null;

function hostOf(u) { try { return new URL(u).host || u; } catch (e) { return u || 'the server'; } }

// ---------- configuration (persisted in the OS user-data dir) ----------
// settings.json is one of:  {"serverUrl":"http://…/"}  |  {"offlineOnly":true}
function settingsFile() { return path.join(app.getPath('userData'), 'settings.json'); }
function normalizeUrl(u) {
  u = (u || '').trim();
  if (u && !/\/$/.test(u)) u += '/'; // ensure trailing slash so url + 'api.php' is correct
  return u;
}
function loadConfig() {
  if (process.env.CODEMAN_NAS_BASE) { serverUrl = normalizeUrl(process.env.CODEMAN_NAS_BASE); configured = true; return; }
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    if (s && s.offlineOnly) { serverUrl = ''; configured = true; return; } // local-only, no server
    if (s && s.serverUrl)   { serverUrl = normalizeUrl(s.serverUrl); configured = true; return; }
  } catch (e) { /* no settings yet */ }
  serverUrl = normalizeUrl(DEFAULT_SERVER_URL);
  configured = !!serverUrl; // a baked-in default counts as configured; otherwise show first-run
}
function writeSettings(obj) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(obj, null, 2));
  } catch (e) { console.warn('Could not save settings:', e && e.message); }
}
function setServerUrl(url) { serverUrl = normalizeUrl(url); configured = true; writeSettings({ serverUrl }); }
function setOfflineOnly()  { serverUrl = ''; configured = true; writeSettings({ offlineOnly: true }); }

// ---------- mode / server switching (safe data merge & sync) ----------
// The offline cache + write-queue are namespaced per server in the renderer
// (offline.js), so a queue can NEVER replay against the wrong server — that's the
// hard guarantee. These prompts are the UX layer on top: when the user switches
// with unsynced changes, we ask what to do rather than silently stranding work.
async function readQueueLen() {
  if (!mainWin || mainWin.isDestroyed()) return 0;
  try { return await mainWin.webContents.executeJavaScript('window.__codemanQueueLen ? window.__codemanQueueLen() : 0'); }
  catch (e) { return 0; }
}
async function flushViaRenderer() {
  if (!mainWin || mainWin.isDestroyed()) return;
  // Flush the CURRENT namespace's queue against the CURRENTLY-active server
  // (must run before serverUrl changes), then wait briefly for it to drain.
  try {
    await mainWin.webContents.executeJavaScript('window.__codemanFlush ? window.__codemanFlush() : 0');
  } catch (e) {}
}
function askBox(opts) {
  const win = (settingsWin && !settingsWin.isDestroyed()) ? settingsWin : mainWin;
  return dialog.showMessageBox(win, {
    type: 'question', defaultId: 0, cancelId: opts.buttons.length - 1,
    message: opts.message, detail: opts.detail, buttons: opts.buttons, noLink: true,
  }).then(r => r.response);
}

// Resolve a settings save into an applied config change. Returns
// { ok, changed, cancelled }. Shows native dialogs when a choice is needed.
async function applySwitch(body) {
  const toOffline = !!body.offlineOnly;
  const newUrl = toOffline ? '' : normalizeUrl(body.serverUrl || '');

  // First-run setup (nothing configured yet) — just apply, no switch semantics.
  if (!configured) {
    if (toOffline) setOfflineOnly(); else setServerUrl(newUrl);
    return { ok: true, changed: true };
  }

  const oldUrl = serverUrl;                 // '' === local-only
  const sameTarget = toOffline ? (oldUrl === '') : (newUrl === oldUrl);
  if (sameTarget) return { ok: true, changed: false };

  const q = await readQueueLen();           // pending in the CURRENT (old) namespace
  if (q === 0) {                            // nothing unsynced — switch cleanly
    if (toOffline) setOfflineOnly(); else setServerUrl(newUrl);
    return { ok: true, changed: true };
  }

  const plural = q === 1 ? '' : 's';
  const oldLocal = (oldUrl === '');

  if (oldLocal && !toOffline) {             // Local-only → Server, with local work
    const choice = await askBox({
      message: q + ' local change' + plural + ' are only on this Mac.',
      detail: 'Push them up to ' + hostOf(newUrl) + ', or keep them on this Mac (they stay available if you switch back to offline)?',
      buttons: ['Push to ' + hostOf(newUrl), 'Keep on this Mac', 'Cancel'],
    });
    if (choice === 2) return { ok: false, cancelled: true };
    if (choice === 0) {                     // adopt local data into the new server's namespace
      try { await mainWin.webContents.executeJavaScript('window.__codemanAdoptInto ? window.__codemanAdoptInto(' + JSON.stringify(newUrl) + ') : 0'); } catch (e) {}
    }
    setServerUrl(newUrl);
    return { ok: true, changed: true, flushAfter: choice === 0 };
  }

  if (!oldLocal && toOffline) {             // Server → Local-only, with unsynced work
    const choice = await askBox({
      message: q + ' change' + plural + ' not yet synced to ' + hostOf(oldUrl) + '.',
      detail: 'Sync them now before going offline-only, or switch anyway (they stay safe and sync when you reconnect to ' + hostOf(oldUrl) + ')?',
      buttons: ['Sync now', 'Switch anyway', 'Cancel'],
    });
    if (choice === 2) return { ok: false, cancelled: true };
    if (choice === 0) await flushViaRenderer();   // flush while old server is still active
    setOfflineOnly();
    return { ok: true, changed: true };
  }

  // Server A → Server B, with unsynced work for A. NEVER replay A's queue into B.
  const choice = await askBox({
    message: q + ' unsynced change' + plural + ' for ' + hostOf(oldUrl) + '.',
    detail: 'Sync them to ' + hostOf(oldUrl) + ' first, or switch to ' + hostOf(newUrl)
      + ' anyway? Unsynced changes stay safe and sync when you return to ' + hostOf(oldUrl) + '.',
    buttons: ['Sync to ' + hostOf(oldUrl) + ' first', 'Switch anyway', 'Cancel'],
  });
  if (choice === 2) return { ok: false, cancelled: true };
  if (choice === 0) await flushViaRenderer();
  setServerUrl(newUrl);
  return { ok: true, changed: true };
}

// Reachability probe of a CANDIDATE url (used by the settings "Test connection").
async function testServer(url) {
  const target = normalizeUrl(url);
  if (!target) return { ok: false, error: 'empty url' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(target + 'api.php?action=tree', { signal: ctrl.signal });
    clearTimeout(t);
    return { ok: r.ok, status: r.status, auth: r.status === 401 };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, error: String(e && e.message || e) };
  }
}

// After a config change: reload the live app (re-namespaces via preload) and, if
// requested, flush the now-active namespace's queue (e.g. the just-adopted local work).
function afterConfigChange(flushAfter) {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.close(); settingsWin = null; }
  if (!mainWin || mainWin.isDestroyed()) return;
  mainWin.loadURL(`http://127.0.0.1:${port}/index.html`);
  if (flushAfter) {
    mainWin.webContents.once('did-finish-load', () => {
      setTimeout(() => { mainWin.webContents.executeJavaScript('window.__codemanFlush && window.__codemanFlush()').catch(() => {}); }, 800);
    });
  }
}

// ---------- the settings screen (served by the local server at /__settings) ----------
function settingsHtml() {
  const current = serverUrl.replace(/"/g, '&quot;');
  const isOfflineNow = configured && !serverUrl;
  const statusLine = !configured ? '' : (isOfflineNow
    ? 'Currently <b>offline-only</b> — snippets live on this Mac.'
    : 'Currently connected to <b>' + hostOf(serverUrl).replace(/</g, '&lt;') + '</b>.');
  return `<!doctype html><html><head><meta charset="utf-8"><title>CodeMan — Settings</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
         background:#1e1e1e; color:#ddd; min-height:100vh; display:flex; align-items:center; justify-content:center; }
  .card { width:480px; max-width:88vw; background:#252526; border:1px solid #444; border-radius:10px; padding:24px 26px; margin:24px; }
  h1 { font-size:18px; margin:0 0 4px; }
  p { color:#9aa; font-size:12.5px; line-height:1.5; margin:0 0 16px; }
  .status { font-size:12.5px; color:#cdd; background:#1e1e1e; border:1px solid #3a3d41; border-left:3px solid #0e639c;
            border-radius:6px; padding:9px 12px; margin:0 0 18px; }
  label { display:block; font-size:12px; color:#9aa; margin-bottom:6px; }
  .urlrow { display:flex; gap:8px; }
  input { flex:1; min-width:0; box-sizing:border-box; background:#1e1e1e; border:1px solid #3a3d41; border-radius:6px;
          color:#fff; font-size:15px; padding:10px 12px; outline:none; }
  input:focus { border-color:#0e639c; }
  .ex { font-size:11.5px; color:#777; margin-top:8px; }
  .btns { display:flex; justify-content:flex-end; gap:10px; margin-top:20px; }
  button { font-size:14px; padding:8px 18px; border-radius:6px; border:1px solid #3a3d41; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  .save { background:#0e639c; border-color:#0e639c; color:#fff; }
  .save:hover:not(:disabled) { background:#1177bb; }
  .cancel, .test, .offline { background:#2d2d30; color:#ddd; }
  .cancel:hover, .test:hover:not(:disabled), .offline:hover { background:#3a3a3d; }
  .test { flex-shrink:0; padding:10px 14px; }
  .divider { display:flex; align-items:center; gap:12px; color:#666; font-size:11px; margin:22px 0 16px; }
  .divider::before, .divider::after { content:""; flex:1; height:1px; background:#3a3a3d; }
  .offline-row { display:flex; align-items:center; justify-content:space-between; gap:14px; }
  .offline-row .txt { font-size:12.5px; color:#9aa; line-height:1.45; }
  .offline { flex-shrink:0; }
  .test-result { font-size:12px; margin-top:8px; min-height:15px; }
  .ok { color:#6bb36b; } .bad { color:#d98b8b; }
  .msg { font-size:12px; margin-top:12px; min-height:16px; }
</style></head><body>
<div class="card">
  <h1>${configured ? 'CodeMan Settings' : 'Set up CodeMan'}</h1>
  ${statusLine ? `<div class="status">${statusLine}</div>` : ''}
  <p>Connect to a CodeMan <b>server</b> to sync your snippets across devices, or use this app
     <b>offline only</b> — everything stored locally on this Mac, no server needed.</p>

  <label for="u">Server URL</label>
  <div class="urlrow">
    <input id="u" type="text" value="${current}" placeholder="http://my-nas.local:8080/codeman/" autofocus>
    <button class="test" id="test">Test</button>
  </div>
  <div class="test-result" id="testResult"></div>
  <div class="ex">The folder that serves <code>api.php</code>, with a trailing slash. The app still
     works offline and syncs back when the server is reachable.</div>
  <div class="btns">
    <button class="cancel" id="cancel">Cancel</button>
    <button class="save" id="save">${configured ? 'Connect' : 'Save &amp; open'}</button>
  </div>

  <div class="divider">or</div>
  <div class="offline-row">
    <div class="txt">Use <b>offline only</b> — no server. Your snippets live on this Mac.
      ${configured ? 'Switching here keeps everything; you can reconnect anytime.' : 'You can connect a server later from the menu.'}</div>
    <button class="offline" id="offline">${isOfflineNow ? 'Offline (current)' : 'Use offline'}</button>
  </div>

  <div class="msg" id="msg"></div>
</div>
<script>
  const $ = (id) => document.getElementById(id);
  const configured = ${configured ? 'true' : 'false'};
  if (!configured) $('cancel').style.display = 'none'; // nothing to go back to on first run
  if (${isOfflineNow ? 'true' : 'false'}) $('offline').disabled = true;
  const done = () => { try { window.close(); } catch (e) {} }; // child window; main also reloads/closes
  $('cancel').onclick = done;
  $('u').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('save').click(); });

  $('test').onclick = async () => {
    const url = $('u').value.trim();
    const out = $('testResult');
    if (!url) { out.className = 'test-result bad'; out.textContent = 'Enter a URL to test.'; return; }
    $('test').disabled = true; out.className = 'test-result'; out.textContent = 'Testing…';
    try {
      const r = await fetch('/__test', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ url }) });
      const j = await r.json();
      if (j.ok) { out.className = 'test-result ok'; out.textContent = '✓ Reachable.'; }
      else if (j.auth) { out.className = 'test-result ok'; out.textContent = '✓ Reachable (password-protected).'; }
      else { out.className = 'test-result bad'; out.textContent = '✕ Not reachable' + (j.error ? ' — ' + j.error : (j.status ? ' (HTTP ' + j.status + ')' : '')) + '.'; }
    } catch (e) { out.className = 'test-result bad'; out.textContent = '✕ ' + e.message; }
    $('test').disabled = false;
  };

  async function post(payload, label) {
    $('msg').textContent = label;
    $('save').disabled = true; $('offline').disabled = true;
    try {
      const r = await fetch('/__config', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
      const j = await r.json();
      if (j.cancelled) { $('msg').textContent = 'Change cancelled.'; $('save').disabled = false; $('offline').disabled = ${isOfflineNow ? 'true' : 'false'}; return; }
      if (!configured) { location.href = '/index.html'; return; } // first-run: this page lives in the main window
      // Reconfigure: the main process reloads the app + closes this window.
      $('msg').textContent = 'Done.';
    } catch (e) { $('msg').textContent = 'Could not save: ' + e.message; $('save').disabled = false; $('offline').disabled = false; }
  }
  $('save').onclick = () => {
    const url = $('u').value.trim();
    if (!url) { $('msg').textContent = 'Enter a URL, or choose “Use offline”.'; return; }
    post({ serverUrl: url }, 'Saving…');
  };
  $('offline').onclick = () => post({ offlineOnly: true }, 'Switching to offline…');
</script></body></html>`;
}

function startServer() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');

    // ----- settings screen -----
    if (u.pathname === '/__settings') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(settingsHtml());
      return;
    }
    // ----- current configuration (for the settings panel to render live state) -----
    if (u.pathname === '/__status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ serverUrl, configured, offlineOnly: configured && !serverUrl }));
      return;
    }
    // ----- reachability test of a candidate server URL -----
    if (u.pathname === '/__test' && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        const out = await testServer(body.url || '');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"ok":false,"error":"bad request"}');
      }
      return;
    }
    // ----- apply a settings change (server URL / offline-only), with safe-switch prompts -----
    if (u.pathname === '/__config' && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        const result = await applySwitch(body); // may show native dialogs
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
        if (result.ok && result.changed) afterConfigChange(result.flushAfter);
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":"bad request"}');
      }
      return;
    }

    // ----- proxy the PHP API to the configured server (server-side: no CORS/cert/mixed-content) -----
    if (u.pathname === '/api.php') {
      if (!serverUrl) { // not configured yet → behave as "offline" so the UI prompts/uses cache
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{"error":"no server configured"}');
        return;
      }
      try {
        const headers = {};
        if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
        if (req.headers['x-codeman-auth']) headers['x-codeman-auth'] = req.headers['x-codeman-auth'];
        const body = (req.method === 'GET' || req.method === 'HEAD') ? undefined : await readBody(req);
        const r = await fetch(serverUrl + 'api.php' + u.search, { method: req.method, headers, body });
        const buf = Buffer.from(await r.arrayBuffer());
        res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
        res.end(buf);
      } catch (e) {
        if (process.env.CODEMAN_SMOKE) console.log('PROXY_ERR ' + (e && e.message) + ' / ' + (e && e.cause && e.cause.code));
        // Server down/unreachable → 5xx so apiFetch throws and offline.js takes over.
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{"error":"server unreachable"}');
      }
      return;
    }

    // ----- static: serve the bundled shell (ignore the ?v= cache-bust query) -----
    let rel = decodeURIComponent(u.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const filePath = path.normalize(path.join(shellDir, rel));
    if (!filePath.startsWith(shellDir)) { res.writeHead(403); res.end(); return; } // no traversal
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
  });

  return new Promise((resolve, reject) => {
    let p = BASE_PORT, attempts = 0;
    const tryListen = () => {
      server.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && attempts++ < 8) { p++; tryListen(); }
        else reject(e);
      });
      server.listen(p, '127.0.0.1', () => resolve(p));
    };
    tryListen();
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function openSettings() {
  if (!mainWin) return;
  // First run (nothing configured) — the setup screen owns the main window.
  if (!configured) { mainWin.loadURL(`http://127.0.0.1:${port}/__settings`); return; }
  // Reconfigure — a dedicated, native-feeling Settings window; the app stays alive.
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 540, height: 660, resizable: false, minimizable: false, maximizable: false,
    parent: mainWin, backgroundColor: '#1e1e1e', title: 'CodeMan Settings',
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.on('closed', () => { settingsWin = null; });
  settingsWin.loadURL(`http://127.0.0.1:${port}/__settings`);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: openSettings },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' }, { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        ...(isMac ? [] : [{ label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: openSettings }, { type: 'separator' }]),
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    // Edit roles MUST stay so copy/paste works in a snippet manager.
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWin = new BrowserWindow({
    width: 1280, height: 850, backgroundColor: '#1e1e1e', title: 'CodeMan',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false, // so the preload can use ipcRenderer.sendSync to read the live server URL
    },
  });

  // Real external links (note-block http links) open in the system browser.
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\/(?!127\.0\.0\.1)/i.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });

  // Not configured yet → first-run setup screen; otherwise the app (server or offline-only).
  mainWin.loadURL(`http://127.0.0.1:${port}/${configured ? 'index.html' : '__settings'}`);

  // Optional non-interactive smoke check (verification only).
  if (process.env.CODEMAN_SMOKE) {
    mainWin.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const out = await mainWin.webContents.executeJavaScript(
            '(async () => { let api={}; try { const r = await fetch("api.php?action=tree"); const j = await r.json(); api={ok:r.ok, rootNodes:Array.isArray(j)?j.length:"?"}; } catch(e){ api={err:String(e)}; } return JSON.stringify({path:location.pathname, title:document.title, scripts:document.scripts.length, rows:document.querySelectorAll(".tree-row,.miller-row,.subfolder-card").length, api}); })()'
          );
          console.log('SMOKE_RESULT ' + out);
        } catch (e) { console.log('SMOKE_ERROR ' + (e && e.message)); }
        app.quit();
      }, 4000);
    });
  }
}

// The preload reads the active server URL synchronously at page-load time so
// offline.js can namespace its cache before any other script runs. Using sendSync
// (vs. a fixed window arg) means a post-switch reload re-reads the LIVE value.
ipcMain.on('codeman:server-url', (e) => { e.returnValue = serverUrl; });

app.whenReady().then(async () => {
  loadConfig();
  port = await startServer();
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
