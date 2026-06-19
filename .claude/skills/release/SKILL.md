---
name: release
description: >-
  Cut / ship / publish a new CodeMan release end to end. Use when the user says "release",
  "cut a release", "ship it", "publish a version", "do a release", or "bump and release". Reviews
  changes since the last release, decides + applies the version bump (both version files), updates
  CLAUDE.md / README / docs/TEST_CASES.md (+ tests) / CHANGELOG as needed, runs the test suites,
  then — behind ONE confirmation gate — commits, pushes, opens a PR to main, squash-merges it, tags
  the merged commit, and publishes the release notes.
---

# Release CodeMan

You are cutting a release. Work through the phases in order. **All local work happens first; nothing
is pushed, merged, tagged, or published until the single confirmation gate in Phase 5 is approved.**

Background facts (verify, don't assume): version lives in **two** files — `codeman/version.js`
(`self.CODEMAN_VERSION = 'X.Y.Z'`) and `codeman-desktop/package.json` (`version`). Default branch is
`main`; releases are driven by `vX.Y.Z` semver tags. **CI (`.github/workflows/codeman-desktop.yml`)
auto-builds and auto-creates the GitHub Release on tag push** (`softprops/action-gh-release@v2`,
uploads the `.dmg`/`.exe`) — so this skill must *create-or-edit* the release notes, never assume it
owns creation. The release flow is also documented in `CLAUDE.md` (CI section) and `CHANGELOG.md`.

**Argument** (optional, from how the skill was invoked):
- none → auto-decide the bump from the diff.
- `major` | `minor` | `patch` → force the bump level.
- `X.Y.Z` → pin that exact version.

## Phase 0 — Preflight (read-only; stop early on a blocker)
- `gh auth status` — if not authenticated, stop and tell the user to run `gh auth login`.
- `git branch --show-current` — expect a **feature branch**. If on `main` or detached HEAD, ask the
  user how to proceed before doing anything.
- `git fetch --tags --quiet`. Last release = `git describe --tags --abbrev=0 --match 'v*'`.
- Confirm there is something to release: a non-empty `git status --porcelain` OR commits since the
  last tag (`git log vLAST..HEAD --oneline`). If nothing, stop and say so.

## Phase 1 — Analyze the changes (read-only) — do this ONCE, reuse for version + changelog
Review **both** committed-since-last-tag and uncommitted work:
- `git diff <vLAST>...HEAD --stat` and `git status --porcelain`, then read the meaningful diffs
  (`git diff <vLAST>...HEAD`, `git diff`, `git diff --staged`).
Categorize every user-visible change into **Added / Changed / Fixed / Security**, and flag any
**breaking** change. Hold this categorized list — it drives both the version decision and the
changelog. (Ignore noise: test data under `codeman/structures/`, `.history/`, build artifacts.)

## Phase 2 — Decide + apply the version bump
1. **Already bumped?** Check whether `codeman/version.js` and `codeman-desktop/package.json` already
   show a version **higher** than the last tag (in the working tree or commits-since-tag). If both
   already raised and consistent, use that version — do not bump again.
2. Otherwise choose the new version:
   - the invocation argument if given (`X.Y.Z`, or `major|minor|patch` applied to the last tag), else
   - semver from Phase 1: **breaking → major**, **any new feature → minor**, **only fixes/docs/chore → patch**.
3. Apply to **both** files (they must match):
   - In `codeman-desktop/`: `npm version <X.Y.Z> --no-git-tag-version --allow-same-version`
     (updates `package.json` **and** `package-lock.json`).
   - `codeman/version.js`: replace with the SAME pattern CI uses —
     `sed -i.bak "s/CODEMAN_VERSION = '[^']*'/CODEMAN_VERSION = '<X.Y.Z>'/" codeman/version.js`
     then delete the `.bak`. (Or an exact Edit of that one line.)
   - Verify: both files now read `<X.Y.Z>`.

## Phase 3 — Update docs + tests (only what the changes warrant)
- **CLAUDE.md** — update only if architecture, data model, conventions, or a gotcha changed. Skip for
  pure fixes. Keep it code-focused (no deployment/secret specifics).
- **docs/TEST_CASES.md** — for any new/changed behavior, add or update the `TC-<area>-<n>` case(s)
  (Core tier unless it's hard/slow → Extended), and **add matching automated tests**: client logic →
  `codeman/tests.html` (`t()`/`ta()`), server/API → `codeman/tests-api.sh`. This is the repo rule:
  *a fix without a case here is an untested fix.*
- **README.md** — update only if user-facing features/setup changed (its `## Features` / `## Setup`).
  Don't add a version string; the Releases link already points at GitHub Releases.
- **CHANGELOG.md** — promote the `## [Unreleased]` section to `## [<X.Y.Z>] — <YYYY-MM-DD>` (today via
  `date +%F`), populated from Phase 1's categorized list (only the non-empty groups), and leave a
  fresh empty `## [Unreleased]` heading above it. Keep entries user-facing and concise.

## Phase 4 — Verify (hard gate before committing)
- Server suite: `bash codeman/tests-api.sh` — must exit 0.
- Client suite: run `codeman/tests.html` via the preview or Chrome MCP if available and confirm
  **"0 failed"**; if no browser harness is reachable, say so and rely on the API suite.
- Lint anything you touched: `php -l codeman/api.php`, `node --check codeman/src/<file>.js`,
  `bash -n codeman/tests-api.sh`.
- If anything fails, fix it (or stop and report) — do **not** proceed to commit.
- (Optional, for a large/risky release: suggest a `senior-qa-engineer` Core pass. Not required.)

## Phase 5 — REVIEW + single confirmation gate
Print a concise summary and **STOP for explicit approval**. Nothing below this line runs before a yes.
Show:
- chosen **version** and a one-line rationale (which change forced the bump level);
- the list of **files changed**;
- the **new CHANGELOG section** verbatim;
- the proposed **commit message**;
- target = `main`, merge = **squash**.

## Phase 6 — Ship (remote / irreversible — only after approval)
1. `git add -A`
2. Commit:
   ```
   git commit -m "Release v<X.Y.Z> — <headline>" -m "<changelog highlights>" \
     -m "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
   ```
3. `git push -u origin <current-feature-branch>`
4. Open the PR (reuse an existing open PR for the branch if one exists, else create):
   `gh pr create --base main --head <branch> --title "Release v<X.Y.Z> — <headline>" --body "<changelog section + short summary>"`
5. Squash-merge: `gh pr merge --squash` (wait for it to report merged).
6. **Tag the MERGED main commit** (not the feature branch):
   ```
   git fetch origin main
   git tag -a v<X.Y.Z> -m "v<X.Y.Z>" origin/main
   git push origin v<X.Y.Z>          # ← triggers the CI build + auto-release
   ```
7. **Publish release notes (create-or-edit, to coexist with CI):**
   ```
   gh release create v<X.Y.Z> --title "v<X.Y.Z>" --notes "<the CHANGELOG section>" \
     || gh release edit v<X.Y.Z> --notes "<the CHANGELOG section>"
   ```
   CI's `action-gh-release` then uploads the `.dmg`/`.exe` to this release without clobbering the notes.
8. Report: the PR link, the merged commit, the tag, and the Release URL (`gh release view v<X.Y.Z> --web`).

## Guardrails (must hold)
- **Never clobber a shipped tag:** if `v<X.Y.Z>` already exists (`git tag --list` / `gh release view`),
  stop and ask — do not overwrite.
- Stop if there's nothing to release.
- Expect a feature branch; if on `main`/detached, ask first.
- Never force-push. Keep the `Co-Authored-By` trailer on the commit.
- The tag must point at the merged `main` commit, so CI builds the released code.
- If `gh pr merge` is blocked (checks/branch protection), stop and report — don't try to bypass it.

## How to use
- `/release` — auto-detect the bump from the diff and run the whole flow, pausing once at Phase 5.
- `/release minor` (or `major` / `patch`) — force the bump level.
- `/release 1.8.0` — pin the exact version.
