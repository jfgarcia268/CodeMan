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
// Folder the toolbar's +Folder/+Page act on in single-column mode (clicked folder).
let selectedFolder = localStorage.getItem('codeman.selectedFolder') || '';
// In-progress inline creation: { kind: 'folder'|'page', parent: '<folderPath>' }.
let pendingNew = null;
let searchQuery = '';
let sidebarMode = localStorage.getItem('codeman.sidebarMode') || 'single'; // 'single' | 'double'
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
// Miller layout shows a fixed window of equal-width columns (no scrolling). The
// user picks up to 2–4 via the footer slider; we clamp to what fits the sidebar.
let millerVisibleCount = parseInt(localStorage.getItem('codeman.millerCols'), 10);
if (!(millerVisibleCount >= 2 && millerVisibleCount <= 4)) millerVisibleCount = 3;
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
function saveMillerCols() {
  try { localStorage.setItem('codeman.millerCols', String(millerVisibleCount)); } catch (e) {}
}
// How many columns actually fit the current sidebar width (2..4).
function millerFitMax() {
  const sb = document.querySelector('.sidebar');
  const avail = (sb ? sb.clientWidth : 320) - 16 /* back rail */;
  return Math.max(2, Math.min(4, Math.floor(avail / MILLER_MIN_COL)));
}
function millerEffCount() { return Math.min(millerVisibleCount, millerFitMax()); }
let deepSearch = localStorage.getItem('codeman.deepSearch') === '1'; // search inside page content
let deepMatches = new Set();  // page paths whose content matched (deep search)

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
  renderTree();
}

async function moveItem(srcPath, targetFolder) {
  if (!srcPath) return;
  // Ignore drop onto the folder it already lives in.
  const srcParent = srcPath.includes('/') ? srcPath.slice(0, srcPath.lastIndexOf('/')) : '';
  if (srcParent === targetFolder) return;
  // Projects are pinned to the top level; don't let one be dropped into a folder.
  const srcNode = nodeAtPath(srcPath);
  if (srcNode && srcNode.project && targetFolder) { toast('Projects stay at the top level'); return; }
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

// The tree node at a given path (or null).
function nodeAtPath(path) {
  if (!path) return null;
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  return folderChildren(parent).find(n => n.path === path) || null;
}

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

  // breadcrumb (full path — context even when left columns are windowed out)
  const mkSeg = (label, depth) => {
    const s = document.createElement('span');
    s.className = 'crumb-seg';
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

  // When inside a project but its root column is windowed out of view, show a
  // banner naming the project (click it to jump back to the project root).
  const rootDrilled = columnPath[0];
  const rootNode = rootDrilled ? nodeAtPath(rootDrilled) : null;
  if (rootNode && rootNode.project && millerWindowStart > 0) {
    const banner = document.createElement('div');
    banner.className = 'project-banner';
    banner.title = 'Back to project';
    banner.innerHTML = '<span class="pb-icon">\u{1F4E6}</span>';
    const nm = document.createElement('span'); nm.className = 'pb-name'; nm.textContent = rootNode.name;
    banner.appendChild(nm);
    banner.addEventListener('click', () => {
      columnPath = [rootDrilled];
      setSelectedFolder(rootDrilled);
      millerSnapRight = true;
      saveColumnPath();
      renderTree();
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

  if (!folders.length && !pages.length && !pending) {
    const e = document.createElement('div'); e.className = 'tree-empty'; e.textContent = 'Empty';
    col.appendChild(e);
    return col;
  }
  folders.forEach(f => {
    const card = renderMillerFolderCard(f, depth, f.path === selectedChild || f.path === selectedFolder);
    attachColumnReorder(card, f, parentPath, true); // folders also accept "move into"
    col.appendChild(card);
  });
  if (folders.length && pages.length) {
    const d = document.createElement('div'); d.className = 'miller-divider';
    col.appendChild(d);
  }
  pages.forEach(p => {
    const node = renderTreeNode(p);              // rich page card
    const row = node.querySelector('.tree-row');
    if (row) attachColumnReorder(row, p, parentPath, false);
    col.appendChild(node);
  });
  if (pending) col.appendChild(buildPendingRow());
  return col;
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
  // A project can only be reordered among root-level items, never nested.
  const srcNode = nodeAtPath(srcPath);
  if (srcNode && srcNode.project && parentPath) { toast('Projects stay at the top level'); return; }
  if (srcParent !== parentPath) {
    const res = await api('move', { path: srcPath, target: parentPath });
    if (res && res.error) { toast(res.error); return; }
  }
  let list = folderChildren(parentPath).map(n => n.path.split('/').pop()).filter(n => n !== srcName);
  const idx = list.indexOf(refName);
  if (idx === -1) { await loadTree(); return; }
  list.splice(pos === 'before' ? idx : idx + 1, 0, srcName);
  await api('reorder', { parent: parentPath, order: list });
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
  el.draggable = true;
  el.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', node.path); e.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging'); });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  // drop handling (reorder edges + "move into" middle) is wired by attachColumnReorder

  const icon = document.createElement('span'); icon.className = 'sf-icon'; icon.textContent = node.project ? '\u{1F4E6}' : '\u{1F4C1}';
  const body = document.createElement('div'); body.className = 'sf-body';
  const name = document.createElement('div'); name.className = 'sf-name'; name.textContent = node.name; name.title = node.name;
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

function renderTree() {
  const container = document.getElementById('tree');
  const pageCol = document.getElementById('pageCol');
  const area = document.getElementById('treeArea');
  area.classList.toggle('double', effectiveMode() === 'double');
  // Expand/Collapse-all only act on the single-column tree; flag the mode so the
  // footer can hide them in double (Miller) layout where they do nothing.
  document.body.classList.toggle('mode-double', effectiveMode() === 'double');
  updateLayoutToggle();
  const q = searchQuery.trim().toLowerCase();

  if (effectiveMode() === 'double') {
    pageCol.style.display = 'none';
    renderMiller(container, q); // clears + restores its own scroll internally
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
}

function updateLayoutToggle() {
  const sw = document.getElementById('layoutToggle');
  if (sw) sw.classList.toggle('on', effectiveMode() === 'double');
  updateColCountSlider();
}

// Reflect the column-count slider: visible only in double mode, current value
// highlighted, options that don't fit the sidebar width disabled.
function updateColCountSlider() {
  const wrap = document.getElementById('colCount');
  if (!wrap) return;
  wrap.style.display = effectiveMode() === 'double' ? 'flex' : 'none';
  if (effectiveMode() !== 'double') return;
  const fit = millerFitMax();
  const eff = millerEffCount(); // what's actually shown (preference clamped to fit)
  wrap.querySelectorAll('.cc-opt').forEach(opt => {
    const n = parseInt(opt.dataset.n, 10);
    opt.classList.toggle('active', n === eff);
    opt.classList.toggle('disabled', n > fit);
  });
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
  if (node.type === 'page' && node.path === currentPagePath) row.classList.add('active');

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
    if (parts.length) {
      const crumb = document.createElement('div');
      crumb.className = 'card-crumb';
      crumb.textContent = parts.join(' › ');
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
  });
  row.addEventListener('dragend', () => row.classList.remove('dragging'));

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
    // open vs closed folder glyph as the primary expansion cue (projects keep 📦)
    if (!node.project) icon.textContent = isOpen ? '\u{1F4C2}' : '\u{1F4C1}';
    renderTreeNodes(node.children || [], childrenEl, opts);
    if (hasPending && !opts.foldersOnly) childrenEl.appendChild(buildPendingRow());
    el.appendChild(childrenEl);

    const toggleExpand = () => {
      const open = childrenEl.style.display === 'none';
      childrenEl.style.display = open ? 'block' : 'none';
      row.classList.toggle('expanded', open);
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
function createProjectHere() { startInlineCreate('project', ''); } // projects live at root

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
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));

  let row;
  if (isFolderish && effectiveMode() === 'double') {
    // amber folder / prominent project card (matches renderMillerFolderCard)
    row = document.createElement('div');
    row.className = 'subfolder-card pending-new' + (isProject ? ' project-card' : '');
    const icon = document.createElement('span'); icon.className = 'sf-icon'; icon.textContent = isProject ? '\u{1F4E6}' : '\u{1F4C1}';
    const body = document.createElement('div'); body.className = 'sf-body';
    body.appendChild(input);
    row.append(icon, body);
  } else if (isFolderish) {
    // single-column folder bar / project bar (matches .tree-row.is-folder)
    row = document.createElement('div');
    row.className = 'tree-row is-folder pending-new' + (isProject ? ' is-project' : '');
    const chevron = document.createElement('span'); chevron.className = 'tree-chevron';
    const icon = document.createElement('span'); icon.className = 'tree-icon'; icon.textContent = isProject ? '\u{1F4E6}' : '\u{1F4C1}';
    row.append(chevron, icon, input);
  } else {
    // page card (matches .tree-row.is-page, used in both layouts)
    row = document.createElement('div');
    row.className = 'tree-row is-page pending-new';
    const top = document.createElement('div'); top.className = 'card-top';
    const icon = document.createElement('span'); icon.className = 'tree-icon'; icon.textContent = '\u{1F4C4}';
    top.append(icon, input);
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
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { done = true; renderTree(); }
  });
  input.addEventListener('blur', commit);

  label.replaceWith(input);
  input.focus();
  input.select();
}

async function deleteItem(node) {
  if (!await showConfirm(`Delete "${node.name}"? This cannot be undone.`)) return;
  await api('delete', { path: node.path });
  closeUnder(node.path);
  loadTree();
}
