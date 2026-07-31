// Master list of supported code block types. `id` is stored on the block;
// `prism` is the Prism grammar (loaded on demand via the autoloader plugin).
// `color` is optional — a stable color is derived from the id otherwise.
const LANGUAGES = [
  { id: 'soql', label: 'SOQL', prism: 'sql', color: '#3a7d44' },
  { id: 'apex', label: 'Apex', prism: 'apex', color: '#1f6f9c' },
  { id: 'sql', label: 'SQL', prism: 'sql', color: '#2f6f4f' },
  { id: 'plsql', label: 'PL/SQL', prism: 'plsql' },
  { id: 'java', label: 'Java', prism: 'java', color: '#9c5b1f' },
  { id: 'javascript', label: 'JavaScript', prism: 'javascript', color: '#9c8a1f' },
  { id: 'typescript', label: 'TypeScript', prism: 'typescript', color: '#2f74c0' },
  { id: 'jsx', label: 'JSX', prism: 'jsx' },
  { id: 'tsx', label: 'TSX', prism: 'tsx' },
  { id: 'bash', label: 'Bash / Shell', prism: 'bash', color: '#555' },
  { id: 'powershell', label: 'PowerShell', prism: 'powershell' },
  { id: 'batch', label: 'Batch', prism: 'batch' },
  { id: 'python', label: 'Python', prism: 'python' },
  { id: 'ruby', label: 'Ruby', prism: 'ruby' },
  { id: 'php', label: 'PHP', prism: 'php' },
  { id: 'go', label: 'Go', prism: 'go' },
  { id: 'rust', label: 'Rust', prism: 'rust' },
  { id: 'c', label: 'C', prism: 'c' },
  { id: 'cpp', label: 'C++', prism: 'cpp' },
  { id: 'csharp', label: 'C#', prism: 'csharp' },
  { id: 'kotlin', label: 'Kotlin', prism: 'kotlin' },
  { id: 'swift', label: 'Swift', prism: 'swift' },
  { id: 'objectivec', label: 'Objective-C', prism: 'objectivec' },
  { id: 'scala', label: 'Scala', prism: 'scala' },
  { id: 'groovy', label: 'Groovy', prism: 'groovy' },
  { id: 'dart', label: 'Dart', prism: 'dart' },
  { id: 'r', label: 'R', prism: 'r' },
  { id: 'perl', label: 'Perl', prism: 'perl' },
  { id: 'lua', label: 'Lua', prism: 'lua' },
  { id: 'html', label: 'HTML', prism: 'markup' },
  { id: 'xml', label: 'XML', prism: 'markup' },
  { id: 'css', label: 'CSS', prism: 'css' },
  { id: 'scss', label: 'SCSS', prism: 'scss' },
  { id: 'json', label: 'JSON', prism: 'json' },
  { id: 'yaml', label: 'YAML', prism: 'yaml' },
  { id: 'toml', label: 'TOML', prism: 'toml' },
  { id: 'markdown', label: 'Markdown', prism: 'markdown' },
  { id: 'graphql', label: 'GraphQL', prism: 'graphql' },
  { id: 'dockerfile', label: 'Dockerfile', prism: 'docker' },
  { id: 'nginx', label: 'Nginx', prism: 'nginx' },
  { id: 'apacheconf', label: 'Apache Config', prism: 'apacheconf' },
  { id: 'ini', label: 'INI', prism: 'ini' },
  { id: 'diff', label: 'Diff', prism: 'diff' },
  { id: 'regex', label: 'Regex', prism: 'regex' },
  { id: 'visualbasic', label: 'Visual Basic', prism: 'visual-basic' },
  { id: 'elixir', label: 'Elixir', prism: 'elixir' },
  { id: 'erlang', label: 'Erlang', prism: 'erlang' },
  { id: 'haskell', label: 'Haskell', prism: 'haskell' },
  { id: 'clojure', label: 'Clojure', prism: 'clojure' },
  { id: 'fsharp', label: 'F#', prism: 'fsharp' },
  { id: 'matlab', label: 'MATLAB', prism: 'matlab' },
  { id: 'solidity', label: 'Solidity', prism: 'solidity' },
  { id: 'terraform', label: 'Terraform', prism: 'hcl' },
  { id: 'protobuf', label: 'Protobuf', prism: 'protobuf' },
  { id: 'plaintext', label: 'Plain Text', prism: 'plaintext', color: '#555' }
];
const LANG_BY_ID = Object.fromEntries(LANGUAGES.map(l => [l.id, l]));

function langPrism(id) { return (LANG_BY_ID[id] && LANG_BY_ID[id].prism) || 'plaintext'; }
function langLabel(id) { return (LANG_BY_ID[id] && LANG_BY_ID[id].label) || id; }
function langColor(id) {
  const l = LANG_BY_ID[id];
  if (l && l.color) return l.color;
  // derive a stable, reasonably dark color from the id
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return 'hsl(' + h + ', 45%, 32%)';
}

// Trailing-edge debounce: coalesce a burst of calls into one, `wait` ms after the
// last. Used to keep sidebar renderTree() off the keystroke/resize hot paths (a big
// library renders too slowly to run per event). `.cancel()` drops a pending call.
// Pure/timer-only → unit-tested in tests.html.
function debounce(fn, wait) {
  let timer = null;
  const wrapped = function (...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn.apply(this, args); }, wait);
  };
  wrapped.cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  return wrapped;
}

let currentPagePath = null;
let currentPageData = null;
let saveTimer = null;
let saveInFlight = false;   // a savePage() request is awaiting the server
let savePending = false;    // edits arrived mid-save; re-save when it returns
let pageFilter = '';

// Shared-secret token (only used when the backend has CODEMAN_PASSWORD set).
let authToken = null;
try { authToken = localStorage.getItem('codeman.authToken') || null; } catch (e) {}

// One auth prompt at a time, even if several requests 401 at once.
let _authPrompt = null;
function promptAuth() {
  if (_authPrompt) return _authPrompt;
  let inputEl;
  _authPrompt = showModal((box, submit, cancel) => {
    const title = document.createElement('div');
    title.className = 'modal-title';
    title.textContent = 'This CodeMan is password-protected. Enter the password to continue.';
    inputEl = document.createElement('input');
    inputEl.type = 'password';
    inputEl.className = 'modal-input';
    inputEl.placeholder = 'Password';
    const btns = document.createElement('div');
    btns.className = 'modal-btns';
    const c = document.createElement('button');
    c.className = 'secondary'; c.textContent = 'Cancel'; c.onclick = cancel;
    const ok = document.createElement('button');
    ok.textContent = 'Unlock'; ok.onclick = submit;
    btns.append(c, ok);
    box.append(title, inputEl, btns);
    setTimeout(() => inputEl.focus(), 0);
  }, () => (inputEl ? inputEl.value : '')).then(val => {
    _authPrompt = null;
    if (val) { authToken = val; try { localStorage.setItem('codeman.authToken', val); } catch (e) {} return true; }
    return false;
  });
  return _authPrompt;
}

// Clear the stored shared-secret token (sign out). promptAuth re-prompts on the
// next 401, so a stale token self-heals there — this is for explicit/shared-machine
// sign-out and for recovering when you entered the wrong password without a 401 loop.
function signOut() {
  authToken = null;
  try { localStorage.removeItem('codeman.authToken'); } catch (e) {}
  toast('Signed out');
  setTimeout(() => location.reload(), 300); // reload → next request 401s → re-prompt
}

// Network call to the PHP backend. Throws on network failure (used to detect
// that the backend is unreachable so we can fall back to local persistence).
// A 401 means the optional password gate is on: prompt once and retry.
const API_TIMEOUT_MS = 9000; // abort a hung request so the retry/offline path can run

// The request headers every request shares. One attach point so auth, the CSRF
// marker, and the content type can't drift between apiFetch, flushQueue's replay,
// and the keepalive unload-save in editor.js. X-CodeMan-Request is a same-origin
// CSRF signal attached at SEND time — so even queues parked by an older client pick
// it up on replay. api.php ENFORCES it deny-by-default: only the read-only actions in
// its $csrfReadOnly allowlist may run header-less, so any action added later is
// fail-CLOSED. A missing header on a write is a clean 403 (dead-lettered, recoverable),
// and `CODEMAN_CSRF=off` is the break-glass for a straggler-client migration window.
// The desktop proxy requires it on mutating actions too (it always sends it).
function apiHeaders() {
  const h = { 'Content-Type': 'application/json', 'X-CodeMan-Request': '1' };
  if (authToken) h['X-CodeMan-Auth'] = authToken;
  return h;
}

async function apiFetch(action, body, query) {
  const doFetch = () => {
    // Normally relative (UI is served by the NAS). The desktop wrapper bundles the
    // UI locally and sets window.CODEMAN_API_BASE so api() reaches the NAS instead.
    const base = (typeof window !== 'undefined' && window.CODEMAN_API_BASE) || '';
    let url = base + 'api.php?action=' + action;
    if (query) url += '&' + query;
    const opts = { method: body !== undefined ? 'POST' : 'GET', headers: apiHeaders() };
    if (body !== undefined) opts.body = JSON.stringify(body);
    // Time-box the request: a hung fetch (flaky mobile link, slow TLS) aborts and
    // throws so we fail fast instead of spinning. AbortError is a network failure.
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (ctrl) { opts.signal = ctrl.signal; var timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS); }
    return fetch(url, opts).finally(() => { if (ctrl) clearTimeout(timer); });
  };
  let res = await doFetch();
  if (res.status === 401) {
    const entered = await promptAuth();
    if (entered) res = await doFetch();          // retry once with the new token
  }
  if (res.status === 401) {
    // Still 401 after prompting → the entered secret was wrong (or none given).
    // Don't persist a known-bad token; clearing it makes the next request cleanly
    // re-prompt instead of replaying the wrong secret forever.
    authToken = null; try { localStorage.removeItem('codeman.authToken'); } catch (e) {}
    throw new Error('authentication required');
  }
  if (res.status >= 500) throw new Error('backend error ' + res.status);
  // A reachable server that returns a 4xx (or a malformed body) is a *server
  // response*, not "offline" — surface it as an app error so we don't false-trip
  // the offline mirror on, e.g., a 400 with a non-JSON body.
  try {
    return await res.json();
  } catch (e) {
    // We GOT a response, so the server is reachable — a body that won't parse is a
    // server-side bug (e.g. a PHP notice/warning printed before the JSON), NOT a
    // connectivity loss. Surface it as an app error rather than throwing, so api()
    // doesn't false-trip the whole UI offline and a poisoned queued op can't latch
    // offline forever (it drains as a failed op instead of re-tripping flushQueue).
    // Tagged _transient so flushQueue can classify it (retry a few times, then park)
    // WITHOUT string-matching the message — a malformed body is usually a passing
    // server hiccup (a stray PHP notice), not a permanent rejection like a 4xx.
    return { error: 'malformed server response (' + res.status + ')', _transient: true };
  }
}

// Storage layer: try the backend; if it's unreachable, serve reads from the
// IndexedDB cache and queue writes to replay on reconnect (see OFFLINE section).
async function api(action, body, query) {
  try {
    const data = await apiFetch(action, body, query);
    await cacheOnSuccess(action, body, query, data); // keep the local mirror fresh
    if (offlineState) setOffline(false);             // back online → flush queue
    return data;
  } catch (err) {
    setOffline(true);
    return offlineApi(action, body, query);
  }
}

// Mark a button as a menu trigger for assistive tech BEFORE its menu is ever
// opened — without this, a trigger announces as a plain button until first open.
// showMiniMenu then just toggles aria-expanded on it. Apply at trigger creation.
function markMenuTrigger(el) {
  if (!el) return el;
  el.setAttribute('aria-haspopup', 'menu');
  if (!el.hasAttribute('aria-expanded')) el.setAttribute('aria-expanded', 'false');
  return el;
}

function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    // Announce transient feedback (saved / copied / errors) to assistive tech — same
    // polite live channel the offline badge already uses (offline.js). role=status
    // implies aria-live=polite; both set explicitly to match the badge's convention.
    t.setAttribute('role', 'status');
    t.setAttribute('aria-live', 'polite');
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 1900);
}

// Copy text to the clipboard, robust across BOTH secure and INSECURE contexts.
// The async Clipboard API (navigator.clipboard) is UNDEFINED off https/localhost —
// e.g. a NAS served over plain http — so without a fallback Copy silently throws
// there. Try the modern API when available (await + catch rejections), else fall
// back to a hidden-textarea execCommand('copy'). Resolves to whether it succeeded.
async function copyText(text) {
  text = text == null ? '' : String(text);
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try { ta.setSelectionRange(0, text.length); } catch (e) {}
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) { return false; }
}

// A tiny confirmation bubble that pops right next to a control (e.g. the Copy
// button) and fades out — more immediate than the corner toast for an action
// whose source you're looking at. Positioned above the anchor element.
function flashCopied(anchorEl, msg) {
  if (!anchorEl) { toast(msg || 'Copied to clipboard'); return; }
  const pop = document.createElement('div');
  pop.className = 'copy-pop';
  // Announced on the same polite live channel as toast (flashCopied only shows the
  // bubble when it has an anchor; otherwise it falls back to toast — never both, so
  // no double-announce).
  pop.setAttribute('role', 'status');
  pop.setAttribute('aria-live', 'polite');
  pop.textContent = msg || 'Copied to clipboard';
  document.body.appendChild(pop);
  const r = anchorEl.getBoundingClientRect();
  // Center over the anchor, clamped to the viewport. The bubble is translateX(-50%),
  // so clamp by HALF the width on BOTH sides (the right edge was spilling off-screen
  // for buttons near the right edge — notably on mobile and right-aligned toolbars).
  const half = pop.offsetWidth / 2;
  const x = Math.min(window.innerWidth - 8 - half, Math.max(8 + half, r.left + r.width / 2));
  pop.style.left = Math.round(x) + 'px';
  pop.style.top = Math.round(r.top - 6) + 'px';
  // next frame → trigger the fade-in/up transition, then remove
  requestAnimationFrame(() => pop.classList.add('show'));
  setTimeout(() => { pop.classList.remove('show'); setTimeout(() => pop.remove(), 200); }, 1800);
}

/* ---------- MODALS (themed replacements for prompt/confirm) ---------- */

// Pure: the next focus index for a Tab/Shift-Tab cycle within a trap of n
// focusables. Wraps first↔last so focus can't escape the dialog; when the current
// element isn't in the list (i<0) it lands on the first (or last, shift). Extracted
// so it's unit-testable in isolation.
function focusTrapNextIndex(i, n, shift) {
  if (!n) return -1;
  if (i < 0) return shift ? n - 1 : 0;
  return shift ? (i === 0 ? n - 1 : i - 1) : (i === n - 1 ? 0 : i + 1);
}

function showModal(buildBody, onSubmit) {
  // Restore focus on close to whatever launched the modal (the invoker) — captured
  // BEFORE the dialog steals focus.
  const invoker = document.activeElement;
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal';
    // ARIA dialog: modal semantics so assistive tech traps into it and treats the
    // rest of the page as inert. tabIndex=-1 lets us focus the box itself when it
    // holds no focusable controls (the guard below).
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.tabIndex = -1;
    overlay.appendChild(box);

    // Every focusable control currently inside the dialog (visible + enabled).
    const focusables = () => Array.from(box.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )).filter(el => !el.disabled && el.offsetParent !== null);

    function close(value) {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      // Return focus to the invoker if it's still in the document (a re-render could
      // have dropped it — fail soft rather than throw / yank focus to <body>).
      if (invoker && document.contains(invoker) && typeof invoker.focus === 'function') invoker.focus();
      resolve(value);
    }
    function onKey(e) {
      if (e.key === 'Escape') close(null);
      else if (e.key === 'Tab') {
        // Focus trap: cycle Tab / Shift-Tab within the dialog's focusables.
        const f = focusables();
        e.preventDefault();
        if (!f.length) { box.focus(); return; }
        const next = focusTrapNextIndex(f.indexOf(document.activeElement), f.length, e.shiftKey);
        f[next].focus();
      }
      else if (e.key === 'Enter') { e.preventDefault(); submit(); }
    }
    function submit() { close(onSubmit()); }

    overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(null); });
    document.addEventListener('keydown', onKey);

    buildBody(box, submit, () => close(null));
    // Name the dialog from its title (a .modal-title built by buildBody) for a
    // screen reader, else it announces as an unlabeled dialog.
    const titleEl = box.querySelector('.modal-title');
    if (titleEl) {
      if (!titleEl.id) titleEl.id = 'modalTitle_' + Math.random().toString(36).slice(2, 8);
      box.setAttribute('aria-labelledby', titleEl.id);
    }
    document.body.appendChild(overlay);
    // Move focus into the dialog if buildBody didn't already (it often focuses an
    // input/OK via its own setTimeout(0), which registers before this one and so
    // runs first — this only fires when nothing inside grabbed focus).
    setTimeout(() => {
      if (box.contains(document.activeElement)) return;
      const f = focusables();
      (f[0] || box).focus();
    }, 0);
  });
}

// Themed confirm: resolves true/false.
function showConfirm(message, { okLabel = 'Delete', danger = true } = {}) {
  return showModal((box, submit, cancel) => {
    const m = document.createElement('div');
    m.className = 'modal-title';
    m.textContent = message;
    const btns = document.createElement('div');
    btns.className = 'modal-btns';
    const c = document.createElement('button');
    c.className = 'secondary';
    c.textContent = 'Cancel';
    c.onclick = cancel;
    const ok = document.createElement('button');
    ok.textContent = okLabel;
    if (danger) ok.className = 'danger';
    ok.onclick = submit;
    btns.append(c, ok);
    box.append(m, btns);
    setTimeout(() => ok.focus(), 0);
  }, () => true) // submit resolves true; cancel/esc/backdrop resolve null (falsy)
    .then(v => v === true);
}

// Themed acknowledgement: ONE button, no choice to make. For informational modals
// (e.g. "the upload was rejected, here's why") — showConfirm there renders a dead
// "Cancel" beside "OK" that implies an alternative outcome the caller doesn't have.
// Resolves when dismissed (button / Enter / Escape / backdrop) — the caller can't
// branch on it, which is the point.
function showAlert(message, { okLabel = 'OK' } = {}) {
  return showModal((box, submit) => {
    const m = document.createElement('div');
    m.className = 'modal-title';
    m.textContent = message;
    const btns = document.createElement('div');
    btns.className = 'modal-btns';
    const ok = document.createElement('button');
    ok.textContent = okLabel;
    ok.onclick = submit;
    btns.append(ok);
    box.append(m, btns);
    setTimeout(() => ok.focus(), 0);
  }, () => true).then(() => undefined);
}
