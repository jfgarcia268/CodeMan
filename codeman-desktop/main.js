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
const { app, BrowserWindow, shell, Menu } = require('electron');
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

// ---------- the settings screen (served by the local server at /__settings) ----------
function settingsHtml() {
  const current = serverUrl.replace(/"/g, '&quot;');
  return `<!doctype html><html><head><meta charset="utf-8"><title>CodeMan — Setup</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
         background:#1e1e1e; color:#ddd; min-height:100vh; display:flex; align-items:center; justify-content:center; }
  .card { width:480px; max-width:88vw; background:#252526; border:1px solid #444; border-radius:10px; padding:24px 26px; margin:24px; }
  h1 { font-size:18px; margin:0 0 4px; }
  p { color:#9aa; font-size:12.5px; line-height:1.5; margin:0 0 16px; }
  label { display:block; font-size:12px; color:#9aa; margin-bottom:6px; }
  input { width:100%; box-sizing:border-box; background:#1e1e1e; border:1px solid #3a3d41; border-radius:6px;
          color:#fff; font-size:15px; padding:10px 12px; outline:none; }
  input:focus { border-color:#0e639c; }
  .ex { font-size:11.5px; color:#777; margin-top:8px; }
  .btns { display:flex; justify-content:flex-end; gap:10px; margin-top:20px; }
  button { font-size:14px; padding:8px 18px; border-radius:6px; border:1px solid #3a3d41; cursor:pointer; }
  .save { background:#0e639c; border-color:#0e639c; color:#fff; }
  .save:hover { background:#1177bb; }
  .cancel { background:#2d2d30; color:#ddd; }
  .cancel:hover { background:#3a3a3d; }
  .divider { display:flex; align-items:center; gap:12px; color:#666; font-size:11px; margin:22px 0 16px; }
  .divider::before, .divider::after { content:""; flex:1; height:1px; background:#3a3a3d; }
  .offline-row { display:flex; align-items:center; justify-content:space-between; gap:14px; }
  .offline-row .txt { font-size:12.5px; color:#9aa; line-height:1.45; }
  .offline { background:#2d2d30; color:#ddd; flex-shrink:0; }
  .offline:hover { background:#3a3a3d; }
  .msg { font-size:12px; margin-top:12px; min-height:16px; }
</style></head><body>
<div class="card">
  <h1>Set up CodeMan</h1>
  <p>Connect to a CodeMan <b>server</b> to sync your snippets across devices, or use this app
     <b>offline only</b> — everything stored locally on this Mac, no server needed.</p>

  <label for="u">Server URL</label>
  <input id="u" type="text" value="${current}" placeholder="http://my-nas.local:8080/codeman/" autofocus>
  <div class="ex">The folder that serves <code>api.php</code>, with a trailing slash. The app still
     works offline and syncs back when the server is reachable.</div>
  <div class="btns">
    <button class="cancel" id="cancel">Cancel</button>
    <button class="save" id="save">Save &amp; open</button>
  </div>

  <div class="divider">or</div>
  <div class="offline-row">
    <div class="txt">Use <b>offline only</b> — no server. Your snippets live on this Mac.
      You can connect a server later from the menu.</div>
    <button class="offline" id="offline">Use offline</button>
  </div>

  <div class="msg" id="msg"></div>
</div>
<script>
  const $ = (id) => document.getElementById(id);
  const configured = ${configured ? 'true' : 'false'};
  if (!configured) $('cancel').style.display = 'none'; // nothing to go back to on first run
  $('cancel').onclick = () => { location.href = '/index.html'; };
  $('u').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('save').click(); });
  async function post(payload, label) {
    $('msg').textContent = label;
    try {
      await fetch('/__config', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
      location.href = '/index.html';
    } catch (e) { $('msg').textContent = 'Could not save: ' + e.message; }
  }
  $('save').onclick = () => {
    const url = $('u').value.trim();
    if (!url) { $('msg').textContent = 'Enter a URL, or choose “Use offline”.'; return; }
    post({ serverUrl: url }, 'Saving…');
  };
  $('offline').onclick = () => post({ offlineOnly: true }, 'Setting up offline…');
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
    // ----- save the configured server URL -----
    if (u.pathname === '/__config' && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        if (body.offlineOnly) setOfflineOnly();
        else setServerUrl(body.serverUrl || '');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
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
  if (mainWin) mainWin.loadURL(`http://127.0.0.1:${port}/__settings`);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: 'Server / Offline…', click: openSettings },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' }, { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        ...(isMac ? [] : [{ label: 'Server / Offline…', click: openSettings }, { type: 'separator' }]),
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

app.whenReady().then(async () => {
  loadConfig();
  port = await startServer();
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
