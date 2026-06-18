/* ---------- SEARCH ---------- */

const searchInput = document.getElementById('searchInput');
const searchClear = document.getElementById('searchClear');
const deepSearchToggle = document.getElementById('deepSearchToggle');

let deepSearchTimer = null;
let deepSearchSeq = 0;

function runDeepSearch() {
  const q = searchQuery.trim();
  if (!deepSearch || q.length < 2) { deepMatches = new Set(); return; }
  const seq = ++deepSearchSeq;
  if (deepSearchTimer) clearTimeout(deepSearchTimer);
  deepSearchTimer = setTimeout(async () => {
    const res = await api('search_content', undefined, 'q=' + encodeURIComponent(q));
    if (seq !== deepSearchSeq) return; // a newer search superseded this one
    deepMatches = new Set(Array.isArray(res) ? res : []);
    renderTree();
  }, 220);
}

function updateSearch() {
  searchQuery = searchInput.value;
  document.querySelector('.sidebar-search').classList.toggle('has-text', searchQuery !== '');
  if (!searchQuery.trim()) deepMatches = new Set();
  else runDeepSearch();
  renderTree();
  if (deepSearch) renderPage(); // keep the open page's block filter in sync/locked
}

function setDeepSearch(on) {
  deepSearch = on;
  try { localStorage.setItem('codeman.deepSearch', on ? '1' : '0'); } catch (e) {}
  deepSearchToggle.classList.toggle('on', on);
  deepSearchToggle.title = on ? 'Searching inside page content (click to disable)'
                              : 'Also search inside page content';
  deepMatches = new Set();
  if (deepSearch) runDeepSearch();
  renderTree();
  renderPage(); // lock/unlock the open page's block filter accordingly
}

searchInput.addEventListener('input', updateSearch);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { searchInput.value = ''; updateSearch(); }
});
searchClear.addEventListener('click', () => {
  searchInput.value = '';
  updateSearch();
  searchInput.focus();
});
deepSearchToggle.addEventListener('click', () => setDeepSearch(!deepSearch));
setDeepSearch(deepSearch); // initialise toggle state

/* ---------- LAYOUT TOGGLE ---------- */

document.getElementById('layoutToggle').addEventListener('click', (e) => {
  const opt = e.target.closest('.ls-opt');
  if (opt) setSidebarMode(opt.dataset.mode);
  else setSidebarMode(sidebarMode === 'single' ? 'double' : 'single');
});

// Re-render the Miller window on viewport changes (e.g. sidebar resize/orientation).
window.addEventListener('resize', () => { if (sidebarMode === 'double') renderTree(); });

/* ---------- EXPAND / COLLAPSE ALL ---------- */

function allFolderPaths(nodes, out) {
  nodes.forEach(n => {
    if (n.type === 'folder') { out.push(n.path); allFolderPaths(n.children || [], out); }
  });
  return out;
}
document.getElementById('expandAllBtn').addEventListener('click', () => {
  allFolderPaths(treeData, []).forEach(p => expandedFolders.add(p));
  saveExpanded();
  renderTree();
});
document.getElementById('collapseAllBtn').addEventListener('click', () => {
  expandedFolders.clear();
  saveExpanded();
  renderTree();
});

/* ---------- HIDE / SHOW SIDEBAR ---------- */

function setSidebarHidden(hidden) {
  document.body.classList.toggle('sidebar-hidden', hidden);
  // On phones the sidebar is a transient drawer; opening/closing it must not
  // overwrite the persisted DESKTOP show/hide preference (restored on resize back).
  if (!document.body.classList.contains('is-mobile')) {
    try { localStorage.setItem('codeman.sidebarHidden', hidden ? '1' : '0'); } catch (e) {}
  }
}
document.getElementById('hideSidebarBtn').addEventListener('click', () => setSidebarHidden(true));
document.getElementById('showSidebarBtn').addEventListener('click', () => setSidebarHidden(false));
setSidebarHidden(localStorage.getItem('codeman.sidebarHidden') === '1');

/* ---------- SIDEBAR RESIZE ---------- */

const SIDEBAR_MIN = 200;

function applySidebarWidth(w) {
  // keep a sensible minimum, but allow expanding as far as the user wants
  // (cap only to the viewport so it can't push the main pane off-screen)
  const clamped = Math.max(SIDEBAR_MIN, Math.min(window.innerWidth - 120, w));
  document.documentElement.style.setProperty('--sidebar-width', clamped + 'px');
  return clamped;
}

(function initSidebarResize() {
  const saved = parseInt(localStorage.getItem('codeman.sidebarWidth'), 10);
  if (saved) applySidebarWidth(saved);

  const resizer = document.getElementById('sidebarResizer');
  const sidebar = document.querySelector('.sidebar');
  let startX, startW;

  function onMove(e) {
    applySidebarWidth(startW + (e.clientX - startX));
    // columns reflow via flex live; re-render so the slider's fit clamp keeps up
    if (sidebarMode === 'double') renderTree();
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.classList.remove('resizing');
    resizer.classList.remove('dragging');
    const w = sidebar.getBoundingClientRect().width;
    try { localStorage.setItem('codeman.sidebarWidth', Math.round(w)); } catch (e) {}
  }
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startW = sidebar.getBoundingClientRect().width;
    document.body.classList.add('resizing');
    resizer.classList.add('dragging');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
})();

/* ---------- MOBILE / RESPONSIVE ----------
   On phones the fixed sidebar becomes an off-canvas drawer over a full-width
   main pane (CSS in style.css under @media). Here we (1) flag body.is-mobile so
   JS can branch (effectiveMode() forces single-column tree), (2) default the
   drawer CLOSED on phones without touching the desktop preference, and (3) add a
   dim backdrop that closes the drawer on tap. */
(function initMobile() {
  const mq = window.matchMedia('(max-width: 768px)');

  // Backdrop behind the open drawer — tap to close.
  const backdrop = document.createElement('div');
  backdrop.className = 'drawer-backdrop';
  backdrop.addEventListener('click', () => setSidebarHidden(true));
  document.body.appendChild(backdrop);

  // Backdrop behind the open in-page outline overlay — tap to close (mobile only;
  // the outline has no room for a big dismiss and its toggle is in the ⋯ menu it covers).
  const outlineBackdrop = document.createElement('div');
  outlineBackdrop.className = 'outline-backdrop';
  outlineBackdrop.addEventListener('click', () => { if (typeof toggleOutline === 'function') toggleOutline(); });
  document.body.appendChild(outlineBackdrop);

  function apply(matches) {
    document.body.classList.toggle('is-mobile', matches);
    if (matches) {
      // phones: start with the drawer closed (desktop pref untouched)
      document.body.classList.add('sidebar-hidden');
    } else {
      // back to desktop: restore the persisted show/hide preference
      document.body.classList.toggle('sidebar-hidden',
        localStorage.getItem('codeman.sidebarHidden') === '1');
    }
    renderTree(); // effectiveMode() changed → re-render the tree in the right layout
  }
  mq.addEventListener('change', (e) => apply(e.matches));
  apply(mq.matches);
})();
