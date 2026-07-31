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
     **"N passed, 0 failed"** (currently **912**). `window.__testResult = {pass, fail, done}` for
     scripting (`done` flips true after the async offline tests finish).
   - **Server API** — `bash codeman/tests-api.sh` (spins a throwaway `php -S` against a temp data
     dir; exit 0 = all green; currently **194**). Override port: `bash codeman/tests-api.sh 8099` —
     a taken port is skipped automatically (bounded upward hunt), so parallel runs stay green.
   - **CI enforces both** on every push/PR: `.github/workflows/tests.yml` runs `tests-api.sh`
     (`api-tests` job), tests.html headless via Playwright + `php -S`
     (`client-tests` job — fails on any assertion failure, a 60s hang, **any uncaught page
     error**, **or a pass count that isn't EXACTLY the FLOOR** in
     `.github/scripts/run-client-tests.mjs`; the floor is an equality so deleting assertions is
     as visible as adding them — bump it whenever the total moves), and a grep-based
     `invariants` job. That job is **12 checks**, each verified to FIRE on an injected
     violation (list it in full, because "some greps run" is not a spec):
     1. `sw.js` derives `CACHE_VERSION` from `importScripts('version.js')` — the import must be a
        **live statement**, not a mention in a comment, and `CACHE_VERSION` must be built from
        `self.CODEMAN_VERSION`.
     2. `api.php` is never in the service worker's `SHELL` precache.
     3. Page JSON writes are atomic — no `copy()`/`fwrite()`/`fputs()`/bare `file_put_contents(`
        anywhere in `api.php` outside `writeJsonAtomic`'s own temp write and the empty `.project`
        marker.
     4. The html-block iframe sandbox is never widened — no `allow-same-origin` anywhere in
        `codeman/`, and both iframe builders still declare `allow-scripts`.
     5. `index.html` still ships its CSP `<meta>` (incl. `object-src 'none'` / `base-uri 'none'`).
     6. `treeData` is written only through `setTreeData()` (memo invalidation + shape guard).
     7. The rich sanitizer keeps its three declared tables: `RICH_ALLOWED` never names a
        script-bearing tag, and the scriptable vector format is never reachable from `richImgSrc`.
     8. The CSRF read-only allowlist matches between `api.php` (`$csrfReadOnly`) and the desktop
        proxy (`READ_ONLY_ACTIONS`).
     9. The edit-session wiring census — EXACT call-site counts in `editor.js`:
        `beforeEditSession()`=5, `afterEditSession()`=10, `wireEscapeRevert(`=`wireFocusFlush(`=6.
     10. `afterEditSession` never calls `scheduleSave(` (it would re-mark the page dirty).
     11. The default-child-order oracle (`SORT_ORACLE_JSON`) is byte-identical in `tests.html`
         and `tests-api.sh` — editing one copy alone leaves both suites self-consistently green.
     12. No `renderPage()` inside `renderHtmlBlock` outside the convert/delete teardowns (it
         would silently kill a live iframe).
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
- TC-tree-09 (N): **a malformed `tree` response never empties the library.** Make a *reachable*
  server answer `action=tree` with a non-array 200 body — the realistic shapes are `{"error":…}`, a
  bare PHP notice printed before the JSON (→ apiFetch's `_transient` error object), or `null` (e.g.
  add `echo " ";` above api.php's tree handler, or intercept the response in devtools). Reload. The
  library must **NOT** render the empty onboarding state: `setTreeData` rejects the shape, `loadTree`
  reads the **IndexedDB mirror** instead, the offline badge lights (self-healing probe starts), and a
  toast says the library couldn't be loaded. Then click around the sidebar / open a page — **no
  uncaught page error** (the old failure was `TypeError: folderChildren(...).find is not a function`
  from `nodeAtPath`, plus a silently empty library that bypassed a perfectly good offline cache).
  With **nothing** cached the library may legitimately be empty, but still no throw. Same guard
  applies to the two `apiFetch('tree')` reconcile sites (`probeBackend`, `flushQueue`): a malformed
  body there must leave the **persisted** `kv.tree` mirror untouched rather than overwriting it.
  **The mirror check is the critical half** — inspect IndexedDB (`codeman` → `kv` → the namespaced
  `tree` key) after the bad reload: it must still hold the good tree. `cacheOnSuccess` runs *before*
  the caller sees the response, so if it mirrors the bad body the fallback has nothing left to read
  (that was a real second defect, invisible to the unit suite until the live run). Prime the mirror
  first (a healthy boot, or `⋯ → Prime offline cache`), then break the response.
  Related shape guards: the **Trash** and **History** panels say "Could not load…" on a non-array
  response instead of claiming they're empty. `cacheOnSuccess` names **three** per-action guards —
  `tree`, `col_sorts`, `get_page` — and all three are in scope: break the **`col_sorts`** response
  the same way (200 + `{"error":…}` / `null` / `[]`), reload, and confirm the per-column `⇅` sort
  prefs still come back (inspect `kv` → the namespaced `colsorts` key: it must still hold the good
  map, not the error body — nothing later repairs it, so a poisoned one survives every reload).
  **[auto: tests.html — malformed-tree guard (setTreeData
  rejects every non-array shape / loadTree falls back to the mirror / navigation does not throw /
  cacheOnSuccess leaves the kv mirror intact on a malformed, 4xx or null body, and still caches a
  valid one) · the same five-shape sweep for **`col_sorts`** plus a positive control that a valid
  object DOES refresh the `colsorts` mirror (a "nothing was written" assertion proves nothing
  without one) · `probeBackend` refuses a malformed tree, stays offline and leaves both the persisted
  mirror and `treeData` intact (and still reconnects on a valid one) · `flushQueue` drains its ops,
  skips only the reconcile and still reports `Synced` · the Trash and History panels' "Could not
  load…" vs genuinely-empty wording]** *(manual half: the live devtools/`echo` interception and the
  IndexedDB inspection.)*

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
  result set ≤ cap or search cleared. **[auto: tests.html — the cap itself is driven through the real
  `runDeepSearch` against a stubbed `search_content` returning 500 paths (rendered set capped to 200,
  `deepMatchTotal` = 500, banner text); `updateSearchCapNote`'s hide/show states are separate. Manual:
  that the capped render is actually FAST at ~1200 pages (TC-ext-perf).]**
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

### TC-editor — Editor & blocks (code / note / rich / checklist / csv / json / html)
- TC-editor-01 (P): Edit/Save, Cancel→Revert, Copy, Duplicate, Delete per block; section collapse.
  **Duplicate now inserts the copy DIRECTLY BELOW the source** (not appended to the section end),
  scrolls it into view with a transient pulse, and persists on reload.
- TC-editor-02 (E): **input round-trip** — type, save, reopen → byte-identical (trailing whitespace,
  tabs vs spaces, blank lines, emoji, large paste). **One INTENDED exception: line endings are
  normalized to LF.** A block whose stored content carries CRLF (`\r\n`) — e.g. imported or written
  via the API — keeps its CRLF while it's only *viewed* (open + Cancel changes nothing on disk), but
  the first **edit + save** rewrites it as LF. That's `<textarea>.value` behavior (the DOM API
  normalizes on read) surfaced by the textarea being the single source of truth for `block.code`, and
  it is **accepted, not a defect**: LF-normalization is standard editor behavior, and a CR-restoring
  save pass would be fragile and fight the platform. Verify only that content is otherwise
  byte-identical and that a view-only open does NOT rewrite the file.
- TC-editor-03 (A): **autosave deferral + cancel/revert — the CONTRACT.** *While a block editor is
  open, no autosave reaches the server.* Verify each line with the network panel open:
  - Type into a code block → **zero** `save_page` requests.
  - Click **Cancel** → **zero** writes and **zero** new History versions (check via History).
  - Type, click **Save** → **exactly one** write.
  - Type, then click into another block (**focus departure**) → **exactly one** write, and the
    **edit session stays open** (Save/Revert still showing — sticky editing is deliberate).
  - Type, then click the block's own **Delete** → **exactly one** write and **exactly one** new
    History version. (It used to be two: the focus flush fired as `renderPage()` tore the block
    down, then the delete's own save followed. A teardown is not a focus departure.)
  - Type, then switch **browser tabs** → **one forced keepalive write.** This is the documented
    exception: an edit backgrounded mid-session **is** persisted (gating that would be data loss),
    so a Cancel afterwards costs one History slot. Cancel is local *unless* you backgrounded the
    tab or left the block mid-edit.
  - End state is always correct: after Cancel/Revert the block **and** the persisted page hold the
    original text (reload to confirm).
  Applies identically to **code, note, rich, csv, json and html-entry** editors. **Checklist blocks
  have no edit session and keep immediate autosave** — that is by design, not an inconsistency.
  Section titles / tags / block labels are also deferred while a block editor is open; they flush on
  session end, focus departure, or tab switch.
  **[auto: tests.html — `anyBlockEditing` (incl. its fail-OPEN catch) / `scheduleSave` defers but
  still marks dirty / `beforeEditSession` captures the clean snapshot through the REAL `enterEdit`
  (so the "Cancel → zero writes, zero History versions" bullet is automated end-to-end) /
  `afterEditSession` reached from the Revert button of every session-bearing kind / the focus flush
  wired by `renderBlock`, incl. the teardown guard (the "Delete-while-editing → exactly one write"
  bullet). Manual: the `save_page` counts as seen in the network panel, the History-version counts,
  the browser-tab-switch keepalive write, and the after-reload end state.]**
- TC-editor-09 (P): **Esc parity across all six edit-session kinds.** Open an editor in a **code**,
  **note**, **rich**, **csv**, **json** and **html-entry** block in turn and press **Esc**:
  - Clean (nothing typed) → the block leaves edit mode and writes **zero** `save_page`.
  - Dirty (typed) → the text is **reverted to the backup** and the session **stays open** — exactly
    what the Cancel/Revert **button** does, because Esc routes through that button (it must never be
    a bespoke revert, or the `afterEditSession`/dirty wiring drifts per kind).
  - With a `⋯` menu open, Esc **closes the menu only** — the editor stays open; a second Esc then
    exits it. Checklist blocks have no edit session, so Esc does nothing there.
  **[auto: tests.html Esc-exits-every-kind / Esc-reverts-dirty / Esc-defers-to-menu]**
- TC-editor-04 (E): **code layer alignment** — transparent textarea stays pixel-aligned with the
  Prism overlay + gutter, line numbers ON and OFF, while scrolling, after autosize.
- TC-editor-05 (Pe/E): autosizing editors cap at 60vh (50dvh mobile), scroll past; resize handle;
  open 500-block page / 8000-line block render < ~150ms, no jank.
- TC-editor-06 (A): paste `<script>`/HTML into **note** (markdown, `html:false`) and **rich**
  (sanitizer strips script/handlers/`javascript:`) — escaping holds (security boundary).
  The rich sanitizer is **deny-by-default across three declared tables** (allowed tags / dangerous
  tags / per-tag attributes); verify all of:
  - **Round-trips:** a pasted **table** (incl. `<caption>`/`<colgroup>`/`<col>`, `colspan`/`rowspan`,
    `scope`), an **`<img>`**, and **`<h5>`/`<h6>`** all survive Save → reload with their structure —
    no cell text concatenated into one run, no caption relocated above the table.
  - **`<img src>` accepted:** `https:` and non-vector `data:image/…;base64,…` only.
  - **`<img src>` rejected** (attribute removed, element kept): `data:image/svg+xml` (script-bearing
    — permanently rejected, not an incomplete MIME list), `http:`, relative, `blob:`,
    protocol-relative.
  - **`on*` never survives** on any tag, including an allowed `<img>` (deny-by-default, so a future
    handler name is impossible without enumerating it).
  - **Dropped WITH their subtree** (text must not leak through as visible text):
    `<script>/<style>/<iframe>/<object>/<embed>/<form>/<input>/<base>/<template>/<noscript>/<math>/
    <svg>` — note SVG/MathML report a *lowercase* tag name, so case normalization is part of this.
  - `<a href="javascript:">` neutralized with the **link text kept**.
  **[auto: tests.html sanitizeRichHtml / richImgSrc (accepted + ALL FOUR rejections: `data:image/svg+xml`,
  `http:`, `blob:`, protocol-relative and relative) / richIntAttr / richToMarkdown +
  richTableToGfm (pipe-in-cell escaping, ragged-row padding, `<caption>` dropped without corrupting
  the table, a non-top-level table falling back to tab-separated text, and the never-throws fallback)
  + md escapes raw html]**
- TC-editor-07 (A): **rich round-trip through both exports** — paste a table + an image into a rich
  block, Save, reload (structure + image survive). Export **HTML**: the table has borders, the image
  renders, and the CSP `<meta>` is present in the file. Export **Markdown**: the table is a GFM table
  with a `| --- |` separator row, images degrade to their `alt` text, and the block is **not a single
  run-on line** (it used to be — `innerText` on a detached node has no layout). Re-import the JSON
  export and confirm the block is unchanged. Merged cells (`colspan`) collapse to one column in
  Markdown — GFM has no colspan; that loss is expected.
- TC-editor-08 (E): paste a **~500 KB data-URL image** into a rich block: a soft-warn toast fires
  **once** (naming the ×21 history multiplier), the paste is **never truncated**, the page saves, and
  History still works. Watch the page file's growth on disk.
  **[auto: tests.html — a rich block over `RICH_SOFT_WARN` toasts exactly ONCE per session and the
  stored HTML is never truncated. Manual: a real clipboard paste, the on-disk growth, History.]**

### TC-menu — Shared popup `⋯` menus (`showMiniMenu`) — a11y + positioning parity
**Every** `⋯`/overflow popup routes through the one `showMiniMenu` — block-kind menus ×3, section
`⋯`, tags menu, **per-column sort (colsort)**, page-header `⋯`, sidebar `⋯` / More, Export submenu,
and the block **Copy-as `▾`** submenu. No hand-rolled `.mini-menu` remains (grep-verified).
- TC-menu-01 (A11y): the open menu is `role="menu"`, each option `role="menuitem"` (or
  `role="menuitemradio"` + `aria-checked` in the checkable colsort menu), dividers
  `role="separator"`; the anchor button carries `aria-haspopup="menu"` + `aria-expanded` toggling
  `true` on open / `false` on close. Screen reader announces "menu" + item count.
  **[auto: tests.html — the roles (`menu`/`menuitem`/`menuitemradio`+`aria-checked`/`separator`), the
  `aria-label` taken from the trigger, `aria-haspopup`, and `aria-expanded` on open AND on close, all
  on a real menu. Manual: the actual screen-reader announcement, and that every one of the 9+ call
  sites reaches `showMiniMenu` (grep-verified).]**
- TC-menu-02 (A11y): **keyboard-only, all sites incl. colsort + Copy-as** — open a menu, focus
  lands on the first item; ArrowDown/Up move and **wrap** at both ends; Home/End jump to first/last;
  Enter/Space activate the focused item; Escape closes and **returns focus to the anchor**; Tab
  closes. Every menu action is operable with no mouse.
  **[auto: tests.html — `miniMenuWrapIndex` (pure) PLUS the real menu's focus-on-open (and
  focus-on-the-`checked`-row in a checkable menu), Arrow wrap both ways, Home/End, Enter and Space
  activation, and Escape/Tab closing with focus returned to the anchor. Manual: doing it at each
  call site with a real keyboard.]**
- TC-menu-03 (A11y): closing by outside-click or by scrolling closes cleanly (fails soft — no error
  — if the anchor was removed by a re-render); clicking the anchor again toggles the menu shut.
  Opening any menu while another is open closes the first via its `_close` path (its anchor's
  `aria-expanded` resets, its dismiss listeners are removed — no lingering `.remove()` bypass).
  **[auto: tests.html — outside-`mousedown` dismissal, page-scroll dismissal, same-anchor re-open
  toggling shut, and one menu closing another through `_close` (asserting exactly one `.mini-menu`
  survives and the first anchor's `aria-expanded` reset). Manual: the fails-soft re-render case.]**
- TC-menu-04 (P, positioning parity — NO regression): **default** mode — a block `⋯` menu opened
  near the viewport bottom **flips upward** and stays clamped inside the viewport (left edge ≥ 8px).
- TC-menu-05 (P, positioning parity): **sidebar `⋯` (openMoreMenu)** stays **right-aligned** under
  its button (`left = r.right; translateX(-100%)`), tucked under the sidebar as before — wherever
  it fits, which is every normal sidebar width (the overflow case is TC-menu-10).
- TC-menu-06 (P, positioning parity): the **Export submenu** anchors to its passed rect (plain
  top/left, no flip) on desktop (from `exportBtn`) **and** on the **mobile page-header `⋯`
  path**, where it's handed the *visible* `headerMoreBtn` (never opens at 0,0).
- TC-menu-07 (P, positioning + visual parity): the **colsort menu** opens at the same plain
  top/left as before (`anchorRect`), and the active row still shows **both** a `✓` in the aligned
  24px icon column **and** the accent `.active` background; inactive rows keep the reserved column
  so all labels line up. **[auto: tests.html miniMenuHasCheck — icon-column reservation]**
- TC-menu-08 (P, behavior only — NOT positioning): the block **Copy-as** formats are reached through
  the block `⋯` menu, which **rebuilds them as its own items**; the standalone Copy-as `▾` trigger is
  `display:none` at **every** width (`.block-toolbar .copy-as`), so its self-anchored submenu — and the
  `anchorRect` clamp to `max(8, r.right − 200)` / `r.bottom + 4` that positions it — is **not
  user-reachable** in the shipped CSS and must not be tested as live positioning. Verify only the
  behavior: each `Copy: <format>` item in the `⋯` menu copies via `copyText` (records the copy,
  "Copied…/Copy failed" toast). The same is true of the block-kind submenu's own trigger
  (`.type-menu`, also hidden at every width) — its kinds are likewise rebuilt as `⋯` items.
- TC-menu-09 (P, short viewport — the clamp): resize the window to **1440×420** and open the
  **colsort `⇅`** and the **Export `▾`** submenus. Every row must be **inside the viewport** and
  reachable — `.mini-menu` is `position:fixed`, so a row past the bottom edge cannot be scrolled to
  at all. Then repeat at **1440×900**, where both menus **fit**: their position must be
  **unchanged** from before the clamp existed (byte-identical top/left — the `anchorRect` contract
  is "plain position from the caller's rect"; only a real overflow may move it). Also confirm at
  1440×600 and 390×700 that **no** menu in the app moved: block-kind ×3, section `⋯`, tags, colsort,
  page-header `⋯`, sidebar More, Export, html `⋯`, html height. (**Not** the Copy-as `▾` or the
  block-kind `.type-menu` submenus — both triggers are `display:none` at every width, so their
  positioning is unreachable; see TC-menu-08.) Keyboard nav must still
  work in a clamped menu (Arrow wrap, Home/End, Escape → focus back on the anchor) and a **page
  scroll must still dismiss** it.
  **[auto: tests.html — `miniMenuClampPos` as a pure function (fit / overflow / exact-fit boundary)
  AND its WIRING into `showMiniMenu`'s `anchorRect` mode: a real menu opened at a fitting viewport
  lands on the caller's rect UNCHANGED, and at a short/narrow one is shifted inside with the 8px pad.
  Manual: the 4-viewport sweep across all ten real menus in the app, keyboard nav inside a clamped
  menu, and page-scroll dismissal of one.]**
- TC-menu-10 (P, narrow sidebar — the `align:'right'` clamp): drag the **sidebar** to its minimum
  width (`SIDEBAR_MIN` = 200px) on desktop and open the sidebar **More `⋯`**. The menu must be
  **fully inside the viewport** (left edge ≥ 8px) with **every label readable** — before the clamp
  it rendered at left −71, clipping the icon column and the first characters of every row (a
  `position:fixed` box, so it can't be scrolled to). Same at 390×700 with the drawer closed. Then
  restore a normal sidebar width (and check the phone drawer **open**, the way a real user reaches
  it): the menu **fits**, so it must be **byte-identical** to before the clamp — same top/left AND
  the `translateX(-100%)` transform still present, same box size. Only a genuinely overflowing menu
  may move (it then positions by its visual left with `transform:none`, keeping its measured width
  — nudging `left` under the transform would re-wrap the menu narrower/taller). Keyboard nav in the
  clamped menu still works (Arrow wrap, Home/End, Enter/Space, Escape/Tab → focus back on the `⋯`)
  and a page scroll still dismisses it.
  **[auto: tests.html — `miniMenuShift` as a pure function (fit / left+right overflow / exact-fit
  boundary / both axes) AND its WIRING into `showMiniMenu`'s `align:'right'` mode: a real menu that
  fits keeps its `top`, its `left` AND its `translateX(-100%)` untouched, a left-overflowing one is
  repositioned by its **visual** left with `transform:none`, a bottom-overflowing one shifts its top
  while KEEPING the transform, and both-axes does both. Manual: dragging the real sidebar to
  `SIDEBAR_MIN`, the phone drawer, the box-size check, keyboard nav and scroll dismissal.]**

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
- TC-a11y-03b (P, modal message formatting): `.modal-title` is `white-space: pre-line`, so a
  **multi-line** message keeps its line breaks — check the HTML-project over-cap `showAlert`
  ("Project not imported." / the limit lines / "Largest files:" + one file per line): each file must
  be on its own line, blank lines preserved. Then check a **single-line** caller is unchanged (a
  block/section delete confirm renders on one line at the same height) and a **long wrapping** one
  is unchanged (the save-conflict prompt wraps normally, no doubled spacing, no leading indent).
  `pre-line` still collapses runs of spaces, so no caller needs escaping.
  **[auto: tests.html — the COMPUTED `white-space` of a `.modal-title` against the real `style.css`
  is `pre-line`. Manual: the rendered over-cap message, and the single-line / long-wrapping callers.]**
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
  rather than silently persisting a blank copy — the offline `get_page` placeholder is
  indistinguishable from a real empty page. Open/primed and header-menu (live-buffer) dups are
  unaffected. **[auto: tests.html]**
- TC-dup-10 (P, offline): tree-row duplicate of a page that IS in the offline cache but was **never
  opened** (i.e. cached by "Download for offline" / `primeOfflineCache`) **succeeds** — the copy is
  queued carrying the primed content, not a blank page. The hit/miss discriminator is the MIRROR
  (`pageGet`), never the response's `_mtime`: `cacheOnSuccess` strips `_mtime` before mirroring, so a
  hit and the miss placeholder are byte-identical and the old test refused both. **[auto: tests.html]**
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
- TC-hscroll-12 (P): a **WIDE table** in a note block, in a rich block **and in a CSV block** (10 and
  20 columns)
  keeps each column at its natural width (single-line headers) and **scrolls horizontally** once the
  columns no longer fit — it must NOT shrink to fit by collapsing every cell to ~1 character. Measured
  post-fix at 1440px: 20 columns → 80×31px cells, `table.scrollWidth 1711 > clientWidth 939`
  (pre-fix: 45×70px, `939 = 939`, no scrollbar until 30 columns). Cause: `overflow-wrap:anywhere` is
  inherited, and `anywhere` feeds min-content sizing; cells now reset to the min-content-neutral
  `break-word`. **The reset is cell-scoped — TC-hscroll-11's prose wrapping must still hold** (verify
  both in the same pass). Also verify at ≤768px (`body.is-mobile`): the tables scroll, cells stay
  single-line. **[auto: tests.html geometry probe against the real style.css]**
  **CSV (the same defect under a different property name — verify it separately):** the CSV block
  reached the identical state via `word-break: break-word`, the **deprecated alias** for
  `word-break: normal` + `overflow-wrap: anywhere`. Its scroller is the **wrapper** `.csv-table-wrap`,
  not the table. Measured pre-fix at 1440px: 20 columns → 45–48×59–75px cells, `scrollWidth 939 ==
  clientWidth 939` (right-hand columns unreachable); at 390px, 31×171px cells. Post-fix the block
  scrolls with natural single-line columns, and `white-space: pre-wrap` is retained so a cell with an
  embedded newline still breaks. A 10-column table fits at a ~1000px probe width either way, so the
  **20-column case is the discriminator**; the 10-column case is the unharmed-narrow control. The
  `pageToHtml` **export** (`table.csv`) never carried `word-break` and was always correct — it needs
  no reset; check it still renders after any change here.

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

### TC-html — HTML project block (preview)
- TC-html-01 (P): create an html block from **all three** kind-menu sites (`+ Add ▾`, the block
  `type-menu ▾`, the block `⋯`); the empty block shows *"Empty — upload a folder or edit the entry
  HTML."* and no iframe.
- TC-html-02 (P): **folder upload** (`index.html` + `style.css` + `app.js` + a PNG) renders live in
  the sandboxed iframe: **CSS applied**, **JS interactive** (a button handler runs), **image
  visible**; a nested `assets/img/logo.png` resolves; the picker's leading root segment is stripped.
  **[auto (helpers): tests.html stripCommonRoot/bundleHtmlProject]**
- TC-html-03 (P): **drag-drop** a folder onto the block imports it identically (`.drop-active`
  outline while hovering). A folder with **>100 entries imports completely** (`readEntries` is paged
  — it must be looped until it returns empty).
- TC-html-04 (P): **entry auto-resolution**, all three branches — root `index.html` wins; a lone
  `.html` anywhere is chosen; two or more `.html` files prompt a picker (cancel = nothing imported).
  **[auto: tests.html resolveHtmlEntry]**
- TC-html-05 (A): **cap rejection is non-destructive** — a >512 KB single file (or >1 MB total, or
  >50 files) shows a modal naming the offenders + sizes and the block is left **completely
  untouched** (candidate built and checked BEFORE anything is assigned). The modal is an
  **acknowledgement** (`showAlert`) with a SINGLE "OK" button — there is no decision to make, so no
  dead "Cancel" beside it. Enter / Escape / backdrop-click all dismiss it and import nothing.
  **[auto: tests.html htmlCapCheck]**
- TC-html-06 (P): a >256 KB project shows the **soft-warn** confirm explaining the ×21 history
  growth; proceeding imports normally, cancelling imports nothing.
- TC-html-07 (A): **a broken project never renders blank** — a missing entry, an unresolvable
  `src`, a `../` root escape and malformed HTML each show the `.html-warn` banner plus the file
  list. `bundleHtmlProject` never throws. **[auto: tests.html bundleHtmlProject]**
- TC-html-08 (A): **the warning invariant — nothing fails silently.** (a) an unresolved/escaping ref
  warns by name (layer 1); (b) a ref-bearing form the bundler doesn't rewrite (`<object data>`,
  `<embed src>`, `<form action>`, `style="…url(…)"`) is still reported (layer 2); (c) a file present
  in the project but **never referenced** produces an unconsumed-file warning (layer 3), and the
  same file referenced through a handled `<img src>` produces none.
  **[auto: tests.html bundleHtmlProject layers]**
- TC-html-09 (P): **responsive images** — a project with `<img src="photo.jpg" srcset="photo-2x.jpg
  2x, photo-3x.jpg 3x">` plus a `<picture>` element renders the image (**not blank**) on a retina
  display; `.html-warn` shows a **Notes** entry naming the collapsed variants; the **file list still
  lists all three files** (the collapse is render-time only — nothing is dropped from storage).
  **[auto: tests.html parseSrcset/pickSrcsetCandidate]**
- TC-html-10 (P): entry-text **Edit → Save → reload persists**; the file list `✕` removes a
  non-entry file; `⌁`/"Make entry" swaps the entry (old entry pushed back into `files`); the
  preview height drag persists (`htmlH`). Every one of these marks the page dirty.
  The **file list** carries a sticky `N files · X of 1 MB` header (amber past 256 KB), the `⌁`
  entry marker sits in its **own column** so every path shares a left edge, and Remove is a
  **`danger`** button ≥24×24 (neutral at rest, red on hover/focus) whose toast names the recovery
  path ("restore from page History"). Removal is deliberately **modal-free**, like every other
  content delete. **[auto: tests.html setHtmlEntry + the scheduleSave dirty-guard]**
- TC-html-11 (P): `▶ Run` / `↻ Reload` / `■ Stop`; a **running** preview re-mounts immediately after
  a re-render (no "click ▶ again"); a first-view block mounts on scroll-into-view.
- TC-html-12 (P): duplicate block / section / page deep-copies the whole project (the copy's
  `files` is independent); save→reload, history restore, trash restore, two-tab conflict + force,
  and offline render + queued replay all behave as for any other block.
- TC-html-13 (E): **export HTML** renders the project interactively in the standalone file, and that
  file carries the **same CSP** as the app (`object-src 'none'`, `default-src 'self'`) and the same
  `sandbox="allow-scripts"` **without** `allow-same-origin`; **export Markdown** emits a ```` ```html ````
  fence of the entry plus a project-file listing; JSON export→import round-trips `files`/`entry`
  identically.
- TC-html-14 (E): **search is not polluted by binary assets** — a word that occurs by chance inside a
  `b64` blob does NOT match `search_content`, while the same word in the entry HTML does.
  **[auto: tests-api.sh b64 strip, fast path + decoded fallback]**
- TC-html-15 (P): toolbar/⋯ parity — `type-menu` and Duplicate are reachable **only** through the
  `⋯` menu at both widths; the **mobile row is exactly five controls — `✎ ▶ ⧉ ⋯ ✕`** — each on the
  34×32 square footprint, label on its own row, with **`■ Stop` folded into `⋯`** (hidden, never
  removed) and **`Upload…` hidden** (iOS Safari has no folder picker). `■` is `disabled` while the
  preview is idle; `▶`/`■` carry `aria-label`s. The mobile empty-state copy does **not** offer a
  folder upload. **[auto: tests.html htmlEmptyText]**
- TC-html-16 (A): converting **away** from an html block that owns other files shows a confirm
  naming the count + files ("the entry HTML is kept"); with `files.length === 0` it converts with no
  prompt. **[auto: tests.html convertBlock]**
- TC-html-17 (E): **the discriminator is `block.html === true`** — an existing **code** block whose
  language is `html` must still render as a code block, never as a project block.
  **[auto: tests.html blockKind — regression guard]**
- TC-html-18 (A): **a merge upload never loses the existing entry.** Upload folder A
  (`index.html` + `style.css`), then a **non-replace** `Upload…` of folder B (`home.html` +
  `style.css`). A confirm names `style.css` as overwritten; on OK the file list shows
  **`index.html` as a regular file with its ORIGINAL content**, `home.html` as the entry, and B's
  `style.css`; the toast reads `… · 1 replaced · entry is now home.html (index.html kept as a
  file)`. **Cancelling at the confirm leaves the block byte-identical** (nothing saved). Separately,
  `⋯ → Replace project…` on a non-empty block asks first and names the file count; cancel ⇒ no
  picker, no change. **[auto: tests.html mergeHtmlProject — H-1 regression guard]**
- TC-html-19 (A): **a click is not a drag.** Click (do not drag) a preview 10×, forcing a
  re-render between each. The stored height stays put — **no drift toward the 120px minimum** — and
  the clicks do **not** mark the page dirty (no history churn). A real drag still persists `htmlH`.
- TC-html-20 (P): **the warning banner is proportionate.** A project whose 5 pages share a nav
  produces **one info-level Notes entry** (not one line per link), the banner renders **neutral
  `ⓘ`, not amber**, and there are **no layer-3 duplicates** for files reached via `<a href>`. A
  genuinely orphaned file still appears under **Problems** and turns the banner amber.
  **[auto: tests.html groupRefWarnings/htmlWarnSummary + bundler behaviour]**
- TC-html-21 (P): a banner with **>12 entries** shows a `+N more` **focusable button**; activating
  it reveals the tail in place, and **Problems still precede Notes** after expansion.
- TC-html-22 (P): `⋯ → Preview height…` offers Small/Medium/Large with the current one **checked**;
  picking one resizes the box **without restarting a running demo**, persists across reload, and all
  three are reachable at phone width.

**Known limits (expected behavior, not bugs):**
- TC-html-L1: **find & replace rewrites only the entry file** (`block.code`); the other project
  files in `files[]` are untouched.
- TC-html-L2: **quick-paste / block palette yields a plain code block** of the entry HTML —
  `search_blocks` doesn't return the `html:true` flag, so the project doesn't come with it.

### TC-convert — Block-kind conversion
- TC-convert-01 (P): code→note→rich→checklist→csv→json→html→code carries text; rich→other **preserves
  line breaks** (regression: detached-innerText newline loss); entities decode; code↔csv, code↔json
  and code↔html round-trip raw text losslessly (html keeps the text as the entry file).
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
- TC-merge-02 (A): **caret-Split works through the `⋯` menu** — the only route there is (`.block-split`
  is `display:none` at every width). In a code block with **no blank line** (e.g. `one` / `two` on two
  lines), Edit, click to put the caret mid-content (after `one`), then `⋯ → Split`. It must split **at
  the caret** into two blocks (`one`, `two`) — *not* refuse with "Nothing to split — add a blank line
  or place the cursor". The refusal is correct only when there genuinely is no split point: view mode
  (no caret), caret at offset 0, or caret at the very end. A block that *does* contain a blank line
  still splits on the gaps regardless of the caret. Was dead before: `showMiniMenu` moves focus to its
  first item on open, so the old `document.activeElement === textarea` check never matched.
  **[auto: tests.html — Split via the ⋯ menu splits AT the caret]**

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
- TC-data-07 (P/E): **History version read + restore.** `get_history_version` returns the stored
  version (unknown ts → 404; traversal path → `invalid path`); `restore_history` snapshots the
  current content FIRST, then writes the chosen version **atomically** (temp + rename — never a raw
  `copy()` over the live page), returns `{ok, mtime}`, leaves the page valid JSON and no `.tmp-*`
  residue, and a 404 restore changes nothing. **[auto: tests-api restore_history]**
- TC-data-08 (E/A): **HISTORY_KEEP pruning keeps the 20 NEWEST.** 25 consecutive saves → exactly 20
  versions remain, and they are the most recent 20 (the oldest are the ones dropped). Covers the
  same-second burst case: version keys never go backwards into slots the prune just freed, which
  used to make every save after the cap delete the version it had just written.
  **[auto: tests-api HISTORY_KEEP]**
- TC-data-09 (A): **content scans never descend into dot-dirs.** A token that exists ONLY in a
  `.history` snapshot (or only in `.trash`) is invisible to `search_content`/`search_blocks`, a tag
  that exists only in history never reaches `list_tags` (even after `rebuild_index`), and
  `replace_content` leaves history snapshots byte-identical — the recovery net is never rewritten.
  **[auto: tests-api contentFileIterator]**
- TC-data-10 (A/N, critical): **a save the SERVER REJECTED must never report success, and the edit
  must survive a reload.** Open `F/P.json`, then from another device/tab delete its folder
  (`POST api.php?action=delete {"path":"F"}`). Edit a block, Save. Expect: **NO "Saved" toast** — a
  "Save failed: parent folder does not exist — kept in unsynced changes" toast, the bottom-right badge
  in its **red** dead-letter state ("⚠ 1 change could not sync — review"), and the edit parked in the
  **Unsynced changes** panel (`Save · F/P.json`, Inspect shows the edited block text). **Reload the
  page** → the parked entry is still there. Recreate the folder → **Retry** in the panel → the edit
  lands on the server and the panel empties. Same for a malformed 200 body (a stray PHP notice before
  the JSON): it goes to the **retry queue** (3 attempts, then parks) rather than parking immediately.
  Also cover: answering **Overwrite** to a save-conflict prompt when the forced resend is *also*
  rejected → parked, no "Saved (overwrote disk version)"; and leaving the tab (`visibilitychange →
  hidden`) with a dirty page the server rejects → queued, then parked, never dropped. Regression
  boundaries that must stay green: a healthy save still toasts "Saved" exactly once and clears
  `pageDirty`; a conflict still prompts, force-resends and snapshots the other version to History
  (TC-data-03); an offline-queued save still clears dirty and drops `baseMtime`.
  **[auto: tests.html rejected-save — `savePage`: terminal park · transient queue · supersede ·
  conflict unchanged · conflict-force rejected · offline unchanged · healthy save; and its two
  SIBLING call sites, which shipped unpinned: `flushSave`'s non-keepalive path parks a rejected
  write (deleting that one line left the whole suite green) · the keepalive/unload path requeues on
  a RESOLVED `!ok`, not only on a refused fetch · the parked op carries the REQUEST's page, not
  whatever tab we switched to · an edit arriving mid-save keeps the page dirty for the re-save · a
  park that THROWS leaves the page dirty rather than clearing it]**
- TC-data-11 (A/N): **a block Save announces "Saved" exactly once, and only after the write landed.**
  `savePage()` is the single announcer; the five block-Save handlers must NOT toast it themselves
  (they used to, beside an un-awaited `savePage()` — so a healthy save announced **twice** through the
  `aria-live` channel and a rejected one showed a **false "Saved" first**, contradicted a whole
  request-window later). Verify in each session-bearing kind (code/note, rich, csv, json, html-entry):
  Save → exactly one "Saved". Then make the write fail (delete the parent folder from another
  device / throttle to a 4xx) → **no "Saved" at any point**, only the "Save failed …" toast. An
  **offline** save reads **"Saved offline — will sync"** (a queued write is durable but is not on the
  server yet). **[auto: tests.html F-1 (pre-resolve silence · once · rejected · offline wording ·
  per-render-path drift census)]**
- TC-data-12 (A/N, critical): **a create-then-save sequence must leave no history version whose
  restoration would destroy the page.** `create_page` writes `{"title":…,"sections":[]}` and the very
  next `save_page` used to snapshot that stub — so after restoring a JSON bundle, **every** page's
  entire history was one 47-byte empty version, offered by the History panel with a normal blue
  **Restore** button. Restoring it EMPTIED the page, and the real prior versions were never in the
  bundle: worse than no history, a loaded gun where the safety net should be. Verify: restore a
  bundle into an empty data root (TC-io-03), open a restored page → **History says "No saved versions
  yet"**. Then check the two halves that bound the guard, because the risk here is over-suppression:
  **(a) normal history is untouched** — edit that restored page 3× → 3 versions, the OLDEST holding
  the imported content, and restoring it brings that content back; `HISTORY_KEEP` still prunes 25
  saves to the newest 20 (TC-data-08). **(b) authored content is never skipped** — a page you
  deliberately EMPTY still versions the work it replaced, and once a page has any history even
  stub-shaped content is versioned (the skip only ever applies to a page's first snapshot); a page
  whose only content is its title (renamed, never given a section) keeps every authored title.
  Same sequence in `duplicatePageFromTree` and in a queued create+save replaying on reconnect —
  which is why the guard lives in `snapshotHistory`, not in the importer.
  **[auto: tests-api create-then-save (zero versions · no destructive version · next save versions ·
  deliberately-emptied · emptied-state-then-versioned · title-only)]**
- TC-data-13 (A, **fail OPEN**): the stub check reads the PRIOR on-disk content, so it must never
  treat content it cannot READ as the stub — un-decodable bytes (an external editor, a truncated
  write, a hand-edited file) are the case with the most to lose, and calling them a stub would
  discard the only copy there is. Write a non-JSON body straight into `CODEMAN_DATA` over a page,
  then save that page from the app: History gains **one** version and it holds the un-decodable
  bytes. Snapshotting noise is cheap; suppressing a snapshot of content a user could have authored
  is not — never widen this guard. **[auto: tests-api.sh]**

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
- TC-prod-05 (N): **a bulk content mutation must never install an ERROR BODY as an open tab's
  page content.** Both reconciliation loops (Find & Replace's `replace_content`, the tag manager's
  `applyRename`) re-fetch every open tab with `get_page` — a reachable-but-wrong reply is not
  content and nothing upstream catches it, so an unguarded assignment would put `{error:…}` into
  `tab.data` and the next autosave would write it to disk. With a page open, make `get_page`
  answer `{"error":"invalid path"}` (devtools) and run a Replace all that changes that page: the
  tab keeps its real content and its `baseMtime`, and no error body reaches the editor.
  **Then the other half, which is the more damaging one:** with `get_page` healthy, run the same
  Replace all and confirm the open tab now shows the **replaced** text (and picked up the new
  `baseMtime`). A reconcile that silently never runs leaves every open tab on **pre-replace**
  content, and the next autosave writes that stale text back over the server's replacement — and it
  looks identical to "the guard worked" from the outside.
  **[auto: tests.html — the REAL `openReplace` Replace-all against a stubbed `get_page` error,
  instrumented so the reconcile must actually be REACHED, plus a positive control that a valid
  reply DOES replace `tab.data`/`baseMtime`/`currentPageData`]**

### TC-io — Export / Import
- TC-io-01 (P): export HTML (self-contained, title escaped) / Markdown / JSON. **[auto: tests.html pageToHtml/pageToMarkdown]**
- TC-io-02 (P/N): JSON import round-trips byte-identical; malformed / non-CodeMan JSON fails
  gracefully (no tree corruption); traversal names server-rejected.
  **[auto-ish: tests.html importPages negatives + tests-api rename/safePath guards]**
- TC-io-03 (P, **disaster recovery**): `All pages → JSON` exported from a foldered library, then
  imported into an **EMPTY** data root, restores **every** page under its **correct** folder name at
  depth 1, 2 and 3 (incl. multi-word names like `QA Kinds`) with content identical to the source. No
  truncated folder (`Note/` for `Notes/`, `D/` for `DZ/`) is created. This is the case the old parent
  derivation broke — re-importing into the *same* library masked it because the top-level folders
  already existed. **[auto: tests.html importPages positive round-trip]**
- TC-io-04 (N): a page the server refuses (create_folder / create_page / save_page error) is
  **counted and reported** — the toast reads `Imported N pages, M failed`, never a bare success over
  partial data loss. **[auto: tests.html — all four refusal points, each asserted on the toast the
  user reads: a refused `create_page` (every page fails), a refused `save_page` (a PARTIAL import
  reports both the wins and the losses), a refused `create_folder` in the page loop's chain build
  (the page is counted failed), and a refused `create_folder` in the sidecar phase (`folderFailed`
  reaches the toast and the folder is never counted as restored)]**
- TC-io-05 (N, server): `create_folder` with a **non-existent parent** returns
  `404 {"error":"parent folder does not exist"}` and materialises **nothing** — it no longer
  recursive-mkdirs an invented parent chain inside the data root. A legitimate nested folder (parent
  created first) still succeeds. **[auto: tests-api.sh]**
- TC-io-06 (P): **a JSON bundle's SCOPE is stated, not implied.** `Exported N pages` / `Imported N
  pages` were unqualified success claims over a bundle that carries page CONTENT only, so a restore
  silently drops project markers, manual folder order, column sort, trash and history — and the
  restored library (plain folders, no history) is indistinguishable from a failed restore. Verify:
  **Export ▸ All pages → JSON** → the file downloads AND an acknowledge-only modal reads
  `Exported N pages.` + `Every page restores exactly as it is now.` + the list of what a bundle does
  not carry (multi-line — `.modal-title` is `white-space: pre-line`); no toast repeats the claim.
  **Import…** a bundle that lands ≥1 page → the toast names the same omissions. It must NOT fire
  where it doesn't apply: **Export ▸ This page → JSON** still just toasts `Exported <name>` (no
  modal), a **single-page** import toasts a bare `Imported 1 page`, and a bundle that imported
  nothing keeps its `Imported 0 pages, M failed` wording. Mobile (375px): the toast wraps inside the
  viewport (it is `max-width`-capped) and the modal fits. **[auto: tests.html export scope-note +
  import caveat (bundle · single page · zero pages) — the WORDING of each toast/modal ONLY; that the
  file downloads, the modal's multi-line `pre-line` rendering and the 375px wrap are manual]**
  *(The bundle now also carries the library's
  shape — see TC-io-07 — so the export modal and the import toast say what it DOES carry as well as
  what it doesn't; trash and version history remain the only omissions.)*
- TC-io-07 (P, **disaster recovery**): **the library's SHAPE round-trips.** The bundle carries a
  `__codeman_meta` sidecar key alongside the page keys. Build a library with ≥2 projects (one nested
  inside the other), ≥1 folder whose children were **dragged** into a non-alphabetical order, ≥1
  **empty** folder (no descendant pages — it appears in no page key), ≥1 active column `⇅` sort, and
  ≥1 favourited page. **Export ▸ All pages → JSON**, then import into a **genuinely empty**
  `CODEMAN_DATA`. Expect, with **no manual repair**: both projects are projects (`.project` present,
  the nested one inside its parent project), the dragged order is the **user's** — not alphabetical
  and not `prependOrder`'s reverse-creation artifact — the empty folder exists, `.colsort.json`
  matches, and the starred page is starred again. Inspect `.project` / `.order.json` /
  `.colsort.json` on disk, not just the sidebar. **[auto: tests.html — the round trip through the
  REAL `importPages` against a server model, asserting the exact create kinds/parents, the empty
  folder, the `reorder`/`set_col_sort` payloads and the favourites merge]** *(manual only, and the
  half that actually proves recovery: the on-disk inspection of `.project`/`.order.json`/
  `.colsort.json` after a real export→import against a real `php -S` + empty `CODEMAN_DATA`. The
  automated half stops at the client's call sequence — it never touches a filesystem.)*
- TC-io-08 (P, **no artifact**): a folder that never had a manual order must not GAIN an
  `.order.json` from a restore — a materialised order file changes how a *future* sibling sorts. A
  leaf folder holding only pages ends with **no** `.order.json` at all; a folder polluted only by
  `prependOrder` (because the import created a sub-folder inside it) ends with `[]`, which
  `buildTree` treats as identical to no file. **[auto: tests.html + tests-api.sh `reorder {order:[]}`
  equivalence]**
- TC-io-09 (P/N, **compatibility, both directions**): an **old** (sidecar-less) bundle imported by
  the new client lands every page and reports pages-only honestly (no "restored N folders" claim);
  a **new** bundle imported by a **pre-change** client lands every page with **zero failures** — the
  sidecar isn't page-shaped, so the existing skip drops it silently and it is never materialised as a
  folder or page. **[auto: tests.html forward/backward compat; live: pre-change worktree]**
- TC-io-10 (P, **merge restraint**): import into a **non-empty** library applies layout **only** to
  folders the import itself created. An existing folder keeps its own `.order.json`, its column sort
  and its project-vs-plain marker byte-for-byte; it does **not** jump to the top of its parent (the
  old import called `create_folder` for every path segment of every page, and `create_folder`
  prependOrders unconditionally); and the toast says `· N existing folder(s) left as-is` so an
  unchanged sidebar is explained rather than looking like a failure. **A second, subtler route into
  the same damage: the stale-`known` retry.** When a `create_page` is refused because its parent is
  genuinely gone (another device deleted the folder), the import rebuilds that page's chain once and
  retries — and the rebuilt folder legitimately becomes a layout target. That retry must stay
  **narrow**: a rejection for any OTHER reason (quota, a name the server dislikes, a disk error) must
  NOT rebuild the chain, because re-`create_folder`ing an existing folder both jumps it to the top of
  its parent AND re-marks it as "created by this import", which pulls a folder the import never made
  into the layout phase. Verify both directions: make `create_page` fail with a non-parent error (the
  chain is untouched, the page is counted failed, nothing is reordered) and with
  `parent folder does not exist` (the chain is rebuilt, the page lands, the rebuilt folder's recorded
  order is applied). **[auto: tests.html — the create/reorder/set_col_sort calls the import does and
  does not make, plus the `left as-is` clause; and both retry directions, the stale-parent one
  serving as the positive control for the non-parent one's zero-call assertions]** *(manual only: the
  byte-for-byte on-disk comparison of the pre-existing folder's `.order.json`/`.colsort.json`/
  `.project` before and after.)*
- TC-io-11 (A, **offline-only desktop**): export then import end to end with no server reachable —
  the shape restores from the IndexedDB mirror (empty folders included), and a later reconnect
  flushes cleanly. **On the write-queue size, measure — don't assume it shrinks.** The change trades
  one `create_folder` **per page path segment** for one **per folder** plus the sidecar's layout ops
  (`reorder`/`set_col_sort`), so the direction depends on the library's shape: measured, **5 pages
  nested 3 deep went UP, 25 → 36 ops (+44%)** — the layout ops outnumber the segment creates it
  saved — while **80 pages went DOWN, 320 → 193 (−40%)**. Both are correct; the win is at scale, and
  the small-library cost buys the shape restore that is the point of the change. Record the badge
  count for the library under test rather than asserting a direction.
- TC-io-12 (N, **hostile sidecar**): hand-edit a bundle's `__codeman_meta` to contain a traversal
  path (`../escape`), a dotfile path (`.history`), a non-string path, a project whose parent is a
  **plain** folder, a junk `colSort` field, an **orphan** folder entry (`Orphan/Child` with no
  `Orphan` entry anywhere), and a **non-string inside an `order` array** (`["A", null, 7, "B"]`).
  Each is rejected **client-side** (no request is
  sent), each real rejection is **counted** in the toast's `N shape item(s) failed`, and nothing in
  the data root is corrupted. The orphan entry is the same class as the project downgrade: the
  server's parent guard must **never** be exercised as an error path, so no `create_folder` is sent
  for it at all — and because `shapeFailed` and `folderFailed` net out identically in the toast, the
  **absence of the request** is the only observable difference. The non-string order entry is
  filtered on both ends: `readLibraryMeta` strips it on the way in (and the same filter guards
  `rootOrder` and `client.favorites`), and `buildLibraryMeta` normalises a junk `colSort` `dir` on the
  way **out** as well as in. The project-under-a-plain-folder case is **not** a failure: it is
  downgraded to `create_folder` (the server guard must never be exercised as an error path) and
  reported in its own clause — `· 1 project restored as a plain folder (a project cannot sit inside
  a plain folder)` — because the folder and all its pages landed, and reporting it as
  `1 shape item failed` reads to a merging user as data loss on the documented backup path. A
  sidecar with the wrong `format`, a non-array `folders`, or a non-object value degrades to a
  pages-only import reporting `· library shape could not be read` — **never a throw**.
  **[auto: tests.html — every rejection above, the downgrade's own wording (and that it is NOT
  counted as a failure), and `readLibraryMeta`'s never-throw contract driven with a sidecar that
  throws while being read. Note the two guards that need a non-JSON input to be observable at all:
  `folders`-not-an-array is only distinguishable via an array-LIKE with a `.map` (a string falls
  into the never-throw catch and returns null either way), and the array-sidecar guard only via an
  array CARRYING `format`/`folders`. Both are asserted that way; the plain-JSON forms are kept
  beside them but prove nothing on their own. The orphan entry and the non-string order are asserted
  through the REAL `importPages` — on the CALL LIST and the `reorder` PAYLOAD respectively, not on
  `readLibraryMeta`'s return value alone — and the orphan run's zero-call assertion is paired with a
  legitimate sibling entry that DOES produce a `create_folder`, so it can never pass vacuously. The
  export-side `dir` normalisation is controlled by the existing assertion that a REAL `desc`
  survives.]**
- TC-io-13 (P/E, **the user's manual order survives a restore**): the sidecar **omits** a folder's
  `order` whenever `defaultChildOrder` (tree.js) thinks the children are already in `buildTree`'s
  default order — so a divergence between those two comparators silently **DROPS** a dragged order
  on the next restore (the error is asymmetric: a false "non-default" is harmless, a false
  "default" is data loss). They are in different languages and cannot call each other, so both are
  pinned to one shared oracle corpus. Manual check: build a folder containing a **non-BMP-named**
  child — an **emoji-named folder** is the whole trigger — alongside ASCII and Latin-1 names, leave
  the order **untouched**, export, import into an empty root, and confirm the folder gained no
  `.order.json`; then **drag** one child, re-export/re-import, and confirm the dragged order comes
  back exactly. **[auto: tests.html `defaultChildOrder` vs the oracle + tests-api.sh the REAL
  `buildTree` over the same names created directly on disk + CI invariant 11 comparing the two
  literals. The corpus now carries `Ｗide` (U+FF37) and `😀emoji` (U+1F600): byte order puts `Ｗide`
  first, UTF-16 code-unit order puts the emoji first, so they are the ONLY pair that catches
  `cmpUtf8` regressing to a plain JS string compare — every other name in the corpus is BMP, where
  the two orderings agree. It ALSO carries `Cap`/`cap`, two same-type siblings differing only in
  case: the type tier ties and ASCII folding ties, so only the raw-byte tier can order them — the
  one input that catches `cmpUtf8(a.r, b.r)` being dropped. They are listed in the corpus in the
  OPPOSITE order on purpose, or the index tie-break would reproduce the right answer anyway.]**
  ⚠️ **Filesystem caveat (Extended, Linux only):** `Cap/` and `cap/` cannot coexist on a
  case-INSENSITIVE volume (macOS/APFS), so `tests-api.sh` probes the test volume and drops `cap`
  from the expected slice when it folds case — the oracle *literal* stays byte-identical in both
  suites (invariant 11) either way. The CI runner is Linux, so the full pair IS exercised on every
  push; a purely-macOS local run leaves the server half of that pair unproved. This matters because
  the documented production deployment is Linux/Docker, where `Alpha/` and `alpha/` really can
  coexist and a lost tier 3 is a false "already default" verdict — the data-losing direction.
- TC-io-14 (P/E, **import is a MERGE, and stars are bundle-scoped**): a restore must not clear the
  favourites the user already has, and must not resurrect a star for a page the bundle doesn't
  contain. Star a page that is NOT in the bundle, import a bundle whose sidecar stars (a) a page it
  contains and (b) a page it doesn't. Expect: the pre-existing star survives, (a) is starred, (b)
  is not. **[auto: tests.html — all three, through the real `importPages`]**

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

- TC-offline-07 (E): **an unusual-but-VALID page is still mirrored offline.** A hand-written or
  imported page with no `sections` array (`{"title":"NoSect"}`) is cached on open and by
  `⋯ → Prime offline cache`, so it still opens with the backend down (title + header, no throw) —
  the mirror's shape guard rejects **error bodies**, not odd content. A `get_page` that returns an
  error body (or an array/scalar) is still NOT mirrored. **[auto: tests.html cacheOnSuccess guards]**

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

- TC-sec-08 (A): **the html-block iframe sandbox is `allow-scripts` and nothing else.** The rendered
  preview iframe's `sandbox` attribute is EXACTLY `allow-scripts` (opaque origin: no
  `parent.document`, no cookies/storage, no egress), it's fed by `srcdoc` with no navigable `src`,
  and it sends `referrerpolicy="no-referrer"`. The standalone `pageToHtml` export emits the same
  attribute **and** the same CSP `<meta>` (`object-src 'none'`, `base-uri 'none'`) — an export must
  never be less restrictive than the app. Adding `allow-same-origin` VOIDS the whole sandbox and is
  a permanent invariant, not a tuning knob. **[auto: tests.html rendered-iframe + export assertions;
  CI `invariants` job greps `codeman/` for `allow-same-origin` and re-checks `index.html`'s CSP meta]**
- TC-sec-09 (N/A): **`apiFetch` network classification** — the "offline never latches" and "a wrong
  password is never persisted" guarantees. A reachable server returning **4xx** surfaces the body as
  an app error and does **not** trip offline; a **200 with a malformed body** returns
  `{error, _transient:true}` and does **not** trip offline (flushQueue retries, then parks); a **5xx**
  or an **aborted/timed-out** request throws and `api()` falls back to the offline mirror; a **401 →
  prompt → still 401** throws `authentication required` (retried exactly once) and **clears the stored
  `authToken`** so the next request cleanly re-prompts. **[auto: tests.html stubbed-fetch apiFetch]**

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
- TC-colsort-02 (P/E): **server side.** `set_col_sort` keys the ROOT column off the **empty string**
  (`{"":{"field","dir"}}`) and a nested column off its folder rel path; all prefs live in ONE
  root-level `.colsort.json` (never a per-folder file); `field:"manual"` (or an unknown field) clears
  just that entry and leaves the others; `col_sorts` returns the map; a traversal `parent` →
  `invalid path`. **[auto: tests-api set_col_sort/col_sorts]**

### TC-order — Manual child order & metadata index (server)
- TC-order-01 (P/N): `reorder` persists `{parent, order:[names]}` into the folder's `.order.json`
  and `tree` returns that folder's children in exactly that order; a traversal `parent` →
  `invalid path`. **[auto: tests-api reorder]**
- TC-order-02 (P): `rebuild_index` drops and re-parses the index — regenerates `.index.json`,
  reports a non-zero `pages` count, and indexes **no** `.history`/`.trash` entries.
  **[auto: tests-api rebuild_index]**

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
- TC-ext-html-sandbox (HTML block, sandbox posture): load a project that calls `parent.document`,
  `fetch()`, `localStorage` and `alert()` — **each fails inside the frame only** (opaque origin: no
  `allow-same-origin`, no `allow-modals`), the app is unaffected, and the banner shows the
  network/storage heuristic note. Confirm the iframe carries `sandbox="allow-scripts"` **without**
  `allow-same-origin` — adding it would void the whole sandbox. *Why extended:* needs a
  deliberately hostile fixture + DevTools inspection.
- TC-ext-html-retina (HTML block, responsive images on a 2× device): on a retina/2× display the
  collapsed preview image is visibly correct (not blank, not a broken icon) and **DevTools shows
  ZERO network requests from the frame** (everything is a data URI). *Why:* needs real 2× hardware.
- TC-ext-html-size (HTML block, size limits): the 256 KB soft-warn modal; a page whose serialized
  JSON exceeds 6 MB toasts the `post_max_size` warning, and a **real** server rejection surfaces as
  the normal visible save error (not a silent drop). At 1000+ pages, `search_content` shows no
  b64 false positives and no sidebar/search regression. *Why:* needs large fixtures + server config.
- TC-ext-html-norestart (HTML block, run state): scroll a long page past a **running** demo and back
  — the demo is still running (or restarts immediately without a ▶ click), never stuck on the idle
  poster. *Why:* timing/scroll-dependent, awkward to automate.
- TC-ext-html-partial (HTML block, incomplete drag-drop): drag-drop a folder of >100 entries from a
  source whose directory reader errors mid-page — the import must stop and ask
  ("Some folders couldn't be fully read… Import anyway?"), and cancelling imports **nothing**.
  *Why:* the reader error is hard to force reliably; run as code inspection of
  `collectDroppedFiles`'s `partial` flag plus an instrumented case that stubs `readEntries`.
- TC-ext-menu-scroll (`.mini-menu` overflow, GLOBAL blast radius): open a **12+ row** `⋯` menu (the
  html block's, and the block-kind menu) at **1440×600** and **390×700**. The menu scrolls
  **internally** (≤70vh) instead of running off the viewport, the upward flip near the bottom edge
  still lands correctly, and — the companion guard — **ArrowDown to the LAST item does NOT close
  the menu**. Sweep every menu that shares the component: block-kind ×3, section `⋯`, tags,
  colsort, page-header `⋯`, sidebar More, Export submenu, Copy-as submenu. *Why:* one shared
  component, many call sites; a regression here is app-wide.
- TC-ext-html-desktop (packaged desktop build): the same `.mini-menu` internal scrolling +
  keyboard nav, and the `⋯ → Preview height…` presets, behave identically in the packaged
  Electron app. *Why:* needs a packaged build.
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
