# CodeMan — Project Context & Handoff

Context for contributors and AI coding agents. (Claude Code auto-loads `CLAUDE.md`.)
User-facing install/configuration lives in **[README.md](README.md)**; this file covers
how the codebase is built and the non-obvious decisions behind it.

### Project commands — toggle the Graphify hooks

Two project slash commands let me force the agent to do a **raw read of the codebase**
(grep/read/glob) instead of consulting the graphify knowledge graph, and switch back:

| Command | What it does |
|---------|--------------|
| **`/graphify-off`** | Runs `python3 .claude/toggle_graphify.py disable` — renames `PreToolUse` → `_PreToolUse_disabled` in [.claude/settings.json](.claude/settings.json), turning the `graphify hook-guard` PreToolUse hooks OFF. The agent then explores with raw reads/greps, not `graphify query`. |
| **`/graphify-on`** | Runs `python3 .claude/toggle_graphify.py enable` — renames it back, restoring the graph-first workflow. |

The commands live in [.claude/commands/](.claude/commands/) and both wrap the single
toggle script [.claude/toggle_graphify.py](.claude/toggle_graphify.py) (`enable`/`disable`
argument; idempotent, JSON-safe write, finds the key whether it's top-level or nested under
`hooks`, and prints a helpful message when the file or key is missing). You can also run the
script directly. Use `/graphify-off` when you want me to bypass the graph and read the
source files myself.

A self-hosted **code-snippet manager**: browse a folder tree of "pages"; each page holds
collapsible sections/subsections; each section holds code / note / rich-text / checklist
blocks with syntax highlighting, tags, search, trash & history. Plain static files + a
small PHP API. **No build step, no database, no external services.** Works offline, and
optionally as a native desktop app.

```
codeman/          the web app + PHP API (this is what you host)
codeman-desktop/  optional desktop wrapper (Electron, macOS + Windows)
.github/workflows/codeman-desktop.yml   tag-triggered macOS + Windows build → Release
.github/workflows/tests.yml             both test suites + invariant greps on every push/PR
.github/scripts/run-client-tests.mjs    CI runner for tests.html (Playwright, CI-only dep — never in codeman/)
docs/images/      README screenshots (generated — see Local dev)
```

> **Maintaining this file:** keep it about the **code** — architecture, data model,
> gotchas, conventions. Anything specific to a *particular* deployment or dataset
> (hostnames, IPs, ports, tokens, private data provenance) must NOT go here; this is a
> public repo. Keep that kind of note private (a private repo, local gitignored file, or
> agent memory).

---

## Ways of working — roles & seniority bar

Every piece of work is performed at a **senior** bar, by the matching **role agent**. These
roles are real subagents in [.claude/agents/](.claude/agents/), each with a defined
**handoff-in / handoff-out contract** so that when work passes between them nothing is lost —
the receiving role gets a complete, self-contained brief and never has to re-derive intent.
**Delegate to the agent for the phase** (don't just "act in the spirit" of the role):

| Phase | Agent | Produces (handoff) |
|-------|-------|--------------------|
| **Solutioning** — the *what* & *why* | [senior-solution-architect](.claude/agents/senior-solution-architect.md) | a **Solution Brief**: problem, options + trade-offs, recommendation, scope, non-goals, risks, acceptance criteria |
| **Technical design** — the *how* | [senior-technical-architect](.claude/agents/senior-technical-architect.md) | a **Technical Design**: data shapes, file-by-file change map, edge cases, gotchas honored, test strategy |
| **Development** — code, tests, docs | [senior-developer](.claude/agents/senior-developer.md) | a verified **Completion Report**: changes, tests/docs, suite + live-preview evidence |
| **QA** — full regression | [senior-qa-engineer](.claude/agents/senior-qa-engineer.md) | a pass/fail report with repro + suspected `file:line` |
| **Usability / visual** — UX review | [ui-ux-reviewer](.claude/agents/ui-ux-reviewer.md) | prioritized usability/UI findings with evidence |
| **Performance** — measure & diagnose | [senior-performance-engineer](.claude/agents/senior-performance-engineer.md) | a **Performance Report**: measured findings (before/after), root cause vs symptom, recommended fix + risk, owning role |

**The chain:** Solution Brief → Technical Design → Completion Report → QA + UX review. Each
agent's output is the *only* context the next one receives, so it must be complete and
self-contained (that's the point of the handoff contracts — a role is never half-defined).
The **[senior-performance-engineer](.claude/agents/senior-performance-engineer.md)** is a
specialist reviewer alongside QA/UX: pull it in whenever a change is performance-sensitive (boot,
render, search, at-scale behavior) or a slowness needs measuring. It *measures and recommends
with hard numbers* (separating code cost from environment) and hands its findings back into the
chain — it does not implement the fix.

**Right-sizing:** this is a quality bar, not mandatory ceremony for every keystroke. Trivial
changes (a typo, a one-line fix, a rename) don't need the full chain. But for any **new
feature or non-trivial change**, run the phases explicitly and in order — solutioning and
design get confirmed *before* development — and use the agents so the handoffs are real, not
implied. A new block kind, a new `api.php` action, or anything touching the data model / offline
story is squarely "non-trivial."

---

## Stack & files (under `codeman/`)

| File | Role |
|------|------|
| `index.html` | Markup; loads **vendored** Prism + **markdown-it** (offline). `version.js` is a **static `<script src>`** in `<head>` (so `CODEMAN_VERSION` exists before anything else), then the 7 ordered `src/*.js` scripts via the dynamic loader array (NOT `version.js` — it's static now). Cache-busts CSS/JS with a **version-keyed 3-way `?v=`** via the shared `cacheBustKey()`: `''` on `file://`, `Date.now()` on localhost/desktop, `CODEMAN_VERSION` on a real server (see the cache-bust gotcha). The stylesheet is a plain `<link>` whose href gets the same key appended by JS — **never** `document.write` (that wipes the document under a `file://` load). |
| `version.js` | **Single version source of truth.** `self.CODEMAN_VERSION = 'X.Y.Z'` — read by the footer (`init.js`) and `importScripts`-ed by `sw.js` for the cache name. Bump this one file per release (CI also syncs it from the git tag for the packaged desktop build). |
| `src/core.js` | Languages, global state, the `api()` wrapper (offline-aware) + `apiFetch`, toast, `flashCopied`, the `copyText()` clipboard helper (see gotcha), themed modals. `apiFetch` builds a relative `api.php?...` URL, or prefixes `window.CODEMAN_API_BASE` if non-empty — but it's `''` everywhere today (unset in a browser; the desktop preload sets it to `''` so the renderer keeps using the relative, proxied `api.php`), so the URL is effectively always relative. |
| `src/tree.js` | Sidebar tree (single column) + Miller columns (double, **always exactly 2** — `MILLER_COLS`) + drag-to-sort. `effectiveMode()` forces single-column when `body.is-mobile`, without changing the persisted `sidebarMode` (which **defaults to `double`** on desktop). Project helpers: `pathPrefixes`, `projectChain` (the project-ancestor chain), `isValidProjectParent`; the project-chain banner + color-coded breadcrumb live here. Page rows carry a discreet `❐` (`.tree-dup`) → `duplicatePageFromTree` (both layouts). |
| `src/editor.js` | Page tabs, page/section/block editor, language picker, blocks (code/note/rich/checklist), merge/split/reorder, variables, save (conflict-aware). **Duplicate** (glyph `❐`; clipboard-Copy keeps `⧉`): `duplicateBlock`/`duplicateSection` deep-copy (`JSON.parse(JSON.stringify)`) + splice-below + `pendingRevealObj`→`revealNewEl` (pulse/scroll); `duplicatePageFromTree`/`duplicateCurrentPage` are client-side page copies (`create_page`→`save_page {baseMtime:null}`→`loadTree`, then `revealTreeRow` or `openPage`) named by the pure `uniqueCopyName`. |
| `src/features.js` | Trash & history UI, history diff, the **dead-letter review panel** (`openDeadLetterPanel` — unsynced changes the server rejected), favorites + recently-copied, tag manager, command palette, quick-paste block palette, find & replace, export/import, `primeOfflineCache`, `rebuildIndex`, and `openMoreMenu` (the sidebar `⋯` overflow menu, reusing the `.mini-menu` pattern). |
| `src/ui.js` | Search, layout toggle (single/double), expand/collapse, hide/resize sidebar, and `initMobile()` (the `body.is-mobile` flag + off-canvas drawer + backdrop). |
| `src/offline.js` | Local-persistence fallback: IndexedDB mirror + write-queue + sync; offline trash/history. |
| `src/init.js` | Bootstrap IIFE + Service Worker registration (skipped on `file://`/insecure contexts) + sets the footer version label from `CODEMAN_VERSION`. |
| `sw.js` | **PWA Service Worker** — precaches the app shell so CodeMan boots when the server is unreachable (network-first + cache fallback, `ignoreSearch` so `?v=` URLs hit cache, stable cache keys). `api.php` is deliberately **not** intercepted. `CACHE_VERSION` is derived from `version.js` (`importScripts('version.js')`) — bump `version.js`, not this. |
| `manifest.webmanifest` + `icon-maskable.svg` + `favicon.svg` | PWA manifest (installable) + icons. |
| `style.css` | All styling. Palette lives in `:root` **design tokens** (dark-only — light theme was intentionally dropped; don't add a theme toggle). Hidden-sidebar desktop **rail** (`.sidebar-rail`). One `@media (max-width:768px)` block at the end makes the UI mobile-responsive — see the **Mobile** gotchas below (drawer sidebar, always-visible row actions on touch, 16px inputs + viewport zoom-lock, **icon-only block toolbars** with a `⋯` overflow menu, **count-button tag menus**, a compact page header, and an aligned **40px top band**). |
| `api.php` | Filesystem API: tree, page CRUD, move, reorder, content/block search, metadata index, projects, trash, history, save-conflict detection, find & replace, tag rename, optional password gate. |
| `vendor/prism/` | Vendored Prism (core + autoloader + grammars + theme) — **no CDN**, works offline. Grammars autoload on demand; an unviewed language won't highlight offline until first rendered. |
| `vendor/markdown-it/` | Vendored **markdown-it** (v14, single UMD file) — **no CDN**, offline. Backs `renderMarkdown` for **note blocks** (full CommonMark + GFM). Loaded as a static `<script>` before the `src/*.js` modules so `window.markdownit` exists when `editor.js` builds its instance. See the markdown-it gotcha. |
| `tests.html` | Standalone **client** browser tests: pure helpers + merge/markdown/diff/link/block-search/reorder/`pageToHtml` + project helpers (`pathPrefixes`/`projectChain`/`isValidProjectParent`) + `richToPlainText`/`convertBlock`/`parseCsv`/`parseJsonSafe`/`jsonPath`/`assembleRestoredTabs`/`uniqueCopyName` + deep-search cap + offline trash/history reducers (snapshots/restores the real IndexedDB cache — incl. `dl:` dead-letter keys — safe to run) + `sanitizeRichHtml` + `flushQueue` replay (FIFO/conflict-force/failure-retains + **dead-letter parking**: terminal/transient-exhausted/conflict-force-error, retry, `__codemanAdoptInto` merge, against stubbed `apiFetch`) + `importPages` negatives + the **HTML-project** helpers (`normalizeHtmlPath`/`resolveHtmlPath`/`isAbsoluteRef`/`stripCommonRoot`/`htmlExtInfo`/`resolveHtmlEntry`/`htmlFileList`/`htmlProjectSize`/`htmlCapCheck`/`htmlBundleKey`/`parseSrcset`/`serializeSrcset`/`pickSrcsetCandidate`/`parseImageSet`/`setHtmlEntry` + `bundleHtmlProject` incl. its three warning layers + the `blockKind` `block.html`-vs-`type:'html'` trap guard) + the **rendered html-block iframe's sandbox attribute** + `apiFetch`'s network classification (4xx / malformed body / 5xx / timeout / wrong-password token clear, against a stubbed `window.fetch`) + the **rich sanitizer's expanded allowlist** (`richImgSrc`/`richIntAttr`/`richToMarkdown` matrices, the two table invariants, foster-parent + foreign-content guards) + the **autosave-deferral** contract (`anyBlockEditing` incl. a per-`BLOCK_KINDS` pin, `scheduleSave` defers-but-still-marks-dirty, `safeStringify`, `afterEditSession`, the focus-flush **teardown** guard, and **Esc parity** across all six edit-session kinds) + `miniMenuClampPos` (the `anchorRect` viewport clamp: fits-unchanged / overflow / exact-fit boundary) + `miniMenuShift` (the same guard for `align:'right'`, as a `{dx,dy}` on the RENDERED rect: fits-unchanged / left+right overflow / exact-fit boundary / both axes) + **`showMiniMenu` itself** (the pure clamps' WIRING — a real menu opened in all three positioning modes at a fitting AND an overflowing viewport, asserting the applied `top`/`left`/`transform`, incl. `transform:'none'` on the `dx` branch — plus the full ARIA/keyboard/dismissal contract: roles, `aria-expanded` on open AND close, focus-on-open (and on the `checked` row), Arrow wrap, Home/End, Enter/Space, Escape/Tab → focus back on the anchor, outside-click, page-scroll, same-anchor toggle, one menu closing another via `_close`) + **`beforeEditSession` driven through the real `enterEdit`** (the snapshot must be captured, and captured BEFORE `.viewing` drops) + the **per-render-path wiring** (the focus flush asserted THROUGH `renderBlock`; a no-op Revert clearing `pageDirty` in every session-bearing kind; a `.toString()` census that all five paths wire all four hooks) + `anyBlockEditing`'s fail-OPEN catch + the **real `runDeepSearch` render cap** (a stubbed `search_content` returning 500 paths ⇒ 200 rendered + the "first N of M" banner) + `RICH_SOFT_WARN` (warns once, never truncates) + the computed `.modal-title` `white-space` against the real `style.css` + the **malformed-`tree` shape guard** (`setTreeData` rejects every non-array shape and keeps the last good tree; `loadTree` falls back to the offline mirror, flags offline and toasts; navigation afterwards does not throw — the pre-fix code fails 9 of these, one with the live crash `nodes is not iterable`) + **caret-Split through the real `⋯` menu** (rendered block → real Edit → caret at an offset → the menu takes focus → the Split item splits AT the caret, not at 0) + the **rejected-save contract** (the REAL `savePage` against a stubbed `api`: a terminal 4xx parks a forced dead-letter carrying the edit and never toasts "Saved", a repeat supersedes our own entry, a `_transient` body goes to the retry QUEUE instead, and the conflict / conflict-force-rejected / offline-queued / healthy-save branches are each pinned so the new branch can't have reordered them) + the **`importPages` POSITIVE round-trip** (a foldered bundle through the REAL `importPages` against a stub that MODELS api.php's parent guards: the exact create_folder parent at depth 1/2/3 incl. a multi-word name, every page landing, and a failure REPORTED not swallowed — the coverage was negatives-only, which is why D-B1 shipped) + the **offline tree-row Duplicate hit/miss discriminator** (a primed-but-unopened page duplicates through the real `duplicatePageFromTree`→`api()`→`offlineApi`→IndexedDB; a genuine miss is still refused) + the **single-'Saved'-announcer contract** (a real `renderBlock` Save: silent until the api call RESOLVES, exactly one "Saved", none on a rejection, the offline wording, plus a `.toString()` census that no render path re-adds its own `toast('Saved')`) + the **note/rich wide-table geometry** (measured against the real `style.css`: 20 columns keep single-line cells AND scroll, while a 400-char prose token still wraps inside the block — the cell-scoped `overflow-wrap` reset) + the **JSON-bundle scope note** (the REAL `exportAll` announcing via `showAlert` — count + what a bundle does NOT carry, multi-line for `pre-line` — with no toast repeating it, and the REAL `importPages` carrying the short caveat for a bundle but NOT for a single page or a zero-page import). Open it in a browser; **738 assertions**, expect `0 failed`. `window.__testResult = {pass, fail, done}` — CI runs it headless via `.github/scripts/run-client-tests.mjs`, which asserts `pass === FLOOR` **exactly** (not `>=`: a `>=` floor is silent when a change deletes 5 assertions and adds 6 — so bump FLOOR whenever the total moves, in either direction) and fails on any uncaught page error. |
| `tests-api.sh` | Standalone **server** API tests (bash + curl, no deps). Spins a throwaway `php -S` against a temp `CODEMAN_DATA` dir and asserts api.php behavior the browser can't reach: path-traversal confinement, parent-dir guards (`create_page`/`save_page`/**`create_folder`**), unicode `search_content`, same-second history retention, `empty_trash` history-prune + its traversal guard, save-conflict detection (stale `baseMtime` → conflict + untouched file; `force` → history snapshot), the project-nesting `move` guard, the `rename` traversal guard, the `restore_trash` round-trip, `replace_content` (preview dry-run / literal / regex), `rename_tag` (rename/merge/delete), the **create-then-save stub guard** (create_page→save_page leaves ZERO history versions and no listed version whose restore would empty the page, while a deliberately-emptied page and a title-only page still version normally), and the password gate. `bash codeman/tests-api.sh` (exit 0 = green; hunts upward from its port if taken, so parallel/CI runs don't collide). |

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
  `items:[{text,done}]`), **csv** (`csv:true`, raw CSV text in `code` rendered as a table in
  view mode — `parseCsv`/`renderCsvBlock` in `editor.js`), **json** (`json:true`, raw JSON text
  in `code` rendered as a collapsible copy-path tree in view mode — `parseJsonSafe`/
  `renderJsonBlock` in `editor.js`), **html** (`html:true`, a small static web project stored
  INLINE — `entry` + the entry's source in `code` + every other file in `files:[{p,t}|{p,m,b64}]`
  + `htmlH` preview height — rendered by `bundleHtmlProject`/`renderHtmlBlock` into a sandboxed
  `<iframe srcdoc>`). `blockKind()` derives the kind;
  `convertBlock()` switches a block to any other kind carrying text across.
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
  `0 failed`) and run `bash codeman/tests-api.sh` (server API, exit 0). **Both run in CI on every
  push/PR** (`.github/workflows/tests.yml` — the client suite headless via
  `.github/scripts/run-client-tests.mjs`, which enforces an EXACT pass count + zero page errors, plus
  a grep `invariants` job — **11** invariants: SW version single-sourcing, api.php never precached, atomic
  JSON writes (no `copy(`/`fwrite(`/bare `file_put_contents(`), **no `allow-same-origin` in
  `codeman/`**, `index.html` keeps its CSP meta, the single `setTreeData` write point, CSRF
  allowlist parity, the **edit-session wiring census** (exact call-site counts in `editor.js`:
  `beforeEditSession()`=5, `afterEditSession()`=10 (2 per path), `wireEscapeRevert(`/`wireFocusFlush(`=6
  each = 5 calls + 1 definition — an EXACT count, because losing one hook from one render path is
  per-kind DRIFT no single behavioural assertion can see), **`afterEditSession` never calls
  `scheduleSave(`** (scoped to its body — that call would re-mark the page dirty), and **no
  `renderPage()` inside `renderHtmlBlock`** outside the two lines that deliberately tear the block down
  (allowlisted by `convertBlock` / `parentArray.splice` — a stray one silently kills a live iframe,
  which no assertion can observe). Every invariant is verified to FIRE on an injected violation; note
  the runner's shell is `bash -eo pipefail`, so a local reproduction must use the same flags or a
  multi-grep step passes on its last line only.). The **full set of regression
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
  Fixed via the `?v=` cache-bust loader (http(s) only). If you ever see stale behavior, a one-time
  hard reload loads the new `index.html`.
- **Cache-bust is version-keyed (3-way) via one `cacheBustKey()` (index.html `<head>`).** `version.js`
  is a **static `<script src="version.js">`** in `<head>` (NOT in the dynamic loader array) so
  `self.CODEMAN_VERSION` exists before the key is computed and before any module runs. `cacheBustKey()`
  returns: `''` on `file://` (Chromium won't resolve `foo.js?v=…` off disk — the desktop wrapper),
  `'?v=' + Date.now()` on `localhost`/`127.0.0.1`/`::1` (dev + the desktop 127.0.0.1 proxy — SW
  `ignoreSearch` makes the per-load key free and edits never serve stale), else `'?v=' +
  CODEMAN_VERSION` on a real hostname (the NAS: assets cache hard, the key only moves on a release
  bump → a near-instant warm boot, only the two un-keyed bootstrap files travel the wire). BOTH the
  stylesheet `<link>` bust and the JS module loader call `cacheBustKey()` — one source of truth. **The
  desktop 127.0.0.1 keeping `Date.now()` is intentional.** **Deploy step (NAS nginx):** serve
  `= /codeman/index.html` and `= /codeman/version.js` with `Cache-Control: no-cache` (the two un-keyed
  bootstrap files) so a version bump is always seen; everything else caches hard + is busted by `?v=`.
  `sw.js` is untouched — its `CACHE_VERSION` still comes from `importScripts('version.js')`.
- **`document.write` for the stylesheet wiped the document under Electron's `file://` load**
  (an implicit `document.open()`), and `file://` won't resolve `foo.js?v=…` query URLs — hence
  the localhost-server approach in the desktop wrapper and the `file://`-aware loader in `index.html`.
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
- **`showMiniMenu(anchorEl, items, opts)` (editor.js) is the ONE accessible popup-menu — nothing
  else constructs a `.mini-menu` (grep-verified).** Every `⋯`/overflow popup routes through it:
  block-kind menus ×3, section `⋯`, tags menu, per-column sort (`buildColSortMenu`, tree.js),
  page-header `⋯`, sidebar More (`openMoreMenu`), Export submenu (`exportMenu`), and the block
  Copy-as `▾` submenu — the old bespoke bodies were all folded in as thin item-builders. **Don't
  fork a second hand-rolled `.mini-menu`.** Checkable menus (colsort) pass `checked` per item →
  each option becomes `role="menuitemradio"` + `aria-checked`, and the pure `miniMenuHasCheck(items)`
  reserves the 24px icon column on EVERY row (✓ on checked rows, accent `.active` background as
  before) so labels stay aligned; menus with no `checked` item keep the exact per-item `it.icon`
  behavior (column only where an icon is supplied) so none of them shift. **A11y contract:**
  container `role="menu"` (named via `aria-label` from the trigger's title/text), options
  `role="menuitem"` (roving `tabindex=-1`), dividers `role="separator"`. **Triggers are marked
  STATICALLY at creation** — menu-opening buttons are built with `menuBtn()` (= `markMenuTrigger`
  ∘ `mkBtn`, tree.js) or `markMenuTrigger(el)` (core.js) for the two `createElement` triggers
  (page Export, mobile page-header `⋯`), so each carries `aria-haspopup="menu"` +
  `aria-expanded="false"` **before its first open** (a screen reader announces it as a menu button
  from the first render); `showMiniMenu` then toggles only `aria-expanded` (and a safety-net sets
  haspopup if a dynamic anchor lacks it). Keyboard: ArrowUp/Down **wrap** (via the pure, unit-tested
  `miniMenuWrapIndex`), Home/End, Enter/Space activate, Escape/Tab close. **Focus on open** lands on
  the first item — or, in a checkable menu (colsort), on the currently-`checked` item (via
  `miniMenuHasCheck` + `checkedIdx`). **Keyboard dismissal (Escape/Tab) returns focus to `anchorEl`**
  (guarded by `document.contains` so a re-render that dropped the anchor fails soft). **On item
  activation**, if the action left focus on `<body>` (it only re-rendered/toasted rather than opening
  its own modal/panel), focus is restored to a caller-supplied `it.refocus()` target or the surviving
  `anchorEl` — so the next Tab doesn't restart at the top of the page; an action that opens its own
  modal keeps focus there. Pointer dismissal (outside-click/scroll) does NOT force focus.
  The block-type menu marks its current row with `active`/`aria-current` (not `checked`/`✓`), a
  deliberate visual-parity choice — don't convert it to a radio menu without accepting the `✓`-column
  shift. Toggle (`_anchor`
  re-click), the outside-`mousedown`-closes handler, close-on-scroll, and the "don't
  `preventDefault` the toolbar mousedown" rule are all preserved; opening one menu closes any other
  via its `_close` (clears that anchor's `aria-expanded` + listeners — no stale `.remove()` bypass).
  **Three positioning modes, each byte-preserving a prior behavior WHERE THE MENU FITS (zero
  positional regression in the normal case is the whole point):** *default* = viewport clamp +
  upward flip near the bottom edge; *`opts.align: 'right'`* = right-align under the anchor
  (`left=r.right; translateX(-100%)`, the `openMoreMenu`/sidebar behavior), **with no clamp while
  the box fits** — the transform means the visual left edge is `left − width`, so the guard measures
  the **rendered rect** via the pure `miniMenuShift(top,left,w,h,vw,vh,pad)` (= `miniMenuClampPos`
  expressed as a `{dx,dy}`), and when it returns `0/0` neither style is rewritten (a fitting menu is
  pixel-identical, transform included). A real overflow — the sidebar dragged to `SIDEBAR_MIN`=200
  pushed the menu to `left:−71`, clipped off-screen — is corrected **horizontally by setting the
  absolute VISUAL left and dropping the transform**, NOT by nudging `left` by `dx`: a `position:fixed`
  box's shrink-to-fit width is bounded by `viewport − left`, so moving `left` rightwards re-wraps the
  menu narrower/taller and invalidates the `dx` computed from the old width (measured: 233×277 →
  180×324). Setting the visual left can only give it more room;
  *`opts.anchorRect`* = plain top/left from a caller-supplied rect, **no flip, and no clamp while
  the box fits** — used by the `exportMenu` submenu (passed the **visible** `headerMoreBtn` on the
  mobile page-header path, never a hidden `exportBtn` at 0,0), the **colsort** menu (its original
  plain top/left), and the **Copy-as** submenu (which pre-computes its bespoke
  `left=max(8, r.right−200)` clamp into the rect so it lands identically). **Two of those `anchorRect`
  call sites are DEAD in the shipped CSS and must not be documented or tested as live positioning:**
  the block-kind `.type-menu` submenu and the Copy-as `.copy-as` submenu both anchor to their own
  trigger, and both triggers are `display:none` at **every** width (the unconditional `.block-toolbar`
  declutter rules) — the block `⋯` menu **rebuilds** both as its own items precisely because a hidden
  button's rect is invalid. The code is correct and worth keeping (it's the fallback if a trigger is
  ever un-hidden), but the *positional* behavior is unreachable: only the exportMenu and colsort
  `anchorRect` paths are user-observable. `anchorRect` mode passes
  through the pure `miniMenuClampPos(top,left,w,h,vw,vh,pad)`, which **returns its input unchanged
  unless the box genuinely overflows** — so every fitting menu is still on the exact prior pixel
  (proved by a full 4-viewport before/after rect sweep), while a short window no longer strands the
  last rows out of reach (`.mini-menu` is `position:fixed`, so the page cannot be scrolled to them).
  It **shifts, never flips**: an `anchorRect` carries a bottom edge but not necessarily a usable
  top. The height cap (`max-height:min(70vh,520px)` + internal scroll) is what bounds `offsetHeight`
  and makes the clamp tractable — don't remove it. The
  `.mini-menu-opt:focus-visible` ring (inset offset) is the keyboard affordance; no change at rest.
  **Both clamps are now pinned at the WIRING level, not just as pure math.** Unit-testing
  `miniMenuClampPos`/`miniMenuShift` in isolation left both fixes DELETABLE with a green build
  (mutation-proved: `if (s.dx) → if (false && s.dx)`, and passing the raw rect straight through, both
  shipped green). The suite now opens a REAL menu in each of the three modes at a fitting AND an
  overflowing viewport and asserts the applied `top`/`left`/`transform` — the **fitting** assertions are
  the load-bearing half (they ARE the "zero positional regression" contract), the overflowing ones catch
  a deleted clamp. The box is sized by a scoped test-only `.mini-menu` rule (tests.html doesn't load
  `style.css`) and `innerWidth`/`innerHeight` are `Object.defineProperty`-stubbed. A new positioning
  mode needs the same fit + overflow pair or it is unguarded. The ARIA/keyboard/dismissal contract is
  covered the same way (it had ZERO automated coverage before — the suite named `showMiniMenu` exactly
  once, in a comment).
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
  copy-as. **Desktop is no longer byte-identical** — that was an intentional declutter. **Glyph
  convention:** `❐` (U+2750) means **Duplicate** at all three levels (block/section/page menus + the
  tree row); `⧉` is reserved for **clipboard-Copy** only — don't cross them. All Duplicate handlers
  route through `duplicateBlock`/`duplicateSection` (deep-copy + splice **below** the source, not
  push-to-end) so a copy lands directly beneath its original and `pendingRevealObj`/`revealNewEl`
  pulse it into view.
  **Corollary — a hidden-and-proxied action MUST NOT read `document.activeElement`.** `showMiniMenu`
  moves focus to its first item on open, so by the time a proxied handler runs, the menu owns focus.
  **Split** was the casualty: it read `document.activeElement === textarea ? textarea.selectionStart :
  0`, which — now that `.block-split` is hidden at every width and the `⋯` menu is the ONLY route —
  never matched. `pos` was always 0, so caret-Split silently refused with "add a blank line or place
  the cursor" *at a cursor the user had just placed*: a shipped feature that was dead on both desktop
  and mobile. Fix: `renderBlock` keeps a `lastCaret`, recorded in `updateActiveLine` (which already
  runs on the textarea's keyup/click/focus/select **and** on `input` via `updateGutter`, and already
  bails while `.viewing`) — i.e. captured while the textarea still owns the caret. Split reads
  `el.classList.contains('viewing') ? 0 : lastCaret`, preserving the existing semantic that view mode,
  caret-at-0 and caret-at-end are all "no split point". Any future menu-proxied action that needs
  selection/focus state must capture it the same way, at the source.
- **Line endings are normalized to LF on the first edit+save — intended, not a bug.** `block.code` is
  written from `<textarea>.value`, and the DOM API normalizes `\r\n` → `\n` on read; a CRLF-bearing
  block (imported, or written through the API) therefore re-saves as LF. Viewing costs nothing (open +
  Cancel is a no-op — `flushSave` is dirty-guarded). This is standard editor behavior and is
  **deliberately not "fixed"**: a CR-restoring save pass would have to guess the file's original
  convention, would fight the platform on every keystroke path, and would risk mixed endings. Don't add
  one.
- **ALL block kinds get the icon toolbar (not just code/note).** `renderChecklistBlock` and
  `renderRichBlock` mirror the same mobile treatment: Edit→`✎`/Save→`✓` (rich), Copy→`⧉`, Delete→`✕`,
  label on its own row, and a `.block-overflow` (`⋯`) that folds Duplicate + the block-kind convert
  (and Clear-done for checklists) — necessary because the generic (now **unconditional**, not just
  `body.is-mobile`) `.block-toolbar .type-menu/.block-dup/.block-clear { display:none }` rules strip
  those buttons, so without a `⋯` they'd be unreachable. Rich's convert syncs `surface.innerHTML`
  into `block.code` first. Shared marker classes (`.block-copy`/`.block-dup`/`.block-clear`) drive
  the CSS hide + icon sizing.
- **CSV block edit/view split + tolerant parse.** `renderCsvBlock` mirrors the rich/checklist
  pattern (own render path, `viewing` toggled via `blockBackups`, Edit/Save/Revert). Raw CSV lives
  in `block.code`; the `.csv-edit` textarea is the source, `.csv-view` holds the rendered
  `.csv-table`. While editing, the textarea AND a **live preview** table both show (CSS hides only
  `.csv-edit` when `.viewing`); in view mode only the table. **`parseCsv` (editor.js) is the single
  parse path and must never throw** — it's RFC-4180-ish (quoted fields, `""` escapes, embedded
  newlines), auto-detects the delimiter (`,`/`;`/tab) via `detectCsvDelimiter`, and flags
  `unterminated` for an open quote; the view pads ragged rows and shows a `.csv-warn` banner for
  unterminated/ragged input rather than breaking. Cells are filled via `textContent` (no XSS). The
  exports reuse `parseCsv`: `pageToMarkdown` emits a GFM table, `pageToHtml` a `<table class="csv">`.
- **JSON block = CSV pattern, tree view instead of table.** `renderJsonBlock` clones the CSV
  block's edit/view split (raw JSON in `block.code`, `.json-edit` textarea + live `.json-view`,
  `viewing` via `blockBackups`, Edit/Save/Revert/Copy/Dup/⋯/Delete). **`parseJsonSafe` (editor.js)
  is the single parse path and must never throw** — standard `JSON.parse` in a try/catch returning
  `{ok,value,error}` (no JSON5/comment leniency on purpose: invalid input should warn). On parse
  failure the view shows a `.json-warn` banner + a `.json-raw` `<pre>` of the raw text (never a
  blank block). `buildJsonTree` recurses into `<details>/<summary>` collapsibles (open by default),
  typed-colored leaf values, and **clickable keys that copy a JS-accessor path** via `jsonPath()`
  (`root.records[0].Id`, bracket-quoting non-identifier keys) — the whole tree is built with
  `textContent`/DOM, never `innerHTML` of data (no XSS). The ⋯ menu adds **Format** (pretty-print
  via `formatJson` = `JSON.stringify(…,2)`). Exports: `pageToMarkdown` emits a pretty ```json fence,
  `pageToHtml` a highlighted `<pre>` (static — no interactive tree in export). `jsonPath`/
  `parseJsonSafe`/`formatJson` are pure → unit-tested in `tests.html`.
- **`buildJsonTree` cycle guard = a DFS ancestor-set with pop-on-exit.** It takes a 4th
  `seen` Set: a value already on the current path renders a `.json-circular` `[circular]` leaf (no
  infinite recursion), and **`seen.delete(value)` on exit** means only true *ancestors* count — a
  shared-but-acyclic ref (same object via two sibling keys) renders fully in both branches.
- **JSON tree collapse/expand toggle.** `makeTreeToggleBtn(view)` + `syncTreeToggle(btn, view)` (JSON
  block only) read the **live** `<details>.json-node` state at click/sync time — `⊟` collapses-all /
  `⊞` expands-all (NOT the per-node ▾/▸ markers). The button **hides** when the view has no container
  nodes (scalar/empty/invalid). A capture-phase `toggle` listener on the view re-syncs the glyph when a
  single node is hand-toggled; `renderTree()` calls `syncTreeToggle` at its end.
- **HTML-project block = the CSV/JSON pattern + a sandboxed iframe.** The whole project lives inline
  in the page JSON, so history/trash/duplicate/conflict-save/offline/export need ZERO new plumbing —
  paid for with a hard cap (`HTML_MAX_TOTAL` 1 MB / `HTML_MAX_FILE` 512 KB / `HTML_MAX_FILES` 50,
  soft-warn at 256 KB), because every byte is multiplied **×21** on disk (current + 20 history
  versions). **`block.code` IS the entry file's source** and `files` holds only NON-entry files — so
  `blockPlainText`, `convertBlock`, `search_blocks`, `replace_content` and the block filter all work
  unchanged. Five load-bearing rules:
  **(1) `blockKind()` discriminates on the `block.html` BOOLEAN, never `type === 'html'`** — existing
  CODE blocks legitimately use `html` as their language and would be silently reinterpreted as
  projects (pinned by a tests.html regression guard).
  **(2) The iframe is `sandbox="allow-scripts"` WITHOUT `allow-same-origin`** ⇒ opaque origin ⇒ no
  `parent.document`, no cookies/storage, and (with the inherited CSP) no egress. Adding
  `allow-same-origin` alongside `allow-scripts` **voids the entire sandbox — permanent invariant, not
  a tuning knob.** `allow-modals` is deliberately omitted (`alert()` no-ops); adding it later is safe.
  **This is now GUARDED in three places** (it used to be documentation only — widening it left every
  assertion green): a CI `invariants` grep fails on `allow-same-origin` anywhere in `codeman/` (bare
  comments excepted — they're what document it), `tests.html` asserts the **rendered** iframe's
  `sandbox` attribute is exactly `allow-scripts` (plus `srcdoc`-only, `no-referrer`), and a string
  assertion pins the same posture on `pageToHtml`'s export path.
  **(3) `bundleHtmlProject` MUST NEVER THROW** (the `parseCsv`/`parseJsonSafe` contract) and must
  never render a blank block — it's try-wrapped and falls back to the raw entry + a warning. It's
  regex-based, deliberately NOT `DOMParser`, so the author's exact document survives.
  **(4) The three-layer warning system is the trust guarantee:** layer 1 warns per unresolvable/
  root-escaping ref; layer 2 is a declared `HTML_REF_ATTRS` × `HTML_HANDLED_REFS` census that catches
  ref-bearing forms the rewrite table doesn't cover (`<object data>`, `<form action>`, `style=
  "…url(…)"`); **layer 3 is the unconsumed-file audit** — any file in `files` the bundler never
  inlined warns, which is whitelist-free and forward-proof (the evidence IS the unused file). Don't
  weaken layer 3 to a whitelist; it's what makes an unhandled reference form structurally unable to
  fail silently.
  **(5) NO html-block mutation may call `renderPage()`** — it rewrites `#page` wholesale and would
  kill a live iframe. Every in-block mutation (upload, file remove, entry change, height drag, entry
  edit) updates its own subtree, calls `remountFrame()` **and `scheduleSave()`** (the `pageDirty`
  contract — a path that forgets it silently fails to persist on tab switch/unload). Only
  convert/delete/duplicate call `renderPage()`. **Now grep-guarded** (`no html-block mutation calls
  renderPage`): the CI job awks `renderHtmlBlock`'s body and permits `renderPage()` ONLY on a line that
  also contains `convertBlock` or `parentArray.splice` (the convert + delete teardowns) — same shape as
  the `writeJsonAtomic` primitive ban with its two allowlisted lines. It guards a failure NO assertion
  can observe: a live iframe silently killed by `#page.innerHTML = ''`. `htmlRunState` (module-scope Map, FIFO-capped at 64)
  keys `htmlBundleKey` → `'running'|'stopped'`; **binaries hash by base64 LENGTH only**, which is
  safe ONLY because every explicit mutation calls `remountFrame()` directly.
  Other traps that bit during implementation: `readEntries` **pages at 100 entries** — loop until it
  returns an empty array or a large folder imports partially; base64 conversion is **8 KB-chunked**
  (one `.apply()` over 512 KB blows the argument-list limit); the cap check is **atomic** (build the
  whole candidate, check, only then assign — a rejected upload leaves the block untouched);
  `</script>` inside inlined JS is escaped to `<\/script`; binaries are stored as **one unbroken
  base64 line** under the reserved key `b64`, which is the shape `api.php`'s `search_content` strip
  depends on (both the raw fast path AND the decoded fallback blank those spans, or encoded image
  data produces false search hits). The block uses a **plain `.html-edit` textarea**, never the Prism
  `.code-stack` overlay — zero contact with `ED_*`/`autosizeCode`/`syncScroll`, which is exactly why
  editing NON-entry files is deferred to a phase 2 with its own design pass.
- **`sanitizeRichHtml` is a THREE-table, deny-by-default sanitizer** (`RICH_ALLOWED` tags kept /
  `RICH_DANGEROUS` tags dropped WITH their subtree / `RICH_ATTRS` per-tag attribute allowlist +
  `RICH_GLOBAL_ATTRS` for the value-filtered `style`). A tag named nowhere is **unwrapped** (lossless
  for its text) — do NOT change unknown-tags to *drop*, that's a silent data-loss path. Five
  load-bearing points: **(1)** the tag lookup **UPPERCASES `node.tagName`** — foreign content
  (SVG/MathML, incl. an `<svg><script>`) reports a *lowercase* local name, so the raw lookup missed
  `'SVG'` entirely and merely unwrapped it, leaking the payload's text; **(2)** the **FULL table set**
  is allowlisted incl. `CAPTION/COLGROUP/COL` — the output is a *string* re-parsed by
  `surface.innerHTML`, and an unwrapped caption's text becomes a direct `<table>` child that the
  second parse **foster-parents OUT of the table**, silently relocating content; **(3)** `richImgSrc`
  accepts **only** `https:` and non-vector `data:image/…;base64,…` — the scalable-vector MIME is
  absent ON PURPOSE (script-bearing format ⇒ a permitted data: src is an XSS primitive); control/
  whitespace chars are stripped before the scheme test (`java\tscript:`); a rejected `src` is REMOVED,
  not blanked (an empty `src` re-requests the page); **(4)** deny-by-default is what makes `on*` (and
  every FUTURE handler) impossible without enumerating it — the pure `richIntAttr` bounds
  `width/height/colspan/rowspan/span`; **(5)** it is wrapped in `try/catch` and **must never throw** —
  it degrades to `&<>`-escaped inert text, never to raw HTML and never to `''`. Both Sets must stay
  **single-line literals**: the `rich-sanitizer` CI invariant greps the `const RICH_ALLOWED` line for
  script-bearing tag names and bans any `svg` reference on a `richImgSrc` line. Consumers:
  `richToPlainText` maps `</td>|</th>` → TAB (so rich→csv convert yields a real table) and `<img>` →
  its `alt`; `richToMarkdown`/`richTableToGfm` (features.js) emit GFM tables — `pageToMarkdown` used
  to read `innerText` off a **detached** div, which has no layout, so every rich block exported as one
  run-on line. Data-URL images are a page-bloat vector (×21 on disk); `RICH_SOFT_WARN` (256 KB) is a
  **soft toast only, never a truncation** — a hard cap could only lose content.
- **Autosave is DEFERRED while a block edit session is open (`anyBlockEditing()`).** `scheduleSave()`
  still adds to `pageDirty` on its first line, **unconditionally** — the choke-point contract and its
  `tests.html` regression guard are byte-identical; only the 500 ms `setTimeout(savePage)` is skipped
  (early-return **before** arming the timer, NOT a guard inside `savePage` — that would break the
  `saveInFlight`/`savePending` re-save path). The predicate is **DOM-derived**
  (`#page .block:not(.viewing):not(.checklist)`) and **fails OPEN** (`catch → false` ⇒ save): a
  tracked Set would go stale when an editing block is deleted and would suppress autosave forever.
  `.checklist` is excluded because it's the ONE kind with no edit session. **`flushSave` is
  deliberately NOT gated** — every editor assigns `block.code` on `input` *before* calling
  `scheduleSave`, so `currentPageData` always holds the live buffer and tab-switch/unload still
  commits it; gating that would turn a retention win into DATA LOSS. Cancel is free because
  `beforeEditSession()` snapshots the clean page (`safeStringify`, capped at `SNAPSHOT_MAX`, captured
  BEFORE `.viewing` drops since the predicate is DOM-derived) and `afterEditSession()` clears
  `pageDirty` when the page is byte-identical at session end — it **arms `saveTimer` directly and must
  NEVER call `scheduleSave`**, which would re-mark dirty. Wired into all **SIX** session-bearing
  render paths (code + note share `renderBlock`; rich, csv, json, html-entry); Esc routes through the
  Cancel/Revert button, so wiring those covers it — via the shared **`wireEscapeRevert(surfaceEl,
  revertBtn)`**, called once per session-bearing render path (it used to be an inline handler on the
  code/note textarea ONLY, so Esc silently did nothing in rich/csv/json/html). **Esc must always
  `revertBtn.click()`, never a bespoke revert** — that button is where each kind decides clean-exit
  vs restore-backup and calls `afterEditSession()`; a second implementation drifts per kind. It bails
  while a `.mini-menu` is open (the menu owns Escape).
  `wireFocusFlush(el)` is a focus-departure **FLUSH, not a session end** — sticky editing stays; it
  bails on an in-block `relatedTarget` (the original toolbar-click gotcha) and on an open
  `.mini-menu` (which lives on `document.body`, so opening the `⋯` would otherwise burn a history
  slot). **A TEARDOWN is not a departure either, and the sync guards CANNOT see it:** delete/convert
  splice the block then `renderPage()`, whose `#page.innerHTML = ''` makes Blink dispatch the focused
  Delete button's `focusout` at the START of `RemoveChildren` — while `document.contains(el)` is
  still `true` and `.viewing` is still absent. So the decision is **deferred one task**
  (`setTimeout(…,0)`) and the `.viewing`/`document.contains` pair is **re-checked there**; by then
  the teardown has finished and `el` is detached. Deferring keys on the OBSERVABLE end state rather
  than on enumerating teardown paths (a "renderPage is running" flag would miss any future detach
  route, and would break if an engine ever dispatched that focusout asynchronously). It can't swallow
  a real departure: both failure modes (`.viewing` ⇒ Save wrote / Cancel ran `afterEditSession`;
  detached ⇒ the mutation path called `scheduleSave`) persist by their own route, and the page stays
  in `pageDirty` regardless. Without it, delete-while-editing cost TWO writes and two history
  versions. **Accepted regression:** un-Saved text lives only in tab
  memory between commit points (Save / focus departure / `visibilitychange→hidden` / `beforeunload`).
  **Guarded three ways now, because the hooks are pure WIRING and wiring rots silently** (all
  mutation-proved to have shipped green before): (a) `beforeEditSession` is exercised through the REAL
  `enterEdit` — an emptied body AND the call MOVED below `el.classList.remove('viewing')` both left the
  old suite green, since it set `cleanPageSnapshot` by hand and only called `afterEditSession`; (b) the
  focus flush is asserted THROUGH `renderBlock` (not on a synthetic `<div>`) and a no-op Revert must
  clear `pageDirty` in EVERY session-bearing kind (that's what catches losing one `afterEditSession`
  call from one kind); (c) a CI `edit-session wiring census` counts the call sites EXACTLY
  (`beforeEditSession()`=5 · `afterEditSession()`=10 · `wireEscapeRevert(`=`wireFocusFlush(`=6 incl. the
  definition) and a second invariant greps `afterEditSession`'s BODY for `scheduleSave(` — the
  "never call scheduleSave" rule has no observable behavioural difference, so a grep is the only guard
  that can exist for it. Adding or removing a session-bearing render path means updating BOTH the
  census counts and the tests.html census.
- **Sidebar tree is keyboard-operable + ARIA (a11y pass).** `#tree` is `role="tree"`; rows
  (`.tree-row`) and Miller folder cards (`.subfolder-card`) are `role="treeitem"` with a
  `data-path`, `aria-label`, roving `tabindex` (exactly one row is `tabindex=0` via
  `initRovingTabindex`, called at the end of `renderTree`), folders carry `aria-expanded`. One
  delegated `keydown` on `#tree` (`onTreeKeydown`, bound once via `bindTreeKeys`): Enter/Space
  activate any row in BOTH layouts (`activateTreeItem` clicks then restores focus by `data-path`,
  since folder activation re-renders via `selectFolder`); single-column also gets Up/Down/Home/End +
  Left/Right expand-collapse/parent. It bails when `e.target` is an INPUT (don't hijack inline
  rename/create). A global `:focus-visible` ring lives near the base `button{}` rule.
- **Page tabs are an ARIA tablist; the section toggle is the accessible collapse button.**
  `renderMainTabs` (editor.js) marks `#mainTabs` `role="tablist"` and each `.main-tab`
  `role="tab"` + `aria-selected` + a **roving tabindex** (only the active tab is `0`), carrying
  `data-path`. Left/Right **wrap** and Home/End jump via the pure `tabArrowIndex(key,i,n)`;
  arrow-move uses **automatic activation** (opens that page) then `focusTabByPath` re-focuses the
  rebuilt tab (activation re-renders the strip). Enter/Space open a focused tab. Each tab's **close ✕
  is a real `<button>`** (in the Tab order, `aria-label="Close <title>"`) so tabs are keyboard-closable;
  its click closes then moves focus to a surviving tab (never `<body>`). **"Close all" is a real
  `<button>`** (`aria-label`), NOT a `role=tab`, and stays sticky-pinned on the mobile strip. Full APG
  pairing: `#mainTabs` carries `aria-label="Open pages"`, each tab an `id` + `aria-controls="page"`,
  and `#page` is the `role="tabpanel"` (`tabindex=0`, `aria-labelledby=<active tab id>`), set in
  `renderMainTabs` (persists across `renderPage`'s innerHTML rewrite). The mobile horizontal-scroll
  strip is untouched. The slow-open affordance (`openPage`) adds `.tabs-loading` + `aria-busy="true"`
  to the strip after 250 ms, revealing a hidden (first-open) strip early so the spinner paints.
  For section collapse, `role="button"` + `tabindex=0` + `aria-expanded` + Enter/Space live on the
  **`.section-toggle`** span, NOT the `.section-header` — the header contains the title `<input>`
  and action buttons, and a `role=button` MUST NOT wrap interactive descendants. A shared
  `toggleCollapse()` closure backs both the header click and the toggle keydown so aria-expanded +
  the `.collapsed` class + save stay in lockstep. `tabArrowIndex` is pure → unit-tested.
- **`showModal` (core.js) is a real focus-trapping dialog.** The box is `role="dialog"`
  `aria-modal="true"`, named via `aria-labelledby`→its `.modal-title` (auto-assigned an id after
  `buildBody`). It captures `document.activeElement` as the **invoker BEFORE** opening and restores
  focus to it on close (guarded by `document.contains` — a re-render that dropped it fails soft).
  `onKey` handles **Tab** (`preventDefault` + cycle within the dialog's focusables via the pure
  `focusTrapNextIndex(i,n,shift)`, wrapping first↔last), Escape (close), Enter (submit) — same as
  before. On open a `setTimeout(0)` moves focus inside only if `buildBody` didn't already (its own
  `setTimeout(0)` focus registers first, so this is a fallback); a dialog with no focusable control
  focuses the `tabIndex=-1` box itself. Every themed confirm/prompt AND the palette's Move-to picker
  inherit this. **`showAlert(message)` is the acknowledgement variant** — one button, resolves
  `undefined` (the caller can't branch on it, which is the point). Use it for INFORMATIONAL modals;
  `showConfirm` there renders a dead "Cancel" beside "OK" that implies an outcome the caller doesn't
  offer (the html-block over-cap rejection was the one such site). Everything else in the codebase
  using `showConfirm` is a genuine two-outcome decision — checked, don't convert them.
  **`.modal-title` is `white-space: pre-line`** so a `\n`-separated message (the over-cap rejection's
  file list) keeps its line breaks; `pre-line` still collapses space runs and wraps normally, so the
  single-line messages every other caller passes render exactly as before — a modal message is a
  plain string, never markup. `focusTrapNextIndex` is pure → unit-tested. Toast + the `flashCopied` bubble are
  `role="status" aria-live="polite"` (the offline badge's channel) — one announces per action
  (flashCopied shows the bubble OR falls back to toast, never both).
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
  Any new bulk server-side mutation of page content needs the same open-tab reconciliation. **Both
  reconciliation loops must shape-guard the `get_page` reply** (`if (!d || d.error) continue`) — Find &
  Replace's loop assigned the reply straight into `tab.data`, so a reachable-but-wrong response would
  have installed an error body as the tab's page content. Same one-line class as the `api()`-consumer
  sweep; a reachable-but-wrong response is not a connectivity error and nothing upstream catches it.
- **`importPages` builds parent folders by TRACKING the parent, never by string surgery — and a
  failed page is REPORTED (features.js).** The original loop derived each `create_folder` parent as
  `acc.slice(0, acc.lastIndexOf('/')) || ''`; on the FIRST path segment `acc` has no `/`, so
  `lastIndexOf` returned `-1` and `slice(0, -1)` **dropped the last character** — `"Notes"` was created
  under a parent named `"Note"`, `"DZ"` under `"D"`, `"QA Kinds"` under `"QA Kind"` (only 1-char names
  accidentally worked). Three failures compounded into **silent data loss on the documented backup
  path**: (1) `api.php`'s `create_folder` did `mkdir($path, 0777, true)` with **no parent check**, so
  the bogus parent was *materialised* (`{"ok":true}`) instead of rejected — it now mirrors
  `create_page`/`save_page` with `404 'parent folder does not exist'`, which also closes an
  independent hole (any client bug or crafted request could litter the confined data root with
  arbitrary nested folders); (2) the later `create_page {parent:'Notes'}` legitimately failed and the
  loop `continue`d **without counting it**; (3) the toast said `Imported N pages` regardless. Measured:
  a real 14-page `All pages → JSON` bundle restored into an EMPTY root imported **2** pages and left
  `ROOT/B/BZ` + `ROOT/D/DZ` behind. **Invisible when re-importing into the SAME library** (the real
  top-level folders already exist), which is why it survived from the initial release. Import now
  reports `Imported N pages, M failed` and checks `save_page`'s reply too. A non-page-shaped bundle
  value is still skipped silently (it isn't a page) — that's the existing negatives' contract.
- **`tests.html` seeds via the namespaced wrappers.** Since `offline.js` keys IndexedDB per server,
  the offline-reducer tests must seed/read/snapshot/restore through `kvGet/kvSet/kvDel` +
  `pageGet/pageSet/pageDel` (NOT raw `idbGet/idbSet('kv'|'pages', …)`), or they'd miss the active
  namespace AND fail to restore the real cache. Keep that contract when adding offline tests.
- **A JSON bundle is page CONTENT only, and both ends must SAY so (features.js).** `exportAll`'s
  bundle is `{path: pageData}`, so everything the library's SHAPE lives in — the `.project` markers,
  `.order.json`, `.colsort.json`, `.trash`, `.history` — is absent from a restore. `Exported N pages`
  / `Imported N pages` were unqualified success claims over that, and a restored library (plain
  folders, no history) is indistinguishable from a failed restore. Two constants,
  `BUNDLE_SCOPE_NOTE` / `BUNDLE_SCOPE_SHORT`, are the single wording source. **Export gets the
  `showAlert`, import gets the toast** — export is where the belief "I have a backup" forms (init.js's
  offline-only desktop nudge sends users straight into `exportAll`, and on that machine IndexedDB is
  the only other copy), so it must be unmissable and acknowledge-only (nothing to decide, the file is
  already downloaded); `exportAll` no longer toasts a second success line. The import note is gated on
  `isBundle && n` — a **single-page** import (the `This page → JSON` counterpart) has no library shape
  to lose, and "0 pages" is a different message. `.toast` gained a `max-width` + wrap: it was
  unbounded, and a sentence-length toast ran off the left edge at 375px. Keep the wording accurate —
  page content IS byte-perfect; the note says what's missing, never that the restore failed.
- **An assertion must CALL production code, and coverage of a pure helper is not coverage of its
  caller.** A suite audit by **mutation testing** (inject a realistic single-point regression, run the
  suite, see if it goes red) found **10 of 20** injected regressions shipping green at a fully-green
  suite. Every one had the same two shapes: **(1) a tautology** — the deep-search-cap "test"
  re-implemented `all.slice(0, DEEP_MATCH_CAP)` *inside its own expectation*, so it passed with the cap
  deleted; **(2) coverage of the pure part only** — `miniMenuClampPos`/`miniMenuShift`,
  `afterEditSession` and `wireFocusFlush` were all exercised in isolation while the WIRING that calls
  them (`showMiniMenu`'s three modes, each render path's `enterEdit`/Revert) was untested, so both menu
  clamp fixes and `beforeEditSession` could be deleted outright. Two rules fall out: **drive the real
  entry point** (click the rendered Edit/Revert button, open a real menu, call `runDeepSearch` against a
  stubbed `api`) rather than the helper it delegates to; and where a rule has **no observable
  behavioural difference** (`afterEditSession` must not route through `scheduleSave`; no `renderPage()`
  inside `renderHtmlBlock`; a hook wired once per render path) a **scoped CI grep is the only guard that
  can exist** — write it, allowlist by what the line does, and prove it fires by injecting the
  violation. **When adding an assertion, prove it fails on the regression it is meant to catch** —
  otherwise the gap is still open, just now with a green tick over it. (Local reproduction of an
  invariant must use `bash -eo pipefail`, the runner's shell: without `-e` a multi-grep step only
  reports its LAST line's status.)
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
- **Mobile section header = one row: `▼ Title  🏷N  ⛶  ⋯ ✕`.** On mobile (`isMobile` checked
  in `renderSection`), section tags collapse into a `.section-tags-btn` (`🏷 N` count) that opens a
  `showMiniMenu` picklist (each tag with ✕ + an Add-tag item) instead of the wrapping chip row, and
  the per-section merge bar is **relocated** out of the section body (`panel`) up onto the header
  row via `panel.querySelector(':scope > .merge-bar')` + append (its start button shortened to just
  `⛶`). Merge still works because its `target` (the panel) is captured in the closure — only the
  controls move. Tag add/remove logic is shared via `removeTag`/`addTagFlow` (factored out of
  `renderTags`). Desktop keeps inline chips + the body merge bar (the whole branch is `is-mobile`-gated).
  The `$` Variables toggle (`.sec-var-toggle`) and `⤴ Dissolve` (`.section-dissolve`, subsections
  only) are **CSS-hidden on every width** and folded into a new `.section-overflow` (`⋯`) menu
  (`❐ Duplicate section · $ Variables · ⤴ Dissolve`) that proxies them via `.click()` — so
  the desktop section header also declutters to `$/⤴`-in-`⋯`. `⛶ Merge` + `✕ Delete` stay inline.
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
- **Code-view horizontal scroll range comes from a `max-content`-wide `<pre>` set INLINE.**
  `updatePreview()` (editor.js) rebuilds the Prism `<pre>`'s `cssText` on **every keystroke**, so the
  `width:max-content;min-width:100%` that gives `.code-view` a real horizontal scroll range MUST be in
  that inline string (a `style.css` width rule would be overridden each re-highlight → the colored
  layer snaps back to clipped while typing). The static-view `<pre>` rule in `style.css` carries the
  same values as belt-and-suspenders (inline wins where both apply). The scrolling itself: **edit
  mode** = `syncScroll` mirrors `view.scrollLeft = textarea.scrollLeft` (the textarea is the single
  scroller; `.code-view` stays `overflow:hidden`); **view mode** = `.block.viewing .code-view {
  overflow-x:auto }` (overflow-x only — view height is content-driven, no vertical bar). Backgrounds
  live on the scroll containers (`.code-view` / `.code-stack`), so a line scrolled right never exposes
  an unpainted right-edge gap. A **thin dark themed scrollbar** (`scrollbar-width:thin` +
  `::-webkit-scrollbar` 8px, `--border-2` thumb) is scoped to the source editors (code/note/csv/json
  edit + their scrollable views) — NOT `.block.note .code-view` (wrapped prose, never scrolls).
- **Deep (content) search renders a capped result set.** `runDeepSearch` (ui.js) keeps the full
  match count in `deepMatchTotal` but slices `deepMatches` to `DEEP_MATCH_CAP` (200, tree.js) — a
  broad term on a large library would otherwise paint thousands of sidebar rows synchronously (~1.5s
  at 1200 pages). `updateSearchCapNote` (tree.js, called from `renderTree`) shows the
  `#searchCapNote` "Showing first N of M — refine your search" banner when capped, hidden otherwise.
  It's a render cap, not a server cap (search_content still scans everything) — don't remove it. The
  cap is now driven through the REAL `runDeepSearch` against a stubbed `search_content` (500 paths ⇒ 200
  rendered + `deepMatchTotal` 500 + the banner); the case it replaced re-implemented
  `all.slice(0, DEEP_MATCH_CAP)` INSIDE its own expectation, so deleting the cap left it green.
- **`setTreeData(t)` is the SINGLE write point for `treeData` (tree.js) — no bare `treeData = …`
  survives outside it (grep-verified).** It sets the global AND calls `invalidateTreeMemos()`, which
  drops the `folderCounts`/`folderMeta` WeakMap caches (memoized by node identity — those aggregates
  recurse the whole subtree, so re-render/resize/Miller-paging would otherwise re-walk it every
  time). Every writer routes through it: `loadTree` and the four offline.js paths (`probeBackend`,
  `flushQueue` reconcile, `restoreNodeToTree`, `mutateTreeCache`). The WeakMap is safe **because**
  each write either replaces node objects (fresh from IndexedDB/server) or mutates in place then
  immediately calls `setTreeData` — so a cached value can never outlive the node it summarised. **A
  future direct `treeData =` assignment = stale counts/tags; always go through `setTreeData`.** A CI
  grep invariant (`.github/workflows/tests.yml` `invariants` job) fails the build on any bare
  `treeData =` in `codeman/src/` outside the declaration + `setTreeData` definition — mirroring the
  `writeJsonAtomic` invariant; keep source comments free of a literal `treeData =` token so they
  don't trip it.
  **It is ALSO the single SHAPE guard: `treeData` must stay an ARRAY, and a non-array write is
  REJECTED (returns `false`) rather than applied.** Being the choke point is what makes one guard
  cover all five writers. The bug it closes: `api()` only falls back to the IndexedDB mirror when
  `apiFetch` **throws**, so a *reachable* server answering **200 with a non-array body** —
  `{"error":…}`, `null`, or an unparseable body (→ the `_transient` error object) — sailed straight
  into `treeData`. The library rendered as the EMPTY onboarding state, the offline mirror was
  **BYPASSED** (a user with a perfectly good cache saw nothing), and the next navigation threw
  `TypeError: folderChildren(...).find is not a function` from `nodeAtPath`. So: **a bad shape is a
  FAILURE, never "the library is empty"** — `loadTree` checks the return, reads `offlineApi('tree')`,
  calls `setOffline(true)` (which starts the self-healing probe loop) and toasts. The two offline.js
  sites that call `apiFetch('tree')` directly (`probeBackend`, `flushQueue`'s reconcile) need their
  OWN `Array.isArray` check as well, because they `kvSet('tree', fresh)` — an unguarded write there
  poisoned the **PERSISTED** mirror, not just the in-memory global; `probeBackend` stays offline and
  re-schedules, `flushQueue` skips only the reconcile (its writes did land). **The load-bearing one
  is `cacheOnSuccess` (offline.js), found only by live-testing the fix:** `api()` runs it BEFORE
  returning, so the malformed body overwrote `kv.tree` and the library still went empty *with*
  `loadTree`'s fallback in place — the mirror was already poisoned by the time the fallback read it.
  It now refuses to mirror anything with an `.error`, and shape-checks per action — **with strictness
  proportional to blast radius**, which is the design rule, not an inconsistency: `tree` must be an
  array (a non-array there CRASHES navigation) and `col_sorts` a plain object, but `get_page` only has
  to be a **plain object** (not an array/scalar). The stricter `Array.isArray(data.sections)` it
  originally carried over-reached: a hand-written or imported `{title:"NoSect"}` is an unusual-yet-VALID
  page, not an error body, and demanding `sections` made it permanently uncacheable — `primeOfflineCache`
  silently skipped it and it came up empty offline with no warning. The guard's job is to reject ERROR
  bodies; the render path already tolerates a missing `sections` (`openPage` defaults it to `[]`).
  **A fallback is only as good as the cache behind it: never let a failed response write the mirror.** Same class, same fix, in
  the two array-returning panels that were unguarded: **Trash** and **History** normalize a non-array
  response and say "Could not load…" instead of "empty"/"no versions" (deep search, block search and
  the tags panel were already `Array.isArray`-guarded). Any new consumer that assumes an API response
  shape needs the same one-line guard — a reachable-but-wrong response is not a connectivity error and
  nothing upstream will catch it for you.
- **Single-column tree is LAZY-built — a collapsed folder's `.tree-children` is left unbuilt
  (`data-lazy="1"`, empty) and constructed on first expand (tree.js `renderTreeNode` folder branch +
  its `toggleExpand`).** This is what stops the sidebar scaling with library size (collapsed
  `renderTree()` dropped ~12ms→~0.2ms at 1200 pages). **Consumer-path contract — anything that must
  reach a collapsed row MUST force the build first or operate on DATA, not the DOM:** a non-empty
  search sets `forceOpen` (filtered tree via `filterTree` is always fully built — laziness never
  hides a result); `openPage`/`revealTreeRow`/duplicate flows call `expandAncestors` (→
  `expandedFolders` → `renderTree` builds the chain eagerly) BEFORE scrolling to the row; persisted
  `expandedFolders` build eagerly; keyboard ArrowRight-expand routes through `activateTreeItem →
  click → toggleExpand` (children exist before the next `visibleTreeItems` query); drag/reorder +
  `primeOfflineCache` walk `treeData`, not the DOM. **`toggleExpand` re-runs
  `initRovingTabindex(#tree)` after a lazy build** so the freshly-built rows join keyboard traversal
  with exactly one `tabindex=0` preserved (it bails when one already exists). Miller (double) already
  renders only its 2 visible columns, so laziness there is inherent — its win is the memoized
  aggregates. Don't add a path that touches a collapsed subtree's rows without expanding it first.
- **`openPage` dedups concurrent/rapid opens.** It's async (awaits `get_page`), so a rapid
  double-click or N calls in one tick would each pass the "already open?" check before any push and
  create duplicate tabs. An in-flight `_openingPages` Map (editor.js) makes concurrent opens of the
  same path reuse one fetch/tab. Don't drop it.
- **`writeJsonAtomic($path, $json)` is the SINGLE write path for every JSON file (api.php).** All
  page/metadata writes (`save_page`, `create_page`, `replace_content`, `rename_tag`, `writeOrder`,
  `writeColSorts`, `flushIndex`, `snapshotHistory`, the trash `.meta`) go through it: write a
  **per-write-unique dot-prefixed temp** (`.tmp-<uniqid>`) in the target dir, then `rename()` over the
  target (atomic on POSIX → a crash mid-write can never truncate a page). **The temp name MUST be
  unique** — a fixed `<path>.tmp` would let two concurrent `save_page`s clobber each other's temp
  before either renames (defeating the LOCK_EX serialization). The dot prefix keeps an orphaned temp
  invisible to `buildTree`. (Linux/macOS only; Windows can't `rename()` over an existing file, but
  api.php never runs there.) **The CI invariant now bans the write PRIMITIVES, not one shape.** The
  old grep only matched an inline `file_put_contents(…, json_encode(…))` — which is why
  `restore_history` slipped through for a whole release writing a live page with a raw **`copy()`**
  (a crash mid-copy truncates it: precisely the failure the helper exists to prevent), and why the
  split form (`$j = json_encode(…); file_put_contents($p, $j);`) would too. The `invariants` job now
  fails on ANY `copy(`/`fwrite(`/`fputs(`/`file_put_contents(` in `api.php` outside two allowlisted
  lines (the helper's own temp write, and the EMPTY `.project` marker) — every write shape, however
  many lines it spans, has to end in one of those primitives. Route new writes through the helper;
  don't extend the allowlist without a very good reason.
- **`snapshotHistory` version keys must never go BACKWARDS (api.php).** The key is the page's mtime
  (second-granularity), bumped to the next free integer on collision. Once a page hits `HISTORY_KEEP`
  (20), the prune frees the LOW keys again — so a burst of same-second saves (autosave is
  per-keystroke) restarted at the page mtime, landed on a just-freed low key, and the next prune
  deleted the version *just written*: every save after the cap was silently discarded and history
  froze at the first 20. Fixed by starting at `max(mtime, highest existing key + 1)`, and by pruning
  with a **numeric** `usort` on the basename rather than a lexicographic `sort()` of full paths
  (which only happened to work while every key had the same digit count). Pinned by a tests-api case
  (25 saves → exactly 20 versions, extremes assert the surviving window is the NEWEST 20).
- **`snapshotHistory` must NOT version the `create_page` stub as a page's FIRST entry (api.php).**
  `create_page` writes `{"title":…,"sections":[]}` and any create-then-immediately-save sequence
  (`importPages` restoring a bundle, `duplicatePageFromTree`, a queued create+save replaying on
  reconnect) saves the real content one call later — so the stub got snapshotted, and **after
  restoring a JSON backup every page's ENTIRE history was that one 47-byte empty version.** The
  History panel presented it as a normal restorable version with a blue Restore button, and restoring
  it EMPTIED the page — while the real prior versions had never been in the bundle. Worse than no
  history: a loaded gun where the safety net should be. The guard lives in `snapshotHistory`, NOT in
  the importer, because the root cause is the create-then-save sequence, not import. **Both
  conditions are load-bearing and together bound it to a page's very first snapshot of content
  nobody authored:** (1) the page has **no versions yet** — anything ever saved is untouched, so a
  page a user DELIBERATELY emptied still versions normally (its real content is already in history,
  and the empty state it was emptied *into* is snapshotted by the next save like any other content);
  and (2) `isCreatePageStub($old, basename($path,'.json'))` — structural (not a byte compare, so
  re-formatting can't break it) and exact on all three counts: EXACTLY the keys `title`+`sections`,
  `sections` empty, and **the title `create_page` itself derived from the filename**. That title
  check is not decoration — dropping it makes the rule "any empty-sections page", which silently
  discards every authored title of a page renamed but never given a section, and **fails 28 existing
  tests-api assertions** (measured). Fail OPEN: snapshotting a stub is noise, failing closed loses
  data — never widen this, and never suppress a snapshot of content a user could have authored.
  Pinned by tests-api (zero versions after create→save · no listed version would destroy the page ·
  the next save DOES version · deliberately-emptied · title-only), which go RED on removal.
- **`.index.json` is read LAZILY via `loadIndex()` (api.php).** Only the three index-using actions
  — `tree`, `rebuild_index`, `list_tags` — call `loadIndex()` (idempotent, guarded by `$indexLoaded`);
  EVERY other request skips the (potentially large) index read entirely. `list_tags` is now
  index-backed (`pageMetaIndexed` + `flushIndex`, mirroring `tree`) — a warm call reuses cached
  tags/langs and only re-parses pages whose mtime moved (target ≤5 ms warm). Don't reintroduce an
  eager top-level index read; a new index-consuming action must call `loadIndex()` first.
- **`search_content` has a raw `stripos` fast path (api.php).** Pages are stored `JSON_UNESCAPED_UNICODE`
  (`save_page`), so most content — incl. UTF-8 — matches the raw JSON directly without a decode. The
  expensive decode-and-re-encode-unescaped fallback runs ONLY when the raw haystack MISSES **and** the
  query is non-ASCII **or contains `/`/`\`** (`preg_match('/[^\x00-\x7F]/', $q) || strpbrk($q, '/\\')`).
  Both conditions matter: a page written with `\uXXXX` escapes needs the non-ASCII branch; a page whose
  content has a `/` written with **bare** `JSON_PRETTY_PRINT` stores it as `\/` on disk, so a slash-bearing
  ASCII query (`api/v1`, `TCP/IP`) raw-misses and needs the slash branch (WITHOUT it the page is silently
  hidden from the search — do NOT narrow this back to non-ASCII only). The pinned tests-api cases (a
  `\uXXXX`-on-disk file AND an escaped-`\/` file, both exercising the fallback) must stay green. Common
  ASCII-no-slash queries keep the fast path. **Also:** `replace_content`/`rename_tag` now write
  `JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES` (matching `save_page`) so a
  *rewritten* page re-stores `/`/UTF-8 literally and matches via the fast path — but this does NOT
  retroactively fix pages already on disk with escaped slashes, so the fallback broadening is the
  necessary fix; the writer normalization just stops new escaped-slash/unicode writes.
- **The five content-scanning actions skip dot-dirs via `contentFileIterator($base)` (api.php).**
  `list_tags`, `search_content`, `search_blocks`, `replace_content`, `rename_tag` all iterate through it
  — a `RecursiveCallbackFilterIterator` that returns false for any dot-prefixed entry, so it NEVER
  descends into `.history`/`.trash` (which on a mature library hold ~20 versions/page = tens of thousands
  of hidden files that would otherwise be stat'd, blowing the ≤5 ms warm `list_tags` target). Each caller
  keeps its in-loop `/.'`-in-path skip as belt-and-suspenders. **`rrmdir`'s iterator is deliberately NOT
  filtered** — the delete path MUST walk dot-dirs. Route a new content-scanning action through
  `contentFileIterator`, never a bare `RecursiveDirectoryIterator($base, …)`.
- **API-response gzip is OPT-IN behind `CODEMAN_GZIP=1` (api.php, OFF by default).** `ob_gzhandler` is
  engaged only when the env/`$_SERVER` flag is `'1'` (and `zlib.output_compression` is off). It's a
  **deploy gate**: a NAS nginx might already gzip PHP output, and double-compression corrupts the body
  — enable it ONLY after confirming nginx isn't compressing `api.php`. The desktop path is always safe:
  the proxy's `fetch()` (undici) decompresses transparently and re-serves identity, so the renderer
  never sees gzip — `CODEMAN_SMOKE=1`'s `gzip` probe asserts a well-formed body + no round-trip regression.
- **`rename`/`move` migrate the `.history` subtree (api.php `migrateHistory`).** After the main
  `rename()`, the page's/folder's `.history/<rel>` is `@rename`d to the new rel (best-effort — a
  missing/locked history never fails the action; both rels `safePath`'d). If the **destination history
  already exists** (a prior same-named item left it behind), it does NOT clobber and does NOT strand:
  `mergeHistoryDir` recursively carries the source's non-colliding version files across (a colliding
  `<ts>.json` = same version, skipped) then drops the drained source, so the moved page isn't
  mis-attributed to stale history. The **offline**
  mirror mirrors this: `mutateTreeCache`'s rename/move branches call `collectRepathPairs` (captured
  BEFORE `rePath` mutates paths) + `rekeyCachedPaths` to move the cached page content **and** local
  history from the old key to the new one — else an offline rename shows a blank page under a name
  that no longer exists.
- **Dead-letter queue = the anti-silent-loss guarantee (offline.js + features.js).** A queued write
  the server *rejects* (terminal 4xx, a `_transient` error that outlives 3 retries, or a conflict-force
  that still errors) is **parked** as a dead-letter, NEVER `shift()`-dropped (that bare shift was the
  bug). **It is no longer only a REPLAY mechanism:** a live, ONLINE save the server rejects parks here
  too (editor.js `handleSaveError` — see the rejected-save gotcha), so the panel is the one recovery
  surface for "the server refused this write", offline or not.
  Each is its own kv entry keyed `kvKey('dl:'+id)` = `<NS>\x1F dl:<id>` — so retry is
  **namespace-locked by construction** (the `dl*` helpers + `kvEnumerate('dl:')` only ever touch the
  ACTIVE namespace; a parked op can't replay against the wrong server, same guarantee as the queue).
  Key shape is shared with the **now-live** per-page `history:<path>` keys (`<NS>\x1F<kind>:<suffix>`)
  so `kvEnumerate` serves both — no second migration. `flushQueue` classifies via `res._transient` (set by core.js on a
  malformed body), NOT string-matching — and both the normal path AND the **conflict-force resend** run
  the same 3-attempt retry before parking a transient (only a genuine terminal parks immediately). The
  `openDeadLetterPanel` (features.js) groups by `cascadeOf` with the **failed parent `create_*` hoisted
  to head its own group** (parent + blocked dependents contiguous), and soft-caps at 100 with an
  **export prompt, never eviction**. `__codemanAdoptInto` **merges** (queue/trash concat, history
  per-path merge, dl: copied) — never overwrites the target namespace's own unsynced work. **Recovery
  reach (a11y):** the badge is a **keyboard-operable `role=button`** (Enter/Space) that switches to a
  distinct **`.danger` (red)** state for dead-letters (louder than routine amber offline/queued); the
  panel is also reachable from the command palette + sidebar `⋯` menu, both gated on `dlCountCached()>0`
  (a sync cache refreshed by `updateOfflineBadge`).
- **Local history is per-page `history:<path>` kv keys, not one `history` blob (offline.js).** Each
  page's version log is its own kv entry (`kvKey('history:'+path)` = `<NS>\x1F history:<path>`, the same
  `<kind>:<suffix>` seam as `dl:`), same `{ts,size,data}` array shape. The four reducers
  (`recordLocalHistory`/`offlineListHistory`/`offlineGetHistory`/`offlineRestoreHistory`), the offline
  rename/move re-key (`rekeyCachedPaths`), and `__codemanAdoptInto`'s history merge all read/write per-page
  keys — one place each; don't reintroduce the single-blob reads. **`migrateHistoryKeys()` (boot IIFE,
  after `migrateLegacy`) is the one-time fold off the old blob and is the highest-risk item — its three
  invariants are load-bearing:** (a) **ALL NAMESPACES** — it cursors every `<ns>\x1F history` blob (not
  just the active one) so a stranded namespace's local history migrates too; (b) **IDEMPOTENT** — it
  writes a `history:<path>` key ONLY where the target is ABSENT, so a re-run or a crash-then-retry never
  double-appends or clobbers newer per-path data; (c) **LEGACY-RETAINED** — it leaves the `history` blob
  in place (rollback-safe: reverting the code restores the old read path losslessly, mirroring
  `migrateLegacy`) and sets a per-ns `__history_migrated` flag **only after** that namespace's paths are
  all written — so a mid-transform crash (flag never set) is safe to retry on the next boot, and a second
  boot is a cheap no-op. Unit-tested in tests.html (per-path keys, legacy intact, flag, no-op re-run,
  present-target-no-clobber, mid-transform retry).
- **`flushSave` is dirty-guarded; unload uses keepalive, not `sendBeacon` (editor.js).** `pageDirty`
  (a Set of paths) is marked in `scheduleSave` (the one choke point every mutation funnels through) and
  cleared in `savePage` ONLY on a successful non-conflict save (mtime OR queued-offline branch; and NOT
  while a mid-save edit is pending re-save). `flushSave` early-returns when the active page isn't dirty
  — so a tab switch / unload on an **unchanged** page does ZERO writes (no history churn, no mtime
  bump). **Semantic change C11:** a stale-but-clean tab no longer self-heals `baseMtime` on tab switch
  (it didn't earn a write). The unload path is a **`keepalive` fetch through `apiHeaders()`** (carries
  auth — a header-less `sendBeacon` would 401 on a gated server), falling back to `enqueue()` if the
  browser refuses it (offline/quota) — never a silent drop. `visibilitychange→hidden` is the PRIMARY
  trigger (fires reliably, keepalive completes); `beforeunload` is a backstop (an IndexedDB write
  started there isn't guaranteed to finish). Don't reintroduce `sendBeacon` or gate the triggers on
  `saveTimer` — the dirty guard is the gate. **Contract / latent trap:** because a page only persists
  on tab-switch/unload if it's in `pageDirty`, **every mutation MUST route through `scheduleSave()`** —
  a new mutation path that forgets it will silently fail to persist on switch/unload. That contract is
  locked by a `tests.html` regression guard (`scheduleSave` marks dirty · `flushSave` writes a dirty
  page but not a clean one · clears on success); keep `scheduleSave` the single choke point.
- **A save the SERVER REJECTED must be PARKED, never announced as "Saved" (editor.js
  `handleSaveError`).** `apiFetch` deliberately RESOLVES a reachable server's 4xx (a 4xx is a real
  response, not "offline") and a malformed 200 (core.js tags it `_transient`) — so for a long time
  `savePage` handled `res.conflict` and `res.offline` but had **no `res.error` branch**, and an error
  body fell straight through to `pageDirty.delete()` + `toast('Saved')`. Measured: another device
  deletes the open page's folder → `404 {"error":"parent folder does not exist"}` → the client says
  **"Saved"**, the page goes clean, queue 0, dead-letters 0, **zero page errors**, and after a reload
  the edit exists NOWHERE. (It was masked for a while by `cacheOnSuccess` accidentally mirroring the
  attempted write; hardening THAT correctly — never mirror a response the caller can't use — is what
  made the loss total. Don't "fix" it there.) The rule now: **an error response routes into the same
  anti-silent-loss machinery `flushQueue` uses** — a `_transient` goes to the write QUEUE (its
  existing 3-attempt-then-park policy owns transients), a terminal 4xx is parked STRAIGHT as a
  `dl:` dead-letter (it can never succeed as-is), and `pageDirty` is cleared ONLY because the edit is
  now durably in IndexedDB — the identical justification as the `offline` branch. If parking itself
  throws, the page stays DIRTY. Two corollaries: the parked op is `force:true` (a replay must not
  re-conflict on a dead `baseMtime`), and repeated failures on one page **supersede our own** previous
  entry via the `saveDeadLetters` path→id map (each entry is a FULL page snapshot, up to 1 MB for an
  html project — one per autosave burst would flood both IndexedDB and the panel; only ids this
  session created are replaced, never a `flushQueue`-parked op, which is a different op with different
  content). **THREE call paths reach the same server action and all three needed it:** `savePage`,
  `handleSaveConflict`'s forced resend (a rejected force must not claim "Saved (overwrote disk
  version)"), and `flushSave` — whose non-keepalive `.then` cleared `pageDirty` unconditionally, and
  whose keepalive path only caught a REFUSED fetch (`p.catch`), not one that RESOLVES with a 4xx (now
  `p.then(r => !r.ok && requeue())` — on `visibilitychange→hidden`, the primary trigger, the document
  is still alive so it runs; on `beforeunload` it may not, which is best-effort by nature). A future
  branch on a save response must decide error-vs-success explicitly; "not conflict, not offline"
  is NOT "success".
- **`savePage` is the SINGLE 'Saved' announcer — a render path must NEVER toast it (editor.js).** All
  five block-Save handlers used to do `savePage(); toast('Saved');` with `savePage()` **un-awaited**, so
  the announcement raced the write: on the healthy path "Saved" fired **twice** through the
  `role=status aria-live=polite` channel, and on a rejection the FALSE "Saved" landed first and was only
  contradicted a full request-window later — partly undoing the rejected-save fix above. The handlers
  now just call `savePage()`, which toasts after the write is confirmed (and stays silent on the
  `res.error`/`res.conflict` early-returns). The `saveInFlight` re-save path still announces, because
  the finally-block re-save runs the same code. The offline branch says **"Saved offline — will sync"**:
  a queued write is durable but is not on the server, and borrowing the plain "Saved" made the amber
  badge the only hint. Guarded behaviourally (a real `renderBlock` Save: silent-until-resolved, exactly
  once, none on rejection) **and** by a `.toString()` census over the five render paths — the per-kind
  drift has no other observable signature, same reasoning as the edit-session wiring census.
- **Offline tree-row Duplicate must ask the MIRROR, not the response (editor.js
  `duplicatePageFromTree`).** The hit/miss discriminator was `d._mtime == null` — but `cacheOnSuccess`
  **deletes** `_mtime` before mirroring (offline.js) and `offlineApi`'s miss placeholder is
  `{title, sections:[], _mtime:null}`, so a genuine cache **HIT was byte-indistinguishable from a
  miss** and the guard rejected BOTH: the `❐` on a tree row was dead offline for every page not
  currently open, defeating the advertised `primeOfflineCache` / "Download for offline". It now tests
  `await pageGet(node.path)` — presence in the mirror is the actual question. Don't reintroduce a
  response-shape test: the placeholder is deliberately shaped like a real empty page, and the loose
  `cacheOnSuccess` `get_page` guard means a cached page may legitimately lack `sections` too.
- **Prose `overflow-wrap: anywhere` must be RESET on table cells (style.css).** `.block.note
  .code-view` and `.rich-surface` set `overflow-wrap: anywhere` so a long unbroken token wraps instead
  of blowing the block out (TC-hscroll-11) — but that property **inherits**, so it reached `<th>`/`<td>`,
  and `anywhere` (unlike `break-word`) **contributes its break opportunities to MIN-CONTENT sizing**.
  Every column therefore collapsed to ~one character, the auto table layout always shrank to fit, and
  the `overflow-x:auto` on those `display:block` tables was **unreachable** (measured at 1440px: 20
  columns → 45×70px cells, `scrollWidth == clientWidth`, no scrollbar until 30 columns had already been
  crushed). Cells now set `overflow-wrap: break-word; word-break: normal` — min-content-neutral, so
  columns keep their natural width and a wide table genuinely overflows and scrolls (20 columns →
  80×31px, `1711 > 939`). **Scope the reset to cells only; the prose `anywhere` is deliberate.**
  **`word-break: break-word` is the DEPRECATED ALIAS for `word-break: normal` + `overflow-wrap:
  anywhere` — so it causes the identical defect under a different property name; never put it on a
  table cell.** That is exactly what `.csv-table` carried, which is why the CSV block stayed broken
  for two releases after note/rich were fixed (and why an early draft of this note wrongly cited
  `.csv-table` as the reference implementation — it was the *last* victim). Measured pre-fix at
  1440px: 20 columns → 45×59–75px cells, `.csv-table-wrap` `scrollWidth 939 == clientWidth`; at 390px,
  31×171px cells. The reference implementation is the **declaration**, identical in all three places
  (`.block.note .code-view`, `.rich-surface`, `.csv-table` cells): `overflow-wrap: break-word;
  word-break: normal` — plus `white-space: pre-wrap` on CSV cells, which is orthogonal (embedded
  newlines) and min-content-neutral. `pageToHtml`'s export CSS never set `anywhere` **nor**
  `word-break`, so the export path had nothing to fix — its `table.csv` already scrolled correctly,
  i.e. the in-app view was worse than its own exported copy. **Don't mirror the reset into the export
  CSS**; there is nothing there to reset.
- **`navigator.storage.persist()` on boot (init.js) + `apiHeaders()` single header attach point
  (core.js).** Persist keeps the IndexedDB mirror/queue/dead-letters from being evicted under storage
  pressure (best-effort, no prompt). `apiHeaders()` is the ONE place request headers are built — both
  `apiFetch` and the keepalive unload-save use it, so auth (and future request-ids) can't drift.
- **Release checklist — bump `version.js` for any client-shipping phase.** A phase that changes
  `codeman/src/*.js`, `style.css`, or `index.html` (like this one) ships new SW-precached assets — the
  `version.js` bump (→ new `CACHE_VERSION`) is what busts the old service-worker cache. Do it as part
  of the release cut (see the CI section), not per intermediate commit, but never ship the client
  without it.

---

## Persisted client state

**localStorage:** `codeman.sidebarMode` (defaults to `double`), `columnPath`, `selectedFolder`,
`millerColScroll`, `expandedFolders`, `openTabs`, `sidebarWidth`, `sidebarHidden`, `deepSearch`,
`favorites`, `recentCopies`, `authToken` (only when the password gate is on), `exportNudgeAt` +
`exportNudgeOff` (offline-only desktop backup nudge).
**IndexedDB `codeman`:** store `kv` holds `tree`, `queue` (pending writes), `trash` (local
recoverable deletes), per-page `history:<path>` **local version logs**, per-op `dl:<id>`
**dead-letters** (writes the server rejected, awaiting review), and a `__history_migrated` flag — all
keys namespaced per server (`<NS>\x1F…`); the legacy single `history` blob is retained (rollback-safe)
after `migrateHistoryKeys` folds it into the per-page keys. Store `pages` holds cached page content. **Desktop wrapper:** `settings.json` in the OS user-data dir holds
the server URL or `{offlineOnly:true}`.

---

## Security / safety

- `safeName()` rejects path separators, `..`, and leading `.` for all create/rename names.
  **`safePath($base, $rel)` now REJECTS the whole path (returns `null`) if ANY segment is `.`,
  `..`, or dot-prefixed** (a hidden/system file), mirroring `safeName` — empty segments (doubled/
  edge slashes) still silently drop, and an empty `$rel` still resolves to `$base` (root ops). It
  used to *strip* `..`/`.` and keep going, which still let a dotfile read/delete resolve (`get_page
  {path:".index.json"}`, `delete {path:".history"}`) and left `list_history` on a **raw concat**
  traversal hole. **EVERY caller must treat `null` as reject:** the ~18 action call sites →
  `jsonError('invalid path')`; the `empty_trash` loop → **skip the entry's history prune, never
  `rrmdir` a null path**; `restore_trash` → error (a crafted `.meta` `origPath` stays inert);
  `list_history` → `[]`; `migrateHistory` and `snapshotHistory` route `$rel` through `safePath`
  INTERNALLY and no-op (best-effort) on `null`, so a future unguarded caller can't reintroduce a
  `.history` traversal via those helpers. Any new path built from a stored/echoed value must be
  `safePath`'d and null-checked the same way.
- **CSRF: send everywhere, enforce on BOTH the server and the proxy.** Every request carries an
  `X-CodeMan-Request: 1` header, attached at the single choke point `apiHeaders()` (core.js) — so
  normal calls, `flushQueue` replay (incl. queues parked by an OLDER client — headers attach at SEND
  time), and the keepalive unload-save all send it. **`api.php` NOW enforces it** (deny-by-default),
  right AFTER the auth gate (a gated request with no token still 401s first): a `$csrfReadOnly`
  allowlist (`tree`/`col_sorts`/`get_page`/`list_tags`/`list_trash`/`list_history`/
  `get_history_version`/`search_content`/`search_blocks`) may run header-less; **every other action —
  including any FUTURE one — needs the header** (implemented as `!in_array($action, $csrfReadOnly) &&
  no header → 403`, so a newly added write is fail-CLOSED, never fail-open). The 403 is a **clean 4xx**
  (`jsonError('missing request header', 403)`) so a straggler offline client DEAD-LETTERS the write
  (Phase-2 panel, recoverable) instead of treating a 5xx as "offline" and retrying forever.
  **Break-glass:** `CODEMAN_CSRF=off` (read from BOTH `getenv` AND `$_SERVER` — the PHP-FPM
  `clear_env` gotcha, deliver via nginx `fastcgi_param` like `CODEMAN_DATA`) accepts header-less
  writes during a migration/straggler window. **This allowlist mirrors the desktop proxy's
  `READ_ONLY_ACTIONS` EXACTLY — keep the two in sync; a divergence is a bug.** **Deploy precondition
  (release-cut checklist):** R3 (header-sending client) must be live on the NAS AND all desktop installs
  updated BEFORE enabling enforcement, or an older client's writes get 403'd → parked as dead-letters.
  The **desktop proxy (`main.js`) ALSO enforces it**: a mutating action (anything outside the
  `READ_ONLY_ACTIONS` allowlist — the read actions `tree`/`search_*`/`list_*`/`get_page`/
  `get_history_version`/`col_sorts`) without the header is 403'd, an anti-trampoline guard that's safe
  because the renderer always sends it. **HPP guard:** the proxy classifies the
  action from `searchParams`, but PHP's `$_GET['action']` takes the LAST value — so `?action=tree&
  action=save_page` would sneak a write past the read-only check; the proxy therefore **rejects any
  `/api.php` request carrying more than one `action` param outright** (a legit client never sends two).
  The proxy also confines `/api.php`, `/__config`, `/__test` to its own loopback origin
  (`sameOriginOk`: Host must be `127.0.0.1:<port>`; and for STATE-CHANGING requests — non-GET writes,
  `/__config`, `/__test` — the browser `Origin` must be PRESENT and match, `{requireOrigin:true}`, so a
  header/Origin-less mutating request can't slip through on Host alone; reads may omit Origin). It pins
  top-level navigation via a `will-navigate` handler AND matches the `setWindowOpenHandler` origin by
  **parsed host** (`new URL(url).host === '127.0.0.1:<port>'`), never a string prefix — else
  `http://127.0.0.1.evil.com/` reads as internal. `/__test` targets are restricted to http(s).
- **CSP + nosniff.** `index.html` ships a `<meta http-equiv="Content-Security-Policy">`:
  `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src
  'self' data: https:; object-src 'none'; base-uri 'none'`. `'unsafe-inline'` is REQUIRED (no build
  step): inline `onclick=` handlers, the inline `<script>` loaders, and the inline `ED_*` element
  styles. All vendored/executable code is same-origin `'self'` (the Prism autoloader injects
  same-origin `<script src>`; `?v=` cache-bust queries don't change the source origin; markdown-it +
  the SW are same-origin). **`pageToHtml`'s standalone export now emits the SAME CSP `<meta>`** —
  without it an export carrying a live HTML-project iframe would be strictly LESS restrictive than
  the app itself; `'unsafe-inline'` there covers the export's own inline `<style>`. **`img-src`
  includes `https:` + `data:`** so remote https images referenced in **note** blocks — and, since the
  D-1 sanitizer pass, images in **rich** blocks too (that sentence was aspirational before: `IMG`
  wasn't in `RICH_ALLOWED`, so a pasted rich image was deleted) — render. A self-hosted snippet
  manager legitimately references remote images; plain
  `http:`/other schemes stay blocked — no mixed content, marginal exfil risk under the trusted
  single-user model. **`richImgSrc` enforces exactly this policy client-side** (`https:` +
  non-SVG `data:image`), so a stored rich block can never carry a src the CSP would block anyway. At the release cut the **NAS nginx** deployment must ALSO send this header +
  `X-Content-Type-Options: nosniff` in `default.conf` (can't be set from a `<meta>`; deployment step).
- **Projects nest only in projects:** `create_project` and `move` reject placing a `.project`
  folder anywhere except the root or inside another project (a parent with its own `.project`
  marker) — also guarded client-side via `isValidProjectParent`.
- **Optional password gate:** set `CODEMAN_PASSWORD` (env or web-server param) and `api.php`
  requires it on every request via `hash_equals` (`X-CodeMan-Auth` header **only** — the old
  `?token=` query fallback was removed: a secret in the URL leaks into logs/history/`Referer`).
  **Off by default** (open, trusted-LAN assumption). The client prompts once on a 401, stores the token,
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
