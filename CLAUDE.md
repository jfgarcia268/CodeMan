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
| `index.html` | Markup; loads **vendored** Prism (offline), then `version.js`, then the 7 ordered `src/*.js` scripts (via the dynamic loader array — `version.js` is first so `CODEMAN_VERSION` exists before the modules run). Cache-busts CSS/JS with a `?v=` query over http(s); on `file://` the query is skipped (Chromium won't resolve `foo.js?v=…` off disk). The stylesheet is a plain `<link>` whose href gets `?v=` appended by JS — **never** `document.write` (that wipes the document under a `file://` load). |
| `version.js` | **Single version source of truth.** `self.CODEMAN_VERSION = 'X.Y.Z'` — read by the footer (`init.js`) and `importScripts`-ed by `sw.js` for the cache name. Bump this one file per release (CI also syncs it from the git tag for the packaged desktop build). |
| `src/core.js` | Languages, global state, the `api()` wrapper (offline-aware) + `apiFetch`, toast, themed modals. `apiFetch` builds a relative `api.php?...` URL, or prefixes `window.CODEMAN_API_BASE` if set (the desktop wrapper sets it; in a browser it's unset → relative). |
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
| `tests.html` | Standalone browser tests: pure helpers + merge/markdown/diff/link/block-search/reorder/`pageToHtml` + project helpers (`pathPrefixes`/`projectChain`/`isValidProjectParent`) + offline trash/history reducers (snapshots/restores the real IndexedDB cache, safe to run). Open it in a browser; ~82 assertions. |

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
from the tag (`v3.2.0` → `3.2.0`, and `sed` the same version into `codeman/version.js` for the
bundled shell) → `npm run dist` → publish the `.dmg` to a GitHub Release.
Unsigned (`CSC_IDENTITY_AUTO_DISCOVERY=false`). Release flow: bump **both** `codeman/version.js`
(drives the web footer + SW cache for the git-synced web/NAS deployment) and
`codeman-desktop/package.json`, commit, `git tag vX.Y.Z && git push origin vX.Y.Z`. (Heads-up: a
repo's very first workflow, added in the same push as a tag, won't fire for that tag — re-push the
tag once.)

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
- **Mobile code-block toolbar is icon-only with ONE merged `⋯` menu.** `renderBlock` reads
  `isMobile = body.classList.contains('is-mobile')` at render time (blocks re-render on demand;
  the matchMedia listener re-renders on the 768px flip) and swaps Edit→`✎`, Save→`✓`,
  Copy→`⧉` (keeping `title=` for a11y; Delete stays red text, Revert is owned by
  `refreshRevertLabel`). The `.block-overflow` (`⋯`) opens `showMiniMenu` with three groups
  separated by `{divider:true}` (rendered as `.mini-menu-sep`): (1) direct actions `#` lines /
  `$` vars / Duplicate / Split / `⤵ To subsection` — these stay in the DOM, `display:none` under
  `body.is-mobile`, and the menu **proxies them via `.click()`** (no handler duplication);
  (2) the block-kind convert list (`BLOCK_KINDS`), folding away the desktop `Code ▾` `.type-menu`;
  (3) Copy-as formats via the shared `copyAsOptions()` helper, folding away the desktop `▾`
  `.copy-as`. Copy-as is **rebuilt as items** (not proxied) because its own popup anchors to its
  button rect, invalid while hidden. CSS also drops the `.block-label` to its own full-width row.
  Everything is `body.is-mobile`/media-gated and `⋯` is `display:none` off-mobile → **desktop is
  byte-identical** (full text toolbar, both `Code ▾` and `▾`).
- **ALL block kinds get the icon toolbar (not just code/note).** `renderChecklistBlock` and
  `renderRichBlock` mirror the same mobile treatment: Edit→`✎`/Save→`✓` (rich), Copy→`⧉`, Delete→`✕`,
  label on its own row, and a `.block-overflow` (`⋯`) that folds Duplicate + the block-kind convert
  (and Clear-done for checklists) — necessary because the generic `body.is-mobile .block-toolbar
  .type-menu/.block-dup/.block-clear { display:none }` rules already strip those buttons, so without
  a `⋯` they'd be unreachable. Rich's convert syncs `surface.innerHTML` into `block.code` first.
  Shared marker classes (`.block-copy`/`.block-dup`/`.block-clear`) drive the CSS hide + icon sizing.
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
  JSON instead of leaking PHP warnings.
- **Projects nest only in projects:** `create_project` and `move` reject placing a `.project`
  folder anywhere except the root or inside another project (a parent with its own `.project`
  marker) — also guarded client-side via `isValidProjectParent`.
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
