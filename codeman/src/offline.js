/* ---------- OFFLINE / LOCAL PERSISTENCE FALLBACK ----------

   When the PHP backend is unreachable the app stays usable: reads come from an
   IndexedDB mirror (tree + opened pages) and writes are applied optimistically
   to that mirror and queued. On reconnect the queue is replayed to the backend
   in order. This makes CodeMan work as pure static files / offline, and means a
   backend blip never loses edits. */

const IDB_NAME = 'codeman', IDB_STORES = ['kv', 'pages'];
let _idb = null;
function idbOpen() {
  return new Promise((res, rej) => {
    if (_idb) return res(_idb);
    const r = indexedDB.open(IDB_NAME, 1);
    r.onupgradeneeded = () => { const db = r.result; IDB_STORES.forEach(s => { if (!db.objectStoreNames.contains(s)) db.createObjectStore(s); }); };
    r.onsuccess = () => { _idb = r.result; res(_idb); };
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(store, key) {
  const db = await idbOpen();
  return new Promise((res, rej) => { const q = db.transaction(store, 'readonly').objectStore(store).get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
}
async function idbSet(store, key, val) {
  const db = await idbOpen();
  return new Promise((res, rej) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(val, key); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
}
async function idbDel(store, key) {
  const db = await idbOpen();
  return new Promise((res) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).delete(key); tx.oncomplete = () => res(); });
}

let offlineState = false;
let syncQueue = [];
(async () => { try { syncQueue = (await idbGet('kv', 'queue')) || []; } catch (e) {} updateOfflineBadge(); })();
async function saveQueue() { try { await idbSet('kv', 'queue', syncQueue); } catch (e) {} }
async function enqueue(op) { syncQueue.push(op); await saveQueue(); updateOfflineBadge(); }

function setOffline(on) {
  if (offlineState === on) return;
  offlineState = on;
  updateOfflineBadge();
  if (on) { reconnectDelay = 0; scheduleReconnect(); } // start self-healing probe loop
  else { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } flushQueue(); }
}

// --- Self-healing reconnect ---------------------------------------------------
// A reachable server must clear a false "offline" WITHOUT user action. We probe
// with a lightweight tree fetch on a capped backoff, and immediately on tab-focus
// and the browser 'online' event. Only a real success clears the state — so this
// never lies about being online (the old 'online'-event handler did).
let reconnectTimer = null;
let reconnectDelay = 0;
const RECONNECT_MIN = 3000, RECONNECT_MAX = 30000;

async function probeBackend() {
  if (!offlineState) return true;
  try {
    const fresh = await apiFetch('tree');         // reachable? (throws/aborts if not)
    await idbSet('kv', 'tree', fresh);
    treeData = fresh; renderTree();
    setOffline(false);                            // clears state + flushes the queue
    return true;
  } catch (e) {
    scheduleReconnect();                          // still down — back off and retry
    return false;
  }
}

function scheduleReconnect() {
  if (!offlineState || reconnectTimer) return;
  reconnectDelay = Math.min(reconnectDelay ? reconnectDelay * 2 : RECONNECT_MIN, RECONNECT_MAX);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; probeBackend(); }, reconnectDelay);
}

// Replay queued writes to the backend in FIFO order. Stops on the first network
// failure (still offline); reconciles the tree afterward.
let flushing = false;
async function flushQueue() {
  if (flushing || !syncQueue.length) return;
  flushing = true;
  let conflicts = 0;
  try {
    while (syncQueue.length) {
      const op = syncQueue[0];
      let res;
      try { res = await apiFetch(op.action, op.body, op.query); }
      catch (e) { setOffline(true); break; } // backend down again
      // The server silently refuses a save whose baseMtime is stale (a concurrent
      // edit landed while we were offline). Don't drop the edit: re-apply it forced.
      // save_page snapshots the prior content into .history first, so the concurrent
      // version is recoverable rather than lost — deterministic, never silent.
      if (op.action === 'save_page' && res && res.conflict) {
        try { await apiFetch('save_page', Object.assign({}, op.body, { force: true })); conflicts++; }
        catch (e) { setOffline(true); break; }
      }
      syncQueue.shift();
      await saveQueue();
      updateOfflineBadge();
    }
    if (!syncQueue.length) {
      const fresh = await apiFetch('tree');     // reconcile cache with server truth
      await idbSet('kv', 'tree', fresh);
      treeData = fresh; renderTree();
      toast(conflicts
        ? 'Synced — ' + conflicts + ' conflict' + (conflicts === 1 ? '' : 's') + ' overwritten (prior versions in History)'
        : 'Synced');
    }
  } finally { flushing = false; }
}

// Keep the IndexedDB mirror current after a successful backend call.
async function cacheOnSuccess(action, body, query, data) {
  try {
    if (action === 'tree') await idbSet('kv', 'tree', data);
    else if (action === 'get_page') { const p = (body && body.path) || qparam(query, 'path'); if (p) { const copy = Object.assign({}, data); delete copy._mtime; await idbSet('pages', p, copy); } }
    else if (action === 'save_page' && body) { const copy = Object.assign({}, body.data); delete copy._mtime; await idbSet('pages', body.path, copy); }
    else if (action === 'delete' && body) await idbDel('pages', body.path);
  } catch (e) {}
}

function qparam(query, key) {
  if (!query) return '';
  const m = new RegExp('(?:^|&)' + key + '=([^&]*)').exec(query);
  return m ? decodeURIComponent(m[1]) : '';
}

// Serve a request from the local mirror; queue writes for later replay.
async function offlineApi(action, body, query) {
  switch (action) {
    case 'tree': return (await idbGet('kv', 'tree')) || [];
    case 'get_page': {
      const p = (body && body.path) || qparam(query, 'path');
      return (await idbGet('pages', p)) || { title: nameFromPath(p || ''), sections: [], _mtime: null };
    }
    case 'search_content': return offlineSearch(qparam(query, 'q'));
    case 'search_blocks': return offlineSearchBlocks(qparam(query, 'q'));
    case 'list_tags': return offlineListTags();
    case 'rename_tag': return { error: 'Tag rename needs a connection' };
    case 'replace_content': return { error: 'Find & replace needs a connection' };
    case 'rebuild_index': return { ok: true, pages: 0, offline: true };

    // Trash — mirrored locally so offline deletes are recoverable.
    case 'list_trash': return offlineListTrash();
    case 'restore_trash': return offlineRestoreTrash(body);
    case 'empty_trash': return offlineEmptyTrash();

    // History — a local snapshot log of edits made while offline.
    case 'list_history': return offlineListHistory((body && body.path) || qparam(query, 'path'));
    case 'get_history_version': return offlineGetHistory((body && body.path) || qparam(query, 'path'), body ? body.ts : qparam(query, 'ts'));
    case 'restore_history': return offlineRestoreHistory(body);

    case 'save_page': {
      const copy = Object.assign({}, body.data); delete copy._mtime;
      const prev = await idbGet('pages', body.path);
      if (prev) await recordLocalHistory(body.path, prev); // version prior content
      await idbSet('pages', body.path, copy);
      await enqueue({ action, body }); return { ok: true, offline: true, mtime: null };
    }
    case 'delete': {
      await recordLocalTrash(body.path); // snapshot before the cache clears it
      await mutateTreeCache(action, body);
      await enqueue({ action, body }); return { ok: true, offline: true };
    }
    case 'create_page': case 'create_folder': case 'create_project':
    case 'rename': case 'move': case 'reorder': {
      await mutateTreeCache(action, body);
      await enqueue({ action, body }); return { ok: true, offline: true };
    }
    default: return { error: 'offline: ' + action };
  }
}

/* ---------- OFFLINE TRASH (local recoverable deletes) ---------- */

// Snapshot an item into the local trash before it's removed from the cache.
async function recordLocalTrash(path) {
  try {
    const tree = (await idbGet('kv', 'tree')) || [];
    const node = findInTree(tree, path);
    const isDir = node ? node.type === 'folder' : !String(path).endsWith('.json');
    const name = String(path).split('/').pop().replace(/\.json$/, '');
    const data = isDir ? null : ((await idbGet('pages', path)) || null);
    const list = (await idbGet('kv', 'trash')) || [];
    list.unshift({
      id: 'local__' + Date.now() + '__' + name,
      origPath: path, name, deletedAt: Math.floor(Date.now() / 1000), isDir,
      data, node: node ? JSON.parse(JSON.stringify(node)) : null,
    });
    await idbSet('kv', 'trash', list);
  } catch (e) {}
}

async function offlineListTrash() {
  const list = (await idbGet('kv', 'trash')) || [];
  return list.map(e => ({ id: e.id, origPath: e.origPath, name: e.name, deletedAt: e.deletedAt, isDir: e.isDir }));
}

async function offlineRestoreTrash(body) {
  const id = body && body.id;
  const list = (await idbGet('kv', 'trash')) || [];
  const idx = list.findIndex(e => e.id === id);
  if (idx === -1) return { error: 'offline: trash item not found' };
  const entry = list[idx];
  if (!entry.isDir && entry.data) await idbSet('pages', entry.origPath, entry.data);
  await restoreNodeToTree(entry);
  // If the matching delete is still queued, cancelling it makes this a clean
  // no-op server-side; otherwise the delete already synced, so rebuild on replay.
  const qi = syncQueue.findIndex(op => op.action === 'delete' && op.body && op.body.path === entry.origPath);
  if (qi !== -1) { syncQueue.splice(qi, 1); await saveQueue(); }
  else { await enqueueReconstruct(entry); }
  list.splice(idx, 1); await idbSet('kv', 'trash', list);
  updateOfflineBadge();
  return { ok: true, offline: true, path: entry.origPath };
}

// Re-insert a trashed node back into its original parent in the tree cache.
async function restoreNodeToTree(entry) {
  const tree = (await idbGet('kv', 'tree')) || [];
  if (!findInTree(tree, entry.origPath)) {
    const parent = entry.origPath.includes('/') ? entry.origPath.slice(0, entry.origPath.lastIndexOf('/')) : '';
    const list = parent ? ((findInTree(tree, parent) || {}).children) : tree;
    if (list) {
      list.push(entry.node || (entry.isDir
        ? { type: 'folder', name: entry.name, path: entry.origPath, children: [] }
        : { type: 'page', name: entry.name, path: entry.origPath, tags: [], langs: [] }));
    }
  }
  await idbSet('kv', 'tree', tree);
  treeData = tree; renderTree();
}

// When a delete already reached the server, restoring means recreating the item.
async function enqueueReconstruct(entry) {
  const parentOf = (p) => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
  if (!entry.isDir) {
    await enqueue({ action: 'create_page', body: { parent: parentOf(entry.origPath), name: entry.name } });
    if (entry.data) await enqueue({ action: 'save_page', body: { path: entry.origPath, data: entry.data, force: true } });
    return;
  }
  const walk = async (n) => {
    if (n.type === 'folder') {
      if (n.project) await enqueue({ action: 'create_project', body: { name: n.name } });
      else await enqueue({ action: 'create_folder', body: { parent: parentOf(n.path), name: n.name } });
      for (const c of (n.children || [])) await walk(c);
    } else {
      await enqueue({ action: 'create_page', body: { parent: parentOf(n.path), name: n.name } });
      const data = await idbGet('pages', n.path);
      if (data) await enqueue({ action: 'save_page', body: { path: n.path, data, force: true } });
    }
  };
  if (entry.node) await walk(entry.node);
  else await enqueue({ action: 'create_folder', body: { parent: parentOf(entry.origPath), name: entry.name } });
}

// Offline empty only discards the local restore snapshots; any queued deletes
// still run on reconnect, so items remain recoverable from the server trash.
async function offlineEmptyTrash() {
  await idbSet('kv', 'trash', []);
  return { ok: true, offline: true };
}

/* ---------- OFFLINE HISTORY (local snapshot log) ---------- */

const LOCAL_HISTORY_KEEP = 20;
async function recordLocalHistory(path, content) {
  try {
    const all = (await idbGet('kv', 'history')) || {};
    const json = JSON.stringify(content);
    const list = all[path] || [];
    list.unshift({ ts: Math.floor(Date.now() / 1000), size: json.length, data: content });
    all[path] = list.slice(0, LOCAL_HISTORY_KEEP);
    await idbSet('kv', 'history', all);
  } catch (e) {}
}

async function offlineListHistory(path) {
  const all = (await idbGet('kv', 'history')) || {};
  return (all[path] || []).map(v => ({ ts: v.ts, size: v.size }));
}

async function offlineGetHistory(path, ts) {
  const all = (await idbGet('kv', 'history')) || {};
  const v = (all[path] || []).find(x => String(x.ts) === String(ts));
  return v ? v.data : { error: 'offline: version not found' };
}

async function offlineRestoreHistory(body) {
  const path = body && body.path, ts = body && body.ts;
  const all = (await idbGet('kv', 'history')) || {};
  const v = (all[path] || []).find(x => String(x.ts) === String(ts));
  if (!v) return { error: 'offline: version not found' };
  const cur = await idbGet('pages', path);
  if (cur) await recordLocalHistory(path, cur); // snapshot current so restore is undoable
  await idbSet('pages', path, v.data);
  await enqueue({ action: 'save_page', body: { path, data: v.data, force: true } });
  return { ok: true, offline: true, mtime: null };
}

// Search cached page contents (offline equivalent of search_content).
async function offlineSearch(q) {
  q = (q || '').toLowerCase().trim();
  if (!q) return [];
  const db = await idbOpen();
  return new Promise((res) => {
    const out = []; const store = db.transaction('pages', 'readonly').objectStore('pages');
    const cur = store.openCursor();
    cur.onsuccess = (e) => {
      const c = e.target.result;
      if (!c) return res(out);
      try { if (JSON.stringify(c.value).toLowerCase().includes(q)) out.push(c.key); } catch (er) {}
      c.continue();
    };
    cur.onerror = () => res(out);
  });
}

// Aggregate tags from the cached tree (page nodes carry their tag list).
async function offlineListTags() {
  const tree = (await idbGet('kv', 'tree')) || [];
  const counts = {};
  (function walk(nodes) {
    nodes.forEach(n => {
      if (n.type === 'page') (n.tags || []).forEach(t => { counts[t] = (counts[t] || 0) + 1; });
      else if (n.children) walk(n.children);
    });
  })(tree);
  return Object.keys(counts).map(t => ({ tag: t, count: counts[t] }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

// Search cached page blocks (offline equivalent of search_blocks).
async function offlineSearchBlocks(q) {
  q = (q || '').toLowerCase().trim();
  if (!q) return [];
  const db = await idbOpen();
  return new Promise((res) => {
    const out = []; const store = db.transaction('pages', 'readonly').objectStore('pages');
    const cur = store.openCursor();
    cur.onsuccess = (e) => {
      const c = e.target.result;
      if (!c) return res(out.slice(0, 100));
      try { collectBlocksFromPage(c.key, c.value, q, out); } catch (er) {}
      c.continue();
    };
    cur.onerror = () => res(out);
  });
}

// Walk a cached page's sections collecting blocks whose code/label/type matches.
function collectBlocksFromPage(path, data, q, out) {
  const page = nameFromPath(path);
  const walk = (sections, trail) => {
    (sections || []).forEach(sec => {
      const t = trail.concat([sec.title || 'Untitled']);
      const content = sec.tabs ? (sec.tabs[0] || {}) : sec;
      (content.blocks || []).forEach(b => {
        const hay = ((b.code || '') + ' ' + (b.label || '') + ' ' + (b.type || '')).toLowerCase();
        if (hay.includes(q)) out.push({ path, page, label: b.label || '', type: b.type || 'plaintext', code: b.code || '', note: !!b.note, trail: t.join(' › ') });
      });
      walk(content.subsections, t);
    });
  };
  walk(data.sections, []);
}

// Apply a structural change to the cached tree so the UI reflects it offline.
async function mutateTreeCache(action, body) {
  const tree = (await idbGet('kv', 'tree')) || [];
  const childrenOf = (parent) => { if (!parent) return tree; const n = findInTree(tree, parent); return n ? (n.children || (n.children = [])) : null; };
  if (action === 'create_folder' || action === 'create_project') {
    const list = childrenOf(body.parent || ''); if (!list) return;
    const path = (body.parent ? body.parent + '/' : '') + body.name;
    if (!list.some(n => n.path === path)) list.unshift(Object.assign({ type: 'folder', name: body.name, path, children: [] }, action === 'create_project' ? { project: true } : {}));
  } else if (action === 'create_page') {
    const list = childrenOf(body.parent || ''); if (!list) return;
    const path = (body.parent ? body.parent + '/' : '') + body.name + '.json';
    if (!list.some(n => n.path === path)) list.push({ type: 'page', name: body.name, path, tags: [], langs: [] });
    await idbSet('pages', path, { title: body.name, sections: [] });
  } else if (action === 'delete') {
    removeFromTree(tree, body.path); await idbDel('pages', body.path);
  } else if (action === 'rename') {
    const node = findInTree(tree, body.path); if (!node) return;
    const parent = body.path.includes('/') ? body.path.slice(0, body.path.lastIndexOf('/')) : '';
    node.name = body.newName;
    const newPath = (parent ? parent + '/' : '') + (node.type === 'folder' ? body.newName : body.newName + '.json');
    rePath(node, newPath);
  } else if (action === 'move') {
    const node = findInTree(tree, body.path); if (!node) return;
    removeFromTree(tree, body.path);
    const dest = childrenOf(body.target || ''); if (!dest) return;
    const base = node.path.split('/').pop();
    rePath(node, (body.target ? body.target + '/' : '') + base);
    dest.push(node);
  } else if (action === 'reorder') {
    const list = childrenOf(body.parent || ''); if (!list || !Array.isArray(body.order)) return;
    const key = (n) => n.type === 'folder' ? n.name : n.name + '.json';
    list.sort((a, b) => body.order.indexOf(key(a)) - body.order.indexOf(key(b)));
  }
  await idbSet('kv', 'tree', tree);
  treeData = tree; renderTree();
}
function findInTree(tree, path) { for (const n of tree) { if (n.path === path) return n; if (n.children) { const f = findInTree(n.children, path); if (f) return f; } } return null; }
function removeFromTree(tree, path) {
  const i = tree.findIndex(n => n.path === path);
  if (i !== -1) { tree.splice(i, 1); return true; }
  for (const n of tree) { if (n.children && removeFromTree(n.children, path)) return true; }
  return false;
}
// Recompute a node's path and all descendant paths under a new path.
function rePath(node, newPath) {
  node.path = newPath;
  (node.children || []).forEach(c => rePath(c, newPath + '/' + (c.type === 'folder' ? c.name : c.name + '.json')));
}

/* ---------- PRIME OFFLINE CACHE ----------
   The on-demand mirror only holds pages you've actually opened. To use the WHOLE
   library away from home, pre-fetch every page into IndexedDB while connected.
   Each api('get_page') routes through cacheOnSuccess(), which stores the page in
   the `pages` store — so after this runs, the SW has the shell and IndexedDB has
   the data, and the app is fully usable offline. Run it while online (a backend
   blip mid-run just leaves the unreached pages uncached — re-run to finish). */
async function primeOfflineCache(btn) {
  if (offlineState) { toast('Connect to the server first, then download for offline'); return; }
  const all = collectMatchingPages(treeData, '', []);
  if (!all.length) { toast('No pages to cache yet'); return; }
  const orig = btn ? btn.textContent : '';
  let done = 0, failed = 0;
  const update = () => { if (btn) { btn.disabled = true; btn.textContent = done + '/' + all.length; } };
  update();
  // Modest concurrency: fast on a LAN without hammering PHP-FPM.
  const CONC = 6;
  let i = 0;
  async function worker() {
    while (i < all.length) {
      const n = all[i++];
      try {
        const p = await api('get_page', undefined, 'path=' + encodeURIComponent(n.path));
        if (p && p.offline) failed++; else done++;   // offline fallback === not actually fetched
      } catch (e) { failed++; }
      update();
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  try { await api('tree'); } catch (e) {}            // make sure the tree mirror is fresh too
  if (btn) { btn.disabled = false; btn.textContent = '✓'; setTimeout(() => { btn.textContent = orig; }, 2000); }
  toast('Offline ready — ' + done + ' page' + (done === 1 ? '' : 's') + ' cached'
    + (failed ? ' · ' + failed + ' skipped' : ''));
}

function updateOfflineBadge() {
  let b = document.getElementById('offlineBadge');
  if (!b) {
    b = document.createElement('div'); b.id = 'offlineBadge'; b.className = 'offline-badge';
    // Tap to force a recheck: probe the server when offline, else flush any queue.
    b.addEventListener('click', () => { if (offlineState) probeBackend(); else if (syncQueue.length) flushQueue(); });
    document.body.appendChild(b);
  }
  const pending = syncQueue.length;
  if (!offlineState && !pending) { b.style.display = 'none'; return; }
  b.style.display = 'block';
  b.textContent = offlineState
    ? (pending ? '⚠ Offline · ' + pending + ' change' + (pending === 1 ? '' : 's') + ' queued' : '⚠ Offline (local only)')
    : (pending ? '↻ Syncing ' + pending + '…' : '');
  b.classList.toggle('warn', offlineState);
}

// Recover on reconnection signals — but only a real probe success clears offline.
window.addEventListener('online', () => { if (offlineState) probeBackend(); else if (syncQueue.length) flushQueue(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && offlineState) probeBackend(); });
