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

/* ---------- PER-SERVER NAMESPACING ----------
   The IndexedDB lives at a fixed origin (the desktop wrapper pins a fixed
   localhost port so the cache survives launches), so without qualification ALL
   servers would share ONE cache + write-queue — and a queue meant for server A
   could replay into server B. We avoid that by keying every offline record by
   the active server's identity. The desktop preload sets window.CODEMAN_SERVER_URL;
   a plain browser leaves it unset → a single fixed 'ns:local' namespace, i.e.
   behaviour identical to before. NS_SEP is a control char that can't occur in a
   page path, so namespaced keys are unambiguously distinguishable from legacy ones. */
const NS_SEP = '';
function nsHash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); }
function computeNS() {
  const u = ((typeof window !== 'undefined' && window.CODEMAN_SERVER_URL) || '').trim();
  return u ? 'ns:' + nsHash(u) : 'ns:local';
}
let NS = computeNS();
const kvKey = (key) => NS + NS_SEP + key;
const pageKey = (p) => NS + NS_SEP + p;
async function kvGet(key) { return idbGet('kv', kvKey(key)); }
async function kvSet(key, val) { return idbSet('kv', kvKey(key), val); }
async function kvDel(key) { return idbDel('kv', kvKey(key)); }
async function pageGet(p) { return idbGet('pages', pageKey(p)); }
async function pageSet(p, val) { return idbSet('pages', pageKey(p), val); }
async function pageDel(p) { return idbDel('pages', pageKey(p)); }

// One-time migration: pre-namespacing builds stored un-prefixed keys (incl. a
// possibly-pending queue). On the first boot after the upgrade, fold that legacy
// data into the CURRENTLY active namespace — which is the server the data was
// implicitly for — so nothing is stranded. Runs once (global flag), leaves the
// originals in place (harmless: cursors only read the active namespace's keys).
async function migrateLegacy() {
  try {
    if (await idbGet('kv', '__migrated')) return;
    const legacyQueue = await idbGet('kv', 'queue');
    const legacyTree = await idbGet('kv', 'tree');
    if (legacyQueue || legacyTree) {
      if (legacyQueue) await kvSet('queue', legacyQueue);
      if (legacyTree) await kvSet('tree', legacyTree);
      for (const k of ['trash', 'history']) { const v = await idbGet('kv', k); if (v) await kvSet(k, v); }
      const db = await idbOpen();
      await new Promise((resolve) => {
        const cur = db.transaction('pages', 'readonly').objectStore('pages').openCursor();
        const moves = [];
        cur.onsuccess = (e) => {
          const c = e.target.result;
          if (!c) { Promise.all(moves).then(resolve, resolve); return; }
          if (String(c.key).indexOf(NS_SEP) === -1) moves.push(pageSet(c.key, c.value)); // un-prefixed = legacy
          c.continue();
        };
        cur.onerror = () => resolve();
      });
    }
    await idbSet('kv', '__migrated', true);
  } catch (e) {}
}

// One-time migration: fold the single per-namespace `history` blob ({ path: [versions] })
// into per-page `history:<path>` kv keys (the <NS>\x1F<kind>:<suffix> seam kvEnumerate
// already serves). Runs in the boot IIFE after migrateLegacy. Design constraints:
//  (a) ALL NAMESPACES — cursor every `<ns>\x1F history` blob, not just the active one,
//      so a stranded namespace's local history migrates too;
//  (b) IDEMPOTENT — write a `history:<path>` key ONLY where it's absent, so a re-run or
//      a crash-then-retry never double-appends or clobbers newer per-path data;
//  (c) LEGACY-RETAINED — leave the `history` blob in place (rollback-safe: reverting the
//      code restores the old read path losslessly), mirroring migrateLegacy;
//  (d) a per-ns `__history_migrated` flag set AFTER a namespace's paths are all written,
//      so a second boot is a cheap no-op — and a mid-transform failure (flag never set)
//      is safe to retry, the absent-only writes making the retry lossless.
async function migrateHistoryKeys() {
  try {
    const db = await idbOpen();
    // Collect every namespace's legacy history blob (key === '<ns>\x1F history').
    const blobs = await new Promise((resolve) => {
      const found = [];
      const cur = db.transaction('kv', 'readonly').objectStore('kv').openCursor();
      cur.onsuccess = (e) => {
        const c = e.target.result;
        if (!c) return resolve(found);
        const key = String(c.key);
        const i = key.indexOf(NS_SEP);
        if (i !== -1 && key.slice(i + NS_SEP.length) === 'history') {
          found.push({ ns: key.slice(0, i), value: c.value });
        }
        c.continue();
      };
      cur.onerror = () => resolve(found);
    });
    for (const { ns, value } of blobs) {
      const flagKey = ns + NS_SEP + '__history_migrated';
      if (await idbGet('kv', flagKey)) continue;              // (d) already done → no-op
      if (value && typeof value === 'object') {
        for (const path of Object.keys(value)) {
          const perKey = ns + NS_SEP + 'history:' + path;
          if ((await idbGet('kv', perKey)) === undefined) {   // (b) absent-only write
            await idbSet('kv', perKey, value[path] || []);
          }
        }
      }
      // (c) legacy blob left in place; (d) flag set only after all paths are written,
      // so a crash before here leaves the flag unset → next boot safely retries.
      await idbSet('kv', flagKey, true);
    }
  } catch (e) {}
}

let offlineState = false;
let syncQueue = [];
(async () => {
  try { await migrateLegacy(); } catch (e) {}
  try { await migrateHistoryKeys(); } catch (e) {}
  try { syncQueue = (await kvGet('queue')) || []; } catch (e) {}
  updateOfflineBadge();
  // A queue can survive a reload (writes parked offline, a switched server, a
  // dropped beacon). setOffline/probeBackend only flush on a state TRANSITION, so
  // on a cold boot that starts online nothing would ever replay it — flush here.
  if (!offlineState && syncQueue.length) flushQueue();
})();
// Hooks the desktop wrapper calls (main.js) to drive safe server/mode switching.
if (typeof window !== 'undefined') {
  // How many writes are queued in the ACTIVE namespace (→ which merge prompt to show).
  window.__codemanQueueLen = () => syncQueue.length;
  // Flush the active namespace's queue against the active server; resolve with the
  // remaining count. Used for "Sync now / Sync first" before a switch.
  window.__codemanFlush = async () => { try { await flushQueue(); } catch (e) {} return syncQueue.length; };
  // Adopt the CURRENT namespace's cache + queue into the namespace of targetUrl, so
  // local-only work can be pushed up when first connecting a server. The wrapper then
  // switches the active server and flushes, replaying the adopted writes onto it.
  window.__codemanAdoptInto = async (targetUrl) => {
    try {
      const fromNS = NS;
      const u = (targetUrl || '').trim();
      const toNS = u ? 'ns:' + nsHash(u) : 'ns:local';
      if (toNS === fromNS) return;
      const get = (ns, k) => idbGet('kv', ns + NS_SEP + k);
      const set = (ns, k, v) => idbSet('kv', ns + NS_SEP + k, v);
      // MERGE into the target — never overwrite. The target namespace may already hold
      // its own unsynced work (a queue parked while it was inactive); clobbering it
      // would be exactly the silent loss this phase exists to prevent.
      // queue: append source ops AFTER any the target already has (FIFO preserved).
      const srcQueue = (await get(fromNS, 'queue')) || [];
      if (srcQueue.length) { const dst = (await get(toNS, 'queue')) || []; await set(toNS, 'queue', dst.concat(srcQueue)); }
      // trash: concat (newest-first lists; order isn't load-bearing for restore).
      const srcTrash = (await get(fromNS, 'trash')) || [];
      if (srcTrash.length) { const dst = (await get(toNS, 'trash')) || []; await set(toNS, 'trash', dst.concat(srcTrash)); }
      // tree / colsorts: only seed the target if it has none (else it reconciles from
      // the server on the next flush — the source tree could be stale for that server).
      for (const k of ['tree', 'colsorts']) {
        if ((await get(toNS, k)) === undefined) { const v = await get(fromNS, k); if (v !== undefined) await set(toNS, k, v); }
      }
      const db = await idbOpen();
      // history: per-page merge — each fromNS `history:<path>` key concatenated (capped)
      // onto the toNS one, never overwriting the target namespace's own local history.
      // Cursors the new per-page key shape (post-migrateHistoryKeys), not the old blob.
      await new Promise((resolve) => {
        const cur = db.transaction('kv', 'readonly').objectStore('kv').openCursor();
        const jobs = [];
        const srcPrefix = fromNS + NS_SEP + 'history:';
        cur.onsuccess = (e) => {
          const c = e.target.result;
          if (!c) { Promise.all(jobs).then(resolve, resolve); return; }
          const key = String(c.key);
          if (key.startsWith(srcPrefix)) {
            const dstKey = toNS + NS_SEP + key.slice(fromNS.length + NS_SEP.length);
            const src = c.value || [];
            jobs.push((async () => {
              const dst = (await idbGet('kv', dstKey)) || [];
              await idbSet('kv', dstKey, dst.concat(src).slice(0, LOCAL_HISTORY_KEEP));
            })());
          }
          c.continue();
        };
        cur.onerror = () => resolve();
      });
      // Dead-letters are unsynced work too — carry each per-op entry across.
      await new Promise((resolve) => {
        const cur = db.transaction('kv', 'readonly').objectStore('kv').openCursor();
        const moves = [];
        cur.onsuccess = (e) => {
          const c = e.target.result;
          if (!c) { Promise.all(moves).then(resolve, resolve); return; }
          const key = String(c.key);
          if (key.startsWith(fromNS + NS_SEP + 'dl:')) moves.push(idbSet('kv', toNS + NS_SEP + key.slice(fromNS.length + NS_SEP.length), c.value));
          c.continue();
        };
        cur.onerror = () => resolve();
      });
      await new Promise((resolve) => {
        const cur = db.transaction('pages', 'readonly').objectStore('pages').openCursor();
        const moves = [];
        cur.onsuccess = (e) => {
          const c = e.target.result;
          if (!c) { Promise.all(moves).then(resolve, resolve); return; }
          const key = String(c.key);
          if (key.startsWith(fromNS + NS_SEP)) moves.push(idbSet('pages', toNS + NS_SEP + key.slice(fromNS.length + NS_SEP.length), c.value));
          c.continue();
        };
        cur.onerror = () => resolve();
      });
    } catch (e) {}
  };
}
async function saveQueue() { try { await kvSet('queue', syncQueue); } catch (e) {} }
async function enqueue(op) { syncQueue.push(op); await saveQueue(); updateOfflineBadge(); }

/* ---------- DEAD-LETTER QUEUE ----------
   A queued write the server *rejects* (a terminal 4xx, a transient error that
   survived its retries, or a conflict-force that still errored) must NEVER be
   silently dropped — that was the old flushQueue's bug (a bare shift() on any
   non-throw response). It's PARKED here as a dead-letter the user can review, retry,
   discard, or export (see openDeadLetterPanel in features.js). Each dead-letter is
   its own kv entry keyed kvKey('dl:' + id) = <NS>\x1F dl:<id>, so retry is
   NAMESPACE-LOCKED by construction: the helpers only ever read/write the ACTIVE
   namespace, so a parked op can never replay against the wrong server (the same hard
   guarantee as the write-queue). The key shape mirrors the planned history:<path>
   keys (<NS>\x1F<kind>:<suffix>) so kvEnumerate() serves both — no second migration. */

// Cursor the kv store returning { key (namespace-stripped), value } for every entry
// under the active namespace whose key starts with `prefix`. One helper for every
// per-op namespaced kv family (dead-letters now; local history later).
async function kvEnumerate(prefix) {
  const db = await idbOpen();
  const full = NS + NS_SEP + prefix;
  const strip = (NS + NS_SEP).length;
  return new Promise((res) => {
    const out = [];
    const cur = db.transaction('kv', 'readonly').objectStore('kv').openCursor();
    cur.onsuccess = (e) => {
      const c = e.target.result;
      if (!c) return res(out);
      const key = String(c.key);
      if (key.startsWith(full)) out.push({ key: key.slice(strip), value: c.value });
      c.continue();
    };
    cur.onerror = () => res(out);
  });
}

let _dlSeq = 0;
// Park an op the server rejected. `kind` is a label ('terminal' | 'retryable-exhausted'
// | 'retryable' | 'cascade'); `cascadeOf` names the failed create_* this op depended
// on (so the panel can group a failed subtree).
async function dlAdd(op, reason, kind, cascadeOf) {
  const id = Date.now() + '-' + (++_dlSeq);
  const entry = {
    id, ts: Math.floor(Date.now() / 1000),
    action: op.action, body: op.body || null, query: op.query || null,
    reason: String(reason == null ? 'unknown error' : reason),
    kind: kind || 'terminal',
    attempts: op.attempts || 0,
    cascadeOf: cascadeOf || null,
  };
  await kvSet('dl:' + id, entry);
  updateOfflineBadge();
  return entry;
}
async function dlList() {
  const rows = await kvEnumerate('dl:');
  return rows.map(r => r.value).sort((a, b) => (a.ts - b.ts) || String(a.id).localeCompare(String(b.id)));
}
async function dlRemove(id) { await kvDel('dl:' + id); updateOfflineBadge(); }
async function dlCount() { return (await kvEnumerate('dl:')).length; }

// The path a create_* op would create — used to track failed creates so dependent
// ops can be dead-lettered with a cascade context instead of noisy standalone 404s.
function dlCreatedPath(op) {
  if (!op || !op.body) return null;
  const b = op.body;
  if (op.action === 'create_page') return (b.parent ? b.parent + '/' : '') + b.name + '.json';
  if (op.action === 'create_folder' || op.action === 'create_project') return (b.parent ? b.parent + '/' : '') + b.name;
  return null;
}
// If this op is itself a create_* that just failed, remember its target path.
function dlMarkFailedCreate(op, set) { const p = dlCreatedPath(op); if (p) set.add(p); }
// Does this op target something under a create_* that already failed this drain?
// Returns that failed-create path (for cascadeOf), or null.
function dlCascadeParent(op, set) {
  if (!op || !op.body || !set.size) return null;
  const targets = [];
  if (op.body.path) targets.push(String(op.body.path));
  if (op.body.parent) targets.push(String(op.body.parent));
  for (const t of targets) {
    for (const f of set) {
      const fFolder = f.replace(/\.json$/, '');
      if (t === f || t === fFolder || t.startsWith(fFolder + '/')) return f;
    }
  }
  return null;
}

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
    await kvSet('tree', fresh);
    setTreeData(fresh); renderTree();
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

// Replay queued writes to the backend in FIFO order. Network/5xx failures stop the
// drain (still offline; op stays queued). A server that *rejects* an op — a terminal
// 4xx, a transient error that outlasts its retries, or a conflict-force that still
// errors — parks it as a dead-letter (never a bare shift() → never a silent drop).
// Reconciles the tree once the queue empties.
let flushing = false;
async function flushQueue() {
  if (flushing || !syncQueue.length) return;
  flushing = true;
  let conflicts = 0, dead = 0;
  const failedCreates = new Set(); // create_* ops that terminally failed this drain
  try {
    while (syncQueue.length) {
      const op = syncQueue[0];
      let res;
      try { res = await apiFetch(op.action, op.body, op.query); }
      catch (e) { setOffline(true); break; } // network/5xx → still offline, op stays queued

      // Save-conflict: the server refused a stale-baseMtime write (a concurrent edit
      // landed while we were offline). Re-send forced — save_page snapshots the prior
      // content into .history first, so the concurrent version is recoverable, never
      // lost. A forced resend that STILL errors is dead-lettered (never dropped); a
      // thrown resend means the backend went down again → stop, keep the op queued.
      if (op.action === 'save_page' && res && res.conflict) {
        let res2;
        try { res2 = await apiFetch('save_page', Object.assign({}, op.body, { force: true })); }
        catch (e) { setOffline(true); break; }
        if (res2 && res2.error) {
          if (res2._transient) {
            // Same transient policy as the normal-error path: a passing hiccup on the
            // forced resend gets the 3-attempt retry, not an immediate park.
            op.attempts = (op.attempts || 0) + 1;
            if (op.attempts >= 3) { await dlAdd(op, res2.error, 'retryable-exhausted'); syncQueue.shift(); await saveQueue(); dead++; continue; }
            await saveQueue(); break;
          }
          await dlAdd(op, res2.error, 'terminal'); dead++;
        } else conflicts++;
        syncQueue.shift(); await saveQueue(); updateOfflineBadge();
        continue;
      }

      if (res && res.error) {
        if (res._transient) {
          // Reachable server, transient body (a passing hiccup): retry across flush
          // cycles, then park. Don't spin in-loop — bump the counter, leave the op at
          // the head, and break so the next flush (probe / focus / online) retries.
          op.attempts = (op.attempts || 0) + 1;
          if (op.attempts >= 3) { await dlAdd(op, res.error, 'retryable-exhausted'); syncQueue.shift(); await saveQueue(); dead++; continue; }
          await saveQueue(); // persist the bumped attempts counter
          break;
        }
        // Terminal 4xx (bad name, missing parent, project-nesting rule …): can never
        // succeed as-is → park it, tagged with the failed-create it depended on (if any)
        // so the panel groups a failed subtree. Remember our own path if we're a create_*.
        const cascadeOf = dlCascadeParent(op, failedCreates);
        dlMarkFailedCreate(op, failedCreates);
        await dlAdd(op, res.error, cascadeOf ? 'cascade' : 'terminal', cascadeOf);
        syncQueue.shift(); await saveQueue(); dead++; continue;
      }

      syncQueue.shift();
      await saveQueue();
      updateOfflineBadge();
    }
    if (!syncQueue.length) {
      const fresh = await apiFetch('tree');     // reconcile cache with server truth
      await kvSet('tree', fresh);
      setTreeData(fresh); renderTree();
      if (dead) toast('Synced — ' + dead + ' change' + (dead === 1 ? '' : 's') + ' could not sync (review)');
      else if (conflicts) toast('Synced — ' + conflicts + ' conflict' + (conflicts === 1 ? '' : 's') + ' overwritten (prior versions in History)');
      else toast('Synced');
    }
  } finally { flushing = false; }
  updateOfflineBadge();
}

// Keep the IndexedDB mirror current after a successful backend call.
async function cacheOnSuccess(action, body, query, data) {
  try {
    if (action === 'tree') await kvSet('tree', data);
    else if (action === 'col_sorts') await kvSet('colsorts', data);
    else if (action === 'get_page') { const p = (body && body.path) || qparam(query, 'path'); if (p) { const copy = Object.assign({}, data); delete copy._mtime; await pageSet(p, copy); } }
    else if (action === 'save_page' && body) { const copy = Object.assign({}, body.data); delete copy._mtime; await pageSet(body.path, copy); }
    else if (action === 'delete' && body) await pageDel(body.path);
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
    case 'tree': return (await kvGet('tree')) || [];
    case 'col_sorts': return (await kvGet('colsorts')) || {};
    case 'get_page': {
      const p = (body && body.path) || qparam(query, 'path');
      return (await pageGet(p)) || { title: nameFromPath(p || ''), sections: [], _mtime: null };
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
      const prev = await pageGet(body.path);
      if (prev) await recordLocalHistory(body.path, prev); // version prior content
      await pageSet(body.path, copy);
      await enqueue({ action, body }); return { ok: true, offline: true, mtime: null };
    }
    case 'delete': {
      await recordLocalTrash(body.path); // snapshot before the cache clears it
      await mutateTreeCache(action, body);
      await enqueue({ action, body }); return { ok: true, offline: true };
    }
    case 'set_col_sort': {
      // Sorting is client-side, so just mirror the preference locally + replay later.
      const map = (await kvGet('colsorts')) || {};
      if (body && ['name', 'lang', 'kind'].includes(body.field)) map[body.parent || ''] = { field: body.field, dir: body.dir === 'desc' ? 'desc' : 'asc' };
      else if (body) delete map[body.parent || ''];
      await kvSet('colsorts', map);
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
    const tree = (await kvGet('tree')) || [];
    const node = findInTree(tree, path);
    const isDir = node ? node.type === 'folder' : !String(path).endsWith('.json');
    const name = String(path).split('/').pop().replace(/\.json$/, '');
    const data = isDir ? null : ((await pageGet(path)) || null);
    const list = (await kvGet('trash')) || [];
    list.unshift({
      id: 'local__' + Date.now() + '__' + name,
      origPath: path, name, deletedAt: Math.floor(Date.now() / 1000), isDir,
      data, node: node ? JSON.parse(JSON.stringify(node)) : null,
    });
    await kvSet('trash', list);
  } catch (e) {}
}

async function offlineListTrash() {
  const list = (await kvGet('trash')) || [];
  return list.map(e => ({ id: e.id, origPath: e.origPath, name: e.name, deletedAt: e.deletedAt, isDir: e.isDir }));
}

async function offlineRestoreTrash(body) {
  const id = body && body.id;
  const list = (await kvGet('trash')) || [];
  const idx = list.findIndex(e => e.id === id);
  if (idx === -1) return { error: 'offline: trash item not found' };
  const entry = list[idx];
  if (!entry.isDir && entry.data) await pageSet(entry.origPath, entry.data);
  await restoreNodeToTree(entry);
  // If the matching delete is still queued, cancelling it makes this a clean
  // no-op server-side; otherwise the delete already synced, so rebuild on replay.
  const qi = syncQueue.findIndex(op => op.action === 'delete' && op.body && op.body.path === entry.origPath);
  if (qi !== -1) { syncQueue.splice(qi, 1); await saveQueue(); }
  else { await enqueueReconstruct(entry); }
  list.splice(idx, 1); await kvSet('trash', list);
  updateOfflineBadge();
  return { ok: true, offline: true, path: entry.origPath };
}

// Re-insert a trashed node back into its original parent in the tree cache.
async function restoreNodeToTree(entry) {
  const tree = (await kvGet('tree')) || [];
  if (!findInTree(tree, entry.origPath)) {
    const parent = entry.origPath.includes('/') ? entry.origPath.slice(0, entry.origPath.lastIndexOf('/')) : '';
    const list = parent ? ((findInTree(tree, parent) || {}).children) : tree;
    if (list) {
      list.push(entry.node || (entry.isDir
        ? { type: 'folder', name: entry.name, path: entry.origPath, children: [] }
        : { type: 'page', name: entry.name, path: entry.origPath, tags: [], langs: [] }));
    }
  }
  await kvSet('tree', tree);
  setTreeData(tree); renderTree();
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
      if (n.project) await enqueue({ action: 'create_project', body: { name: n.name, parent: parentOf(n.path) } });
      else await enqueue({ action: 'create_folder', body: { parent: parentOf(n.path), name: n.name } });
      for (const c of (n.children || [])) await walk(c);
    } else {
      await enqueue({ action: 'create_page', body: { parent: parentOf(n.path), name: n.name } });
      const data = await pageGet(n.path);
      if (data) await enqueue({ action: 'save_page', body: { path: n.path, data, force: true } });
    }
  };
  if (entry.node) await walk(entry.node);
  else await enqueue({ action: 'create_folder', body: { parent: parentOf(entry.origPath), name: entry.name } });
}

// Offline empty only discards the local restore snapshots; any queued deletes
// still run on reconnect, so items remain recoverable from the server trash.
async function offlineEmptyTrash() {
  await kvSet('trash', []);
  return { ok: true, offline: true };
}

/* ---------- OFFLINE HISTORY (local snapshot log) ---------- */

const LOCAL_HISTORY_KEEP = 20;
// Local history is stored per page under a `history:<path>` kv key (the
// <NS>\x1F<kind>:<suffix> seam), NOT the single `history` blob any more — see
// migrateHistoryKeys for the boot migration off the old shape. Same {ts,size,data}
// entry shape; the array itself IS the key's value.
async function recordLocalHistory(path, content) {
  try {
    const json = JSON.stringify(content);
    const list = (await kvGet('history:' + path)) || [];
    list.unshift({ ts: Math.floor(Date.now() / 1000), size: json.length, data: content });
    await kvSet('history:' + path, list.slice(0, LOCAL_HISTORY_KEEP));
  } catch (e) {}
}

async function offlineListHistory(path) {
  const list = (await kvGet('history:' + path)) || [];
  return list.map(v => ({ ts: v.ts, size: v.size }));
}

async function offlineGetHistory(path, ts) {
  const list = (await kvGet('history:' + path)) || [];
  const v = list.find(x => String(x.ts) === String(ts));
  return v ? v.data : { error: 'offline: version not found' };
}

async function offlineRestoreHistory(body) {
  const path = body && body.path, ts = body && body.ts;
  const list = (await kvGet('history:' + path)) || [];
  const v = list.find(x => String(x.ts) === String(ts));
  if (!v) return { error: 'offline: version not found' };
  const cur = await pageGet(path);
  if (cur) await recordLocalHistory(path, cur); // snapshot current so restore is undoable
  await pageSet(path, v.data);
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
      if (String(c.key).startsWith(NS + NS_SEP)) {
        try { if (JSON.stringify(c.value).toLowerCase().includes(q)) out.push(c.key.slice(NS.length + NS_SEP.length)); } catch (er) {}
      }
      c.continue();
    };
    cur.onerror = () => res(out);
  });
}

// Aggregate tags from the cached tree (page nodes carry their tag list).
async function offlineListTags() {
  const tree = (await kvGet('tree')) || [];
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
      if (String(c.key).startsWith(NS + NS_SEP)) {
        try { collectBlocksFromPage(c.key.slice(NS.length + NS_SEP.length), c.value, q, out); } catch (er) {}
      }
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
  const tree = (await kvGet('tree')) || [];
  const childrenOf = (parent) => { if (!parent) return tree; const n = findInTree(tree, parent); return n ? (n.children || (n.children = [])) : null; };
  if (action === 'create_folder' || action === 'create_project') {
    const list = childrenOf(body.parent || ''); if (!list) return;
    const path = (body.parent ? body.parent + '/' : '') + body.name;
    if (!list.some(n => n.path === path)) list.unshift(Object.assign({ type: 'folder', name: body.name, path, children: [] }, action === 'create_project' ? { project: true } : {}));
  } else if (action === 'create_page') {
    const list = childrenOf(body.parent || ''); if (!list) return;
    const path = (body.parent ? body.parent + '/' : '') + body.name + '.json';
    if (!list.some(n => n.path === path)) list.push({ type: 'page', name: body.name, path, tags: [], langs: [] });
    await pageSet(path, { title: body.name, sections: [] });
  } else if (action === 'delete') {
    removeFromTree(tree, body.path); await pageDel(body.path);
  } else if (action === 'rename') {
    const node = findInTree(tree, body.path); if (!node) return;
    // Defensive: a malformed offline op with no newName would set node.name = undefined
    // and corrupt the cached card. The live rename always sends it, but skip the mutation
    // (leave the node intact) rather than trust the field — same posture as the DLQ guards.
    if (!body.newName) return;
    const parent = body.path.includes('/') ? body.path.slice(0, body.path.lastIndexOf('/')) : '';
    node.name = body.newName;
    const newPath = (parent ? parent + '/' : '') + (node.type === 'folder' ? body.newName : body.newName + '.json');
    const pairs = collectRepathPairs(node, newPath); // capture old→new BEFORE rePath mutates paths
    rePath(node, newPath);
    await rekeyCachedPaths(pairs); // move the cached page content + local history to the new keys
  } else if (action === 'move') {
    const node = findInTree(tree, body.path); if (!node) return;
    removeFromTree(tree, body.path);
    const dest = childrenOf(body.target || ''); if (!dest) return;
    const base = node.path.split('/').pop();
    const newPath = (body.target ? body.target + '/' : '') + base;
    const pairs = collectRepathPairs(node, newPath);
    rePath(node, newPath);
    dest.push(node);
    await rekeyCachedPaths(pairs);
  } else if (action === 'reorder') {
    const list = childrenOf(body.parent || ''); if (!list || !Array.isArray(body.order)) return;
    const key = (n) => n.type === 'folder' ? n.name : n.name + '.json';
    list.sort((a, b) => body.order.indexOf(key(a)) - body.order.indexOf(key(b)));
  }
  await kvSet('tree', tree);
  // In-place mutation above → route through setTreeData so the folder-aggregate memos
  // (keyed by node) are dropped; a stale count/tag summary would otherwise survive.
  setTreeData(tree); renderTree();
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
// The [{ old, neu }] path pairs a rePath(node, newPath) will produce — computed
// BEFORE rePath mutates node.path, so we can re-key the cached page content + local
// history that are keyed by the OLD paths. Mirrors rePath's descent exactly.
function collectRepathPairs(node, newPath) {
  const pairs = [{ old: node.path, neu: newPath }];
  (node.children || []).forEach(c => {
    pairs.push(...collectRepathPairs(c, newPath + '/' + (c.type === 'folder' ? c.name : c.name + '.json')));
  });
  return pairs;
}
// After an offline rename/move, follow the tree change through the OTHER caches: move
// each page's cached content and its local-history log from the old key to the new one
// (old key deleted), so opening the renamed/moved page offline shows its content and
// keeps its History — instead of a blank page keyed by a name that no longer exists.
async function rekeyCachedPaths(pairs) {
  try {
    for (const { old, neu } of pairs) {
      if (old === neu) continue;
      const page = await pageGet(old);
      if (page !== undefined) { await pageSet(neu, page); await pageDel(old); }
      // Local history moved with the page: per-page `history:<path>` keys (concat onto
      // any the destination already holds, then drop the old key).
      const hist = await kvGet('history:' + old);
      if (hist !== undefined) {
        const dst = (await kvGet('history:' + neu)) || [];
        await kvSet('history:' + neu, dst.concat(hist));
        await kvDel('history:' + old);
      }
    }
  } catch (e) {}
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

// Cached dead-letter count, refreshed on every badge update — lets the SYNCHRONOUS
// menu/command-palette builders decide whether to surface the review entry without an
// await. Dead-letters only ever appear after a flush attempt (which calls
// updateOfflineBadge), so this is fresh whenever there's anything to show.
let _dlCountCache = 0;
function dlCountCached() { return _dlCountCache; }

async function updateOfflineBadge() {
  let b = document.getElementById('offlineBadge');
  if (!b) {
    b = document.createElement('div'); b.id = 'offlineBadge'; b.className = 'offline-badge';
    // Operable by keyboard + assistive tech: it's a real control (opens the recovery
    // panel / forces a recheck), not just a status readout. role=button + tabindex make
    // it focusable; Enter/Space mirror the click.
    b.setAttribute('role', 'button');
    b.setAttribute('tabindex', '0');
    b.setAttribute('aria-live', 'polite');
    b.addEventListener('click', onBadgeClick);
    b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onBadgeClick(); } });
    document.body.appendChild(b);
  }
  const pending = syncQueue.length;
  let dl = 0;
  try { dl = await dlCount(); } catch (e) {}
  _dlCountCache = dl;
  if (!offlineState && !pending && !dl) { b.style.display = 'none'; b.setAttribute('aria-label', ''); return; }
  b.style.display = 'block';
  if (dl) {
    // Rejected data needs attention — a distinct, higher-urgency DANGER (red) state, so
    // it reads as more serious than routine amber "Offline / queued".
    b.textContent = '⚠ ' + dl + ' change' + (dl === 1 ? '' : 's') + ' could not sync — review';
    b.classList.add('danger'); b.classList.remove('warn');
  } else {
    b.textContent = offlineState
      ? (pending ? '⚠ Offline · ' + pending + ' change' + (pending === 1 ? '' : 's') + ' queued' : '⚠ Offline (local only)')
      : (pending ? '↻ Syncing ' + pending + '…' : '');
    b.classList.remove('danger');
    b.classList.toggle('warn', offlineState);
  }
  b.setAttribute('aria-label', b.textContent + (dl ? ' — activate to review' : ''));
}

// Badge activate (click / Enter / Space): dead-letters present → open the review panel;
// else force a recheck (probe the server when offline, or flush a pending queue).
function onBadgeClick() {
  dlCount().then(n => {
    if (n > 0 && typeof openDeadLetterPanel === 'function') openDeadLetterPanel();
    else if (offlineState) probeBackend();
    else if (syncQueue.length) flushQueue();
  }).catch(() => { if (offlineState) probeBackend(); else if (syncQueue.length) flushQueue(); });
}

// Recover on reconnection signals — but only a real probe success clears offline.
window.addEventListener('online', () => { if (offlineState) probeBackend(); else if (syncQueue.length) flushQueue(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && offlineState) probeBackend(); });
