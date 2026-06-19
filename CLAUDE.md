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
codeman-desktop/  optional desktop wrapper (Electron, macOS + Windows)
.github/workflows/codeman-desktop.yml   tag-triggered macOS + Windows build → Release
docs/images/      README screenshots (generated — see Local dev)
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
| `index.html` | Markup; loads **vendored** Prism + **markdown-it** (offline), then `version.js`, then the 7 ordered `src/*.js` scripts (via the dynamic loader array — `version.js` is first so `CODEMAN_VERSION` exists before the modules run). Cache-busts CSS/JS with a `?v=` query over http(s); on `file://` the query is skipped (Chromium won't resolve `foo.js?v=…` off disk). The stylesheet is a plain `<link>` whose href gets `?v=` appended by JS — **never** `document.write` (that wipes the document under a `file://` load). |
| `version.js` | **Single version source of truth.** `self.CODEMAN_VERSION = 'X.Y.Z'` — read by the footer (`init.js`) and `importScripts`-ed by `sw.js` for the cache name. Bump this one file per release (CI also syncs it from the git tag for the packaged desktop build). |
| `src/core.js` | Languages, global state, the `api()` wrapper (offline-aware) + `apiFetch`, toast, `flashCopied`, the `copyText()` clipboard helper (see gotcha), themed modals. `apiFetch` builds a relative `api.php?...` URL, or prefixes `window.CODEMAN_API_BASE` if non-empty — but it's `''` everywhere today (unset in a browser; the desktop preload sets it to `''` so the renderer keeps using the relative, proxied `api.php`), so the URL is effectively always relative. |
| `src/tree.js` | Sidebar tree (single column) + Miller columns (double, **always exactly 2** — `MILLER_COLS`) + drag-to-sort. `effectiveMode()` forces single-column when `body.is-mobile`, without changing the persisted `sidebarMode` (which **defaults to `double`** on desktop). Project helpers: `pathPrefixes`, `projectChain` (the project-ancestor chain), `isValidProjectParent`; the project-chain banner + color-coded breadcrumb live here. |
| `src/editor.js` | Page tabs, page/section/block editor, language picker, blocks (code/note/rich/checklist), merge/split/reorder, variables, save (conflict-aware). |
| `src/features.js` | Trash & history UI, history diff, favorites + recently-copied, tag manager, command palette, quick-paste block palette, find & replace, export/import, `primeOfflineCache`, `rebuildIndex`, and `openMoreMenu` (the sidebar `⋯` overflow menu, reusing the `.mini-menu` pattern). |
| `src/ui.js` | Search, layout toggle (single/double), expand/collapse, hide/resize sidebar, and `initMobile()` (the `body.is-mobile` flag + off-canvas drawer + backdrop). |
| `src/offline.js` | Local-persistence fallback: IndexedDB mirror + write-queue + sync; offline trash/history. |
| `src/init.js` | Bootstrap IIFE + Service Worker registration (skipped on `file://`/insecure contexts) + sets the footer version label from `CODEMAN_VERSION`. |
| `sw.js` | **PWA Service Worker** — precaches the app shell so CodeMan boots when the server is unreachable (network-first + cache fallback, `ignoreSearch` so `?v=` URLs hit cache, stable cache keys). `api.php` is deliberately **not** intercepted. `CACHE_VERSION` is derived from `version.js` (`importScripts('version.js')`) — bump `version.js`, not this. |
| `manifest.webmanifest` + `icon-maskable.svg` + `favicon.svg` | PWA manifest (installable) + icons. |
| `style.css` | All styling. Palette lives in `:root` **design tokens** (dark-only — light theme was intentionally dropped; don't add a theme toggle). Hidden-sidebar desktop **rail** (`.sidebar-rail`). One `@media (max-width:768px)` block at the end makes the UI mobile-responsive — see the **Mobile** gotchas below (drawer sidebar, always-visible row actions on touch, 16px inputs + viewport zoom-lock, **icon-only block toolbars** with a `⋯` overflow menu, **count-button tag menus**, a compact page header, and an aligned **40px top band**). |
| `api.php` | Filesystem API: tree, page CRUD, move, reorder, content/block search, metadata index, projects, trash, history, save-conflict detection, find & replace, tag rename, optional password gate. |
| `vendor/prism/` | Vendored Prism (core + autoloader + grammars + theme) — **no CDN**, works offline. Grammars autoload on demand; an unviewed language won't highlight offline until first rendered. |
| `vendor/markdown-it/` | Vendored **markdown-it** (v14, single UMD file) — **no CDN**, offline. Backs `renderMarkdown` for **note blocks** (full CommonMark + GFM). Loaded as a static `<script>` before the `src/*.js` modules so `window.markdownit` exists when `editor.js` builds its instance. See the markdown-it gotcha. |
| `tests.html` | Standalone **client** browser tests: pure helpers + merge/markdown/diff/link/block-search/reorder/`pageToHtml` + project helpers (`pathPrefixes`/`projectChain`/`isValidProjectParent`) + `richToPlainText`/`convertBlock` + deep-search cap + offline trash/history reducers (snapshots/restores the real IndexedDB cache, safe to run). Open it in a browser; ~120 assertions, expect `0 failed`. |
| `tests-api.sh` | Standalone **server** API tests (bash + curl, no deps). Spins a throwaway `php -S` against a temp `CODEMAN_DATA` dir and asserts api.php behavior the browser can't reach: path-traversal confinement, parent-dir guards, unicode `search_content`, same-second history retention, `empty_trash` history-prune + its traversal guard, and the password gate. `bash codeman/tests-api.sh` (exit 0 = green). |

**No build step.** The `src/*.js` files are plain classic scripts sharing one global scope;
the load order in `index.html` *is* the dependency order. Edit a file, reload the browser.

⚠️ **Hidden data dirs** (dot-prefixed, skipped by `buildTree`, never web-served):
`.trash/` (soft-deletes + `.meta`), `.history/<page>/<mtime>.json` (last 20 per page),
`.index.json` (metadata cache), `.order.json` (per-folder child order), `.project` (marker),
`.colsort.json` (root-level map of per-column sort prefs for the double layout).

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
- **Projects** = a folder with a hidden `.project` marker; rendered prominently. **Nestable**:
  a project may live at the root or inside **another project**, but **never inside a plain
  folder** — guarded client- and server-side (`isValidProjectParent`, the `move`/`create_project`
  checks). `buildTree` detects the marker at any depth, so nested projects render for free. The
  sidebar shows a clickable **project-chain banner** + a color-coded breadcrumb (project=purple,
  folder=teal).
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
  tag/lang search without parsing every file. "Rebuild index" (in the sidebar `⋯`
  menu) = `rebuild_index`.
- **PHP-FPM gotcha (deployment):** PHP-FPM often runs with `clear_env` on, which strips
  container/process env vars — so `getenv('CODEMAN_DATA')` can come back empty even when the
  var is set in the container's environment. Deliver it via the web server instead (nginx
  `fastcgi_param`, Apache `SetEnv`). `api.php` checks `getenv` then `$_SERVER`.

---

## Features (overview)

**Sidebar / navigation** — folder tree with inline create/rename/delete (editable rows, not
dialogs), drag-and-drop, expand/collapse-all. **Single column** = classic tree; **Double
column** (the desktop default) = windowed Finder/Miller columns showing **exactly 2 columns**
at a time (left/right rails page the window; folder cards show aggregated code-types + top tags
+ recursive counts). New folder/page targets the selected folder. The header is three bands:
brand row (+ `⋯` overflow menu for the utility actions + `⟨` hide), a full-width create group
(`+ Project`/`+ Folder`/`+ Page`), and the search row. Hiding the sidebar collapses it to a slim
**rail** on desktop (a floating hamburger on mobile). Search by name/tags/code-type, with a
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

**Notes & links** — Markdown note blocks rendered by **vendored markdown-it** (full CommonMark +
GFM: tables, strikethrough, task lists, nested lists, autolinks, images) via `renderMarkdown`/
`renderInlineMd` (thin wrappers over a configured `markdownit` instance, `html:false` so raw HTML
stays escaped). Cross-page `[[links]]` (`resolvePageLink` matches the tree, custom inline rule),
GFM task-list checkboxes, and external links open in a new tab — see the markdown-it gotcha.

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
precaches the shell for full offline boot. **`primeOfflineCache`** (in the `⋯` menu) walks the
whole tree to cache every page for offline use. Reconnect is **conflict-aware** (stale-mtime
saves re-sent forced after the server snapshots the concurrent version to history) — never
silently dropped. Offline state is **self-healing and never latches**: `apiFetch` has a request
timeout (`AbortController`) and treats a 4xx as a real server response (not "offline"); when
offline, a backoff `probeBackend()` loop (plus tab-focus and the `online` event) re-probes and
clears the badge once the server is reachable again — important on mobile/self-signed-HTTPS where
a single failed request used to stick the app offline.

### Collisions / concurrency
No live collaboration or auto-merge; conflicts are caught **at save time**, server-side, and
resolved **last-write-wins but recoverable**. `get_page` returns the file mtime; `save_page`
refuses a write whose `baseMtime` is stale (another tab/device/external edit) unless `force`,
and the client prompts overwrite-vs-reload. A `force` overwrite **snapshots the other version
into `.history` first**, so nothing is lost. `flushSave` (tab switch / `beforeunload` / hidden)
forces — the active editor is treated as the source of truth. Conflicts are per **page** (whole
file), not per block. Built for one user across devices, not simultaneous multi-user editing.

---

## Desktop app (`codeman-desktop/`, Electron, macOS + Windows)

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
  with nothing configured opens a setup screen (served at `/__settings`, in the main window)
  offering **a server URL OR offline-only** (`{offlineOnly:true}`). `app.setName('CodeMan')` pins
  the user-data dir so dev and packaged builds share settings.
- **Native Settings (`Cmd+,`)** opens the same `/__settings` HTML in a **dedicated child
  `BrowserWindow`** (the main app stays alive — not the old in-place `loadURL` that wiped it). The
  panel reads live state from **`GET /__status`**, offers a **Test-connection** button (**`POST
  /__test`** = a server-side reachability probe of a *candidate* URL, 5s `AbortController`), and a
  Server/Local toggle. Saving `POST`s to `/__config`, which calls `applySwitch()`.
- **Safe mode switching / data sync** is the core of the settings work. The offline cache +
  write-queue are **namespaced per server** in `offline.js` (see its gotcha), so a queue can
  **never replay against the wrong server** — that's the hard guarantee. On top, `applySwitch()`
  shows **native `dialog.showMessageBox`** prompts when switching with unsynced changes:
  Local→Server with local work = *Push to server* (adopts the local namespace into the server's via
  `window.__codemanAdoptInto`, then flushes) / *Keep on this Mac*; Server→Local or Server A→Server B
  with a queue = *Sync now/first* (`window.__codemanFlush` while the **old** server is still the
  active proxy target) / *Switch anyway* (the queue parks under its own namespace, flushes when you
  return). `main.js` reads the pending count via `window.__codemanQueueLen` before prompting.
- **Renderer learns the active server via `preload.js`** (the only `webPreferences.preload`):
  `ipcRenderer.sendSync('codeman:server-url')` → `window.CODEMAN_SERVER_URL`, set **before any page
  script** so `offline.js` can pick its namespace at module load. `sendSync` (not
  `additionalArguments`) means a post-switch `loadURL` reload re-reads the **live** URL, re-namespacing
  for free. `sandbox:false` (so the preload can `sendSync`), `contextIsolation:true`. `CODEMAN_API_BASE`
  stays `''` — the renderer still uses the relative, proxied `api.php`. Add `preload.js` to
  `package.json` `build.files` or the packaged app ships without it.
- **macOS specifics:** unsigned (`identity:null`) ad-hoc build → on download, the quarantine flag
  makes Gatekeeper report it as "damaged"; users clear it with
  `xattr -dr com.apple.quarantine /Applications/CodeMan.app` (see README — the "right-click →
  Open" trick does *not* clear *damaged*). `NSLocalNetworkUsageDescription` is set so the app can
  prompt for Local Network access (needed to reach a LAN server). Real signing/notarization would
  remove these steps but needs a paid Apple Developer account.
- **Performance note:** the proxy resolves the server name per connection; if a `.local` mDNS name
  is slow to resolve on a given network, configure the server by **IP** instead (fast + stable;
  pair with a DHCP reservation).
- **Build:** `cd codeman-desktop && npm install`, then `npm run dist:mac` (→ **both**
  `dist/CodeMan-<version>-arm64.dmg` + `-x64.dmg`, since there are no native deps the single arm64
  runner repackages both arches) or `npm run dist:win` (→ `dist/CodeMan-<version>.exe`, NSIS, must
  run on Windows). `npm run dist` builds for the host OS. App **icons** live in
  `codeman-desktop/build/` (`icon.icns` for mac, `icon.ico` for win) — both generated from
  `codeman/icon-maskable.svg` and committed; CI just consumes them. Targets/arches + `artifactName`
  are in `package.json` `build` (`mac.target` = dmg×[arm64,x64], `win.target` = nsis×x64).
  `npm start` runs it in dev. `CODEMAN_SMOKE=1` does a non-interactive boot+reach check.

### CI (`.github/workflows/codeman-desktop.yml`)
Triggers **only** on a version tag (`v*`). An **OS matrix** builds all three artifacts and
publishes them to one GitHub Release: `macos-14` runs `npm run dist:mac` → arm64 + x64 `.dmg`;
`windows-latest` runs `npm run dist:win` → the NSIS `.exe`. Both legs: `npm ci` → set the app
version from the tag (`v3.2.0` → `3.2.0`, and `sed` the same version into `codeman/version.js` for
the bundled shell — the version-sync step is `shell: bash` so `sed` works on the Windows runner's
git-bash) → build → `softprops/action-gh-release` uploads the per-platform glob (`*.dmg` / `*.exe`)
to the tag's Release (created once, files appended). Unsigned (`CSC_IDENTITY_AUTO_DISCOVERY=false`)
— macOS needs the `xattr` clear, Windows shows a SmartScreen prompt. Release flow: **(1)** promote
`CHANGELOG.md`'s `## [Unreleased]` block to a dated `## [X.Y.Z]` heading (see **Release notes**
below); **(2)** bump **both** `codeman/version.js` (drives the web footer + SW cache for the
git-synced web/NAS deployment) and `codeman-desktop/package.json`; **(3)** commit, `git tag vX.Y.Z
&& git push origin vX.Y.Z`. (Heads-up: a repo's very first workflow, added in the same push as a
tag, won't fire for that tag — re-push the tag once.)

**Release notes** live in `CHANGELOG.md` at the repo root in [Keep a Changelog](https://keepachangelog.com)
format: keep an `## [Unreleased]` section and append to it (grouped `Added` / `Changed` / `Fixed` /
`Security`) **as each change lands** — same "update in the same change" discipline as
`docs/TEST_CASES.md`. At release, rename it to `## [X.Y.Z] — YYYY-MM-DD`; section headings track the
`vX.Y.Z` semver tags. The **tag-triggered GitHub Release** (published by the workflow above) is the
user-facing copy — paste that version's section into the Release body, or extend the workflow to
extract it (`softprops/action-gh-release` `body_path`). Keep the changelog about **user-visible**
changes; `CLAUDE.md` stays the code/architecture reference, `docs/TEST_CASES.md` the QA matrix.

---

## Local dev

- Serve `codeman/` with any PHP host. Simplest: `cd codeman && php -S localhost:8090` (data falls
  back to `codeman/structures/`, which is gitignored).
- **Testing.** Two automated suites: open `codeman/tests.html` in a browser (client units, expect
  `0 failed`) and run `bash codeman/tests-api.sh` (server API, exit 0). The **full set of regression
  test cases lives in [docs/TEST_CASES.md](docs/TEST_CASES.md)**, split into a **Core** tier (run every
  regression) and an **Extended/release-gate** tier (cross-browser, packaged/Windows builds, CI,
  real-device, perf-at-scale, desktop native dialogs — run on demand). **Full regression is run by the
  [senior-qa-engineer](.claude/agents/senior-qa-engineer.md) agent** against that matrix; usability
  passes by [ui-ux-reviewer](.claude/agents/ui-ux-reviewer.md). **When you add or change behavior,
  update `docs/TEST_CASES.md` (and the suites) in the same change** — a fix without a case there is an
  untested fix.
- **README screenshots** live in `docs/images/` and are referenced by `README.md`. Regenerate
  them against a **throwaway generic dataset** — point `CODEMAN_DATA` at a temp dir, seed
  vendor-neutral demo pages, and serve that on a spare port; **never** screenshot real/private
  data (the local `structures/` is work data). The desktop setup/settings shots come from
  Electron launched with a temp `--user-data-dir` (so the real `settings.json` is untouched) —
  its `/__settings` panel is served on `BASE_PORT` (47615) and renders the "Set up" vs
  "Settings" variant from `/__status`. Capturing via a headless browser (e.g. puppeteer-core
  driving the installed Chrome) yields crisp retina PNGs straight to disk.

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
- **Note views must NOT get the inline editor metrics.** Code and note blocks share the
  `.code-view` element, but only CODE needs the inline `ED_*` font/line-height/padding (so the
  colored layer lines up row-for-row with the textarea + gutter). A note renders **Markdown prose**,
  so `renderBlock` applies those inline styles to the view **only when `!block.note`** — otherwise
  the monospace/edFont/edLineH/ED_PAD override `.block.note .code-view`'s prose styling and the
  Markdown renders cramped + code-like (lists hugging the box edge). The note's **textarea** still
  gets the metrics (keeps editing at 16px / no iOS focus-zoom). Don't reintroduce the inline metrics
  on note views to "align" them with anything — the note gutter is hidden and the editor is separate.
- **Toolbar clicks vs. the editor's blur:** the textarea's blur switched the block to `viewing`,
  hiding Save/Revert mid-click. Fixed by bailing the blur handler when `e.relatedTarget` is inside
  the block. Don't `preventDefault()` the toolbar mousedown to "keep focus" — that swallowed clicks.
- **`sectionContent()` is the single read path** for both flat and legacy-tabbed shapes; don't
  assume `section.blocks` exists directly.
- **Persisted nav must survive an empty initial tree:** `sanitizeColumnPath` returns early when
  `!treeData.length`, or setup-time `renderTree()` calls would wipe saved navigation.
- **Version is single-sourced in `version.js`.** It's a classic script (`self.CODEMAN_VERSION`)
  loaded first in `index.html` AND `importScripts`-ed by `sw.js` — so it works in both the window
  and the worker scope. Don't hardcode the version in the footer or `sw.js`; bump `version.js`.
- **Hidden-sidebar rail vs. mobile hamburger:** desktop hides → a real `.sidebar-rail` flex child
  (occupies width, content flows beside it). On mobile the rail is `display:contents` so the same
  `#showSidebarBtn` floats as a hamburger over the drawer. Don't reintroduce the old
  `position:fixed` button + `padding-left` banner hacks.
- **Project nesting is a contiguous prefix:** because a project can only sit in a project/root,
  the project ancestors of any path form a prefix from the root — `projectChain()` relies on this.
  Guard all create/move/reorder paths with `isValidProjectParent` (server mirrors it in
  `create_project`/`move`); don't add a new path that bypasses it.
- **The code-block `⋯` overflow menu now declutters BOTH desktop and mobile** (was mobile-only
  before the UI/UX pass). The secondary actions — `#` lines / `$` vars / Duplicate / Split /
  `⤵ To subsection` / block-kind `.type-menu` / copy-as `.copy-as` — are hidden by **unconditional**
  `.block-toolbar` rules (not `body.is-mobile`-gated anymore) and folded into `.block-overflow`,
  which is `display:inline-flex` on every width. They stay in the DOM so the menu **proxies them via
  `.click()`** (copy-as is rebuilt as items — its popup anchors to its own rect, invalid while
  hidden). Primary row = `type-picker · label · Edit/Save/Revert · Copy · ⋯ · Delete` (Copy is
  labelled "Copy", `title="Copy to clipboard"`). `renderBlock` still reads
  `isMobile = body.classList.contains('is-mobile')` for the **icon swaps** (Edit→`✎`, Save→`✓`,
  Copy→`⧉`, Delete→`✕`) and label-on-own-row; the open page re-renders on the 768px flip
  (`initMobile` calls `renderPage()`), so toolbars reflow without a reload. The `⋯` menu groups
  (`showMiniMenu`, `{divider:true}`→`.mini-menu-sep`): direct actions · `BLOCK_KINDS` convert ·
  copy-as. **Desktop is no longer byte-identical** — that was an intentional declutter.
- **ALL block kinds get the icon toolbar (not just code/note).** `renderChecklistBlock` and
  `renderRichBlock` mirror the same mobile treatment: Edit→`✎`/Save→`✓` (rich), Copy→`⧉`, Delete→`✕`,
  label on its own row, and a `.block-overflow` (`⋯`) that folds Duplicate + the block-kind convert
  (and Clear-done for checklists) — necessary because the generic (now **unconditional**, not just
  `body.is-mobile`) `.block-toolbar .type-menu/.block-dup/.block-clear { display:none }` rules strip
  those buttons, so without a `⋯` they'd be unreachable. Rich's convert syncs `surface.innerHTML`
  into `block.code` first. Shared marker classes (`.block-copy`/`.block-dup`/`.block-clear`) drive
  the CSS hide + icon sizing.
- **Sidebar tree is keyboard-operable + ARIA (a11y pass).** `#tree` is `role="tree"`; rows
  (`.tree-row`) and Miller folder cards (`.subfolder-card`) are `role="treeitem"` with a
  `data-path`, `aria-label`, roving `tabindex` (exactly one row is `tabindex=0` via
  `initRovingTabindex`, called at the end of `renderTree`), folders carry `aria-expanded`. One
  delegated `keydown` on `#tree` (`onTreeKeydown`, bound once via `bindTreeKeys`): Enter/Space
  activate any row in BOTH layouts (`activateTreeItem` clicks then restores focus by `data-path`,
  since folder activation re-renders via `selectFolder`); single-column also gets Up/Down/Home/End +
  Left/Right expand-collapse/parent. It bails when `e.target` is an INPUT (don't hijack inline
  rename/create). A global `:focus-visible` ring lives near the base `button{}` rule.
- **Delete buttons are de-emphasized at rest.** `button.danger` is neutral (`#3a3d41` / dim-red
  text) until `:hover`/`:focus-visible` (then full red). The empty page is an **onboarding** state
  (`.empty-state.onboard`: + New Project / + New Page CTAs, ⌘K hint, "Open the sidebar" nudge when
  `body.sidebar-hidden`). Inline create (`buildPendingRow`) has visible `✓`/`✕`; **blur now cancels**
  (was auto-commit) — the `✓`/`✕` `mousedown`-preventDefault so their click lands before blur.
- **Copy uses `copyText()` (core.js), never a bare `navigator.clipboard`.** `navigator.clipboard`
  is **`undefined` in insecure contexts** (a NAS served over plain `http://…`), so a direct
  `writeText` throws there → Copy silently fails with no feedback (it only "worked" on localhost /
  the desktop app / HTTPS). `copyText(text)` uses the async Clipboard API when `window.isSecureContext`,
  else falls back to a hidden-textarea `document.execCommand('copy')`, and resolves a success
  boolean. **All** copy sites (code/note/rich/checklist blocks, both copy-as menus, recently-copied,
  quick-paste) route through it and then show a `flashCopied` bubble / `toast` — "Copied…" on success,
  "Copy failed" otherwise (~1.8s; `flashCopied` clamps by half-width on BOTH edges so it never spills
  off-screen). Don't reintroduce a direct `navigator.clipboard.writeText`.
- **The global `:focus-visible` ring is deliberately excluded from the code editor.** `.code-edit`
  (the transparent overlay textarea) keeps `outline:none` even on focus — the ring's specificity
  otherwise drew a stray blue box around the code while editing; the block's editing state (border +
  Save/Cancel) is the focus affordance. The code textarea also sets `spellcheck=false` +
  `data-gramm`/`data-gramm_editor`/`data-enable-grammarly="false"` + `autocorrect/autocapitalize/
  autocomplete="off"` so the browser AND extensions (Grammarly) stop drawing squiggle/underline
  overlays on code. `.section-header` is `align-items:flex-start` so the title/actions don't float
  mid-height beside a tall multi-row tag block.
- **Tag-mutating actions must refresh open tabs.** `applyRename` (tag manager rename/merge/delete)
  re-fetches every open page after the server write (`get_page` → reset `tab.data`/`tab.baseMtime`,
  re-render the active page), mirroring what Find & Replace's replace-all already does — otherwise an
  open tab's stale in-memory `currentPageData` would silently re-save the OLD tag on the next autosave.
  Any new bulk server-side mutation of page content needs the same open-tab reconciliation.
- **`tests.html` seeds via the namespaced wrappers.** Since `offline.js` keys IndexedDB per server,
  the offline-reducer tests must seed/read/snapshot/restore through `kvGet/kvSet/kvDel` +
  `pageGet/pageSet/pageDel` (NOT raw `idbGet/idbSet('kv'|'pages', …)`), or they'd miss the active
  namespace AND fail to restore the real cache. Keep that contract when adding offline tests.
- **iOS home-screen PWA top inset:** `body.is-mobile .main` gets `padding-top:env(safe-area-inset-top)`
  + a `#1b1b1b` background (the tab-bar colour) so the tab bar/header clear the Dynamic Island in
  standalone mode (status bar is `black-translucent`, `viewport-fit=cover`). The floating ☰ is
  already inset-offset, so padding `.main` doesn't double-shift it. `env()` is 0 on non-notched
  devices. The header uses **normal 14px side padding** (the ☰ clearance lives on `.main-tabs`,
  which is what the ☰ overlaps — the header sits below it, so no 56px indent).
- **Compact mobile page header = title + `⋯` + `+ Section` only.** `renderPageBody` builds all
  seven action buttons as today, but on mobile only `+ Section` and a new `.page-header-more`
  (`⋯`) show; the other six (Outline, Collapse-all, the `.fav-star`, History, Export, Reorder)
  carry a `.page-act-demote` class that's `display:none` under `body.is-mobile` and are folded
  into the `⋯`'s `showMiniMenu` (state re-read on each open). Menu items **proxy the real buttons
  via `.click()`** (no duplication); **Export is the exception** — `exportMenu(anchor)` anchors a
  submenu to its arg, so it's passed `headerMoreBtn` (a hidden `exportBtn` would open at 0,0).
  `.page-header-more` is `display:none` off-mobile → **desktop keeps the full 7-button row**. CSS
  puts the title + action cluster on one row (`margin-left:auto`), breadcrumb ellipsizes, filter
  is its own slim row — no ragged wrap, no empty gap.
- **Mobile is zoom-locked + the code editor renders at 16px.** The viewport meta has
  `maximum-scale=1, user-scalable=no` (kills pinch-zoom AND iOS focus-zoom — an intentional a11y
  tradeoff). Belt-and-suspenders for the focus case: `renderBlock` reads `isMobile` and picks
  `edFont = isMobile ? 16 : ED_FONT_SIZE` / `edLineH = isMobile ? 24 : ED_LINE_H`, then **every**
  editor layer (gutter, `.ln`, textarea, view, `pre`, `code`) uses those locals — so the textarea
  is ≥16px (no focus-zoom, more readable) AND all layers share one metric so the transparent
  textarea stays pixel-aligned with the Prism overlay (the gutter gotcha above). Desktop →
  locals equal 13/19, byte-identical. `pageToHtml` export doesn't use `ED_*`, so it's unaffected.
- **Mobile tab strip scrolls horizontally.** `body.is-mobile .main-tabs` is `flex-wrap:nowrap;
  overflow-x:auto` (scrollbar hidden) so tabs never wrap; `.main-tab` is `flex-shrink:0;
  max-width:160px`, and `.main-tab-closeall` is `position:sticky; right:0` so "Close all" stays
  pinned at the right edge instead of wrapping onto its own line above the page. Desktop keeps
  `flex-wrap:wrap`.
- **The in-page Outline overlay is dismissible on mobile.** `.outline-head` carries an
  `.outline-close` ✕ (click → `toggleOutline`), and `initMobile` appends an `.outline-backdrop`
  (tap-outside → close), mirroring the sidebar drawer's `.drawer-backdrop`. The backdrop is driven
  by a `body.outline-open` class set in `toggleOutline`/`buildPageOutline` (the outline lives deep
  in `.main`, not a body sibling). Both ✕ and backdrop are `display:none` off-mobile → desktop rail
  unchanged.
- **Mobile section header = one row: `▼ Title  🏷N  ⛶  $ ⤴ ✕`.** On mobile (`isMobile` checked
  in `renderSection`), section tags collapse into a `.section-tags-btn` (`🏷 N` count) that opens a
  `showMiniMenu` picklist (each tag with ✕ + an Add-tag item) instead of the wrapping chip row, and
  the per-section merge bar is **relocated** out of the section body (`panel`) up onto the header
  row via `panel.querySelector(':scope > .merge-bar')` + append (its start button shortened to just
  `⛶`). Merge still works because its `target` (the panel) is captured in the closure — only the
  controls move. Tag add/remove logic is shared via `removeTag`/`addTagFlow` (factored out of
  `renderTags`). Desktop keeps inline chips + the body merge bar (the whole branch is `is-mobile`-gated).
- **Mobile renames icons to save space.** On mobile every red Delete button (all four `delBtn` sites:
  `renderBlock`/`renderChecklistBlock`/`renderRichBlock`/`renderSection`) becomes a red `✕`
  (`title="Delete"`, keeps `danger`), and the per-section Merge button is just `⛶` (`title="Merge"`).
  Desktop keeps the full text ("Delete", "⛶ Merge"). Gated by each function's `isMobile` flag.
  All mobile icon buttons share a uniform **34×32 square** footprint — the block toolbar icons
  (`✎ ⧉ ⋯ ✕`, the `.danger` delete included) AND the section-header icons (`$ ⛶ ✕`) — so a
  section/subsection delete `✕` is exactly the same size as a block's delete `✕` (the `🏷 N` tag
  button keeps its text width).
- **One 40px top band (desktop + mobile).** `.main-tabs` is `min-height:40px; box-sizing:border-box`
  and `.brand-row` is `min-height:40px` with `.sidebar-header` top padding dropped — so the sidebar
  brand row, the tab strip, and the `☰` toggle all share an aligned 40px band. Desktop hidden ☰
  (32px, rail `padding-top:8px`) bottom-aligns at y40; the mobile ☰ is **30px centered** in the 40px
  band (`top:calc(5px+safe-area); left:calc(10px+…); 30×30`) so it has even margins on all sides;
  `body.is-mobile .main-tabs` is `min-height:40px; align-items:center`. This intentionally changed
  desktop (tab band ~34→40px). The `☰` is **drawn as three CSS bars** (`#showSidebarBtn::before` +
  `box-shadow`, glyph hidden via `color:transparent`), not the `☰` font glyph — whose ink sits high
  in the em box, so font-centering never looked centered. The CSS bars are pixel-centered at any size.
- **Per-column sort (double layout) sorts client-side, persists server-side.** Each Miller column
  has a `.miller-col-head` with a `⇅` sort button (`buildColSortMenu`) offering Name/Code-type/Kind ×
  asc/desc + "Manual order". The choice is stored on the server in a single root-level `.colsort.json`
  (`{ "<folderRelPath>": {field,dir} }`, ""=root) via the `set_col_sort` action, and fetched alongside
  the tree by `loadTree` (`col_sorts` action → `colSort` map). **`buildTree` is deliberately untouched** —
  the actual ordering is done in `renderMillerColumn` via the pure `sortMillerChildren(children, pref)`
  (so it works offline against the cached tree, and the array-shaped `tree` response stays intact for
  `offline.js`). An active sort renders a **flat, intermixed** list (no folders/pages `.miller-divider`);
  no pref = today's folders-first + divider + `.order.json` order. **Dragging an item (`dropReorder`)
  clears the column's sort** (drag = "I want manual order"). Single-column layout is unaffected.
- **Note Markdown is rendered by vendored markdown-it, not a hand-rolled parser.** `renderMarkdown(src)`
  = `MD.render(src)` and `renderInlineMd(t)` = `MD.renderInline(t)` over one module-scope instance
  `MD = markdownit({ html:false, linkify:true, breaks:true })` in `editor.js`. **`html:false` is the
  security boundary** — raw HTML in note source is escaped, same posture as the old escape-first
  renderer; don't enable `html`. Three custom rules layer CodeMan behavior on top: a `[[wiki]]` inline
  rule that emits the **exact** `<a class="xlink" data-xtarget>` / broken-span markup the note-view
  click wiring expects (`editor.js` `wireNoteLinks`); a GFM **task-list** core rule (`- [ ]`/`- [x]`
  → disabled checkbox, `li.md-task`); and a `link_open` override adding `target/rel` to external
  `http(s)` links (leaves wiki `.xlink` alone). markdown-it emits **plain tags** (no `.md-*` classes),
  so all note CSS is scoped under `.block.note .code-view <tag>` (and mirrored into `pageToHtml`'s
  embedded export CSS). The vendored file is in the SW precache + a static `<script>` in `index.html`
  (before the modules). Strikethrough renders as `<s>`, not `<del>`.
- **Block editors auto-size to content while editing, capped to the viewport, with a resize handle.**
  All three editable kinds bound the *editing surface* (view mode is unbounded — long content reads
  fully). The cap is **60vh desktop/desktop-app, 50dvh mobile** (CSS + JS `editorCapPx()`); editors
  scroll past it. **Note** (`<textarea>`): `autosizeNote()` sets height to content (`scrollHeight`),
  `resize:vertical` handle, a manual drag records a `userMin` floor the autosizer respects. **Rich**
  (`contentEditable`): grows natively; CSS adds `max-height`/`overflow:auto`/`resize:vertical` while
  editing. **Code** is the subtle one: the transparent textarea overlays the Prism `.code-view`, and
  the editor **height is JS-driven** (`autosizeCode()` sets `.code-wrap` height = min(content, cap) or
  a dragged `userCodeH`) — **independent of the line-number gutter** (a CSS-only approach collapsed
  when line numbers were off, since the gutter was the only in-flow sizer). While editing, `.code-view`
  goes `position:absolute; inset:0` (overlay) and **the textarea `.code-edit` is the single scroller**
  (overflow:auto); `syncScroll` mirrors its `scrollTop` onto `.code-view` + `.line-gutter` (both
  `overflow:hidden`) so all layers stay aligned. `.code-wrap` (`align-items:stretch`) never itself
  scrolls. The slate edit background (`#303841`) is **not** gated on `.show-lines` (so it's consistent
  with line numbers on or off). A debounced `window`/`visualViewport` resize listener re-fits open
  editors; the dragged height + autosize state reset on Save/Cancel. Don't reintroduce a CSS-only code
  cap — the gutter-independence requires the JS height.
- **Deep (content) search renders a capped result set.** `runDeepSearch` (ui.js) keeps the full
  match count in `deepMatchTotal` but slices `deepMatches` to `DEEP_MATCH_CAP` (200, tree.js) — a
  broad term on a large library would otherwise paint thousands of sidebar rows synchronously (~1.5s
  at 1200 pages). `updateSearchCapNote` (tree.js, called from `renderTree`) shows the
  `#searchCapNote` "Showing first N of M — refine your search" banner when capped, hidden otherwise.
  It's a render cap, not a server cap (search_content still scans everything) — don't remove it.
- **`openPage` dedups concurrent/rapid opens.** It's async (awaits `get_page`), so a rapid
  double-click or N calls in one tick would each pass the "already open?" check before any push and
  create duplicate tabs. An in-flight `_openingPages` Map (editor.js) makes concurrent opens of the
  same path reuse one fetch/tab. Don't drop it.

---

## Persisted client state

**localStorage:** `codeman.sidebarMode` (defaults to `double`), `columnPath`, `selectedFolder`,
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
  JSON instead of leaking PHP warnings. **`empty_trash` runs the stored (raw, client-supplied)
  `origPath` through `safePath($historyDir, …)` before `rrmdir`-ing the history subtree** — without
  it a `../`-bearing `origPath` could escape `.history`. Any new path built from a stored/echoed
  value must be `safePath`'d the same way.
- **Projects nest only in projects:** `create_project` and `move` reject placing a `.project`
  folder anywhere except the root or inside another project (a parent with its own `.project`
  marker) — also guarded client-side via `isValidProjectParent`.
- **Optional password gate:** set `CODEMAN_PASSWORD` (env or web-server param) and `api.php`
  requires it on every request via `hash_equals` (`X-CodeMan-Auth` header or `?token=`). **Off by
  default** (open, trusted-LAN assumption). The client prompts once on a 401, stores the token,
  retries. Page data lives outside the web root and is only reachable through `api.php`, so gating
  the API protects the data; serve over HTTPS if exposed beyond a trusted network. **A wrong secret
  is NOT persisted** — if the retry after the prompt still 401s, `apiFetch` clears the bad token so
  the next request cleanly re-prompts; a 401 is treated as a server response, never "offline". A
  **`signOut()`** (the *Forget password* item in the sidebar `⋯` menu, `openMoreMenu`, shown only
  when `authToken` is set) clears the stored token + reloads.

---

## Known limits / non-goals

- **Dark-only.** A light theme was intentionally dropped — don't add a theme toggle.
- **Single-user across devices**, not simultaneous multi-user: conflict-aware + recoverable, but
  effectively last-write-wins with no merge UI.
- Offline `empty_trash` only clears local snapshots (queued deletes still run, so items stay
  recoverable from the server trash after reconnect).
- The desktop build ships **macOS (arm64 + x64 dmgs) + Windows (x64 NSIS exe)**, all **unsigned**;
  avoiding the macOS Gatekeeper step needs Developer ID signing + notarization, and avoiding the
  Windows SmartScreen prompt needs a code-signing certificate. No Linux target.
