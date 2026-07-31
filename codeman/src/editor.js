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
  // Dedup + existence filter up front so we only fetch what we'll show, in SAVED ORDER.
  const seen = new Set();
  const candidates = saved.tabs.filter(t => {
    const p = t && t.path;
    if (!p || seen.has(p) || !existing.has(p)) return false;
    seen.add(p); return true;
  });
  if (!candidates.length) return;
  // Fetch every surviving tab CONCURRENTLY. api() never rejects (→ offlineApi);
  // get_page is a pure read keyed per-path in the cache, so concurrent reads are
  // safe. The Map decouples result availability from saved order.
  const results = new Map();
  await Promise.all(candidates.map(async t => {
    results.set(t.path, await api('get_page', undefined, 'path=' + encodeURIComponent(t.path)));
  }));
  const { tabs, active } = assembleRestoredTabs(saved, existing, p => results.get(p));
  if (!tabs.length) return;
  // Defensive: nothing should open a page between boot and here, but push only tabs
  // not already present so a future auto-open can't produce a duplicate tab.
  openPages.push(...tabs.filter(t => !openPages.some(o => o.path === t.path))); // saved order
  const activeTab = openPages.find(t => t.path === active) || openPages[openPages.length - 1];
  activateTab(activeTab);                                    // EXACTLY ONCE, after all settle
  expandAncestors(activeTab.path);
  renderTree();                                              // (a): was loadTree()
  // A tab whose get_page returned {error} (a malformed server response, not a deleted
  // page — those were filtered out of `candidates`) was skipped above so it can't
  // clobber the real page with an empty tab. But activateTab→saveOpenTabs just
  // persisted only the LOADED tabs, which would permanently forget the errored one.
  // Re-persist every surviving candidate (loaded + transiently-errored, in saved
  // order) so a flaky boot retries the failed tab next launch instead of dropping it.
  if (candidates.some(t => (results.get(t.path) || {}).error)) {
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify({
        tabs: candidates.map(t => ({ path: t.path, filter: t.filter || '' })),
        active: activePath
      }));
    } catch (e) {}
  }
}

function nameFromPath(path) {
  const base = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
  return base.replace(/\.json$/, '');
}

// Pick a non-clashing "<stem> copy" name for a duplicated page. sourceName +
// siblingNames are display names (no ".json"). Strips a trailing " copy"/" copy N"
// off the source so duplicating "Foo copy" yields "Foo copy 2", not "Foo copy copy".
// Output always passes safeName (a valid stem + " copy N" stays valid). Pure.
function uniqueCopyName(sourceName, siblingNames) {
  const taken = siblingNames instanceof Set ? siblingNames : new Set(siblingNames);
  const m = /^(.*?) copy(?: \d+)?$/.exec(sourceName);
  const stem = m ? m[1] : sourceName;
  let candidate = stem + ' copy';
  let n = 2;
  while (taken.has(candidate)) candidate = stem + ' copy ' + (n++);
  return candidate;
}

// Pure. Rebuild the restored-tab list in SAVED ORDER from already-resolved
// get_page results — independent of fetch-resolution timing — skipping tabs
// that no longer exist, failed to load, or are duplicate paths, then pick the
// active tab. No I/O, no globals besides pure nameFromPath → unit-testable.
//   saved:    { tabs:[{path,filter}], active }   (as persisted)
//   existing: Set<string> of page paths currently in the tree
//   resultOf: (path) => data | {error} | undefined   (resolved get_page payload)
// returns:   { tabs:[{path,title,data,filter,baseMtime}], active: string|null }
function assembleRestoredTabs(saved, existing, resultOf) {
  const out = [], seen = new Set();
  for (const t of (saved && saved.tabs) || []) {
    const path = t && t.path;
    if (!path || seen.has(path) || !existing.has(path)) continue; // skip dup / non-existent
    seen.add(path);
    const data = resultOf(path);
    if (!data || data.error) continue;            // failed fetch → skip, order NOT shifted
    if (!Array.isArray(data.sections)) data.sections = [];
    const baseMtime = data._mtime != null ? data._mtime : null;
    delete data._mtime;
    out.push({ path, title: data.title || nameFromPath(path), data, filter: t.filter || '', baseMtime });
  }
  const active = out.length
    ? (out.some(x => x.path === (saved && saved.active)) ? saved.active : out[out.length - 1].path)
    : null;
  return { tabs: out, active };
}

// After a duplicate, the new block/section object is stashed here so the next
// renderPage() can scroll it into view + pulse it (matched by identity, cleared
// once revealed). See revealNewEl + the reveal hooks in renderSection*/renderBlock.
let pendingRevealObj = null;

// Deep-copy a block and drop the copy DIRECTLY BELOW the source (Split's
// insert-below pattern), then reveal it. Shared by all five block kinds.
function duplicateBlock(parentArray, idx) {
  const copy = JSON.parse(JSON.stringify(parentArray[idx]));
  parentArray.splice(idx + 1, 0, copy);
  pendingRevealObj = copy;
  renderPage();
  scheduleSave();
  toast('Block duplicated');
}

// Deep-copy a section (RAW — preserves any legacy {tabs:[]} shape), retitle
// "… copy", drop it directly below the source, then reveal it.
function duplicateSection(section, parentArray, idx) {
  const copy = JSON.parse(JSON.stringify(section));
  copy.title = (section.title || 'Section') + ' copy';
  parentArray.splice(idx + 1, 0, copy);
  pendingRevealObj = copy;
  renderPage();
  scheduleSave();
  toast('Section duplicated');
}

// Flash + scroll a freshly-duplicated element into view. Uses setTimeout(…,0)
// (after layout) rather than rAF — see the "Scroll after re-render" gotcha.
function revealNewEl(el, align) {
  el.classList.add('just-duplicated');
  setTimeout(() => {
    // Blocks sit directly below a visible source → 'nearest' (minimal jump). A
    // duplicated section can be taller than the viewport → 'start' so its "… copy"
    // header (what identifies it as new) surfaces, not its bottom edge.
    el.scrollIntoView({ block: align || 'nearest' });
    setTimeout(() => el.classList.remove('just-duplicated'), 1200);
  }, 0);
}

// Sibling PAGE display-names in a folder (from the loaded tree) — the set
// uniqueCopyName dedups against. Empty parent ('') = the tree root.
function siblingPageNames(parent) {
  return new Set(folderChildren(parent).filter(n => n.type === 'page').map(n => n.name));
}

// Duplicate a whole page CLIENT-SIDE (no dedicated api.php action): create_page +
// save_page {baseMtime:null}, then reveal the new row WITHOUT opening a tab. Uses
// the open tab's live (possibly-unsaved) sections when the source page is open.
async function duplicatePageFromTree(node) {
  const parent = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : '';
  const newName = uniqueCopyName(node.name, siblingPageNames(parent));
  const openTab = openPages.find(t => t.path === node.path);
  let sections;
  if (openTab) sections = openTab.data.sections || [];
  else {
    const d = await api('get_page', undefined, 'path=' + encodeURIComponent(node.path));
    // Offline + cache miss → offlineApi returns an empty placeholder ({sections:[], _mtime:null})
    // that's indistinguishable from a real empty page. Refuse rather than silently persist a blank
    // copy of a page whose real content we can't see — open or prime it first.
    // Ask the MIRROR (pageGet) rather than testing the RESPONSE: the old `d._mtime == null` test
    // could never say "hit", because cacheOnSuccess strips _mtime before mirroring and the miss
    // placeholder also carries _mtime:null — so a genuine cache HIT looked exactly like a miss and
    // tree-row Duplicate was dead offline for EVERY page not currently open, defeating
    // primeOfflineCache / "Download for offline". (Online this is skipped entirely.)
    if (offlineState && !(await pageGet(node.path))) { toast('Open this page before duplicating it offline'); return; }
    sections = (d && d.sections) || [];
  }
  const create = await api('create_page', { parent, name: newName });
  if (create && create.error) { toast(create.error); return; }
  const newPath = (parent ? parent + '/' : '') + newName + '.json';
  const payload = { title: newName, sections: JSON.parse(JSON.stringify(sections)) };
  const save = await api('save_page', { path: newPath, data: payload, baseMtime: null });
  if (save && save.error) { toast(save.error); return; }
  if (parent) {
    expandedFolders.add(parent); saveExpanded();
    if (effectiveMode() === 'double') setColumnPathTo(parent);
  }
  await loadTree();
  revealTreeRow(newPath);
  toast('Page duplicated');
}

// Scroll + pulse a tree row by path after a re-render (single + Miller layouts
// both give the row a data-path). setTimeout(…,0) so layout has settled.
function revealTreeRow(path) {
  setTimeout(() => {
    const sel = '.tree-row[data-path="' + ((window.CSS && CSS.escape) ? CSS.escape(path) : path) + '"]';
    const row = document.querySelector(sel);
    if (row) { row.scrollIntoView({ block: 'nearest' }); row.classList.add('just-duplicated'); setTimeout(() => row.classList.remove('just-duplicated'), 1200); }
  }, 0);
}

// Duplicate the OPEN page from its header ⋯ menu — same client-side flow, but
// opens the copy in a tab (openPage's _openingPages dedup ⇒ one tab even if fired twice).
async function duplicateCurrentPage() {
  if (!currentPagePath) return;
  const parent = currentPagePath.includes('/') ? currentPagePath.slice(0, currentPagePath.lastIndexOf('/')) : '';
  const newName = uniqueCopyName(nameFromPath(currentPagePath), siblingPageNames(parent));
  const create = await api('create_page', { parent, name: newName });
  if (create && create.error) { toast(create.error); return; }
  const newPath = (parent ? parent + '/' : '') + newName + '.json';
  const payload = { title: newName, sections: JSON.parse(JSON.stringify(currentPageData.sections || [])) };
  const save = await api('save_page', { path: newPath, data: payload, baseMtime: null });
  if (save && save.error) { toast(save.error); return; }
  await loadTree();
  await openPage(newPath);
  toast('Page duplicated');
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
      // Loading affordance: only reveal a spinner if the fetch is actually slow
      // (>250 ms) so a fast local open never flashes. The tab element doesn't exist
      // until the fetch resolves, so the indicator lives on the tab strip; aria-busy
      // gives screen-reader feedback. On the very first open the strip is display:none
      // (no tabs yet) — reveal it early so the spinner paints; the reveal is undone in
      // the finally if the open failed (a success re-renders the strip visible anyway).
      const bar = document.getElementById('mainTabs');
      let revealedForSpin = false;
      const spinTimer = setTimeout(() => {
        if (!bar) return;
        bar.classList.add('tabs-loading');
        bar.setAttribute('aria-busy', 'true');
        if (getComputedStyle(bar).display === 'none') { bar.style.display = 'flex'; revealedForSpin = true; }
      }, 250);
      try { tab = await p; }
      finally {
        _openingPages.delete(path);
        clearTimeout(spinTimer);
        if (bar) {
          bar.classList.remove('tabs-loading');
          bar.removeAttribute('aria-busy');
          if (revealedForSpin) bar.style.display = openPages.length ? 'flex' : 'none';
        }
      }
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

// Pure: the next tab index for the ARIA tablist arrow keys. Left/Right wrap around
// the ends; Home/End jump to first/last. Any other key leaves the index unchanged.
// Extracted so it's unit-testable in isolation.
function tabArrowIndex(key, i, n) {
  if (!n) return -1;
  if (key === 'ArrowRight') return (i + 1) % n;
  if (key === 'ArrowLeft') return (i - 1 + n) % n;
  if (key === 'Home') return 0;
  if (key === 'End') return n - 1;
  return i;
}

// Focus the open-page tab for a path (used after activation re-renders the strip,
// so keyboard focus follows the newly selected tab instead of falling to <body>).
function focusTabByPath(path) {
  const bar = document.getElementById('mainTabs');
  if (!bar) return;
  const el = Array.from(bar.querySelectorAll('[role="tab"]')).find(t => t.dataset.path === path);
  if (el) el.focus();
}

function renderMainTabs() {
  const bar = document.getElementById('mainTabs');
  bar.innerHTML = '';
  bar.style.display = openPages.length ? 'flex' : 'none';
  // ARIA tabs pattern: the strip is a tablist; each tab is role="tab" with
  // aria-selected + a roving tabindex (only the active tab is tabbable). Arrow keys
  // move between tabs (Home/End to the ends) and open that page; Enter/Space open a
  // focused tab. Each tab's close ✕ is a real <button> so it's keyboard-reachable
  // (Tab to it, Enter/Space closes); "Close all" is likewise a real <button>.
  bar.setAttribute('role', 'tablist');
  bar.setAttribute('aria-label', 'Open pages');
  let activeTabId = '';
  openPages.forEach((tab, i) => {
    const isActive = tab.path === activePath;
    const el = document.createElement('div');
    el.className = 'main-tab' + (isActive ? ' active' : '');
    el.id = 'maintab-' + i;
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', isActive ? 'true' : 'false');
    el.setAttribute('aria-controls', 'page');   // the tabpanel it controls (#page)
    el.tabIndex = isActive ? 0 : -1;
    el.dataset.path = tab.path;
    el.setAttribute('aria-label', tab.title);
    if (isActive) activeTabId = el.id;
    const name = document.createElement('span');
    name.className = 'main-tab-name';
    name.textContent = tab.title;
    name.title = tab.path;
    el.appendChild(name);
    // The close ✕ is a real focusable <button> (enters the Tab sequence; Enter/Space
    // fire its click) so a keyboard user can close a tab. On close, focus is moved to
    // a surviving tab (renderMainTabs rebuilt the strip) so it doesn't fall to <body>.
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'main-tab-close';
    x.textContent = '✕';
    x.setAttribute('aria-label', 'Close ' + tab.title);
    x.title = 'Close';
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = openPages.indexOf(tab);
      const survivors = openPages.filter(t => t.path !== tab.path);
      closePage(tab.path);
      if (survivors.length) focusTabByPath(survivors[Math.min(idx, survivors.length - 1)].path);
    });
    el.appendChild(x);
    el.addEventListener('click', () => { if (tab.path !== activePath) activateTab(tab); });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (tab.path !== activePath) { activateTab(tab); focusTabByPath(tab.path); }
        return;
      }
      if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const ni = tabArrowIndex(e.key, openPages.indexOf(tab), openPages.length);
      const target = openPages[ni];
      if (!target) return;
      if (target.path !== activePath) activateTab(target); // re-renders the strip
      focusTabByPath(target.path);
    });
    bar.appendChild(el);
  });
  // Pair the page region as the tabpanel for the active tab (APG tabs pattern).
  const pageRegion = document.getElementById('page');
  if (pageRegion) {
    pageRegion.setAttribute('role', 'tabpanel');
    pageRegion.setAttribute('tabindex', '0');
    if (activeTabId) pageRegion.setAttribute('aria-labelledby', activeTabId);
    else pageRegion.removeAttribute('aria-labelledby');
  }
  if (openPages.length > 1) {
    const closeAll = document.createElement('button');
    closeAll.type = 'button';
    closeAll.className = 'main-tab-closeall';
    closeAll.textContent = 'Close all';
    closeAll.title = 'Close all tabs';
    closeAll.setAttribute('aria-label', 'Close all tabs');
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
  markMenuTrigger(exportBtn);
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
  markMenuTrigger(headerMoreBtn);
  headerMoreBtn.addEventListener('click', () => {
    const allCollapsedNow = allSectionsCollapsed(currentPageData.sections);
    showMiniMenu(headerMoreBtn, [
      { icon: '❐', label: 'Duplicate page', onClick: () => duplicateCurrentPage() },
      { divider: true },
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
    if (el && sec === pendingRevealObj) { pendingRevealObj = null; revealNewEl(el, 'start'); }
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
//
// THREE declared tables, deny-by-default: RICH_ALLOWED (kept), RICH_DANGEROUS
// (dropped WITH their subtree), RICH_ATTRS (the only attributes that may survive,
// per tag). Anything named nowhere is removed — which is why `onerror`/`onload`
// and every FUTURE on* handler are impossible without enumerating them.
// A merely-unknown tag is UNWRAPPED (lossless for its text), never dropped.
//
// The FULL table set is allowlisted on purpose: this function returns a serialized
// string that is re-parsed by `surface.innerHTML = …`, and an unwrapped
// <caption>/<colgroup>/<col> would leave bare text as a direct child of <table>,
// which the second parse FOSTER-PARENTS out of the table — silently relocating
// content above it.
// CONSTRAINT: both Sets must stay SINGLE-LINE literals — the `rich-sanitizer` CI
// invariant greps the `const RICH_ALLOWED` line for script-bearing tag names.
const RICH_ALLOWED = new Set(['P', 'BR', 'DIV', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'A', 'FONT', 'SUB', 'SUP', 'PRE', 'CODE', 'HR', 'TABLE', 'CAPTION', 'COLGROUP', 'COL', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'IMG']);
const RICH_DANGEROUS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'FORM', 'INPUT', 'BUTTON', 'SVG', 'TEXTAREA', 'BASE', 'TEMPLATE', 'NOSCRIPT', 'MATH', 'FRAME', 'FRAMESET', 'APPLET', 'PORTAL', 'SELECT', 'OPTION', 'OPTGROUP']);
// Deny-by-default: an attribute survives only if this table names it for that tag.
const RICH_ATTRS = {
  A: ['href', 'title'],
  IMG: ['src', 'alt', 'title', 'width', 'height'],
  FONT: ['color', 'size', 'face'],
  TD: ['colspan', 'rowspan'],
  TH: ['colspan', 'rowspan', 'scope'],
  COL: ['span'],
  COLGROUP: ['span'],
};
const RICH_GLOBAL_ATTRS = ['style'];               // value-filtered, all tags

// Constrain an <img src> to exactly what the app's CSP already permits
// (img-src 'self' data: https:). Returns the cleaned value, or '' to reject.
// PURE, NEVER THROWS (the parseCsv/parseJsonSafe contract).
// The MIME list is deliberately incomplete — see the note below the function.
function richImgSrc(v) {
  const s = String(v == null ? '' : v).replace(/[\x00-\x20\x7f]/g, '');
  if (/^https:\/\/\S/i.test(s)) return s;
  if (/^data:image\/(png|jpeg|jpg|gif|webp|avif|bmp);base64,[A-Za-z0-9+/=]*$/i.test(s)) return s;
  return '';
}
// Why that list is short, and must STAY short:
//  - control/whitespace chars are stripped BEFORE the scheme test, so `java\tscript:`
//    and a leading-space `javascript:` can't split past it;
//  - the vector image format is ABSENT ON PURPOSE. It is a script-bearing document
//    format, so permitting it as a data: source would be an XSS primitive. This is
//    load-bearing, not an oversight — do not "complete" the MIME list;
//  - `http:` is rejected (the CSP blocks it anyway, and it's mixed content on HTTPS);
//  - blob:, protocol-relative and relative paths all fall through to '' (rejected).

// Bare non-negative integer within bounds, else '' (reject). PURE, NEVER THROWS.
// Used for width/height (max 10000) and colspan/rowspan/span (max 1000): these carry
// no script surface, and dropping them visually scrambles every pasted merged table.
function richIntAttr(v, max) {
  const s = String(v == null ? '' : v).trim();
  if (!/^\d{1,5}$/.test(s)) return '';
  const n = Math.min(parseInt(s, 10), max || 10000);
  return n > 0 ? String(n) : '';
}

// Last-resort degradation for the sanitizer: inert escaped text, never raw HTML.
function richEscapeText(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sanitizeRichHtml(html) {
  try {
    // A <template>'s content is an INERT document fragment: no image loads, no script
    // execution, no onerror firing while we walk it.
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html || '');
    const clean = (node) => {
      [...node.childNodes].forEach(clean);          // children first (post-order)
      if (node.nodeType === 8) { node.remove(); return; }   // comment
      if (node.nodeType !== 1) return;                       // keep text nodes
      // UPPERCASE, not node.tagName as-is: an HTML element's tagName is already
      // uppercase, but a FOREIGN-CONTENT element (SVG / MathML, incl. an <svg><script>)
      // reports its lowercase local name — so a raw lookup missed 'SVG' entirely and
      // merely UNWRAPPED it. That silently defeated the dangerous-tag drop for exactly
      // the mXSS surface the list exists to close. Normalize before every lookup.
      const tag = String(node.tagName || '').toUpperCase();
      if (RICH_DANGEROUS.has(tag)) { node.remove(); return; }   // drop WITH subtree
      if (!RICH_ALLOWED.has(tag)) {                          // unwrap unknown tag, keep text
        const p = node.parentNode; if (!p) return;
        while (node.firstChild) p.insertBefore(node.firstChild, node);
        p.removeChild(node); return;
      }
      const allowed = RICH_ATTRS[tag] || [];
      [...node.attributes].forEach(a => {
        const name = a.name.toLowerCase();
        const val = a.value;
        if (name === 'style' && RICH_GLOBAL_ATTRS.indexOf('style') !== -1) {
          if (/javascript:|expression\(|url\s*\(/i.test(val)) node.removeAttribute(a.name);
          return;
        }
        if (allowed.indexOf(name) === -1) { node.removeAttribute(a.name); return; }   // deny-by-default
        if (name === 'href') { if (!/^(https?:|mailto:)/i.test(val.trim())) node.removeAttribute(a.name); return; }
        // A rejected src is REMOVED, not blanked — an empty src re-requests the page
        // in some engines.
        if (name === 'src') { const okSrc = richImgSrc(val); if (okSrc) node.setAttribute('src', okSrc); else node.removeAttribute(a.name); return; }
        if (name === 'width' || name === 'height') { const n = richIntAttr(val, 10000); if (n) node.setAttribute(name, n); else node.removeAttribute(a.name); return; }
        if (name === 'colspan' || name === 'rowspan' || name === 'span') { const n = richIntAttr(val, 1000); if (n) node.setAttribute(name, n); else node.removeAttribute(a.name); return; }
        if (name === 'scope') { if (['row', 'col', 'rowgroup', 'colgroup'].indexOf(val.toLowerCase()) === -1) node.removeAttribute(a.name); return; }
        // alt / title / color / size / face: free text, attribute-escaped on serialize
      });
      if (tag === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
    };
    clean(tpl.content);
    return tpl.innerHTML;
  } catch (e) {
    // A sanitizer that throws must degrade to INERT TEXT — never to unsanitized
    // HTML, and never to '' (which would silently delete the block's content).
    return richEscapeText(html || '');
  }
}
// A rich block's stored HTML can now legally carry data: images, so one pasted
// screenshot can balloon the page — and every page is multiplied ×21 on disk
// (current + 20 history versions). Soft warning only: a hard cap could only
// truncate or reject the paste, i.e. silent content loss.
const RICH_SOFT_WARN = 262144;                  // 256 KB of stored HTML
const richWarned = new WeakSet();               // once per block per session

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

// A JSON (tree-viewer) block: raw JSON text lives in block.code; view mode renders it
// as a collapsible, typed, copy-path tree. Edit mode is a plain textarea.
function newJsonBlock() {
  return { type: 'json', label: '', code: '', json: true };
}

// Tolerant JSON parse — NEVER throws. Returns { ok, value, error }. Standard JSON.parse
// (no JSON5/comment leniency on purpose: malformed input should surface its error in the
// view, the same way the CSV block warns on an unterminated quote).
function parseJsonSafe(text) {
  const s = String(text == null ? '' : text);
  if (!s.trim()) return { ok: false, value: undefined, error: '' };   // empty = no tree, no warning
  try { return { ok: true, value: JSON.parse(s), error: '' }; }
  catch (e) { return { ok: false, value: undefined, error: (e && e.message) || 'Invalid JSON' }; }
}

// Pretty-print a parsed value (2-space indent), used by the Format action + exports.
function formatJson(value) { return JSON.stringify(value, null, 2); }

// Build a JS-accessor path string from a list of keys/indices, for copy-path-on-click.
// Numbers → `[0]`; identifier-safe strings → `.name`; everything else → `["odd key"]`.
function jsonPath(keys) {
  let out = 'root';
  for (const k of (keys || [])) {
    if (typeof k === 'number') out += '[' + k + ']';
    else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k)) out += '.' + k;
    else out += '[' + JSON.stringify(String(k)) + ']';
  }
  return out;
}

/* ---------- HTML PROJECT (pure) ---------- */
// A small static web project (entry HTML + its CSS/JS/images) stored INLINE in the
// page JSON, rendered by inlining every sub-resource into one document fed to a
// sandboxed <iframe srcdoc>. Keeping it in the page means history, trash, duplicate,
// conflict-aware save, the offline mirror and self-contained export all work with no
// new plumbing — paid for with a hard size cap, since every byte is multiplied ×21
// on disk (current + 20 history versions).
//
// EVERY helper below is pure and MUST NEVER THROW — the parseCsv / parseJsonSafe
// contract. A malformed project shows a warning banner, never a blank block.

const HTML_MAX_TOTAL = 1048576;   // 1 MB decoded, whole block
const HTML_MAX_FILE  = 524288;    // 512 KB any single file
const HTML_MAX_FILES = 50;
const HTML_SOFT_WARN = 262144;    // 256 KB → soft warning (explains the ×21 history growth)
const HTML_PAGE_WARN = 6291456;   // 6 MB serialized page → post_max_size guard
const HTML_DEFAULT_H = 320;       // preview height px (clamped 120–1200 on read)

// An HTML-project block. `code` IS the entry file's source (so blockPlainText,
// convertBlock, search_blocks, replace_content, the block filter and Copy all work
// unchanged); `files` holds only the NON-entry files.
function newHtmlBlock() {
  return { type: 'html', label: '', code: '', html: true, entry: 'index.html', files: [] };
}

// Normalize a project-relative path: strip leading "./" and "/", collapse empty
// segments, resolve "." / "..". Returns '' if the path escapes the project root.
function normalizeHtmlPath(p) {
  const s = String(p == null ? '' : p).replace(/\\/g, '/');
  const out = [];
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!out.length) return ''; out.pop(); continue; }
    out.push(seg);
  }
  return out.join('/');
}

// Join a reference to its base directory and normalize it. `?query` / `#hash` are
// stripped for the file lookup. Returns null when the ref is empty or escapes root.
function resolveHtmlPath(baseDir, ref) {
  const raw = String(ref == null ? '' : ref).trim().split('#')[0].split('?')[0];
  if (!raw) return null;
  if (raw.charAt(0) === '/') return normalizeHtmlPath(raw) || null;
  const base = normalizeHtmlPath(baseDir || '');
  return normalizeHtmlPath(base ? base + '/' + raw : raw) || null;
}

// Is this reference outside the project (so the bundler must leave it verbatim)?
// Covers any scheme, protocol-relative "//host", and same-document "#frag".
function isAbsoluteRef(ref) {
  const r = String(ref == null ? '' : ref).trim();
  if (!r) return false;
  if (r.charAt(0) === '#') return true;
  if (r.slice(0, 2) === '//') return true;
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(r);
}

// The folder picker reports paths under the picked folder's own name
// ("demo/index.html"). Drop that leading segment when EVERY path shares it.
function stripCommonRoot(paths) {
  const list = (paths || []).map(p => normalizeHtmlPath(p)).filter(Boolean);
  if (!list.length) return [];
  const parts = list.map(p => p.split('/'));
  if (parts.some(a => a.length < 2)) return list;
  const root = parts[0][0];
  if (!parts.every(a => a[0] === root)) return list;
  return parts.map(a => a.slice(1).join('/'));
}

// Extensions stored as text (everything else is base64 binary) + a MIME map.
const HTML_TEXT_EXTS = ['html', 'htm', 'css', 'js', 'mjs', 'json', 'svg', 'txt', 'md', 'csv', 'xml'];
const HTML_MIME_MAP = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript',
  mjs: 'text/javascript', json: 'application/json', svg: 'image/svg+xml',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', xml: 'application/xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp4: 'video/mp4', webm: 'video/webm', ogg: 'audio/ogg', mp3: 'audio/mpeg',
  wav: 'audio/wav', pdf: 'application/pdf',
};
function htmlExtInfo(path) {
  const m = String(path == null ? '' : path).toLowerCase().match(/\.([a-z0-9]+)$/);
  const ext = m ? m[1] : '';
  return { text: HTML_TEXT_EXTS.indexOf(ext) !== -1, mime: HTML_MIME_MAP[ext] || 'application/octet-stream' };
}

// Pick the entry file out of an uploaded path list: a root index.html wins, else a
// lone .html anywhere, else the caller must ask (ambiguous, with the candidates).
function resolveHtmlEntry(paths) {
  const list = (paths || []).map(p => normalizeHtmlPath(p)).filter(Boolean);
  const htmls = list.filter(p => /\.(html|htm)$/i.test(p));
  if (list.indexOf('index.html') !== -1) return { entry: 'index.html', ambiguous: false, candidates: htmls };
  if (htmls.length === 1) return { entry: htmls[0], ambiguous: false, candidates: htmls };
  return { entry: '', ambiguous: true, candidates: htmls };
}

// Decoded byte length of a standard base64 string (padding-aware).
function b64DecodedBytes(b64) {
  const s = String(b64 == null ? '' : b64).replace(/\s+/g, '');
  if (!s) return 0;
  let pad = 0;
  if (s.charAt(s.length - 1) === '=') pad++;
  if (s.charAt(s.length - 2) === '=') pad++;
  return Math.max(0, Math.floor(s.length * 3 / 4) - pad);
}

// UTF-8 byte length of a text file's content.
function htmlTextBytes(t) {
  const s = String(t == null ? '' : t);
  try { return new TextEncoder().encode(s).length; } catch (e) { return s.length; }
}

// Human byte label for the size column / cap modals.
function htmlBytesLabel(n) {
  const b = Math.max(0, Number(n) || 0);
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(b < 10240 ? 1 : 0) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

// THE single read path for "what files does this block hold": the entry (whose text
// lives in block.code) is spliced back in at its sorted position, so the file list and
// all size accounting agree. A path wrongly duplicated in files[] is dropped.
function htmlFileList(block) {
  const b = block || {};
  const entry = normalizeHtmlPath(b.entry || '');
  const rows = [];
  const seen = Object.create(null);
  (Array.isArray(b.files) ? b.files : []).forEach(f => {
    if (!f) return;
    const p = normalizeHtmlPath(f.p || '');
    if (!p || p === entry || seen[p]) return;
    seen[p] = true;
    const bin = typeof f.b64 === 'string';
    rows.push({ p, kind: bin ? 'binary' : 'text', bytes: bin ? b64DecodedBytes(f.b64) : htmlTextBytes(f.t), isEntry: false });
  });
  if (entry) rows.push({ p: entry, kind: 'text', bytes: htmlTextBytes(b.code), isEntry: true });
  rows.sort((a, c) => (a.p < c.p ? -1 : a.p > c.p ? 1 : 0));
  return rows;
}

// Decoded size of the whole project, plus the files ordered largest-first.
function htmlProjectSize(block) {
  const rows = htmlFileList(block);
  return {
    bytes: rows.reduce((n, r) => n + r.bytes, 0),
    count: rows.length,
    largest: rows.slice().sort((a, c) => c.bytes - a.bytes).map(r => ({ p: r.p, bytes: r.bytes })),
  };
}

// The cap decision, run over a CANDIDATE file list BEFORE anything is committed to
// the block — a rejected upload must leave the block completely untouched.
function htmlCapCheck(entries, limits) {
  const lim = Object.assign(
    { total: HTML_MAX_TOTAL, file: HTML_MAX_FILE, files: HTML_MAX_FILES, soft: HTML_SOFT_WARN },
    limits || {});
  const list = (entries || []).filter(Boolean).map(e => ({ p: String(e.p || ''), bytes: Math.max(0, Number(e.bytes) || 0) }));
  const total = list.reduce((n, e) => n + e.bytes, 0);
  const offenders = list.slice().sort((a, b) => b.bytes - a.bytes);
  const hard = [], soft = [];
  const tooBig = list.filter(e => e.bytes > lim.file);
  if (tooBig.length) hard.push(tooBig.length + (tooBig.length > 1 ? ' files are' : ' file is') + ' over the ' + htmlBytesLabel(lim.file) + ' per-file limit');
  if (total > lim.total) hard.push('The project is ' + htmlBytesLabel(total) + ' — over the ' + htmlBytesLabel(lim.total) + ' limit');
  if (list.length > lim.files) hard.push(list.length + ' files — over the ' + lim.files + '-file limit');
  if (!hard.length && total > lim.soft) {
    soft.push('This project is ' + htmlBytesLabel(total) + '. It is stored inside the page, and every save keeps up to 20 history versions — so it can use around '
      + htmlBytesLabel(total * 21) + ' on the server.');
  }
  return { ok: !hard.length, hard, soft, offenders };
}

// FNV-1a 32-bit over a canonical descriptor of the STORED content (entry path + entry
// text + each file's path and body). Label / htmlH deliberately don't move the key.
// Binaries hash by base64 length PLUS a bounded head/tail fingerprint (≤128 chars per
// file regardless of asset size), so a same-length replacement of a different binary
// moves the key with overwhelming probability instead of silently reusing run state.
function htmlBundleKey(block) {
  const b = block || {};
  const parts = [normalizeHtmlPath(b.entry || ''), String(b.code || '')];
  (Array.isArray(b.files) ? b.files : []).forEach(f => {
    if (!f) return;
    parts.push(normalizeHtmlPath(f.p || ''));
    parts.push(typeof f.b64 === 'string'
      ? 'b' + f.b64.length + ':' + f.b64.slice(0, 64) + f.b64.slice(-64)
      : 't' + String(f.t || ''));
  });
  const s = parts.join('');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

// Merge an incoming uploaded project over an existing one. THE normative merge rule:
// nothing the block already held is ever deleted — an old entry the upload doesn't
// overwrite is DEMOTED to a regular file, not dropped.
//
// Returns {entry, code, files, replaced[], displaced[], added[]}:
//   replaced  — paths present on BOTH sides (incoming won; the old bytes are only
//               recoverable from page History, so the caller confirms first)
//   displaced — the old entry, demoted to a plain file because the new entry differs
//   added     — paths the project didn't have before
//
// INVARIANT: the returned `entry` NEVER also appears in `files` — htmlFileList drops a
// duplicated entry from the list, so it would persist in the JSON while being invisible.
// Pure, DOM-free, and NEVER throws (the parseCsv / parseJsonSafe contract).
function mergeHtmlProject(existing, incoming) {
  try {
    const norm = (o) => {
      const b = (o && typeof o === 'object') ? o : {};
      return {
        entry: normalizeHtmlPath(b.entry || ''),
        code: String(b.code == null ? '' : b.code),
        files: (Array.isArray(b.files) ? b.files : []).filter(f => f && typeof f === 'object'),
      };
    };
    const ex = norm(existing), inc = norm(incoming);

    // 1. Materialize the EXISTING project into one flat path→record map — INCLUDING
    //    the existing entry as an ordinary record. That inclusion IS the H-1 fix: the
    //    old merge iterated files[] only, so the entry was never a merge candidate and
    //    was silently lost.
    const map = Object.create(null);
    const exOrder = [];
    ex.files.forEach(f => {
      const p = normalizeHtmlPath(f.p || '');
      if (!p || map[p]) return;
      map[p] = f; exOrder.push(p);
    });
    // …but only when that entry actually HOLDS something. A brand-new block is
    // {entry:'index.html', code:''}: materializing that placeholder would make the very
    // first upload look like it overwrites a file, and merge-into-empty must be
    // byte-identical to replace — no prompt, no displaced entry. An empty entry has
    // nothing to preserve, so there is nothing to report either way.
    if (ex.entry && ex.code && !map[ex.entry]) { map[ex.entry] = { p: ex.entry, t: ex.code }; exOrder.push(ex.entry); }
    const before = Object.create(null);
    exOrder.forEach(p => { before[p] = true; });

    // 2. Overlay the incoming records by normalized path — incoming wins every collision.
    const replaced = [], added = [], incOrder = [];
    const overlay = (p, rec) => {
      if (!p) return;
      if (incOrder.indexOf(p) === -1) incOrder.push(p);
      if (before[p]) { if (replaced.indexOf(p) === -1) replaced.push(p); }
      else if (added.indexOf(p) === -1) added.push(p);
      map[p] = rec;
    };
    inc.files.forEach(f => overlay(normalizeHtmlPath(f.p || ''), f));
    if (inc.entry) overlay(inc.entry, { p: inc.entry, t: inc.code });

    // 3. The new entry is the incoming one (falling back to the existing entry when the
    //    incoming project has none). An old entry that survives untouched is demoted.
    const entry = inc.entry || ex.entry;
    const displaced = [];
    if (ex.entry && entry !== ex.entry && map[ex.entry] && replaced.indexOf(ex.entry) === -1) {
      displaced.push(ex.entry);
    }

    // 4/5. Rematerialize. Deterministic order — incoming records in upload order first,
    //      then existing-only survivors in their original files[] order — so a repeated
    //      merge produces a stable htmlBundleKey and no spurious remount.
    const files = [], emitted = Object.create(null);
    const emit = (p) => {
      if (!p || p === entry || emitted[p] || !map[p]) return;
      emitted[p] = true;
      files.push(Object.assign({}, map[p], { p }));
    };
    incOrder.forEach(emit);
    exOrder.forEach(emit);

    const rec = entry ? map[entry] : null;
    return { entry, code: rec ? String(rec.t == null ? '' : rec.t) : '', files, replaced, displaced, added };
  } catch (e) {
    return { entry: '', code: '', files: [], replaced: [], displaced: [], added: [] };
  }
}

// Group the bundler's layer-2 census hits (unhandled ref-bearing attributes) into ONE
// warning per (tag, attr) form instead of one per reference — a 5-page site sharing a
// nav emitted 8 near-identical lines. <a href> is INFO: a single-document preview
// simply can't navigate, which is expected, not broken. Never throws.
function groupRefWarnings(hits) {
  try {
    const groups = [], byKey = Object.create(null), seen = Object.create(null);
    (Array.isArray(hits) ? hits : []).forEach(h => {
      if (!h) return;
      const tag = String(h.tag == null ? '' : h.tag).toLowerCase();
      const attr = String(h.attr == null ? '' : h.attr).toLowerCase();
      const ref = String(h.ref == null ? '' : h.ref);
      if (!tag || !attr || !ref) return;
      const trip = tag + '|' + attr + '|' + ref;
      if (seen[trip]) return;                    // de-dupe identical triples
      seen[trip] = true;
      const key = tag + '|' + attr;
      if (!byKey[key]) { byKey[key] = { tag, attr, refs: [] }; groups.push(byKey[key]); }
      byKey[key].refs.push(ref);
    });
    return groups.map(g => {
      const n = g.refs.length;
      const shown = g.refs.slice(0, 3).join(', ') + (n > 3 ? ' +' + (n - 3) + ' more' : '');
      const info = (g.tag === 'a' && g.attr === 'href');
      return {
        level: info ? 'info' : 'warn',
        text: '<' + g.tag + ' ' + g.attr + '> — ' + n + (info ? ' link' : ' reference') + (n === 1 ? '' : 's')
          + (info ? ' to project files; the single-document preview can’t navigate: '
                  : ' not inlined; they won’t load in the preview: ')
          + shown,
      };
    });
  } catch (e) { return []; }
}

// Headline for the warning banner: what to say and how loudly. infoOnly (nothing above
// 'info') keeps the banner neutral so a routine collapse doesn't read as a failure.
function htmlWarnSummary(warnings) {
  const list = (Array.isArray(warnings) ? warnings : []).filter(Boolean);
  const notes = list.filter(w => w.level === 'info').length;
  const issues = list.length - notes;
  const label = (c, word) => c + ' ' + word + (c === 1 ? '' : 's');
  const parts = [];
  if (issues) parts.push(label(issues, 'issue'));
  if (notes) parts.push(label(notes, 'note'));
  return { glyph: issues ? '⚠' : 'ⓘ', text: parts.join(' · '), infoOnly: !issues };
}

// Empty-state copy. Mobile has no folder picker (.html-upload is display:none there),
// so the mobile wording must not promise a route the UI hides.
function htmlEmptyText(isMobile) {
  return isMobile
    ? 'Empty — edit the entry HTML to get started. Folder upload needs a desktop browser.'
    : 'Empty — upload a folder or edit the entry HTML.';
}

// Discrete height presets for the ⋯ → "Preview height…" submenu (design §12.2's
// fallback, shipped alongside the drag rather than instead of it).
const HTML_H_PRESETS = [
  { label: 'Small', px: 240 },
  { label: 'Medium', px: HTML_DEFAULT_H },
  { label: 'Large', px: 560 },
];

// Parse a srcset value into candidates. A srcset is a comma-separated list of
// "<url> [descriptor]" — and URLs may THEMSELVES contain commas ("photo,v2.jpg 2x"),
// which is exactly why a naive split(',') is wrong. So: skip separators, consume the
// URL as a run of NON-WHITESPACE (the comma rides along inside it), then take an
// optional descriptor up to the next comma. A URL run that ends in a comma has no
// descriptor ("a.jpg, b.jpg"). Never throws.
function parseSrcset(value) {
  const s = String(value == null ? '' : value);
  const out = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && (/\s/.test(s.charAt(i)) || s.charAt(i) === ',')) i++;
    if (i >= s.length) break;
    let url = '';
    while (i < s.length && !/\s/.test(s.charAt(i))) { url += s.charAt(i); i++; }
    const trimmed = url.replace(/,+$/, '');
    const endedOnComma = trimmed !== url;
    url = trimmed;
    let desc = '';
    if (!endedOnComma) {
      while (i < s.length && s.charAt(i) !== ',') { desc += s.charAt(i); i++; }
      if (i < s.length) i++;                       // consume the separating comma
    }
    if (url) out.push({ url, descriptor: desc.trim() });
  }
  return out;
}

// Inverse of parseSrcset (whitespace normalized; order/urls/descriptors preserved).
function serializeSrcset(entries) {
  return (entries || [])
    .filter(e => e && e.url)
    .map(e => (e.descriptor ? e.url + ' ' + e.descriptor : e.url))
    .join(', ');
}

// Which candidate the preview keeps when a srcset is collapsed. Deterministic (so
// htmlBundleKey stays stable): the element's own src target → a 1x/bare candidate →
// the lowest density/width → the first.
function pickSrcsetCandidate(entries, srcTarget) {
  const list = (entries || []).filter(e => e && e.url);
  if (!list.length) return null;
  if (srcTarget) { const hit = list.find(e => e.url === srcTarget); if (hit) return hit; }
  const bare = list.find(e => !e.descriptor || /^1(\.0+)?x$/i.test(e.descriptor));
  if (bare) return bare;
  const scored = list
    .map(e => {
      const d = String(e.descriptor || '');
      const mx = d.match(/^([\d.]+)x$/i), mw = d.match(/^(\d+)w$/i);
      return { e, n: mx ? parseFloat(mx[1]) : mw ? parseInt(mw[1], 10) : NaN };
    })
    .filter(o => isFinite(o.n))
    .sort((a, b) => a.n - b.n);
  return scored.length ? scored[0].e : list[0];
}

// CSS image-set() is the same candidate-list shape as srcset, with optional url()
// wrappers / quotes and an optional type() the preview ignores. Accepts either the
// full "image-set(…)" function or just its inner value.
function parseImageSet(value) {
  let v = String(value == null ? '' : value).trim();
  const wrap = v.match(/^-?(?:webkit-)?image-set\(([\s\S]*)\)$/i);
  if (wrap) v = wrap[1];
  const unwrap = (u) => {
    let s = String(u || '').trim();
    const m = s.match(/^url\(([\s\S]*)\)$/i);
    if (m) s = m[1].trim();
    const q = s.charAt(0);
    if ((q === '"' || q === "'") && s.charAt(s.length - 1) === q) s = s.slice(1, -1);
    return s.trim();
  };
  return parseSrcset(v)
    .map(e => ({
      url: unwrap(e.url),
      descriptor: String(e.descriptor || '').replace(/type\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\)/gi, '').trim(),
    }))
    .filter(e => e.url && !/^type\(/i.test(e.url));
}

// Attributes known to carry a resource reference. Anything here that the bundler does
// NOT rewrite must still be DETECTED (layer 2 below) so it can never fail silently.
const HTML_REF_ATTRS = [
  'src', 'srcset', 'href', 'poster', 'data', 'action', 'formaction',
  'background', 'cite', 'longdesc', 'usemap', 'profile', 'manifest', 'ping',
];
// The (tag, attr) pairs the rewrite table in bundleHtmlProject actually covers.
// Keep this list next to the rewrites — the two are read together.
const HTML_HANDLED_REFS = [
  'img|src', 'img|srcset', 'source|src', 'source|srcset',
  'script|src', 'link|href', 'video|src', 'video|poster', 'audio|src',
];

// Inline every sub-resource of the project into one HTML document for the sandboxed
// preview. Regex over the raw entry string — deliberately NOT DOMParser, so the
// author's exact document survives and the helper stays DOM-free and pure.
//
// THE INVARIANT: every reference the bundler rewrites warns when it can't be resolved,
// AND every ref-bearing form the bundler does NOT handle is still detected. It must be
// structurally impossible for a reference to a project file to vanish from the preview
// with no entry in the warning banner. Three layers enforce it (see the end).
//
// Returns { html, warnings: [{level:'warn'|'info', text}] } and NEVER throws.
function bundleHtmlProject(block) {
  const warnings = [];
  const warn = (text, level) => warnings.push({ level: level || 'warn', text: String(text) });
  try {
    const b = block || {};
    const entry = normalizeHtmlPath(b.entry || '');
    const entryDir = entry.indexOf('/') === -1 ? '' : entry.slice(0, entry.lastIndexOf('/'));
    const map = Object.create(null);
    (Array.isArray(b.files) ? b.files : []).forEach(f => {
      if (!f) return;
      const p = normalizeHtmlPath(f.p || '');
      if (p && p !== entry) map[p] = f;
    });
    const consumed = Object.create(null);   // layer 3: every project path actually inlined
    const warnedRef = Object.create(null);  // dedupe layer 1 ↔ layer 2 on the same ref string

    const dataUri = (rec, path) => {
      if (rec && typeof rec.b64 === 'string') {
        return 'data:' + (rec.m || htmlExtInfo(path).mime) + ';base64,' + rec.b64;
      }
      // text assets (svg, …) go in percent-encoded — pure, and immune to btoa's
      // "characters outside Latin1" throw on UTF-8 content.
      return 'data:' + htmlExtInfo(path).mime + ';charset=utf-8,' + encodeURIComponent((rec && rec.t) || '');
    };

    // Layer 1: resolve one reference, warning on a root escape or a missing file.
    const lookup = (ref, baseDir) => {
      if (!ref || isAbsoluteRef(ref) || /^data:/i.test(ref)) return null;
      const p = resolveHtmlPath(baseDir, ref);
      if (!p) { warnedRef[ref] = true; warn('outside project: ' + ref); return null; }
      if (!map[p]) { warnedRef[ref] = true; warn('unresolved: ' + ref); return null; }
      consumed[p] = true;
      return { path: p, rec: map[p] };
    };

    // url() / image-set() inside a stylesheet, resolved relative to THAT stylesheet's
    // directory (not the entry's).
    const rewriteCss = (css, baseDir) => {
      let out = String(css == null ? '' : css);
      if (/@import/i.test(out)) warn('@import is not followed — imported stylesheets will not load in the preview.');
      out = out.replace(/(-webkit-)?image-set\(([^;{}]*)\)/gi, (m0, pfx, inner) => {
        const cands = parseImageSet(inner);
        if (!cands.length) return m0;
        const picked = pickSrcsetCandidate(cands, '');
        const hit = picked ? lookup(picked.url, baseDir) : null;
        if (!hit) return m0;
        const dropped = [];
        cands.forEach(c => {
          if (c === picked) return;
          const p = resolveHtmlPath(baseDir, c.url);
          if (p && map[p]) { consumed[p] = true; dropped.push(p); }
        });
        if (cands.length > 1) {
          warn('Responsive variants collapsed for preview: kept ' + hit.path
            + (dropped.length ? ', dropped ' + dropped.join(', ') : '')
            + '. All files are still stored in the project.', 'info');
        }
        return 'url("' + dataUri(hit.rec, hit.path) + '")';
      });
      out = out.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m0, q, ref) => {
        const hit = lookup(String(ref).trim(), baseDir);
        return hit ? 'url("' + dataUri(hit.rec, hit.path) + '")' : m0;
      });
      return out;
    };

    let html = String(b.code || '');

    // 1. the entry's own inline <style> blocks (before <link>, so the CSS injected by
    //    the link rewrite — already resolved against ITS dir — isn't processed twice)
    html = html.replace(/<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi,
      (m0, attrs, css) => '<style' + attrs + '>' + rewriteCss(css, entryDir) + '</style>');

    // 2. <link rel="stylesheet" href> → <style> with the stylesheet inlined
    html = html.replace(/<link\b[^>]*>/gi, (tag) => {
      if (!/rel\s*=\s*['"]?stylesheet/i.test(tag)) return tag;
      const m = tag.match(/href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const ref = m ? (m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]) : '';
      if (!ref || isAbsoluteRef(ref)) return tag;
      const hit = lookup(ref, entryDir);
      if (!hit) return tag;
      const dir = hit.path.indexOf('/') === -1 ? '' : hit.path.slice(0, hit.path.lastIndexOf('/'));
      return '<style>\n' + rewriteCss(hit.rec.t || '', dir) + '\n</style>';
    });

    // 3. <script src> → inline <script>. </script inside the payload MUST be escaped
    //    or it terminates the wrapper element early.
    html = html.replace(/<script\b([^>]*?)\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))([^>]*)>\s*<\/script\s*>/gi,
      (m0, pre, d, s, u, post) => {
        const ref = d !== undefined ? d : s !== undefined ? s : u;
        if (!ref || isAbsoluteRef(ref)) return m0;
        const hit = lookup(ref, entryDir);
        if (!hit) return m0;
        const js = String(hit.rec.t || '').replace(/<\/script/gi, '<\\/script');
        const attrs = (pre + post).replace(/\s(?:defer|async)\b/gi, '');
        return '<script' + attrs + '>\n' + js + '\n</script>';
      });

    // 4. media elements: src / srcset / poster → data URIs (srcset collapsed, see §5)
    html = html.replace(/<(img|source|video|audio)\b([^>]*)>/gi, (m0, tag, attrs) => {
      const t = tag.toLowerCase();
      let out = attrs;
      const getAttr = (name) => {
        const m = out.match(new RegExp('\\s' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
        if (!m) return null;
        return m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
      };
      const setAttr = (name, val) => {
        const v = String(val).replace(/"/g, '&quot;');
        const re = new RegExp('(\\s' + name + '\\s*=\\s*)(?:"[^"]*"|\'[^\']*\'|[^\\s>]+)', 'i');
        if (re.test(out)) out = out.replace(re, (mm, p1) => p1 + '"' + v + '"');
        else out = out.replace(/\s*\/?\s*$/, '') + ' ' + name + '="' + v + '"';
      };
      const delAttr = (name) => {
        out = out.replace(new RegExp('\\s' + name + '\\s*=\\s*(?:"[^"]*"|\'[^\']*\'|[^\\s>]+)', 'gi'), '');
      };

      const srcRef = getAttr('src');
      const srcsetRef = getAttr('srcset');
      const srcTargetPath = (srcRef && !isAbsoluteRef(srcRef)) ? resolveHtmlPath(entryDir, srcRef) : null;

      if (srcsetRef) {
        const resolved = parseSrcset(srcsetRef).map(c => ({
          c, path: isAbsoluteRef(c.url) ? null : resolveHtmlPath(entryDir, c.url),
        }));
        // one warning per candidate URL that can't be resolved to a project file
        resolved.forEach(r => {
          if (isAbsoluteRef(r.c.url)) return;
          if (!r.path) { warnedRef[r.c.url] = true; warn('outside project: ' + r.c.url); }
          else if (!map[r.path]) { warnedRef[r.c.url] = true; warn('unresolved: ' + r.c.url); }
        });
        const usable = resolved.filter(r => r.path && map[r.path]);
        if (usable.length) {
          const srcCand = srcTargetPath ? usable.find(r => r.path === srcTargetPath) : null;
          const picked = pickSrcsetCandidate(usable.map(r => r.c), srcCand ? srcCand.c.url : '');
          const keep = usable.find(r => r.c === picked) || usable[0];
          consumed[keep.path] = true;
          const dropped = [];
          resolved.forEach(r => {
            if (r === keep || !r.path || !map[r.path]) return;
            consumed[r.path] = true;          // reported by the collapse note, not layer 3
            dropped.push(r.path);
          });
          const uri = dataUri(map[keep.path], keep.path);
          if (t === 'img') { setAttr('src', uri); delAttr('srcset'); }
          else { setAttr('srcset', uri); delAttr('src'); }
          delAttr('sizes');
          if (resolved.length > 1) {
            warn('Responsive variants collapsed for preview: kept ' + keep.path
              + (dropped.length ? ', dropped ' + dropped.join(', ') : '')
              + '. All files are still stored in the project.', 'info');
          }
          return '<' + tag + out + '>';
        }
      }

      if (t === 'video') {
        const poster = getAttr('poster');
        const ph = poster ? lookup(poster, entryDir) : null;
        if (ph) setAttr('poster', dataUri(ph.rec, ph.path));
      }
      const sh = srcRef ? lookup(srcRef, entryDir) : null;
      if (sh) setAttr('src', dataUri(sh.rec, sh.path));
      return '<' + tag + out + '>';
    });

    // ---- Layer 2: unhandled ref-attribute census ---------------------------------
    // Any HTML_REF_ATTRS attribute still holding a RELATIVE value, on a (tag, attr)
    // pair the rewrite table doesn't cover, is reported — <object data>, <embed src>,
    // <track src>, <form action>, <a href>, style="…url(…)…" and friends.
    // Hits are COLLECTED, not warned inline: groupRefWarnings folds them into one entry
    // per form, so a 5-page site sharing a nav gets one note instead of eight lines.
    const refHits = [];
    const noteRef = (tag, attr, ref) => {
      warnedRef[ref] = true;
      refHits.push({ tag, attr, ref });
      // A ref that resolves to a REAL project file is now accounted for here, so
      // layer 3 must not report the same file a second time as "never inlined".
      const p = resolveHtmlPath(entryDir, ref);
      if (p && map[p]) consumed[p] = true;
    };
    html.replace(/<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g, (m0, tag, attrs) => {
      const t = tag.toLowerCase();
      HTML_REF_ATTRS.forEach(name => {
        if (HTML_HANDLED_REFS.indexOf(t + '|' + name) !== -1) return;
        const m = attrs.match(new RegExp('\\s' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
        if (!m) return;
        const val = (m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]) || '';
        if (!val || isAbsoluteRef(val) || /^data:/i.test(val) || warnedRef[val]) return;
        noteRef(t, name, val);
      });
      const sm = attrs.match(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      const sv = sm ? (sm[1] !== undefined ? sm[1] : sm[2]) : '';
      const um = sv ? sv.match(/url\(\s*['"]?([^'")]+)/i) : null;
      const uref = um ? um[1].trim() : '';
      if (uref && !isAbsoluteRef(uref) && !/^data:/i.test(uref) && !warnedRef[uref]) {
        noteRef(t, 'style', uref);
      }
      return m0;
    });
    groupRefWarnings(refHits).forEach(w => warnings.push(w));

    // ---- Layer 3: unconsumed-file audit (the structural guarantee) ----------------
    // Whitelist-free and forward-proof: a file sitting in the project that the bundler
    // never inlined is itself the evidence that some reference form went unhandled.
    Object.keys(map).forEach(p => {
      if (consumed[p]) return;
      warn(p + ' is in the project but was never inlined — it may be referenced in a form the preview doesn’t support.');
    });

    // ---- Heuristics (Notes) ------------------------------------------------------
    if (/(?:fetch\s*\(|XMLHttpRequest|\bimport\s*\(|localStorage|sessionStorage)/.test(html)) {
      warn('Network and storage APIs don’t work in the sandboxed preview (opaque origin + CSP).', 'info');
    }
    const remoteScript = /<script\b[^>]*\ssrc\s*=\s*["']?https?:/i.test(html);
    const remoteStyle = (html.match(/<link\b[^>]*>/gi) || [])
      .some(tg => /rel\s*=\s*["']?stylesheet/i.test(tg) && /href\s*=\s*["']?https?:/i.test(tg));
    if (remoteScript || remoteStyle) {
      warn('Remote scripts and stylesheets are blocked by the app’s CSP; remote images do load.', 'info');
    }

    return { html, warnings };
  } catch (e) {
    return {
      html: (block && block.code) || '',
      warnings: [{ level: 'warn', text: 'Bundler error — showing the raw entry file.' }],
    };
  }
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
  { kind: 'json', icon: '{}', label: 'JSON tree' },
  { kind: 'html', icon: '▶', label: 'HTML preview' },
];
function blockKind(block) {
  if (block.checklist) return 'checklist';
  if (block.rich) return 'rich';
  if (block.note) return 'note';
  if (block.csv) return 'csv';
  if (block.json) return 'json';
  // NOTE: the discriminator is the block.html BOOLEAN, never type === 'html' —
  // plain CODE blocks legitimately use 'html' as their language and must stay code.
  if (block.html) return 'html';
  return 'code';
}
function newBlockOfKind(kind) {
  if (kind === 'note') return newNoteBlock();
  if (kind === 'rich') return newRichBlock();
  if (kind === 'checklist') return newChecklistBlock();
  if (kind === 'csv') return newCsvBlock();
  if (kind === 'json') return newJsonBlock();
  if (kind === 'html') return newHtmlBlock();
  return newBlock();
}
// HTML → plain text preserving line breaks. Done by mapping block-close tags and
// <br> to newlines on the markup string (NOT via a detached node's innerText —
// detached nodes have no layout, so innerText collapses every block boundary and
// the conversion silently loses all line breaks).
function richToPlainText(html) {
  let s = String(html || '');
  s = s.replace(/<\s*br\s*\/?>/gi, '\n');
  // An <img> carries its meaning in alt= — keep that instead of dropping the element.
  s = s.replace(/<img\b[^>]*>/gi, (m) => {
    const a = /\balt\s*=\s*("([^"]*)"|'([^']*)')/i.exec(m);
    return a ? (a[2] != null ? a[2] : (a[3] || '')) : '';
  });
  // Cells become TAB-separated so a table survives as a real grid (this is what makes
  // rich→csv convert produce a table rather than one run-on line). Must run BEFORE the
  // block-close pass, which would otherwise swallow </td> via the generic alternation.
  s = s.replace(/<\/(td|th)\s*>/gi, '\t');
  s = s.replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr|ul|ol|table|thead|tbody|tfoot|caption)\s*>/gi, '\n');
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
  delete block.note; delete block.rich; delete block.checklist; delete block.items; delete block.csv; delete block.json;
  delete block.html; delete block.files; delete block.entry; delete block.htmlH;
  if (kind === 'note') { block.note = true; block.type = 'markdown'; block.code = text; }
  else if (kind === 'rich') { block.rich = true; block.type = 'plaintext'; block.code = textToRichHtml(text); }
  else if (kind === 'checklist') { block.checklist = true; block.type = 'checklist'; block.items = textToChecklistItems(text); block.code = ''; }
  else if (kind === 'csv') { block.csv = true; block.type = 'csv'; block.code = text; }
  else if (kind === 'json') { block.json = true; block.type = 'json'; block.code = text; }
  // the text becomes the ENTRY file's source; a fresh project has no other files
  else if (kind === 'html') { block.html = true; block.type = 'html'; block.code = text; block.entry = 'index.html'; block.files = []; }
  else { block.type = 'plaintext'; block.code = text; }   // code
}

// Converting AWAY from an html block keeps only the entry HTML — the other project
// files are dropped. Confirm first (naming them) when there are any; every convert
// call site routes through this so the guard can't be bypassed. History is still the
// undo path, so a plain confirm is enough.
function confirmKindChange(block, kind, go) {
  const extra = (blockKind(block) === 'html' && kind !== 'html' && Array.isArray(block.files)) ? block.files.length : 0;
  if (!extra) { go(); return; }
  const names = block.files.slice(0, 3).map(f => (f && f.p) || '').filter(Boolean).join(', ');
  const target = (BLOCK_KINDS.find(k => k.kind === kind) || { label: kind }).label;
  showConfirm(
    'Converting to ' + target + ' discards ' + extra + ' other project file' + (extra > 1 ? 's' : '')
    + (names ? ' (' + names + (extra > 3 ? ', …' : '') + ')' : '')
    + '. The entry HTML is kept. This can be undone from page History.',
    { okLabel: 'Convert', danger: false }
  ).then(ok => { if (ok) go(); });
}

// Pure: wrap a menu index into [0,n) so ArrowUp/Down cycle past both ends
// (returns -1 for an empty menu). Extracted so it's unit-testable in isolation.
function miniMenuWrapIndex(i, n) {
  if (!n) return -1;
  return ((i % n) + n) % n;
}

// Pure: is this a "checkable" menu — does any option carry a checked state? A
// checkable menu (e.g. the per-column sort picker) reserves the 24px icon column
// on EVERY row so the checked (✓) and unchecked rows stay label-aligned. Menus
// with no checkable item keep the per-item `it.icon` behavior exactly as before
// (icon column only on rows that supply an icon), so no existing menu shifts.
function miniMenuHasCheck(items) {
  return items.some(it => it && !it.divider && it.checked !== undefined);
}

// Pure: keep an anchorRect-positioned menu box inside the viewport.
// It returns the requested {top,left} UNCHANGED whenever the box already fits — the
// anchorRect contract is "plain position from the caller's rect", and preserving that
// byte-for-byte in the normal case is the whole point of the mode. Only a genuine
// overflow moves the box, and then by the minimum needed to bring it back inside with
// a `pad` margin. It SHIFTS, never flips: an anchorRect carries a bottom edge but not
// necessarily a usable top edge, so there's nothing to flip around. `.mini-menu` is
// height-capped (min(70vh,520px)) and scrolls internally, so a shifted menu always has
// every row reachable. NEVER THROWS.
const MINI_MENU_PAD = 8;
function miniMenuClampPos(top, left, w, h, vw, vh, pad) {
  const p = pad == null ? MINI_MENU_PAD : pad;
  let t = top, l = left;
  if (l + w > vw) l = Math.max(p, vw - p - w);
  else if (l < 0) l = p;
  if (t + h > vh) t = Math.max(p, vh - p - h);
  else if (t < 0) t = p;
  return { top: t, left: l };
}

// Pure: the same viewport guard for the align:'right' mode, expressed as a SHIFT of the
// ALREADY-RENDERED box. That mode positions with `left = r.right` plus a CSS
// translateX(-100%), so the box's visual left edge is `r.right - width`, NOT the `left`
// property — feeding the raw property into miniMenuClampPos would be wrong in both
// directions. Measuring the RENDERED rect sidesteps that (and the transform's sub-pixel
// width) entirely. Returns {dx:0,dy:0} whenever the box already fits, which is what leaves
// a fitting menu on the exact pixel it has always used. NEVER THROWS.
function miniMenuShift(top, left, w, h, vw, vh, pad) {
  const pos = miniMenuClampPos(top, left, w, h, vw, vh, pad);
  return { dx: pos.left - left, dy: pos.top - top };
}

// The single accessible popup-menu implementation, anchored to a button.
// items: [{icon,label,active,checked,onClick}] (or {divider:true} for a separator).
// A `checked` (boolean) makes the option a role="menuitemradio" and marks the menu
// "checkable" — every row then reserves the icon column and checked rows show ✓
// (the per-column sort picker). Reuses the .mini-menu styling (shared with the
// Export + sidebar-⋯ + colsort + copy-as menus).
//
// Accessibility (ARIA menu-button pattern): the container is role="menu", each
// option role="menuitem" (roving tabindex=-1), dividers role="separator"; the
// anchor gets aria-haspopup="menu" + aria-expanded toggled. Keyboard: ArrowUp/
// Down wrap, Home/End jump, Enter/Space activate, Escape/Tab close. Focus moves
// to the first item on open. Keyboard dismissal (Escape/Tab) returns focus to the
// anchor (failing soft if it was removed by a re-render); pointer dismissal
// (outside-click/scroll) and item activation do NOT force focus — the click target
// or the invoked action (which often opens its own modal/panel) owns focus instead.
//
// Three positioning modes via opts, each preserving a pre-existing behavior
// exactly (zero positional regression is the acceptance criterion):
//   default            — clamp to the viewport + flip upward near the bottom edge.
//   opts.align:'right' — right-align under the anchor (openMoreMenu: left=r.right,
//                        translateX(-100%)) so it tucks under the sidebar. NO clamp
//                        while the box fits — the position is then byte-identical to
//                        the right-aligned one. Only a genuine viewport overflow shifts
//                        it back inside (see miniMenuShift, which clamps the RENDERED
//                        rect because the transform moves the visual left edge); without
//                        that, a sidebar narrowed to SIDEBAR_MIN pushed the menu off the
//                        left edge of the window, where it can't be scrolled to.
//   opts.anchorRect    — plain position from a caller-supplied rect (the exportMenu /
//                        colsort / Copy-as cases). No flip, and NO clamp while the box
//                        fits — the position is then byte-identical to the rect. Only a
//                        genuine viewport overflow shifts it back inside (see
//                        miniMenuClampPos); without that, a short window left the last
//                        rows unreachable (.mini-menu is position:fixed, so the page
//                        can't be scrolled to them).
function showMiniMenu(anchorEl, items, opts = {}) {
  const open = document.querySelector('.mini-menu');
  if (open) { const wasMine = open._anchor === anchorEl; (open._close || open.remove).call(open, false); if (wasMine) return; }
  const menu = document.createElement('div');
  menu.className = 'mini-menu'; menu._anchor = anchorEl;
  menu.setAttribute('role', 'menu');
  // Name the menu for a screen reader (else it's just "menu, N items"): prefer the
  // trigger's title, fall back to its aria-label / trimmed text.
  const menuName = anchorEl && (anchorEl.getAttribute('title') || anchorEl.getAttribute('aria-label') || (anchorEl.textContent || '').trim());
  if (menuName) menu.setAttribute('aria-label', menuName);
  menu.tabIndex = -1;
  const optEls = [];
  const checkable = miniMenuHasCheck(items);
  let checkedIdx = -1;
  items.forEach(it => {
    if (it.divider) { const d = document.createElement('div'); d.className = 'mini-menu-sep'; d.setAttribute('role', 'separator'); menu.appendChild(d); return; }
    const o = document.createElement('div');
    o.className = 'mini-menu-opt' + (it.active ? ' active' : '');
    o.tabIndex = -1;
    if (it.checked !== undefined) { o.setAttribute('role', 'menuitemradio'); o.setAttribute('aria-checked', it.checked ? 'true' : 'false'); }
    else { o.setAttribute('role', 'menuitem'); if (it.active) o.setAttribute('aria-current', 'true'); }
    // Render the icon column when this row has an icon OR the menu is checkable
    // (then every row reserves it, ✓ on checked rows) — keeps labels aligned.
    if (it.icon || checkable) { const ic = document.createElement('span'); ic.className = 'mm-ic'; ic.textContent = it.icon || (it.checked ? '✓' : ''); o.appendChild(ic); }
    const lbl = document.createElement('span'); lbl.textContent = it.label; o.appendChild(lbl);
    // On activation: close, run the action, then keep keyboard focus sane. If the
    // action opened a modal/panel (focus already moved off <body>), leave it be. If
    // it only re-rendered/toasted (focus fell to <body>), restore focus to a caller-
    // supplied post-render target (it.refocus, for anchors re-rendered away) or the
    // surviving trigger — so the next Tab doesn't restart at the top of the page.
    o.onclick = () => {
      close(false);
      it.onClick && it.onClick();
      if (document.activeElement === document.body || !document.activeElement) {
        const t = (it.refocus && it.refocus()) || (document.contains(anchorEl) ? anchorEl : null);
        if (t && document.contains(t) && typeof t.focus === 'function') t.focus();
      }
    };
    menu.appendChild(o);
    if (checkedIdx < 0 && it.checked === true) checkedIdx = optEls.length;
    optEls.push(o);
  });
  document.body.appendChild(menu);

  // --- positioning (three preserved modes) ---
  if (opts.anchorRect) {
    // exportMenu / colsort / Copy-as: plain position from the supplied rect (no flip).
    // miniMenuClampPos is a no-op while the box fits, so a menu that isn't overflowing
    // lands on exactly the same pixel as before; only an off-viewport one is pulled back.
    const rect = opts.anchorRect;
    const pos = miniMenuClampPos(rect.bottom + 4, rect.left, menu.offsetWidth, menu.offsetHeight,
                                 window.innerWidth, window.innerHeight);
    menu.style.top = Math.round(pos.top) + 'px';
    menu.style.left = Math.round(pos.left) + 'px';
  } else {
    const r = anchorEl.getBoundingClientRect();
    if (opts.align === 'right') {
      // openMoreMenu: right-align under the ⋯ button so it stays under the sidebar.
      menu.style.top = Math.round(r.bottom + 4) + 'px';
      menu.style.left = Math.round(r.right) + 'px';
      menu.style.transform = 'translateX(-100%)';
      // Then keep it inside the viewport. The translateX(-100%) means the VISUAL left edge
      // is (left - width), not the `left` property, so the clamp is measured on the
      // RENDERED rect. miniMenuShift returns 0/0 while the box fits, and then neither
      // style is rewritten — a fitting menu is pixel-identical to before, transform
      // included (that byte-preservation is the mode's contract).
      const mr = menu.getBoundingClientRect();
      const s = miniMenuShift(mr.top, mr.left, mr.width, mr.height, window.innerWidth, window.innerHeight);
      if (s.dy) menu.style.top = Math.round(r.bottom + 4 + s.dy) + 'px';
      if (s.dx) {
        // Horizontally, apply the correction as an absolute VISUAL left and drop the
        // transform rather than nudging `left` by dx: with translateX(-100%), `left` is
        // the box's RIGHT edge, and a position:fixed box's shrink-to-fit width is bounded
        // by (viewport - left) — so moving `left` rightwards re-wraps the menu narrower
        // and taller, and the dx measured from the old width no longer lands it where it
        // was computed to. Setting the visual left can only give the box MORE room, so the
        // measured width still holds (it can widen back into the 8px pad at most, never
        // past the viewport edge).
        menu.style.transform = 'none';
        menu.style.left = Math.round(mr.left + s.dx) + 'px';
      }
    } else {
      const mw = menu.offsetWidth, mh = menu.offsetHeight;
      menu.style.left = Math.round(Math.min(window.innerWidth - 8 - mw, Math.max(8, r.left))) + 'px';
      // open downward, or upward if it would overflow the viewport bottom
      menu.style.top = Math.round(r.bottom + 4 + mh > window.innerHeight ? Math.max(8, r.top - 4 - mh) : r.bottom + 4) + 'px';
    }
  }

  // --- open state + close/focus-return ---
  // Triggers carry aria-haspopup statically (markMenuTrigger); ensure it as a safety
  // net for any dynamic anchor, then toggle only aria-expanded here.
  if (anchorEl) { if (!anchorEl.hasAttribute('aria-haspopup')) anchorEl.setAttribute('aria-haspopup', 'menu'); anchorEl.setAttribute('aria-expanded', 'true'); }
  let closed = false;
  const off = (e) => { if (!menu.contains(e.target) && e.target !== anchorEl) close(false); };
  // Scrolling the PAGE dismisses the menu (the anchor moves out from under it) — but the
  // menu itself is now scrollable (.mini-menu max-height), and arrowing down past the
  // visible rows scrolls it. That inner scroll is captured here too, so without this
  // guard keyboard navigation would close the menu on the way to the last item.
  // (the target is a Node for a real element/document scroll, but `window` for a
  // synthesized window-dispatched one — Node.contains THROWS on a non-Node)
  const onScroll = (e) => {
    const tgt = e && e.target;
    if (tgt && tgt.nodeType && menu.contains(tgt)) return;
    close(false);
  };
  function close(restoreFocus) {
    if (closed) return; closed = true;
    menu.remove();
    document.removeEventListener('mousedown', off);
    window.removeEventListener('scroll', onScroll, true);
    if (anchorEl) anchorEl.setAttribute('aria-expanded', 'false');
    if (restoreFocus && anchorEl && document.contains(anchorEl)) anchorEl.focus();
  }
  menu._close = close;

  // --- keyboard navigation ---
  let idx = -1;
  const focusAt = (i) => { idx = miniMenuWrapIndex(i, optEls.length); if (idx >= 0) optEls[idx].focus(); };
  menu.addEventListener('keydown', (e) => {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); focusAt(idx + 1); break;
      case 'ArrowUp': e.preventDefault(); focusAt(idx - 1); break;
      case 'Home': e.preventDefault(); focusAt(0); break;
      case 'End': e.preventDefault(); focusAt(optEls.length - 1); break;
      case 'Enter': case ' ': e.preventDefault(); if (idx >= 0) optEls[idx].click(); break;
      case 'Escape': e.preventDefault(); close(true); break;
      case 'Tab': close(true); break; // let focus land back on the anchor, in tab order
    }
  });
  // track the focused item so click-then-arrow keeps a sane starting index
  optEls.forEach((o, i) => o.addEventListener('focus', () => { idx = i; }));

  // Open focused on the current selection in a checkable menu (e.g. the active sort),
  // else on the first item.
  focusAt(checkable && checkedIdx >= 0 ? checkedIdx : 0);
  // defer the dismiss listeners so the opening click/scroll-into-view don't self-close
  setTimeout(() => { document.addEventListener('mousedown', off); window.addEventListener('scroll', onScroll, true); }, 0);
}

// The per-block "type" switch (replaces the old ¶ / T toggles). Same on every
// block kind, so converting is one consistent control everywhere.
function makeTypeMenuButton(block) {
  const cur = BLOCK_KINDS.find(k => k.kind === blockKind(block));
  const btn = menuBtn((cur ? cur.label : 'Type') + ' ▾', () => {
    showMiniMenu(btn, BLOCK_KINDS.map(k => ({
      icon: k.icon, label: k.label, active: blockKind(block) === k.kind,
      onClick: () => confirmKindChange(block, k.kind, () => { convertBlock(block, k.kind); renderPage(); scheduleSave(); }),
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

  // The disclosure triangle IS the accessible collapse control: role=button +
  // roving-free tabindex + aria-expanded, so a screen reader announces it as a
  // button and its collapsed/expanded state. (role=button lives on the toggle, not
  // the whole .section-header, because the header also contains the title <input>
  // and action buttons — a role=button MUST NOT wrap interactive descendants.)
  const toggle = document.createElement('span');
  toggle.className = 'section-toggle';
  toggle.textContent = '▼';
  toggle.setAttribute('role', 'button');
  toggle.tabIndex = 0;
  toggle.setAttribute('aria-expanded', section.collapsed ? 'false' : 'true');
  toggle.setAttribute('aria-label', 'Toggle section' + (section.title ? ': ' + section.title : ''));

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
    dissolveBtn.className = 'secondary section-dissolve';
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

  // Declutter: Duplicate / Variables / Dissolve fold behind a ⋯ menu (the last
  // two are CSS-hidden and proxied via .click() so their exact handlers run — incl.
  // secVarToggle's anyBlockVars disabled-guard/toast). ⛶ Merge + ✕ Delete stay inline.
  const secOverflow = menuBtn('⋯', () => {
    const sectionVarsOnNow = !!section.varsOn && !anyBlockVars;
    const items = [
      { icon: '❐', label: 'Duplicate section', onClick: () => duplicateSection(section, parentArray, idx) },
      { divider: true },
      { icon: '$', label: 'Variables', active: sectionVarsOnNow, onClick: () => secVarToggle.click() },
    ];
    if (dissolveBtn) items.push({ icon: '⤴', label: 'Dissolve', onClick: () => dissolveBtn.click() });
    showMiniMenu(secOverflow, items);
  });
  secOverflow.className = 'secondary section-overflow';
  secOverflow.title = 'More section actions';
  if (dissolveBtn) sectionActions.append(secVarToggle, dissolveBtn, secOverflow, delBtn);
  else sectionActions.append(secVarToggle, secOverflow, delBtn);

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
  const addMenuBtn = menuBtn('+ Add ▾', () => {
    showMiniMenu(addMenuBtn, BLOCK_KINDS.map(k => ({
      icon: k.icon, label: k.label,
      onClick: () => { content.blocks.push(newBlockOfKind(k.kind)); renderPage(); scheduleSave(); },
    })));
  });
  addMenuBtn.title = 'Add a block (Code, Note, Rich Text, Checklist, Table/CSV, JSON tree)';
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
    const tagsBtn = menuBtn('🏷 ' + n, () => {
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
  const toggleCollapse = () => {
    section.collapsed = !section.collapsed;
    el.classList.toggle('collapsed', section.collapsed);
    toggle.setAttribute('aria-expanded', section.collapsed ? 'false' : 'true');
    scheduleSave();
  };
  headerEl.addEventListener('click', (e) => {
    if (e.target === headerEl || e.target === toggle) toggleCollapse();
  });
  // Keyboard: Enter/Space on the focused toggle collapses/expands (the button's
  // native activation contract) without hijacking the header's other controls.
  toggle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCollapse(); }
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
    if (be && block === pendingRevealObj) { pendingRevealObj = null; revealNewEl(be); }
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

// Is a block edit session open on the active page? Derived from the DOM, NOT from a
// tracked Set: a Set would hold a strong ref to the block object and would go stale
// the moment an editing block is deleted (splice + renderPage) or the page is
// re-rendered — permanently suppressing autosave with no way to notice. The DOM is
// self-healing: renderPage rebuilds the editing state from blockBackups, and a
// removed block simply isn't in #page any more.
// `.checklist` is excluded because it is the ONE block kind with no edit session (it
// is always live-editable, has no Cancel, and so never carries `.viewing`).
function anyBlockEditing() {
  try { return !!document.querySelector('#page .block:not(.viewing):not(.checklist)'); }
  catch (e) { return false; }   // FAIL OPEN: a broken predicate must degrade to SAVING
}

// Focus left the block entirely → persist NOW (the crash-safety bound while autosave is
// deferred), but DO NOT end the edit session: sticky editing is deliberate (see the
// "no blur handler" note on the code textarea), and ending it here would hide
// Save/Revert mid-click again. Honors the original blur gotcha — a toolbar click inside
// the block bails via relatedTarget — plus a `.mini-menu` exemption, because a menu
// opened from THIS block's toolbar lives on document.body and would otherwise read as a
// departure (one history slot per menu open). The pageDirty guard caps repeated
// clicking around at ONE write: savePage clears the flag, only a new keystroke re-marks it.
function wireFocusFlush(el) {
  el.addEventListener('focusout', (e) => {
    // The SESSION ENDING is not a departure. Save / Cancel add `.viewing`, which CSS-hides
    // the focused textarea — the browser then fires focusout with a null relatedTarget, and
    // without this guard an explicit Save cost TWO writes (its own, plus this flush landing
    // mid-flight → savePending → a second request) and two history versions.
    if (el.classList.contains('viewing') || !document.contains(el)) return;
    if (e.relatedTarget && (el.contains(e.relatedTarget) || e.relatedTarget.closest('.mini-menu'))) return;
    if (document.querySelector('.mini-menu')) return;
    // A TEARDOWN is not a departure either. Delete/convert splice the block and call
    // renderPage(), which does `#page.innerHTML = ''` — and the engine dispatches the
    // focused button's focusout at the START of that removal, while this element still
    // reports `document.contains(el) === true` and hasn't gained `.viewing`. The sync
    // guards above therefore can't see it, and a delete-while-editing cost TWO writes
    // (this flush, then the delete's own scheduleSave). So re-check the element's state
    // one task later: by then the teardown has finished and `el` is detached.
    //   Deferring (rather than a "renderPage is running" flag) keys the decision on the
    // OBSERVABLE end state instead of on knowing every teardown path, so a future
    // detach route is covered for free and an engine that ever dispatches this focusout
    // asynchronously still lands on the same answer.
    //   It cannot swallow a real departure: the only ways to fail the re-check are
    // `.viewing` (the session ended → Save wrote, or Cancel ran afterEditSession) and
    // detached (renderPage ran → its mutation path called scheduleSave). Both persist
    // by their own route, and the page stays in `pageDirty` regardless.
    setTimeout(() => {
      if (el.classList.contains('viewing') || !document.contains(el)) return;
      if (currentPagePath && pageDirty.has(currentPagePath)) savePage();
    }, 0);
  });
}

// Esc inside an open editor = a quick "done". It MUST route through the Cancel/Revert
// BUTTON (not a bespoke revert) so the afterEditSession()/pageDirty wiring stays
// identical across all six edit-session kinds — that button is the one place each kind
// decides "clean ⇒ just exit" vs "dirty ⇒ restore the backup and stay open".
// An open ⋯ menu owns Escape (showMiniMenu closes itself on it). It also holds focus
// while open, so this listener normally can't fire then; the guard is belt-and-braces
// for a menu opened without moving focus.
function wireEscapeRevert(surfaceEl, revertBtn) {
  surfaceEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.querySelector('.mini-menu')) return;
    e.preventDefault();
    revertBtn.click();
  });
}

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

  const dupBtn = mkBtn('Duplicate', () => duplicateBlock(parentArray, idx));
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
  const overflowBtn = menuBtn('⋯', () => {
    showMiniMenu(overflowBtn, [
      { icon: '❐', label: 'Duplicate block', onClick: () => dupBtn.click() },
      { icon: '⊘', label: 'Clear done', onClick: () => clearBtn.click() },
      { divider: true },
      ...BLOCK_KINDS.map(k => ({
        icon: k.icon, label: k.label, active: blockKind(block) === k.kind,
        onClick: () => confirmKindChange(block, k.kind, () => { convertBlock(block, k.kind); renderPage(); scheduleSave(); }),
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
  // Warn ONCE per block per session when the stored HTML crosses the soft threshold
  // (a pasted data: image is the usual cause). Never truncates — see RICH_SOFT_WARN.
  const warnIfBig = () => {
    if (richWarned.has(block) || (block.code || '').length <= RICH_SOFT_WARN) return;
    richWarned.add(block);
    toast('This rich block is ' + htmlBytesLabel((block.code || '').length)
      + '. It is stored inside the page, and every save keeps up to 20 history versions — so it can use around '
      + htmlBytesLabel((block.code || '').length * 21) + ' on the server.');
  };
  const syncFromSurface = () => { block.code = sanitizeRichHtml(surface.innerHTML); warnIfBig(); scheduleSave(); refreshRevertLabel(); };
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
    beforeEditSession();               // BEFORE .viewing drops (the predicate is DOM-derived)
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
    savePage();   // announces 'Saved' itself, once the write is CONFIRMED
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
      afterEditSession();
      refreshRevertLabel();
      surface.focus();
      toast('Reverted');
    } else {
      blockBackups.delete(block);
      el.classList.add('viewing');
      surface.setAttribute('contenteditable', 'false');
      afterEditSession();
    }
  });
  revertBtn.className = 'secondary block-revert';
  wireEscapeRevert(surface, revertBtn);

  const copyBtn = mkBtn('Copy', () => {
    copyText(surface.innerText || '').then(ok => { if (ok) recordCopy(block); flashCopied(copyBtn, ok ? 'Copied to clipboard' : 'Copy failed'); });
  });
  copyBtn.className = 'secondary block-copy';
  copyBtn.title = 'Copy to clipboard';
  if (isMobile) copyBtn.textContent = '⧉';

  const dupBtn = mkBtn('Duplicate', () => duplicateBlock(parentArray, idx));
  dupBtn.className = 'secondary block-dup';

  // Unified "type" switch (convert to Code / Note / Checklist, keeping the text).
  // Sync the latest HTML into block.code first so the conversion sees current text.
  const typeBtn = makeTypeMenuButton(block);
  typeBtn.addEventListener('mousedown', () => { block.code = sanitizeRichHtml(surface.innerHTML); }, true);

  // Mobile: fold Duplicate + convert-type behind a ⋯ menu (mirrors code blocks) so
  // the toolbar is just [label · ✎/✓ Cancel · ⧉ · ⋯ · ✕]. Sync the surface HTML into
  // block.code before converting so the new kind keeps the current text.
  const overflowBtn = menuBtn('⋯', () => {
    showMiniMenu(overflowBtn, [
      { icon: '❐', label: 'Duplicate block', onClick: () => dupBtn.click() },
      { divider: true },
      ...BLOCK_KINDS.map(k => ({
        icon: k.icon, label: k.label, active: blockKind(block) === k.kind,
        onClick: () => { block.code = sanitizeRichHtml(surface.innerHTML); confirmKindChange(block, k.kind, () => { convertBlock(block, k.kind); renderPage(); scheduleSave(); }); },
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
  wireFocusFlush(el);
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
    beforeEditSession();               // BEFORE .viewing drops (the predicate is DOM-derived)
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
    savePage();   // announces 'Saved' itself, once the write is CONFIRMED
  });
  saveBtn.className = 'block-save';
  if (isMobile) { saveBtn.textContent = '✓'; saveBtn.title = 'Save'; }

  const revertBtn = mkBtn('Cancel', () => {
    const backup = blockBackups.has(block) ? blockBackups.get(block) : (block.code || '');
    if ((block.code || '') !== backup) {
      block.code = backup; textarea.value = backup;
      el.classList.remove('viewing');
      renderTable(); autosize(); afterEditSession(); refreshRevertLabel(); textarea.focus();
      toast('Reverted');
    } else {
      blockBackups.delete(block);
      el.classList.add('viewing');
      afterEditSession();
    }
  });
  revertBtn.className = 'secondary block-revert';
  wireEscapeRevert(textarea, revertBtn);

  const copyBtn = mkBtn('Copy', () => {
    copyText(block.code || '').then(ok => { if (ok) recordCopy(block); flashCopied(copyBtn, ok ? 'Copied to clipboard' : 'Copy failed'); });
  });
  copyBtn.className = 'secondary block-copy';
  copyBtn.title = 'Copy raw CSV to clipboard';
  if (isMobile) copyBtn.textContent = '⧉';

  const dupBtn = mkBtn('Duplicate', () => duplicateBlock(parentArray, idx));
  dupBtn.className = 'secondary block-dup';

  const overflowBtn = menuBtn('⋯', () => {
    showMiniMenu(overflowBtn, [
      { icon: '❐', label: 'Duplicate block', onClick: () => dupBtn.click() },
      { divider: true },
      ...BLOCK_KINDS.map(k => ({
        icon: k.icon, label: k.label, active: blockKind(block) === k.kind,
        onClick: () => { block.code = textarea.value; confirmKindChange(block, k.kind, () => { convertBlock(block, k.kind); renderPage(); scheduleSave(); }); },
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
  wireFocusFlush(el);
  if (!el.classList.contains('viewing')) requestAnimationFrame(autosize);
  return el;
}

// Build the collapsible tree DOM for a parsed JSON value. Pure DOM (textContent only,
// never innerHTML of data) so arbitrary string values can't inject markup. Each key/index
// is clickable → copies its JS-accessor path. `path` is the accessor key list to here.
// `seen` is a DFS ancestor-set (pop-on-exit) that guards reference cycles: a value already
// on the current path renders `[circular]` instead of recursing forever, but
// shared-but-acyclic refs (the same object reached via two sibling keys) render fully in
// both places.
function buildJsonTree(value, path, onCopyPath, seen) {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

  // Leaf (string / number / boolean / null) — a single typed value span.
  if (type !== 'object' && type !== 'array') {
    const v = document.createElement('span');
    v.className = 'json-val json-' + type;
    v.textContent = type === 'string' ? JSON.stringify(value) : String(value);
    return v;
  }

  seen = seen || new Set();
  if (seen.has(value)) {
    const c = document.createElement('span');
    c.className = 'json-val json-circular';
    c.textContent = '[circular]';
    return c;
  }
  seen.add(value);

  const entries = type === 'array'
    ? value.map((v, i) => [i, v])
    : Object.keys(value).map(k => [k, value[k]]);

  const details = document.createElement('details');
  details.className = 'json-node';
  details.open = true;                                  // fully expanded by default
  const summary = document.createElement('summary');
  summary.className = 'json-summary';
  const brace = type === 'array' ? ['[', ']'] : ['{', '}'];
  const meta = document.createElement('span');
  meta.className = 'json-meta';
  meta.textContent = brace[0] + (entries.length ? ' ' + entries.length + (entries.length === 1 ? ' item' : ' items') + ' ' : '') + brace[1];
  summary.appendChild(meta);
  details.appendChild(summary);

  const kids = document.createElement('div');
  kids.className = 'json-children';
  entries.forEach(([k, v]) => {
    const row = document.createElement('div');
    row.className = 'json-row';
    const childPath = path.concat([k]);
    const key = document.createElement('span');
    key.className = 'json-key';
    key.textContent = type === 'array' ? '[' + k + ']' : JSON.stringify(String(k));
    key.title = 'Copy path: ' + jsonPath(childPath);
    key.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onCopyPath(childPath, key); });
    const colon = document.createElement('span');
    colon.className = 'json-colon'; colon.textContent = ':';
    row.append(key, colon, buildJsonTree(v, childPath, onCopyPath, seen));
    kids.appendChild(row);
  });
  details.appendChild(kids);
  seen.delete(value);                                   // pop on exit — only ancestors count
  return details;
}

// Icon-only collapse-all / expand-all toggle for a tree view. Reads the LIVE <details>
// state of the node container at click time (`makeTreeToggleBtn`) and reflects it
// (`syncTreeToggle`): ⊟ = the next click collapses all, ⊞ = the next click expands all
// (NOT ▾/▸ — those are the per-node markers). Hidden when the view has no container nodes
// (a scalar / empty / invalid tree has nothing to fold). Used by the JSON block.
function makeTreeToggleBtn(view) {
  const btn = mkBtn('⊟', () => {
    const nodes = view.querySelectorAll('details.json-node');
    if (!nodes.length) return;
    const anyOpen = Array.prototype.some.call(nodes, n => n.open);
    nodes.forEach(n => n.open = !anyOpen);
    syncTreeToggle(btn, view);
  });
  btn.className = 'secondary tree-toggle';
  return btn;
}
function syncTreeToggle(btn, view) {
  const nodes = view.querySelectorAll('details.json-node');
  btn.style.display = nodes.length ? '' : 'none';
  if (!nodes.length) return;
  const anyOpen = Array.prototype.some.call(nodes, n => n.open);
  btn.textContent = anyOpen ? '⊟' : '⊞';
  btn.title = anyOpen ? 'Collapse all' : 'Expand all';
}

// JSON (tree-viewer) block: a textarea of raw JSON while editing (with a live tree
// preview underneath), a collapsible typed tree while viewing. Malformed JSON never
// breaks the view — parseJsonSafe is tolerant and the view shows a warning banner plus
// the raw text. Click any key/index to copy its JS-accessor path. (Mirrors the CSV block.)
function renderJsonBlock(block, parentArray, idx) {
  const isMobile = document.body.classList.contains('is-mobile');
  const el = document.createElement('div');
  el.className = 'block json' + (blockBackups.has(block) ? '' : ' viewing');

  const toolbar = document.createElement('div');
  toolbar.className = 'block-toolbar';

  const labelInput = document.createElement('input');
  labelInput.className = 'block-label';
  labelInput.placeholder = 'Label (optional)';
  labelInput.value = block.label || '';
  labelInput.addEventListener('input', () => { block.label = labelInput.value; scheduleSave(); });

  const spacer = document.createElement('span');
  spacer.className = 'spacer';

  // The JSON source editor (visible only while editing, via CSS).
  const textarea = document.createElement('textarea');
  textarea.className = 'json-edit';
  textarea.value = block.code || '';
  textarea.spellcheck = false;
  textarea.setAttribute('autocapitalize', 'off');
  textarea.setAttribute('autocorrect', 'off');
  textarea.placeholder = 'Paste JSON — view mode renders a collapsible tree.\n{ "name": "Ada", "tags": ["a", "b"] }';

  // The rendered tree / preview (visible while viewing; also shown live while editing).
  const view = document.createElement('div');
  view.className = 'json-view';

  // Shared collapse-all/expand-all toggle. Re-synced after every render + on per-node
  // <details> toggles (capture listener) so its glyph always reflects the live state.
  const treeToggleBtn = makeTreeToggleBtn(view);
  view.addEventListener('toggle', () => syncTreeToggle(treeToggleBtn, view), true);

  function autosize() {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight + 2, editorCapPx()) + 'px';
  }
  textarea._autosize = autosize;

  const copyPath = (keys, anchor) => {
    copyText(jsonPath(keys)).then(ok => flashCopied(anchor, ok ? 'Copied ' + jsonPath(keys) : 'Copy failed'));
  };

  function renderTree() {
    view.innerHTML = '';
    const raw = block.code || '';
    if (!raw.trim()) {
      const empty = document.createElement('div');
      empty.className = 'json-empty';
      empty.textContent = 'Empty — edit and paste JSON to see it as a tree.';
      view.appendChild(empty);
      syncTreeToggle(treeToggleBtn, view);
      return;
    }
    const { ok, value, error } = parseJsonSafe(raw);
    if (!ok) {
      const warn = document.createElement('div');
      warn.className = 'json-warn';
      warn.textContent = '⚠ Invalid JSON — ' + error;
      const pre = document.createElement('pre');
      pre.className = 'json-raw';
      pre.textContent = raw;                              // raw text fallback (still readable)
      view.append(warn, pre);
      syncTreeToggle(treeToggleBtn, view);
      return;
    }
    const tree = document.createElement('div');
    tree.className = 'json-tree';
    tree.appendChild(buildJsonTree(value, [], copyPath));
    view.appendChild(tree);
    syncTreeToggle(treeToggleBtn, view);
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
    block.code = textarea.value; renderTree(); autosize(); scheduleSave(); refreshRevertLabel();
  });

  function enterEdit() {
    beforeEditSession();               // BEFORE .viewing drops (the predicate is DOM-derived)
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
    renderTree();
    savePage();   // announces 'Saved' itself, once the write is CONFIRMED
  });
  saveBtn.className = 'block-save';
  if (isMobile) { saveBtn.textContent = '✓'; saveBtn.title = 'Save'; }

  const revertBtn = mkBtn('Cancel', () => {
    const backup = blockBackups.has(block) ? blockBackups.get(block) : (block.code || '');
    if ((block.code || '') !== backup) {
      block.code = backup; textarea.value = backup;
      el.classList.remove('viewing');
      renderTree(); autosize(); afterEditSession(); refreshRevertLabel(); textarea.focus();
      toast('Reverted');
    } else {
      blockBackups.delete(block);
      el.classList.add('viewing');
      afterEditSession();
    }
  });
  revertBtn.className = 'secondary block-revert';
  wireEscapeRevert(textarea, revertBtn);

  const copyBtn = mkBtn('Copy', () => {
    copyText(block.code || '').then(ok => { if (ok) recordCopy(block); flashCopied(copyBtn, ok ? 'Copied to clipboard' : 'Copy failed'); });
  });
  copyBtn.className = 'secondary block-copy';
  copyBtn.title = 'Copy raw JSON to clipboard';
  if (isMobile) copyBtn.textContent = '⧉';

  const dupBtn = mkBtn('Duplicate', () => duplicateBlock(parentArray, idx));
  dupBtn.className = 'secondary block-dup';

  // Pretty-print the JSON (2-space indent), into the textarea + block.code, and re-render.
  // No-op (with a toast) when the JSON is invalid — can't format what won't parse.
  const formatJsonBlock = () => {
    const src = (el.classList.contains('viewing') ? block.code : textarea.value) || '';
    const { ok, value } = parseJsonSafe(src);
    if (!ok) { toast('Can’t format — invalid JSON'); return; }
    block.code = formatJson(value);
    textarea.value = block.code;
    renderTree();
    if (!el.classList.contains('viewing')) autosize();
    scheduleSave();
    toast('Formatted');
  };

  const overflowBtn = menuBtn('⋯', () => {
    showMiniMenu(overflowBtn, [
      { icon: '❐', label: 'Duplicate block', onClick: () => dupBtn.click() },
      { icon: '{ }', label: 'Format (pretty-print)', onClick: () => formatJsonBlock() },
      { divider: true },
      ...BLOCK_KINDS.map(k => ({
        icon: k.icon, label: k.label, active: blockKind(block) === k.kind,
        onClick: () => { block.code = textarea.value; confirmKindChange(block, k.kind, () => { convertBlock(block, k.kind); renderPage(); scheduleSave(); }); },
      })),
    ]);
  });
  overflowBtn.className = 'secondary block-overflow';
  overflowBtn.title = 'More actions';

  const delBtn = mkBtn('Delete', () => { parentArray.splice(idx, 1); renderPage(); scheduleSave(); });
  delBtn.className = 'danger';
  if (isMobile) { delBtn.textContent = '✕'; delBtn.title = 'Delete'; }

  toolbar.append(labelInput, spacer, typeBtn, editBtn, saveBtn, revertBtn, treeToggleBtn, copyBtn, dupBtn, overflowBtn, delBtn);
  el.append(toolbar, textarea, view);
  renderTree();
  wireFocusFlush(el);
  if (!el.classList.contains('viewing')) requestAnimationFrame(autosize);
  return el;
}

/* ---------- HTML PROJECT (block) ---------- */

// htmlBundleKey → 'running' | 'stopped'. Absent = never mounted, so the preview waits
// for the block to scroll into view. renderPage() rewrites #page wholesale, so a live
// iframe can't survive it — the guarantee is over RUN STATE, not DOM state.
// RULE: any content mutation goes through the block's refreshAfterMutation(), which
// carries THIS render's run state forward explicitly and rebuilds the view exactly
// once. htmlBundleKey moving is no longer the enforcement mechanism (it fingerprints
// binaries now, but the explicit carry is what makes correctness independent of it).
const htmlRunState = new Map();
function setHtmlRunState(key, state) {
  htmlRunState.delete(key);                 // re-insert so the FIFO order is recency
  htmlRunState.set(key, state);
  while (htmlRunState.size > 64) htmlRunState.delete(htmlRunState.keys().next().value);
}

// Preview height, clamped to something sane whatever is stored.
function htmlHeightPx(block) {
  const h = Number((block && block.htmlH) || HTML_DEFAULT_H) || HTML_DEFAULT_H;
  return Math.max(120, Math.min(1200, Math.round(h)));
}

// Swap which file is the entry: block.code is ALWAYS the entry's source, so the old
// entry goes back into files[] as text and the new one is pulled out into code.
function setHtmlEntry(block, path) {
  const next = normalizeHtmlPath(path || '');
  if (!next) return;
  const cur = normalizeHtmlPath(block.entry || '');
  if (next === cur) return;
  if (!Array.isArray(block.files)) block.files = [];
  const i = block.files.findIndex(f => f && normalizeHtmlPath(f.p || '') === next);
  const rec = i === -1 ? null : block.files.splice(i, 1)[0];
  if (cur) block.files.push({ p: cur, t: block.code || '' });
  block.entry = next;
  block.code = rec ? String(rec.t || '') : '';
}

// HTML-project block: a small static site stored inline in the page, previewed in a
// sandboxed iframe. Edit mode is a plain textarea over the ENTRY file only (the CSV /
// JSON pattern — deliberately NOT the Prism .code-stack overlay, whose ED_* metrics
// coupling is why per-file editing is a separate phase).
function renderHtmlBlock(block, parentArray, idx) {
  const isMobile = document.body.classList.contains('is-mobile');
  const el = document.createElement('div');
  el.className = 'block html' + (blockBackups.has(block) ? '' : ' viewing');

  if (!Array.isArray(block.files)) block.files = [];

  const toolbar = document.createElement('div');
  toolbar.className = 'block-toolbar';

  const labelInput = document.createElement('input');
  labelInput.className = 'block-label';
  labelInput.placeholder = 'Label (optional)';
  labelInput.value = block.label || '';
  labelInput.addEventListener('input', () => { block.label = labelInput.value; scheduleSave(); });

  const spacer = document.createElement('span');
  spacer.className = 'spacer';

  // The entry-file source editor (visible only while editing, via CSS).
  const textarea = document.createElement('textarea');
  textarea.className = 'html-edit';
  textarea.value = block.code || '';
  textarea.spellcheck = false;
  textarea.setAttribute('autocapitalize', 'off');
  textarea.setAttribute('autocorrect', 'off');
  // mobile has no folder picker (.html-upload is hidden there) — don't offer the route
  textarea.placeholder = (isMobile ? 'Entry HTML — write it here.' : 'Entry HTML — upload a folder, or write it here.')
    + '\n<!DOCTYPE html>\n<html>…</html>';

  const view = document.createElement('div');
  view.className = 'html-view';

  function autosize() {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight + 2, editorCapPx()) + 'px';
  }
  textarea._autosize = autosize;

  /* ----- preview mount / unmount (run state, never renderPage) ----- */

  let frameWrap = null, poster = null, frame = null, observer = null;
  // THIS render's run state — the authority while the block is on screen. htmlRunState
  // stays the authority only ACROSS renderPage() rebuilds, where the closure is gone.
  let myState;
  let lastWarnings = [];        // what renderView last put in the banner

  function mountFrame() {
    if (!frameWrap || frame) return;
    if (poster) poster.style.display = 'none';
    frame = document.createElement('iframe');
    frame.className = 'html-frame';
    // SECURITY INVARIANT: allow-scripts WITHOUT allow-same-origin ⇒ opaque origin ⇒
    // no parent.document, no cookies, no storage; with the inherited CSP, no egress.
    // Adding allow-same-origin alongside allow-scripts VOIDS the entire sandbox.
    // This is permanent, not a tuning knob.
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('loading', 'lazy');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('title', 'HTML preview' + (block.label ? ': ' + block.label : ''));
    frame.srcdoc = bundleHtmlProject(block).html;
    frameWrap.appendChild(frame);
    myState = 'running';
    setHtmlRunState(htmlBundleKey(block), 'running');
    syncRunBtn();
  }
  function unmountFrame() {
    if (frame) { frame.remove(); frame = null; }
    if (poster) poster.style.display = '';
    myState = 'stopped';
    setHtmlRunState(htmlBundleKey(block), 'stopped');
    syncRunBtn();
  }
  // THE seam for every content mutation (upload, entry change, file remove, save,
  // revert). Replaces the old `renderView(); remountFrame();` pairs, which mounted the
  // iframe twice and made "remember to remount" the only thing keeping run state right.
  // Deliberately does NOT call scheduleSave() — each caller keeps its own explicit call
  // so the dirty choke point stays visible at the mutation site.
  function refreshAfterMutation() {
    const carry = frame ? 'running' : myState;   // undefined stays undefined → observer re-arms
    if (frame) { frame.remove(); frame = null; }
    const key = htmlBundleKey(block);
    if (carry) setHtmlRunState(key, carry); else htmlRunState.delete(key);
    renderView();                                // consults that state and mounts at most ONCE
    // Announce the banner's state on ACTION-DRIVEN re-renders only. The banner itself is
    // a role="region" (silent at rest) precisely so three html blocks don't fire three
    // live-region announcements every time a page is opened.
    if (lastWarnings.length) {
      const s = htmlWarnSummary(lastWarnings);
      toast(s.glyph + ' ' + s.text);
    }
  }

  function reloadFrame() { if (frame) { frame.remove(); frame = null; } mountFrame(); }
  const runBtn = mkBtn('▶', () => { if (frame) reloadFrame(); else mountFrame(); });
  runBtn.className = 'secondary html-run';
  function syncRunBtn() {
    runBtn.textContent = frame ? '↻' : '▶';
    runBtn.title = frame ? 'Reload preview' : 'Run preview';
    runBtn.setAttribute('aria-label', runBtn.title);
    stopBtn.disabled = !frame;                   // nothing to stop while idle
  }
  const stopBtn = mkBtn('■', () => unmountFrame());
  stopBtn.className = 'secondary html-stop';
  stopBtn.title = 'Stop preview';
  stopBtn.setAttribute('aria-label', 'Stop preview');

  /* ----- the view: warnings + frame + file list ----- */

  // The banner. `budget` caps the rendered list so a pathologically broken project can't
  // produce a banner taller than the preview; the "+N more" button re-renders the same
  // box with an unlimited budget, so the tail is REACHABLE rather than merely counted.
  // Truncation priority (Problems before Notes) is preserved exactly.
  function renderWarnings(warnings, budgetIn) {
    if (!warnings.length) return null;
    const problems = warnings.filter(w => w.level !== 'info');
    const notes = warnings.filter(w => w.level === 'info');
    const sum = htmlWarnSummary(warnings);
    const box = document.createElement('div');
    box.className = 'html-warn' + (sum.infoOnly ? ' html-warn-info' : '');
    // role=region (NOT status): a live region present at render would announce on every
    // page open. Change announcements go through toast() in refreshAfterMutation.
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', 'Preview notes: ' + sum.text);
    const head = document.createElement('div');
    head.textContent = sum.glyph + ' ' + sum.text;
    box.appendChild(head);
    let budget = budgetIn === undefined ? 12 : budgetIn;
    const addList = (items, cls, title) => {
      if (!items.length || budget <= 0) return;
      const h = document.createElement('div');
      h.className = 'html-warn-head';
      h.textContent = title;
      const ul = document.createElement('ul');
      if (cls) ul.className = cls;
      items.slice(0, budget).forEach(w => {
        const li = document.createElement('li');
        li.textContent = w.text;                 // data-derived → textContent, never innerHTML
        ul.appendChild(li);
      });
      budget -= Math.min(budget, items.length);
      box.append(h, ul);
    };
    addList(problems, '', 'Problems');
    addList(notes, 'html-warn-note', 'Notes');
    const shown = Math.min(budgetIn === undefined ? 12 : budgetIn, warnings.length);
    if (warnings.length > shown) {
      const more = mkBtn('+' + (warnings.length - shown) + ' more', () => {
        const full = renderWarnings(warnings, Infinity);
        if (full && box.parentNode) box.parentNode.replaceChild(full, box);
      });
      more.className = 'secondary html-warn-more';
      box.appendChild(more);
    }
    return box;
  }

  function renderFiles() {
    const rows = htmlFileList(block);
    const wrap = document.createElement('div');
    wrap.className = 'html-files';
    // Size header — what the project costs against the 1 MB cap, before you hit it.
    const size = htmlProjectSize(block);
    const head = document.createElement('div');
    head.className = 'html-files-head' + (size.bytes > HTML_SOFT_WARN ? ' over-soft' : '');
    head.textContent = rows.length + ' file' + (rows.length === 1 ? '' : 's') + ' · '
      + htmlBytesLabel(size.bytes) + ' of ' + htmlBytesLabel(HTML_MAX_TOTAL);
    wrap.appendChild(head);
    rows.forEach(r => {
      const row = document.createElement('div');
      row.className = 'html-file-row' + (r.isEntry ? ' is-entry' : '');
      // the entry marker is its OWN cell (rendered empty on other rows) so every path
      // shares one left edge instead of the entry's text being indented by the glyph
      const mark = document.createElement('span');
      mark.className = 'html-file-mark';
      mark.textContent = r.isEntry ? '⌁' : '';
      if (r.isEntry) mark.title = 'Entry file';
      const name = document.createElement('span');
      name.className = 'html-file-path';
      name.textContent = r.p;                                    // all cells via textContent
      const sz = document.createElement('span');
      sz.className = 'html-file-size';
      sz.textContent = htmlBytesLabel(r.bytes);
      row.append(mark, name, sz);
      if (!r.isEntry && /\.(html|htm)$/i.test(r.p)) {
        const mk = mkBtn('Make entry', () => {
          setHtmlEntry(block, r.p);
          textarea.value = block.code || '';
          scheduleSave();
          refreshAfterMutation();
          toast('Entry set to ' + r.p);
        });
        mk.className = 'secondary html-file-entry';
        row.appendChild(mk);
      }
      if (!r.isEntry) {
        // no modal — page History is the safety net, same as removing any other content
        // (block, section, checklist item). The affordance carries the weight instead:
        // a `danger` button, a real tap target, and a toast naming the recovery path.
        const rm = mkBtn('✕', () => {
          const i = block.files.findIndex(f => f && normalizeHtmlPath(f.p || '') === r.p);
          if (i !== -1) block.files.splice(i, 1);
          scheduleSave();
          refreshAfterMutation();
          toast('Removed ' + r.p + ' — restore from page History');
        });
        rm.className = 'danger html-file-del';
        rm.title = 'Remove ' + r.p;
        rm.setAttribute('aria-label', 'Remove ' + r.p);
        row.appendChild(rm);
      }
      wrap.appendChild(row);
    });
    return wrap;
  }

  function renderView() {
    if (observer) { observer.disconnect(); observer = null; }
    frame = null;
    view.innerHTML = '';
    myState = htmlRunState.get(htmlBundleKey(block));
    lastWarnings = [];
    const hasEntry = !!(block.code || '').trim();
    const files = htmlFileList(block);

    if (!hasEntry && !block.files.length) {
      const empty = document.createElement('div');
      empty.className = 'html-empty';
      empty.textContent = htmlEmptyText(isMobile);
      view.appendChild(empty);
      syncRunBtn();
      return;
    }

    const bundle = bundleHtmlProject(block);
    const warnings = bundle.warnings.slice();
    if (!hasEntry) {
      warnings.unshift({ level: 'warn', text: 'No entry file — pick one with “Make entry”, or edit the entry HTML.' });
    }
    lastWarnings = warnings;
    const warnBox = renderWarnings(warnings);
    if (warnBox) view.appendChild(warnBox);

    if (hasEntry) {
      frameWrap = document.createElement('div');
      frameWrap.className = 'html-frame-wrap';
      frameWrap.style.height = htmlHeightPx(block) + 'px';

      poster = document.createElement('div');
      poster.className = 'html-poster';
      const play = document.createElement('button');
      play.className = 'secondary html-poster-run';
      play.textContent = '▶ Run';
      play.addEventListener('click', () => mountFrame());
      const cap = document.createElement('div');
      cap.className = 'html-poster-cap';
      // The poster is a STOPPED state — say what pressing ▶ will actually do, and that
      // it runs sandboxed with no network access, rather than repeating a file stat line.
      cap.textContent = (normalizeHtmlPath(block.entry || '') || 'index.html')
        + ' · ' + files.length + ' file' + (files.length === 1 ? '' : 's')
        + ' · runs sandboxed, no network access';
      poster.append(play, cap);
      frameWrap.appendChild(poster);
      view.appendChild(frameWrap);
      wireResize(frameWrap);

      if (myState === 'running') {
        mountFrame();                                   // don't make the user click ▶ again
      } else if (myState !== 'stopped') {
        observer = new IntersectionObserver(entries => {
          if (!entries.some(e => e.isIntersecting)) return;
          observer.disconnect(); observer = null;
          mountFrame();
        }, { rootMargin: '200px' });
        observer.observe(frameWrap);
      }
    }

    view.appendChild(renderFiles());
    syncRunBtn();
  }

  // The wrap is CSS-resizable; the iframe would swallow the drag, so shield it with
  // pointer-events:none for the duration and persist the height on release.
  // COUPLING: offsetHeight (border-box) is read back, not clientHeight, because
  // style.height was SET as a border-box value — clientHeight excludes the 1px border
  // on .html-frame-wrap, so every click shrank the stored height by 2px and the preview
  // crept toward its 120px minimum. If that border ever moves to an inner element, this
  // reading becomes the wrong one.
  function wireResize(wrap) {
    wrap.addEventListener('pointerdown', () => {
      if (frame) frame.style.pointerEvents = 'none';
      const startH = wrap.offsetHeight;
      const up = () => {
        if (frame) frame.style.pointerEvents = '';
        const h = wrap.offsetHeight;
        // a click that isn't a drag writes nothing — no htmlH, no scheduleSave, no
        // history churn on a page the user only looked at
        if (h && Math.abs(h - startH) >= 2 && h !== htmlHeightPx(block)) {
          block.htmlH = h; scheduleSave();
        }
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointerup', up);
    });
  }

  /* ----- toolbar ----- */

  const typeBtn = makeTypeMenuButton(block);
  typeBtn.addEventListener('mousedown', () => { block.code = textarea.value; }, true);

  function refreshRevertLabel() {
    const backup = blockBackups.has(block) ? blockBackups.get(block) : (block.code || '');
    const dirty = (block.code || '') !== backup;
    revertBtn.textContent = dirty ? 'Revert' : 'Cancel';
    revertBtn.title = dirty ? 'Undo changes made since you started editing' : 'Exit edit mode (no changes)';
  }

  textarea.addEventListener('input', () => {
    block.code = textarea.value; autosize(); scheduleSave(); refreshRevertLabel();
  });

  function enterEdit() {
    beforeEditSession();               // BEFORE .viewing drops (the predicate is DOM-derived)
    blockBackups.set(block, block.code || '');
    el.classList.remove('viewing');
    refreshRevertLabel();
    requestAnimationFrame(() => { autosize(); textarea.focus(); });
  }
  const editBtn = mkBtn('Edit', enterEdit);
  editBtn.className = 'secondary block-edit';
  editBtn.title = 'Edit the entry HTML';
  if (isMobile) { editBtn.textContent = '✎'; editBtn.title = 'Edit the entry HTML'; }

  const saveBtn = mkBtn('Save', () => {
    block.code = textarea.value;
    blockBackups.delete(block);
    el.classList.add('viewing');
    refreshAfterMutation();
    savePage();   // announces 'Saved' itself, once the write is CONFIRMED
  });
  saveBtn.className = 'block-save';
  if (isMobile) { saveBtn.textContent = '✓'; saveBtn.title = 'Save'; }

  const revertBtn = mkBtn('Cancel', () => {
    const backup = blockBackups.has(block) ? blockBackups.get(block) : (block.code || '');
    if ((block.code || '') !== backup) {
      block.code = backup; textarea.value = backup;
      el.classList.remove('viewing');
      refreshAfterMutation(); autosize(); afterEditSession(); refreshRevertLabel(); textarea.focus();
      toast('Reverted');
    } else {
      blockBackups.delete(block);
      el.classList.add('viewing');
      afterEditSession();
    }
  });
  revertBtn.className = 'secondary block-revert';
  wireEscapeRevert(textarea, revertBtn);

  // Copy hands over the BUNDLED document (the thing you'd paste into a file and open).
  // Deliberately NOT recordCopy(block) — recentCopies is a localStorage array and
  // parking bundled documents there risks the 5 MB quota.
  const copyBtn = mkBtn('Copy', () => {
    copyText(bundleHtmlProject(block).html).then(ok =>
      flashCopied(copyBtn, ok ? 'Copied bundled HTML' : 'Copy failed'));
  });
  copyBtn.className = 'secondary block-copy';
  copyBtn.title = 'Copy the bundled HTML document to clipboard';
  if (isMobile) copyBtn.textContent = '⧉';

  const afterUpload = () => { textarea.value = block.code || ''; refreshAfterMutation(); };
  const uploadBtn = mkBtn('Upload…', () => {
    uploadHtmlProject(block, { replace: false }, afterUpload);
  });
  uploadBtn.className = 'secondary html-upload';
  uploadBtn.title = 'Upload a project folder';

  const dupBtn = mkBtn('Duplicate', () => duplicateBlock(parentArray, idx));
  dupBtn.className = 'secondary block-dup';

  const overflowBtn = menuBtn('⋯', () => {
    showMiniMenu(overflowBtn, [
      { icon: '❐', label: 'Duplicate block', onClick: () => dupBtn.click() },
      { icon: '↻', label: 'Reload preview', onClick: () => { if (frame) reloadFrame(); else mountFrame(); } },
      // Stop lives here at ALL widths; CSS hides the toolbar's ■ on mobile so the phone
      // row stays five controls (✎ ▶ ⧉ ⋯ ✕) without making Stop unreachable there.
      { icon: '■', label: 'Stop preview', onClick: () => unmountFrame() },
      { icon: '↕', label: 'Preview height…', onClick: () => pickHeight() },
      { icon: '⇪', label: 'Replace project…', onClick: () => replaceProject() },
      { icon: '⌁', label: 'Set entry file…', onClick: () => pickEntry() },
      { icon: '⧉', label: 'Copy bundled HTML', onClick: () => copyBtn.click() },
      { divider: true },
      ...BLOCK_KINDS.map(k => ({
        icon: k.icon, label: k.label, active: blockKind(block) === k.kind,
        onClick: () => { block.code = textarea.value; confirmKindChange(block, k.kind, () => { convertBlock(block, k.kind); renderPage(); scheduleSave(); }); },
      })),
    ]);
  });
  overflowBtn.className = 'secondary block-overflow';
  overflowBtn.title = 'More actions';

  function pickEntry() {
    const cands = htmlFileList(block).filter(r => /\.(html|htm)$/i.test(r.p));
    if (!cands.length) { toast('No HTML files in this project'); return; }
    showMiniMenu(overflowBtn, cands.map(r => ({
      icon: r.isEntry ? '⌁' : '', label: r.p, active: r.isEntry,
      onClick: () => {
        if (r.isEntry) return;
        setHtmlEntry(block, r.p);
        textarea.value = block.code || '';
        scheduleSave(); refreshAfterMutation();
        toast('Entry set to ' + r.p);
      },
    })));
  }

  // Discrete height presets — the reliable route when dragging the corner over an
  // iframe is awkward (and the only route at phone widths). A submenu anchored to the
  // ⋯ button rather than inline items: miniMenuHasCheck reserves the 24px icon column
  // on EVERY row of a checkable menu, so inlining these would shift every other ⋯ item.
  function pickHeight() {
    const cur = htmlHeightPx(block);
    showMiniMenu(overflowBtn, HTML_H_PRESETS.map(p => ({
      label: p.label + ' (' + p.px + 'px)',
      checked: cur === p.px,
      onClick: () => {
        block.htmlH = p.px;
        // no remount — the iframe is height:100%, so a running demo keeps running
        if (frameWrap) frameWrap.style.height = p.px + 'px';
        scheduleSave();
      },
    })));
  }

  // Replace DISCARDS the current project, so name what's going before opening a picker
  // the user might otherwise treat as harmless browsing.
  async function replaceProject() {
    if ((block.code || '').trim() || block.files.length) {
      const n = htmlFileList(block).length;
      const go = await showConfirm('Replace discards the current project (' + n + ' file'
        + (n === 1 ? '' : 's') + '). It can be recovered from page History.\n\nReplace?',
        { okLabel: 'Replace', danger: true });
      if (!go) return;
    }
    uploadHtmlProject(block, { replace: true }, afterUpload);
  }

  const delBtn = mkBtn('Delete', () => { parentArray.splice(idx, 1); renderPage(); scheduleSave(); });
  delBtn.className = 'danger';
  if (isMobile) { delBtn.textContent = '✕'; delBtn.title = 'Delete'; }

  toolbar.append(labelInput, spacer, typeBtn, editBtn, saveBtn, revertBtn, runBtn, stopBtn, uploadBtn, copyBtn, dupBtn, overflowBtn, delBtn);
  el.append(toolbar, textarea, view);
  wireFocusFlush(el);

  // Drag-and-drop a folder straight onto the block.
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drop-active'); });
  el.addEventListener('dragleave', (e) => { if (e.target === el) el.classList.remove('drop-active'); });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drop-active');
    const items = e.dataTransfer && e.dataTransfer.items;
    if (!items || !items.length) return;
    collectDroppedFiles(items).then(async ({ files: picked, partial }) => {
      if (!picked.length) return;
      // A directory reader that errored mid-walk means we're holding an incomplete
      // folder — say so BEFORE committing rather than importing a broken project.
      if (partial) {
        const go = await showConfirm('Some folders couldn’t be fully read — this import may be incomplete.\n\nImport anyway?',
          { okLabel: 'Import anyway', danger: false });
        if (!go) return;
      }
      commitHtmlUpload(block, picked, { replace: false }, afterUpload);
    });
  });

  renderView();
  if (!el.classList.contains('viewing')) requestAnimationFrame(autosize);
  return el;
}

// Walk a DataTransferItemList into { files: [{path, file}], partial }.
// FileSystemDirectoryReader.readEntries PAGES AT 100 ENTRIES — it must be called
// repeatedly until it returns an empty array, or a large folder imports partially.
// `partial` is set when a reader or a file handle errors: the walk still resolves with
// whatever it got (never rejects), but the caller must not commit it silently.
async function collectDroppedFiles(items) {
  const roots = [];
  for (let i = 0; i < items.length; i++) {
    const entry = items[i].webkitGetAsEntry && items[i].webkitGetAsEntry();
    if (entry) roots.push(entry);
  }
  const out = [];
  let partial = false;
  const readAll = (reader) => new Promise(res => {
    const acc = [];
    const step = () => reader.readEntries(batch => {
      if (!batch.length) { res(acc); return; }     // empty batch = truly done
      acc.push(...batch);
      step();
    }, () => { partial = true; res(acc); });
    step();
  });
  const walk = async (entry, prefix) => {
    if (!entry) return;
    if (entry.name.charAt(0) === '.') return;                     // .DS_Store, .git/…
    const path = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isFile) {
      const file = await new Promise(res => entry.file(res, () => { partial = true; res(null); }));
      if (file) out.push({ path, file });
      return;
    }
    if (entry.isDirectory) {
      const kids = await readAll(entry.createReader());
      for (const k of kids) await walk(k, path);
    }
  };
  for (const r of roots) await walk(r, '');
  return { files: out, partial };
}

// Read a File into the stored shape: text files as `t`, binaries as ONE UNBROKEN LINE
// of standard base64 under the reserved `b64` key (the shape api.php's search strip
// depends on). The base64 conversion is 8 KB-chunked — a single .apply() over a
// 512 KB buffer blows the argument-list limit.
async function readHtmlFile(path, file) {
  const info = htmlExtInfo(path);
  if (info.text) return { p: path, t: await file.text() };
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 8192) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
  }
  return { p: path, m: info.mime, b64: btoa(bin) };
}

// Open a folder picker and hand the selection to commitHtmlUpload.
function uploadHtmlProject(block, opts, onDone) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.setAttribute('webkitdirectory', '');
  input.setAttribute('directory', '');            // Firefox
  input.style.display = 'none';
  document.body.appendChild(input);
  // `change` never fires when the native dialog is dismissed, so the input has to be
  // cleaned up from `cancel` too — otherwise every abandoned picker leaks a DOM node.
  const cleanup = () => { if (input.parentNode) input.remove(); };
  input.addEventListener('change', () => {
    const picked = Array.from(input.files || []).map(f => ({ path: f.webkitRelativePath || f.name, file: f }));
    cleanup();
    if (picked.length) commitHtmlUpload(block, picked, opts || {}, onDone);
  });
  input.addEventListener('cancel', cleanup);
  input.click();
}

// Build the WHOLE candidate project in a local, check the caps, and only THEN assign
// onto the block — a rejected upload must leave the block completely untouched.
async function commitHtmlUpload(block, picked, opts, onDone) {
  const replace = !!(opts && opts.replace);
  try {
    // skip dot-prefixed segments and empty directory entries; they don't count
    // against the cap either
    const usable = picked.filter(p =>
      p && p.file && !String(p.path).split('/').some(seg => seg.charAt(0) === '.'));
    if (!usable.length) { toast('Nothing to upload'); return; }

    const paths = stripCommonRoot(usable.map(p => p.path));
    const withPaths = usable.map((p, i) => ({ path: paths[i], file: p.file })).filter(p => p.path);

    let dupes = 0;
    const byPath = new Map();
    for (const p of withPaths) {
      if (byPath.has(p.path)) dupes++;            // last write wins
      byPath.set(p.path, p.file);
    }
    if (dupes) toast(dupes + ' duplicate path' + (dupes > 1 ? 's' : '') + ' — last one kept');

    const allPaths = Array.from(byPath.keys());
    const found = resolveHtmlEntry(allPaths);
    let entry = found.entry;
    if (found.ambiguous) {
      if (!found.candidates.length) { toast('No .html file found in that folder'); return; }
      entry = await pickHtmlEntryModal(found.candidates);
      if (!entry) return;                          // cancelled — block untouched
    }

    const records = [];
    for (const [p, f] of byPath) records.push(await readHtmlFile(p, f));

    // candidate list for the cap decision (entry included — it's stored too)
    const incoming = { entry, code: '', files: [] };
    records.forEach(r => {
      if (r.p === entry) incoming.code = r.t || '';
      else incoming.files.push(r);
    });
    // Replace takes the upload wholesale; merge goes through the normative rule, which
    // keeps EVERYTHING the block already had — an old entry the upload doesn't overwrite
    // is demoted to a regular file rather than silently disappearing.
    const merged = replace
      ? { entry: incoming.entry, code: incoming.code, files: incoming.files, replaced: [], displaced: [], added: [] }
      : mergeHtmlProject({ entry: block.entry, code: block.code, files: block.files }, incoming);
    const candidate = merged;

    const sizes = htmlFileList({ entry: candidate.entry, code: candidate.code, files: candidate.files })
      .map(r => ({ p: r.p, bytes: r.bytes }));
    const cap = htmlCapCheck(sizes);
    if (!cap.ok) {
      const top = cap.offenders.slice(0, 5).map(o => o.p + ' — ' + htmlBytesLabel(o.bytes)).join('\n');
      // Informational, not a decision: nothing is committed either way, so this is an
      // acknowledgement (one button) — a Cancel here would imply an alternative outcome.
      await showAlert('Project not imported.\n\n' + cap.hard.join('\n') + '\n\nLargest files:\n' + top);
      return;                                      // NOTHING committed
    }
    if (cap.soft.length) {
      const go = await showConfirm(cap.soft.join('\n') + '\n\nUpload anyway?', { okLabel: 'Upload', danger: false });
      if (!go) return;
    }
    // The ONE destructive branch: paths present on both sides lose their old content.
    // A demote (displaced) deletes nothing, so it doesn't ask. Asked AFTER the cap and
    // soft-warn checks so a rejected upload never poses a question it will then ignore.
    if (merged.replaced.length) {
      const named = merged.replaced.slice(0, 5).join(', ')
        + (merged.replaced.length > 5 ? ' +' + (merged.replaced.length - 5) + ' more' : '');
      const go = await showConfirm('This upload overwrites ' + merged.replaced.length + ' file'
        + (merged.replaced.length === 1 ? '' : 's') + ' already in the project: ' + named
        + '.\n\nThe previous content can be recovered from page History.\n\nMerge?',
        { okLabel: 'Merge', danger: true });
      if (!go) return;                             // block byte-identical, nothing saved
    }

    block.html = true;
    block.type = 'html';
    block.entry = candidate.entry;
    block.code = candidate.code;
    block.files = candidate.files;
    scheduleSave();
    if (onDone) onDone();
    toast(sizes.length + ' file' + (sizes.length === 1 ? '' : 's') + ' imported'
      + (merged.replaced.length ? ' · ' + merged.replaced.length + ' replaced' : '')
      + ' · entry is now ' + candidate.entry
      + (merged.displaced.length ? ' (' + merged.displaced.join(', ') + ' kept as a file)' : ''));

    try {
      if (currentPageData && JSON.stringify(currentPageData).length > HTML_PAGE_WARN) {
        toast('This page is now very large — the server may reject the save (post_max_size). Consider a smaller project.');
      }
    } catch (e) { /* stringify of a huge page can throw — the warning is best-effort */ }
  } catch (e) {
    toast('Upload failed — ' + ((e && e.message) || 'unknown error'));
  }
}

// Ask which .html file is the entry (uses the shared focus-trapping dialog).
function pickHtmlEntryModal(candidates) {
  let chosen = null;                    // submit() takes no args — carry the pick in a closure
  return showModal((box, submit, cancel) => {
    const title = document.createElement('div');
    title.className = 'modal-title';
    title.textContent = 'Which file is the entry point?';
    const list = document.createElement('div');
    list.className = 'modal-list';
    candidates.forEach(p => {
      const b = document.createElement('button');
      b.className = 'secondary';
      b.textContent = p;
      b.onclick = () => { chosen = p; submit(); };
      list.appendChild(b);
    });
    const btns = document.createElement('div');
    btns.className = 'modal-btns';
    const c = document.createElement('button');
    c.className = 'secondary';
    c.textContent = 'Cancel';
    c.onclick = cancel;
    btns.appendChild(c);
    box.append(title, list, btns);
    setTimeout(() => { const f = list.querySelector('button'); if (f) f.focus(); }, 0);
  }, () => chosen);
}

function renderBlock(block, parentArray, idx, sectionVarValues, onSecVarsRefresh, subsectionsArray) {
  // Rich-text and checklist blocks aren't code/markdown surfaces — render them
  // via their own paths (no gutter, lang picker, variables, etc.).
  if (block.checklist) return renderChecklistBlock(block, parentArray, idx);
  if (block.rich) return renderRichBlock(block, parentArray, idx);
  if (block.csv) return renderCsvBlock(block, parentArray, idx);
  if (block.json) return renderJsonBlock(block, parentArray, idx);
  if (block.html) return renderHtmlBlock(block, parentArray, idx);

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
    beforeEditSession();               // BEFORE .viewing drops (the predicate is DOM-derived)
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
    savePage();   // announces 'Saved' itself, once the write is CONFIRMED
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
      afterEditSession();         // persist the revert only if it isn't provably a no-op
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
      afterEditSession();
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
  const copyAsBtn = menuBtn('▾', () => {
    // Route through the shared accessible menu. Preserve the bespoke right-edge
    // clamp exactly by handing showMiniMenu a rect whose left is max(8, r.right-200)
    // (anchorRect mode = plain top/left from the rect, no further clamp/flip) — the
    // popup still anchors to the copy-as button's own position (CLAUDE.md gotcha).
    const r = copyAsBtn.getBoundingClientRect();
    showMiniMenu(copyAsBtn, copyAsOptions().map(([label, text]) => ({
      label,
      onClick: () => copyText(text).then(ok => { if (ok) recordCopy(block); toast(ok ? 'Copied: ' + label : 'Copy failed'); }),
    })), { anchorRect: { bottom: r.bottom, left: Math.max(8, r.right - 200) } });
  });
  copyAsBtn.className = 'secondary copy-as';
  copyAsBtn.title = 'Copy as… (Markdown, escaped string, one line)';

  const dupBtn = mkBtn('Duplicate', () => duplicateBlock(parentArray, idx));
  dupBtn.className = 'secondary block-dup';

  // Split this block into several — inverse of Merge. Splits on blank-line gaps
  // (Merge joins with a blank line); if there are none, splits at the caret.
  const splitBtn = mkBtn('Split', () => {
    const code = block.code || '';
    let parts = code.split(/\n[ \t]*\n[ \t]*\n*/).map(s => s.replace(/^\n+|\n+$/g, '')).filter(s => s.trim() !== '');
    if (parts.length < 2) {
      // Use the caret REMEMBERED from the live edit session (lastCaret, recorded by
      // updateActiveLine), not document.activeElement — by the time this runs the ⋯
      // menu owns focus. In view mode there is no caret, so 0 keeps the existing
      // "add a blank line or place the cursor" semantic (as does a caret at 0 or at
      // the very end — neither is a split point).
      const pos = el.classList.contains('viewing') ? 0 : lastCaret;
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
  const overflowBtn = menuBtn('⋯', () => {
    const items = [];
    // Duplicate leads every level's ⋯ (section/page/checklist/rich/csv/json all do) → keep it
    // first + a divider here too, so it's in one predictable spot across the app.
    items.push({ icon: '❐', label: 'Duplicate block', onClick: () => dupBtn.click() });
    items.push({ divider: true });
    if (!block.note) items.push({ icon: '#', label: 'Line numbers',
      active: el.classList.contains('show-lines'), onClick: () => lineToggle.click() });
    if (!sectionControlled) items.push({ icon: '$', label: 'Variables',
      active: !!block.varsOn, onClick: () => varToggle.click() });
    if (!block.note) items.push({ icon: '⎘', label: 'Split', onClick: () => splitBtn.click() });
    if (subsectionsArray) items.push({ icon: '⤵', label: 'To subsection', onClick: () => toSubBtn.click() });
    // Block-kind switch (replaces the "Code ▾" button, folded into ⋯ on mobile).
    items.push({ divider: true });
    BLOCK_KINDS.forEach(k => items.push({
      icon: k.icon, label: k.label, active: blockKind(block) === k.kind,
      onClick: () => confirmKindChange(block, k.kind, () => { convertBlock(block, k.kind); renderPage(); scheduleSave(); }),
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
  // Last caret offset seen while this block was in an EDIT session. Split reads it
  // instead of document.activeElement: its only UI route is the block ⋯ menu, and
  // showMiniMenu moves focus to its first item on open, so an activeElement check
  // never matched and caret-Split was dead (it always fell back to pos 0 and refused).
  let lastCaret = 0;
  // Highlight the gutter number for the caret's line — only while editing.
  function updateActiveLine() {
    const lines = gutter.children;
    if (el.classList.contains('viewing')) {
      for (let i = 0; i < lines.length; i++) lines[i].classList.remove('active');
      return;
    }
    const pos = textarea.selectionStart || 0;
    lastCaret = pos;   // remembered here, while the textarea still owns the caret
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
  // Esc = a quick "done" (cancels when clean, reverts when dirty), so blocks don't pile
  // up open without a mouse exit. Shared with the other five kinds — see wireEscapeRevert.
  wireEscapeRevert(textarea, revertBtn);

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
    // width:max-content + min-width:100% make the colored <pre> grow to the widest line so
    // .code-view gains a real horizontal scroll range (syncScroll mirrors the textarea's
    // scrollLeft onto it). These MUST be inline: updatePreview rebuilds this cssText on every
    // keystroke (re-highlight), so a style.css width rule would be overridden and the layer
    // would snap back to clipped while typing.
    pre.style.cssText = 'margin:0;padding:0;background:none;white-space:pre;' +
      'width:max-content;min-width:100%;' +
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
  wireFocusFlush(el);
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
      document.querySelectorAll('.block.csv:not(.viewing) .csv-edit, .block.json:not(.viewing) .json-edit, .block.html:not(.viewing) .html-edit')
        .forEach(ta => { if (ta._autosize) ta._autosize(); });
    }, 120);
  };
  window.addEventListener('resize', refit);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', refit);
})();

/* ---------- SAVE ---------- */

// Pages with un-persisted edits. Marked in scheduleSave() — the single choke point
// every mutation path funnels through — and cleared in savePage() ONLY on a
// successful, non-conflict save (a real mtime bump OR a queued-offline write, both of
// which mean the edit is durably captured). A conflict or a thrown save keeps the page
// dirty so the next flush retries it. flushSave() early-returns when the active page
// isn't dirty, so a tab switch / unload on an untouched page does ZERO writes — no
// history churn, no mtime bump (see the flushSave contract in CLAUDE.md).
let pageDirty = new Set();

function scheduleSave() {
  if (currentPagePath) pageDirty.add(currentPagePath);   // UNCHANGED choke point
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  // Defer the NETWORK write while a block editor is open, so an edit the user intends
  // to Cancel never reaches the server and never burns a HISTORY_KEEP slot. Only the
  // debounced write is skipped — the page stays DIRTY, and every editor assigns
  // block.code on `input` BEFORE calling scheduleSave, so currentPageData always holds
  // the live buffer and flushSave (tab switch / unload) still persists it. That
  // property is what the whole deferral rests on; don't break it.
  if (anyBlockEditing()) return;
  saveTimer = setTimeout(savePage, 500);
}

// Whole-page snapshot taken when an edit session begins on an otherwise-clean page.
// If the page is byte-identical at session end (a Cancel/Revert that undid everything),
// the page is provably back to the persisted state and the write can be skipped
// entirely — that is what makes Cancel cost ZERO history versions.
const SNAPSHOT_MAX = 262144;   // don't stringify a 1 MB html-project page twice per session
let cleanPageSnapshot = null;

// Serialize a page for identity comparison. Returns null when it can't (cycles) or when
// it's over `limit` — callers treat null as "can't prove clean". PURE, NEVER THROWS.
function safeStringify(data, limit) {
  try { const s = JSON.stringify(data); return (s && s.length <= (limit || SNAPSHOT_MAX)) ? s : null; }
  catch (e) { return null; }
}

// Capture the clean baseline as a block edit session BEGINS. Called from each
// enterEdit BEFORE the element drops `.viewing` — the predicate is DOM-derived, so
// the order matters (this must see "no editor open yet").
function beforeEditSession() {
  if (anyBlockEditing() || !currentPagePath || pageDirty.has(currentPagePath)) return;
  cleanPageSnapshot = safeStringify(currentPageData);
}

// Called when a block edit session ENDS (Cancel / completed Revert).
function afterEditSession() {
  if (anyBlockEditing()) return;                       // another editor still open → stay deferred
  if (cleanPageSnapshot != null && safeStringify(currentPageData) === cleanPageSnapshot) {
    if (currentPagePath) pageDirty.delete(currentPagePath);   // provably back to the persisted state
  }
  cleanPageSnapshot = null;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  // Deliberately NOT scheduleSave() — that would re-mark the page dirty. scheduleSave
  // stays the single dirty-marking choke point; this only arms the deferred timer.
  if (currentPagePath && pageDirty.has(currentPagePath)) saveTimer = setTimeout(savePage, 500);
}

// Dead-letters WE parked for a rejected save, keyed by page path → dl id. A repeated
// failure on the same page supersedes our own entry instead of stacking one full-page
// snapshot per autosave burst (each entry carries the whole page — 1 MB for an
// html-project page). Only ids this session created are ever replaced: a dead-letter
// parked by flushQueue is a DIFFERENT op (its own content) and is never touched.
const saveDeadLetters = new Map();

// A save the SERVER REJECTED. apiFetch deliberately RESOLVES for a reachable server's
// 4xx (a 4xx is a real response, not "offline" — see the apiFetch gotcha) and for a
// malformed 200 (core.js tags it `_transient`), so an error body used to fall straight
// through to `pageDirty.delete()` + toast('Saved'): the user was told the write
// succeeded, the page went clean, and after a reload the edit existed NOWHERE. Route it
// into the same anti-silent-loss machinery flushQueue uses:
//   • `_transient` (unparseable body — usually a passing server hiccup) → the write
//     QUEUE, whose existing policy retries it 3× across flush cycles then parks it;
//   • terminal 4xx (invalid path / missing parent folder / missing CSRF header) → parked
//     STRAIGHT as a dead-letter: it can never succeed as-is, so retrying would only churn.
// Either way the edit lands in IndexedDB, so it SURVIVES A RELOAD and is reviewable in
// the dead-letter panel (the red badge / sidebar ⋯ / command palette). Only once it is
// durably captured elsewhere may the page leave pageDirty — the same rule the offline
// branch already uses. If even parking fails (IndexedDB unavailable/full) the page stays
// DIRTY so a later flush retries. NEVER reports success.
async function handleSaveError(path, res, data) {
  const reason = (res && res.error) || 'save rejected';
  // Park EXACTLY the content the rejected request carried (each caller passes the same
  // object it sent), forced — a replay must not re-conflict on a stale baseMtime.
  const op = { action: 'save_page', body: { path, data: data || currentPageData, force: true } };
  try {
    if (res && res._transient) {
      await enqueue(op);
      toast('Save failed: ' + reason + ' — queued to retry');
    } else {
      const prev = saveDeadLetters.get(path);
      const entry = await dlAdd(op, reason, 'terminal');
      if (entry && entry.id) saveDeadLetters.set(path, entry.id);
      if (prev) await dlRemove(prev);      // our own superseded snapshot of this page
      toast('Save failed: ' + reason + ' — kept in unsynced changes');
    }
    // An edit that arrived mid-save (savePending) is NOT captured by the op above, so
    // stay dirty and let the finally-block re-save carry it (mirrors the success path).
    if (!savePending) pageDirty.delete(path);
  } catch (e) {
    toast('Save failed: ' + reason);       // page stays dirty → a later flush retries
  }
}

async function savePage() {
  if (!currentPagePath) return;
  // Serialize saves: overlapping autosaves would each read the same stale
  // baseMtime (a NAS round-trip can outlast the 500ms debounce), so the second
  // one lands after the first bumped the file's mtime → a false conflict prompt.
  // While a save is in flight, mark dirty and re-save once it returns instead.
  if (saveInFlight) { savePending = true; return; }
  cleanPageSnapshot = null;   // once we write, the snapshot no longer describes disk
  saveInFlight = true;
  const savedPath = currentPagePath;
  try {
    const tab = openPages.find(t => t.path === savedPath);
    const baseMtime = tab ? tab.baseMtime : null;
    const res = await api('save_page', { path: savedPath, data: currentPageData, baseMtime });
    if (res && res.conflict) { await handleSaveConflict(savedPath, res.mtime); return; }
    // The server REJECTED the write (4xx body, or a malformed 200) — park/queue it so
    // the edit is recoverable, and never toast 'Saved'. See handleSaveError.
    if (res && res.error) { await handleSaveError(savedPath, res, currentPageData); return; }
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
    // Durably captured (a server mtime OR a queued offline write) → no longer dirty.
    // A conflict returned above (early return) or a thrown api() keeps it dirty so a
    // later flush retries. But if an edit arrived mid-save (savePending), stay dirty —
    // the finally-block re-save clears it once THAT save lands, closing any window where
    // an unload could skip a genuinely-dirty page.
    if (!savePending) pageDirty.delete(savedPath);
    // savePage is the SINGLE 'Saved' announcer, and it only speaks AFTER the write is
    // confirmed. The five block-Save handlers used to fire their own synchronous
    // toast('Saved') beside an un-awaited savePage(): on the healthy path that announced
    // twice through the aria-live channel, and on a rejected save it announced success a
    // full request-window BEFORE handleSaveError contradicted it — the exact false-success
    // the rejected-save fix exists to remove. A queued OFFLINE write is durable but is not
    // on the server yet, so it says so rather than borrowing "Saved".
    toast(res && res.offline ? 'Saved offline — will sync' : 'Saved');
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
    // Same blind spot as savePage's main path: a FORCED resend the server still rejects
    // (the folder was deleted meanwhile, a bad path, a missing CSRF header) resolves like
    // a success. Park it instead of announcing an overwrite that never happened — this is
    // exactly what flushQueue does with a conflict-force that still errors.
    if (res && res.error) { await handleSaveError(path, res, tab ? tab.data : currentPageData); return; }
    if (tab && res && res.mtime != null) tab.baseMtime = res.mtime;
    pageDirty.delete(path);
    toast('Saved (overwrote disk version)');
  } else {
    // reload disk version into the tab
    const data = await api('get_page', undefined, 'path=' + encodeURIComponent(path));
    if (!data.sections) data.sections = [];
    const m = data._mtime != null ? data._mtime : null;
    delete data._mtime;
    if (tab) { tab.data = data; tab.baseMtime = m; }
    if (activePath === path) { currentPageData = data; renderPage(); }
    pageDirty.delete(path); // discarded our edits in favour of disk → nothing pending
    toast('Reloaded disk version');
  }
}

// Persist any pending debounced save immediately (e.g. before switching tabs).
// Forced: the active editor is the source of truth at this moment.
function flushSave(opts) {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!currentPagePath) return;
  // Dirty guard: only write if this page actually has un-persisted edits. A tab switch
  // / unload on an unchanged page must do NOTHING (no forced save → no history
  // snapshot, no mtime bump). Call sites stay unconditional; the gate lives here.
  if (!pageDirty.has(currentPagePath)) return;
  cleanPageSnapshot = null;   // once we write, the snapshot no longer describes disk
  const path = currentPagePath, data = currentPageData;
  const tab = openPages.find(t => t.path === path);
  if (opts && opts.keepalive) {
    // Unload path: a keepalive fetch survives the page teardown (a normal fetch is
    // cancelled on navigation). It carries the SAME auth headers as every other write
    // (apiHeaders) — NEVER a header-less network write a gated server would 401. If the
    // browser refuses it (offline, over quota), fall back to queue-routing so the edit
    // still replays on reconnect — never a silent drop. (An IndexedDB write started in
    // beforeunload isn't guaranteed to finish, which is why visibilitychange→hidden is
    // the primary trigger below and beforeunload is only a backstop.)
    const body = JSON.stringify({ path, data, force: true });
    const requeue = () => { try { enqueue({ action: 'save_page', body: { path, data, force: true } }); } catch (e) {} };
    try {
      const p = fetch('api.php?action=save_page', { method: 'POST', keepalive: true, headers: apiHeaders(), body });
      // A REFUSED fetch rejects → requeue. But a fetch that RESOLVES with a 4xx is a
      // rejected write too (deleted parent folder, bad path, missing CSRF header) and was
      // just as silently dropped, so requeue on !ok as well: the queue replays it and, if
      // the server rejects it again, flushQueue parks it as a reviewable dead-letter.
      // Best-effort by nature — on visibilitychange→hidden (the PRIMARY trigger) the
      // document is still alive so this handler runs; on beforeunload it may not.
      if (p && p.then) p.then(r => { if (r && !r.ok) requeue(); }, requeue);
    } catch (e) { requeue(); }
    // No usable response on unload → drop the cached baseMtime so returning to the tab
    // and typing one char doesn't false-conflict against our own keepalive write.
    if (tab) tab.baseMtime = null;
    pageDirty.delete(path);
    return;
  }
  api('save_page', { path, data, force: true })
    .then(res => {
      // Same blind spot as savePage: an error body resolves like a success. Park it and
      // keep the page dirty rather than clearing the flag on a write that never landed.
      if (res && res.error) return handleSaveError(path, res, data);
      if (tab && res && res.mtime != null) tab.baseMtime = res.mtime;
      pageDirty.delete(path);
    });
}

// Persist a dirty page if the tab is hidden/closed. visibilitychange→hidden is the
// PRIMARY trigger (fires reliably on tab switch / app background, and a keepalive fetch
// there completes); beforeunload is a best-effort backstop. Both are unconditional —
// the dirty guard inside flushSave is the gate (an unchanged page writes nothing).
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave({ keepalive: true }); });
window.addEventListener('beforeunload', () => { flushSave({ keepalive: true }); });

/* ---------- INDEX ---------- */

async function rebuildIndex(btn) {
  if (btn) btn.classList.add('spinning');
  const res = await api('rebuild_index');
  await loadTree();
  if (btn) btn.classList.remove('spinning');
  toast(res && res.pages != null ? `Index rebuilt (${res.pages} pages)` : 'Index rebuilt');
}
