/* ---------- TREE ---------- */

const EXPANDED_KEY = 'codeman.expandedFolders';
let expandedFolders;
try {
  expandedFolders = new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY)) || []);
} catch (e) {
  expandedFolders = new Set();
}
function saveExpanded() {
  try { localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expandedFolders])); } catch (e) {}
}
let treeData = [];
// Per-column sort preferences for the double (Miller) layout, keyed by folder path
// (''=root) → { field:'name'|'lang'|'kind', dir:'asc'|'desc' }. Source of truth is the
// server (.colsort.json, fetched in loadTree); a missing entry = manual/default order.
// Sorting runs client-side (sortMillerChildren) so it also works offline.
let colSort = {};
// Folder the toolbar's +Folder/+Page act on in single-column mode (clicked folder).
let selectedFolder = localStorage.getItem('codeman.selectedFolder') || '';
// In-progress inline creation: { kind: 'folder'|'page', parent: '<folderPath>' }.
let pendingNew = null;
let searchQuery = '';
let sidebarMode = localStorage.getItem('codeman.sidebarMode') || 'double'; // 'single' | 'double'; double is the desktop default
// On phones the Miller (double) layout can't fit, so the *effective* mode is
// forced to single while body.is-mobile is set — without clobbering the user's
// persisted desktop preference. All render/navigation logic reads effectiveMode().
function isMobileView() { return document.body.classList.contains('is-mobile'); }
function effectiveMode() { return isMobileView() ? 'single' : sidebarMode; }
// Miller-column navigation: chain of open folder paths (column 0 is always root).
let columnPath = [];
try { columnPath = JSON.parse(localStorage.getItem('codeman.columnPath')) || []; } catch (e) { columnPath = []; }
function saveColumnPath() {
  try { localStorage.setItem('codeman.columnPath', JSON.stringify(columnPath)); } catch (e) {}
}
// Miller layout shows a fixed window of exactly 2 equal-width columns (the current
// folder + its parent). Deeper paths page through via the left/right window rails.
const MILLER_COLS = 2;
let millerWindowStart = 0;        // index of the leftmost visible column
let millerSnapRight = true;       // on navigation, snap the window to the deepest column
const MILLER_MIN_COL = 160;       // smallest usable column width (px)
// Per-column vertical scroll, keyed by the column's folder path so it survives
// re-renders, window paging, and reloads.
let millerColScroll = {};
try { millerColScroll = JSON.parse(localStorage.getItem('codeman.millerColScroll')) || {}; } catch (e) { millerColScroll = {}; }
let millerScrollSaveTimer = null;
function saveMillerColScroll() {
  if (millerScrollSaveTimer) clearTimeout(millerScrollSaveTimer);
  millerScrollSaveTimer = setTimeout(() => {
    try { localStorage.setItem('codeman.millerColScroll', JSON.stringify(millerColScroll)); } catch (e) {}
  }, 250);
}
function millerEffCount() { return MILLER_COLS; }
let deepSearch = localStorage.getItem('codeman.deepSearch') === '1'; // search inside page content
let deepMatches = new Set();  // page paths whose content matched (deep search), capped for render
const DEEP_MATCH_CAP = 200;   // render at most this many content matches — a term matching most of
                              // a large library would otherwise paint thousands of rows (~1.5s jank)
let deepMatchTotal = 0;       // total content matches before the cap, for the "refine your search" note

// Returns a pruned copy of the tree containing only pages whose name matches
// the query, plus the folders needed to reach them.
function pageMatches(node, q) {
  if (node.name.toLowerCase().includes(q)) return true;
  if ((node.tags || []).some(t => t.toLowerCase().includes(q))) return true;
  // match code type by key (e.g. "soql") or display label (e.g. "JavaScript")
  if ((node.langs || []).some(l => l.toLowerCase().includes(q) || langLabel(l).toLowerCase().includes(q))) return true;
  // deep search: page content matched on the server
  return deepSearch && deepMatches.has(node.path);
}

function filterTree(nodes, q) {
  const out = [];
  nodes.forEach(node => {
    if (node.type === 'page') {
      if (pageMatches(node, q)) out.push(node);
    } else {
      const children = filterTree(node.children || [], q);
      if (children.length) out.push(Object.assign({}, node, { children }));
    }
  });
  return out;
}

// Mark all ancestor folders of a page path as expanded so it stays visible.
function expandAncestors(pagePath) {
  const parts = pagePath.split('/');
  parts.pop(); // drop the file name
  let acc = '';
  parts.forEach(p => {
    acc = acc ? acc + '/' + p : p;
    expandedFolders.add(acc);
  });
  saveExpanded();
}

async function loadTree() {
  treeData = await api('tree');
  try { colSort = (await api('col_sorts')) || {}; } catch (e) { colSort = colSort || {}; }
  renderTree();
}

async function moveItem(srcPath, targetFolder) {
  if (!srcPath) return;
  // Ignore drop onto the folder it already lives in.
  const srcParent = srcPath.includes('/') ? srcPath.slice(0, srcPath.lastIndexOf('/')) : '';
  if (srcParent === targetFolder) return;
  // A project may only nest inside another project or sit at the root — never in
  // a plain folder.
  const srcNode = nodeAtPath(srcPath);
  if (srcNode && srcNode.project && !isValidProjectParent(targetFolder)) {
    toast('Projects can only go in another project or the top level'); return;
  }
  const res = await api('move', { path: srcPath, target: targetFolder });
  if (res.error) { toast(res.error); return; }
  // Track the moved page's new path so it stays selected/visible.
  const name = srcPath.includes('/') ? srcPath.slice(srcPath.lastIndexOf('/') + 1) : srcPath;
  const newPath = (targetFolder ? targetFolder + '/' : '') + name;
  if (name.endsWith('.json')) { updateOpenPath(srcPath, newPath); renderMainTabs(); }
  if (targetFolder) { expandedFolders.add(targetFolder); saveExpanded(); }
  toast('Moved');
  await loadTree();
}

function attachRootDrop(container) {
  container.ondragover = (e) => {
    if (e.target === container) { e.preventDefault(); container.classList.add('drop-root'); }
  };
  container.ondragleave = (e) => {
    if (e.target === container) container.classList.remove('drop-root');
  };
  container.ondrop = (e) => {
    if (e.target === container) {
      e.preventDefault();
      container.classList.remove('drop-root');
      moveItem(e.dataTransfer.getData('text/plain'), '');
    }
  };
}

// Direct children of a folder path ('' = root).
function folderChildren(path) {
  if (!path) return treeData;
  let found = null;
  (function walk(nodes) {
    for (const n of nodes) {
      if (n.type === 'folder') {
        if (n.path === path) { found = n.children || []; return; }
        walk(n.children || []);
      }
    }
  })(treeData);
  return found || [];
}

// Sort a column's children by a saved preference (pure — returns a new array).
// field: 'name' (case-insensitive), 'lang' (page primary code-type; folders sort as
// '' so they group together), 'kind' (project<folder<page). dir flips the result.
// Ties always break on name so the order is stable.
function sortMillerChildren(children, pref) {
  if (!pref || !pref.field) return children.slice();
  const kindRank = n => n.type === 'folder' ? (n.project ? 0 : 1) : 2;
  const langKey = n => n.type === 'page' ? ((n.langs || []).slice().sort()[0] || '').toLowerCase() : '';
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  const cmp = (a, b) => {
    let d = 0;
    if (pref.field === 'kind') d = kindRank(a) - kindRank(b);
    else if (pref.field === 'lang') d = langKey(a).localeCompare(langKey(b));
    if (d === 0) d = byName(a, b);
    return d;
  };
  const out = children.slice().sort(cmp);
  if (pref.dir === 'desc') out.reverse();
  return out;
}

// Persist a column's sort choice (field='manual' clears it → back to default order).
// Optimistic: update the in-memory map + re-render now, then write to the server.
function setColSort(parentPath, field, dir) {
  if (field === 'manual') delete colSort[parentPath];
  else colSort[parentPath] = { field, dir };
  renderTree();
  api('set_col_sort', { parent: parentPath, field, dir });
}

// The tree node at a given path (or null).
function nodeAtPath(path) {
  if (!path) return null;
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  return folderChildren(parent).find(n => n.path === path) || null;
}

// Cumulative path prefixes for a path, e.g. "a/b/c" → ["a","a/b","a/b/c"].
function pathPrefixes(path) {
  if (!path) return [];
  const parts = path.split('/');
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

// The project ancestors of a path, outermost → nearest (a path's own node counts
// if it's a project). Projects nest only in projects/root, so this is a prefix.
function projectChain(path) {
  return pathPrefixes(path).map(nodeAtPath).filter(n => n && n.project);
}

// A project may be created/moved/reordered only at the root ('') or inside another
// project — never inside a plain folder.
function isValidProjectParent(path) { return !path || !!nodeAtPath(path)?.project; }

// Mark a folder as the create target (highlight + toolbar +Folder/+Page target).
function setSelectedFolder(path) {
  selectedFolder = path;
  try { localStorage.setItem('codeman.selectedFolder', path); } catch (e) {}
}
function selectFolder(path) {
  setSelectedFolder(path);
  renderTree();
}

// Navigate the sidebar to a folder/project (used by the open page's path crumbs).
function navigateToFolder(path) {
  setSelectedFolder(path);
  if (effectiveMode() === 'double') {
    setColumnPathTo(path); // drill columns so the folder's contents show
  } else {
    const parts = (path || '').split('/').filter(Boolean);
    let acc = '';
    parts.forEach(p => { acc = acc ? acc + '/' + p : p; expandedFolders.add(acc); });
    saveExpanded();
  }
  renderTree();
}

// In double (Miller) mode, is this folder's column currently on screen?
function isFolderVisibleDouble(path) {
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  return [''].concat(columnPath).includes(parent);
}

// Root row for the folder column (represents '').
// Counts for a folder: direct subfolders, direct pages, and total pages (deep).
function folderCounts(node) {
  let folders = 0, pages = 0, totalPages = 0;
  (node.children || []).forEach(c => { c.type === 'folder' ? folders++ : pages++; });
  (function deep(n) {
    (n.children || []).forEach(c => { c.type === 'page' ? totalPages++ : deep(c); });
  })(node);
  return { folders, pages, totalPages };
}

// Aggregate code types (all) and the 5 most common tags across every page
// anywhere inside a folder/project.
function folderMeta(node) {
  const langs = new Set();
  const tagCounts = {};
  (function deep(n) {
    (n.children || []).forEach(c => {
      if (c.type === 'page') {
        (c.langs || []).forEach(l => langs.add(l));
        (c.tags || []).forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; });
      } else deep(c);
    });
  })(node);
  const topTags = Object.keys(tagCounts).sort((a, b) => tagCounts[b] - tagCounts[a]).slice(0, 5);
  return { langs: [...langs], topTags };
}

/* ---------- MILLER (Finder) COLUMNS — double layout ---------- */

// Drop column-path entries that no longer resolve to a real folder chain.
function sanitizeColumnPath() {
  // Don't touch the persisted path before the tree has loaded — early renders
  // (toggle setup) would otherwise wipe it against an empty treeData.
  if (!treeData.length) return;
  const valid = [];
  let parent = '';
  for (const p of columnPath) {
    const kids = folderChildren(parent).filter(c => c.type === 'folder').map(c => c.path);
    if (kids.includes(p)) { valid.push(p); parent = p; } else break;
  }
  // never keep an empty folder as the deepest column (no "Empty" column),
  // unless it's hosting a pending new item (then we want it visible to edit).
  while (valid.length && folderChildren(valid[valid.length - 1]).length === 0
         && !(pendingNew && pendingNew.parent === valid[valid.length - 1])) valid.pop();
  if (valid.length !== columnPath.length) { columnPath = valid; saveColumnPath(); }
}

function renderMiller(host, q) {
  host.classList.add('miller');
  // per-column scroll is tracked by the scroll listener (millerColScroll) and
  // re-applied per column on render, so it survives re-renders and reloads.
  host.innerHTML = '';
  const crumb = document.createElement('div');
  crumb.className = 'miller-crumb';
  const body = document.createElement('div');
  body.className = 'miller-body';
  host.append(crumb, body);

  if (q) {
    crumb.textContent = 'Search results';
    const cols = document.createElement('div'); cols.className = 'miller-cols';
    cols.appendChild(renderMillerSearchColumn(q));
    body.appendChild(cols);
    return;
  }

  sanitizeColumnPath();

  // breadcrumb (full path — context even when left columns are windowed out).
  // Each segment is color-coded by type: project (purple), folder (teal), root.
  const mkSeg = (label, depth) => {
    const s = document.createElement('span');
    s.className = 'crumb-seg';
    if (depth === 0) s.classList.add('crumb-root');
    else { const n = nodeAtPath(columnPath[depth - 1]); s.classList.add(n && n.project ? 'crumb-project' : 'crumb-folder'); }
    s.textContent = label;
    s.addEventListener('click', () => { columnPath = columnPath.slice(0, depth); saveColumnPath(); setSelectedFolder(depth ? columnPath[depth - 1] : ''); millerSnapRight = true; renderTree(); });
    return s;
  };
  crumb.appendChild(mkSeg('Root', 0));
  columnPath.forEach((p, i) => {
    const sep = document.createElement('span'); sep.className = 'crumb-sep'; sep.textContent = '›';
    crumb.append(sep, mkSeg(p.slice(p.lastIndexOf('/') + 1), i + 1));
  });

  // Fixed window of equal-width columns — no scrolling. Snap to the deepest
  // column after navigation; the left/right rails page the window otherwise.
  const total = columnPath.length + 1;          // root + one per drilled folder
  const xEff = Math.min(millerEffCount(), total);
  if (millerSnapRight) millerWindowStart = total - xEff;
  millerWindowStart = Math.max(0, Math.min(millerWindowStart, total - xEff));
  millerSnapRight = false;

  // Whenever the current location is inside one or more projects, show the full
  // project chain (outermost → nearest); each segment jumps to that project.
  const ctxPath = selectedFolder || (columnPath.length ? columnPath[columnPath.length - 1] : '');
  const chain = projectChain(ctxPath);
  if (chain.length) {
    const banner = document.createElement('div');
    banner.className = 'project-banner';
    banner.title = 'Project';
    const ic = document.createElement('span'); ic.className = 'pb-icon'; ic.textContent = '\u{1F4E6}';
    banner.appendChild(ic);
    chain.forEach((pn, i) => {
      if (i) { const sep = document.createElement('span'); sep.className = 'pb-sep'; sep.textContent = '›'; banner.appendChild(sep); }
      const seg = document.createElement('span'); seg.className = 'pb-seg'; seg.textContent = pn.name;
      seg.addEventListener('click', () => {
        columnPath = pathPrefixes(pn.path);
        setSelectedFolder(pn.path);
        millerSnapRight = true;
        saveColumnPath();
        renderTree();
      });
      banner.appendChild(seg);
    });
    host.insertBefore(banner, body);
  }

  const hasLeft = millerWindowStart > 0;
  const hasRight = millerWindowStart + xEff < total;
  if (hasLeft) body.appendChild(makeWindowRail('left'));

  const cols = document.createElement('div');
  cols.className = 'miller-cols';
  const allParents = [''].concat(columnPath);   // global depth = index
  for (let depth = millerWindowStart; depth < millerWindowStart + xEff; depth++) {
    cols.appendChild(renderMillerColumn(allParents[depth], depth, depth === total - 1));
  }
  body.appendChild(cols);

  if (hasRight) body.appendChild(makeWindowRail('right'));
}

// Thin rail that pages the visible window one column left/right (non-destructive;
// the drilled path is unchanged, you're just sliding what's on screen).
function makeWindowRail(dir) {
  const rail = document.createElement('div');
  rail.className = 'miller-rail miller-rail-' + dir;
  rail.title = dir === 'left' ? 'Show previous column' : 'Show next column';
  rail.textContent = dir === 'left' ? '‹' : '›';
  rail.addEventListener('click', () => {
    millerWindowStart += (dir === 'left' ? -1 : 1);
    renderTree();
  });
  return rail;
}

function renderMillerColumn(parentPath, depth, isLast) {
  const col = document.createElement('div');
  col.className = 'miller-col';
  col.dataset.parent = parentPath;
  // equal-width columns fill the sidebar; only vertical scroll, kept per folder
  col.addEventListener('scroll', () => { millerColScroll[parentPath] = col.scrollTop; saveMillerColScroll(); });
  if (millerColScroll[parentPath]) {
    setTimeout(() => { col.scrollTop = millerColScroll[parentPath]; }, 0);
  }
  col.addEventListener('dragover', e => { if (e.target === col) { e.preventDefault(); col.classList.add('drop-into'); } });
  col.addEventListener('dragleave', e => { if (e.target === col) col.classList.remove('drop-into'); });
  col.addEventListener('drop', e => {
    if (e.target === col) { e.preventDefault(); col.classList.remove('drop-into'); moveItem(e.dataTransfer.getData('text/plain'), parentPath); }
  });
  // Click empty space in a column to close the folder it drilled into (and any
  // columns to the right), sliding the window left.
  col.addEventListener('click', e => {
    if (e.target !== col) return;             // only the column's own empty area
    if (columnPath.length <= depth) return;   // nothing open from here
    columnPath = columnPath.slice(0, depth);
    setSelectedFolder(depth ? columnPath[depth - 1] : '');
    millerSnapRight = true;
    saveColumnPath();
    renderTree();
  });

  const children = folderChildren(parentPath);
  const folders = children.filter(c => c.type === 'folder');
  const pages = children.filter(c => c.type === 'page');
  const selectedChild = columnPath[depth];
  const pending = pendingNew && pendingNew.parent === parentPath;
  const pref = colSort[parentPath];

  if (!folders.length && !pages.length && !pending) {
    const e = document.createElement('div'); e.className = 'tree-empty'; e.textContent = 'Empty';
    col.appendChild(e);
    return col;
  }

  // Per-column sort control (only worth showing once there's something to sort).
  if (folders.length || pages.length) col.appendChild(renderColSortHead(parentPath, pref));

  const addFolder = f => {
    const card = renderMillerFolderCard(f, depth, f.path === selectedChild || f.path === selectedFolder);
    attachColumnReorder(card, f, parentPath, true); // folders also accept "move into"
    col.appendChild(card);
  };
  const addPage = p => {
    // renderTreeNode already wires the page row's drag/drop (attachColumnReorder at
    // its end). Re-wiring here added a SECOND drop handler whose clearDndOn nulled
    // dndZone before the first read it → "before" drops silently landed "after".
    col.appendChild(renderTreeNode(p));            // rich page card (drag wired inside)
  };

  if (pref && pref.field) {
    // Active sort → one flat, intermixed list (no folders/pages divider).
    sortMillerChildren(children, pref).forEach(n => n.type === 'folder' ? addFolder(n) : addPage(n));
  } else {
    // Default → folders first, divider, then pages (manual/.order.json order).
    folders.forEach(addFolder);
    if (folders.length && pages.length) {
      const d = document.createElement('div'); d.className = 'miller-divider';
      col.appendChild(d);
    }
    pages.forEach(addPage);
  }
  if (pending) col.appendChild(buildPendingRow());
  return col;
}

// Labels for the sort fields, shown in the header chip + menu.
const COL_SORT_FIELDS = [
  { field: 'name', label: 'Name' },
  { field: 'lang', label: 'Code-type' },
  { field: 'kind', label: 'Kind' }
];
function colSortLabel(pref) {
  if (!pref || !pref.field) return null;
  const f = COL_SORT_FIELDS.find(x => x.field === pref.field);
  return (f ? f.label : pref.field) + ' ' + (pref.dir === 'desc' ? '↓' : '↑');
}

// Slim header at the top of each Miller column: a sort button showing the active
// choice (or ⇅ when default). Click opens the sort menu.
function renderColSortHead(parentPath, pref) {
  const head = document.createElement('div');
  head.className = 'miller-col-head';
  const btn = document.createElement('button');
  btn.className = 'col-sort-btn' + (pref && pref.field ? ' active' : '');
  btn.title = 'Sort this column';
  btn.textContent = pref && pref.field ? '⇅ ' + colSortLabel(pref) : '⇅';
  btn.addEventListener('click', e => { e.stopPropagation(); buildColSortMenu(btn, parentPath); });
  head.appendChild(btn);
  return head;
}

// Sort menu for a column (reuses the .mini-menu pattern). Offers each field × asc/desc,
// then "Manual order" to clear. The current choice is marked.
function buildColSortMenu(anchor, parentPath) {
  const existing = document.querySelector('.mini-menu');
  if (existing) { existing.remove(); return; }
  const pref = colSort[parentPath];
  const menu = document.createElement('div'); menu.className = 'mini-menu';
  const r = anchor.getBoundingClientRect();
  menu.style.top = Math.round(r.bottom + 4) + 'px';
  menu.style.left = Math.round(r.left) + 'px';
  const opt = (label, active, fn) => {
    const o = document.createElement('div'); o.className = 'mini-menu-opt' + (active ? ' active' : '');
    const ic = document.createElement('span'); ic.className = 'mm-ic'; ic.textContent = active ? '✓' : '';
    const tx = document.createElement('span'); tx.textContent = label;
    o.append(ic, tx);
    o.onclick = () => { menu.remove(); fn(); };
    return o;
  };
  const sep = () => { const d = document.createElement('div'); d.className = 'mini-menu-sep'; return d; };
  COL_SORT_FIELDS.forEach(f => {
    ['asc', 'desc'].forEach(dir => {
      const active = pref && pref.field === f.field && pref.dir === dir;
      menu.append(opt(f.label + ' ' + (dir === 'desc' ? '↓' : '↑'), active, () => setColSort(parentPath, f.field, dir)));
    });
  });
  menu.append(sep(), opt('Manual order', !(pref && pref.field), () => setColSort(parentPath, 'manual')));
  document.body.appendChild(menu);
  const off = (e) => { if (!menu.contains(e.target) && e.target !== anchor) { menu.remove(); document.removeEventListener('mousedown', off); } };
  setTimeout(() => document.addEventListener('mousedown', off), 0);
}

/* ---------- DRAG-TO-SORT (Miller columns) ---------- */

let dndRow = null, dndZone = null;
function clearDndOn(el) {
  if (el) el.classList.remove('reorder-before', 'reorder-after', 'drop-target');
  if (dndRow === el) { dndRow = null; dndZone = null; }
}
function clearDnd() { if (dndRow) clearDndOn(dndRow); }
document.addEventListener('dragend', clearDnd);

// Add drop handling to a column card/row: drop on the top/bottom edge reorders
// (insert before/after); drop on the middle of a folder moves the item into it.
function attachColumnReorder(el, node, parentPath, allowInto) {
  el.addEventListener('dragover', e => {
    e.preventDefault();
    e.stopPropagation();
    const r = el.getBoundingClientRect();
    const y = e.clientY - r.top;
    const zone = (allowInto && y > r.height * 0.32 && y < r.height * 0.68)
      ? 'into' : (y < r.height / 2 ? 'before' : 'after');
    if (dndRow && dndRow !== el) clearDndOn(dndRow);
    el.classList.remove('reorder-before', 'reorder-after', 'drop-target');
    el.classList.add(zone === 'into' ? 'drop-target' : 'reorder-' + zone);
    dndRow = el; dndZone = zone;
  });
  el.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    const src = e.dataTransfer.getData('text/plain');
    const zone = dndZone;
    clearDndOn(el);
    if (!src || src === node.path) return;
    if (zone === 'into') moveItem(src, node.path);
    else dropReorder(src, parentPath, node, zone);
  });
}

// Reorder srcPath within parentPath relative to refNode (before/after),
// moving it into parentPath first if it lived elsewhere.
async function dropReorder(srcPath, parentPath, refNode, pos) {
  const srcName = srcPath.split('/').pop();
  const refName = refNode.path.split('/').pop();
  const srcParent = srcPath.includes('/') ? srcPath.slice(0, srcPath.lastIndexOf('/')) : '';
  if (srcName === refName && srcParent === parentPath) return;
  // A project can be reordered among root items or among items inside another
  // project — never inside a plain folder.
  const srcNode = nodeAtPath(srcPath);
  if (srcNode && srcNode.project && !isValidProjectParent(parentPath)) {
    toast('Projects can only go in another project or the top level'); return;
  }
  if (srcParent !== parentPath) {
    const res = await api('move', { path: srcPath, target: parentPath });
    if (res && res.error) { toast(res.error); return; }
  }
  let list = folderChildren(parentPath).map(n => n.path.split('/').pop()).filter(n => n !== srcName);
  const idx = list.indexOf(refName);
  if (idx === -1) { await loadTree(); return; }
  list.splice(pos === 'before' ? idx : idx + 1, 0, srcName);
  await api('reorder', { parent: parentPath, order: list });
  // Dragging means "I want a manual order" — drop any active sort on this column.
  if (colSort[parentPath]) { delete colSort[parentPath]; api('set_col_sort', { parent: parentPath, field: 'manual' }); }
  if (srcParent !== parentPath && srcName.endsWith('.json')) {
    updateOpenPath(srcPath, (parentPath ? parentPath + '/' : '') + srcName);
    renderMainTabs();
  }
  await loadTree();
}

// Folder shown as the amber card (drill-in via Miller columns); projects get a
// more prominent treatment.
function renderMillerFolderCard(node, depth, selected) {
  const c = folderCounts(node);
  const el = document.createElement('div');
  el.className = 'subfolder-card' + (selected ? ' selected' : '') + (node.project ? ' project-card' : '');
  el.setAttribute('role', 'treeitem');
  el.tabIndex = -1;
  el.dataset.path = node.path;
  el.setAttribute('aria-label', node.name + (node.project ? ' project' : ' folder'));
  if (selected) el.setAttribute('aria-selected', 'true');
  el.draggable = true;
  el.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', node.path); e.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging'); document.body.classList.toggle('dragging-project', !!node.project); });
  el.addEventListener('dragend', () => { el.classList.remove('dragging'); document.body.classList.remove('dragging-project'); });
  // drop handling (reorder edges + "move into" middle) is wired by attachColumnReorder

  const icon = document.createElement('span'); icon.className = 'sf-icon'; icon.textContent = node.project ? '\u{1F4E6}' : '\u{1F4C1}';
  const body = document.createElement('div'); body.className = 'sf-body';
  const name = document.createElement('div'); name.className = 'sf-name'; name.title = node.name;
  const nameText = document.createElement('span'); nameText.className = 'sf-name-text'; nameText.textContent = node.name;
  name.appendChild(nameText); // text truncates; the PROJECT ::after badge stays visible beside it
  const meta = document.createElement('div'); meta.className = 'sf-meta';
  const parts = [];
  if (c.folders) parts.push(c.folders + (c.folders > 1 ? ' folders' : ' folder'));
  if (c.totalPages) parts.push(c.totalPages + (c.totalPages === 1 ? ' page' : ' pages')); // recursive
  if (!parts.length) parts.push('empty');
  meta.textContent = parts.join(' · ');
  body.append(name, meta);

  // aggregated code types (all) + 5 most common tags from everything inside
  const agg = folderMeta(node);
  if (agg.langs.length) {
    const langRow = document.createElement('div');
    langRow.className = 'sf-meta-row sf-langs';
    agg.langs.forEach(l => {
      const b = document.createElement('span');
      b.className = 'lang-badge';
      b.style.background = langColor(l);
      b.textContent = langLabel(l);
      langRow.appendChild(b);
    });
    body.appendChild(langRow);
  }
  if (agg.topTags.length) {
    const tagRow = document.createElement('div');
    tagRow.className = 'sf-meta-row sf-tags';
    agg.topTags.forEach(t => {
      const c2 = document.createElement('span');
      c2.className = 'card-tag';
      c2.textContent = t;
      tagRow.appendChild(c2);
    });
    body.appendChild(tagRow);
  }

  const actions = document.createElement('span'); actions.className = 'sf-actions';
  const rn = mkBtn('✎', () => startInlineRename(node, name, el)); actions.appendChild(rn);
  const del = document.createElement('span'); del.className = 'tree-del'; del.textContent = '🗑'; del.title = 'Delete';
  del.addEventListener('click', e => { e.stopPropagation(); deleteItem(node); });
  actions.appendChild(del);

  const isEmpty = (node.children || []).length === 0;
  if (isEmpty) el.classList.add('empty');
  const arrow = document.createElement('span'); arrow.className = 'sf-arrow'; arrow.textContent = isEmpty ? '' : '›';
  el.append(icon, body, actions, arrow);

  el.addEventListener('click', e => {
    if (e.target.closest('.sf-actions') || e.target.tagName === 'INPUT') return;
    setSelectedFolder(node.path); // selectable as the create target either way
    if (isEmpty) {
      // selecting an empty folder doesn't open a column; it also replaces the
      // drilled child of this column, so close any columns deeper than it.
      columnPath = columnPath.slice(0, depth);
    } else {
      columnPath = columnPath.slice(0, depth).concat([node.path]);
    }
    millerSnapRight = true; // keep the newly-relevant column on screen
    saveColumnPath();
    renderTree();
  });
  name.addEventListener('dblclick', e => { e.stopPropagation(); startInlineRename(node, name, el); });
  return el;
}

function renderMillerSearchColumn(q) {
  const col = document.createElement('div');
  col.className = 'miller-col miller-col-wide';
  const pages = collectMatchingPages(treeData, q, []);
  if (!pages.length) {
    const e = document.createElement('div'); e.className = 'tree-empty'; e.textContent = 'No matching pages';
    col.appendChild(e);
    return col;
  }
  pages.forEach(p => col.appendChild(renderTreeNode(p)));  // rich page cards
  return col;
}

// All matching pages anywhere in the tree (used by double-column search).
function collectMatchingPages(nodes, q, out) {
  nodes.forEach(n => {
    if (n.type === 'page') { if (pageMatches(n, q)) out.push(n); }
    else if (n.children) collectMatchingPages(n.children, q, out);
  });
  return out;
}

/* ---------- TREE KEYBOARD NAV & ROLES (accessibility) ----------
   The tree is built from <div>s; these give it real treeitem semantics and make it
   keyboard-operable. Enter/Space activate any row (BOTH layouts); the single-column
   tree additionally gets Up/Down/Left/Right roving navigation. Activating a folder
   re-renders the tree (selectFolder → renderTree), so we restore focus by data-path. */
let treeKbdBound = false;
function bindTreeKeys(container) {
  if (treeKbdBound) return;            // attach once — renderTree only swaps innerHTML
  treeKbdBound = true;
  container.addEventListener('keydown', onTreeKeydown);
}
function visibleTreeItems(container) {
  return Array.from(container.querySelectorAll('[role="treeitem"]')).filter(el => el.offsetParent !== null);
}
function focusTreeItem(items, i) {
  const el = items[Math.max(0, Math.min(i, items.length - 1))];
  if (!el) return;
  items.forEach(x => { x.tabIndex = -1; });
  el.tabIndex = 0; el.focus();
}
// Activate a row (click), then restore keyboard focus to the equivalent row by path
// since folder activation rebuilds the tree.
function activateTreeItem(container, item) {
  const path = item.dataset.path;
  item.click();
  const items = visibleTreeItems(container);
  const after = items.find(x => x.dataset.path === path);
  if (after) focusTreeItem(items, items.indexOf(after));
}
// Keep exactly ONE row tabbable (open page → selected folder → first row) so Tab lands
// in the tree and arrows take over. Never steals focus on its own (mouse-safe).
function initRovingTabindex(container) {
  const items = visibleTreeItems(container);
  if (!items.length || items.some(el => el.tabIndex === 0)) return;
  const preferred = container.querySelector('.tree-row.active[role="treeitem"], .subfolder-card.selected[role="treeitem"], [role="treeitem"][aria-selected="true"]');
  (preferred && items.includes(preferred) ? preferred : items[0]).tabIndex = 0;
}
function onTreeKeydown(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return; // don't hijack inline edit
  const container = e.currentTarget;
  const item = e.target.closest('[role="treeitem"]');
  const k = e.key;
  if (k === 'Enter' || k === ' ' || k === 'Spacebar') { if (item) { e.preventDefault(); activateTreeItem(container, item); } return; }
  if (effectiveMode() === 'double') return;  // arrow nav is single-column only (Miller is a drill UI)
  const items = visibleTreeItems(container);
  if (!items.length) return;
  const idx = item ? items.indexOf(item) : -1;
  if (k === 'ArrowDown') { e.preventDefault(); focusTreeItem(items, idx + 1); }
  else if (k === 'ArrowUp') { e.preventDefault(); focusTreeItem(items, idx - 1); }
  else if (k === 'Home') { e.preventDefault(); focusTreeItem(items, 0); }
  else if (k === 'End') { e.preventDefault(); focusTreeItem(items, items.length - 1); }
  else if (k === 'ArrowRight' && item) {
    const exp = item.getAttribute('aria-expanded');
    if (exp === 'false') { e.preventDefault(); activateTreeItem(container, item); }       // expand
    else if (exp === 'true') { e.preventDefault(); focusTreeItem(items, idx + 1); }        // into first child
  }
  else if (k === 'ArrowLeft' && item) {
    if (item.getAttribute('aria-expanded') === 'true') { e.preventDefault(); activateTreeItem(container, item); return; } // collapse
    e.preventDefault();                                                                    // else jump to parent
    const nodeEl = item.closest('.tree-node');
    const parentRow = nodeEl && nodeEl.parentElement.closest('.tree-node') && nodeEl.parentElement.closest('.tree-node').querySelector(':scope > .tree-row[role="treeitem"]');
    if (parentRow) focusTreeItem(items, items.indexOf(parentRow));
  }
}

function renderTree() {
  const container = document.getElementById('tree');
  container.setAttribute('role', 'tree');
  bindTreeKeys(container);
  const pageCol = document.getElementById('pageCol');
  const area = document.getElementById('treeArea');
  area.classList.toggle('double', effectiveMode() === 'double');
  // Expand/Collapse-all only act on the single-column tree; flag the mode so the
  // footer can hide them in double (Miller) layout where they do nothing.
  document.body.classList.toggle('mode-double', effectiveMode() === 'double');
  updateLayoutToggle();
  renderSingleProjectBanner();
  updateSearchCapNote();
  const q = searchQuery.trim().toLowerCase();

  if (effectiveMode() === 'double') {
    pageCol.style.display = 'none';
    renderMiller(container, q); // clears + restores its own scroll internally
    initRovingTabindex(container);
    return;
  }

  // single column: preserve vertical scroll across the re-render
  const prevScrollTop = container.scrollTop;
  container.innerHTML = '';
  container.classList.remove('miller');
  pageCol.style.display = 'none';
  const nodes = q ? filterTree(treeData, q) : treeData;
  if (q && !nodes.length) {
    container.innerHTML = '<div class="tree-empty">No matching pages</div>';
    return;
  }
  renderTreeNodes(nodes, container);
  if (pendingNew && pendingNew.parent === '') container.appendChild(buildPendingRow());
  attachRootDrop(container);
  container.scrollTop = prevScrollTop;
  initRovingTabindex(container);
}

// Non-silent truncation: when a content search matches more pages than we render,
// tell the user how many are shown vs found and to refine — never silently drop matches.
function updateSearchCapNote() {
  const note = document.getElementById('searchCapNote');
  if (!note) return;
  const capped = deepSearch && deepMatchTotal > deepMatches.size;
  if (capped) {
    note.textContent = 'Showing first ' + deepMatches.size + ' of ' + deepMatchTotal + ' content matches — refine your search';
    note.hidden = false;
  } else {
    note.hidden = true;
    note.textContent = '';
  }
}

function updateLayoutToggle() {
  const sw = document.getElementById('layoutToggle');
  if (sw) sw.classList.toggle('on', effectiveMode() === 'double');
}

// Single-column project context: a compact project-chain banner pinned above the
// tree (the Miller banner is double-mode only — single & mobile users need this).
function renderSingleProjectBanner() {
  const area = document.getElementById('treeArea');
  const existing = document.getElementById('singleProjectBanner');
  if (existing) existing.remove();
  if (effectiveMode() !== 'single') return;
  const ctx = selectedFolder
    || (currentPagePath && currentPagePath.includes('/') ? currentPagePath.slice(0, currentPagePath.lastIndexOf('/')) : '');
  const chain = projectChain(ctx);
  if (!chain.length) return;
  const banner = document.createElement('div');
  banner.className = 'project-banner';
  banner.id = 'singleProjectBanner';
  banner.title = 'Project';
  const ic = document.createElement('span'); ic.className = 'pb-icon'; ic.textContent = '\u{1F4E6}';
  banner.appendChild(ic);
  chain.forEach((pn, i) => {
    if (i) { const sep = document.createElement('span'); sep.className = 'pb-sep'; sep.textContent = '›'; banner.appendChild(sep); }
    const seg = document.createElement('span'); seg.className = 'pb-seg'; seg.textContent = pn.name;
    seg.addEventListener('click', () => { setSelectedFolder(pn.path); expandedFolders.add(pn.path); saveExpanded(); renderTree(); });
    banner.appendChild(seg);
  });
  area.insertBefore(banner, document.getElementById('tree'));
}

function setSidebarMode(mode) {
  sidebarMode = mode;
  try { localStorage.setItem('codeman.sidebarMode', mode); } catch (e) {}
  renderTree();
}

function renderTreeNodes(nodes, container, opts) {
  opts = opts || {};
  nodes.forEach(node => {
    if (opts.foldersOnly && node.type !== 'folder') return;
    container.appendChild(renderTreeNode(node, opts));
  });
}

function renderTreeNode(node, opts) {
  opts = opts || {};
  const el = document.createElement('div');
  el.className = 'tree-node';

  const row = document.createElement('div');
  row.className = 'tree-row';
  row.setAttribute('role', 'treeitem');
  row.tabIndex = -1; // roving: initRovingTabindex() promotes one row to 0 each render
  row.dataset.path = node.path;
  row.setAttribute('aria-label', node.name + (node.type === 'folder' ? (node.project ? ' project' : ' folder') : ' page'));
  if (node.type === 'page' && node.path === currentPagePath) { row.classList.add('active'); row.setAttribute('aria-selected', 'true'); }

  const chevron = document.createElement('span');
  chevron.className = 'tree-chevron';
  // Show the arrow only when there's something to expand. In the folder-only
  // column that means having SUBFOLDERS; otherwise any child (folder or page).
  let showArrow = false;
  if (node.type === 'folder') {
    const children = node.children || [];
    showArrow = opts.foldersOnly
      ? children.some(c => c.type === 'folder')
      : children.length > 0;
  }
  chevron.textContent = showArrow ? '▸' : '';

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.textContent = node.type === 'folder' ? '\u{1F4C1}' : '\u{1F4C4}';

  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = node.name;

  const actions = document.createElement('span');
  actions.className = 'tree-actions';

  if (node.type === 'folder') {
    const addFolderBtn = mkBtn('+F', () => createFolder(node.path));
    const addPageBtn = mkBtn('+P', () => createPage(node.path));
    actions.append(addFolderBtn, addPageBtn);
  }
  const renameBtn = mkBtn('✎', () => startInlineRename(node, label, row));
  actions.append(renameBtn);

  // always-visible small delete icon
  const delIcon = document.createElement('span');
  delIcon.className = 'tree-del';
  delIcon.textContent = '🗑';
  delIcon.title = 'Delete';
  delIcon.addEventListener('click', (e) => { e.stopPropagation(); deleteItem(node); });

  if (node.type === 'folder') {
    row.classList.add('is-folder');
    if (node.project) { row.classList.add('is-project'); icon.textContent = '\u{1F4E6}'; }
    // page-count badge (folder column only) so you can see which folders hold pages
    let countBadge = null;
    if (opts.foldersOnly) {
      const n = folderCounts(node).pages; // direct pages only — matches the cards shown
      if (n) {
        countBadge = document.createElement('span');
        countBadge.className = 'folder-count';
        countBadge.textContent = n;
        countBadge.title = n + (n === 1 ? ' page directly in this folder' : ' pages directly in this folder');
      }
    }
    row.append(chevron, icon, label, actions, ...(countBadge ? [countBadge] : []), delIcon);
  } else {
    // Page card: optional folder breadcrumb + top line + meta lines
    row.classList.add('is-page');

    const parts = node.path.split('/');
    parts.pop(); // drop filename
    {
      // Always show a location crumb (root pages read "Root") so two pages that
      // share a display name are distinguishable at a glance.
      const crumb = document.createElement('div');
      crumb.className = 'card-crumb';
      crumb.textContent = parts.length ? parts.join(' › ') : 'Root';
      row.appendChild(crumb);
    }

    const top = document.createElement('div');
    top.className = 'card-top';
    top.append(icon, label, actions, delIcon);
    row.appendChild(top);

    const langs = node.langs || [];
    const tags = node.tags || [];
    if (langs.length) {
      const langRow = document.createElement('div');
      langRow.className = 'card-meta card-langs';
      langs.forEach(l => {
        const b = document.createElement('span');
        b.className = 'lang-badge';
        b.style.background = langColor(l);
        b.textContent = langLabel(l);
        langRow.appendChild(b);
      });
      row.appendChild(langRow);
    }
    if (tags.length) {
      const tagRow = document.createElement('div');
      tagRow.className = 'card-meta card-tags';
      tags.forEach(t => {
        const c = document.createElement('span');
        c.className = 'card-tag';
        c.textContent = t;
        tagRow.appendChild(c);
      });
      row.appendChild(tagRow);
    }
  }
  el.appendChild(row);

  // --- drag source ---
  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', node.path);
    e.dataTransfer.effectAllowed = 'move';
    row.classList.add('dragging');
    document.body.classList.toggle('dragging-project', !!node.project);
  });
  row.addEventListener('dragend', () => { row.classList.remove('dragging'); document.body.classList.remove('dragging-project'); });

  // --- drop target: reorder on the row's edges, "move into" in the middle
  // (folders) or just reorder (pages). Shared with the Miller-column layout. ---
  const rowParent = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '';
  attachColumnReorder(row, node, rowParent, node.type === 'folder');

  let childrenEl;
  if (node.type === 'folder') {
    if (node.path === selectedFolder) row.classList.add('selected');
    childrenEl = document.createElement('div');
    childrenEl.className = 'tree-children';
    const forceOpen = searchQuery.trim() !== '';
    // keep the folder open while it hosts a pending new child
    const hasPending = pendingNew && pendingNew.parent === node.path;
    const isOpen = forceOpen || hasPending || expandedFolders.has(node.path);
    childrenEl.style.display = isOpen ? 'block' : 'none';
    if (isOpen) row.classList.add('expanded');
    if (showArrow) row.setAttribute('aria-expanded', String(isOpen));
    // open vs closed folder glyph as the primary expansion cue (projects keep 📦)
    if (!node.project) icon.textContent = isOpen ? '\u{1F4C2}' : '\u{1F4C1}';
    renderTreeNodes(node.children || [], childrenEl, opts);
    if (hasPending && !opts.foldersOnly) childrenEl.appendChild(buildPendingRow());
    el.appendChild(childrenEl);

    const toggleExpand = () => {
      const open = childrenEl.style.display === 'none';
      childrenEl.style.display = open ? 'block' : 'none';
      row.classList.toggle('expanded', open);
      if (showArrow) row.setAttribute('aria-expanded', String(open));
      if (!node.project) icon.textContent = open ? '\u{1F4C2}' : '\u{1F4C1}';
      if (open) expandedFolders.add(node.path);
      else expandedFolders.delete(node.path);
      saveExpanded();
    };
    if (opts.foldersOnly) {
      chevron.addEventListener('click', (e) => { e.stopPropagation(); toggleExpand(); });
      row.addEventListener('click', (e) => {
        if (e.target.closest('.tree-actions') || e.target.tagName === 'INPUT') return;
        selectFolder(node.path);
      });
    } else {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.tree-actions') || e.target.tagName === 'INPUT') return;
        if (e.target === row || e.target === label || e.target === icon) toggleExpand();
        selectFolder(node.path); // mark as target for the toolbar's +Folder/+Page
      });
    }
  } else {
    row.addEventListener('click', (e) => {
      // open unless clicking an action button or the inline rename input
      if (e.target.closest('.tree-actions') || e.target.tagName === 'INPUT') return;
      openPage(node.path);
    });
    // double-click the name to rename inline
    label.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startInlineRename(node, label, row);
    });
  }

  return el;
}

function mkBtn(text, onClick) {
  const b = document.createElement('button');
  b.textContent = text;
  b.className = 'secondary';
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

// Folder that the sidebar header's +Folder/+Page buttons create into.
function selectedTargetFolder() {
  if (effectiveMode() === 'double') {
    // a selected folder that's on screen (incl. a non-drillable empty one) wins;
    // otherwise fall back to the deepest drilled column.
    if (selectedFolder && isFolderVisibleDouble(selectedFolder)) return selectedFolder;
    return columnPath.length ? columnPath[columnPath.length - 1] : '';
  }
  return selectedFolder || '';
}
function createFolderHere() { createFolder(selectedTargetFolder()); }
function createPageHere() { createPage(selectedTargetFolder()); }
// Projects may only be created at the root or inside another project — never in a
// plain folder. Block invalid spots rather than silently relocating.
function createProjectHere() {
  const t = selectedTargetFolder();
  if (!isValidProjectParent(t)) {
    toast('Projects can only be created at the top level or inside another project');
    return;
  }
  startInlineCreate('project', t);
}

function createFolder(parent) { startInlineCreate('folder', parent || ''); }
function createPage(parent) { startInlineCreate('page', parent || ''); }

// Show an editable, in-position row for a new folder/page instead of a dialog.
function startInlineCreate(kind, parent) {
  pendingNew = { kind, parent };
  if (effectiveMode() === 'double') {
    setColumnPathTo(parent);
  } else if (parent) {
    expandedFolders.add(parent);
    saveExpanded();
  }
  renderTree(); // injection happens during render (see mountPendingNew points)
}

async function commitPendingNew(name) {
  if (!pendingNew) return;
  const { kind, parent } = pendingNew;
  pendingNew = null;
  if (kind === 'folder' || kind === 'project') {
    const res = await api(kind === 'project' ? 'create_project' : 'create_folder', { parent, name });
    if (res && res.error) toast(res.error);
    await loadTree();
  } else {
    const res = await api('create_page', { parent, name });
    if (res && res.error) { toast(res.error); await loadTree(); return; }
    await loadTree();
    openPage((parent ? parent + '/' : '') + name + '.json');
  }
}

function cancelPendingNew() {
  pendingNew = null;
  renderTree();
}

// Editable row for the pending new folder/page, placed inside its parent.
// It mirrors the shape of a real folder/page so the slot matches what's being
// created: a folder bar / amber card for folders, a page card for pages.
function buildPendingRow() {
  const kind = pendingNew.kind;
  const isProject = kind === 'project';
  const isFolderish = kind === 'folder' || isProject;

  const input = document.createElement('input');
  input.className = 'pending-input';
  input.placeholder = isProject ? 'New project name' : kind === 'folder' ? 'New folder name' : 'New page name';
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (commit && v) commitPendingNew(v);
    else cancelPendingNew();
  };
  input.addEventListener('click', e => e.stopPropagation());
  input.addEventListener('mousedown', e => e.stopPropagation());
  input.title = 'Enter to create · Esc to cancel';
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  // Click-away cancels (was: auto-commit on blur, which surprised users). The ✓/✕
  // buttons preventDefault on mousedown so their click lands before this blur fires.
  input.addEventListener('blur', () => finish(false));

  const ok = document.createElement('button'); ok.className = 'pending-ok'; ok.textContent = '✓'; ok.title = 'Create (Enter)';
  const no = document.createElement('button'); no.className = 'pending-cancel secondary'; no.textContent = '✕'; no.title = 'Cancel (Esc)';
  [ok, no].forEach(b => b.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); }));
  ok.addEventListener('click', e => { e.stopPropagation(); finish(true); });
  no.addEventListener('click', e => { e.stopPropagation(); finish(false); });

  let row;
  if (isFolderish && effectiveMode() === 'double') {
    // amber folder / prominent project card (matches renderMillerFolderCard)
    row = document.createElement('div');
    row.className = 'subfolder-card pending-new' + (isProject ? ' project-card' : '');
    const icon = document.createElement('span'); icon.className = 'sf-icon'; icon.textContent = isProject ? '\u{1F4E6}' : '\u{1F4C1}';
    const body = document.createElement('div'); body.className = 'sf-body';
    body.appendChild(input);
    const acts = document.createElement('span'); acts.className = 'pending-acts'; acts.append(ok, no);
    row.append(icon, body, acts);
  } else if (isFolderish) {
    // single-column folder bar / project bar (matches .tree-row.is-folder)
    row = document.createElement('div');
    row.className = 'tree-row is-folder pending-new' + (isProject ? ' is-project' : '');
    const chevron = document.createElement('span'); chevron.className = 'tree-chevron';
    const icon = document.createElement('span'); icon.className = 'tree-icon'; icon.textContent = isProject ? '\u{1F4E6}' : '\u{1F4C1}';
    const acts = document.createElement('span'); acts.className = 'pending-acts'; acts.append(ok, no);
    row.append(chevron, icon, input, acts);
  } else {
    // page card (matches .tree-row.is-page, used in both layouts)
    row = document.createElement('div');
    row.className = 'tree-row is-page pending-new';
    const top = document.createElement('div'); top.className = 'card-top';
    const icon = document.createElement('span'); icon.className = 'tree-icon'; icon.textContent = '\u{1F4C4}';
    const acts = document.createElement('span'); acts.className = 'pending-acts'; acts.append(ok, no);
    top.append(icon, input, acts);
    row.appendChild(top);
  }

  setTimeout(() => input.focus(), 0);
  return row;
}

// Point the Miller column chain at a folder path (so its contents are the
// deepest visible column), used when creating inside a folder in double mode.
function setColumnPathTo(folderPath) {
  const chain = [];
  if (folderPath) {
    let acc = '';
    folderPath.split('/').filter(Boolean).forEach(p => { acc = acc ? acc + '/' + p : p; chain.push(acc); });
  }
  columnPath = chain;
  saveColumnPath();
  millerSnapRight = true;
}

function startInlineRename(node, label, row) {
  row.draggable = false; // let the input handle text selection
  const input = document.createElement('input');
  input.className = 'tree-rename';
  input.value = node.name;
  let done = false;

  const commit = async () => {
    if (done) return;
    done = true;
    const newName = input.value.trim();
    if (!newName || newName === node.name) { renderTree(); return; }
    const res = await api('rename', { path: node.path, newName });
    if (res && res.error) { toast(res.error); renderTree(); return; }
    // keep the page open under its new path
    const parent = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '';
    const newPath = (parent ? parent + '/' : '') + newName + '.json';
    updateOpenPath(node.path, newPath);
    renderMainTabs();
    if (activePath === newPath) renderPage();
    loadTree();
  };

  input.addEventListener('click', e => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); done = true; renderTree(); } // cancel before blur can commit
  });
  input.addEventListener('blur', commit);

  label.replaceWith(input);
  input.focus();
  input.select();
}

async function deleteItem(node) {
  if (!await showConfirm(`Delete "${node.name}"? It moves to Trash — restore it from the ⋯ menu.`)) return;
  await api('delete', { path: node.path });
  closeUnder(node.path);
  loadTree();
}
