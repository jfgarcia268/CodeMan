// Preload — injects the ACTIVE server identity into the renderer before any page
// script runs. offline.js reads window.CODEMAN_SERVER_URL at module-load time to
// namespace its IndexedDB cache + write-queue per server (so server A's queued
// writes can never replay into server B). A dom-ready executeJavaScript or an
// async /__env fetch would land too late — offline.js's load-time IIFE would have
// already chosen a namespace. A preload running with contextIsolation is the only
// injection point guaranteed to run first.
//
// We use a SYNCHRONOUS IPC (not BrowserWindow additionalArguments) so that after a
// server/mode switch the renderer is reloaded (location.href) and re-reads the
// CURRENT serverUrl — re-namespacing for free, without recreating the window.
const { contextBridge, ipcRenderer } = require('electron');

let serverUrl = '';
try { serverUrl = ipcRenderer.sendSync('codeman:server-url') || ''; } catch (e) { /* not in desktop */ }

// Identity only. API_BASE stays '' so the renderer keeps using the relative,
// same-origin api.php that main.js proxies server-side.
contextBridge.exposeInMainWorld('CODEMAN_SERVER_URL', serverUrl);
contextBridge.exposeInMainWorld('CODEMAN_API_BASE', '');
