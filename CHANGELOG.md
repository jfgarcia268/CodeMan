# Changelog

All notable user-visible changes to CodeMan are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
— section headings track the `vX.Y.Z` git tags. See the release flow in
[CLAUDE.md](CLAUDE.md) (CI section).

Append entries to `## [Unreleased]` as changes land, grouped under
`Added` / `Changed` / `Fixed` / `Security`. At release, rename `[Unreleased]`
to `## [X.Y.Z] — YYYY-MM-DD`.

## [Unreleased]

### Added
- **HTML preview block.** A new block kind that holds a small static web project (an entry HTML file
  plus its CSS, JS and images) and renders it **live** inside the page. Upload a whole folder with
  `Upload…` or drag one onto the block; CodeMan works out the entry file, inlines every
  sub-resource, and shows the running result in a resizable preview. `▶ Run` / `↻ Reload` / `■ Stop`
  control the preview, the file list shows every stored file (with a `⌁` marker for the entry, a
  "Make entry" action on other HTML files, and `✕` to remove one), the entry HTML stays editable in
  the block, and `Copy` copies the single bundled document. Everything lives inside the page, so
  history, trash, restore, duplicate, offline and export all work exactly as they do for any other
  block. Projects are capped (1 MB total, 512 KB per file, 50 files) with a warning above 256 KB,
  because every version is kept in page history.
- **Honest preview warnings.** When something in a project can't be shown in the preview — a missing
  or out-of-project file, a reference form that isn't supported (`<object data>`, `<form action>`,
  inline `style="…url(…)"`), an `@import`, or simply a file that's in the project but never
  referenced — it is listed in a banner above the preview under **Problems**. Routine notes
  (responsive-image variants collapsed for the preview, or a reminder that network/storage APIs and
  remote scripts don't work in the sandbox) are listed separately under **Notes**. A reference to a
  project file can never disappear from the preview without being reported.
- **Responsive images.** `srcset`, `<picture><source>`, `sizes` and CSS `image-set()` are understood:
  the preview keeps one variant (preferring the element's own `src`, then `1x`/the smallest) and says
  which ones it dropped. **All uploaded variants are still stored and still listed** — the collapse
  only affects what the preview renders.

### Changed
- Converting a block **away** from an HTML project now asks first when the project holds other
  files, naming them, and reminds you the change can be undone from page History.
- **Uploading into an HTML project keeps everything.** A second, non-replacing `Upload…` now merges:
  files the upload doesn't mention are kept, files it does replace are named in a confirmation
  first, and the project's previous entry file is kept as a regular file rather than being lost. The
  toast afterwards says what was replaced and what the entry file is now.
- `⋯ → Replace project…` now asks for confirmation before discarding an existing project.
- The preview warning banner is quieter and easier to act on: repeated references of the same kind
  are grouped into a single line, ordinary page-to-page links are reported as a **note** rather than
  a problem, a banner with only notes is neutral instead of amber, and `+N more` is now a button
  that reveals the rest instead of just counting them.
- The HTML file list gained a header showing how much of the 1 MB budget the project uses, and the
  preview can be resized from `⋯ → Preview height…` (Small / Medium / Large) as well as by dragging.
- Long `⋯` menus now scroll inside themselves instead of running off the bottom of the screen.
- **Editing a block no longer saves on every keystroke.** While a block editor is open, CodeMan holds
  the changes locally and saves when you press **Save**, when you click away from the block, or when
  you leave/close the tab. So **Cancel now really is a cancel**: a typed-then-cancelled edit writes
  nothing and no longer spends page-History versions (it used to burn about two per cancelled edit).
  **The trade-off, plainly:** between those moments your un-saved text lives only in the browser tab,
  so a crash, force-quit or power loss *while the editor is still open and focused* now loses what
  you typed since you last clicked out of the block — where before it was on the server within half a
  second. Switching browser tabs, closing the tab, and clicking out of the block all still save, so
  nothing is lost by simply walking away. One consequence: an edit you background mid-session **is**
  saved, so cancelling after that does cost one History version.
  Checklist blocks are unaffected — they have no Edit/Cancel and still save immediately.

### Fixed
- **Rich Text blocks no longer silently destroy pasted content.** Pasting a **table** dropped all its
  markup and ran every cell's text together into one line; **images** were deleted outright; and
  **Heading 5 / Heading 6** were flattened to plain text. Tables (including captions, column groups
  and merged cells), images and all six heading levels now survive a paste, a save and a reload, and
  render properly in both the app and an exported HTML page.
- **Rich Text blocks export to Markdown correctly.** They previously collapsed into a single run-on
  line with every paragraph, list item and line break lost. Paragraphs and lists now keep their
  structure, tables export as real Markdown tables, and images export as their alt text.
- Converting a Rich Text block containing a table into a Table (CSV) or Code block now produces a
  real table instead of one run-on line.
- **HTML project: the entry file is no longer lost when merging an upload.** Uploading a second
  folder without choosing "Replace project" silently deleted the project's existing entry HTML.
- **HTML preview: the preview no longer shrinks when clicked.** Clicking (rather than dragging) a
  preview shrank it by 2px each time and marked the page as changed; a click now does nothing.
- A drag-and-drop import that couldn't fully read a folder now says so and asks before importing,
  instead of quietly importing a partial project.
- `■ Stop` is disabled while the preview isn't running, and on phones it moves into the `⋯` menu so
  the block's button row stays readable; `▶`/`■` are now labelled for screen readers.
- Removing a file from an HTML project is now an obvious delete button with a proper tap target, and
  the confirmation message names where to recover it from.
- Cancelling the folder picker no longer leaves an invisible element behind in the page.
- On phones, the empty-state and editor placeholder no longer suggest a folder upload, which isn't
  available there.
- **Page history no longer stops recording after 20 quick saves.** Once a page had its full 20
  versions, further saves made within the same second could overwrite the version just written
  instead of dropping the oldest one — so the newest changes were silently discarded. History now
  always keeps the **20 most recent** versions.
- **Restoring a version is now crash-safe.** Restoring from History wrote the old version straight
  over the live page; an interruption mid-write could leave the page truncated. The restore is now
  written atomically, and a version that isn't valid JSON is refused instead of replacing a good page.
- The "Project not imported" message shown when an HTML project exceeds the size cap now has a
  single **OK** button — it previously offered a "Cancel" that did exactly the same thing.
- **Deleting a block while editing it no longer saves the page twice**, so it costs one page-History
  version instead of two.
- **Esc now cancels the editor in every block kind.** It only worked in Code and Note blocks; in Rich
  Text, Table (CSV), JSON and HTML blocks it did nothing, so the only way out was the Cancel button.
  Esc reverts unsaved changes exactly like Cancel does — and when a `⋯` menu is open, Esc still just
  closes the menu.
- **`⋯` menus that open from a column-sort or Export button no longer run off the bottom of a short
  window.** In a window under about 500px tall the last options couldn't be reached at all (the menu
  can't be scrolled to). Menus that already fit are positioned exactly as before.
- Multi-line messages in dialogs now keep their line breaks instead of running together — most
  visible in the "Project not imported" list of oversized files.
- **The sidebar `⋯` menu no longer runs off the left edge of the window when the sidebar is narrow.**
  With the sidebar dragged to its minimum width, the menu opened partly off-screen — the icons and
  the first characters of every option were cut off and unreachable (it can't be scrolled to). It now
  slides just far enough to sit fully inside the window, keeping its size; at every normal sidebar
  width it opens exactly where it always has.
- **A bad reply from the server no longer makes your whole library look empty.** If the server was
  reachable but answered the sidebar's request with something unusable (an error message, an empty
  reply, or output with a stray warning in front of it), CodeMan showed the "no pages yet" welcome
  screen — ignoring the offline copy it already had — and clicking anywhere in the sidebar then
  failed. It now recognises the bad reply as a failure, shows your offline copy instead, tells you so,
  and starts retrying in the background. The Trash and History panels likewise say "Could not load…"
  rather than claiming they're empty.
- **A save the server rejected reported success and lost the edit.** If the server refused a save —
  most easily by another device deleting the page's folder while you had it open, but also on a bad
  path or a server hiccup that produced a broken reply — CodeMan showed "Saved", marked the page as
  up to date, and the edit then existed nowhere: it was gone after a reload, with nothing to recover
  it from. A rejected save now says so, naming the server's reason, and the edit is **kept**: a
  passing hiccup is queued and retried automatically, a real refusal is parked in **Unsynced changes**
  (the red badge, bottom-right — also reachable from the sidebar `⋯` menu and the command palette),
  where you can inspect it, retry it once the problem is fixed, export it, or discard it. It survives
  a reload. The same blind spot on the "Overwrite" answer to a save-conflict prompt, and on the save
  CodeMan makes when you leave the tab, is fixed too.
- A page saved by hand or imported without any sections is now kept in the offline copy, so it still
  opens when the server is unreachable instead of coming up empty with no explanation.
- **Splitting a block at the cursor works again.** `Split` in a block's `⋯` menu ignored where you had
  put the cursor and refused with "add a blank line or place the cursor" — even though you just had.
  It now splits exactly at the cursor. (Blocks containing a blank line still split on the gaps, and
  view mode / cursor at the very start or end still correctly report there's nothing to split.)
- **A full-library JSON backup could not be restored — and said it had worked.** Importing an
  `All pages → JSON` export into an empty library (the disaster-recovery case the export exists for)
  **silently dropped every page that lived in a folder**, keeping only the pages at the top level. The
  folder names were built wrongly — the last character of each first-level folder was cut off, so
  `Notes/Recipe` was filed under a folder called `Note`, and the page itself was then never written —
  and the failures were hidden behind an "Imported N pages" success message. A 14-page backup restored
  **2** pages. If you have ever restored a backup into a fresh/empty CodeMan and pages seemed to be
  missing, this was why; re-import the same export file and everything now lands. Import also now
  **reports failures** ("Imported 8 pages, 3 failed") instead of claiming success over partial data
  loss, and the server refuses to invent a folder whose parent doesn't exist rather than quietly
  creating a bogus one. Re-importing into an existing library was never affected, which is why this
  went unnoticed.
- **"Download for offline" now actually lets you duplicate a page while offline.** With the server
  unreachable, the `❐` on a page row in the sidebar refused with "Open this page before duplicating it
  offline" for *every* page that wasn't already open in a tab — even ones you had just downloaded for
  offline use. Downloaded pages now duplicate normally, with their real content; only a page CodeMan
  genuinely has no offline copy of is still refused.
- **Wide tables in Note and Rich Text blocks now scroll instead of being crushed.** A table with more
  columns than fit squeezed every column down to about one character wide and stacked the text
  vertically (a 20-column table rendered as 47px-wide, 245px-tall cells) rather than letting the table
  scroll sideways. Columns now keep a sensible width and the table scrolls horizontally, on desktop and
  on phones. Long unbroken words in ordinary note/rich prose still wrap inside the block as before.
- **Wide Table (CSV) blocks now scroll too.** The same defect reached the CSV block by a different
  route and was missed the first time: a table with many columns was squeezed to about one character
  per column (a 20-column table rendered as 45px-wide, 75px-tall cells on a laptop, and roughly two
  characters per column stacked six lines deep on a phone), and the right-hand columns could not be
  reached because the block never grew a horizontal scrollbar — the in-app view was actually worse
  than the same table in an exported HTML page. Columns now keep their natural width and the block
  scrolls sideways, on desktop and on phones. Cells with line breaks inside them still show those
  line breaks.
- **"Saved" is no longer announced before the save has happened.** Saving a block reported "Saved"
  immediately and then again when the write completed (announced twice to screen readers) — and if the
  server refused the write, the false "Saved" appeared first and was only corrected a moment later.
  The message now appears once, after the save has actually landed, and never appears at all when the
  save is refused. A save made while offline now reads **"Saved offline — will sync"** so a queued
  change isn't mistaken for one that reached the server.

### Security
- The HTML preview runs in an iframe with `sandbox="allow-scripts"` and **no** `allow-same-origin` —
  the previewed project gets an opaque origin, so it cannot read CodeMan's page, cookies or storage,
  and the app's Content-Security-Policy blocks it from reaching the network. `alert()`/`confirm()`
  do nothing inside the preview (no `allow-modals`), which is deliberate.
- **Exported HTML pages now carry the same Content-Security-Policy as the app.** Previously a
  standalone export was less restrictive than CodeMan itself; an export containing a live HTML
  preview now enforces the identical policy.
- Binary project files are stored as base64 and are **excluded from content search**, so a word that
  happens to occur inside encoded image data no longer produces false search results. Images pasted
  **inline** into a Rich Text block are excluded the same way.
- **The Rich Text sanitizer now works from a declared per-tag attribute allowlist.** An attribute is
  kept only if it is explicitly named for that tag, so no event handler — including any added to
  browsers in future — can survive a paste without someone deliberately listing it.
- **Pasted image sources are restricted to `https:` and non-vector `data:image` URLs**, matching the
  app's own Content-Security-Policy. Scalable-vector images are refused because that format can carry
  scripts; plain-`http:` and relative sources are refused too. The image itself is kept, just without
  the rejected source.
- **A pasted `<svg>` or `<math>` block is now removed together with its contents.** Because those
  elements report their name differently from ordinary HTML, they were previously only unwrapped —
  which let the text of an embedded script show up in the block.

## [1.13.0] — 2026-07-14

### Added
- **Accessibility: full keyboard & screen-reader reach.** Page tabs are now a proper tab strip —
  arrow keys (Left/Right, Home/End) move between them and open the page, each tab announces its
  selected state, and every tab (and "Close all") can be closed with the keyboard. Collapsible
  section headers are keyboard-operable (Tab to the disclosure triangle,
  Enter/Space to collapse/expand) and announce collapsed/expanded. Confirm/prompt dialogs trap focus
  while open (Tab cycles inside), close on Escape, and return focus to whatever opened them.
  Copy/save/error feedback (toasts and the "Copied" bubble) is announced to assistive tech.
- **"Move current page to…" command.** A new command-palette entry (`⌘K`, then `>`) opens a
  filterable folder picker to move the open page to another folder — the same move (with history
  preserved) you'd get by dragging it in the sidebar.

### Changed
- **Readability & contrast pass.** Faint low-contrast text (empty states, search placeholders) is
  darkened to meet AA contrast, the smallest labels are enlarged slightly, and the double-column
  paging rails are widened for an easier click/touch target. A slow page open (>250 ms) now shows a
  brief spinner on the tab strip.
- **Faster sidebar & search on large libraries.** The folder tree now builds collapsed subtrees
  only when you open them (instead of building the whole tree up front), and repeated renders reuse
  cached folder counts/tags — so the sidebar stays instant even with thousands of pages. Typing in
  search and dragging the sidebar divider are also smoothed (coalesced) so they don't stutter at
  scale. No change to what you see: search, reveal, and keyboard navigation work exactly as before.
- **Faster warm boot & server responses.** On a hosted (non-localhost) server the app now
  cache-busts its scripts/styles by *version* instead of a per-load timestamp, so after the first
  visit the browser reuses the cached files until the next release — a near-instant warm boot with
  almost nothing re-downloaded. The tag list is now served from the same metadata index the sidebar
  uses (fast even with thousands of pages), and deep content search takes a quicker path on the
  common case. An optional gzip of API responses can be enabled server-side (`CODEMAN_GZIP=1`) once
  you've confirmed your web server isn't already compressing. No change to what you see.

### Fixed
- **Content search finds pages with a slash in the text again.** A deep (content) search for a term
  containing a `/` (e.g. `api/v1`, `TCP/IP`) could miss pages — especially ones recently touched by the
  tag manager or find-&-replace — because of how the slash was stored on disk. Slash searches now return
  all matching pages, and pages rewritten by those tools are re-saved so they stay findable.

### Security
- **Server-side CSRF protection.** The API now requires the `X-CodeMan-Request` header on every
  state-changing action (deny-by-default: reads are allowlisted, every write — including any future
  one — is protected), rejecting forged/cross-site header-less writes with a clean 403. The web
  client has been sending this header since the previous release, and the desktop wrapper already
  enforced it, so normal use is unaffected. A `CODEMAN_CSRF=off` server setting is available as a
  break-glass during a migration window. **Deploy note:** roll out the updated client/desktop app
  before enabling enforcement on an existing server.
- **Tighter path safety.** The server now flatly rejects any request whose path contains a `..`,
  `.`, or hidden/dotfile segment (e.g. attempts to read `.index.json` or delete `.history` are
  refused) instead of quietly stripping it — closing read/traversal gaps in page reads, deletes,
  history listing, and trash restore. Legitimate nested pages are unaffected.
- **Password no longer accepted in the URL.** The optional password gate now only reads the
  `X-CodeMan-Auth` header; the old `?token=` query fallback (which could leak the secret into
  server logs / browser history) was removed.
- **Content Security Policy.** The app ships a CSP that confines scripts, styles, and images to
  trusted sources, reducing the blast radius of any injected content. Remote **https** images in
  note/rich blocks still load; plain-http and other-scheme remote images are blocked.
- **Hardened desktop wrapper.** The desktop app's internal proxy now confines its privileged
  endpoints to its own loopback origin (requiring a matching Origin on any state-changing request),
  rejects duplicated `action` parameters and header-less writes, blocks off-origin navigation and
  look-alike-host link windows, and only tests http(s) server URLs — defense-in-depth so nothing
  outside the app can drive it.
- **Find & Replace regex safety.** A pathological (catastrophic-backtracking) search pattern now
  fails fast with a clear "regex too complex" message instead of hanging the request.

## [1.12.0] — 2026-07-13

### Added
- **Keyboard- & screen-reader-operable popup menus.** Every `⋯` / overflow menu (block actions,
  section, tags, per-column sort, the page-header `⋯`, the sidebar More menu, the Export submenu,
  and the block Copy-as menu) is now a proper accessible menu: open it and arrow-key up/down (wrapping) between items,
  Home/End to jump, Enter/Space to activate, Escape to close — focus returns to the button you
  opened it from, and assistive tech announces it as a menu. The menus look and land exactly where
  they did before.
- **Unsynced-changes review.** When an offline edit can't be synced back to the server (a
  name the server rejects, a save that keeps failing), it's no longer silently dropped —
  the offline badge shows "N changes could not sync — review" (in a distinct red state), opening a
  panel where you can inspect, retry, discard, or export each change (grouped so a whole failed subtree
  reads as one unit under the item that couldn't be created). Nothing is ever thrown away without your
  say. The review panel is reachable by keyboard (focus the badge and press Enter) and from the command
  palette and sidebar ⋯ menu, not just a mouse click on the badge.
- **Backup reminder (offline-only desktop).** When the desktop app is configured offline-only
  — so this machine's local store is the *only* copy of your library — it occasionally shows a
  dismissable "Back up your library — Export all pages" toast. Server-connected and web users
  never see it (the server is the backup). "Don't remind me" silences it for good.

### Changed
- **Crash-safe page writes.** Every page and metadata file is now written atomically (write to
  a temp file, then rename), so a crash or power loss mid-save can never leave a truncated or
  corrupted page.
- **History follows renames/moves.** A page's (or folder's) version history now travels with it
  when you rename or move it, instead of being stranded under the old name.

### Fixed
- Unsaved edits when a tab is closed or the app is backgrounded are now saved with a reliable
  keepalive request that carries your login — previously, on a password-protected server, that
  last-moment save could be rejected and lost.

## [1.11.0] — 2026-07-13

### Added
- Command palette and Find & replace are now reachable from the sidebar ⋯ menu — a
  touch-friendly path for phones/tablets, where the ⌘K shortcut (previously the only way
  to reach them) isn't available.
- Both automated test suites now run in CI on every push and pull request (GitHub Actions),
  with new regression coverage for save-conflict detection, trash restore, find & replace,
  tag rename/merge/delete, the offline write-queue replay, rich-text paste sanitizing, and
  import error handling.

### Fixed
- Importing a JSON file whose entire contents are `null` (or another non-object value) now
  shows an "Invalid JSON" message instead of silently failing.

## [1.10.0] — 2026-07-13

### Added
- Duplicate a whole page, a whole section (with its subsections), or a block — discreet ⋯/tree
  controls; copies land directly below the original.

### Changed
- Faster cold boot — restore open tabs in parallel and drop a redundant tree reload (fewer,
  concurrent API round-trips).

### Fixed
- Horizontal scrollbars now appear consistently for wide block content in view mode across all
  kinds (code, CSV, note code/tables, rich, JSON); JSON tree scrolls horizontally instead of
  wrapping. Long unbroken strings in note prose now wrap inside the block instead of
  overflowing/clipping.

## [1.9.0] — 2026-06-23

### Added
- **CSV / table block** — a new block kind. Edit it as plain CSV text (the first row is the
  header); when not editing it renders as a clean table. The parser handles quoted fields,
  `""` escapes, embedded newlines, and auto-detects comma / semicolon / tab delimiters.
  Malformed input never breaks the view — an unterminated quote or rows with differing column
  counts show a warning banner above a best-effort table. CSV blocks export to a Markdown table
  (Markdown export) and an HTML `<table>` (HTML export), and convert to/from the other block
  kinds like any other.
- **JSON tree block** — a new block kind. Edit it as raw JSON; when not editing it renders as a
  collapsible, syntax-colored tree. Click any key or array index to copy its JS-accessor path
  (e.g. `root.records[0].Id`), collapse/expand nodes to navigate large payloads, and use
  **Format** to pretty-print. Invalid JSON never breaks the view — it shows a clear error plus
  the raw text. JSON blocks export to a pretty-printed code block (Markdown / HTML) and convert
  to/from the other block kinds.
- **Collapse-all / expand-all toggle** on the JSON tree block — one toolbar button folds or unfolds
  every node at once (in addition to the existing per-node expand/collapse).

### Fixed
- Long lines in the **code / CSV / JSON** source editors now scroll horizontally instead of being
  clipped, in both edit and view modes, with a thin dark-themed scrollbar. **Note (Markdown)** editors
  wrap prose instead (so a long paragraph stays readable while editing).
- Wide content in **Note (Markdown)** and **Rich-text** blocks now scrolls horizontally in view mode:
  fenced code blocks and tables get their own horizontal scrollbar instead of spilling/clipping.
- A two-finger sideways trackpad swipe over a horizontally-scrolling editor no longer triggers the
  browser's back/forward navigation (overscroll is contained at the page root).

## [1.8.0] — 2026-06-19

### Added
- **Password sign-out** — a *Forget password* item in the sidebar `⋯` menu clears the stored auth
  token (shown only when the optional password gate is in use).
- **Deep-search result cap** — content search now renders at most 200 matches with a *"Showing first
  N of M — refine your search"* banner, keeping the sidebar responsive on large libraries.
- **Automated test suites + docs** — a server-side API test harness (`codeman/tests-api.sh`), an
  expanded client suite (`codeman/tests.html`), a documented regression matrix (`docs/TEST_CASES.md`),
  and this changelog.

### Changed
- Note blocks render prose in a sans-serif font (no longer monospace).
- Clearer dialog copy: the save-conflict prompt states that Cancel discards unsaved changes; the
  delete confirmation says items move to Trash (restorable) rather than "cannot be undone".
- UI/mobile polish: larger tree-delete tap target, section titles ellipsize instead of clipping,
  project-card names no longer hide behind the PROJECT badge, onboarding buttons match the
  project/page colors, panel sub-text meets contrast, and tag-manager rows wrap on mobile.
- Accessibility: project rows are announced as "project" instead of "folder".

### Fixed
- Converting a rich-text block to another kind no longer drops line breaks.
- Deep content search now matches non-ASCII text (emoji, accents, CJK).
- Creating or saving a page under a missing folder returns a clean error instead of a raw server
  warning that could flip the app into offline mode.
- Emptying the trash now also clears the item's history; concurrent same-second saves keep distinct
  history versions.
- Offline: a queued change flushes on a fresh online start, and a malformed server response no longer
  falsely flips the app offline.
- Dragging to reorder in the double/Miller layout no longer mis-places the item.
- Rapidly opening the same page no longer creates duplicate tabs.

### Security
- `empty_trash` confines history deletion to the data root (path-traversal guard on the stored
  original path).
- A wrong password is no longer persisted as the auth token.
