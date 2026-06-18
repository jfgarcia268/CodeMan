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

// Network call to the PHP backend. Throws on network failure (used to detect
// that the backend is unreachable so we can fall back to local persistence).
// A 401 means the optional password gate is on: prompt once and retry.
const API_TIMEOUT_MS = 9000; // abort a hung request so the retry/offline path can run

async function apiFetch(action, body, query) {
  const doFetch = () => {
    // Normally relative (UI is served by the NAS). The desktop wrapper bundles the
    // UI locally and sets window.CODEMAN_API_BASE so api() reaches the NAS instead.
    const base = (typeof window !== 'undefined' && window.CODEMAN_API_BASE) || '';
    let url = base + 'api.php?action=' + action;
    if (query) url += '&' + query;
    const opts = { method: body !== undefined ? 'POST' : 'GET', headers: {} };
    if (authToken) opts.headers['X-CodeMan-Auth'] = authToken;
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
  if (res.status === 401) throw new Error('authentication required');
  if (res.status >= 500) throw new Error('backend error ' + res.status);
  // A reachable server that returns a 4xx (or a malformed body) is a *server
  // response*, not "offline" — surface it as an app error so we don't false-trip
  // the offline mirror on, e.g., a 400 with a non-JSON body.
  try {
    return await res.json();
  } catch (e) {
    if (!res.ok) return { error: 'request failed (' + res.status + ')' };
    throw e;
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

function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
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

function showModal(buildBody, onSubmit) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal';
    overlay.appendChild(box);

    function close(value) {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    }
    function onKey(e) {
      if (e.key === 'Escape') close(null);
      else if (e.key === 'Enter') { e.preventDefault(); submit(); }
    }
    function submit() { close(onSubmit()); }

    overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(null); });
    document.addEventListener('keydown', onKey);

    buildBody(box, submit, () => close(null));
    document.body.appendChild(overlay);
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
