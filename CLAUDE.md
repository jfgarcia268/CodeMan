# CodeMan — Project Context & Handoff

Context for contributors and AI coding agents. (Claude Code auto-loads `CLAUDE.md`.)
User-facing install/configuration lives in **[README.md](README.md)**; this file covers
how the codebase is built and the non-obvious decisions behind it.

A self-hosted **code-snippet manager**: browse a folder tree of "pages"; each page holds
collapsible sections/subsections; each section holds code / note / rich-text / checklist
blocks with syntax highlighting, tags, search, trash & history. Plain static files + a
small PHP API. **No build step, no database, no external services.** Works offline, and
optionally as a native desktop app.

```
codeman/          the web app + PHP API (this is what you host)
codeman-desktop/  optional macOS desktop wrapper (Electron)
.github/workflows/codeman-desktop.yml   tag-triggered macOS build → Release
```

> **Maintaining this file:** keep it about the **code** — architecture, data model,
> gotchas, conventions. Anything specific to a *particular* deployment or dataset
> (hostnames, IPs, ports, tokens, private data provenance) must NOT go here; this is a
> public repo. Keep that kind of note private (a private repo, local gitignored file, or
> agent memory).

---

## Stack & files (under `codeman/`)

| File | Role |
|------|------|
| `index.html` | Markup; loads **vendored** Prism (offline) and the 7 ordered `src/*.js` scripts. Cache-busts CSS/JS with a `?v=` query over http(s); on `file://` the query is skipped (Chromium won't resolve `foo.js?v=…` off disk). The stylesheet is a plain `<link>` whose href gets `?v=` appended by JS — **never** `document.write` (that wipes the document under a `file://` load). |
| `src/core.js` | Languages, global state, the `api()` wrapper (offline-aware) + `apiFetch`, toast, themed modals. `apiFetch` builds a relative `api.php?...` URL, or prefixes `window.CODEMAN_API_BASE` if set (the desktop wrapper sets it; in a browser it's unset → relative). |
| `src/tree.js` | Sidebar tree (single column) + Miller columns (double) + drag-to-sort. `effectiveMode()` forces single-column when `body.is-mobile`, without changing the persisted `sidebarMode`. |
| `src/editor.js` | Page tabs, page/section/block editor, language picker, blocks (code/note/rich/checklist), merge/split/reorder, variables, save (conflict-aware). |
| `src/features.js` | Trash & history UI, history diff, favorites + recently-copied, tag manager, command palette, quick-paste block palette, find & replace, export/import, `primeOfflineCache`. |
| `src/ui.js` | Search, layout toggle, column-count slider, expand/collapse, hide/resize sidebar, and `initMobile()` (the `body.is-mobile` flag + off-canvas drawer + backdrop). |
| `src/offline.js` | Local-persistence fallback: IndexedDB mirror + write-queue + sync; offline trash/history. |
| `src/init.js` | Bootstrap IIFE + Service Worker registration (skipped on `file://`/insecure contexts). |
| `sw.js` | **PWA Service Worker** — precaches the app shell so CodeMan boots when the server is unreachable (network-first + cache fallback, `ignoreSearch` so `?v=` URLs hit cache, stable cache keys). `api.php` is deliberately **not** intercepted. Bump `CACHE_VERSION` per release. |
| `manifest.webmanifest` + `icon-maskable.svg` + `favicon.svg` | PWA manifest (installable) + icons. |
| `style.css` | All styling. Palette lives in `:root` **design tokens** (dark-only — light theme was intentionally dropped; don't add a theme toggle). One `@media (max-width:768px)` block at the end makes the UI mobile-responsive (drawer sidebar, always-visible row actions on touch, 16px inputs to stop iOS zoom). |
| `api.php` | Filesystem API: tree, page CRUD, move, reorder, content/block search, metadata index, projects, trash, history, save-conflict detection, find & replace, tag rename, optional password gate. |
| `vendor/prism/` | Vendored Prism (core + autoloader + grammars + theme) — **no CDN**, works offline. Grammars autoload on demand; an unviewed language won't highlight offline until first rendered. |
| `tests.html` | Standalone browser tests: pure helpers + merge/markdown/diff/link/block-search/reorder/`pageToHtml` + offline trash/history reducers (snapshots/restores the real IndexedDB cache, safe to run). Open it in a browser; ~74 assertions. |

**No build step.** The `src/*.js` files are plain classic scripts sharing one global scope;
the load order in `index.html` *is* the dependency order. Edit a file, reload the browser.

⚠️ **Hidden data dirs** (dot-prefixed, skipped by `buildTree`, never web-served):
`.trash/` (soft-deletes + `.meta`), `.history/<page>/<mtime>.json` (last 20 per page),
`.index.json` (metadata cache), `.order.json` (per-folder child order), `.project` (marker).

---

## Data model

- **Folders** mirror real directories. **Each page = one `.json` file.**
- Page JSON:
  ```jsonc
  {
    "title": "MyPage",
    "sections": [
      {
        "title": "Section name",
        "collapsed": false,
        "tags": ["cli", "example"],
        // flat shape. Block optional fields: showLines (line numbers; default ON
        // unless false), varsOn + varValues ({NAME: value}) for the _V_NAME_V_ vars.
        "blocks": [ { "type": "bash", "label": "", "code": "...", "showLines": false } ],
        "subsections": [ /* same section shape, recursive */ ]
      }
    ]
  }
  ```
- **Block kinds** (one per block; `BLOCK_KINDS` in `editor.js`): **code** (highlighted,
  default; `type` = language), **note** (`note:true`, Markdown prose in `code`), **rich**
  (`rich:true`, sanitized WYSIWYG HTML in `code`), **checklist** (`checklist:true`,
  `items:[{text,done}]`). `blockKind()` derives the kind; `convertBlock()` switches a block
  to any other kind carrying text across.
- **Legacy shape:** older sections wrapped content in `tabs:[{name,blocks,subsections}]`.
  The tabs feature was removed, but `sectionContent(section)` transparently reads both
  shapes. **New sections are written flat — don't reintroduce `.tabs`.**
- **Projects** = a root-only folder with a hidden `.project` marker; rendered prominently;
  pinned to the root (can't be nested — guarded client- and server-side).
- **Manual child order** per folder in `.order.json` (array of child names in display
  order); `buildTree` sorts folders-before-pages then by this order. New folders/projects
  are prepended. Drag-to-sort writes it via the `reorder` action.

---

## Persistence

- Data root resolved in `api.php` from **`CODEMAN_DATA`** (env or `$_SERVER`), falling back
  to `codeman/structures/` for local dev. **Keep it outside the web root** in production so
  raw `.json` is never served and never git-tracked.
- **Metadata index** (`<root>/.index.json`): caches each page's `tags`+`langs`, validated by
  mtime (self-heals on external edits, prunes deleted pages). Powers sidebar badges + name/
  tag/lang search without parsing every file. "⟳" button = `rebuild_index`.
- **PHP-FPM gotcha (deployment):** PHP-FPM often runs with `clear_env` on, which strips
  container/process env vars — so `getenv('CODEMAN_DATA')` can come back empty even when the
  var is set in the container's environment. Deliver it via the web server instead (nginx
  `fastcgi_param`, Apache `SetEnv`). `api.php` checks `getenv` then `$_SERVER`.

---

## Features (overview)

**Sidebar / navigation** — folder tree with inline create/rename/delete (editable rows, not
dialogs), drag-and-drop, expand/collapse-all. **Single column** = classic tree; **Double
column** = windowed Finder/Miller columns (footer slider picks 2–4 visible columns, left/
right rails page the window, folder cards show aggregated code-types + top tags + recursive
counts). New folder/page targets the selected folder. Search by name/tags/code-type, with a
**deep-search toggle (⊃)** that also scans page content. Open pages are tabs. Full nav state
persists across reloads.

**Page editor** — clickable folder path; recursive collapsible sections; tags; code blocks
with a language picker (Prism autoload) and per-block line numbers, Edit/Save, Cancel→Revert,
Copy, Duplicate, Delete. The editor is a transparent textarea overlaid on the Prism-highlighted
layer (`.code-stack`) so colors stay visible while typing; **line metrics (`ED_LINE_H` etc.)
are applied INLINE from JS** to the gutter/textarea/view/`pre` so all layers are exactly
N px/line and can't drift (don't rely on `style.css` alone — see gotchas). Per-block **Split**,
**Variables** (`_V_NAME_V_` fill-ins, block- or section-level, mutually exclusive), **Copy as…**
(raw/fenced/escaped/one-line/vars-filled), **⤵ To subsection** / **⤴ Dissolve**, **⛶ Merge**
(unified across blocks + subsections), **⇅ Reorder** (sections + blocks). In-page block filter,
in-page outline, themed confirm modals.

**Notes & links** — Markdown note blocks (`renderMarkdown`, escape-first, no dependency);
cross-page `[[links]]` (`resolvePageLink` matches the tree) and `[text](http…)` external links.

**Data safety** — **Trash** (soft delete, restore/empty), **History** (every save snapshots
the prior content, last 20, restore + diff via `lineDiff`), **save-conflict detection**
(mtime/`baseMtime`; see Collisions below).

**Productivity** — command palette (⌘K; `>` switches to command mode), quick-paste block
palette (⌘⇧K), find & replace across all pages (literal/regex, preview, history-safe), tag
manager (rename/merge/delete, filter), favorites + recently-copied, export (HTML/Markdown/JSON;
self-contained HTML via `pageToHtml`) / import.

**Offline** — `api()` tries the backend; if unreachable, reads serve from an IndexedDB mirror
and writes queue to replay on reconnect (structural writes also mutate the cached tree so the
UI updates live). A bottom-right badge shows offline state + queued count. **Service worker**
precaches the shell for full offline boot. **`primeOfflineCache`** (☁ button) walks the whole
tree to cache every page for offline use. Reconnect is **conflict-aware** (stale-mtime saves
re-sent forced after the server snapshots the concurrent version to history) — never silently
dropped.

### Collisions / concurrency
No live collaboration or auto-merge; conflicts are caught **at save time**, server-side, and
resolved **last-write-wins but recoverable**. `get_page` returns the file mtime; `save_page`
refuses a write whose `baseMtime` is stale (another tab/device/external edit) unless `force`,
and the client prompts overwrite-vs-reload. A `force` overwrite **snapshots the other version
into `.history` first**, so nothing is lost. `flushSave` (tab switch / `beforeunload` / hidden)
forces — the active editor is treated as the source of truth. Conflicts are per **page** (whole
file), not per block. Built for one user across devices, not simultaneous multi-user editing.

---

## Desktop app (`codeman-desktop/`, Electron, macOS)

Wraps the UI so it **opens and works fully offline** without any cert/PWA setup — useful where
HTTPS/Gatekeeper/PWA install are blocked.

- **Architecture (`main.js`):** starts a tiny **localhost HTTP server** inside Electron that
  (a) serves the bundled `codeman/` shell and (b) **proxies `/api.php` server-side** to the
  configured server. The renderer loads `http://127.0.0.1:<port>/` — a real, stable, same-origin
  http context (chosen over `file://`, which is brittle: query-string asset URLs 404 and
  `document.write` wipes the doc). Server-side proxying means **no browser CORS, no mixed-content,
  no cert, no `webSecurity` hacks**, and the UI uses its normal relative `api.php`.
- **Offline:** server unreachable → proxy returns 5xx → `apiFetch` throws → `offline.js`
  IndexedDB layer takes over. The shell is always served locally, so it **cold-boots offline**.
  A **fixed port (`BASE_PORT`)** keeps the origin stable → the IndexedDB cache + write-queue
  persist across launches (an ephemeral port would reset them every launch).
- **Configurable server URL (no rebuild):** resolved as `CODEMAN_NAS_BASE` env > saved
  `settings.json` (in `app.getPath('userData')`) > `config.js` `DEFAULT_SERVER_URL`. First launch
  with nothing configured opens a setup screen (served at `/__settings`) offering **a server URL
  OR offline-only** (`{offlineOnly:true}`); change anytime via the **Server / Offline…** menu.
  `app.setName('CodeMan')` pins the user-data dir so dev and packaged builds share settings.
- **macOS specifics:** unsigned (`identity:null`) ad-hoc build → on download, the quarantine flag
  makes Gatekeeper report it as "damaged"; users clear it with
  `xattr -dr com.apple.quarantine /Applications/CodeMan.app` (see README — the "right-click →
  Open" trick does *not* clear *damaged*). `NSLocalNetworkUsageDescription` is set so the app can
  prompt for Local Network access (needed to reach a LAN server). Real signing/notarization would
  remove these steps but needs a paid Apple Developer account.
- **Performance note:** the proxy resolves the server name per connection; if a `.local` mDNS name
  is slow to resolve on a given network, configure the server by **IP** instead (fast + stable;
  pair with a DHCP reservation).
- **Build:** `cd codeman-desktop && npm install && npm run dist` → `dist/CodeMan-<version>-arm64.dmg`.
  `npm start` runs it in dev. `CODEMAN_SMOKE=1` does a non-interactive boot+reach check.

### CI (`.github/workflows/codeman-desktop.yml`)
Triggers **only** on a version tag (`v*`), on `macos-14` (arm64): `npm ci` → set the app version
from the tag (`v3.2.0` → `3.2.0`) → `npm run dist` → publish the `.dmg` to a GitHub Release.
Unsigned (`CSC_IDENTITY_AUTO_DISCOVERY=false`). Release flow: bump `codeman-desktop/package.json`,
commit, `git tag vX.Y.Z && git push origin vX.Y.Z`. (Heads-up: a repo's very first workflow,
added in the same push as a tag, won't fire for that tag — re-push the tag once.)

---

## Local dev

- Serve `codeman/` with any PHP host. Simplest: `cd codeman && php -S localhost:8090` (data falls
  back to `codeman/structures/`, which is gitignored).
- Run `codeman/tests.html` in a browser for the unit tests.

---

## Gotchas / lessons learned

- **Stale cached JS/CSS** caused repeated "still broken" reports (browser served old modules).
  Fixed via the `?v=Date.now()` cache-bust loader (http(s) only). If you ever see stale behavior,
  a one-time hard reload loads the new `index.html`.
- **`document.write` for the stylesheet wiped the document under Electron's `file://` load**
  (an implicit `document.open()`), and `file://` won't resolve `foo.js?v=…` query URLs — hence
  the localhost-server approach in the desktop wrapper and the `file://`-aware loader in `index.html`.
- **`overflow-y:auto` forces `overflow-x` to compute as `auto`** when the other axis is `visible`
  (CSS spec) — Miller columns scrolled sideways until `overflow-x:hidden` was set explicitly.
- **Scroll after re-render:** set `scrollLeft/scrollTop` in a `setTimeout(…,0)` after layout, not
  in `requestAnimationFrame` (fires before layout settles; also rAF is throttled when not painting).
- **Line-number gutter alignment:** the Prism theme forces `line-height:1.5; padding:1em`, which
  drifts vs. the gutter and grows down the file. Fix: `renderBlock` applies line metrics as
  **inline styles** (`ED_*` constants) on the gutter `.ln`, the textarea, the view, and the Prism
  `pre`/`code`. Inline beats any stylesheet (incl. stale CSS). Change the constants, not just CSS.
- **Toolbar clicks vs. the editor's blur:** the textarea's blur switched the block to `viewing`,
  hiding Save/Revert mid-click. Fixed by bailing the blur handler when `e.relatedTarget` is inside
  the block. Don't `preventDefault()` the toolbar mousedown to "keep focus" — that swallowed clicks.
- **`sectionContent()` is the single read path** for both flat and legacy-tabbed shapes; don't
  assume `section.blocks` exists directly.
- **Persisted nav must survive an empty initial tree:** `sanitizeColumnPath` returns early when
  `!treeData.length`, or setup-time `renderTree()` calls would wipe saved navigation.

---

## Persisted client state

**localStorage:** `codeman.sidebarMode`, `columnPath`, `selectedFolder`, `millerCols`,
`millerColScroll`, `expandedFolders`, `openTabs`, `sidebarWidth`, `sidebarHidden`, `deepSearch`,
`favorites`, `recentCopies`, `authToken` (only when the password gate is on).
**IndexedDB `codeman`:** store `kv` holds `tree`, `queue` (pending writes), `trash` (local
recoverable deletes), `history` (per-page local version log); store `pages` holds cached page
content. **Desktop wrapper:** `settings.json` in the OS user-data dir holds the server URL or
`{offlineOnly:true}`.

---

## Security / safety

- `safeName()` rejects path separators, `..`, and leading `.` for all create/rename names;
  `safePath` confines file access to the data root. `requireFields()` returns clean `{error}`
  JSON instead of leaking PHP warnings.
- **Projects pinned to root:** `move` rejects dropping a `.project` folder into any non-root
  target (also guarded client-side).
- **Optional password gate:** set `CODEMAN_PASSWORD` (env or web-server param) and `api.php`
  requires it on every request via `hash_equals` (`X-CodeMan-Auth` header or `?token=`). **Off by
  default** (open, trusted-LAN assumption). The client prompts once on a 401, stores the token,
  retries. Page data lives outside the web root and is only reachable through `api.php`, so gating
  the API protects the data; serve over HTTPS if exposed beyond a trusted network.

---

## Known limits / non-goals

- **Dark-only.** A light theme was intentionally dropped — don't add a theme toggle.
- **Single-user across devices**, not simultaneous multi-user: conflict-aware + recoverable, but
  effectively last-write-wins with no merge UI.
- Offline `empty_trash` only clears local snapshots (queued deletes still run, so items stay
  recoverable from the server trash after reconnect).
- The desktop build is **macOS/arm64 + unsigned**; an Intel Mac would need a universal target, and
  avoiding the Gatekeeper step needs signing + notarization.
