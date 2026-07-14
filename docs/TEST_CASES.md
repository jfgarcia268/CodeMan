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
     **"N passed, 0 failed"** (currently 343). `window.__testResult = {pass, fail, done}` for
     scripting (`done` flips true after the async offline tests finish).
   - **Server API** — `bash codeman/tests-api.sh` (spins a throwaway `php -S` against a temp data
     dir; exit 0 = all green; currently 114). Override port: `bash codeman/tests-api.sh 8099` —
     a taken port is skipped automatically (bounded upward hunt), so parallel runs stay green.
   - **CI enforces both** on every push/PR: `.github/workflows/tests.yml` runs `tests-api.sh`
     (`api-tests` job), tests.html headless via Playwright + `php -S`
     (`client-tests` job — fails on any assertion failure, a 60s hang, **or a pass count below
     the FLOOR** in `.github/scripts/run-client-tests.mjs`; bump FLOOR when you add assertions),
     and a grep-based `invariants` job (sw.js version single-sourcing, api.php never precached,
     atomic JSON writes, single `setTreeData` write point, and CSRF read-only allowlist parity
     between `api.php` and the desktop proxy).
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
- TC-tree-06 (P/A11y): **lazy-build** — a COLLAPSED single-column folder leaves its `.tree-children`
  unbuilt (`data-lazy="1"`, empty); first expand (row click OR keyboard ArrowRight) builds the
  children, drops the flag, sets `aria-expanded="true"`, and keeps **exactly one** `[role=treeitem]`
  at `tabindex=0` (re-runs `initRovingTabindex`). Arrow Up/Down/Home/End then traverse the
  newly-built rows. Both single-column AND double/Miller.
- TC-tree-07 (P): **search-while-collapsed** — with all folders collapsed, a query surfacing a deep
  page (e.g. a `PageN` name match nested 2 folders down) renders its row **visible** in both layouts;
  the filtered tree is fully built (no `.tree-children[data-lazy]` remains) so no result is hidden.
- TC-tree-08 (P): **reveal-into-unbuilt-subtree** — opening a deep page from a cleared/collapsed
  tree (from search, favorites, or a duplicate) expands its ancestor chain, **builds** the subtree,
  and the page row is visible + reachable; roving tabindex stays singular. Single + Miller.

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
- TC-drag-03 (N): project into a plain folder is rejected (`isValidProjectParent`, server mirror). **[auto: tests-api move guard]**
- TC-drag-04 (E): in double layout, dragging an item **clears that column's active sort**.

### TC-proj — Projects & nesting
- TC-proj-01 (P): `.project` marker rendered prominently; project-chain banner + color breadcrumb.
- TC-proj-02 (N): project may live at root or inside another project, **never** in a plain folder —
  guarded client + server (create_project, move). **[auto: tests.html isValidProjectParent + tests-api move guard]**

### TC-search — Search
- TC-search-01 (P): name/tag/code-type filter; results render in both layouts. Matching by name
  substring / tag / lang key + display label, and folder pruning to a materialized (non-lazy) subtree,
  is **[auto: tests.html pageMatches/filterTree]**; the rendered result rows stay manual.
- TC-search-02 (P): deep content search (`⊃`) matches page content, incl. **unicode/emoji/CJK**. **[auto: tests-api search_content]**
- TC-search-03 (E): **deep-search cap** — a broad term matching > `DEEP_MATCH_CAP` (200) renders only
  the cap and shows the "Showing first N of M — refine your search" banner; banner hides when the
  result set ≤ cap or search cleared. **[auto: tests.html updateSearchCapNote]**
- TC-search-04 (Pe): name search + tree render stay snappy at ~1200 pages (< ~100ms render). Search
  keystrokes now **coalesce** the sidebar re-render (`debounce` ~120ms trailing); the in-page block
  filter (deep-search) rides the same window so it still reflects the query within ~250ms.

### TC-tabs — Page tabs
- TC-tabs-01 (P): open pages as tabs; persist across reload; close / close-all.
- TC-tabs-02 (E): mobile tab strip scrolls horizontally; "Close all" stays pinned.
- TC-tabs-03 (A): rapid double-click / concurrent open of the **same** page opens **one** tab
  (in-flight opens are deduped — regression: `openPage` TOCTOU race made duplicate tabs).
- TC-tabs-04 (A): restore ≥3 saved tabs **concurrently** — order preserved (incl. one artificially
  slow / out-of-order fetch), previously-active tab focused, a since-deleted tab skipped without
  shifting survivors, a duplicate path opens once; boot issues **2 fewer** api.php requests (no
  redundant second `loadTree`). **[auto: tests.html assembleRestoredTabs]**
- TC-tabs-05 (N): a saved tab whose `get_page` returns `{error}` (malformed server body, not a
  deleted page) is **not** opened as an empty tab **and is not forgotten** — the surviving-candidate
  set (loaded + transiently-errored, saved order) is re-persisted so it retries on the next boot.

### TC-editor — Editor & blocks (code / note / rich / checklist / csv)
- TC-editor-01 (P): Edit/Save, Cancel→Revert, Copy, Duplicate, Delete per block; section collapse.
  **Duplicate now inserts the copy DIRECTLY BELOW the source** (not appended to the section end),
  scrolls it into view with a transient pulse, and persists on reload.
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
  **[auto: tests.html sanitizeRichHtml + md escapes raw html]**

### TC-menu — Shared popup `⋯` menus (`showMiniMenu`) — a11y + positioning parity
**Every** `⋯`/overflow popup routes through the one `showMiniMenu` — block-kind menus ×3, section
`⋯`, tags menu, **per-column sort (colsort)**, page-header `⋯`, sidebar `⋯` / More, Export submenu,
and the block **Copy-as `▾`** submenu. No hand-rolled `.mini-menu` remains (grep-verified).
- TC-menu-01 (A11y): the open menu is `role="menu"`, each option `role="menuitem"` (or
  `role="menuitemradio"` + `aria-checked` in the checkable colsort menu), dividers
  `role="separator"`; the anchor button carries `aria-haspopup="menu"` + `aria-expanded` toggling
  `true` on open / `false` on close. Screen reader announces "menu" + item count.
- TC-menu-02 (A11y): **keyboard-only, all sites incl. colsort + Copy-as** — open a menu, focus
  lands on the first item; ArrowDown/Up move and **wrap** at both ends; Home/End jump to first/last;
  Enter/Space activate the focused item; Escape closes and **returns focus to the anchor**; Tab
  closes. Every menu action is operable with no mouse. **[auto: tests.html miniMenuWrapIndex]**
- TC-menu-03 (A11y): closing by outside-click or by scrolling closes cleanly (fails soft — no error
  — if the anchor was removed by a re-render); clicking the anchor again toggles the menu shut.
  Opening any menu while another is open closes the first via its `_close` path (its anchor's
  `aria-expanded` resets, its dismiss listeners are removed — no lingering `.remove()` bypass).
- TC-menu-04 (P, positioning parity — NO regression): **default** mode — a block `⋯` menu opened
  near the viewport bottom **flips upward** and stays clamped inside the viewport (left edge ≥ 8px).
- TC-menu-05 (P, positioning parity): **sidebar `⋯` (openMoreMenu)** stays **right-aligned** under
  its button (`left = r.right; translateX(-100%)`), tucked under the sidebar as before.
- TC-menu-06 (P, positioning parity): the **Export submenu** anchors to its passed rect (plain
  top/left, no clamp/flip) on desktop (from `exportBtn`) **and** on the **mobile page-header `⋯`
  path**, where it's handed the *visible* `headerMoreBtn` (never opens at 0,0).
- TC-menu-07 (P, positioning + visual parity): the **colsort menu** opens at the same plain
  top/left as before (`anchorRect`), and the active row still shows **both** a `✓` in the aligned
  24px icon column **and** the accent `.active` background; inactive rows keep the reserved column
  so all labels line up. **[auto: tests.html miniMenuHasCheck — icon-column reservation]**
- TC-menu-08 (P, positioning parity): the block **Copy-as `▾`** submenu lands in the identical
  spot as before — left clamped to `max(8, r.right − 200)`, top `r.bottom + 4` — and each item
  still copies via `copyText` (records the copy, "Copied…/Copy failed" toast).

### TC-a11y — Keyboard & screen-reader reach (AC7 / WS-5 P2/P3)
Tabs, section headers, modals, and transient feedback are operable by keyboard and announced by
assistive tech; low-contrast text and micro-type meet WCAG AA.
- TC-a11y-01 (A11y, tab strip): `#mainTabs` is `role="tablist"` (`aria-label="Open pages"`); each
  open-page tab is `role="tab"` with a unique `id`, `aria-selected` (only the active tab `true`),
  `aria-controls="page"`, and a **roving tabindex** (active tab `0`, rest `-1`). ArrowLeft/Right move
  between tabs and **wrap** at the ends, Home/End jump to first/last; moving activates that page
  (opens it) and keyboard focus follows the newly-selected tab. Enter/Space on a focused tab opens
  it. The page region `#page` is the paired `role="tabpanel"` (`tabindex=0`,
  `aria-labelledby=<active tab id>`). The mobile horizontal-scroll strip is unaffected.
  **[auto: tests.html tabArrowIndex]**
- TC-a11y-01b (A11y, tabs closable by keyboard): each tab's close **✕ is a real `<button>`**
  (`aria-label="Close <title>"`) in the Tab order — Enter/Space closes the tab, and focus lands on a
  surviving tab (not `<body>`), rebuilt via the roving tabindex. **"Close all" is a real `<button>`**
  (`aria-label="Close all tabs"`); it stays sticky/pinned on the mobile strip and is not a `role=tab`.
- TC-a11y-02 (A11y, section header): the section disclosure toggle (`.section-toggle`) is
  `role="button"`, `tabindex=0`, `aria-label="Toggle section: <title>"`, with `aria-expanded`
  reflecting collapsed/expanded state. Enter/Space toggle collapse (aria-expanded flips, the
  `.collapsed` class updates, save scheduled); click-to-collapse on the header/toggle still works;
  the mobile one-row section header is unaffected (role lives on the toggle, not the header — the
  header holds the title `<input>` + action buttons, so it can't itself be a button).
- TC-a11y-03 (A11y, modal focus trap): every `showModal` dialog (confirm, prompt, Move-to picker) is
  `role="dialog"` `aria-modal="true"` named via `aria-labelledby` → its `.modal-title`. On open,
  focus moves inside; **Tab / Shift-Tab cycle within the dialog** (first↔last, focus can't escape to
  the page); Escape closes; on close, **focus returns to the invoking element** (fails soft if a
  re-render dropped it). A dialog with no focusable control focuses the box itself.
  **[auto: tests.html focusTrapNextIndex]**
- TC-a11y-04 (A11y, live regions): `toast` and the `flashCopied` bubble are `role="status"
  aria-live="polite"` (the same polite channel the offline badge joined) — a copy / save / error is
  announced. `flashCopied` shows the bubble OR falls back to `toast`, never both → no double-announce.
- TC-a11y-05 (A11y, Move-to command): `> Move current page to…` (palette, only when a page is open)
  opens a filterable folder picker (root + every folder, current parent excluded, projects tinted);
  choosing a destination routes through **`moveItem` → `api('move')`** — the project-nesting guard,
  history migration, and offline write-queue all run exactly as a drag-move. **[auto: tests.html
  collectFolderPaths]**
- TC-a11y-05b (A11y, Move-to keyboard model — mirrors the command palette): typing filters; a
  **highlighted row** (`.move-row.active`) tracks **ArrowDown/Up** (clamped, no wrap); **Enter in the
  filter selects the highlighted-or-top match** (not a silent cancel — the prior bug); mouse hover
  re-highlights. **[auto: tests.html paletteArrowIndex]**
- TC-a11y-06 (E, slow-open affordance): opening a page whose `get_page` takes **>250 ms** shows a
  spinner on the tab strip (`.main-tabs.tabs-loading::after`) and sets **`aria-busy="true"`** on the
  strip for SR feedback, both cleared when the open settles; a fast local open never flashes it (the
  `_openingPages` map still dedups). On the **first** open (strip was `display:none`, no tabs yet) the
  strip is revealed early so the spinner paints; if that open failed the reveal is undone.
- TC-a11y-07 (A11y, contrast/micro-type): former `#777` sub-AA text (tree-empty, empty-state,
  search placeholders, lang-picker-empty) now uses `var(--muted)` (**#9aa0a8 ≈ 6.3:1** on the
  `#1e1e1e` panel — measured); the smallest micro-type is raised (project badge 8→10px, tag-remove
  9→10px); Miller paging rails widened (16→24px) for an easier click/touch target.
- **Accepted variant (non-goal):** tab arrow-keys use **automatic activation** (moving focus opens the
  page) rather than manual activation — a valid ARIA tabs variant; kept because tab switches are cheap
  and match the click behavior. Not a defect.
- **Carried residual (non-goal, UI/UX finding 12):** hover tooltips (`title=`) on icon-only controls
  are **not reachable on touch** — deliberately not addressed this phase (would need a bespoke
  long-press/tap-to-reveal tooltip layer). Icon buttons keep `title=` + `aria-label` for pointer +
  screen-reader users; documented as an accepted limitation.
- **WCAG 1.4.4 (Resize text) exception — mobile zoom-lock:** the mobile viewport sets
  `maximum-scale=1, user-scalable=no`, which technically fails SC 1.4.4 (no pinch-zoom). This is an
  **accepted, in-plan tradeoff** (per plan C7): it kills iOS focus-zoom that otherwise jumps the
  layout on every input focus, and the editor already renders inputs at **16px** to compensate.
  Non-goal to revisit unless the focus-zoom mitigation changes.

### TC-dup — Duplicate content (block / section / page)
- TC-dup-01 (P): **block** — for all five kinds (code/note/rich/checklist/csv/json), the block ⋯
  overflow menu shows **❐ Duplicate block** (no longer ⧉ — that glyph is clipboard-Copy only). Click
  it → a deep-independent copy appears **directly below** the source (editing the source afterward
  doesn't change the copy), pulses, and survives reload.
- TC-dup-02 (P): **section** — the section header shows a **⋯** button whose menu is
  **❐ Duplicate section · $ Variables · ⤴ Dissolve**. `$ Variables` shows an active state when
  section vars are on and still honors the "disable block vars first" guard/toast; `⤴ Dissolve`
  appears for **subsections only**. `⛶ Merge` and `✕ Delete` stay inline. Duplicate → a
  deep-independent "… copy" section lands directly below, with all blocks + subsections.
- TC-dup-03 (A): **legacy shape** — duplicating a section whose content is stored in the legacy
  `{tabs:[…]}` wrapper preserves that shape in the copy (raw JSON clone, no flattening).
- TC-dup-04 (P): **page (tree ❐)** — hovering a page row (single-column **and** Miller/double
  layouts) reveals a **❐** action; click → a **"… copy"** sibling page is created, the tree reloads,
  and the new row is scrolled into view + pulsed. A second duplicate yields **"… copy 2"**.
  **No tab is opened.** `get_page` round-trips the copy identical to the source (incl. live unsaved
  edits when the source page is open).
- TC-dup-05 (P): **page (header ⋯)** — the page header ⋯ menu's first item is **❐ Duplicate page**;
  click → **exactly one** new tab opens with the copy (a double-invoke still yields one tab via the
  `_openingPages` dedup).
- TC-dup-06 (A): **name collision** — duplicating into a folder that already holds "X copy" produces
  "X copy 2" (never a silent create-page no-op); duplicating "X copy" yields "X copy 2", "X copy 2"
  yields "X copy".
- TC-dup-07 (E, offline): block/section/page duplicate all succeed offline; the page path's
  `create_page` + `save_page` writes queue and **replay FIFO** on reconnect (create before save).
- TC-dup-09 (N, offline): tree-row duplicate of a page that is **not open and not in the offline
  cache** (a true miss) is **refused with a toast** ("Open this page before duplicating it offline")
  rather than silently persisting a blank copy — the offline `get_page` placeholder (`_mtime:null`)
  is indistinguishable from a real empty page. Open/primed and header-menu (live-buffer) dups are
  unaffected.
- TC-dup-08 (E): the **❐** glyph (U+2750) renders as an icon (no tofu/□) on Windows AND macOS across
  the tree row, section ⋯ menu, block ⋯ menu, and page header ⋯ menu.

### TC-hscroll — Source-editor horizontal scroll
- TC-hscroll-01 (P): code **edit mode** — a block with a >200-char single line; the colored layer
  tracks the caret as you scroll right, and **keeps tracking while typing** (no snap-back to clipped
  on each keystroke — the `max-content` `<pre>` width is set inline in `updatePreview`).
- TC-hscroll-02 (P): code **view mode** — a >200-char line scrolls horizontally; `.code-view` is
  `overflow-x:auto` and shows **no vertical scrollbar** (height is content-driven).
- TC-hscroll-03 (A): line numbers **ON and OFF** — gutter rows stay aligned with code rows while
  scrolled, and a scrolled-right line never exposes an unpainted right-edge background gap.
- TC-hscroll-04 (A): the editor **resize handle** still works (drag-to-resize unaffected).
- TC-hscroll-05 (P): **CSV / JSON** long lines scroll horizontally in their source editors. **Note**
  (Markdown) editors **wrap** instead (`white-space: pre-wrap`) — prose stays readable; a long unbroken
  string soft-wraps in the textarea (no horizontal scroll), which is correct for prose, not source.
- TC-hscroll-06 (P): the **thin dark themed scrollbar** appears only when content overflows
  (macOS overlay bars unaffected).
- TC-hscroll-07 (E): **Windows / Firefox** scrollbar theming (`scrollbar-width`/`scrollbar-color`
  vs `::-webkit-scrollbar`) and **mobile touch** horizontal scroll.
- TC-hscroll-08 (E, macOS-gated): **view mode on macOS** (browser + Electron) — a wide block of each
  kind (code, CSV table, note fenced `<pre>`, note table, rich `<pre>`, rich table, JSON tree) shows a
  **persistent themed thin horizontal scrollbar WITHOUT dragging** (the hardened `-webkit-appearance:none`
  view-scroller recipe defeats the macOS overlay auto-hide). Windows/Linux show the same themed bar with
  **no double bar**.
- TC-hscroll-09 (P): **JSON view mode** — a wide value + deep tree → `.json-tree` `scrollWidth > clientWidth`
  and scrolls horizontally like code (was equal/no-scroll before, when rows wrapped); long string values no
  longer wrap (`.json-row` `flex-wrap:nowrap`, `.json-val` `white-space:pre`); copy-path key click +
  collapse/expand toggle still work.
- TC-hscroll-10 (A): **note PROSE still wraps** (only fenced `<pre>`/tables scroll — the recipe styles
  pre/table only, not prose); code **edit-mode** overlay alignment, caret tracking, last line (line-numbers
  ON and OFF), and resize handle unchanged; **no** `-webkit-appearance:none` on edit surfaces; **no**
  `width:max-content` rule on `.code-view pre`.
- TC-hscroll-11 (E): a **note-prose** paragraph containing a very long **unbroken** string (URL / token /
  no-space run) **wraps** and stays inside the block (`overflow-wrap:anywhere` on `.block.note .code-view`)
  — it does not overflow/clip or grow a horizontal scrollbar. Fenced code + tables in the same note still
  scroll. (Prose wraps; only code/tables scroll.)

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
  individual nodes via the ▸/▾ toggle. **[auto: tests.html jsonPath]**
- TC-json-03 (A): **invalid JSON never breaks the view** — malformed input shows a `.json-warn`
  banner with the parse error + the raw text in a `.json-raw` `<pre>` (no throw, no blank block);
  empty input shows the placeholder. `parseJsonSafe` never throws. **[auto: tests.html parseJsonSafe]**
- TC-json-04 (E): tree is built with `textContent`/DOM — a string value containing HTML/`<script>`
  renders as literal text (no XSS).
- TC-json-05 (E): **Format** (⋯ menu) pretty-prints with 2-space indent (no-op + toast on invalid);
  export — Markdown emits a pretty ` ```json ` fence, HTML a highlighted `<pre>` (raw fallback when
  unparseable); raw JSON preserved in `block.code` on import. **[auto: tests.html formatJson]**
- TC-json-06 (P): **collapse-all / expand-all toggle** — the toolbar `⊟`/`⊞` button folds/unfolds
  EVERY node at once; the glyph reflects the live `<details>` state (`⊟` when any open, `⊞` when all
  closed, and it updates when a single node is toggled by hand). **[auto: tests.html makeTreeToggleBtn]**
- TC-json-07 (A): the toggle is **hidden** (`display:none`) when the view has no container nodes —
  a scalar value, an empty block, or an invalid-parse warning. **[auto: tests.html makeTreeToggleBtn]**

### TC-convert — Block-kind conversion
- TC-convert-01 (P): code→note→rich→checklist→csv→json→code carries text; rich→other **preserves
  line breaks** (regression: detached-innerText newline loss); entities decode; code↔csv and
  code↔json round-trip raw text losslessly.
  **[auto: tests.html richToPlainText/convertBlock/parseCsv/parseJsonSafe]**

### TC-vars — Variables / copy-as
- TC-vars-01 (P): `_V_NAME_V_` fill-ins block- or section-level (mutually exclusive); toggle on/off.
  Parsing/substitution (`parseVars` dedup + first-seen order; `substituteVars` fill + `MISSING VALUE`
  fallback) is **[auto: tests.html parseVars/substituteVars]**; the picker UI stays manual.
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
  soft-delete preserves history (restorable); full delete → list → restore round-trip lands the
  file back at `origPath` with the `.meta` cleared. **[auto: tests-api]**
- TC-data-02 (P): History snapshots prior content (last 20), restore + `lineDiff`; **same-second
  saves retain distinct versions** (collision bump). **[auto: tests-api + tests.html lineDiff]**
- TC-data-03 (A): **save-conflict (2 tabs)** — stale-mtime save → modal "Overwrite / Cancel
  (discards your unsaved changes…)"; Overwrite force-saves + snapshots the other version to History
  (recoverable); Cancel reloads disk version. Server side (stale `baseMtime` → `{conflict:true}` +
  file untouched; `force:true` → write + history snapshot) is **[auto: tests-api save-conflict]**;
  the modal flow stays manual. **C11 re-baseline:** a stale-but-CLEAN tab no longer self-heals its
  `baseMtime` on tab switch (it earns no write now) — so a cross-tab conflict is only raised when the
  second tab actually has un-saved edits. Verify: open a page in 2 tabs, edit+save in tab B, then in
  tab A **just switch away without typing** → NO save, NO conflict; edit one char in tab A then switch
  → conflict modal as before.
- TC-data-04 (A): **dirty-guarded `flushSave` — BOTH directions.**
  **(a, critical)** On an UNCHANGED open page, switch tabs ~20 times (and background/foreground the
  app) → **ZERO** new History snapshots and **ZERO** mtime bumps for that page (the dirty guard must
  not let a clean switch write; and it must not be so eager it *eats* a real save). **(b)** With a
  DIRTY editor (typed <500ms before the switch/close), switching tabs / closing the tab / backgrounding
  the app still flushes the edit via a `keepalive` request carrying auth; if that write lands on a
  stale mtime it wins as a forced save and snapshots the prior version to History (nothing lost). On a
  password-gated server the keepalive save is NOT rejected (it sends `X-CodeMan-Auth`). If the browser
  refuses the keepalive (offline), the edit is queued instead — never dropped.
- TC-data-05 (P): **crash-safe atomic writes + history-follows-rename/move.** A rapid save burst leaves
  no `.tmp-*` residue and every JSON file still parses; renaming/moving a page (or renaming a folder)
  carries its `.history` subtree to the new path; moving into a destination whose `.history` already
  exists **merges** the source's non-colliding versions in and removes the stale source (no stranding,
  no mis-attribution). **[auto: tests-api atomic-writes + history-migration + dest-exists merge]**
- TC-data-06 (A): **dirty-guard choke-point contract (regression).** The mechanism (`scheduleSave`
  marks dirty · `flushSave` writes a dirty page, not a clean one · clears on success) is
  **[auto: tests.html dirty-guard]**; the live check is any block/section mutation → tab-switch persists.

### TC-prod — Productivity
- TC-prod-01 (P): Command palette ⌘K — jump to page (substring match), path-subtitle disambiguation;
  `>` command mode executes commands; Esc closes; empty/no-match handled. Also reachable without a
  keyboard: sidebar `⋯` menu → **⌘ Command palette…** opens the same palette.
- TC-prod-02 (P): Quick-paste block palette ⌘⇧K; Favorites + recently-copied.
- TC-prod-03 (P): Find & Replace across pages (literal/regex, preview dry-run, history-safe write,
  invalid regex → error); open tabs reconcile after write. Also reachable without a keyboard:
  sidebar `⋯` menu → **⇄ Find & replace…** opens the same panel. Server side (preview counts
  without writing/snapshotting, literal + regex-with-captures writes, history-snapshot-first,
  invalid regex → clean error) is **[auto: tests-api replace_content]**.
- TC-prod-04 (P): Tag manager rename/merge/delete; open tabs re-fetch after the write; mobile rows
  wrap so the usage count isn't clipped. Server side (rename, merge-dedup, empty-`to` delete,
  history-snapshot-first) is **[auto: tests-api rename_tag]**.

### TC-io — Export / Import
- TC-io-01 (P): export HTML (self-contained, title escaped) / Markdown / JSON. **[auto: tests.html pageToHtml/pageToMarkdown]**
- TC-io-02 (P/N): JSON import round-trips byte-identical; malformed / non-CodeMan JSON fails
  gracefully (no tree corruption); traversal names server-rejected.
  **[auto-ish: tests.html importPages negatives + tests-api rename/safePath guards]**

### TC-offline — Offline + Service Worker
- TC-offline-01 (P): SW registers (secure context incl. localhost) + precaches the shell.
- TC-offline-02 (A): backend down → `offlineState` flips, badge shows queued count, reads served
  from IndexedDB; writes queue. **[auto-ish: tests.html offline reducers]**
- TC-offline-03 (P): reconnect (online event / probe / focus) → queue flushes, writes land on the
  server, badge clears; a pre-existing queue flushes on cold **online** boot. Offline **cold** boot
  with saved tabs restores them from the IndexedDB mirror **concurrently**, no errors, no spurious
  online flip; on reconnect the queued write still flushes exactly once. The replay engine (FIFO
  drain, save-conflict → forced resend, network failure → queue retained + offline flip) is
  **[auto: tests.html flushQueue replay]**.
- TC-offline-04 (N): a 401 (auth) or a malformed-but-200 body is treated as a **server response, not
  offline** — no false offline; a poisoned queued op drains rather than latching offline.
- TC-offline-05 (A): **dead-letter review panel (no silent loss).** Offline, delete a folder subtree
  whose recreate later fails server-side (e.g. a create that 404s / a rejected name) → the failed
  op(s) are **parked**, not dropped: the badge shows "N changes could not sync — review", clicking it
  opens the panel grouped by the failed parent (`cascadeOf`). Each row has Inspect (pretty JSON) /
  Retry (re-queues + flushes) / Discard (confirm); footer has Retry-all / Discard-all / **Export** (a
  JSON download of every parked payload). A conflict-force that still errors, and a transient error
  that survives 3 retries, also park (never a silent `shift()`). Retry is namespace-locked — a parked
  op can only replay against the server it was made for. **Reach + severity (a11y):** the badge shows a
  distinct **red** (danger) state for dead-letters vs amber for routine offline/queued, is
  **keyboard-operable** (Tab to it, Enter/Space opens the panel), and the panel is ALSO reachable from
  the command palette ("Review unsynced changes…") and the sidebar `⋯` menu — both shown only when
  there are dead-letters. In the panel, a failed parent `create_*` heads its own cascade group (parent
  first, dependents under it); Inspect has a Copy button. The parking/classification engine (terminal /
  transient-exhausted / **conflict-force-transient retried then parked** / conflict-force-terminal,
  retry re-enqueue, `__codemanAdoptInto` queue-merge) is **[auto: tests.html dead-letter reducers]**;
  the panel UI + badge keyboard/severity stay manual.

- TC-offline-06 (N): **replay survives the safePath reject tightening.** The offline queue replays
  `enqueueReconstruct` bodies (`create_project {name,parent}`, `create_folder {parent,name}`,
  `save_page {path,data,force:true}`); a legitimate nested path (`Proj/Folder/Page.json`) must still
  round-trip after the safePath change — only `..`/`.`/dotfile segments reject. **[auto: tests-api
  offline-replay reconstruction shapes]**

### TC-sec — Server path-safety & transport (safePath reject / CSRF / CSP)
- TC-sec-01 (N): **safePath reject contract.** A dotfile read is refused (`get_page {path:".index.json"}`
  → `{"error":"invalid path"}`); `delete {path:".history"}` is refused and the dir survives; a
  traversal `get_page`/`save_page` writes/reads nothing outside the data root. **[auto: tests-api]**
- TC-sec-02 (N): **`list_history` traversal** (`path=../../..`) resolves to nothing → `[]` (was a raw
  concat). **[auto: tests-api]**
- TC-sec-03 (N): **crafted trash `.meta`** with a `../`-bearing `origPath` stays inert — `empty_trash`
  never `rrmdir`s the escaped path (sentinel outside `.history` survives) and `restore_trash` errors
  without writing outside the data root. **[auto: tests-api]**
- TC-sec-04 (N): **regex bounds.** A pathological catastrophic-backtracking find regex (`(a+)+$`) hits
  the PCRE backtrack limit → clean `{"error":"regex too complex"}` instead of hanging/silent-skip.
  **[auto: tests-api]**
- TC-sec-05 (P): **CSRF is SENT everywhere.** Every request carries `X-CodeMan-Request: 1`
  (`apiHeaders`), incl. `flushQueue` replay + the keepalive unload-save. Verify via devtools/network
  that reads + writes carry the header.
- TC-sec-05b (N): **server enforces CSRF (deny-by-default).** `api.php` now requires
  `X-CodeMan-Request` on every action outside the read-only allowlist (`tree`, `col_sorts`,
  `get_page`, `list_tags`, `list_trash`, `list_history`, `get_history_version`, `search_content`,
  `search_blocks` — identical to the desktop proxy's `READ_ONLY_ACTIONS`): a header-less mutating
  POST (`create_page`) → **403** `{"error":"missing request header"}` and writes nothing; a header-less
  read (`tree`, `get_page`) → **200**; a header-less **unknown/future** action → 403 (fail-closed).
  The check runs AFTER the auth gate (a gated request with no token still 401s first). Break-glass:
  with `CODEMAN_CSRF=off` (env or nginx `fastcgi_param`, dual-source read) a header-less write is
  **accepted → 200**. A 403 is a clean 4xx so a straggler offline client dead-letters the write
  (recoverable) rather than looping as "offline". **[auto: tests-api server enforcement;
  tests.html flushQueue parks a 403 `missing request header` as a terminal dead-letter; CI
  `invariants` job asserts the `$csrfReadOnly` ↔ `READ_ONLY_ACTIONS` allowlists stay identical]**
- TC-sec-06 (P): **desktop proxy enforces CSRF + origin + HPP.** In the Electron wrapper, a mutating
  `/api.php` POST WITHOUT the `X-CodeMan-Request` header → 403 (read actions pass); a **duplicated
  `action` param** (`?action=tree&action=save_page`, the HPP bypass — PHP takes the last, the proxy
  the first) → 403 outright; a state-changing request with a **missing/mismatched `Origin`** (or a
  rebinding `Host`) → 403 (reads may omit Origin); a cross-origin POST to `/__config` or `/__test`
  → 403; `/__test` rejects a non-http(s) target; navigation off `127.0.0.1:<port>` and a
  look-alike-host new-window (`http://127.0.0.1.evil.com/`) are blocked. Exercised by `CODEMAN_SMOKE=1`
  (`writeGuard.blocked` for both the header-less write and the dup-action request). *Extended (needs a
  running Electron instance).*
- TC-sec-07 (P): **CSP loads clean.** With the `<meta>` CSP, the app boots (inline loaders + `onclick`
  handlers run under `'unsafe-inline'`), Prism autoload highlights a code block, a note renders
  markdown (markdown-it), an export builds, and the SW registers — **no CSP violations** in the
  console. `img-src 'self' data: https:` — a note referencing a remote **https** image loads it; a
  plain-**http** remote image is blocked (verify in devtools: an https `![](…)` renders, an http one
  is refused).

### TC-transport — WS-6 transport & server efficiency (cache-bust / index / search / history keys)
- TC-transport-01 (N): **version-keyed cache-bust, 3-way.** Boot `index.html`: `version.js` loads as a
  STATIC `<script src="version.js">` (no `?v=`) so `self.CODEMAN_VERSION` exists before the modules;
  `src/*.js` + `style.css` carry a `?v=` from `cacheBustKey()` — on `localhost`/`127.0.0.1` a
  `Date.now()` value, on a real hostname `?v=<CODEMAN_VERSION>`, and on `file://` **no query** (the
  desktop wrapper — Chromium won't resolve `foo.js?v=…` off disk). SW registers; footer shows the
  version; no console errors. *Verified this phase (headless Chrome, localhost):* version.js un-keyed,
  modules `?v=<Date.now()>`, `swController:true`, 0 console errors, a code + note block render
  (Prism `.token` present, markdown-it `<h1>` in the note).
- TC-transport-02 (N): **search_content raw fast path + fallback (unicode AND slash).** A `save_page`-stored
  page (unescaped UTF-8 + slashes) matches an emoji/`café`/CJK/ASCII query via the raw `stripos` fast
  path. The decode-and-recheck fallback fires when the raw haystack MISSES **and** the query is
  non-ASCII **or contains `/`/`\`**: a page stored with `\uXXXX` escapes still matches a literal UTF-8
  query, and a page stored with an escaped `\/` (an interior-slash query like `api/v1` — the shape the
  OLD `replace_content`/`rename_tag` `JSON_PRETTY_PRINT` writes and external editors produce) is still
  found (before the broadening it returned **zero** — a page silently hidden from a slash search).
  Common ASCII-no-slash queries keep the fast path. **Writer normalization:** `replace_content` and
  `rename_tag` now write `JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES` (matching `save_page`), so a
  rewritten page re-stores `/`/UTF-8 literally and matches via the fast path without a decode. **[auto:
  tests-api]**
- TC-transport-03 (N): **list_tags is index-backed.** Returns correct `[{tag,count}]` (count = pages
  using it) via `pageMetaIndexed` + `flushIndex` (mirrors `tree`); a warm call reuses cached tags and
  populates `.index.json`. **[auto: tests-api]**
- TC-transport-04 (N): **per-page history-key boot migration** (`migrateHistoryKeys`): idempotent,
  all-namespaces, legacy-retained. Seeding a legacy `history` blob then migrating creates
  `history:<path>` keys with the same entries, leaves the legacy blob intact (rollback-safe), sets a
  per-ns `__history_migrated` flag; a second run is a no-op (no double-append); a present target is
  never clobbered; a mid-transform crash (flag never set, one path written, one missing) safely
  completes the missing path on retry without double-appending the done one. The offline history
  reducers (`recordLocalHistory`/`offlineListHistory`/`offlineGetHistory`/`offlineRestoreHistory`) all
  read/write the per-page keys. **[auto: tests.html]**
- TC-transport-05 (E): **offline namespace boundary.** The IndexedDB mirror/queue/dead-letters/history
  are keyed per server so a queue can never replay against the wrong one: `computeNS()` = `ns:local`
  with no server URL else `ns:<nsHash(url)>`; `nsHash` separates distinct URLs; `kvKey`/`pageKey` carry
  the `NS + \x1F` prefix and two servers never collide on the same logical key. The dead-letter cascade
  helpers (`dlCreatedPath`/`dlCascadeParent`) and the pre-mutation re-key capture (`collectRepathPairs`)
  are covered here too. **[auto: tests.html computeNS/nsHash/kvKey/pageKey + dl cascade + collectRepathPairs]**

### TC-colsort — Per-column sort (double layout)
- TC-colsort-01 (P): Name/Code-type/Kind × asc/desc + Manual order; persists in `.colsort.json`;
  active sort renders a flat intermixed list. **[auto: tests.html sortMillerChildren]**

### TC-pw — Password gate (optional, `CODEMAN_PASSWORD`)
- TC-pw-01 (N): gate on, no/blank token → `401 {"error":"authentication required","auth":true}`. **[auto: tests-api]**
- TC-pw-02 (P): correct secret via `X-CodeMan-Auth` header → 200. The `?token=` query fallback is
  **no longer accepted** — the correct secret via `?token=` → 401 (header-only now). **[auto: tests-api]**
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
  The sidebar `⋯` menu offers **⌘ Command palette…** and **⇄ Find & replace…** (the only touch
  path to them — no keyboard shortcuts on mobile) and both open correctly at ≤768px.
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
- TC-ext-perf-tree (lazy-build + memo, AC6): seed ~1200 pages (10 top folders/projects × 4 subs ×
  30 pages, warm `.index.json`), then time `renderTree()` (avg of ≥10 warm runs via
  `performance.now()`) in each state. **Targets:** collapsed single-column ≤5ms; Miller/double
  ≤60ms; a search/resize burst = **one** render per debounce window; a sidebar-resize drag = **one**
  render per animation frame. *Measured (1,200 pages, headless Chrome, this phase):* collapsed
  **12.04ms → 0.24ms**; Miller **0.76 → 1.02ms** (both ≪60ms; memoized folder aggregates); expanded
  single-column (all folders open, full build) **36.5 → 39.4ms** (unchanged — same DOM work).
  *Why extended:* needs a seeded large dataset + a driven browser for timing.
  - **TC-ext-perf-tree-a (DOM-node cap — proves lazy-build intact):** at ~1,200 pages, a
    fully-collapsed single-column `#tree` holds **≤~500 descendant nodes** (measured **110** with
    10 top folders; a regression to eager-build would balloon it to ~18,550). Assert
    `#tree.querySelectorAll('*').length` stays small when collapsed, then expanding one folder
    **builds its children on demand** (the folder's `.tree-children` goes from `data-lazy="1"`/empty
    to populated). A future eager-build regression fails the node-count ceiling.
  - **TC-ext-perf-tree-b (coalescing render-count):** wrap `renderTree` with a counter. A burst of
    search keystrokes (`updateSearch` typed rapidly) fires **exactly one** `renderTree` per ~120ms
    debounce window (not one per key); a sidebar-resize drag (a stream of `mousemove`) fires **one**
    `renderTree` per animation frame (rAF-coalesced), not one per event. A regression that drops the
    debounce/rAF (rendering per event) fails the count.
  - **TC-ext-perf-tree-c (folder-click single build):** clicking a collapsed folder builds its direct
    children **once** (`selectFolder→renderTree`), not twice — instrument `renderTreeNode` and assert
    each direct child is constructed a single time per click (measured 4 for a 4-child folder;
    the pre-fix double-build produced 8). Guards against reintroducing the redundant inline build.
- TC-ext-perf-transport (WS-6 server efficiency): measure on a seeded large library (~1200 pages,
  warm `.index.json`). **Targets:** (a) **`list_tags` ≤5 ms warm** — after one warming call, the
  index-backed aggregate reuses cached tags (only mtime-moved pages re-parse); measure the warm
  round-trip server-side. (b) **Warm-boot shell transfer <50 KB on the NAS/hosted path** — with
  version-keyed `?v=`, a second visit (no release bump) serves `src/*.js` + `style.css` from browser
  cache (304/`from cache`); only the two un-cached bootstrap files (`index.html`, `version.js`, sent
  `Cache-Control: no-cache`) travel the wire. Verify in devtools Network (disable "disable cache"):
  total transferred on a warm reload is a few KB, not the full ~hundreds-of-KB shell. (c) **No
  `search_content` regression** — the raw fast path should equal or beat the old always-decode path
  on ASCII/UTF-8 queries; confirm result parity + no slowdown. *Why extended:* needs a seeded dataset
  + a driven browser/timed server. **Owner for measured before/after: senior-performance-engineer.**
- TC-ext-gzip (deploy gate — `CODEMAN_GZIP`): API-response gzip is **OFF by default** and shipped
  behind an env gate. **Pre-flight before enabling `CODEMAN_GZIP=1` on the NAS:** confirm the nginx
  layer is NOT already gzipping `api.php` output (else double-compression corrupts the body — check
  `default.conf` `gzip`/`gzip_types` for `application/json`, or `curl -H 'Accept-Encoding: gzip' -I`
  the API and verify a single `Content-Encoding: gzip`). Desktop path is always safe: the proxy's
  `fetch()` decompresses transparently and re-serves identity — `CODEMAN_SMOKE=1` asserts the `gzip`
  probe still parses a well-formed body with no round-trip regression. *Why extended:* needs the real
  NAS/nginx deployment to validate the pre-flight; can't be checked from the repo.
- TC-ext-perf-iter (dot-dir skip on content scans): the five content-scanning actions (`list_tags`,
  `search_content`, `search_blocks`, `replace_content`, `rename_tag`) go through `contentFileIterator`,
  which never DESCENDS into `.history`/`.trash`. On a mature library (history keeps up to 20 versions
  per page → ~24k hidden files at 1,200 pages) this keeps **warm `list_tags` ≤5 ms independent of
  history depth** (before, the iterators stat'd every hidden file — measured ~24 ms, could exceed
  100 ms). Verify: seed pages with deep history, then confirm warm `list_tags`/`search_content` timing
  doesn't grow with history depth. The delete path (`rrmdir`) still walks dot-dirs (must). *Why
  extended:* needs a seeded large/deep-history dataset. **Owner for measured numbers: senior-performance-engineer.**
- TC-ext-desktop-sync (native data-sync dialogs): all three `dialog.showMessageBox` branches —
  Local→Server ("Push to server / Keep"), Server→Local ("Sync now / Switch anyway"), Server A→B —
  with a queued change. *Why:* needs a running Electron instance + native-dialog interaction.
- TC-ext-concurrency (bulk/multi-client): bulk-write loops (`importPages`, `exportAll`,
  `primeOfflineCache`, `applyRename`) on single-threaded `php -S`; many concurrent clients beyond
  two tabs. *Why:* environment-specific; real deployments use nginx + PHP-FPM.
