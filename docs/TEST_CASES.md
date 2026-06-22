# CodeMan — Regression Test Cases

The definition of "full regression" for CodeMan. Full regression is run by the
**[senior-qa-engineer](../.claude/agents/senior-qa-engineer.md)** agent (it plans, executes,
and reports against this matrix); UI/usability passes are run by the
**[ui-ux-reviewer](../.claude/agents/ui-ux-reviewer.md)** agent.

> **Maintaining this file:** keep it in sync with the code. When a feature is **added or
> changed**, add/update the relevant `TC-<area>-<n>` case(s) here (and a matching assertion in
> the automated suites where possible) in the **same change**. This file is the source of truth
> for what regression covers — a fix without a case here is an untested fix. Mirror the
> `docs/images` regeneration discipline noted in [CLAUDE.md](../CLAUDE.md).

## How to run

1. **Automated suites first** (fast, deterministic):
   - **Client units** — open `codeman/tests.html` in a browser. Expect the summary
     **"N passed, 0 failed"** (currently 120). `window.__testResult = {pass, fail}` for scripting.
   - **Server API** — `bash codeman/tests-api.sh` (spins a throwaway `php -S` against a temp data
     dir; exit 0 = all green; currently 28). Override port: `bash codeman/tests-api.sh 8099`.
2. **Then the manual/driven Core suite below**, against a running dev server
   (`cd codeman && php -S localhost:8090`, data falls back to `structures/`). Drive via the
   browser-preview MCP and/or Chrome MCP. Test **both layouts** (single + double/Miller) and
   **desktop + ≤768px mobile**. Use a **throwaway dataset** and restore it afterward — never test
   against real/private data.

Each case lists **dimensions** to cover: **P**ositive · **N**egative · **E**dge ·
**A**buse/adversarial · **Pe**rformance. Cases marked **[auto]** are covered by a suite above.

---

## CORE — run every regression

### TC-tree — Sidebar tree (single + Miller/double)
- TC-tree-01 (P/E): renders folders-before-pages; recursive counts, aggregated code-types + top
  tags on Miller folder cards; empty tree → onboarding state.
- TC-tree-02 (P): single↔double layout toggle persists (`sidebarMode`, default `double`); Miller
  shows exactly 2 columns; left/right rails page the window.
- TC-tree-03 (A11y): `role=tree`/`treeitem`, roving `tabindex` (exactly one `=0`), `aria-expanded`
  on folders; project rows are aria-labelled "project" (single + Miller), folders "folder".
- TC-tree-04 (P): keyboard nav — Enter/Space activate (both layouts); single-column Up/Down/Home/
  End + Left/Right expand-collapse/parent; bail when focus is in an INPUT (don't hijack rename).
- TC-tree-05 (E): hide sidebar → desktop rail; mobile → floating hamburger + drawer + backdrop.

### TC-crud — Create / rename / delete (inline rows)
- TC-crud-01 (P): create project/folder/page targets the selected folder; new items prepend.
- TC-crud-02 (N): rejected names — `/`, `\`, `..`, leading `.` → "invalid name"; spaces allowed. **[auto: tests-api]**
- TC-crud-03 (N): create_page/save_page with a **missing parent** → clean `404 {"error":…}`, no PHP
  warning, nothing written; valid parent → 200. **[auto: tests-api]**
- TC-crud-04 (E): inline create — `✓`/`✕` visible; **blur cancels** (not auto-commit).
- TC-crud-05 (A): rapid double-create / duplicate names are no-ops (create_* skip if present).
- TC-crud-06 (P): delete is a **soft** delete — the confirm copy says it moves to Trash (restorable
  from the `⋯` menu), not "cannot be undone"; the item lands in `.trash/` and restores.

### TC-drag — Drag-to-reorder
- TC-drag-01 (P): drag a page above/below another in a column → order persists in `.order.json`;
  fires `dropReorder` **exactly once**; "before" drop lands before (regression: double-fire).
- TC-drag-02 (P): drag a folder; "move into" a folder.
- TC-drag-03 (N): project into a plain folder is rejected (`isValidProjectParent`, server mirror).
- TC-drag-04 (E): in double layout, dragging an item **clears that column's active sort**.

### TC-proj — Projects & nesting
- TC-proj-01 (P): `.project` marker rendered prominently; project-chain banner + color breadcrumb.
- TC-proj-02 (N): project may live at root or inside another project, **never** in a plain folder —
  guarded client + server (create_project, move). **[auto-ish: tests.html isValidProjectParent]**

### TC-search — Search
- TC-search-01 (P): name/tag/code-type filter; results render in both layouts.
- TC-search-02 (P): deep content search (`⊃`) matches page content, incl. **unicode/emoji/CJK**. **[auto: tests-api search_content]**
- TC-search-03 (E): **deep-search cap** — a broad term matching > `DEEP_MATCH_CAP` (200) renders only
  the cap and shows the "Showing first N of M — refine your search" banner; banner hides when the
  result set ≤ cap or search cleared. **[auto: tests.html updateSearchCapNote]**
- TC-search-04 (Pe): name search + tree render stay snappy at ~1200 pages (< ~100ms render).

### TC-tabs — Page tabs
- TC-tabs-01 (P): open pages as tabs; persist across reload; close / close-all.
- TC-tabs-02 (E): mobile tab strip scrolls horizontally; "Close all" stays pinned.
- TC-tabs-03 (A): rapid double-click / concurrent open of the **same** page opens **one** tab
  (in-flight opens are deduped — regression: `openPage` TOCTOU race made duplicate tabs).

### TC-editor — Editor & blocks (code / note / rich / checklist / csv)
- TC-editor-01 (P): Edit/Save, Cancel→Revert, Copy, Duplicate, Delete per block; section collapse.
- TC-editor-02 (E): **input round-trip** — type, save, reopen → byte-identical (trailing whitespace,
  tabs vs spaces, blank lines, emoji, large paste).
- TC-editor-03 (A): **cancel/revert** — edit then Cancel/Revert restores original, no autosave of the
  edit; edit then switch tab/blur → flush-vs-discard per CLAUDE.md.
- TC-editor-04 (E): **code layer alignment** — transparent textarea stays pixel-aligned with the
  Prism overlay + gutter, line numbers ON and OFF, while scrolling, after autosize.
- TC-editor-05 (Pe/E): autosizing editors cap at 60vh (50dvh mobile), scroll past; resize handle;
  open 500-block page / 8000-line block render < ~150ms, no jank.
- TC-editor-06 (A): paste `<script>`/HTML into **note** (markdown, `html:false`) and **rich**
  (sanitizer strips script/handlers/`javascript:`) — escaping holds (security boundary).

### TC-csv — CSV / table block
- TC-csv-01 (P): add a CSV block; enter `name,age\nAda,36` → view mode renders a table with the
  first row as the `<thead>` header; Edit shows the textarea + a live preview; Save/Cancel/Revert,
  Copy (copies **raw CSV**), Duplicate, Delete all behave like other blocks.
- TC-csv-02 (E): quoting/escapes — `"Doe, John"` is one cell; `""` → a literal `"`; a newline inside
  quotes stays in one cell; CRLF input parses; `;`- and tab-delimited input auto-detect.
  **[auto: tests.html parseCsv]**
- TC-csv-03 (A): **malformed CSV never breaks the view** — an unterminated quote and rows with
  differing column counts both render a best-effort padded table under a `.csv-warn` banner (no
  throw, no blank block). Empty CSV shows the empty-table placeholder. **[auto-ish: tests.html parseCsv]**
- TC-csv-04 (E): CSV cell content is inserted via `textContent` — `<script>`/HTML in a cell renders
  as literal text (no XSS).
- TC-csv-05 (E): export — Markdown export emits a GFM table; HTML export emits `<table class="csv">`;
  round-trips on import (raw CSV preserved in `block.code`).

### TC-json — JSON tree block
- TC-json-01 (P): add a JSON block; paste a nested object/array → view mode renders a collapsible,
  typed-colored tree (strings/numbers/booleans/null); Edit shows the textarea + live tree preview;
  Save/Cancel/Revert, Copy (copies **raw JSON**), Duplicate, Delete behave like other blocks.
- TC-json-02 (P): **copy-path-on-click** — clicking a key/index copies its JS-accessor path
  (`root.records[0].Id`; non-identifier keys bracket-quoted: `root["odd key"]`); collapse/expand
  nodes via the ▸/▾ toggle. **[auto: tests.html jsonPath]**
- TC-json-03 (A): **invalid JSON never breaks the view** — malformed input shows a `.json-warn`
  banner with the parse error + the raw text in a `.json-raw` `<pre>` (no throw, no blank block);
  empty input shows the placeholder. `parseJsonSafe` never throws. **[auto: tests.html parseJsonSafe]**
- TC-json-04 (E): tree is built with `textContent`/DOM — a string value containing HTML/`<script>`
  renders as literal text (no XSS).
- TC-json-05 (E): **Format** (⋯ menu) pretty-prints with 2-space indent (no-op + toast on invalid);
  export — Markdown emits a pretty ` ```json ` fence, HTML a highlighted `<pre>` (raw fallback when
  unparseable); raw JSON preserved in `block.code` on import. **[auto: tests.html formatJson]**

### TC-convert — Block-kind conversion
- TC-convert-01 (P): code→note→rich→checklist→csv→json→code carries text; rich→other **preserves
  line breaks** (regression: detached-innerText newline loss); entities decode; code↔csv and
  code↔json round-trip raw text losslessly.
  **[auto: tests.html richToPlainText/convertBlock/parseCsv/parseJsonSafe]**

### TC-vars — Variables / copy-as
- TC-vars-01 (P): `_V_NAME_V_` fill-ins block- or section-level (mutually exclusive); toggle on/off.
- TC-vars-02 (P): Copy-as raw/fenced/escaped/one-line/vars-filled; all route through `copyText()`
  (works in insecure context via execCommand fallback) + `flashCopied`/toast feedback.

### TC-merge — Split / merge / reorder / to-subsection
- TC-merge-01 (P): per-block Split; ⛶ Merge (unified across blocks + subsections); ⇅ Reorder
  (sections + blocks); ⤵ To subsection / ⤴ Dissolve. **[auto: tests.html mergeBlocksAndSubs]**

### TC-notes — Markdown notes & links
- TC-notes-01 (P): markdown-it renders tables, strikethrough, task lists, nested lists, autolinks,
  images; note prose renders in **sans-serif** (not monospace); inline `<code>`/`<pre>` stay mono. **[auto-ish: tests.html markdown]**
- TC-notes-02 (P): cross-page `[[links]]` resolve; external links open in a new tab; GFM task boxes. **[auto: tests.html resolvePageLink]**

### TC-data — Trash / History / Save-conflict
- TC-data-01 (P): Trash soft-delete → restore / empty; **empty_trash prunes the item's history**;
  soft-delete preserves history (restorable). **[auto: tests-api]**
- TC-data-02 (P): History snapshots prior content (last 20), restore + `lineDiff`; **same-second
  saves retain distinct versions** (collision bump). **[auto: tests-api + tests.html lineDiff]**
- TC-data-03 (A): **save-conflict (2 tabs)** — stale-mtime save → modal "Overwrite / Cancel
  (discards your unsaved changes…)"; Overwrite force-saves + snapshots the other version to History
  (recoverable); Cancel reloads disk version.

### TC-prod — Productivity
- TC-prod-01 (P): Command palette ⌘K — jump to page (substring match), path-subtitle disambiguation;
  `>` command mode executes commands; Esc closes; empty/no-match handled.
- TC-prod-02 (P): Quick-paste block palette ⌘⇧K; Favorites + recently-copied.
- TC-prod-03 (P): Find & Replace across pages (literal/regex, preview dry-run, history-safe write,
  invalid regex → error); open tabs reconcile after write.
- TC-prod-04 (P): Tag manager rename/merge/delete; open tabs re-fetch after the write; mobile rows
  wrap so the usage count isn't clipped.

### TC-io — Export / Import
- TC-io-01 (P): export HTML (self-contained, title escaped) / Markdown / JSON. **[auto: tests.html pageToHtml/pageToMarkdown]**
- TC-io-02 (P/N): JSON import round-trips byte-identical; malformed / non-CodeMan JSON fails
  gracefully (no tree corruption); traversal names server-rejected.

### TC-offline — Offline + Service Worker
- TC-offline-01 (P): SW registers (secure context incl. localhost) + precaches the shell.
- TC-offline-02 (A): backend down → `offlineState` flips, badge shows queued count, reads served
  from IndexedDB; writes queue. **[auto-ish: tests.html offline reducers]**
- TC-offline-03 (P): reconnect (online event / probe / focus) → queue flushes, writes land on the
  server, badge clears; a pre-existing queue flushes on cold **online** boot.
- TC-offline-04 (N): a 401 (auth) or a malformed-but-200 body is treated as a **server response, not
  offline** — no false offline; a poisoned queued op drains rather than latching offline.

### TC-colsort — Per-column sort (double layout)
- TC-colsort-01 (P): Name/Code-type/Kind × asc/desc + Manual order; persists in `.colsort.json`;
  active sort renders a flat intermixed list. **[auto: tests.html sortMillerChildren]**

### TC-pw — Password gate (optional, `CODEMAN_PASSWORD`)
- TC-pw-01 (N): gate on, no/blank token → `401 {"error":"authentication required","auth":true}`. **[auto: tests-api]**
- TC-pw-02 (P): correct secret via `X-CodeMan-Auth` header **and** `?token=` → 200. **[auto: tests-api]**
- TC-pw-03 (P): client — first 401 → prompt → correct → retry succeeds → token stored
  (`codeman.authToken`) → reload replays it (no re-prompt).
- TC-pw-04 (N): wrong password → blocked (no data), the bad token is **not persisted**, next action
  re-prompts; a 401 does **not** flip the app offline.
- TC-pw-05 (P): **Sign out** ("Forget password" in the `⋯` menu, shown only when a token is stored)
  → clears the token + reloads → re-prompts.
- TC-pw-06 (P): desktop proxy forwards `x-codeman-auth` to a gated server.

### TC-mobile — Responsive (≤768px)
- TC-mobile-01 (P): drawer sidebar + backdrop; icon-only block toolbars + `⋯` overflow; compact page
  header + `⋯`; 40px top band; section header single row; uniform 34×32 / 30px icon footprints.
- TC-mobile-02 (E): 16px editor inputs + viewport zoom-lock; safe-area insets; no horizontal overflow
  to 360px; section title ellipsizes (no mid-word clip); tree delete is a ≥32px tap target.
- TC-mobile-03 (P): the 768px flip re-renders the open page without reload.

---

## EXTENDED — release-gate (run on demand, NOT every regression)

These need special hardware/OS/build/time, so they're excluded from routine regression and run
before a release or when the relevant area changes. **Skipping them in a Core run is expected —
say so in the report rather than implying full coverage.**

- TC-ext-browser (cross-browser): Firefox + Safari — `:focus-visible`, `env(safe-area-inset)`,
  clipboard `execCommand` fallback, SW registration differ from Chromium. *Why extended:* needs
  other browser engines installed.
- TC-ext-dmg (packaged macOS app): the built `.dmg` (not `electron .` dev) — Gatekeeper/quarantine
  ("damaged" → `xattr -dr`), unsigned-app behavior, icons, install. *Why:* requires a full
  `electron-builder` build.
- TC-ext-win (Windows build): the NSIS `.exe`, Windows paths, the git-bash version-sync `sed`.
  *Why:* needs a Windows runner.
- TC-ext-ci (CI workflow `codeman-desktop.yml`): tag-triggered build matrix + release upload.
  *Why:* fires only on a version tag; can't be exercised locally.
- TC-ext-mobile (real device): iOS/Android touch, drag, pinch/zoom-lock, standalone-PWA top inset,
  `manifest.webmanifest` install. *Why:* emulated viewport ≠ a real device.
- TC-ext-perf (scale): seed ~1200+ pages; measure tree/search/page-render + the deep-search cap.
  *Why:* slow to seed/run; covered ad-hoc, not every time.
- TC-ext-desktop-sync (native data-sync dialogs): all three `dialog.showMessageBox` branches —
  Local→Server ("Push to server / Keep"), Server→Local ("Sync now / Switch anyway"), Server A→B —
  with a queued change. *Why:* needs a running Electron instance + native-dialog interaction.
- TC-ext-concurrency (bulk/multi-client): bulk-write loops (`importPages`, `exportAll`,
  `primeOfflineCache`, `applyRename`) on single-threaded `php -S`; many concurrent clients beyond
  two tabs. *Why:* environment-specific; real deployments use nginx + PHP-FPM.
