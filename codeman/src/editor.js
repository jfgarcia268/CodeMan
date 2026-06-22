/* ---------- PAGE TABS ---------- */

let openPages = [];   // [{ path, title, data, filter }]
let activePath = null;

const TABS_KEY = 'codeman.openTabs';
function saveOpenTabs() {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify({
      tabs: openPages.map(t => ({ path: t.path, filter: t.filter || '' })),
      active: activePath
    }));
  } catch (e) {}
}

// Collect every page path that currently exists in the tree.
function collectPagePaths(nodes, set) {
  nodes.forEach(n => {
    if (n.type === 'page') set.add(n.path);
    else if (n.children) collectPagePaths(n.children, set);
  });
  return set;
}

// Reopen tabs saved from a previous session (skipping pages that no longer exist).
async function restoreOpenTabs() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(TABS_KEY)); } catch (e) { return; }
  if (!saved || !Array.isArray(saved.tabs) || !saved.tabs.length) return;
  const existing = collectPagePaths(treeData, new Set());
  for (const t of saved.tabs) {
    if (!existing.has(t.path)) continue;
    const data = await api('get_page', undefined, 'path=' + encodeURIComponent(t.path));
    if (!data.sections) data.sections = [];
    const baseMtime = data._mtime != null ? data._mtime : null;
    delete data._mtime;
    openPages.push({ path: t.path, title: data.title || nameFromPath(t.path), data, filter: t.filter || '', baseMtime });
  }
  if (!openPages.length) return;
  const active = openPages.find(t => t.path === saved.active) || openPages[openPages.length - 1];
  activateTab(active);
  expandAncestors(active.path);
  loadTree();
}

function nameFromPath(path) {
  const base = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
  return base.replace(/\.json$/, '');
}

const _openingPages = new Map(); // path → in-flight open Promise — dedups concurrent opens
async function openPage(path) {
  flushSave();
  let tab = openPages.find(t => t.path === path);
  if (!tab) {
    // openPage is async: a rapid double-click (or N calls in one tick) would each pass
    // the find() above before any push, then push duplicate tabs that race on save.
    // Track the in-flight fetch per path so concurrent opens reuse the same tab.
    if (_openingPages.has(path)) {
      tab = await _openingPages.get(path);
    } else {
      const p = (async () => {
        const data = await api('get_page', undefined, 'path=' + encodeURIComponent(path));
        if (!data.sections) data.sections = [];
        const baseMtime = data._mtime != null ? data._mtime : null;
        delete data._mtime;
        let t = openPages.find(x => x.path === path); // re-check after the await
        if (!t) { t = { path, title: data.title || nameFromPath(path), data, filter: '', baseMtime }; openPages.push(t); }
        return t;
      })();
      _openingPages.set(path, p);
      try { tab = await p; } finally { _openingPages.delete(path); }
    }
  }
  activateTab(tab);
  expandAncestors(path);
  // In double-column mode, dock the columns to the page's own folder: selecting
  // a page means no folder is drilled beyond it, so any deeper columns close.
  if (effectiveMode() === 'double') {
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const parts = parent.split('/').filter(Boolean);
    const chain = []; let acc = '';
    parts.forEach(p => { acc = acc ? acc + '/' + p : p; chain.push(acc); });
    if (chain.join('/') !== columnPath.join('/')) {
      columnPath = chain;
      saveColumnPath();
      setSelectedFolder(parent);
      millerSnapRight = true;
    }
  }
  renderTree(); // re-render from cached tree (no refetch — keeps scroll/state)
  // On phones, opening a page closes the navigation drawer so the page is visible.
  if (isMobileView()) setSidebarHidden(true);
}

function activateTab(tab) {
  activePath = tab.path;
  currentPagePath = tab.path;
  currentPageData = tab.data;
  pageFilter = tab.filter || '';
  renderMainTabs();
  renderPage();
  saveOpenTabs();
}

function closePage(path) {
  const idx = openPages.findIndex(t => t.path === path);
  if (idx === -1) return;
  if (path === activePath) flushSave();
  openPages.splice(idx, 1);
  if (path === activePath) {
    if (openPages.length) {
      activateTab(openPages[Math.min(idx, openPages.length - 1)]);
    } else {
      activePath = null;
      currentPagePath = null;
      currentPageData = null;
      pageFilter = '';
      renderMainTabs();
      renderPage();
    }
  } else {
    renderMainTabs();
  }
  saveOpenTabs();
  loadTree();
}

// Keep open tabs in sync when a page is renamed/moved.
function updateOpenPath(oldPath, newPath) {
  const tab = openPages.find(t => t.path === oldPath);
  if (tab) {
    tab.path = newPath;
    tab.title = nameFromPath(newPath);
    if (tab.data) tab.data.title = tab.title;
  }
  if (activePath === oldPath) { activePath = newPath; currentPagePath = newPath; }
  saveOpenTabs();
}

// Close tabs for a deleted page or anything under a deleted folder.
function closeUnder(path) {
  openPages.filter(t => t.path === path || t.path.startsWith(path + '/'))
    .forEach(t => closePage(t.path));
}

function renderMainTabs() {
  const bar = document.getElementById('mainTabs');
  bar.innerHTML = '';
  bar.style.display = openPages.length ? 'flex' : 'none';
  openPages.forEach(tab => {
    const el = document.createElement('div');
    el.className = 'main-tab' + (tab.path === activePath ? ' active' : '');
    const name = document.createElement('span');
    name.className = 'main-tab-name';
    name.textContent = tab.title;
    name.title = tab.path;
    el.appendChild(name);
    const x = document.createElement('span');
    x.className = 'main-tab-close';
    x.textContent = '✕';
    x.addEventListener('click', (e) => { e.stopPropagation(); closePage(tab.path); });
    el.appendChild(x);
    el.addEventListener('click', () => { if (tab.path !== activePath) activateTab(tab); });
    bar.appendChild(el);
  });
  if (openPages.length > 1) {
    const closeAll = document.createElement('span');
    closeAll.className = 'main-tab-closeall';
    closeAll.textContent = 'Close all';
    closeAll.title = 'Close all tabs';
    closeAll.addEventListener('click', closeAllPages);
    bar.appendChild(closeAll);
  }
}

function closeAllPages() {
  flushSave();
  openPages = [];
  activePath = null;
  currentPagePath = null;
  currentPageData = null;
  pageFilter = '';
  saveOpenTabs();
  renderMainTabs();
  renderPage();
  loadTree();
}

// Clickable folder path for the open page; clicking a segment navigates the
// sidebar to that folder/project (mirrors the sidebar breadcrumb).
function buildPagePath(pagePath) {
  const wrap = document.createElement('div');
  wrap.className = 'page-path';
  const parts = pagePath.split('/');
  parts.pop(); // drop the page file name
  const seg = (label, folderPath) => {
    const s = document.createElement('span');
    s.className = 'pp-seg';
    if (folderPath) {
      const n = nodeAtPath(folderPath);
      s.classList.add(n && n.project ? 'pp-project' : 'pp-folder'); // match card color
    }
    s.textContent = label;
    s.title = 'Go to ' + (folderPath || 'Root');
    s.addEventListener('click', () => navigateToFolder(folderPath));
    return s;
  };
  wrap.appendChild(seg('Root', ''));
  let acc = '';
  parts.forEach(p => {
    acc = acc ? acc + '/' + p : p;
    const sep = document.createElement('span'); sep.className = 'pp-sep'; sep.textContent = '›';
    wrap.append(sep, seg(p, acc));
  });
  return wrap;
}

// When on, each section shows up/down arrows to reorder it within its list.
let reorderMode = false;

// In-page section outline (a collapsible nav rail). COLLAPSED BY DEFAULT;
// toggled from the page header and persisted.
let outlineOpen = false;
try { outlineOpen = localStorage.getItem('codeman.outlineOpen') === '1'; } catch (e) {}
let outlineMap = []; // [{ secEl, item }] linking each section to its outline row
function toggleOutline() {
  outlineOpen = !outlineOpen;
  try { localStorage.setItem('codeman.outlineOpen', outlineOpen ? '1' : '0'); } catch (e) {}
  const btn = document.querySelector('.outline-toggle');
  if (btn) btn.classList.toggle('on', outlineOpen);
  // Body-level state class so the mobile tap-outside backdrop (appended to <body>
  // in initMobile) can react — the outline lives deep inside .main, not a sibling.
  document.body.classList.toggle('outline-open', outlineOpen);
  buildPageOutline();
}

// (Re)build the outline from the rendered section DOM. Each row scrolls its
// section into view; nesting depth indents subsections. Runs after every
// renderPage but no-ops cheaply when the rail is collapsed.
function buildPageOutline() {
  const area = document.getElementById('pageArea');
  const outline = document.getElementById('pageOutline');
  if (!area || !outline) return;
  area.classList.toggle('outline-open', outlineOpen);
  document.body.classList.toggle('outline-open', outlineOpen);  // drives the mobile backdrop
  if (!outlineOpen) { outlineMap = []; return; }
  outline.innerHTML = '';
  const head = document.createElement('div'); head.className = 'outline-head';
  const headTitle = document.createElement('span'); headTitle.textContent = 'Outline';
  const headClose = document.createElement('span'); headClose.className = 'outline-close';
  headClose.textContent = '✕'; headClose.title = 'Close outline';
  headClose.addEventListener('click', toggleOutline);
  head.append(headTitle, headClose);
  outline.appendChild(head);
  const pageEl = document.getElementById('page');
  const secs = currentPagePath ? [...pageEl.querySelectorAll('.section')] : [];
  if (!secs.length) {
    const e = document.createElement('div'); e.className = 'outline-empty';
    e.textContent = !currentPagePath ? 'No page open'
      : (pageFilter.trim() ? 'Outline hidden while filtering' : 'No sections yet');
    outline.appendChild(e);
    outlineMap = [];
    return;
  }
  outlineMap = secs.map(secEl => {
    let depth = 0, p = secEl.parentElement;
    while (p && p !== pageEl) { if (p.classList && p.classList.contains('section')) depth++; p = p.parentElement; }
    const title = ((secEl.querySelector('.section-title') || {}).value || '').trim() || 'Untitled';
    const item = document.createElement('div'); item.className = 'outline-item';
    item.textContent = title;
    item.title = title;
    item.style.paddingLeft = (8 + depth * 14) + 'px';
    // Direct scrollTop assignment — reliable across renderers (smooth scroll is a
    // no-op in some, per the gutter/scroll lessons). Offsets to the section top.
    item.addEventListener('click', () => {
      const p = document.getElementById('page');
      p.scrollTop += secEl.getBoundingClientRect().top - p.getBoundingClientRect().top - 4;
    });
    outline.appendChild(item);
    return { secEl, item };
  });
  updateOutlineActive();
}

// Highlight the outline row for the section currently at the top of the viewport.
function updateOutlineActive() {
  if (!outlineOpen || !outlineMap.length) return;
  const pageEl = document.getElementById('page');
  const top = pageEl.getBoundingClientRect().top;
  let activeIdx = 0;
  for (let i = 0; i < outlineMap.length; i++) {
    if (outlineMap[i].secEl.getBoundingClientRect().top - top <= 8) activeIdx = i; else break;
  }
  outlineMap.forEach((o, i) => o.item.classList.toggle('active', i === activeIdx));
}

// Collapse/expand every section AND nested subsection on the page. The header
// toggle reads allSectionsCollapsed() to decide its direction + label, so one
// button flips the whole page either way.
function eachSectionDeep(sections, fn) {
  (sections || []).forEach(s => {
    fn(s);
    eachSectionDeep(sectionContent(s).subsections, fn);
  });
}
function allSectionsCollapsed(sections) {
  let total = 0, collapsed = 0;
  eachSectionDeep(sections, s => { total++; if (s.collapsed) collapsed++; });
  return total > 0 && collapsed === total;
}
function setAllSectionsCollapsed(value) {
  eachSectionDeep(currentPageData.sections, s => { s.collapsed = value; });
  renderPage();
  scheduleSave();
}

function renderPageBody() {
  const header = document.getElementById('pageHeader');
  const page = document.getElementById('page');
  header.innerHTML = '';
  page.innerHTML = '';

  if (!currentPagePath) {
    // Onboarding empty state: orient a new user with primary CTAs + the ⌘K hint,
    // and a "open the sidebar" nudge when it's hidden (so the tree isn't a dead end).
    const empty = document.createElement('div');
    empty.className = 'empty-state onboard';
    const mk = (label, cls, fn) => { const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls; b.addEventListener('click', fn); return b; };
    const h = document.createElement('div'); h.className = 'onboard-title'; h.textContent = 'No page open';
    const sub = document.createElement('div'); sub.className = 'onboard-sub'; sub.textContent = 'Create your first snippet page, or pick one from the sidebar.';
    const actions = document.createElement('div'); actions.className = 'onboard-actions';
    actions.append(mk('+ New Project', 'btn-project', () => createProjectHere()), mk('+ New Page', 'btn-page', () => createPageHere()));
    if (document.body.classList.contains('sidebar-hidden')) {
      actions.appendChild(mk('☰ Open the sidebar', 'secondary', () => setSidebarHidden(false)));
    }
    const hint = document.createElement('div'); hint.className = 'onboard-hint';
    hint.innerHTML = 'Press <kbd>⌘K</kbd> to jump to any page or run a command';
    empty.append(h, sub, actions, hint);
    page.appendChild(empty);
    return;
  }

  const title = document.createElement('h1');
  title.textContent = currentPageData.title || currentPagePath;

  // When the sidebar's deep (content) search is active, the page block filter
  // is driven by that query and locked until the sidebar search is cleared.
  const lockedBySidebar = deepSearch && searchQuery.trim() !== '';
  const effFilter = lockedBySidebar ? searchQuery : pageFilter;

  // in-page block search
  const searchWrap = document.createElement('div');
  searchWrap.className = 'page-search' + (effFilter ? ' has-text' : '') + (lockedBySidebar ? ' locked' : '');
  const search = document.createElement('input');
  search.type = 'text';
  search.value = effFilter;
  if (lockedBySidebar) {
    search.disabled = true;
    search.placeholder = '';
    search.title = 'Filtered by sidebar content search — clear it to edit';
  } else {
    search.placeholder = 'Filter blocks…';
    search.addEventListener('input', () => {
      pageFilter = search.value;
      const t = openPages.find(t => t.path === activePath);
      if (t) t.filter = pageFilter;
      saveOpenTabs();
      renderPage();
      const again = document.querySelector('.page-search input');
      if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
    });
  }
  const clear = document.createElement('span');
  clear.className = 'page-search-clear';
  clear.textContent = '✕';
  clear.title = 'Clear filter';
  clear.addEventListener('click', () => { pageFilter = ''; renderPage(); });
  searchWrap.append(search, clear);

  const actions = document.createElement('div');
  actions.className = 'page-header-actions';
  const outlineBtn = document.createElement('button');
  outlineBtn.className = 'secondary outline-toggle page-act-demote' + (outlineOpen ? ' on' : '');
  outlineBtn.textContent = '≣ Outline';
  outlineBtn.title = 'Toggle the section outline';
  outlineBtn.addEventListener('click', toggleOutline);
  const favStar = buildFavStar(currentPagePath);
  favStar.classList.add('page-act-demote');
  const historyBtn = document.createElement('button');
  historyBtn.className = 'secondary page-act-demote';
  historyBtn.textContent = '⟲ History';
  historyBtn.title = 'View and restore previous versions of this page';
  historyBtn.addEventListener('click', () => openHistory(currentPagePath));
  const exportBtn = document.createElement('button');
  exportBtn.className = 'secondary page-act-demote';
  exportBtn.textContent = '⤓ Export';
  exportBtn.title = 'Export this page';
  exportBtn.addEventListener('click', () => exportMenu(exportBtn));
  const allCollapsed = allSectionsCollapsed(currentPageData.sections);
  const foldBtn = document.createElement('button');
  foldBtn.className = 'secondary page-act-demote';
  foldBtn.textContent = allCollapsed ? '⊞ Expand all' : '⊟ Collapse all';
  foldBtn.title = allCollapsed ? 'Expand every section on this page' : 'Collapse every section on this page';
  foldBtn.addEventListener('click', () => setAllSectionsCollapsed(!allCollapsed));
  const reorderBtn = document.createElement('button');
  reorderBtn.className = 'secondary page-act-demote' + (reorderMode ? ' on' : '');
  reorderBtn.textContent = '⇅ Reorder';
  reorderBtn.title = 'Reorder mode — show up/down arrows on sections and blocks';
  reorderBtn.addEventListener('click', () => { reorderMode = !reorderMode; renderPage(); });
  const addSectionBtn = document.createElement('button');
  addSectionBtn.textContent = '+ Section';
  addSectionBtn.addEventListener('click', () => {
    currentPageData.sections.push(newSection());
    renderPage();
    scheduleSave();
    // new section is appended at the end — scroll the page body down to reveal it
    // (.page is the scroller now; the tabs + header stay pinned as a static banner)
    setTimeout(() => {
      const pageEl = document.getElementById('page');
      if (pageEl) pageEl.scrollTop = pageEl.scrollHeight;
    }, 0);
  });
  // Mobile-only "⋯ More" — folds the secondary page actions behind a menu so the
  // phone header is just [title  ⋯  + Section]. The real buttons stay in the DOM
  // (CSS-hidden via .page-act-demote on mobile) and each item fires the real
  // button's .click(), so handlers run once with no duplication. Desktop never
  // renders this button (CSS display:none unless body.is-mobile). Export anchors
  // its own submenu to the passed anchor, so we hand it the ⋯ button (a hidden
  // exportBtn would open the submenu at 0,0).
  const headerMoreBtn = document.createElement('button');
  headerMoreBtn.className = 'secondary page-header-more';
  headerMoreBtn.textContent = '⋯';
  headerMoreBtn.title = 'More page actions';
  headerMoreBtn.addEventListener('click', () => {
    const allCollapsedNow = allSectionsCollapsed(currentPageData.sections);
    showMiniMenu(headerMoreBtn, [
      { icon: isFavorite(currentPagePath) ? '★' : '☆', label: isFavorite(currentPagePath) ? 'Unfavorite' : 'Favorite',
        active: isFavorite(currentPagePath), onClick: () => favStar.click() },
      { icon: '≣', label: 'Outline', active: outlineOpen, onClick: () => outlineBtn.click() },
      { icon: allCollapsedNow ? '⊞' : '⊟', label: allCollapsedNow ? 'Expand all' : 'Collapse all',
        onClick: () => foldBtn.click() },
      { divider: true },
      { icon: '⟲', label: 'History', onClick: () => historyBtn.click() },
      { icon: '⤓', label: 'Export', onClick: () => exportMenu(headerMoreBtn) },
      { icon: '⇅', label: 'Reorder', active: reorderMode, onClick: () => reorderBtn.click() },
    ]);
  });
  actions.append(outlineBtn, foldBtn, favStar, historyBtn, exportBtn, reorderBtn, headerMoreBtn, addSectionBtn);
  header.append(buildPagePath(currentPagePath), title, searchWrap, actions);

  const q = effFilter.trim().toLowerCase();
  if (q) {
    const results = [];
    currentPageData.sections.forEach(s => collectMatchingBlocks(s, [], q, results));
    if (!results.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No blocks match "' + effFilter + '"';
      page.appendChild(empty);
      return;
    }
    results.forEach(r => {
      const wrap = document.createElement('div');
      wrap.className = 'filtered-block';
      const crumb = document.createElement('div');
      crumb.className = 'filtered-crumb';
      crumb.textContent = r.trail;
      wrap.appendChild(crumb);
      wrap.appendChild(renderBlock(r.block, r.arr, r.idx));
      page.appendChild(wrap);
    });
    return;
  }

  page.appendChild(renderSectionList(currentPageData.sections, false));
}

// renderPage = render the page body, then resync the outline rail (cheap no-op
// when collapsed). Wrapping keeps the outline in step with every re-render.
function renderPage() {
  renderPageBody();
  buildPageOutline();
}

// Keep the outline's active row in step with the page scroll (the page body is
// the scroller; #page is static in the DOM so this binds once).
(function initOutlineScroll() {
  const pageEl = document.getElementById('page');
  // Direct call (no rAF): cheap (~one rect read per section) and reliable across
  // renderers where rAF is throttled when the page isn't actively painting.
  if (pageEl) pageEl.addEventListener('scroll', () => { if (outlineOpen) updateOutlineActive(); });
})();

// Builds the shared "select + merge" control bar used for both sections and
// blocks. The caller owns the live `checks` array (an array of { cb, idx }) and
// pushes to it after this returns; the bar's handlers read it lazily at click
// time. `onMerge(chosenIndices)` receives the selected indices, ascending.
//   opts: { label, title?, extraClass?, mergingClass, target, checks, noun, onMerge }
// Returns { bar, syncSelectAll } — assign syncSelectAll where checkbox changes
// can reach it so the Select all / Deselect all label stays in sync.
function buildMergeBar(opts) {
  const bar = document.createElement('div');
  bar.className = 'merge-bar' + (opts.extraClass ? ' ' + opts.extraClass : '');

  const startBtn = document.createElement('button');
  startBtn.className = 'secondary';
  startBtn.textContent = opts.label;
  if (opts.title) startBtn.title = opts.title;

  const doBtn = document.createElement('button');
  doBtn.className = 'merge-do';
  doBtn.textContent = 'Merge selected';
  doBtn.style.display = 'none';

  const selectAllBtn = document.createElement('button');
  selectAllBtn.className = 'secondary';
  selectAllBtn.textContent = 'Select all';
  selectAllBtn.style.display = 'none';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'secondary';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.display = 'none';

  const checks = opts.checks;
  function syncSelectAll() {
    const all = checks.length && checks.every(c => c.cb.checked);
    selectAllBtn.textContent = all ? 'Deselect all' : 'Select all';
  }
  function exit() {
    opts.target.classList.remove(opts.mergingClass);
    checks.forEach(c => { c.cb.checked = false; });
    startBtn.style.display = '';
    [doBtn, selectAllBtn, cancelBtn].forEach(b => b.style.display = 'none');
  }
  startBtn.addEventListener('click', () => {
    opts.target.classList.add(opts.mergingClass);
    startBtn.style.display = 'none';
    [doBtn, selectAllBtn, cancelBtn].forEach(b => b.style.display = '');
    syncSelectAll();
  });
  selectAllBtn.addEventListener('click', () => {
    const all = checks.every(c => c.cb.checked);
    checks.forEach(c => { c.cb.checked = !all; });
    syncSelectAll();
  });
  cancelBtn.addEventListener('click', exit);
  doBtn.addEventListener('click', () => {
    const chosen = checks.filter(c => c.cb.checked).map(c => c.idx).sort((a, b) => a - b);
    if (chosen.length < 2) { toast('Select at least 2 ' + opts.noun); return; }
    opts.onMerge(chosen);
  });

  bar.append(startBtn, doBtn, selectAllBtn, cancelBtn);
  return { bar, syncSelectAll };
}

// Reorder affordance shared by sections and blocks: prepends an up-arrow bar and
// appends a down-arrow bar to `el`, each moving item `idx` within array `arr`.
// Shown only in reorderMode; first/last arrows are disabled. Mutates the array
// then re-renders + saves (matching the sections drag-to-sort semantics).
function attachReorderArrows(el, arr, idx) {
  el.classList.add('reordering');
  const arrow = (dir, dest, enabled) => {
    const a = document.createElement('div');
    a.className = 'reorder-arrow ' + dir + (enabled ? '' : ' disabled');
    a.textContent = dir === 'up' ? '▲' : '▼';
    a.title = dir === 'up' ? 'Move up' : 'Move down';
    if (enabled) a.addEventListener('click', (e) => {
      e.stopPropagation();
      const [moved] = arr.splice(idx, 1);
      arr.splice(dest, 0, moved);
      renderPage();
      scheduleSave();
    });
    return a;
  };
  el.insertBefore(arrow('up', idx - 1, idx > 0), el.firstChild);
  el.appendChild(arrow('down', idx + 1, idx < arr.length - 1));
}

// Renders a list of sections (or subsections) with a "Merge sections" control
// that lets you select sections and merge them into the topmost selected one.
// mergeCtx (when set) means these subsections are merged via the PARENT section's
// unified bar: no own bar, and each checkbox joins mergeCtx.checks at the combined
// index mergeCtx.base + i. Without it (top-level sections), it keeps its own bar.
function renderSectionList(sections, isSub, parentBlocks, mergeCtx) {
  const wrap = document.createElement('div');
  wrap.className = 'section-list' + (isSub ? ' subsections' : '');
  const checks = [];

  if (!mergeCtx && sections.length >= 2) {
    const { bar, syncSelectAll } = buildMergeBar({
      label: '⛶ Merge sections',
      extraClass: 'section-merge-bar',
      mergingClass: 'merging-sections',
      target: wrap,
      checks,
      noun: 'sections',
      onMerge: (chosen) => {
        const top = chosen[0];
        const topContent = sectionContent(sections[top]);
        chosen.slice(1).forEach(i => {
          const c = sectionContent(sections[i]);
          topContent.blocks.push(...c.blocks);
          topContent.subsections.push(...c.subsections);
          // fold in tags from merged sections
          if (sections[i].tags) {
            sections[top].tags = sections[top].tags || [];
            sections[i].tags.forEach(t => { if (!sections[top].tags.includes(t)) sections[top].tags.push(t); });
          }
        });
        chosen.slice(1).sort((a, b) => b - a).forEach(i => sections.splice(i, 1));
        renderPage();
        scheduleSave();
        toast('Merged ' + chosen.length + ' sections');
      },
    });
    wrap.appendChild(bar);
    wrap._syncSecSelectAll = syncSelectAll;
  }

  sections.forEach((sec, i) => {
    const el = renderSection(sec, sections, i, isSub, parentBlocks);
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'sec-check';
    cb.title = 'Select for merge';
    cb.addEventListener('click', e => e.stopPropagation());
    cb.addEventListener('change', () => {
      if (mergeCtx) mergeCtx.syncAll();
      else if (wrap._syncSecSelectAll) wrap._syncSecSelectAll();
    });
    const hdr = el.querySelector('.section-header');
    if (hdr) hdr.insertBefore(cb, hdr.firstChild);
    if (mergeCtx) mergeCtx.checks.push({ cb, idx: mergeCtx.base + i });
    else checks.push({ cb, idx: i });

    // Reorder arrows: an up-arrow at the top and a down-arrow at the bottom.
    if (reorderMode) attachReorderArrows(el, sections, i);

    wrap.appendChild(el);
  });

  return wrap;
}

function blockMatches(block, q) {
  if ((block.code || '').toLowerCase().includes(q)) return true;
  if ((block.label || '').toLowerCase().includes(q)) return true;
  if ((block.type || '').toLowerCase().includes(q)) return true;
  return langLabel(block.type).toLowerCase().includes(q);
}

// Walks a section's blocks/subsections collecting blocks that match, each with
// a breadcrumb trail showing where it lives.
function collectMatchingBlocks(section, parentTrail, q, out) {
  const c = sectionContent(section);
  const trailArr = parentTrail.concat([section.title || 'Untitled']);
  c.blocks.forEach((b, i) => {
    if (blockMatches(b, q)) {
      out.push({ trail: trailArr.join(' › '), block: b, arr: c.blocks, idx: i });
    }
  });
  c.subsections.forEach(sub => collectMatchingBlocks(sub, trailArr, q, out));
}

function newSection(name) {
  return { title: name || 'New Section', collapsed: false, blocks: [], subsections: [] };
}

function newBlock() {
  return { type: 'sql', label: '', code: '' };
}

// A note block renders Markdown prose instead of highlighted code.
function newNoteBlock() {
  return { type: 'markdown', label: '', code: '', note: true };
}

// A rich-text block is a WYSIWYG editor (fonts, colors, sizes, lists). Its
// content is stored as sanitized HTML in `block.code`.
function newRichBlock() {
  return { type: 'plaintext', label: '', code: '', rich: true };
}

// Best-effort plain text → rich HTML, used when converting a code/note block.
function textToRichHtml(text) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return String(text || '').split('\n').map(l => '<p>' + (l ? esc(l) : '<br>') + '</p>').join('') || '<p><br></p>';
}

// Whitelist sanitizer for rich-text HTML. Post-order so a <script>/<style> nested
// inside an otherwise-unwrapped tag is removed before its ancestor is unwrapped.
// It's the user's own content, but we still strip scripts, event handlers and
// javascript: URLs so a pasted snippet can't execute.
const RICH_ALLOWED = new Set(['P', 'BR', 'DIV', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'BLOCKQUOTE', 'A', 'FONT', 'SUB', 'SUP', 'PRE', 'CODE', 'HR']);
const RICH_DANGEROUS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'FORM', 'INPUT', 'BUTTON', 'SVG', 'TEXTAREA']);
function sanitizeRichHtml(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html || '');
  const clean = (node) => {
    [...node.childNodes].forEach(clean);          // children first (post-order)
    if (node.nodeType === 8) { node.remove(); return; }   // comment
    if (node.nodeType !== 1) return;                       // keep text nodes
    const tag = node.tagName;
    if (RICH_DANGEROUS.has(tag)) { node.remove(); return; }
    if (!RICH_ALLOWED.has(tag)) {                          // unwrap unknown tag, keep text
      const p = node.parentNode; if (!p) return;
      while (node.firstChild) p.insertBefore(node.firstChild, node);
      p.removeChild(node); return;
    }
    [...node.attributes].forEach(a => {
      const name = a.name.toLowerCase();
      if (name === 'style') { if (/javascript:|expression\(|url\s*\(/i.test(a.value)) node.removeAttribute('style'); }
      else if (name === 'href' && tag === 'A') { if (!/^(https?:|mailto:)/i.test(a.value.trim())) node.removeAttribute('href'); }
      else if ((name === 'color' || name === 'size' || name === 'face') && tag === 'FONT') { /* legacy font attrs allowed */ }
      else node.removeAttribute(a.name);
    });
    if (tag === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
  };
  clean(tpl.content);
  return tpl.innerHTML;
}

// A checklist (todo) block: rows of { text, done }. No code/markdown surface.
function newChecklistBlock() {
  return { type: 'checklist', label: '', checklist: true, items: [{ text: '', done: false }] };
}

// A CSV (table) block: raw CSV text lives in block.code; view mode renders it as a
// table. First row is the header.
function newCsvBlock() {
  return { type: 'csv', label: '', code: '', csv: true };
}

// Auto-detect the field delimiter from the first non-empty line (outside quotes):
// comma, semicolon or tab. Defaults to comma when none stands out.
function detectCsvDelimiter(text) {
  const firstLine = String(text || '').split(/\r?\n/).find(l => l.trim().length) || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let q = false;
  for (const ch of firstLine) {
    if (ch === '"') q = !q;
    else if (!q && Object.prototype.hasOwnProperty.call(counts, ch)) counts[ch]++;
  }
  let best = ',', n = 0;
  for (const d of [',', ';', '\t']) if (counts[d] > n) { n = counts[d]; best = d; }
  return n > 0 ? best : ',';
}

// Tolerant CSV parser (RFC-4180-ish): handles quoted fields, "" escapes, and
// delimiters/newlines inside quotes. It NEVER throws — malformed input (e.g. an
// unterminated quote) still yields rows, with `unterminated` flagged so the view
// can warn instead of breaking. Returns { rows, delim, unterminated }.
function parseCsv(text, delim) {
  const s = String(text == null ? '' : text);
  const d = delim || detectCsvDelimiter(s);
  const rows = []; let row = [], field = '', inQ = false, i = 0;
  while (i < s.length) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }  // escaped quote
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === d) { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }                              // swallow CR (CRLF)
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  row.push(field); rows.push(row);
  // a trailing newline yields a final empty row — drop it (but keep a lone empty row)
  if (rows.length > 1) { const last = rows[rows.length - 1]; if (last.length === 1 && last[0] === '') rows.pop(); }
  return { rows, delim: d, unterminated: inQ };
}

/* ---------- BLOCK KINDS (unified create + convert) ---------- */
// Every block is exactly one kind. Centralising this keeps the create menu and
// the per-block "type" switch in sync, and means a new kind is one row here.
const BLOCK_KINDS = [
  { kind: 'code', icon: '</>', label: 'Code' },
  { kind: 'note', icon: '¶', label: 'Note (MD)' },
  { kind: 'rich', icon: 'T', label: 'Rich Text' },
  { kind: 'checklist', icon: '☑', label: 'Checklist' },
  { kind: 'csv', icon: '▦', label: 'Table (CSV)' },
];
function blockKind(block) {
  if (block.checklist) return 'checklist';
  if (block.rich) return 'rich';
  if (block.note) return 'note';
  if (block.csv) return 'csv';
  return 'code';
}
function newBlockOfKind(kind) {
  if (kind === 'note') return newNoteBlock();
  if (kind === 'rich') return newRichBlock();
  if (kind === 'checklist') return newChecklistBlock();
  if (kind === 'csv') return newCsvBlock();
  return newBlock();
}
// HTML → plain text preserving line breaks. Done by mapping block-close tags and
// <br> to newlines on the markup string (NOT via a detached node's innerText —
// detached nodes have no layout, so innerText collapses every block boundary and
// the conversion silently loses all line breaks).
function richToPlainText(html) {
  let s = String(html || '');
  s = s.replace(/<\s*br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr|ul|ol)\s*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');                 // strip remaining tags
  const ta = document.createElement('textarea'); // decode entities (&amp; &lt; …)
  ta.innerHTML = s;
  return ta.value.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').replace(/\s+$/, '');
}
// Plain-text view of any block, for lossless-ish conversion between kinds.
function blockPlainText(block) {
  if (block.checklist) return (block.items || []).map(i => '- [' + (i.done ? 'x' : ' ') + '] ' + i.text).join('\n');
  if (block.rich) return richToPlainText(block.code);
  return block.code || '';
}
// Parse plain text / markdown task lines into checklist items.
function textToChecklistItems(text) {
  const items = String(text || '').split('\n').map(l => {
    const m = l.match(/^\s*(?:[-*]\s*)?\[([ xX])\]\s*(.*)$/);   // "- [ ] foo" / "[x] foo"
    if (m) return { text: m[2], done: /x/i.test(m[1]) };
    const t = l.replace(/^\s*[-*]\s+/, '').trim();               // "- foo" → "foo"
    return t ? { text: t, done: false } : null;
  }).filter(Boolean);
  return items.length ? items : [{ text: '', done: false }];
}
// Convert a block in place to a different kind, carrying the text across.
function convertBlock(block, kind) {
  if (blockKind(block) === kind) return;
  const text = blockPlainText(block);
  delete block.note; delete block.rich; delete block.checklist; delete block.items; delete block.csv;
  if (kind === 'note') { block.note = true; block.type = 'markdown'; block.code = text; }
  else if (kind === 'rich') { block.rich = true; block.type = 'plaintext'; block.code = textToRichHtml(text); }
  else if (kind === 'checklist') { block.checklist = true; block.type = 'checklist'; block.items = textToChecklistItems(text); block.code = ''; }
  else if (kind === 'csv') { block.csv = true; block.type = 'csv'; block.code = text; }
  else { block.type = 'plaintext'; block.code = text; }   // code
}

// A small popup menu anchored under a button. items: [{icon,label,active,onClick}].
// Reuses the .mini-menu styling (shared with the "Copy as…" menu).
function showMiniMenu(anchorEl, items) {
  const open = document.querySelector('.mini-menu');
  if (open) { const wasMine = open._anchor === anchorEl; open.remove(); if (wasMine) return; }
  const menu = document.createElement('div');
  menu.className = 'mini-menu'; menu._anchor = anchorEl;
  items.forEach(it => {
    if (it.divider) { const d = document.createElement('div'); d.className = 'mini-menu-sep'; menu.appendChild(d); return; }
    const o = document.createElement('div');
    o.className = 'mini-menu-opt' + (it.active ? ' active' : '');
    if (it.icon) { const ic = document.createElement('span'); ic.className = 'mm-ic'; ic.textContent = it.icon; o.appendChild(ic); }
    const lbl = document.createElement('span'); lbl.textContent = it.label; o.appendChild(lbl);
    o.onclick = () => { menu.remove(); it.onClick && it.onClick(); };
    menu.appendChild(o);
  });
  document.body.appendChild(menu);
  const r = anchorEl.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.round(Math.min(window.innerWidth - 8 - mw, Math.max(8, r.left))) + 'px';
  // open downward, or upward if it would overflow the viewport bottom
  menu.style.top = Math.round(r.bottom + 4 + mh > window.innerHeight ? Math.max(8, r.top - 4 - mh) : r.bottom + 4) + 'px';
  const off = (e) => { if (!menu.contains(e.target) && e.target !== anchorEl) { menu.remove(); document.removeEventListener('mousedown', off); } };
  setTimeout(() => document.addEventListener('mousedown', off), 0);
}

// The per-block "type" switch (replaces the old ¶ / T toggles). Same on every
// block kind, so converting is one consistent control everywhere.
function makeTypeMenuButton(block) {
  const cur = BLOCK_KINDS.find(k => k.kind === blockKind(block));
  const btn = mkBtn((cur ? cur.label : 'Type') + ' ▾', () => {
    showMiniMenu(btn, BLOCK_KINDS.map(k => ({
      icon: k.icon, label: k.label, active: blockKind(block) === k.kind,
      onClick: () => { convertBlock(block, k.kind); renderPage(); scheduleSave(); },
    })));
  });
  btn.className = 'secondary type-menu';
  btn.title = 'Change block type';
  return btn;
}

// Returns the object that holds a section's blocks/subsections, handling both
// the legacy single-tab wrapper ({tabs:[{blocks,subsections}]}) and the flat
// form ({blocks,subsections}). Tabs are no longer a feature; any extra tabs in
// old data are flattened into the first one.
function sectionContent(section) {
  if (section.tabs) {
    const first = section.tabs[0] || { blocks: [], subsections: [] };
    if (!first.blocks) first.blocks = [];
    if (!first.subsections) first.subsections = [];
    // fold any stray extra tabs into the first (shouldn't normally exist)
    for (let i = 1; i < section.tabs.length; i++) {
      first.blocks.push(...(section.tabs[i].blocks || []));
      first.subsections.push(...(section.tabs[i].subsections || []));
    }
    if (section.tabs.length > 1) section.tabs = [first];
    return first;
  }
  if (!section.blocks) section.blocks = [];
  if (!section.subsections) section.subsections = [];
  return section;
}

// Shared tag mutation helpers — used by the desktop inline chips (renderTags) AND
// the mobile tags-menu button, so the add/remove logic lives in one place.
function removeTag(section, i) {
  section.tags.splice(i, 1);
  renderPage();
  scheduleSave();
}
// Open a transient tag input. `place(input)` decides where it goes (desktop swaps
// it in for the `+`; the mobile menu drops it into the section header). Commits the
// trimmed value on Enter/blur, cancels on Escape.
function addTagFlow(section, place) {
  if (!section.tags) section.tags = [];
  const input = document.createElement('input');
  input.className = 'tag-input';
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (v && !section.tags.includes(v)) section.tags.push(v);
    renderPage();
    scheduleSave();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { done = true; renderPage(); }
  });
  input.addEventListener('blur', commit);
  place(input);
  input.focus();
}

function renderTags(section) {
  if (!section.tags) section.tags = [];
  const wrap = document.createElement('span');
  wrap.className = 'tags';
  wrap.addEventListener('click', e => e.stopPropagation());

  section.tags.forEach((tag, i) => {
    const chip = document.createElement('span');
    chip.className = 'tag';
    const name = document.createElement('span');
    name.className = 'tag-name';
    name.textContent = tag;
    const x = document.createElement('span');
    x.className = 'tag-remove';
    x.textContent = '✕';
    x.title = 'Remove tag';
    x.addEventListener('click', () => removeTag(section, i));
    chip.append(name, x);
    wrap.appendChild(chip);
  });

  const add = document.createElement('span');
  add.className = 'tag-add';
  add.textContent = '+';
  add.title = 'Add tag';
  add.addEventListener('click', () => addTagFlow(section, (input) => add.replaceWith(input)));
  wrap.appendChild(add);

  return wrap;
}

function renderSection(section, parentArray, idx, isSub, parentBlocks) {
  const isMobile = document.body.classList.contains('is-mobile');
  const el = document.createElement('div');
  el.className = 'section' + (isSub ? ' subsection-node' : '') + (section.collapsed ? ' collapsed' : '');

  const headerEl = document.createElement('div');
  headerEl.className = 'section-header';

  const toggle = document.createElement('span');
  toggle.className = 'section-toggle';
  toggle.textContent = '▼';

  const titleInput = document.createElement('input');
  titleInput.className = 'section-title';
  titleInput.value = section.title;
  titleInput.addEventListener('click', e => e.stopPropagation());
  titleInput.addEventListener('input', () => {
    section.title = titleInput.value;
    scheduleSave();
  });

  const sectionActions = document.createElement('span');
  sectionActions.className = 'section-actions';

  const body = document.createElement('div');
  body.className = 'section-body';

  // A section holds its blocks/subsections in a single content container.
  const content = sectionContent(section);

  // Section-level variables (mutually exclusive with block-level): when on, the
  // section shows one set of fill-in fields for every _V_NAME_V_ in its OWN blocks,
  // and those values substitute into all of them. Disabled if any block owns vars.
  const anyBlockVars = content.blocks.some(b => b.varsOn);
  const sectionVarsOn = !!section.varsOn && !anyBlockVars;
  const secVarToggle = mkBtn('$', () => {
    if (anyBlockVars) { toast('Disable variables on the code blocks first'); return; }
    section.varsOn = !section.varsOn;
    renderPage();
    scheduleSave();
  });
  secVarToggle.className = 'secondary sec-var-toggle' + (sectionVarsOn ? ' on' : '') + (anyBlockVars ? ' disabled' : '');
  secVarToggle.title = anyBlockVars
    ? 'Disable variables on the code blocks first to use section variables'
    : 'Toggle section variables — fill in _V_NAME_V_ once for every block here';

  // Dissolve (inverse of a block's "To subsection"): remove this subsection but
  // keep its contents — its blocks move up into the parent's blocks and its own
  // subsections take its place in the parent's subsection list.
  let dissolveBtn = null;
  if (isSub && parentBlocks) {
    dissolveBtn = mkBtn('⤴ Dissolve', () => {
      const c = sectionContent(section);
      parentBlocks.push(...c.blocks);               // child blocks → parent blocks
      parentArray.splice(idx, 1, ...c.subsections); // replace this sub with its own subs
      renderPage();
      scheduleSave();
      toast('Subsection dissolved into parent');
    });
    dissolveBtn.className = 'secondary';
    dissolveBtn.title = 'Remove this subsection, moving its blocks and subsections up to the parent';
  }

  const delBtn = mkBtn('Delete', async () => {
    if (!await showConfirm(`Delete this ${isSub ? 'subsection' : 'section'} and everything in it?`)) return;
    parentArray.splice(idx, 1);
    renderPage();
    scheduleSave();
  });
  delBtn.className = 'danger';
  if (isMobile) { delBtn.textContent = '✕'; delBtn.title = 'Delete'; }
  if (dissolveBtn) sectionActions.append(secVarToggle, dissolveBtn, delBtn);
  else sectionActions.append(secVarToggle, delBtn);

  const panel = document.createElement('div');
  panel.className = 'tab-panel';
  if (sectionVarsOn) section.varValues = section.varValues || {};

  // (Re)build the section variables panel by re-aggregating _V_NAME_V_ across the
  // section's own blocks. Re-run after a block's code is saved so a newly added or
  // removed variable shows up here without toggling the section feature off/on.
  function renderSecVars() {
    const old = panel.querySelector(':scope > .section-vars');
    if (old) old.remove();
    if (!sectionVarsOn) return;
    const names = [];
    content.blocks.forEach(b => parseVars(b.code).forEach(n => { if (!names.includes(n)) names.push(n); }));
    const secVars = document.createElement('div');
    secVars.className = 'section-vars';
    const head = document.createElement('div'); head.className = 'section-vars-head'; head.textContent = 'Section variables';
    secVars.appendChild(head);
    if (!names.length) {
      const e = document.createElement('div'); e.className = 'block-vars-empty';
      e.textContent = 'No variables in this section’s blocks — wrap a value as _V_NAME_V_';
      secVars.appendChild(e);
    } else {
      names.forEach(name => {
        const row = document.createElement('div'); row.className = 'var-row';
        const lab = document.createElement('label'); lab.className = 'var-name'; lab.textContent = name;
        const inp = document.createElement('input'); inp.className = 'var-input'; inp.placeholder = 'MISSING VALUE';
        inp.value = section.varValues[name] || '';
        inp.addEventListener('input', () => {
          section.varValues[name] = inp.value;
          // refresh only this section's direct blocks (live, keeps input focus)
          panel.querySelectorAll(':scope > .block').forEach(b => b._updatePreview && b._updatePreview());
          scheduleSave();
        });
        row.append(lab, inp);
        secVars.appendChild(row);
      });
    }
    panel.insertBefore(secVars, panel.firstChild);
  }

  renderSectionContent(panel, content.blocks, content.subsections, sectionVarsOn ? section.varValues : null, renderSecVars);
  renderSecVars();

  const tabActions = document.createElement('div');
  tabActions.className = 'tab-actions';
  // One "+ Add" menu lists every block kind — scales without piling up buttons.
  const addMenuBtn = mkBtn('+ Add ▾', () => {
    showMiniMenu(addMenuBtn, BLOCK_KINDS.map(k => ({
      icon: k.icon, label: k.label,
      onClick: () => { content.blocks.push(newBlockOfKind(k.kind)); renderPage(); scheduleSave(); },
    })));
  });
  addMenuBtn.title = 'Add a block (Code, Note, Rich Text, Checklist, Table/CSV)';
  const addSubBtn = mkBtn('+ Subsection', () => {
    content.subsections.push(newSection());
    renderPage();
    scheduleSave();
  });
  tabActions.append(addMenuBtn, addSubBtn);
  panel.appendChild(tabActions);

  body.appendChild(panel);

  if (isMobile) {
    // Mobile: tags collapse into a compact "🏷 N" count button that opens a picklist
    // (each tag removable + Add tag), and the section's ⛶ Merge bar is relocated out
    // of the body up onto this same header row — one tidy row instead of three.
    const n = (section.tags || []).length;
    const tagsBtn = mkBtn('🏷 ' + n, () => {
      const items = (section.tags || []).map((t, i) => ({
        icon: '✕', label: t, onClick: () => removeTag(section, i),
      }));
      items.push({ divider: true });
      items.push({ icon: '➕', label: 'Add tag',
        onClick: () => addTagFlow(section, (input) => headerEl.insertBefore(input, sectionActions)) });
      showMiniMenu(tagsBtn, items);
    });
    tagsBtn.className = 'secondary section-tags-btn';
    tagsBtn.title = n ? n + ' tag' + (n === 1 ? '' : 's') : 'Add tags';
    // The merge bar (when present) was appended into `panel`; move the element onto
    // the header row. Its merge-mode target is still `panel` (closure), so selecting
    // blocks keeps working — the controls just live up here now.
    const mb = panel.querySelector(':scope > .merge-bar');
    // Shorten the relocated merge button to just its icon on the tight header row.
    const ms = mb && mb.querySelector('button');
    if (ms) { ms.textContent = '⛶'; ms.title = 'Merge'; }
    headerEl.append(toggle, titleInput, tagsBtn, ...(mb ? [mb] : []), sectionActions);
  } else {
    headerEl.append(toggle, titleInput, renderTags(section), sectionActions);
  }
  headerEl.addEventListener('click', (e) => {
    if (e.target === headerEl || e.target === toggle) {
      section.collapsed = !section.collapsed;
      el.classList.toggle('collapsed', section.collapsed);
      scheduleSave();
    }
  });

  el.append(headerEl, body);
  return el;
}

// Renders blocks then nested subsections into a container. sectionVarValues, when
// set, is the parent section's variable values object — passed to each block so
// it substitutes with the section's values instead of its own.
function renderSectionContent(container, blocks, subsections, sectionVarValues, onSecVarsRefresh) {
  // One unified merge selection spans this section's blocks AND its direct
  // subsections. They share a combined index space — blocks get 0..B-1,
  // subsections get B..B+S-1 — so buildMergeBar's sorted-index contract is kept
  // (no signature change) while a single bar selects across both.
  const B = blocks.length;
  const checks = [];   // {cb, idx: combinedIndex}
  let mergeApi = null;

  if (B + subsections.length >= 2) {
    mergeApi = buildMergeBar({
      label: '⛶ Merge',
      title: 'Combine selected blocks and subsections into one subsection',
      mergingClass: 'merging',
      target: container,
      checks,
      noun: 'items',
      onMerge: (chosen) => {
        const selBlocks = chosen.filter(g => g < B);
        const selSubs = chosen.filter(g => g >= B).map(g => g - B);
        mergeBlocksAndSubs(selBlocks, selSubs, blocks, subsections);
      },
    });
    container.appendChild(mergeApi.bar);
  }
  const syncAll = () => { if (mergeApi) mergeApi.syncSelectAll(); };

  blocks.forEach((block, bIdx) => {
    const be = renderBlock(block, blocks, bIdx, sectionVarValues, onSecVarsRefresh, subsections);
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'merge-check';
    cb.title = 'Select for merge';
    cb.addEventListener('change', syncAll);
    const toolbar = be.querySelector('.block-toolbar');
    if (toolbar) toolbar.prepend(cb);
    checks.push({ cb, idx: bIdx });
    // Reorder mode: up/down arrows to move this block within its section.
    if (reorderMode && blocks.length >= 2) attachReorderArrows(be, blocks, bIdx);
    container.appendChild(be);
  });

  if (subsections.length) {
    // Subsections render without their own merge bar; their checkboxes join the
    // unified selection above (combined index = B + subsection index).
    container.appendChild(renderSectionList(subsections, true, blocks, { checks, base: B, syncAll }));
  }
}

// Merge a unified selection (block indices + subsection indices) per the chosen
// semantics: blocks-only → join code into the topmost block; anything involving a
// subsection → combine everything into the topmost selected subsection.
function mergeBlocksAndSubs(selBlocks, selSubs, blocks, subsections) {
  if (!selSubs.length) {
    const top = selBlocks[0];
    blocks[top].code = selBlocks.map(i => blocks[i].code).join('\n\n');
    selBlocks.slice(1).sort((a, b) => b - a).forEach(i => blocks.splice(i, 1));
    renderPage();
    scheduleSave();
    toast('Merged ' + selBlocks.length + ' blocks');
    return;
  }
  const target = subsections[selSubs[0]];
  const tc = sectionContent(target);
  // selected blocks lead the subsection, in their original order
  tc.blocks.unshift(...selBlocks.map(i => blocks[i]));
  // fold the other selected subsections' content + tags into the target
  selSubs.slice(1).forEach(i => {
    const c = sectionContent(subsections[i]);
    tc.blocks.push(...c.blocks);
    tc.subsections.push(...c.subsections);
    if (subsections[i].tags) {
      target.tags = target.tags || [];
      subsections[i].tags.forEach(t => { if (!target.tags.includes(t)) target.tags.push(t); });
    }
  });
  // remove moved blocks and folded subsections (descending → indices stay valid)
  selBlocks.slice().sort((a, b) => b - a).forEach(i => blocks.splice(i, 1));
  selSubs.slice(1).sort((a, b) => b - a).forEach(i => subsections.splice(i, 1));
  renderPage();
  scheduleSave();
  toast('Merged ' + (selBlocks.length + selSubs.length) + ' items into “' + (target.title || 'subsection') + '”');
}

// Languages actually used by blocks anywhere in the app (from the tree index).
function usedLanguages() {
  const set = new Set();
  (function walk(nodes) {
    nodes.forEach(n => {
      if (n.type === 'page') (n.langs || []).forEach(l => set.add(l));
      else if (n.children) walk(n.children);
    });
  })(treeData);
  return set;
}

// Custom type picker: shows only in-use languages by default; the search box
// filters across the full master list so you can pick a not-yet-used one.
function createLangPicker(block, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'lang-picker';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'lang-picker-btn';
  const refreshBtn = () => { btn.textContent = langLabel(block.type) + '  ▾'; };
  refreshBtn();

  const panel = document.createElement('div');
  panel.className = 'lang-picker-panel';
  panel.style.display = 'none';

  const search = document.createElement('input');
  search.className = 'lang-picker-search';
  search.placeholder = 'Search all languages…';

  const list = document.createElement('div');
  list.className = 'lang-picker-list';
  panel.append(search, list);

  function buildList() {
    const q = search.value.trim().toLowerCase();
    list.innerHTML = '';
    let langs;
    if (q) {
      langs = LANGUAGES.filter(l => l.label.toLowerCase().includes(q) || l.id.toLowerCase().includes(q));
    } else {
      const used = usedLanguages();
      used.add(block.type); // always show the current type
      langs = LANGUAGES.filter(l => used.has(l.id));
    }
    if (!langs.length) {
      list.innerHTML = '<div class="lang-picker-empty">No matches</div>';
      return;
    }
    langs.forEach(l => {
      const opt = document.createElement('div');
      opt.className = 'lang-picker-opt' + (l.id === block.type ? ' current' : '');
      const dot = document.createElement('span');
      dot.className = 'lang-dot';
      dot.style.background = langColor(l.id);
      const t = document.createElement('span');
      t.textContent = l.label;
      opt.append(dot, t);
      opt.addEventListener('click', () => {
        block.type = l.id;
        refreshBtn();
        close();
        onChange();
      });
      list.appendChild(opt);
    });
  }

  function outside(e) { if (!wrap.contains(e.target) && !panel.contains(e.target)) close(); }
  function position() {
    const r = btn.getBoundingClientRect();
    panel.style.left = Math.round(r.left) + 'px';
    const h = panel.offsetHeight;
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
    panel.style.top = Math.round(top) + 'px';
  }
  function open() {
    panel.style.display = 'block';
    search.value = '';
    buildList();
    position();
    search.focus();
    document.addEventListener('mousedown', outside);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
  }
  function close() {
    panel.style.display = 'none';
    document.removeEventListener('mousedown', outside);
    window.removeEventListener('scroll', close, true);
    window.removeEventListener('resize', close);
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.style.display === 'block' ? close() : open();
  });
  search.addEventListener('input', () => { buildList(); position(); });
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  wrap.append(btn, panel);
  return wrap;
}

// Per-edit-session code backups, keyed by block object so they survive
// autosaves and re-renders until the session ends (save or revert).
const blockBackups = new WeakMap();

// Editor line metrics. The gutter, the transparent textarea, and the Prism
// view MUST share these EXACTLY or line numbers/caret drift apart (the Prism
// theme otherwise forces code to line-height:1.5). They're applied as INLINE
// styles in JS so they always win over the stylesheet (incl. a stale style.css)
// and over Prism's rules — making alignment immune to the CSS cascade.
const ED_LINE_H = 19;   // px per line — same for all three layers
const ED_FONT_SIZE = 13;
const ED_PAD = 10;      // top/left padding shared by view + textarea
const ED_FONT = '"SF Mono", Menlo, Consolas, monospace';

// Variables: a value wrapped as _V_NAME_V_ in the code becomes a fill-in field.
// parseVars returns the unique names in order of appearance; substituteVars
// replaces each marker with its value (or "MISSING VALUE" when empty).
const VAR_RE = /_V_([A-Za-z0-9_]+?)_V_/g;
function parseVars(code) {
  const names = []; let m;
  VAR_RE.lastIndex = 0;
  while ((m = VAR_RE.exec(code || '')) !== null) { if (!names.includes(m[1])) names.push(m[1]); }
  return names;
}
function substituteVars(code, values) {
  return (code || '').replace(VAR_RE, (_, name) => {
    const v = values && values[name];
    return (v && v.length) ? v : 'MISSING VALUE';
  });
}

/* ---------- MARKDOWN (note blocks) + CROSS-PAGE [[LINKS]] ---------- */

// Resolve a [[target]] wiki-link against the tree. `target` may be a full page
// path ("Folder/Page"), a bare page name ("Page"), with an optional "#Section"
// suffix (kept for display but not used to locate the file). Returns
// { path, found:true } when a page is located, else { found:false }.
function resolvePageLink(target) {
  const raw = String(target || '').trim();
  if (!raw) return { found: false };
  const hash = raw.indexOf('#');
  const pageRef = (hash === -1 ? raw : raw.slice(0, hash)).trim().replace(/\.json$/i, '');
  if (!pageRef) return { found: false };
  const all = [...collectPagePaths(treeData, new Set())];
  // exact path match (with or without .json), case-insensitive
  let hit = all.find(p => p.toLowerCase() === (pageRef + '.json').toLowerCase()
                       || p.toLowerCase() === pageRef.toLowerCase());
  // else match on bare page name (last path segment)
  if (!hit) hit = all.find(p => nameFromPath(p).toLowerCase() === pageRef.toLowerCase());
  return hit ? { path: hit, found: true } : { found: false };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Full CommonMark + GFM for note blocks, via the vendored markdown-it (tables,
// strikethrough, emphasis, images, nested lists, autolinks, task lists). It's
// configured with html:false so raw HTML in note source is escaped — the same
// escape-first posture the old hand-rolled renderer had. Three local rules layer
// CodeMan behavior on top: [[wiki-links]], GFM task-list checkboxes, and
// target/rel on external links. `renderMarkdown`/`renderInlineMd` keep their old
// names + signatures so every caller (the in-app note view + the HTML export) is
// untouched. markdown-it.min.js is loaded as a vendored <script> before this file.
const MD = window.markdownit({ html: false, linkify: true, breaks: true, typographer: false });

// [[wiki-link]] -> resolved internal link, or a dim "broken" span. Emitted as an
// html_inline token (rendered verbatim even under html:false) with the exact same
// markup the old renderer produced, so the note view's click wiring still matches.
MD.inline.ruler.before('link', 'wikilink', (state, silent) => {
  const src = state.src, start = state.pos;
  if (src.charCodeAt(start) !== 0x5B /* [ */ || src.charCodeAt(start + 1) !== 0x5B) return false;
  const close = src.indexOf(']]', start + 2);
  if (close < 0) return false;
  const target = src.slice(start + 2, close).trim();
  if (!target) return false;
  if (!silent) {
    const r = resolvePageLink(target);
    const label = escapeHtml(target);
    const token = state.push('html_inline', '', 0);
    token.content = r.found
      ? '<a class="xlink" data-xtarget="' + escapeHtml(target) + '" title="Open page">' + label + '</a>'
      : '<span class="xlink broken" title="No matching page">' + label + '</span>';
  }
  state.pos = close + 2;
  return true;
});

// GFM task lists: a list item whose text starts with "[ ]" / "[x]" becomes a
// disabled checkbox (read-only in the rendered note; editing the text re-renders).
MD.core.ruler.after('inline', 'task-lists', (state) => {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    if (tokens[i].type !== 'inline' || tokens[i - 1].type !== 'paragraph_open'
        || tokens[i - 2].type !== 'list_item_open') continue;
    const first = tokens[i].children && tokens[i].children[0];
    if (!first || first.type !== 'text') continue;
    const m = /^\[([ xX])\]\s+/.exec(first.content);
    if (!m) continue;
    first.content = first.content.slice(m[0].length);
    const box = new state.Token('html_inline', '', 0);
    box.content = '<input type="checkbox" disabled' + (m[1] === ' ' ? '' : ' checked') + '> ';
    tokens[i].children.unshift(box);
    tokens[i - 2].attrJoin('class', 'md-task');
  }
});

// External links open in a new tab; leave internal .xlink wiki anchors (no href) alone.
const baseLinkOpen = MD.renderer.rules.link_open
  || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
MD.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = tokens[idx].attrGet('href') || '';
  if (/^https?:/i.test(href)) { tokens[idx].attrSet('target', '_blank'); tokens[idx].attrSet('rel', 'noopener noreferrer'); }
  return baseLinkOpen(tokens, idx, options, env, self);
};

function renderMarkdown(src) { return MD.render(String(src || '')); }
function renderInlineMd(text) { return MD.renderInline(String(text || '')); }

// sectionVarValues: when the parent section owns the variables, its values object
// is passed in. The block then substitutes with it (no own toggle/panel) — the
// section and the block can't both own variables (mutual exclusion).
// Checklist (todo) block: interactive rows of { text, done }. Always live — you
// toggle/edit anytime, no separate edit mode — with a progress count and
// Enter-to-add / Backspace-to-remove keyboard flow like a real todo list.
function renderChecklistBlock(block, parentArray, idx) {
  const isMobile = document.body.classList.contains('is-mobile');
  if (!Array.isArray(block.items)) block.items = [];
  const el = document.createElement('div');
  el.className = 'block checklist';

  const toolbar = document.createElement('div');
  toolbar.className = 'block-toolbar';

  const labelInput = document.createElement('input');
  labelInput.className = 'block-label';
  labelInput.placeholder = 'Label (optional)';
  labelInput.value = block.label || '';
  labelInput.addEventListener('input', () => { block.label = labelInput.value; scheduleSave(); });

  const progress = document.createElement('span');
  progress.className = 'todo-progress';
  function updateProgress() {
    const total = block.items.length, done = block.items.filter(i => i.done).length;
    progress.textContent = total ? done + '/' + total : '';
    el.classList.toggle('all-done', total > 0 && done === total);
  }

  const spacer = document.createElement('span');
  spacer.className = 'spacer';

  const typeBtn = makeTypeMenuButton(block);

  const copyBtn = mkBtn('Copy', () => {
    const txt = block.items.map(i => (i.done ? '☑ ' : '☐ ') + i.text).join('\n');
    copyText(txt).then(ok => { if (ok) recordCopy(block); flashCopied(copyBtn, ok ? 'Copied to clipboard' : 'Copy failed'); });
  });
  copyBtn.className = 'secondary block-copy';
  copyBtn.title = 'Copy to clipboard';
  if (isMobile) copyBtn.textContent = '⧉';

  const dupBtn = mkBtn('Duplicate', () => {
    parentArray.push(JSON.parse(JSON.stringify(block)));
    renderPage();
    scheduleSave();
    toast('Block duplicated');
  });
  dupBtn.className = 'secondary block-dup';

  const clearBtn = mkBtn('Clear done', () => {
    block.items = block.items.filter(i => !i.done);
    if (!block.items.length) block.items.push({ text: '', done: false });
    renderItems();
    scheduleSave();
  });
  clearBtn.className = 'secondary block-clear';
  clearBtn.title = 'Remove all completed items';

  // Mobile: fold the convert-type / Duplicate / Clear-done controls behind a ⋯ menu
  // (same pattern as code blocks) so the toolbar is just [label · ⧉ · ⋯ · ✕].
  const overflowBtn = mkBtn('⋯', () => {
    showMiniMenu(overflowBtn, [
      { icon: '⧉', label: 'Duplicate', onClick: () => dupBtn.click() },
      { icon: '⊘', label: 'Clear done', onClick: () => clearBtn.click() },
      { divider: true },
      ...BLOCK_KINDS.map(k => ({
        icon: k.icon, label: k.label, active: blockKind(block) === k.kind,
        onClick: () => { convertBlock(block, k.kind); renderPage(); scheduleSave(); },
      })),
    ]);
  });
  overflowBtn.className = 'secondary block-overflow';
  overflowBtn.title = 'More actions';

  const delBtn = mkBtn('Delete', () => { parentArray.splice(idx, 1); renderPage(); scheduleSave(); });
  delBtn.className = 'danger';
  if (isMobile) { delBtn.textContent = '✕'; delBtn.title = 'Delete'; }

  toolbar.append(labelInput, progress, spacer, typeBtn, copyBtn, dupBtn, clearBtn, overflowBtn, delBtn);

  const listEl = document.createElement('div');
  listEl.className = 'todo-list';

  const focusItem = (i) => { const ins = listEl.querySelectorAll('.todo-text'); if (ins[i]) { ins[i].focus(); ins[i].setSelectionRange(ins[i].value.length, ins[i].value.length); } };

  function renderItem(item, i) {
    const row = document.createElement('div');
    row.className = 'todo-item' + (item.done ? ' done' : '');

    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.className = 'todo-check'; cb.checked = !!item.done;
    cb.addEventListener('change', () => { item.done = cb.checked; row.classList.toggle('done', cb.checked); updateProgress(); scheduleSave(); });

    const txt = document.createElement('input');
    txt.type = 'text'; txt.className = 'todo-text'; txt.value = item.text || ''; txt.placeholder = 'List item…';
    txt.addEventListener('input', () => { item.text = txt.value; scheduleSave(); });
    txt.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        block.items.splice(i + 1, 0, { text: '', done: false });
        renderItems(); focusItem(i + 1); scheduleSave();
      } else if (e.key === 'Backspace' && txt.value === '' && block.items.length > 1) {
        e.preventDefault();
        block.items.splice(i, 1);
        renderItems(); focusItem(Math.max(0, i - 1)); scheduleSave();
      }
    });

    const rm = mkBtn('×', () => {
      block.items.splice(i, 1);
      if (!block.items.length) block.items.push({ text: '', done: false });
      renderItems(); scheduleSave();
    });
    rm.className = 'todo-remove'; rm.title = 'Remove item';

    row.append(cb, txt, rm);
    return row;
  }

  function renderItems() {
    listEl.innerHTML = '';
    block.items.forEach((item, i) => listEl.appendChild(renderItem(item, i)));
    updateProgress();
  }

  const addRow = mkBtn('+ Add item', () => {
    block.items.push({ text: '', done: false });
    renderItems(); focusItem(block.items.length - 1); scheduleSave();
  });
  addRow.className = 'todo-add';

  renderItems();
  el.append(toolbar, listEl, addRow);
  return el;
}

// WYSIWYG rich-text block: a contentEditable surface with a formatting toolbar
// (bold/italic/underline, bulleted & numbered lists, font family/size/color).
// The toolbar shows only while editing; view mode shows just the formatted prose.
// Content is sanitized HTML in block.code. Uses document.execCommand — deprecated
// but universally supported and by far the simplest WYSIWYG path for a local tool.
function renderRichBlock(block, parentArray, idx) {
  const isMobile = document.body.classList.contains('is-mobile');
  const el = document.createElement('div');
  el.className = 'block rich' + (blockBackups.has(block) ? '' : ' viewing');

  const toolbar = document.createElement('div');
  toolbar.className = 'block-toolbar';

  const labelInput = document.createElement('input');
  labelInput.className = 'block-label';
  labelInput.placeholder = 'Label (optional)';
  labelInput.value = block.label || '';
  labelInput.addEventListener('input', () => { block.label = labelInput.value; scheduleSave(); });

  const spacer = document.createElement('span');
  spacer.className = 'spacer';

  // The editable surface. contentEditable is toggled with edit mode so view mode
  // is read-only (just the formatted text).
  const surface = document.createElement('div');
  surface.className = 'rich-surface';
  surface.innerHTML = sanitizeRichHtml(block.code || '') || '<p><br></p>';
  surface.setAttribute('contenteditable', el.classList.contains('viewing') ? 'false' : 'true');

  function refreshRevertLabel() {
    const backup = blockBackups.has(block) ? blockBackups.get(block) : (block.code || '');
    const dirty = (block.code || '') !== backup;
    revertBtn.textContent = dirty ? 'Revert' : 'Cancel';
    revertBtn.title = dirty ? 'Undo changes made since you started editing' : 'Exit edit mode (no changes)';
  }
  const syncFromSurface = () => { block.code = sanitizeRichHtml(surface.innerHTML); scheduleSave(); refreshRevertLabel(); };
  surface.addEventListener('input', syncFromSurface);
  // Tab / Shift+Tab nest & un-nest list items (like a real editor). Only when the
  // caret is inside a list item, so Tab elsewhere still moves focus out normally.
  surface.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const sel = window.getSelection();
    const node = sel && sel.anchorNode;
    if (!node || !surface.contains(node)) return;
    const inList = (node.nodeType === 1 ? node : node.parentElement)?.closest('li');
    if (!inList) return;
    e.preventDefault();
    ensureCss();
    try { document.execCommand(e.shiftKey ? 'outdent' : 'indent', false, null); } catch (err) {}
    syncFromSurface();
  });

  // ---- formatting toolbar (visible only while editing, via CSS) ----
  const fmt = document.createElement('div');
  fmt.className = 'rich-toolbar';
  let cssOn = false;
  const ensureCss = () => { if (!cssOn) { try { document.execCommand('styleWithCSS', false, true); } catch (e) {} cssOn = true; } };
  const exec = (cmd, val) => { ensureCss(); surface.focus(); try { document.execCommand(cmd, false, val == null ? null : val); } catch (e) {} syncFromSurface(); };
  const fmtBtn = (label, cmd, title) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'rich-btn'; b.innerHTML = label; b.title = title || cmd;
    b.addEventListener('mousedown', e => e.preventDefault());   // keep the selection in the surface
    b.addEventListener('click', e => { e.preventDefault(); exec(cmd); });
    return b;
  };
  const mkSel = (title, opts, onPick) => {
    const s = document.createElement('select'); s.className = 'rich-sel'; s.title = title;
    opts.forEach(([n, v]) => { const o = document.createElement('option'); o.textContent = n; o.value = v; s.append(o); });
    s.addEventListener('mousedown', () => surface.focus());
    s.addEventListener('change', () => { if (s.value) onPick(s.value); s.selectedIndex = 0; });
    return s;
  };

  fmt.append(
    fmtBtn('<b>B</b>', 'bold', 'Bold'),
    fmtBtn('<i>I</i>', 'italic', 'Italic'),
    fmtBtn('<u>U</u>', 'underline', 'Underline'),
    fmtBtn('<s>S</s>', 'strikeThrough', 'Strikethrough'),
  );
  const sep = () => { const s = document.createElement('span'); s.className = 'rich-sep'; return s; };
  fmt.append(sep(),
    fmtBtn('• List', 'insertUnorderedList', 'Bulleted list'),
    fmtBtn('1. List', 'insertOrderedList', 'Numbered list'),
    fmtBtn('⇤', 'outdent', 'Outdent (decrease list level) — Shift+Tab'),
    fmtBtn('⇥', 'indent', 'Indent (nest a sub-level) — Tab'),
  );
  fmt.append(sep(),
    mkSel('Font', [['Font', ''], ['Sans', 'Arial, Helvetica, sans-serif'], ['Serif', 'Georgia, "Times New Roman", serif'], ['Mono', '"SF Mono", Menlo, Consolas, monospace']], v => exec('fontName', v)),
    mkSel('Font size', [['Size', ''], ['Small', '2'], ['Normal', '3'], ['Large', '5'], ['X-Large', '6'], ['Huge', '7']], v => exec('fontSize', v)),
    mkSel('Paragraph style', [['Style', ''], ['Heading 1', 'H1'], ['Heading 2', 'H2'], ['Heading 3', 'H3'], ['Normal', 'P'], ['Quote', 'BLOCKQUOTE']], v => exec('formatBlock', v)),
  );

  // Color picker. The native picker steals focus and clears the selection, so we
  // stash the range on mousedown and restore it before applying the color.
  const colorLabel = document.createElement('label');
  colorLabel.className = 'rich-color'; colorLabel.title = 'Text color';
  const colorInput = document.createElement('input');
  colorInput.type = 'color'; colorInput.value = '#e8a35c';
  const colorGlyph = document.createElement('span'); colorGlyph.textContent = 'A';
  colorLabel.append(colorGlyph, colorInput);
  let savedRange = null;
  colorInput.addEventListener('mousedown', () => {
    const s = window.getSelection();
    if (s && s.rangeCount && surface.contains(s.anchorNode)) savedRange = s.getRangeAt(0).cloneRange();
  });
  colorInput.addEventListener('input', () => {
    surface.focus();
    if (savedRange) { const s = window.getSelection(); s.removeAllRanges(); s.addRange(savedRange); }
    colorGlyph.style.color = colorInput.value;
    ensureCss();
    try { document.execCommand('foreColor', false, colorInput.value); } catch (e) {}
    syncFromSurface();
  });
  fmt.append(sep(), colorLabel, fmtBtn('⌫', 'removeFormat', 'Clear formatting'));

  // ---- Edit / Save / Revert / Copy / Duplicate / convert / Delete ----
  function enterEdit() {
    blockBackups.set(block, block.code || '');
    el.classList.remove('viewing');
    surface.setAttribute('contenteditable', 'true');
    refreshRevertLabel();
    surface.focus();
  }
  const editBtn = mkBtn('Edit', enterEdit);
  editBtn.className = 'secondary block-edit';
  if (isMobile) { editBtn.textContent = '✎'; editBtn.title = 'Edit'; }

  const saveBtn = mkBtn('Save', () => {
    block.code = sanitizeRichHtml(surface.innerHTML);
    blockBackups.delete(block);
    el.classList.add('viewing');
    surface.setAttribute('contenteditable', 'false');
    surface.innerHTML = sanitizeRichHtml(block.code || '') || '<p><br></p>';
    savePage();
    toast('Saved');
  });
  saveBtn.className = 'block-save';
  if (isMobile) { saveBtn.textContent = '✓'; saveBtn.title = 'Save'; }

  const revertBtn = mkBtn('Cancel', () => {
    const backup = blockBackups.has(block) ? blockBackups.get(block) : (block.code || '');
    if ((block.code || '') !== backup) {
      block.code = backup;
      surface.innerHTML = sanitizeRichHtml(backup) || '<p><br></p>';
      el.classList.remove('viewing');
      surface.setAttribute('contenteditable', 'true');
      savePage();
      refreshRevertLabel();
      surface.focus();
      toast('Reverted');
    } else {
      blockBackups.delete(block);
      el.classList.add('viewing');
      surface.setAttribute('contenteditable', 'false');
    }
  });
  revertBtn.className = 'secondary block-revert';

  const copyBtn = mkBtn('Copy', () => {
    copyText(surface.innerText || '').then(ok => { if (ok) recordCopy(block); flashCopied(copyBtn, ok ? 'Copied to clipboard' : 'Copy failed'); });
  });
  copyBtn.className = 'secondary block-copy';
  copyBtn.title = 'Copy to clipboard';
  if (isMobile) copyBtn.textContent = '⧉';

  const dupBtn = mkBtn('Duplicate', () => {
    parentArray.push(JSON.parse(JSON.stringify(block)));
    renderPage();
    scheduleSave();
    toast('Block duplicated');
  });
  dupBtn.className = 'secondary block-dup';

  // Unified "type" switch (convert to Code / Note / Checklist, keeping the text).
  // Sync the latest HTML into block.code first so the conversion sees current text.
  const typeBtn = makeTypeMenuButton(block);
  typeBtn.addEventListener('mousedown', () => { block.code = sanitizeRichHtml(surface.innerHTML); }, true);

  // Mobile: fold Duplicate + convert-type behind a ⋯ menu (mirrors code blocks) so
  // the toolbar is just [label · ✎/✓ Cancel · ⧉ · ⋯ · ✕]. Sync the surface HTML into
  // block.code before converting so the new kind keeps the current text.
  const overflowBtn = mkBtn('⋯', () => {
    showMiniMenu(overflowBtn, [
      { icon: '⧉', label: 'Duplicate', onClick: () => dupBtn.click() },
      { divider: true },
      ...BLOCK_KINDS.map(k => ({
        icon: k.icon, label: k.label, active: blockKind(block) === k.kind,
        onClick: () => { block.code = sanitizeRichHtml(surface.innerHTML); convertBlock(block, k.kind); renderPage(); scheduleSave(); },
      })),
    ]);
  });
  overflowBtn.className = 'secondary block-overflow';
  overflowBtn.title = 'More actions';

  const delBtn = mkBtn('Delete', () => { parentArray.splice(idx, 1); renderPage(); scheduleSave(); });
  delBtn.className = 'danger';
  if (isMobile) { delBtn.textContent = '✕'; delBtn.title = 'Delete'; }

  toolbar.append(labelInput, spacer, typeBtn, editBtn, saveBtn, revertBtn, copyBtn, dupBtn, overflowBtn, delBtn);
  el.append(toolbar, fmt, surface);
  refreshRevertLabel();
  return el;
}

// CSV (table) block: a textarea of raw CSV while editing (with a live table
// preview underneath), a rendered table while viewing. Malformed CSV never breaks
// the view — parseCsv is tolerant and the view shows a warning banner for
// unterminated quotes or ragged rows. First row is treated as the header.
function renderCsvBlock(block, parentArray, idx) {
  const isMobile = document.body.classList.contains('is-mobile');
  const el = document.createElement('div');
  el.className = 'block csv' + (blockBackups.has(block) ? '' : ' viewing');

  const toolbar = document.createElement('div');
  toolbar.className = 'block-toolbar';

  const labelInput = document.createElement('input');
  labelInput.className = 'block-label';
  labelInput.placeholder = 'Label (optional)';
  labelInput.value = block.label || '';
  labelInput.addEventListener('input', () => { block.label = labelInput.value; scheduleSave(); });

  const spacer = document.createElement('span');
  spacer.className = 'spacer';

  // The CSV source editor (visible only while editing, via CSS).
  const textarea = document.createElement('textarea');
  textarea.className = 'csv-edit';
  textarea.value = block.code || '';
  textarea.spellcheck = false;
  textarea.setAttribute('autocapitalize', 'off');
  textarea.setAttribute('autocorrect', 'off');
  textarea.placeholder = 'Enter CSV — the first row is the header.\nname,age,city\nAda,36,London';

  // The rendered table / preview (visible while viewing; also shown live while editing).
  const view = document.createElement('div');
  view.className = 'csv-view';

  function autosize() {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight + 2, editorCapPx()) + 'px';
  }
  textarea._autosize = autosize;

  function renderTable() {
    view.innerHTML = '';
    const raw = block.code || '';
    if (!raw.trim()) {
      const empty = document.createElement('div');
      empty.className = 'csv-empty';
      empty.textContent = 'Empty table — edit and enter comma-separated values (first row = header).';
      view.appendChild(empty);
      return;
    }
    const { rows, unterminated } = parseCsv(raw);
    const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const ragged = rows.some(r => r.length !== cols);
    if (unterminated || ragged) {
      const warn = document.createElement('div');
      warn.className = 'csv-warn';
      warn.textContent = unterminated
        ? '⚠ Unterminated quote (") in the CSV — showing a best-effort parse.'
        : '⚠ Rows have differing column counts — short rows were padded. Check the CSV.';
      view.appendChild(warn);
    }
    const wrap = document.createElement('div'); wrap.className = 'csv-table-wrap';
    const table = document.createElement('table'); table.className = 'csv-table';
    const header = rows[0] || [];
    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    for (let c = 0; c < cols; c++) {
      const th = document.createElement('th');
      th.textContent = header[c] != null ? header[c] : '';
      htr.appendChild(th);
    }
    thead.appendChild(htr); table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (let r = 1; r < rows.length; r++) {
      const tr = document.createElement('tr');
      for (let c = 0; c < cols; c++) {
        const td = document.createElement('td');
        const v = rows[r][c];
        if (v == null) td.className = 'csv-pad';            // padded (missing) cell
        else td.textContent = v;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody); wrap.appendChild(table); view.appendChild(wrap);
  }

  const typeBtn = makeTypeMenuButton(block);
  // sync the textarea into block.code before any convert reads it
  typeBtn.addEventListener('mousedown', () => { block.code = textarea.value; }, true);

  function refreshRevertLabel() {
    const backup = blockBackups.has(block) ? blockBackups.get(block) : (block.code || '');
    const dirty = (block.code || '') !== backup;
    revertBtn.textContent = dirty ? 'Revert' : 'Cancel';
    revertBtn.title = dirty ? 'Undo changes made since you started editing' : 'Exit edit mode (no changes)';
  }

  textarea.addEventListener('input', () => {
    block.code = textarea.value; renderTable(); autosize(); scheduleSave(); refreshRevertLabel();
  });

  function enterEdit() {
    blockBackups.set(block, block.code || '');
    el.classList.remove('viewing');
    refreshRevertLabel();
    requestAnimationFrame(() => { autosize(); textarea.focus(); });
  }
  const editBtn = mkBtn('Edit', enterEdit);
  editBtn.className = 'secondary block-edit';
  if (isMobile) { editBtn.textContent = '✎'; editBtn.title = 'Edit'; }

  const saveBtn = mkBtn('Save', () => {
    block.code = textarea.value;
    blockBackups.delete(block);
    el.classList.add('viewing');
    renderTable();
    savePage();
    toast('Saved');
  });
  saveBtn.className = 'block-save';
  if (isMobile) { saveBtn.textContent = '✓'; saveBtn.title = 'Save'; }

  const revertBtn = mkBtn('Cancel', () => {
    const backup = blockBackups.has(block) ? blockBackups.get(block) : (block.code || '');
    if ((block.code || '') !== backup) {
      block.code = backup; textarea.value = backup;
      el.classList.remove('viewing');
      renderTable(); autosize(); savePage(); refreshRevertLabel(); textarea.focus();
      toast('Reverted');
    } else {
      blockBackups.delete(block);
      el.classList.add('viewing');
    }
  });
  revertBtn.className = 'secondary block-revert';

  const copyBtn = mkBtn('Copy', () => {
    copyText(block.code || '').then(ok => { if (ok) recordCopy(block); flashCopied(copyBtn, ok ? 'Copied to clipboard' : 'Copy failed'); });
  });
  copyBtn.className = 'secondary block-copy';
  copyBtn.title = 'Copy raw CSV to clipboard';
  if (isMobile) copyBtn.textContent = '⧉';

  const dupBtn = mkBtn('Duplicate', () => {
    parentArray.push(JSON.parse(JSON.stringify(block)));
    renderPage();
    scheduleSave();
    toast('Block duplicated');
  });
  dupBtn.className = 'secondary block-dup';

  const overflowBtn = mkBtn('⋯', () => {
    showMiniMenu(overflowBtn, [
      { icon: '⧉', label: 'Duplicate', onClick: () => dupBtn.click() },
      { divider: true },
      ...BLOCK_KINDS.map(k => ({
        icon: k.icon, label: k.label, active: blockKind(block) === k.kind,
        onClick: () => { block.code = textarea.value; convertBlock(block, k.kind); renderPage(); scheduleSave(); },
      })),
    ]);
  });
  overflowBtn.className = 'secondary block-overflow';
  overflowBtn.title = 'More actions';

  const delBtn = mkBtn('Delete', () => { parentArray.splice(idx, 1); renderPage(); scheduleSave(); });
  delBtn.className = 'danger';
  if (isMobile) { delBtn.textContent = '✕'; delBtn.title = 'Delete'; }

  toolbar.append(labelInput, spacer, typeBtn, editBtn, saveBtn, revertBtn, copyBtn, dupBtn, overflowBtn, delBtn);
  el.append(toolbar, textarea, view);
  renderTable();
  if (!el.classList.contains('viewing')) requestAnimationFrame(autosize);
  return el;
}

function renderBlock(block, parentArray, idx, sectionVarValues, onSecVarsRefresh, subsectionsArray) {
  // Rich-text and checklist blocks aren't code/markdown surfaces — render them
  // via their own paths (no gutter, lang picker, variables, etc.).
  if (block.checklist) return renderChecklistBlock(block, parentArray, idx);
  if (block.rich) return renderRichBlock(block, parentArray, idx);
  if (block.csv) return renderCsvBlock(block, parentArray, idx);

  const el = document.createElement('div');
  // stay in edit mode if an edit session backup exists for this block
  el.className = 'block' + (blockBackups.has(block) ? '' : ' viewing');
  const sectionControlled = !!sectionVarValues;
  const refreshSectionVars = () => { if (sectionControlled && onSecVarsRefresh) onSecVarsRefresh(); };
  const varsActive = () => sectionControlled || !!block.varsOn;
  const varValuesNow = () => sectionControlled ? sectionVarValues : (block.varValues || {});
  // On a phone the toolbar goes icon-only and folds its secondary controls into the
  // ⋯ menu. Read the flag at render time (blocks re-render on demand, and the
  // matchMedia listener re-renders when the breakpoint flips), so the bar always
  // matches the current viewport. Desktop keeps the full text toolbar untouched.
  const isMobile = document.body.classList.contains('is-mobile');
  // On mobile, scale every editor layer up together so the code textarea is ≥16px
  // (iOS won't focus-zoom into it) and code is more readable. ALL layers — gutter,
  // .ln, textarea, view, pre, code — read THESE locals (not ED_* directly), so the
  // transparent textarea stays pixel-aligned with the Prism overlay (the gutter-
  // alignment gotcha). Desktop keeps the module constants exactly (13/19).
  const edFont = isMobile ? 16 : ED_FONT_SIZE;
  const edLineH = isMobile ? 24 : ED_LINE_H;   // ~1.5× of 16, mirrors the 13/19 ratio

  const toolbar = document.createElement('div');
  toolbar.className = 'block-toolbar';

  const typePicker = createLangPicker(block, () => {
    updatePreview();
    scheduleSave();
  });

  const labelInput = document.createElement('input');
  labelInput.className = 'block-label';
  labelInput.placeholder = 'Label (optional)';
  labelInput.value = block.label || '';
  labelInput.addEventListener('input', () => {
    block.label = labelInput.value;
    scheduleSave();
  });

  const spacer = document.createElement('span');
  spacer.className = 'spacer';

  // Line numbers are ON by default for every block; the toggle hides them per block.
  const linesOn = block.showLines !== false;
  const lineToggle = mkBtn('#', () => {
    const on = !el.classList.contains('show-lines');
    block.showLines = on;
    el.classList.toggle('show-lines', on);
    lineToggle.classList.toggle('on', on);
    lineToggle.setAttribute('aria-pressed', String(on));
    updateGutter();
    scheduleSave();
  });
  lineToggle.className = 'secondary line-toggle' + (linesOn ? ' on' : '');
  lineToggle.title = 'Toggle line numbers';
  lineToggle.setAttribute('aria-label', 'Toggle line numbers');
  lineToggle.setAttribute('aria-pressed', String(linesOn));

  // Variables toggle (off by default): when on, _V_NAME_V_ markers become
  // fill-in fields shown above the code in view mode, substituted into the
  // rendered code and into Copy. Hidden when the section owns variables.
  const varsOn = !!block.varsOn;
  const varToggle = mkBtn('$', () => {
    block.varsOn = !block.varsOn;
    // re-render the page so the parent section's variables toggle reflects the
    // new state (they're mutually exclusive).
    renderPage();
    scheduleSave();
  });
  varToggle.className = 'secondary var-toggle' + (varsOn ? ' on' : '');
  varToggle.title = 'Toggle variables — wrap a value as _V_NAME_V_, then fill it in';
  varToggle.setAttribute('aria-label', 'Toggle variables');
  varToggle.setAttribute('aria-pressed', String(varsOn));

  // One "type" switch replaces the old ¶ / T toggles — convert to any kind.
  const typeBtn = makeTypeMenuButton(block);

  // Back up the block's code when an edit session begins. Keyed by the block
  // object (in blockBackups), so it survives autosaves AND any re-render of the
  // block during the session. Captured once per session; cleared on save.
  function enterEdit() {
    // (Re)baseline this edit session to the current code, so the button reads
    // "Cancel" until you actually change something — even when re-entering a
    // block you previously edited and clicked away from.
    blockBackups.set(block, block.code || '');
    el.classList.remove('viewing');
    updatePreview();   // show the raw template (with markers) while editing
    refreshRevertLabel();
    textarea.focus();
    if (block.note) autosizeNote(); else autosizeCode();   // fit the editor to its content on edit-enter
  }
  const editBtn = mkBtn('Edit', enterEdit);
  editBtn.className = 'secondary block-edit';
  if (isMobile) { editBtn.textContent = '✎'; editBtn.title = 'Edit'; }

  const saveBtn = mkBtn('Save', () => {
    blockBackups.delete(block); // commit: end the edit session
    el.classList.add('viewing');
    if (block.note) { userMin = 0; textarea.style.height = ''; }  // reset note autosize for next edit
    else { codeWrap.style.height = ''; userCodeH = 0; }   // drop any manual code-editor resize on exit
    updateActiveLine();         // clear the caret-line highlight (now viewing)
    renderVarsPanel();          // refresh block-level var fields for added/removed _V_…_V_
    refreshSectionVars();       // …and the section variables panel, if section-owned
    updatePreview();
    savePage();
    toast('Saved');
  });
  saveBtn.className = 'block-save';
  if (isMobile) { saveBtn.textContent = '✓'; saveBtn.title = 'Save'; }

  // The same button is "Cancel" until you change something, then "Revert".
  function blockDirty() {
    const backup = blockBackups.has(block) ? blockBackups.get(block) : (block.code || '');
    return (block.code || '') !== backup;
  }
  function refreshRevertLabel() {
    const dirty = blockDirty();
    revertBtn.textContent = dirty ? 'Revert' : 'Cancel';
    revertBtn.title = dirty ? 'Undo changes made since you started editing'
                            : 'Exit edit mode (no changes)';
  }
  const revertBtn = mkBtn('Cancel', () => {
    if (blockDirty()) {
      // revert: restore the original code, stay in edit mode
      const backup = blockBackups.has(block) ? blockBackups.get(block) : (block.code || '');
      block.code = backup;
      textarea.value = backup;
      el.classList.remove('viewing');
      if (block.note) autosizeNote();   // re-fit to the reverted content
      updateGutter();
      renderVarsPanel();          // code reverted → refresh var fields
      refreshSectionVars();
      updatePreview();
      savePage();                 // persist the revert (overrides autosaved edits)
      refreshRevertLabel();       // back to "Cancel" now that it's clean
      textarea.focus();
      toast('Reverted');
    } else {
      // cancel: just leave edit mode
      blockBackups.delete(block);
      el.classList.add('viewing');
      if (block.note) { userMin = 0; textarea.style.height = ''; }  // reset note autosize
      else { codeWrap.style.height = ''; userCodeH = 0; }   // drop any manual code-editor resize on exit
      renderVarsPanel();
      updatePreview();
    }
  });
  revertBtn.className = 'secondary block-revert';

  const copyBtn = mkBtn('Copy', () => {
    const out = varsActive() ? substituteVars(block.code, varValuesNow()) : (block.code || '');
    const vals = varValuesNow();
    const missing = varsActive() && parseVars(block.code).some(n => !vals[n]);
    copyText(out).then(ok => {
      if (ok) recordCopy(block);
      flashCopied(copyBtn, ok ? (missing ? 'Copied — vars missing' : 'Copied to clipboard') : 'Copy failed');
    });
  });
  copyBtn.className = 'secondary block-copy';
  copyBtn.title = 'Copy to clipboard';
  if (isMobile) copyBtn.textContent = '⧉';

  // Alternative clipboard formats for the block's code. On desktop this is the "▾"
  // button next to Copy; on mobile the same options live inside the ⋯ menu (the
  // button is hidden there, so its self-anchored popup would mis-position). The
  // option list is shared via copyAsOptions() so both paths stay in sync.
  function copyAsOptions() {
    const raw = block.code || '';
    const filled = varsActive() ? substituteVars(block.code, varValuesNow()) : raw;
    const lang = block.note ? 'markdown' : (block.type || '');
    const opts = [];
    if (varsActive()) opts.push(['Variables filled', filled], ['Raw template', raw]);
    else opts.push(['Raw', raw]);
    opts.push(
      ['Fenced Markdown', '```' + lang + '\n' + filled + '\n```'],
      ['Escaped string', JSON.stringify(filled)],
      ['One line', filled.replace(/\s*\n\s*/g, ' ').trim()]
    );
    return opts;
  }
  const copyAsBtn = mkBtn('▾', () => {
    const existing = document.querySelector('.mini-menu');
    if (existing) { existing.remove(); return; }
    const menu = document.createElement('div'); menu.className = 'mini-menu';
    const r = copyAsBtn.getBoundingClientRect();
    menu.style.top = Math.round(r.bottom + 4) + 'px';
    menu.style.left = Math.round(Math.max(8, r.right - 200)) + 'px';
    copyAsOptions().forEach(([label, text]) => {
      const o = document.createElement('div'); o.className = 'mini-menu-opt'; o.textContent = label;
      o.onclick = () => { menu.remove(); copyText(text).then(ok => { if (ok) recordCopy(block); toast(ok ? 'Copied: ' + label : 'Copy failed'); }); };
      menu.appendChild(o);
    });
    document.body.appendChild(menu);
    const off = (e) => { if (!menu.contains(e.target) && e.target !== copyAsBtn) { menu.remove(); document.removeEventListener('mousedown', off); } };
    setTimeout(() => document.addEventListener('mousedown', off), 0);
  });
  copyAsBtn.className = 'secondary copy-as';
  copyAsBtn.title = 'Copy as… (Markdown, escaped string, one line)';

  const dupBtn = mkBtn('Duplicate', () => {
    // deep-copy this block and add the copy at the bottom of the section
    const copy = JSON.parse(JSON.stringify(block));
    parentArray.push(copy);
    renderPage();
    scheduleSave();
    toast('Block duplicated');
  });
  dupBtn.className = 'secondary block-dup';

  // Split this block into several — inverse of Merge. Splits on blank-line gaps
  // (Merge joins with a blank line); if there are none, splits at the caret.
  const splitBtn = mkBtn('Split', () => {
    const code = block.code || '';
    let parts = code.split(/\n[ \t]*\n[ \t]*\n*/).map(s => s.replace(/^\n+|\n+$/g, '')).filter(s => s.trim() !== '');
    if (parts.length < 2) {
      const pos = (document.activeElement === textarea) ? textarea.selectionStart : 0;
      if (pos > 0 && pos < code.length) parts = [code.slice(0, pos).replace(/\n+$/, ''), code.slice(pos).replace(/^\n+/, '')];
    }
    if (parts.length < 2) { toast('Nothing to split — add a blank line or place the cursor'); return; }
    block.code = parts[0];
    const rest = parts.slice(1).map(c => Object.assign(JSON.parse(JSON.stringify(block)), { code: c }));
    parentArray.splice(idx + 1, 0, ...rest);
    renderPage();
    scheduleSave();
    toast('Split into ' + parts.length + ' blocks');
  });
  splitBtn.className = 'secondary block-split';
  splitBtn.title = 'Split into separate blocks (on blank lines, or at the cursor)';

  // Move this block into a brand-new subsection in the same section (the block
  // is pulled out of its current list and becomes the new subsection's content).
  const toSubBtn = mkBtn('⤵ To subsection', () => {
    if (!subsectionsArray) return;
    parentArray.splice(idx, 1);
    const sub = newSection(block.label || 'New Subsection');
    sub.blocks.push(block);
    subsectionsArray.push(sub);
    renderPage();
    scheduleSave();
    toast('Block moved into a new subsection');
  });
  toSubBtn.className = 'secondary block-tosub';
  toSubBtn.title = 'Move this block into a new subsection in this section';

  const delBtn = mkBtn('Delete', () => {
    parentArray.splice(idx, 1);
    renderPage();
    scheduleSave();
  });
  delBtn.className = 'danger';
  if (isMobile) { delBtn.textContent = '✕'; delBtn.title = 'Delete'; }

  // Mobile-only "⋯" overflow: tucks the less-common actions behind a menu so the
  // icon toolbar stays compact on a phone. Direct-action buttons stay in the DOM
  // (CSS-hidden on mobile) and the menu items fire their .click() so the real
  // handlers run with no duplication. The block-kind switch and Copy-as formats are
  // rebuilt as items here (not proxied): copyAsBtn's popup anchors to its own rect,
  // which is invalid while it's hidden. Desktop never renders ⋯ (display:none unless
  // body.is-mobile), so its toolbar is unchanged.
  const overflowBtn = mkBtn('⋯', () => {
    const items = [];
    if (!block.note) items.push({ icon: '#', label: 'Line numbers',
      active: el.classList.contains('show-lines'), onClick: () => lineToggle.click() });
    if (!sectionControlled) items.push({ icon: '$', label: 'Variables',
      active: !!block.varsOn, onClick: () => varToggle.click() });
    items.push({ icon: '⧉', label: 'Duplicate', onClick: () => dupBtn.click() });
    if (!block.note) items.push({ icon: '⎘', label: 'Split', onClick: () => splitBtn.click() });
    if (subsectionsArray) items.push({ icon: '⤵', label: 'To subsection', onClick: () => toSubBtn.click() });
    // Block-kind switch (replaces the "Code ▾" button, folded into ⋯ on mobile).
    items.push({ divider: true });
    BLOCK_KINDS.forEach(k => items.push({
      icon: k.icon, label: k.label, active: blockKind(block) === k.kind,
      onClick: () => { convertBlock(block, k.kind); renderPage(); scheduleSave(); },
    }));
    // Copy-as formats (replaces the "▾" button, folded into ⋯ on mobile).
    items.push({ divider: true });
    copyAsOptions().forEach(([label, text]) => items.push({
      icon: '▾', label: 'Copy: ' + label,
      onClick: () => { copyText(text).then(ok => { if (ok) recordCopy(block); toast(ok ? 'Copied: ' + label : 'Copy failed'); }); },
    }));
    showMiniMenu(overflowBtn, items);
  });
  overflowBtn.className = 'secondary block-overflow';
  overflowBtn.title = 'More actions';

  // The block's own $ toggle is hidden when the section owns variables.
  // Note blocks render Markdown prose, so the language picker, line-number and
  // Split controls (all code-only) are omitted from their toolbar.
  const toolbarBtns = block.note ? [labelInput, spacer] : [typePicker, labelInput, spacer, lineToggle];
  if (!sectionControlled) toolbarBtns.push(varToggle);
  toolbarBtns.push(typeBtn, editBtn, saveBtn, revertBtn, copyBtn, copyAsBtn, dupBtn);
  if (!block.note) toolbarBtns.push(splitBtn);
  if (subsectionsArray) toolbarBtns.push(toSubBtn);   // between Split and Delete
  toolbarBtns.push(overflowBtn, delBtn);   // ⋯ sits just left of Delete (mobile only)
  toolbar.append(...toolbarBtns);

  // Fill-in fields for the block's variables (shown above the code in view mode).
  const varsPanel = document.createElement('div');
  varsPanel.className = 'block-vars';
  function renderVarsPanel() {
    varsPanel.innerHTML = '';
    if (sectionControlled || !block.varsOn) return; // section owns the fields
    const names = parseVars(block.code);
    if (!names.length) {
      const e = document.createElement('div');
      e.className = 'block-vars-empty';
      e.textContent = 'No variables yet — wrap a value in the code like _V_NAME_V_';
      varsPanel.appendChild(e);
      return;
    }
    block.varValues = block.varValues || {};
    names.forEach(name => {
      const row = document.createElement('div'); row.className = 'var-row';
      const lab = document.createElement('label'); lab.className = 'var-name'; lab.textContent = name;
      const inp = document.createElement('input'); inp.className = 'var-input'; inp.placeholder = 'MISSING VALUE';
      inp.value = block.varValues[name] || '';
      inp.addEventListener('input', () => {
        block.varValues[name] = inp.value;
        updatePreview();   // live-substitute into the rendered code
        scheduleSave();
      });
      row.append(lab, inp);
      varsPanel.appendChild(row);
    });
  }

  const codeWrap = document.createElement('div');
  codeWrap.className = 'code-wrap';

  const gutter = document.createElement('div');
  gutter.className = 'line-gutter';
  // Pin the gutter's metrics inline so they match the view/textarea exactly.
  gutter.style.paddingTop = ED_PAD + 'px';
  gutter.style.paddingBottom = ED_PAD + 'px';
  gutter.style.lineHeight = edLineH + 'px';
  gutter.style.fontSize = edFont + 'px';
  gutter.style.fontFamily = ED_FONT;
  // One element per line so we can highlight the line being edited.
  function updateGutter() {
    const n = Math.max(1, (block.code || '').split('\n').length);
    if (gutter.childElementCount !== n) {
      const frag = document.createDocumentFragment();
      for (let i = 1; i <= n; i++) {
        const d = document.createElement('div');
        d.className = 'ln';
        d.textContent = i;
        d.style.height = edLineH + 'px';
        d.style.lineHeight = edLineH + 'px';
        frag.appendChild(d);
      }
      gutter.textContent = '';
      gutter.appendChild(frag);
    }
    updateActiveLine();
  }
  // Highlight the gutter number for the caret's line — only while editing.
  function updateActiveLine() {
    const lines = gutter.children;
    if (el.classList.contains('viewing')) {
      for (let i = 0; i < lines.length; i++) lines[i].classList.remove('active');
      return;
    }
    const pos = textarea.selectionStart || 0;
    const idx = (textarea.value.slice(0, pos).match(/\n/g) || []).length;
    for (let i = 0; i < lines.length; i++) lines[i].classList.toggle('active', i === idx);
  }

  const textarea = document.createElement('textarea');
  textarea.className = 'code-edit';
  textarea.value = block.code || '';
  textarea.spellcheck = false;
  // Stop the browser AND extensions (Grammarly etc.) from drawing squiggle/underline
  // overlays inside the code editor — they're meaningless on code and leave stray lines.
  textarea.autocapitalize = 'off';
  textarea.autocomplete = 'off';
  textarea.setAttribute('autocorrect', 'off');
  textarea.setAttribute('data-gramm', 'false');
  textarea.setAttribute('data-gramm_editor', 'false');
  textarea.setAttribute('data-enable-grammarly', 'false');
  // Inline metrics so the caret/text layout matches the gutter + view exactly.
  textarea.style.lineHeight = edLineH + 'px';
  textarea.style.fontSize = edFont + 'px';
  textarea.style.fontFamily = ED_FONT;
  textarea.style.padding = ED_PAD + 'px';
  // The textarea is transparent and overlays the colored layer; keep the layer
  // scrolled in lockstep so the visible colors track the caret.
  function syncScroll() {
    // The textarea is the single scroller; keep the colored layer AND the line-number
    // gutter locked to it (both are bounded + overflow:hidden while editing) so all three
    // layers move together and stay aligned when the editor is capped/resized.
    view.scrollTop = textarea.scrollTop;
    view.scrollLeft = textarea.scrollLeft;
    gutter.scrollTop = textarea.scrollTop;
  }
  textarea.addEventListener('input', () => {
    block.code = textarea.value;
    updateGutter();
    updatePreview();   // re-highlight the layer live so colors follow your typing
    syncScroll();
    if (block.note) autosizeNote(); else autosizeCode();   // re-fit as you type (both capped)
    refreshRevertLabel();
    scheduleSave();
  });
  textarea.addEventListener('scroll', syncScroll);

  // ----- Note auto-grow ---------------------------------------------------------
  // Code/rich editors grow on their own (the Prism view sizes the code stack;
  // contentEditable expands) and are capped purely in CSS. A <textarea> does NOT
  // grow to its content, so notes size here: set height to the content height,
  // which CSS `max-height` caps (then it scrolls). A manual drag of the
  // `resize:vertical` handle records a floor (`userMin`) the autosizer respects, so
  // typing still grows past a drag but the dragged size isn't lost. Reset on leaving
  // edit (Save/Cancel) so the next session re-fits.
  let userMin = 0, lastAutoH = 0;
  function autosizeNote() {
    if (!block.note) return;
    textarea.style.height = 'auto';
    lastAutoH = Math.max(textarea.scrollHeight, userMin);
    textarea.style.height = lastAutoH + 'px';
  }
  textarea._autosize = autosizeNote;   // let the global resize listener re-fit open notes
  textarea.addEventListener('mouseup', () => {   // end of a manual resize-handle drag
    if (block.note && textarea.offsetHeight > lastAutoH + 2) userMin = textarea.offsetHeight;
  });

  // ----- Code editor sizing (JS-driven, so it NEVER depends on the gutter) ----------
  // The editor height = content height (line count), clamped to a fraction of the
  // viewport — OR a height the user dragged via the resize handle. We set it on
  // .code-wrap; align-items:stretch propagates it to the gutter + stack, and the
  // inset:0 .code-view / .code-edit fill it. The textarea (overflow:auto) is the real
  // scroller (so the wheel scrolls anywhere over the code), with the colored layer and
  // gutter synced via syncScroll. Driving the height here (not from the gutter's
  // in-flow line-number rows) keeps it correct whether line numbers are on or off.
  let userCodeH = 0, lastCodeH = 0;
  function autosizeCode() {
    if (block.note) return;
    const lines = (textarea.value || '').split('\n').length || 1;
    const oneLine = edLineH + 2 * ED_PAD;
    const contentH = lines * edLineH + 2 * ED_PAD;
    const cap = editorCapPx();
    const h = userCodeH ? Math.min(userCodeH, cap) : Math.min(contentH, cap);
    lastCodeH = Math.max(h, oneLine);
    codeWrap.style.height = lastCodeH + 'px';
  }
  codeWrap._autosize = autosizeCode;   // global resize listener re-fits open code editors
  codeWrap.addEventListener('mouseup', () => {   // end of a manual resize-handle drag
    if (!block.note && Math.abs(codeWrap.offsetHeight - lastCodeH) > 2) userCodeH = codeWrap.offsetHeight;
  });
  // keep the active-line highlight in step with the caret
  ['keyup', 'click', 'focus', 'select'].forEach(ev => textarea.addEventListener(ev, updateActiveLine));
  // Sticky editing: clicking away from the block no longer exits edit mode — the
  // block stays editable until Save / Revert-Cancel (or Esc, below). Autosave is on
  // `input` + flushSave on tab switch, both independent of focus, so nothing is lost
  // while a block sits in edit mode. The old blur handler's side-effects (updateActiveLine/
  // renderVarsPanel/refreshSectionVars/updatePreview) only prepped the view-mode render and
  // already run on Save and on live input, so they're not needed on blur.
  textarea.addEventListener('keydown', (e) => {
    // Esc = a quick "done": same path as the Cancel/Revert button (cancels when
    // clean, reverts when dirty), so blocks don't pile up open without a mouse exit.
    if (e.key === 'Escape') { e.preventDefault(); revertBtn.click(); }
  });

  const view = document.createElement('div');
  view.className = 'code-view';
  // Code/note share this view element, but only CODE needs the inline editor metrics
  // (so the colored layer lines up row-for-row with the textarea + gutter). A NOTE
  // renders Markdown prose, not aligned code — applying the monospace/edFont/edLineH/
  // ED_PAD here would override its `.block.note .code-view` prose styling and make the
  // markdown render cramped + code-like (lists hugging the box edge). So skip it for
  // notes; the note's textarea still gets the metrics below (keeps editing at 16px).
  if (!block.note) {
    view.style.padding = ED_PAD + 'px';
    view.style.lineHeight = edLineH + 'px';
    view.style.fontSize = edFont + 'px';
    view.style.fontFamily = ED_FONT;
  }
  // Note: clicking the rendered code no longer enters edit mode, so text stays
  // selectable for copy/paste — use the Edit button to start editing.

  // Wire up clickable [[cross-page links]] inside a rendered note.
  function wireNoteLinks() {
    view.querySelectorAll('a.xlink[data-xtarget]').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const r = resolvePageLink(a.dataset.xtarget);
        if (r.found) openPage(r.path); else toast('No page named "' + a.dataset.xtarget + '"');
      });
    });
  }

  function updatePreview() {
    // Note blocks: render Markdown to formatted prose in the view layer. While
    // editing, the raw textarea shows (opaque, via the .note CSS); the view holds
    // the rendered prose shown in view mode.
    if (block.note) {
      const showVars = varsActive() && el.classList.contains('viewing');
      const md = showVars ? substituteVars(block.code, varValuesNow()) : (block.code || '');
      view.innerHTML = renderMarkdown(md);
      view.querySelectorAll('pre code[class*="language-"]').forEach(c => Prism.highlightElement(c));
      wireNoteLinks();
      return;
    }
    const lang = langPrism(block.type);
    const pre = document.createElement('pre');
    // Inline metrics override the Prism theme (padding:1em; line-height:1.5),
    // which would otherwise make code taller than the gutter and drift.
    pre.style.cssText = 'margin:0;padding:0;background:none;white-space:pre;' +
      'line-height:' + edLineH + 'px;font-size:' + edFont + 'px;font-family:' + ED_FONT + ';';
    const code = document.createElement('code');
    code.className = 'language-' + lang;
    code.style.cssText = 'line-height:' + edLineH + 'px;font-size:' + edFont + 'px;font-family:' + ED_FONT + ';';
    // In view mode with variables active (block- or section-owned), render the
    // substituted code; while editing (or vars off) show the raw template so it
    // matches the textarea.
    const showVars = varsActive() && el.classList.contains('viewing');
    code.textContent = showVars ? substituteVars(block.code, varValuesNow()) : (block.code || '');
    pre.appendChild(code);
    view.innerHTML = '';
    view.appendChild(pre);
    Prism.highlightElement(code);
  }
  el._updatePreview = updatePreview; // lets the parent section refresh on var input

  renderVarsPanel();
  updatePreview();
  updateGutter();
  refreshRevertLabel(); // correct label if re-rendered mid edit session
  if (block.note) el.classList.add('note');
  else if (linesOn) el.classList.add('show-lines'); // note blocks have no line gutter
  if (varsOn && !sectionControlled) el.classList.add('vars-on');

  // textarea overlays the colored layer inside a positioned stack
  const stack = document.createElement('div');
  stack.className = 'code-stack';
  stack.append(view, textarea);
  codeWrap.append(gutter, stack);
  el.append(toolbar, varsPanel, codeWrap);
  // If this block re-rendered while mid-edit (a backup exists → not 'viewing'),
  // fit the editor once it's in the DOM (scrollHeight is 0 until attached).
  if (!el.classList.contains('viewing')) requestAnimationFrame(() => { if (block.note) autosizeNote(); else autosizeCode(); });
  return el;
}

// Viewport-relative editor cap in pixels (matches the CSS 60vh desktop / 50dvh mobile).
// Used by the JS code-editor sizer so its content-fit clamp tracks the live viewport.
function editorCapPx() {
  const vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
  return Math.round(vh * (document.body.classList.contains('is-mobile') ? 0.5 : 0.6));
}

// Re-fit any editor that's currently in edit mode when the viewport changes (window
// resize, desktop-app window resize, mobile rotate / keyboard). Debounced; bound once.
(function () {
  let t;
  const refit = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      document.querySelectorAll('.block.note:not(.viewing) .code-edit')
        .forEach(ta => { if (ta._autosize) ta._autosize(); });
      document.querySelectorAll('.block:not(.note):not(.viewing) .code-wrap')
        .forEach(cw => { if (cw._autosize) cw._autosize(); });
      document.querySelectorAll('.block.csv:not(.viewing) .csv-edit')
        .forEach(ta => { if (ta._autosize) ta._autosize(); });
    }, 120);
  };
  window.addEventListener('resize', refit);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', refit);
})();

/* ---------- SAVE ---------- */

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(savePage, 500);
}

async function savePage() {
  if (!currentPagePath) return;
  // Serialize saves: overlapping autosaves would each read the same stale
  // baseMtime (a NAS round-trip can outlast the 500ms debounce), so the second
  // one lands after the first bumped the file's mtime → a false conflict prompt.
  // While a save is in flight, mark dirty and re-save once it returns instead.
  if (saveInFlight) { savePending = true; return; }
  saveInFlight = true;
  const savedPath = currentPagePath;
  try {
    const tab = openPages.find(t => t.path === savedPath);
    const baseMtime = tab ? tab.baseMtime : null;
    const res = await api('save_page', { path: savedPath, data: currentPageData, baseMtime });
    if (res && res.conflict) { await handleSaveConflict(savedPath, res.mtime); return; }
    if (res && res.offline) {
      // Queued offline: we don't know whether the request actually reached the
      // server before it dropped (a NAS timeout can write the file yet lose the
      // response). Drop the cached baseMtime so the next online save skips the
      // now-meaningless conflict check and re-syncs from a clean write — without
      // this, a ghost write advances the file's mtime and every later save
      // false-conflicts. (Consistent with the force-on-reconnect queue replay.)
      if (tab) tab.baseMtime = null;
    } else if (tab && res && res.mtime != null) {
      tab.baseMtime = res.mtime;
    }
    toast('Saved');
  } finally {
    saveInFlight = false;
    // Flush any edits that arrived while the request was outstanding; baseMtime
    // is now fresh, so this re-save carries the latest content correctly.
    if (savePending) { savePending = false; savePage(); }
  }
}

// The page changed on disk since we loaded it (another tab/device/external edit).
// Let the user reload the on-disk version or overwrite it with theirs.
async function handleSaveConflict(path, diskMtime) {
  const tab = openPages.find(t => t.path === path);
  const overwrite = await showConfirm(
    'This page changed elsewhere since you opened it. Overwrite the version on disk with your changes? (Cancel discards your unsaved changes and loads the version from disk.)',
    { okLabel: 'Overwrite', danger: true }
  );
  if (overwrite) {
    const res = await api('save_page', { path, data: tab ? tab.data : currentPageData, baseMtime: diskMtime, force: true });
    if (tab && res && res.mtime != null) tab.baseMtime = res.mtime;
    toast('Saved (overwrote disk version)');
  } else {
    // reload disk version into the tab
    const data = await api('get_page', undefined, 'path=' + encodeURIComponent(path));
    if (!data.sections) data.sections = [];
    const m = data._mtime != null ? data._mtime : null;
    delete data._mtime;
    if (tab) { tab.data = data; tab.baseMtime = m; }
    if (activePath === path) { currentPageData = data; renderPage(); }
    toast('Reloaded disk version');
  }
}

// Persist any pending debounced save immediately (e.g. before switching tabs).
// Forced: the active editor is the source of truth at this moment.
function flushSave(opts) {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!currentPagePath) return;
  const tab = openPages.find(t => t.path === currentPagePath);
  const body = JSON.stringify({ path: currentPagePath, data: currentPageData, force: true });
  if (opts && opts.beacon && navigator.sendBeacon) {
    navigator.sendBeacon('api.php?action=save_page', new Blob([body], { type: 'application/json' }));
    // sendBeacon has no response, so we can't learn the new mtime here. Drop the
    // cached baseMtime so the next save skips the (now-unanswerable) conflict
    // check and re-syncs from a clean write — otherwise returning to the tab and
    // typing one char would false-conflict against our own beacon write.
    if (tab) tab.baseMtime = null;
    return;
  }
  api('save_page', { path: currentPagePath, data: currentPageData, force: true })
    .then(res => { if (tab && res && res.mtime != null) tab.baseMtime = res.mtime; });
}

// Flush in-flight edits if the tab is closed/hidden mid-debounce.
window.addEventListener('beforeunload', () => { if (saveTimer) flushSave({ beacon: true }); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && saveTimer) flushSave({ beacon: true }); });

/* ---------- INDEX ---------- */

async function rebuildIndex(btn) {
  if (btn) btn.classList.add('spinning');
  const res = await api('rebuild_index');
  await loadTree();
  if (btn) btn.classList.remove('spinning');
  toast(res && res.pages != null ? `Index rebuilt (${res.pages} pages)` : 'Index rebuilt');
}
