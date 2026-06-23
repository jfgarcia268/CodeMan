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
