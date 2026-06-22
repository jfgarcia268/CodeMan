/* ---------- TRASH & HISTORY (data-safety UI) ---------- */

// Generic scrolling list modal: title + a body the caller fills + footer buttons.
function openPanel(title, build) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const box = document.createElement('div');
  box.className = 'modal panel-modal';
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  function onKey(e) { if (e.key === 'Escape') close(); }
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);

  const head = document.createElement('div'); head.className = 'panel-head';
  const h = document.createElement('div'); h.className = 'modal-title'; h.textContent = title;
  const x = document.createElement('button'); x.className = 'secondary'; x.textContent = '✕'; x.onclick = close;
  head.append(h, x);
  const body = document.createElement('div'); body.className = 'panel-body';
  const foot = document.createElement('div'); foot.className = 'panel-foot modal-btns';
  box.append(head, body, foot);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  build(body, foot, close);
  return { close, body, foot };
}

function fmtTime(ts) {
  if (!ts) return '';
  try { return new Date(ts * 1000).toLocaleString(); } catch (e) { return String(ts); }
}

async function openTrash() {
  openPanel('Trash', async (body, foot, close) => {
    body.innerHTML = '<div class="panel-loading">Loading…</div>';
    const items = await api('list_trash');
    body.innerHTML = '';
    if (!items.length) { body.innerHTML = '<div class="panel-empty">Trash is empty</div>'; }
    items.forEach(it => {
      const row = document.createElement('div'); row.className = 'panel-row';
      const info = document.createElement('div'); info.className = 'panel-row-info';
      const nm = document.createElement('div'); nm.className = 'panel-row-name';
      nm.textContent = (it.isDir ? '📁 ' : '📄 ') + it.name;
      const sub = document.createElement('div'); sub.className = 'panel-row-sub';
      sub.textContent = (it.origPath || '') + ' · deleted ' + fmtTime(it.deletedAt);
      info.append(nm, sub);
      const restore = document.createElement('button'); restore.textContent = 'Restore';
      restore.onclick = async () => {
        const res = await api('restore_trash', { id: it.id });
        if (res && res.error) { toast(res.error); return; }
        toast('Restored'); await loadTree(); close(); openTrash();
      };
      row.append(info, restore);
      body.appendChild(row);
    });
    const empty = document.createElement('button'); empty.className = 'danger'; empty.textContent = 'Empty trash';
    empty.disabled = !items.length;
    empty.onclick = async () => {
      if (!await showConfirm('Permanently delete everything in the trash? This cannot be undone.', { okLabel: 'Empty trash' })) return;
      await api('empty_trash', {}); toast('Trash emptied'); close();
    };
    foot.appendChild(empty);
  });
}

async function openHistory(path) {
  openPanel('History — ' + nameFromPath(path), async (body, foot, close) => {
    body.innerHTML = '<div class="panel-loading">Loading…</div>';
    const versions = await api('list_history', undefined, 'path=' + encodeURIComponent(path));
    body.innerHTML = '';
    if (!versions.length) { body.innerHTML = '<div class="panel-empty">No saved versions yet</div>'; return; }
    versions.forEach((v, i) => {
      const row = document.createElement('div'); row.className = 'panel-row';
      const info = document.createElement('div'); info.className = 'panel-row-info';
      const nm = document.createElement('div'); nm.className = 'panel-row-name';
      nm.textContent = fmtTime(v.ts) + (i === 0 ? '  (most recent)' : '');
      const sub = document.createElement('div'); sub.className = 'panel-row-sub';
      sub.textContent = (v.size != null ? (v.size + ' bytes') : '');
      info.append(nm, sub);
      const diff = document.createElement('button'); diff.className = 'secondary'; diff.textContent = 'Diff';
      diff.title = 'Compare this version to the current page';
      diff.onclick = () => openHistoryDiff(path, v.ts);
      const restore = document.createElement('button'); restore.textContent = 'Restore';
      restore.onclick = async () => {
        if (!await showConfirm('Restore this version? The current content is snapshotted first, so you can undo.', { okLabel: 'Restore', danger: false })) return;
        const res = await api('restore_history', { path, ts: v.ts });
        if (res && res.error) { toast(res.error); return; }
        // reload the page content into the open tab
        const data = await api('get_page', undefined, 'path=' + encodeURIComponent(path));
        const m = data._mtime != null ? data._mtime : null; delete data._mtime;
        const tab = openPages.find(t => t.path === path);
        if (tab) { tab.data = data; tab.baseMtime = m; }
        if (activePath === path) { currentPageData = data; renderPage(); }
        await loadTree(); toast('Version restored'); close();
      };
      row.append(info, diff, restore);
      body.appendChild(row);
    });
  });
}

// Line-based diff (LCS) of two texts → [{ type:'same'|'add'|'del', text }].
// Used by the history diff viewer to show what changed between a saved version
// and the current page.
function lineDiff(aText, bText) {
  const a = String(aText).split('\n'), b = String(bText).split('\n');
  const n = a.length, m = b.length;
  // LCS length table (n and m are small — page-sized — so O(n*m) is fine).
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: 'same', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: a[i] }); i++; }
    else { out.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < n) { out.push({ type: 'del', text: a[i] }); i++; }
  while (j < m) { out.push({ type: 'add', text: b[j] }); j++; }
  return out;
}

// Compare a saved history version to the current page content, shown as a
// readable line diff (over the page's Markdown rendering).
async function openHistoryDiff(path, ts) {
  openPanel('Diff — ' + nameFromPath(path) + ' (' + fmtTime(ts) + ' → current)', async (body, foot, close) => {
    body.innerHTML = '<div class="panel-loading">Loading…</div>';
    // current = the open tab's live data if present, else fetch from disk
    let current = null;
    const tab = openPages.find(t => t.path === path);
    if (tab && tab.data) current = tab.data;
    else { const d = await api('get_page', undefined, 'path=' + encodeURIComponent(path)); delete d._mtime; current = d; }
    const oldData = await api('get_history_version', { path, ts });
    if (oldData && oldData.error) { body.innerHTML = '<div class="panel-empty">' + oldData.error + '</div>'; return; }
    const oldText = pageToMarkdown(oldData);
    const newText = pageToMarkdown(current);
    const rows = lineDiff(oldText, newText);
    const adds = rows.filter(r => r.type === 'add').length;
    const dels = rows.filter(r => r.type === 'del').length;
    body.innerHTML = '';
    const summary = document.createElement('div'); summary.className = 'diff-summary';
    summary.innerHTML = '<span class="diff-add-c">+' + adds + '</span> <span class="diff-del-c">−' + dels + '</span> lines';
    body.appendChild(summary);
    if (!adds && !dels) { const e = document.createElement('div'); e.className = 'panel-empty'; e.textContent = 'No differences — this version matches the current page'; body.appendChild(e); return; }
    const pre = document.createElement('div'); pre.className = 'diff-view';
    rows.forEach(r => {
      const ln = document.createElement('div');
      ln.className = 'diff-line ' + r.type;
      const sign = r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' ';
      ln.textContent = sign + ' ' + r.text;
      pre.appendChild(ln);
    });
    body.appendChild(pre);
  });
}

/* ---------- FAVORITES & RECENTLY COPIED ---------- */

let favorites;
try { favorites = new Set(JSON.parse(localStorage.getItem('codeman.favorites')) || []); } catch (e) { favorites = new Set(); }
function saveFavorites() { try { localStorage.setItem('codeman.favorites', JSON.stringify([...favorites])); } catch (e) {} }
function isFavorite(path) { return favorites.has(path); }
function toggleFavorite(path) {
  if (favorites.has(path)) favorites.delete(path); else favorites.add(path);
  saveFavorites();
}

let recentCopies;
try { recentCopies = JSON.parse(localStorage.getItem('codeman.recentCopies')) || []; } catch (e) { recentCopies = []; }
const RECENT_MAX = 25;
function recordCopy(block) {
  const entry = {
    code: block.code || '',
    label: block.label || '',
    type: block.type || 'plaintext',
    page: currentPagePath || '',
    ts: Date.now()
  };
  // de-dupe identical code, newest first, capped
  recentCopies = [entry, ...recentCopies.filter(r => r.code !== entry.code)].slice(0, RECENT_MAX);
  try { localStorage.setItem('codeman.recentCopies', JSON.stringify(recentCopies)); } catch (e) {}
}

function openFavorites() {
  openPanel('Favorites & Recently copied', (body, foot, close) => {
    body.innerHTML = '';
    // Favorite pages (skip ones that no longer exist)
    const existing = collectPagePaths(treeData, new Set());
    const favs = [...favorites].filter(p => existing.has(p));
    const favHead = document.createElement('div'); favHead.className = 'panel-section-head'; favHead.textContent = 'Favorite pages';
    body.appendChild(favHead);
    if (!favs.length) { const e = document.createElement('div'); e.className = 'panel-empty'; e.textContent = 'No favorites yet — star a page from its header'; body.appendChild(e); }
    favs.forEach(p => {
      const row = document.createElement('div'); row.className = 'panel-row';
      const info = document.createElement('div'); info.className = 'panel-row-info';
      const nm = document.createElement('div'); nm.className = 'panel-row-name'; nm.textContent = '⭐ ' + nameFromPath(p);
      const sub = document.createElement('div'); sub.className = 'panel-row-sub'; sub.textContent = p;
      info.append(nm, sub);
      const open = document.createElement('button'); open.textContent = 'Open';
      open.onclick = () => { openPage(p); close(); };
      const unstar = document.createElement('button'); unstar.className = 'secondary'; unstar.textContent = 'Unstar';
      unstar.onclick = () => { toggleFavorite(p); close(); openFavorites(); };
      row.append(info, open, unstar);
      body.appendChild(row);
    });
    // Recently copied
    const recHead = document.createElement('div'); recHead.className = 'panel-section-head'; recHead.textContent = 'Recently copied';
    body.appendChild(recHead);
    if (!recentCopies.length) { const e = document.createElement('div'); e.className = 'panel-empty'; e.textContent = 'Nothing copied yet'; body.appendChild(e); }
    recentCopies.forEach(r => {
      const row = document.createElement('div'); row.className = 'panel-row';
      const info = document.createElement('div'); info.className = 'panel-row-info';
      const nm = document.createElement('div'); nm.className = 'panel-row-name';
      const badge = document.createElement('span'); badge.className = 'lang-badge'; badge.style.background = langColor(r.type); badge.textContent = langLabel(r.type);
      const txt = document.createElement('span'); txt.textContent = ' ' + (r.label || r.code.split('\n')[0].slice(0, 60) || '(empty)');
      nm.append(badge, txt);
      const sub = document.createElement('div'); sub.className = 'panel-row-sub'; sub.textContent = r.page || '';
      info.append(nm, sub);
      const copy = document.createElement('button'); copy.textContent = 'Copy';
      copy.onclick = () => { copyText(r.code).then(ok => toast(ok ? 'Copied to clipboard' : 'Copy failed')); };
      row.append(info, copy);
      body.appendChild(row);
    });
    // footer: import / export all
    const imp = document.createElement('button'); imp.className = 'secondary'; imp.textContent = 'Import…';
    imp.onclick = () => importPages();
    const expAll = document.createElement('button'); expAll.className = 'secondary'; expAll.textContent = 'Export all (JSON)';
    expAll.onclick = () => exportAll();
    foot.append(imp, expAll);
  });
}

// Star toggle for the page header.
function buildFavStar(path) {
  const b = document.createElement('button');
  b.className = 'secondary fav-star' + (isFavorite(path) ? ' on' : '');
  b.textContent = isFavorite(path) ? '★' : '☆';
  b.title = isFavorite(path) ? 'Unstar this page' : 'Add to favorites';
  b.addEventListener('click', () => {
    toggleFavorite(path);
    b.classList.toggle('on', isFavorite(path));
    b.textContent = isFavorite(path) ? '★' : '☆';
    b.title = isFavorite(path) ? 'Unstar this page' : 'Add to favorites';
  });
  return b;
}

/* ---------- COMMAND PALETTE (⌘K / Ctrl+K quick-open) ---------- */

function openCommandPalette() {
  if (document.querySelector('.cmdk-overlay')) return;
  const pages = collectMatchingPages(treeData, '', []); // all pages
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay cmdk-overlay';
  const box = document.createElement('div'); box.className = 'cmdk-box';
  const input = document.createElement('input'); input.className = 'cmdk-input'; input.placeholder = 'Jump to a page…  (type > for commands)';
  const list = document.createElement('div'); list.className = 'cmdk-list';
  box.append(input, list);
  overlay.appendChild(box);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };
  let active = 0, results = [];

  // Command actions — surfaced when the query starts with ">". Each runs after
  // the palette closes (so dialogs/inline editors it opens aren't dismissed).
  const commands = [
    { name: 'New page', run: () => createPageHere() },
    { name: 'New folder', run: () => createFolderHere() },
    { name: 'New project', run: () => createProjectHere() },
    { name: 'Find & replace…', run: () => openReplace() },
    { name: 'Quick-paste a block…', run: () => openBlockPalette() },
    { name: 'Manage tags…', run: () => openTagManager() },
    { name: 'Toggle outline', run: () => toggleOutline() },
    { name: 'Toggle layout (single / double)', run: () => setSidebarMode(sidebarMode === 'single' ? 'double' : 'single') },
    { name: 'Rebuild index', run: () => rebuildIndex() },
    { name: 'Download all pages for offline', run: () => primeOfflineCache() },
    { name: 'Open trash…', run: () => openTrash() },
    { name: 'Open favorites…', run: () => openFavorites() },
    { name: 'Export current page → HTML', run: () => exportCurrentPage('html') },
    { name: 'Export current page → Markdown', run: () => exportCurrentPage('md') },
    { name: 'Export all pages → JSON', run: () => exportAll() },
    { name: 'Star / unstar current page', run: () => { if (currentPagePath) { toggleFavorite(currentPagePath); renderPage(); } } },
  ];

  function score(p, q) {
    const hay = (p.path + ' ' + (p.tags || []).join(' ') + ' ' + (p.langs || []).join(' ')).toLowerCase();
    return hay.includes(q);
  }
  function activate(r) { close(); if (r.kind === 'cmd') r.cmd.run(); else openPage(r.page.path); }
  function render() {
    const raw = input.value.trim();
    const cmdMode = raw.startsWith('>');
    const q = (cmdMode ? raw.slice(1) : raw).trim().toLowerCase();
    if (cmdMode) {
      results = (q ? commands.filter(c => c.name.toLowerCase().includes(q)) : commands).map(c => ({ kind: 'cmd', cmd: c }));
    } else {
      results = (q ? pages.filter(p => score(p, q)) : pages).slice(0, 50).map(p => ({ kind: 'page', page: p }));
    }
    if (active >= results.length) active = Math.max(0, results.length - 1);
    list.innerHTML = '';
    results.forEach((r, i) => {
      const row = document.createElement('div'); row.className = 'cmdk-row' + (i === active ? ' active' : '');
      const nm = document.createElement('div'); nm.className = 'cmdk-name';
      const sub = document.createElement('div'); sub.className = 'cmdk-sub';
      if (r.kind === 'cmd') { nm.textContent = '⌘  ' + r.cmd.name; sub.textContent = 'Command'; }
      else { nm.textContent = (isFavorite(r.page.path) ? '★ ' : '') + nameFromPath(r.page.path); sub.textContent = r.page.path; }
      row.append(nm, sub);
      row.addEventListener('mousemove', () => { if (active !== i) { active = i; render(); } });
      row.addEventListener('click', () => activate(r));
      list.appendChild(row);
    });
    if (!results.length) { list.innerHTML = '<div class="cmdk-empty">' + (cmdMode ? 'No commands' : 'No matches') + '</div>'; }
    const act = list.querySelector('.cmdk-row.active');
    if (act) act.scrollIntoView({ block: 'nearest' });
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, results.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (results[active]) activate(results[active]); }
  }
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
  input.addEventListener('input', render);
  render();
  input.focus();
}

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    // ⌘⇧K / Ctrl+Shift+K → quick-paste block palette; ⌘K → page quick-open.
    if (e.shiftKey) openBlockPalette(); else openCommandPalette();
  }
});

/* ---------- QUICK-PASTE PALETTE (⌘⇧K — find a block, copy it) ---------- */

function openBlockPalette() {
  if (document.querySelector('.cmdk-overlay')) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay cmdk-overlay';
  const box = document.createElement('div'); box.className = 'cmdk-box';
  const input = document.createElement('input'); input.className = 'cmdk-input';
  input.placeholder = 'Find a block to copy…  (Enter = copy, ⌘/Ctrl+Enter = open page)';
  const hint = document.createElement('div'); hint.className = 'cmdk-hint'; hint.textContent = 'Type at least 2 characters';
  const list = document.createElement('div'); list.className = 'cmdk-list';
  box.append(input, list, hint);
  overlay.appendChild(box);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };
  let active = 0, results = [], seq = 0, timer = null;

  function firstLine(b) { return (b.label || (b.code || '').split('\n').find(l => l.trim()) || '(empty)').slice(0, 80); }
  function render() {
    if (active >= results.length) active = Math.max(0, results.length - 1);
    list.innerHTML = '';
    results.forEach((b, i) => {
      const row = document.createElement('div'); row.className = 'cmdk-row block-row' + (i === active ? ' active' : '');
      const nm = document.createElement('div'); nm.className = 'cmdk-name';
      const badge = document.createElement('span'); badge.className = 'lang-badge';
      badge.style.background = b.note ? '#7a5cc0' : b.csv ? '#3a7a5c' : b.json ? '#3a5c7a' : langColor(b.type);
      badge.textContent = b.note ? 'Note' : b.csv ? 'CSV' : b.json ? 'JSON' : langLabel(b.type);
      const txt = document.createElement('span'); txt.textContent = ' ' + firstLine(b);
      nm.append(badge, txt);
      const sub = document.createElement('div'); sub.className = 'cmdk-sub'; sub.textContent = b.trail || b.path;
      row.append(nm, sub);
      row.addEventListener('mousemove', () => { if (active !== i) { active = i; render(); } });
      row.addEventListener('click', (e) => { (e.metaKey || e.ctrlKey) ? openHit(b) : copyHit(b); });
      list.appendChild(row);
    });
    const act = list.querySelector('.cmdk-row.active');
    if (act) act.scrollIntoView({ block: 'nearest' });
  }
  function copyHit(b) { copyText(b.code || '').then(ok => { if (ok) recordCopy(b); toast(ok ? 'Copied to clipboard' : 'Copy failed'); }); close(); }
  function openHit(b) { openPage(b.path); close(); }
  function search() {
    const q = input.value.trim();
    if (q.length < 2) { results = []; list.innerHTML = ''; hint.style.display = 'block'; return; }
    hint.style.display = 'none';
    const mySeq = ++seq;
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      const res = await api('search_blocks', undefined, 'q=' + encodeURIComponent(q));
      if (mySeq !== seq) return; // superseded
      results = Array.isArray(res) ? res : [];
      active = 0;
      if (!results.length) { list.innerHTML = '<div class="cmdk-empty">No matching blocks</div>'; return; }
      render();
    }, 180);
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, results.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (results[active]) { (e.metaKey || e.ctrlKey) ? openHit(results[active]) : copyHit(results[active]); } }
  }
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
  input.addEventListener('input', search);
  input.focus();
}

/* ---------- TAG MANAGER (rename / merge / delete tags across all pages) ---------- */

function openTagManager() {
  openPanel('Tags', async (body, foot, close) => {
    body.innerHTML = '<div class="panel-loading">Loading…</div>';
    const tags = await api('list_tags');
    body.innerHTML = '';
    if (!Array.isArray(tags) || !tags.length) { body.innerHTML = '<div class="panel-empty">No tags yet — add tags to a section</div>'; return; }
    // Sticky filter bar — narrow the (potentially long) tag list by substring.
    const searchWrap = document.createElement('div'); searchWrap.className = 'tag-search-wrap';
    const search = document.createElement('input'); search.className = 'tag-search';
    search.type = 'text'; search.placeholder = 'Filter tags…'; search.autocomplete = 'off';
    searchWrap.appendChild(search);
    body.appendChild(searchWrap);
    const note = document.createElement('div'); note.className = 'panel-section-head';
    body.appendChild(note);
    const listEl = document.createElement('div'); listEl.className = 'tag-list';
    body.appendChild(listEl);

    const applyRename = async (from, to) => {
      to = (to || '').trim();
      if (to === from) return;
      const res = await api('rename_tag', { from, to });
      if (res && res.error) { toast(res.error); return; }
      // Refresh open tabs so their in-memory tags match disk — otherwise the next
      // autosave of an already-open page would silently re-write the OLD tag back
      // (same open-tab reconciliation that Find & Replace does after replace_content).
      for (const tab of openPages) {
        const d = await api('get_page', undefined, 'path=' + encodeURIComponent(tab.path));
        if (d && !d.error) { const m = d._mtime != null ? d._mtime : null; delete d._mtime; tab.data = d; tab.baseMtime = m; if (tab.path === activePath) currentPageData = d; }
      }
      await loadTree(); // refresh sidebar badges/index
      if (activePath) renderPage();
      toast((to ? 'Renamed' : 'Deleted') + ' in ' + (res.pages || 0) + ' page' + (res.pages === 1 ? '' : 's'));
      close(); openTagManager();
    };

    const buildRow = (t) => {
      const row = document.createElement('div'); row.className = 'panel-row';
      const info = document.createElement('div'); info.className = 'panel-row-info';
      const nm = document.createElement('div'); nm.className = 'panel-row-name';
      const chip = document.createElement('span'); chip.className = 'tag-chip-static'; chip.textContent = t.tag;
      const cnt = document.createElement('span'); cnt.className = 'panel-row-sub'; cnt.textContent = '  ' + t.count + ' page' + (t.count === 1 ? '' : 's');
      nm.append(chip, cnt);
      info.appendChild(nm);

      const find = document.createElement('button'); find.className = 'secondary'; find.textContent = 'Find';
      find.title = 'Filter the sidebar by this tag';
      find.onclick = () => { const si = document.getElementById('searchInput'); if (si) { si.value = t.tag; updateSearch(); } close(); };
      const rename = document.createElement('button'); rename.className = 'secondary'; rename.textContent = 'Rename';
      rename.onclick = () => {
        // swap the row into an inline editor
        info.querySelectorAll('.tag-rename-input').forEach(n => n.remove());
        const inp = document.createElement('input'); inp.className = 'tag-rename-input'; inp.value = t.tag;
        let done = false;
        const commit = (save) => { if (done) return; done = true; if (save) applyRename(t.tag, inp.value); else { inp.remove(); } };
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') commit(true); if (e.key === 'Escape') commit(false); });
        inp.addEventListener('blur', () => commit(true));
        info.appendChild(inp); inp.focus(); inp.select();
      };
      const del = document.createElement('button'); del.className = 'danger'; del.textContent = 'Delete';
      del.onclick = async () => {
        if (!await showConfirm('Remove the tag "' + t.tag + '" from all ' + t.count + ' page' + (t.count === 1 ? '' : 's') + '?', { okLabel: 'Delete tag' })) return;
        applyRename(t.tag, '');
      };
      row.append(info, find, rename, del);
      return row;
    };

    function renderList() {
      const q = search.value.trim().toLowerCase();
      const shown = q ? tags.filter(t => t.tag.toLowerCase().includes(q)) : tags;
      note.textContent = (q ? shown.length + ' of ' + tags.length : tags.length) + ' tag'
        + ((q ? shown.length : tags.length) === 1 ? '' : 's') + ' · rename to an existing tag to merge them';
      listEl.innerHTML = '';
      if (!shown.length) { const e = document.createElement('div'); e.className = 'panel-empty'; e.textContent = 'No tags match "' + search.value.trim() + '"'; listEl.appendChild(e); return; }
      shown.forEach(t => listEl.appendChild(buildRow(t)));
    }
    search.addEventListener('input', renderList);
    renderList();
    setTimeout(() => search.focus(), 0);
  });
}

/* ---------- FIND & REPLACE (across all pages) ---------- */

function openReplace() {
  openPanel('Find & replace', (body, foot, close) => {
    body.innerHTML = '';
    const mkField = (labelText, ph) => {
      const wrap = document.createElement('div'); wrap.className = 'fr-field';
      const lab = document.createElement('label'); lab.textContent = labelText;
      const inp = document.createElement('input'); inp.className = 'fr-input'; inp.placeholder = ph || ''; inp.autocomplete = 'off';
      wrap.append(lab, inp); body.appendChild(wrap); return inp;
    };
    const findInp = mkField('Find', 'text or regex…');
    const replInp = mkField('Replace with', 'replacement ($1, $2 for regex groups)…');
    const optsRow = document.createElement('div'); optsRow.className = 'fr-opts';
    const rc = document.createElement('input'); rc.type = 'checkbox';
    const regexLbl = document.createElement('label'); regexLbl.className = 'fr-check'; regexLbl.append(rc, document.createTextNode(' Regex'));
    const cc = document.createElement('input'); cc.type = 'checkbox';
    const ciLbl = document.createElement('label'); ciLbl.className = 'fr-check'; ciLbl.append(cc, document.createTextNode(' Case-insensitive'));
    optsRow.append(regexLbl, ciLbl); body.appendChild(optsRow);
    const result = document.createElement('div'); result.className = 'fr-result'; body.appendChild(result);

    const params = () => ({ find: findInp.value, replace: replInp.value, regex: rc.checked, ci: cc.checked });
    const renderPreview = (res) => {
      result.innerHTML = '';
      const sum = document.createElement('div'); sum.className = 'fr-summary';
      sum.textContent = res.totalMatches + ' match' + (res.totalMatches === 1 ? '' : 'es')
        + ' in ' + res.pages.length + ' page' + (res.pages.length === 1 ? '' : 's');
      result.appendChild(sum);
      res.pages.slice(0, 60).forEach(p => { const row = document.createElement('div'); row.className = 'fr-page'; row.textContent = p.matches + '×  ·  ' + p.path; result.appendChild(row); });
    };
    const doPreview = async () => {
      if (!findInp.value) { result.textContent = 'Enter something to find'; return null; }
      result.innerHTML = '<div class="panel-loading">Searching…</div>';
      const res = await api('replace_content', Object.assign(params(), { preview: true }));
      if (res && res.error) { result.textContent = res.error; return null; }
      renderPreview(res); return res;
    };

    const previewBtn = document.createElement('button'); previewBtn.className = 'secondary'; previewBtn.textContent = 'Preview'; previewBtn.onclick = doPreview;
    const replaceBtn = document.createElement('button'); replaceBtn.className = 'danger'; replaceBtn.textContent = 'Replace all';
    replaceBtn.onclick = async () => {
      const pv = await doPreview();
      if (!pv) return;
      if (!pv.totalMatches) { toast('No matches'); return; }
      if (!await showConfirm('Replace ' + pv.totalMatches + ' match' + (pv.totalMatches === 1 ? '' : 'es')
        + ' across ' + pv.pages.length + ' page' + (pv.pages.length === 1 ? '' : 's')
        + '? Each changed page is snapshotted to History first.', { okLabel: 'Replace all', danger: true })) return;
      const res = await api('replace_content', params());
      if (res && res.error) { toast(res.error); return; }
      // refresh any open tabs whose content changed, so stale edits aren't re-saved
      const changed = new Set((res.pages || []).map(p => p.path));
      for (const tab of openPages) {
        if (!changed.has(tab.path)) continue;
        const d = await api('get_page', undefined, 'path=' + encodeURIComponent(tab.path));
        const m = d._mtime != null ? d._mtime : null; delete d._mtime;
        tab.data = d; tab.baseMtime = m;
        if (tab.path === activePath) currentPageData = d;
      }
      await loadTree();
      if (activePath) renderPage();
      toast('Replaced in ' + res.changedPages + ' page' + (res.changedPages === 1 ? '' : 's'));
      close();
    };
    foot.append(previewBtn, replaceBtn);
    findInp.addEventListener('keydown', e => { if (e.key === 'Enter') doPreview(); });
    setTimeout(() => findInp.focus(), 0);
  });
}

/* ---------- EXPORT / IMPORT ---------- */

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime || 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Render a page's sections/blocks to Markdown (headings + fenced code).
function pageToMarkdown(data) {
  const out = ['# ' + (data.title || 'Untitled'), ''];
  const walk = (sections, depth) => {
    (sections || []).forEach(sec => {
      const c = sectionContent(sec);
      out.push('#'.repeat(Math.min(depth, 6)) + ' ' + (sec.title || 'Untitled'));
      if (sec.tags && sec.tags.length) out.push('_tags: ' + sec.tags.join(', ') + '_');
      out.push('');
      c.blocks.forEach(b => {
        if (b.label) out.push('**' + b.label + '**');
        if (b.checklist) {
          (b.items || []).forEach(it => out.push('- [' + (it.done ? 'x' : ' ') + '] ' + (it.text || '')));
          out.push('');
        } else if (b.csv) {
          // emit a GitHub-flavoured Markdown table (first row = header)
          const { rows } = parseCsv(b.code || '');
          const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
          if (cols) {
            const cell = (v) => String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
            const fmt = (r) => '| ' + Array.from({ length: cols }, (_, c) => cell(r[c])).join(' | ') + ' |';
            out.push(fmt(rows[0] || []));
            out.push('| ' + Array.from({ length: cols }, () => '---').join(' | ') + ' |');
            for (let r = 1; r < rows.length; r++) out.push(fmt(rows[r]));
            out.push('');
          }
        } else if (b.json) {
          // pretty-print into a fenced json block; fall back to raw text if it won't parse
          const { ok, value } = parseJsonSafe(b.code || '');
          out.push('```json');
          out.push(ok ? formatJson(value) : (b.code || ''));
          out.push('```', '');
        } else if (b.rich) {
          // rich-text blocks hold HTML — emit the plain text for Markdown
          const tmp = document.createElement('div'); tmp.innerHTML = b.code || '';
          out.push((tmp.innerText || '').trim(), '');
        } else if (b.note) {
          // note blocks are already Markdown — emit verbatim, not fenced
          out.push(b.code || '', '');
        } else {
          out.push('```' + (b.type || ''));
          out.push(b.code || '');
          out.push('```', '');
        }
      });
      walk(c.subsections, depth + 1);
    });
  };
  walk(data.sections, 2);
  return out.join('\n');
}

// Render a page to a single self-contained HTML document: dark theme inlined,
// code Prism-highlighted (grammars that are loaded; plain-escaped otherwise),
// notes rendered as prose, and variables substituted. Opens/prints offline with
// no server. Cross-page [[links]] render as styled (non-clickable) text.
function pageToHtml(data) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const parts = [];
  const blockHtml = (b, secVals) => {
    const active = !!b.varsOn || !!secVals;
    const vals = b.varsOn ? (b.varValues || {}) : secVals;
    const code = active ? substituteVars(b.code, vals) : (b.code || '');
    if (b.label) parts.push('<div class="lbl">' + esc(b.label) + '</div>');
    if (b.checklist) {
      const rows = (b.items || []).map(it => '<li class="' + (it.done ? 'done' : '') + '"><input type="checkbox" disabled' + (it.done ? ' checked' : '') + '> ' + esc(it.text || '') + '</li>').join('');
      parts.push('<ul class="todo">' + rows + '</ul>'); return;
    }
    if (b.rich) { parts.push('<div class="rich">' + sanitizeRichHtml(b.code || '') + '</div>'); return; }
    if (b.note) { parts.push('<div class="note">' + renderMarkdown(code) + '</div>'); return; }
    if (b.csv) {
      const { rows } = parseCsv(b.code || '');
      const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
      if (!cols) { parts.push('<div class="csv-empty">(empty table)</div>'); return; }
      const cells = (r, tag) => Array.from({ length: cols }, (_, c) => '<' + tag + '>' + esc(r[c] == null ? '' : r[c]) + '</' + tag + '>').join('');
      const body = [];
      for (let r = 1; r < rows.length; r++) body.push('<tr>' + cells(rows[r], 'td') + '</tr>');
      parts.push('<div class="csv-wrap"><table class="csv"><thead><tr>' + cells(rows[0] || [], 'th') + '</tr></thead><tbody>' + body.join('') + '</tbody></table></div>');
      return;
    }
    if (b.json) {
      // pretty-printed, JSON-highlighted <pre> (a static tree is out of scope for export)
      const { ok, value } = parseJsonSafe(b.code || '');
      const pretty = ok ? formatJson(value) : (b.code || '');
      let html;
      try { const g = Prism.languages.json; html = g ? Prism.highlight(pretty, g, 'json') : esc(pretty); }
      catch (e) { html = esc(pretty); }
      parts.push('<pre class="code"><code>' + html + '</code></pre>');
      return;
    }
    const lang = langPrism(b.type);
    let html;
    try { const g = Prism.languages[lang]; html = g ? Prism.highlight(code, g, lang) : esc(code); }
    catch (e) { html = esc(code); }
    parts.push('<pre class="code"><code>' + html + '</code></pre>');
  };
  const walk = (sections, depth) => {
    (sections || []).forEach(sec => {
      const c = sectionContent(sec);
      const h = Math.min(depth, 6);
      parts.push('<h' + h + '>' + esc(sec.title || 'Untitled') + '</h' + h + '>');
      if (sec.tags && sec.tags.length) parts.push('<div class="tags">' + sec.tags.map(t => '<span class="tag">' + esc(t) + '</span>').join('') + '</div>');
      const secVals = (sec.varsOn && !c.blocks.some(b => b.varsOn)) ? (sec.varValues || {}) : null;
      c.blocks.forEach(b => blockHtml(b, secVals));
      walk(c.subsections, depth + 1);
    });
  };
  walk(data.sections, 2);
  const css = [
    'body{background:#1e1e1e;color:#ddd;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:900px;margin:0 auto;padding:32px 24px;line-height:1.5}',
    'h1{font-size:26px;border-bottom:1px solid #333;padding-bottom:10px}',
    'h2,h3,h4,h5,h6{margin-top:26px;color:#fff}',
    '.lbl{color:#888;font-size:13px;margin:10px 0 4px}',
    '.tags{margin:4px 0 8px}.tag{display:inline-block;background:#094771;color:#cfe3f5;font-size:11px;padding:2px 8px;border-radius:10px;margin-right:5px}',
    'pre.code{background:#252526;border:1px solid #333;border-radius:6px;padding:12px 14px;overflow-x:auto;font-size:13px;line-height:1.45}',
    'pre.code code{font-family:"SF Mono",Menlo,Consolas,monospace;white-space:pre}',
    '.note{background:#252526;border:1px solid #333;border-radius:6px;padding:2px 16px;margin:8px 0}',
    '.note pre{background:#1e1e1e;padding:10px 12px;border-radius:5px;overflow-x:auto}',
    '.note code{background:#1e1e1e;padding:1px 5px;border-radius:3px;color:#e0a060;font-family:"SF Mono",Menlo,Consolas,monospace;font-size:12px}',
    '.note blockquote{border-left:3px solid #0e639c;margin:8px 0;padding:4px 12px;color:#aaa}',
    '.note :is(h1,h2,h3,h4,h5,h6){border:0;padding:0;margin:12px 0 6px;color:#fff}.note h1{font-size:20px}.note h2{font-size:17px}.note h3{font-size:15px}.note :is(h4,h5,h6){font-size:13px}',
    '.note ul,.note ol{padding-left:22px;margin:8px 0}.note li{margin:3px 0}',
    '.note li.md-task{list-style:none;margin-left:-22px;padding-left:22px}.note li.md-task input{margin-right:7px}',
    '.note del,.note s{color:#888}.note img{max-width:100%;height:auto;border-radius:4px;margin:4px 0}.note a{color:#4ea0e0}',
    '.note table{border-collapse:collapse;margin:10px 0;display:block;overflow-x:auto;font-size:13px}.note th,.note td{border:1px solid #3a3d41;padding:5px 10px}.note th{background:#2d2d30;color:#fff;font-weight:600}',
    '.rich{background:#252526;border:1px solid #333;border-radius:6px;padding:10px 16px;margin:8px 0}',
    '.rich ul{list-style:disc;padding-left:24px}.rich ol{list-style:decimal;padding-left:24px}',
    '.rich ul ul{list-style:circle}.rich ul ul ul{list-style:square}.rich ol ol{list-style:lower-alpha}.rich ol ol ol{list-style:lower-roman}',
    '.rich blockquote{border-left:3px solid #0e639c;margin:8px 0;padding:4px 12px;color:#aaa}',
    '.rich a{color:#4ea0e0}',
    'ul.todo{list-style:none;padding-left:4px;margin:8px 0}ul.todo li{margin:4px 0}ul.todo li.done{color:#777;text-decoration:line-through}ul.todo input{margin-right:8px}',
    '.csv-wrap{overflow-x:auto;border:1px solid #333;border-radius:6px;margin:8px 0}',
    'table.csv{border-collapse:collapse;width:100%;font-size:13px}',
    'table.csv th,table.csv td{border:1px solid #3a3d41;padding:5px 10px;text-align:left;vertical-align:top;white-space:pre-wrap}',
    'table.csv thead th{background:#2d2d30;color:#fff;font-weight:600}',
    'table.csv tbody tr:nth-child(even) td{background:rgba(255,255,255,.02)}',
    '.csv-empty{color:#888;font-style:italic}',
    '.xlink{color:#8a7bd8}',
    'a{color:#4ea0e0}',
    // prism-tomorrow token colors (compact subset)
    '.token.comment,.token.prolog,.token.doctype,.token.cdata{color:#999}',
    '.token.punctuation{color:#ccc}',
    '.token.property,.token.tag,.token.boolean,.token.number,.token.constant,.token.symbol,.token.deleted{color:#e2777a}',
    '.token.selector,.token.attr-name,.token.string,.token.char,.token.builtin,.token.inserted{color:#a6e22e}',
    '.token.operator,.token.entity,.token.url{color:#67cdcc}',
    '.token.atrule,.token.attr-value,.token.keyword{color:#cc99cd}',
    '.token.function,.token.class-name{color:#f08d49}',
    '.token.regex,.token.important,.token.variable{color:#e90}'
  ].join('');
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'
    + esc(data.title || 'CodeMan') + '</title><style>' + css + '</style></head><body><h1>'
    + esc(data.title || 'Untitled') + '</h1>' + parts.join('\n') + '</body></html>';
}

// Small popup menu anchored under the Export button.
function exportMenu(anchor) {
  const existing = document.querySelector('.mini-menu');
  if (existing) { existing.remove(); return; }
  const menu = document.createElement('div'); menu.className = 'mini-menu';
  const r = anchor.getBoundingClientRect();
  menu.style.top = Math.round(r.bottom + 4) + 'px';
  menu.style.left = Math.round(r.left) + 'px';
  const opt = (label, fn) => { const o = document.createElement('div'); o.className = 'mini-menu-opt'; o.textContent = label; o.onclick = () => { menu.remove(); fn(); }; return o; };
  menu.append(
    opt('This page → HTML', () => exportCurrentPage('html')),
    opt('This page → Markdown', () => exportCurrentPage('md')),
    opt('This page → JSON', () => exportCurrentPage('json')),
    opt('All pages → JSON', () => exportAll())
  );
  document.body.appendChild(menu);
  const off = (e) => { if (!menu.contains(e.target) && e.target !== anchor) { menu.remove(); document.removeEventListener('mousedown', off); } };
  setTimeout(() => document.addEventListener('mousedown', off), 0);
}

// Sidebar "⋯ More" overflow menu — the utility actions that used to be cryptic
// header icons, now labeled rows (all also reachable from the ⌘K palette).
function openMoreMenu(anchor) {
  const existing = document.querySelector('.mini-menu');
  if (existing) { existing.remove(); return; }
  const menu = document.createElement('div'); menu.className = 'mini-menu';
  const r = anchor.getBoundingClientRect();
  menu.style.top = Math.round(r.bottom + 4) + 'px';
  // right-align under the ⋯ button so the menu stays tucked under the sidebar
  menu.style.left = Math.round(r.right) + 'px';
  menu.style.transform = 'translateX(-100%)';
  const opt = (icon, label, fn) => {
    const o = document.createElement('div'); o.className = 'mini-menu-opt';
    const ic = document.createElement('span'); ic.className = 'mm-ic'; ic.textContent = icon;
    const tx = document.createElement('span'); tx.textContent = label;
    o.append(ic, tx);
    o.onclick = () => { menu.remove(); fn(); };
    return o;
  };
  const sep = () => { const d = document.createElement('div'); d.className = 'mini-menu-sep'; return d; };
  menu.append(
    // everyday actions
    opt('★', 'Favorites & recently copied', () => openFavorites()),
    opt('🏷', 'Manage tags', () => openTagManager()),
    opt('⧉', 'Quick-paste block', () => openBlockPalette()),
    opt('🗑', 'Trash', () => openTrash()),
    sep(),
    // maintenance
    opt('⟳', 'Rebuild index', () => rebuildIndex(anchor)),
    opt('☁', 'Download for offline', () => primeOfflineCache())
  );
  // Sign-out — only when a shared-secret token is stored (password gate in use).
  if (typeof authToken !== 'undefined' && authToken) {
    menu.append(sep(), opt('⊗', 'Forget password (sign out)', () => signOut()));
  }
  document.body.appendChild(menu);
  const off = (e) => { if (!menu.contains(e.target) && e.target !== anchor) { menu.remove(); document.removeEventListener('mousedown', off); } };
  setTimeout(() => document.addEventListener('mousedown', off), 0);
}

// Rebuild the server-side metadata index (powers sidebar badges + name/tag/lang
// search). Optional btn spins while it runs (the ⋯ anchor when called from the menu).
async function rebuildIndex(btn) {
  if (btn) btn.classList.add('spinning');
  try {
    const res = await api('rebuild_index');
    if (res && res.offline) { toast('Offline — index will rebuild when you reconnect'); return; }
    await loadTree();
    toast('Index rebuilt' + (res && res.pages != null ? ' · ' + res.pages + ' pages' : ''));
  } catch (e) {
    toast('Rebuild failed');
  } finally {
    if (btn) btn.classList.remove('spinning');
  }
}

function exportCurrentPage(fmt) {
  if (!currentPagePath) { toast('Open a page first'); return; }
  const base = nameFromPath(currentPagePath);
  if (fmt === 'md') download(base + '.md', pageToMarkdown(currentPageData), 'text/markdown');
  else if (fmt === 'html') download(base + '.html', pageToHtml(currentPageData), 'text/html');
  else download(base + '.json', JSON.stringify(currentPageData, null, 2), 'application/json');
  toast('Exported ' + base);
}

// Export every page as one JSON bundle ({ path: pageData }).
async function exportAll() {
  toast('Bundling…');
  const paths = [...collectPagePaths(treeData, new Set())];
  const bundle = {};
  for (const p of paths) {
    const d = await api('get_page', undefined, 'path=' + encodeURIComponent(p));
    delete d._mtime;
    bundle[p] = d;
  }
  download('codeman-export-' + paths.length + '-pages.json', JSON.stringify(bundle, null, 2), 'application/json');
  toast('Exported ' + paths.length + ' pages');
}

// Import a single page JSON, or a bundle ({path: data}), creating pages.
function importPages() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.json,application/json';
  inp.onchange = async () => {
    const file = inp.files[0];
    if (!file) return;
    let parsed;
    try { parsed = JSON.parse(await file.text()); } catch (e) { toast('Invalid JSON'); return; }
    const items = (parsed && parsed.sections) // single page
      ? { [nameFromPath(file.name)]: parsed }
      : parsed; // assume bundle of { path: data }
    let n = 0;
    for (const [rel, data] of Object.entries(items)) {
      if (!data || !Array.isArray(data.sections)) continue;
      const clean = rel.replace(/\.json$/, '');
      const parts = clean.split('/');
      const name = parts.pop();
      const parent = parts.join('/');
      // build any missing parent folders
      let acc = '';
      for (const seg of parts) { acc = acc ? acc + '/' + seg : seg; await api('create_folder', { parent: acc.slice(0, acc.lastIndexOf('/')) || '', name: seg }); }
      const res = await api('create_page', { parent, name });
      if (res && res.error) continue;
      await api('save_page', { path: (parent ? parent + '/' : '') + name + '.json', data });
      n++;
    }
    await loadTree();
    toast('Imported ' + n + ' page' + (n === 1 ? '' : 's'));
  };
  inp.click();
}
