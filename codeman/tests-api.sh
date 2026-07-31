#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# CodeMan server-side API tests (api.php).
#
# Spins a throwaway `php -S` against a TEMP CODEMAN_DATA dir, asserts responses
# + on-disk effects, then tears everything down. No deps beyond php + curl.
# Pairs with codeman/tests.html (the client unit tests). Covers the server-side
# fixes that can't run in the browser: path-traversal confinement, parent-dir
# guards, unicode content search, same-second history retention, the empty_trash
# history-prune + its traversal guard, save-conflict detection (stale baseMtime
# → conflict; force → history snapshot), the project-nesting move guard, the
# rename traversal guard, the restore_trash round-trip, replace_content
# (preview dry-run / literal / regex / regex-too-complex bound), rename_tag
# (rename/merge/delete), the safePath reject contract (dotfile reads + traversal
# rejected at get_page/delete/list_history/restore_trash), the offline-replay
# reconstruction shapes round-tripping post-safePath, get_history_version +
# restore_history (atomic write, never a raw copy over the live page), HISTORY_KEEP
# pruning keeping the 20 NEWEST versions, contentFileIterator never descending into
# .history/.trash, rebuild_index, reorder, col_sorts/set_col_sort (incl. the ""
# root key), and the optional password gate (header-only; ?token= no longer accepted).
#
#   Run:  bash codeman/tests-api.sh           (exit 0 = all green)
#         bash codeman/tests-api.sh 8099       (override the starting port;
#                                               a taken port is skipped automatically)
# ---------------------------------------------------------------------------
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # the codeman/ dir = docroot
PORT="${1:-8097}"
BASE="http://127.0.0.1:$PORT/api.php"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/cm_apitest.XXXXXX")"
DATA="$TMP/data"; mkdir -p "$DATA"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ✗ $1  →  $2"; }
# assert two strings equal
eqs() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "got [$2] want [$3]"; fi; }
# assert haystack contains needle
has() { case "$2" in *"$3"*) ok "$1";; *) bad "$1" "[$2] has no [$3]";; esac; }
# assert haystack does NOT contain needle
hasnt() { case "$2" in *"$3"*) bad "$1" "[$2] unexpectedly has [$3]";; *) ok "$1";; esac; }

SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

# Launch (or relaunch) the throwaway server. If the requested port is already
# taken (a parallel run, a CI neighbor), `php -S` dies instantly on bind — hunt
# upward for a free port (bounded) instead of failing the whole suite. BASE is
# recomputed after the port settles so every later request hits the live server.
start_server() { # $1 = optional CODEMAN_PASSWORD (empty = gate off); $2 = optional CODEMAN_CSRF ("off" = break-glass)
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; SERVER_PID=""; fi
  local tries=0
  while :; do
    CODEMAN_DATA="$DATA" CODEMAN_PASSWORD="${1:-}" CODEMAN_CSRF="${2:-}" php -S "127.0.0.1:$PORT" -t "$SCRIPT_DIR" >/dev/null 2>&1 &
    SERVER_PID=$!
    sleep 0.3                                   # a failed bind exits immediately
    if kill -0 "$SERVER_PID" 2>/dev/null; then
      BASE="http://127.0.0.1:$PORT/api.php"
      curl -s -o /dev/null --retry 40 --retry-connrefused --retry-delay 1 "http://127.0.0.1:$PORT/" || { echo "server failed to start"; exit 2; }
      return 0
    fi
    SERVER_PID=""
    tries=$((tries+1))
    if [ "$tries" -ge 20 ]; then echo "no free port found (last tried $PORT)"; exit 2; fi
    PORT=$((PORT+1))
  done
}

# POST helper: post <action> <json-body> [authtoken]  → echoes "<body>\n<httpcode>"
# (avoids empty-array expansion — macOS bash 3.2 errors on "${arr[@]}" under set -u)
# Sends X-CodeMan-Request: 1 on every write, mirroring the real client (apiHeaders) —
# so the suite stays representative when server-side CSRF enforcement lands in R4.
post() {
  if [ -n "${3:-}" ]; then
    curl -s -w $'\n%{http_code}' -H "X-CodeMan-Request: 1" -H "X-CodeMan-Auth: $3" -X POST -H "Content-Type: application/json" -d "$2" "$BASE?action=$1"
  else
    curl -s -w $'\n%{http_code}' -H "X-CodeMan-Request: 1" -X POST -H "Content-Type: application/json" -d "$2" "$BASE?action=$1"
  fi
}
body() { printf '%s' "$1" | sed '$d'; }     # all but last line
code() { printf '%s' "$1" | tail -n1; }      # last line

command -v php  >/dev/null || { echo "php not found"; exit 2; }
command -v curl >/dev/null || { echo "curl not found"; exit 2; }

echo "CodeMan API tests — temp data: $DATA"
start_server ""

# --- parent-dir guards (create_page / save_page) ---------------------------
r=$(post create_page '{"name":"P1","parent":""}');                 eqs "create_page valid → 200"            "$(code "$r")" "200"
test -f "$DATA/P1.json" && ok "create_page wrote the file" || bad "create_page wrote the file" "missing"
r=$(post create_page '{"name":"X","parent":"NoSuchFolder"}');      eqs "create_page missing parent → 404"   "$(code "$r")" "404"
has "create_page missing parent → clean JSON error" "$(body "$r")" '"error":"parent folder does not exist"'
hasnt "create_page missing parent → no PHP warning leaked" "$(body "$r")" "Warning"
test ! -e "$DATA/NoSuchFolder" && ok "create_page missing parent wrote nothing" || bad "create_page missing parent wrote nothing" "NoSuchFolder exists"

r=$(post create_folder '{"name":"Box","parent":""}');             eqs "create_folder → 200" "$(code "$r")" "200"
r=$(post save_page '{"path":"Box/Pg.json","data":{"title":"Pg","sections":[]}}'); eqs "save_page valid → 200" "$(code "$r")" "200"
r=$(post save_page '{"path":"Ghost/Pg.json","data":{"title":"x","sections":[]}}'); eqs "save_page missing parent → 404" "$(code "$r")" "404"
has "save_page missing parent → clean JSON error" "$(body "$r")" '"error"'

# create_folder's parent must exist too. The recursive mkdir used to MATERIALISE whatever
# parent it was handed and still report ok:true — so importPages' off-by-one parent
# derivation littered the root with bogus folders instead of failing, and any client bug or
# crafted request could create arbitrary nested structure inside the data root.
r=$(post create_folder '{"name":"X","parent":"no/such/place"}');   eqs "create_folder missing parent → 404" "$(code "$r")" "404"
has "create_folder missing parent → clean JSON error" "$(body "$r")" '"error":"parent folder does not exist"'
test ! -e "$DATA/no" && ok "create_folder missing parent materialised nothing" || bad "create_folder missing parent materialised nothing" "$DATA/no exists"
# …but a legitimate nested folder (parent created first) still works, one level at a time.
r=$(post create_folder '{"name":"Deep","parent":"Box"}');          eqs "create_folder nested under an existing parent → 200" "$(code "$r")" "200"
test -d "$DATA/Box/Deep" && ok "create_folder nested folder was created" || bad "create_folder nested folder was created" "missing"

# --- safePath confinement (no traversal escapes the data root) -------------
post save_page '{"path":"../../ESCAPE_SENTINEL.json","data":{"title":"e","sections":[]}}' >/dev/null
hasnt "save_page traversal did not write a sibling of the data dir" "$(ls "$(dirname "$DATA")" 2>/dev/null)" "ESCAPE_SENTINEL.json"
hasnt "save_page traversal did not write above the temp root"       "$(ls "$(dirname "$TMP")" 2>/dev/null)" "ESCAPE_SENTINEL.json"

# --- unicode content search (search_content) + search_blocks ---------------
post save_page '{"path":"Uni.json","data":{"title":"Uni","sections":[{"title":"S","collapsed":false,"tags":[],"blocks":[{"type":"bash","label":"","code":"echo celebration 🎉 café 日本語"}],"subsections":[]}]}}' >/dev/null
sc() { curl -sG "$BASE" --data-urlencode "action=search_content" --data-urlencode "q=$1"; }
has "search_content matches emoji 🎉"        "$(sc '🎉')"   "Uni.json"
has "search_content matches accented 'café'" "$(sc 'café')" "Uni.json"
has "search_content matches CJK '日本語'"     "$(sc '日本語')" "Uni.json"
has "search_content matches ASCII 'echo'"    "$(sc 'echo')" "Uni.json"
sb=$(curl -sG "$BASE" --data-urlencode "action=search_blocks" --data-urlencode "q=café")
has "search_blocks matches 'café'" "$sb" "Uni.json"

# A page stored with \uXXXX-ESCAPED unicode (an external editor / a create_page-style
# JSON_PRETTY_PRINT write). The raw stripos fast path MISSES the literal UTF-8 query,
# so this exercises the decode-and-recheck fallback that keeps unicode search correct.
printf '%s' '{"title":"UniEsc","sections":[{"title":"S","collapsed":false,"tags":[],"blocks":[{"type":"bash","label":"","code":"marker \u65e5\u672c\u8a9e end"}],"subsections":[]}]}' > "$DATA/UniEsc.json"
has "search_content decode-fallback matches \uXXXX-escaped CJK" "$(sc '日本語')" "UniEsc.json"
has "search_content raw fast-path matches ASCII in an escaped file" "$(sc 'marker')" "UniEsc.json"

# --- slash-query search parity (fallback broadening + writer normalization) --
# A page with an interior slash in content, stored with '\/' ESCAPED on disk — as the
# OLD replace_content/rename_tag (bare JSON_PRETTY_PRINT) writes did, and external editors
# do. The raw stripos fast path MISSES "api/v1" (disk holds "api\/v1"); the broadened
# fallback (query contains '/') decodes-and-rechecks → the page must still be found
# (before the fix this returned zero — a page silently hidden from a slash search).
printf '%s' '{"title":"Slash","sections":[{"title":"S","collapsed":false,"tags":["slashtag"],"blocks":[{"type":"bash","label":"","code":"GET api\/v1\/users"}],"subsections":[]}]}' > "$DATA/Slash.json"
has "search_content slash-query matches an escaped-slash file (fallback)" "$(sc 'api/v1')" "Slash.json"
# Writer normalization: rewriting the page via rename_tag (routine tag manager) must
# re-store it with UNESCAPED slashes, so the raw fast path matches WITHOUT a decode.
post rename_tag '{"from":"slashtag","to":"slashtag2"}' >/dev/null
has "search_content slash-query matches after rename_tag rewrite" "$(sc 'api/v1')" "Slash.json"
grep -q 'api/v1' "$DATA/Slash.json" && ok "rename_tag re-stores slashes UNESCAPED on disk" || bad "rename_tag re-stores slashes UNESCAPED on disk" "still escaped"
# Same via replace_content (find & replace): change unrelated text → forces a rewrite.
post replace_content '{"find":"users","replace":"accounts"}' >/dev/null
has "search_content slash-query matches after replace_content rewrite" "$(sc 'api/v1')" "Slash.json"
grep -q 'api/v1' "$DATA/Slash.json" && ok "replace_content re-stores slashes UNESCAPED on disk" || bad "replace_content re-stores slashes UNESCAPED on disk" "still escaped"
# Sanity: the non-ASCII fallback + ASCII-no-slash fast path are unaffected by the change.
has "search_content non-ASCII still matches (fallback intact)" "$(sc '日本語')" "UniEsc.json"
has "search_content ASCII-no-slash still matches (fast path intact)" "$(sc 'echo')" "Uni.json"

# --- HTML-project b64 search strip ------------------------------------------
# An html block stores binary assets as ONE UNBROKEN LINE of standard base64 under the
# reserved "b64" key. Random base64 runs contain real words by chance, so search_content
# blanks those spans before scanning — otherwise every page with an image becomes a
# false positive. The SAME word in a real `code` field must still match on that page.
post save_page '{"path":"Proj.json","data":{"title":"Proj","sections":[{"title":"S","collapsed":false,"tags":[],"blocks":[{"type":"html","html":true,"label":"","entry":"index.html","code":"<img src=\"logo.png\"> findmeplease","files":[{"p":"logo.png","m":"image/png","b64":"AAAAreportAAAAquarterlyAAAA"}]}],"subsections":[]}]}}' >/dev/null
hasnt "search_content ignores a word inside a b64 blob"        "$(sc 'report')"       "Proj.json"
has   "search_content still matches the block's real code"     "$(sc 'findmeplease')" "Proj.json"
# Same guarantee through the DECODED-FALLBACK branch: a slash-bearing query (base64's
# alphabet includes '/') and a non-ASCII query both take the decode path, which applies
# the identical strip — without it the false positives come straight back.
post save_page '{"path":"Proj2.json","data":{"title":"Proj2","sections":[{"title":"S","collapsed":false,"tags":[],"blocks":[{"type":"html","html":true,"label":"","entry":"index.html","code":"plain ascii entry 日本語marker","files":[{"p":"a.png","m":"image/png","b64":"AAAAap/v1AAAAqqq"}]}],"subsections":[]}]}}' >/dev/null
hasnt "search_content fallback ignores a slash-query inside b64" "$(sc 'ap/v1')"       "Proj2.json"
has   "search_content fallback still matches real CJK content"   "$(sc '日本語marker')" "Proj2.json"

# A RICH block can embed an image INLINE as a data: URL (the sanitizer allows
# data:image/…;base64,…). Same false-hit problem as "b64", but mid-string inside the
# block's HTML rather than under its own key — so the base64 run itself is blanked.
post save_page '{"path":"Rich.json","data":{"title":"Rich","sections":[{"title":"S","collapsed":false,"tags":[],"blocks":[{"type":"plaintext","rich":true,"label":"","code":"<p>quarterly notes</p><img src=\"data:image/png;base64,AAAAinvoiceAAAAledgerAAAA\">"}],"subsections":[]}]}}' >/dev/null
hasnt "search_content ignores a word inside an inline data: image" "$(sc 'invoice')"   "Rich.json"
has   "search_content still matches the rich block's real prose"   "$(sc 'quarterly')" "Rich.json"

# --- list_tags (index-backed: pageMetaIndexed + flushIndex) ----------------
post save_page '{"path":"TagA.json","data":{"title":"TagA","sections":[{"title":"S","collapsed":false,"tags":["alpha","shared"],"blocks":[],"subsections":[]}]}}' >/dev/null
post save_page '{"path":"TagB.json","data":{"title":"TagB","sections":[{"title":"S","collapsed":false,"tags":["shared"],"blocks":[],"subsections":[]}]}}' >/dev/null
lt=$(curl -sG "$BASE" --data-urlencode "action=list_tags")
has "list_tags returns tag 'alpha'"             "$lt" '"tag":"alpha"'
has "list_tags counts 'shared' across 2 pages"  "$lt" '"tag":"shared","count":2'
# Warm the index, then confirm a warm call is still correct (index-backed, cached
# tags). The ≤5 ms warm-timing target is validated separately (see docs/TEST_CASES.md
# Extended perf) — a hard ms assertion here would be flaky across CI/macOS.
curl -sG "$BASE" --data-urlencode "action=list_tags" >/dev/null   # warm the mtime index
lt2=$(curl -sG "$BASE" --data-urlencode "action=list_tags")
has "list_tags warm call still counts 'shared'" "$lt2" '"tag":"shared","count":2'
test -f "$DATA/.index.json" && ok "list_tags populated the metadata index" || bad "list_tags populated the metadata index" "no .index.json"

# --- same-second history retention (collision bump, no silent drop) --------
post create_page '{"name":"Hist","parent":""}' >/dev/null
for i in 1 2 3 4; do post save_page "{\"path\":\"Hist.json\",\"data\":{\"title\":\"v$i\",\"sections\":[]}}" >/dev/null; done
hist=$(curl -sG "$BASE" --data-urlencode "action=list_history" --data-urlencode "path=Hist.json")
nts=$(printf '%s' "$hist" | grep -o '"ts":[0-9]*' | sort -u | wc -l | tr -d ' ')
nent=$(printf '%s' "$hist" | grep -o '"ts":[0-9]*' | wc -l | tr -d ' ')
[ "$nent" -ge 2 ] && ok "rapid saves produced >=2 history versions ($nent)" || bad "rapid saves produced >=2 history versions" "got $nent"
eqs "all history ts are distinct (no same-second drop)" "$nts" "$nent"

# --- empty_trash prunes history (and the traversal guard holds) ------------
post create_page '{"name":"Hp","parent":""}' >/dev/null
post save_page '{"path":"Hp.json","data":{"title":"a","sections":[]}}' >/dev/null
post save_page '{"path":"Hp.json","data":{"title":"b","sections":[]}}' >/dev/null
test -d "$DATA/.history/Hp.json" && ok "history dir exists before prune" || bad "history dir exists before prune" "missing"
post delete '{"path":"Hp.json"}' >/dev/null
test -d "$DATA/.history/Hp.json" && ok "soft-delete preserves history (restorable)" || bad "soft-delete preserves history" "pruned too early"
# craft a malicious trash entry whose meta origPath escapes .history via ../
SENT="$TMP/SENTINEL_KEEP"; mkdir -p "$SENT"; echo keep > "$SENT/x"
mkdir -p "$DATA/.trash/evil"; echo y > "$DATA/.trash/evil/y"
printf '{"origPath":"../../SENTINEL_KEEP","name":"evil","deletedAt":1,"isDir":true}' > "$DATA/.trash/evil.meta"
post empty_trash '{}' >/dev/null
test -f "$SENT/x" && ok "empty_trash traversal guard: sentinel OUTSIDE .history survived" || bad "empty_trash traversal guard" "SENTINEL DELETED (traversal escaped!)"
test ! -d "$DATA/.history/Hp.json" && ok "empty_trash pruned the page's history" || bad "empty_trash pruned the page's history" "still present"

# --- save-conflict detection (stale baseMtime → conflict; force → history) --
post create_page '{"name":"Conf","parent":""}' >/dev/null
r=$(post get_page '{"path":"Conf.json"}')
mt=$(body "$r" | grep -o '"_mtime":[0-9]*' | grep -o '[0-9]*$')
[ -n "$mt" ] && ok "get_page returns _mtime" || bad "get_page returns _mtime" "no _mtime in [$(body "$r")]"
sleep 1   # mtime is second-granularity — make the concurrent save observably newer
post save_page '{"path":"Conf.json","data":{"title":"second","sections":[]},"baseMtime":null}' >/dev/null
r=$(post save_page "{\"path\":\"Conf.json\",\"data\":{\"title\":\"stale\",\"sections\":[]},\"baseMtime\":$mt}")
has "stale baseMtime → conflict flagged" "$(body "$r")" '"conflict":true'
has "conflict left the file untouched" "$(cat "$DATA/Conf.json")" '"second"'
hasnt "conflict wrote no stale content" "$(cat "$DATA/Conf.json")" '"stale"'
nh_before=$(ls "$DATA/.history/Conf.json" 2>/dev/null | wc -l | tr -d ' ')
r=$(post save_page "{\"path\":\"Conf.json\",\"data\":{\"title\":\"forced\",\"sections\":[]},\"baseMtime\":$mt,\"force\":true}")
eqs "forced save over conflict → 200" "$(code "$r")" "200"
has "forced save → ok" "$(body "$r")" '"ok":true'
has "forced save wrote the new content" "$(cat "$DATA/Conf.json")" '"forced"'
nh_after=$(ls "$DATA/.history/Conf.json" 2>/dev/null | wc -l | tr -d ' ')
[ "$nh_after" -gt "$nh_before" ] && ok "forced save snapshotted the overwritten version ($nh_before → $nh_after)" || bad "forced save snapshotted the overwritten version" "history count $nh_before → $nh_after"

# --- move guard: a project can never land inside a plain folder -------------
post create_project '{"name":"Prj","parent":""}' >/dev/null
post create_folder '{"name":"PlainF","parent":""}' >/dev/null
r=$(post move '{"path":"Prj","target":"PlainF"}')
has "move project → plain folder rejected" "$(body "$r")" '"error"'
test -d "$DATA/Prj" && ok "rejected move left the project in place" || bad "rejected move left the project in place" "Prj missing at root"
test ! -e "$DATA/PlainF/Prj" && ok "rejected move wrote nothing into the folder" || bad "rejected move wrote nothing into the folder" "PlainF/Prj exists"
r=$(post move '{"path":"PlainF","target":"Prj"}')
has "move plain folder → project allowed" "$(body "$r")" '"ok":true'
test -d "$DATA/Prj/PlainF" && ok "allowed move relocated the folder" || bad "allowed move relocated the folder" "Prj/PlainF missing"

# --- rename guard: traversal newName is rejected -----------------------------
r=$(post rename '{"path":"P1.json","newName":"../esc"}')
has "rename traversal newName → invalid name" "$(body "$r")" '"error":"invalid name"'
test -f "$DATA/P1.json" && ok "rejected rename left the source intact" || bad "rejected rename left the source intact" "P1.json gone"
test ! -e "$TMP/esc.json" -a ! -e "$DATA/esc.json" && ok "rejected rename wrote nothing" || bad "rejected rename wrote nothing" "esc.json appeared"

# --- restore_trash round-trip (delete → list → restore → back at origPath) ---
post create_folder '{"name":"RtBox","parent":""}' >/dev/null
post create_page '{"name":"Rt","parent":"RtBox"}' >/dev/null
post delete '{"path":"RtBox/Rt.json"}' >/dev/null
test ! -e "$DATA/RtBox/Rt.json" && ok "delete moved the page out of the tree" || bad "delete moved the page out of the tree" "still present"
lt=$(post list_trash '{}')
tid=$(body "$lt" | grep -o '"id":"[^"]*Rt\.json"' | head -1 | sed 's/^"id":"//; s/"$//')
[ -n "$tid" ] && ok "list_trash shows the deleted page" || bad "list_trash shows the deleted page" "no Rt.json id in [$(body "$lt")]"
has "list_trash keeps origPath" "$(body "$lt")" '"origPath":"RtBox\/Rt.json"'
r=$(post restore_trash "{\"id\":\"$tid\"}")
has "restore_trash → ok" "$(body "$r")" '"ok":true'
test -f "$DATA/RtBox/Rt.json" && ok "restore put the page back at origPath" || bad "restore put the page back at origPath" "RtBox/Rt.json missing"
test ! -e "$DATA/.trash/$tid" -a ! -e "$DATA/.trash/$tid.meta" && ok "restore cleared the trash entry + .meta" || bad "restore cleared the trash entry + .meta" "leftovers in .trash"

# --- replace_content: preview is a dry run; literal + regex writes ----------
post create_page '{"name":"Rc","parent":""}' >/dev/null
post save_page '{"path":"Rc.json","data":{"title":"Rc","sections":[{"title":"S","collapsed":false,"tags":[],"blocks":[{"type":"bash","label":"","code":"foo bar foo baz"}],"subsections":[]}]}}' >/dev/null
nh_rc=$(ls "$DATA/.history/Rc.json" 2>/dev/null | wc -l | tr -d ' ')
r=$(post replace_content '{"find":"foo","replace":"XX","preview":true}')
has "replace preview counts matches" "$(body "$r")" '"totalMatches":2'
has "replace preview flags itself" "$(body "$r")" '"preview":true'
has "replace preview did not write" "$(cat "$DATA/Rc.json")" 'foo bar foo baz'
eqs "replace preview did not snapshot history" "$(ls "$DATA/.history/Rc.json" 2>/dev/null | wc -l | tr -d ' ')" "$nh_rc"
r=$(post replace_content '{"find":"foo","replace":"XX"}')
has "literal replace reports the changed page" "$(body "$r")" '"changedPages":1'
has "literal replace rewrote the block" "$(cat "$DATA/Rc.json")" 'XX bar XX baz'
hasnt "literal replace left no match behind" "$(cat "$DATA/Rc.json")" 'foo'
nh_rc2=$(ls "$DATA/.history/Rc.json" 2>/dev/null | wc -l | tr -d ' ')
[ "$nh_rc2" -gt "$nh_rc" ] && ok "replace-all snapshotted history first ($nh_rc → $nh_rc2)" || bad "replace-all snapshotted history first" "history count $nh_rc → $nh_rc2"
r=$(post replace_content '{"find":"b(a)r","replace":"B$1R","regex":true}')
has "regex replace applies the capture group" "$(cat "$DATA/Rc.json")" 'XX BaR XX baz'
r=$(post replace_content '{"find":"(","regex":true}')
has "invalid regex → clean error" "$(body "$r")" '"error":"invalid regular expression"'

# --- rename_tag: rename / merge / delete, history-snapshotted ----------------
post create_page '{"name":"Tg","parent":""}' >/dev/null
post save_page '{"path":"Tg.json","data":{"title":"Tg","sections":[{"title":"S","collapsed":false,"tags":["oldtag","keeptag"],"blocks":[],"subsections":[]}]}}' >/dev/null
nh_tg=$(ls "$DATA/.history/Tg.json" 2>/dev/null | wc -l | tr -d ' ')
r=$(post rename_tag '{"from":"oldtag","to":"newtag"}')
has "rename_tag reports 1 changed page" "$(body "$r")" '"pages":1'
has "rename_tag wrote the new tag" "$(cat "$DATA/Tg.json")" '"newtag"'
hasnt "rename_tag removed the old tag" "$(cat "$DATA/Tg.json")" '"oldtag"'
nh_tg2=$(ls "$DATA/.history/Tg.json" 2>/dev/null | wc -l | tr -d ' ')
[ "$nh_tg2" -gt "$nh_tg" ] && ok "rename_tag snapshotted history first ($nh_tg → $nh_tg2)" || bad "rename_tag snapshotted history first" "history count $nh_tg → $nh_tg2"
post rename_tag '{"from":"newtag","to":"keeptag"}' >/dev/null   # merge into an existing tag
eqs "rename_tag merge dedups into one tag" "$(grep -o '"keeptag"' "$DATA/Tg.json" | wc -l | tr -d ' ')" "1"
post rename_tag '{"from":"keeptag","to":""}' >/dev/null         # empty `to` = delete
hasnt "rename_tag empty to → tag deleted" "$(cat "$DATA/Tg.json")" 'keeptag'

# --- atomic writes: a save burst leaves NO temp residue + every page parses -------
post create_folder '{"name":"Atomic","parent":""}' >/dev/null
for i in 1 2 3 4 5 6 7 8; do
  post save_page "{\"path\":\"Atomic/Pg.json\",\"data\":{\"title\":\"v$i\",\"sections\":[{\"title\":\"S\",\"collapsed\":false,\"tags\":[],\"blocks\":[{\"type\":\"bash\",\"label\":\"\",\"code\":\"line $i\"}],\"subsections\":[]}]}}" >/dev/null
done
tmpleft=$(find "$DATA" -name '.tmp-*' 2>/dev/null | wc -l | tr -d ' ')
eqs "atomic writes leave no .tmp-* residue anywhere under data" "$tmpleft" "0"
# Every *.json under the data root (pages, history snapshots, .order/.index/.colsort)
# must still parse — a non-atomic write crashing mid-stream would leave a truncated file.
badjson=0
while IFS= read -r f; do
  php -r '$c=@file_get_contents($argv[1]); if($c==="" || (json_decode($c)===null && trim($c)!=="null")) exit(1);' "$f" 2>/dev/null || badjson=$((badjson+1))
done < <(find "$DATA" -type f -name '*.json' 2>/dev/null)
eqs "every JSON file parses after a save burst (no truncation)" "$badjson" "0"

# --- rename/move migrate the page's .history subtree ------------------------------
post create_folder '{"name":"Hm","parent":""}' >/dev/null
post create_page '{"name":"Old","parent":"Hm"}' >/dev/null
post save_page '{"path":"Hm/Old.json","data":{"title":"a","sections":[]}}' >/dev/null
post save_page '{"path":"Hm/Old.json","data":{"title":"b","sections":[]}}' >/dev/null
test -d "$DATA/.history/Hm/Old.json" && ok "history exists before rename" || bad "history exists before rename" "missing"
post rename '{"path":"Hm/Old.json","newName":"New"}' >/dev/null
test -d "$DATA/.history/Hm/New.json" && ok "rename migrated the page history to the new name" || bad "rename migrated the page history" "not at Hm/New.json"
test ! -d "$DATA/.history/Hm/Old.json" && ok "rename left no history at the old name" || bad "rename left no history at the old name" "still at Hm/Old.json"
hist=$(curl -sG "$BASE" --data-urlencode "action=list_history" --data-urlencode "path=Hm/New.json")
has "renamed page lists its migrated history" "$hist" '"ts"'
post create_folder '{"name":"HmDest","parent":""}' >/dev/null
post move '{"path":"Hm/New.json","target":"HmDest"}' >/dev/null
test -d "$DATA/.history/HmDest/New.json" && ok "move migrated the page history to the target" || bad "move migrated the page history" "not at HmDest/New.json"
test ! -d "$DATA/.history/Hm/New.json" && ok "move left no history at the old location" || bad "move left no history at the old location" "still at Hm/New.json"
# folder rename migrates the WHOLE history subtree
post create_folder '{"name":"HFolderA","parent":""}' >/dev/null
post create_page '{"name":"P","parent":"HFolderA"}' >/dev/null
post save_page '{"path":"HFolderA/P.json","data":{"title":"x","sections":[]}}' >/dev/null
post save_page '{"path":"HFolderA/P.json","data":{"title":"y","sections":[]}}' >/dev/null
post rename '{"path":"HFolderA","newName":"HFolderB"}' >/dev/null
test -d "$DATA/.history/HFolderB/P.json" && ok "folder rename migrated the whole history subtree" || bad "folder rename migrated the whole history subtree" "not at HFolderB/P.json"

# --- move into a dest whose .history ALREADY exists → merge, don't strand (LOW-1) ---
post create_folder '{"name":"MgD","parent":""}' >/dev/null
post create_page '{"name":"Mv","parent":"MgD"}' >/dev/null
post save_page '{"path":"MgD/Mv.json","data":{"title":"d1","sections":[]}}' >/dev/null
post save_page '{"path":"MgD/Mv.json","data":{"title":"d2","sections":[]}}' >/dev/null
post delete '{"path":"MgD/Mv.json"}' >/dev/null   # leaves .history/MgD/Mv.json behind (dest history)
test -d "$DATA/.history/MgD/Mv.json" && ok "dest history exists from a prior deleted page" || bad "dest history exists" "missing"
destv_before=$(ls "$DATA/.history/MgD/Mv.json" 2>/dev/null | wc -l | tr -d ' ')
sleep 1   # distinct timestamps so source versions don't collide with dest on merge
post create_page '{"name":"Mv","parent":""}' >/dev/null
post save_page '{"path":"Mv.json","data":{"title":"s1","sections":[]}}' >/dev/null
sleep 1
post save_page '{"path":"Mv.json","data":{"title":"s2","sections":[]}}' >/dev/null
test -d "$DATA/.history/Mv.json" && ok "source history exists before the dest-exists move" || bad "source history exists" "missing"
post move '{"path":"Mv.json","target":"MgD"}' >/dev/null
test ! -d "$DATA/.history/Mv.json" && ok "dest-exists move removed the stale source history (not stranded)" || bad "dest-exists move removed the stale source history" "source .history/Mv.json still present"
destv_after=$(ls "$DATA/.history/MgD/Mv.json" 2>/dev/null | wc -l | tr -d ' ')
[ "$destv_after" -gt "$destv_before" ] && ok "dest-exists move merged source versions into dest ($destv_before → $destv_after)" || bad "dest-exists move merged source versions into dest" "dest count $destv_before → $destv_after"

# --- safePath reject contract: dotfile reads + traversal are rejected -------------
# get_page on a dotfile is refused (previously .index.json etc. could be read out)
r=$(post get_page '{"path":".index.json"}')
has "get_page dotfile (.index.json) → invalid path" "$(body "$r")" '"error":"invalid path"'
r=$(post get_page '{"path":"../../etc/passwd"}')
has "get_page traversal path → invalid path" "$(body "$r")" '"error":"invalid path"'
# deleting a hidden data dir is refused, and the dir survives
test -d "$DATA/.history" && ok "history dir present before the delete-dotfile probe" || bad "history dir present" "missing"
r=$(post delete '{"path":".history"}')
has "delete dotfile (.history) → invalid path" "$(body "$r")" '"error":"invalid path"'
test -d "$DATA/.history" && ok "delete .history left the history dir intact" || bad "delete .history left the history dir intact" ".history gone"
# list_history no longer raw-concats the path → a traversal resolves to nothing ([])
lh=$(curl -sG "$BASE" --data-urlencode "action=list_history" --data-urlencode "path=../../..")
eqs "list_history traversal path → empty array" "$lh" "[]"
# a crafted trash .meta with a traversal origPath stays inert on restore
mkdir -p "$DATA/.trash/evilr"; echo z > "$DATA/.trash/evilr/z"
printf '{"origPath":"../../ESC_RESTORE.json","name":"evilr","deletedAt":1,"isDir":false}' > "$DATA/.trash/evilr.meta"
r=$(post restore_trash '{"id":"evilr"}')
has "restore_trash traversal origPath → rejected" "$(body "$r")" '"error"'
test ! -e "$(dirname "$DATA")/ESC_RESTORE.json" && ok "restore_trash traversal wrote nothing outside data" || bad "restore_trash traversal wrote nothing" "ESC_RESTORE.json escaped"

# --- replace_content: a pathological (catastrophic-backtracking) regex fails clean ---
post create_page '{"name":"Rx","parent":""}' >/dev/null
post save_page '{"path":"Rx.json","data":{"title":"Rx","sections":[{"title":"S","collapsed":false,"tags":[],"blocks":[{"type":"bash","label":"","code":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaX"}],"subsections":[]}]}}' >/dev/null
r=$(post replace_content '{"find":"(a+)+$","replace":"z","regex":true,"preview":true}')
has "pathological regex (backtrack limit) → clean 'regex too complex'" "$(body "$r")" '"error":"regex too complex"'

# --- offline-replay reconstruction shapes still round-trip post-safePath ------------
# The offline queue replays exactly these bodies (enqueueReconstruct in offline.js); a
# legitimate nested path MUST still work — only ../ / . / dotfile segments reject.
post create_project '{"name":"OProj","parent":""}' >/dev/null
r=$(post create_folder '{"parent":"OProj","name":"OFold"}')
eqs "replay create_folder (nested) → 200" "$(code "$r")" "200"
# The replayed page carries a section (as a real replayed save does) so that the re-save
# below snapshots: a page whose content is exactly {"title":"<filename>","sections":[]} is
# the create_page stub, and snapshotHistory deliberately never versions that (see the
# "create-then-save leaves no destructive empty version" case).
r=$(post save_page '{"path":"OProj/OFold/OPage.json","data":{"title":"OPage","sections":[{"title":"S","collapsed":false,"tags":[],"blocks":[],"subsections":[]}]},"force":true}')
eqs "replay save_page (nested, force) → 200" "$(code "$r")" "200"
test -f "$DATA/OProj/OFold/OPage.json" && ok "replay wrote the nested page on disk" || bad "replay wrote the nested page" "missing"
r=$(post get_page '{"path":"OProj/OFold/OPage.json"}')
has "replay round-trips the nested page" "$(body "$r")" '"title":"OPage"'
# snapshotHistory now routes $rel through safePath internally — a legit nested re-save
# must still snapshot the prior version (best-effort guard doesn't break valid paths).
post save_page '{"path":"OProj/OFold/OPage.json","data":{"title":"OPage2","sections":[]},"force":true}' >/dev/null
test -d "$DATA/.history/OProj/OFold/OPage.json" && ok "snapshotHistory still snapshots a legit nested save" || bad "snapshotHistory still snapshots a legit nested save" "no history dir"

# --- get_history_version + restore_history (atomic, never a raw copy) -------------
# restore_history used to `copy()` a history version straight over the LIVE page: a
# crash mid-copy truncates it, which is exactly what writeJsonAtomic exists to prevent.
# It must snapshot first, then temp-file + rename, and leave the page parseable.
post create_page '{"name":"Rh","parent":""}' >/dev/null
post save_page '{"path":"Rh.json","data":{"title":"one","sections":[]}}' >/dev/null
sleep 1
post save_page '{"path":"Rh.json","data":{"title":"two","sections":[]}}' >/dev/null
rh_hist=$(curl -sG "$BASE" --data-urlencode "action=list_history" --data-urlencode "path=Rh.json")
rh_ts=$(printf '%s' "$rh_hist" | grep -o '"ts":[0-9]*' | head -1 | grep -o '[0-9]*')   # newest first
[ -n "$rh_ts" ] && ok "list_history returned a version ts for Rh.json" || bad "list_history returned a version ts" "none in [$rh_hist]"
r=$(post get_history_version "{\"path\":\"Rh.json\",\"ts\":$rh_ts}")
eqs "get_history_version → 200" "$(code "$r")" "200"
has "get_history_version returns the stored version body" "$(body "$r")" '"title": "one"'
r=$(post get_history_version '{"path":"Rh.json","ts":1}')
eqs "get_history_version unknown ts → 404" "$(code "$r")" "404"
r=$(post get_history_version '{"path":"../../etc/passwd","ts":1}')
has "get_history_version traversal path → invalid path" "$(body "$r")" '"error":"invalid path"'
rh_before=$(ls "$DATA/.history/Rh.json" 2>/dev/null | wc -l | tr -d ' ')
r=$(post restore_history "{\"path\":\"Rh.json\",\"ts\":$rh_ts}")
eqs "restore_history → 200" "$(code "$r")" "200"
has "restore_history → ok" "$(body "$r")" '"ok":true'
has "restore_history returns the new mtime" "$(body "$r")" '"mtime":'
has "restore_history put the old content back" "$(cat "$DATA/Rh.json")" '"title": "one"'
php -r '$c=@file_get_contents($argv[1]); exit(json_decode($c,true)===null?1:0);' "$DATA/Rh.json" \
  && ok "restored page is valid JSON (atomic write, not a truncated copy)" \
  || bad "restored page is valid JSON" "does not parse"
rh_after=$(ls "$DATA/.history/Rh.json" 2>/dev/null | wc -l | tr -d ' ')
[ "$rh_after" -gt "$rh_before" ] && ok "restore_history snapshotted the replaced version first ($rh_before → $rh_after)" || bad "restore_history snapshotted first" "history count $rh_before → $rh_after"
eqs "restore_history left no .tmp-* residue" "$(find "$DATA" -name '.tmp-*' 2>/dev/null | wc -l | tr -d ' ')" "0"
r=$(post restore_history '{"path":"Rh.json","ts":1}')
eqs "restore_history unknown ts → 404 (page untouched)" "$(code "$r")" "404"
has "restore_history 404 left the page as restored" "$(cat "$DATA/Rh.json")" '"title": "one"'
# a CORRUPT version must be refused, not written over a perfectly good page
printf '%s' '{"title": "trunc' > "$DATA/.history/Rh.json/$rh_ts.json"
r=$(post restore_history "{\"path\":\"Rh.json\",\"ts\":$rh_ts}")
has "restore_history refuses a version that is not valid JSON" "$(body "$r")" '"error"'
has "refused restore left the live page intact" "$(cat "$DATA/Rh.json")" '"title": "one"'

# --- HISTORY_KEEP: pruning keeps exactly 20, and keeps the NEWEST ------------------
# The prune sorts version filenames and drops the head. With 25 saves the surviving
# window must be the LAST 20 — a reversed/lexicographic mistake would silently keep
# the OLDEST 20 and quietly discard everything you'd actually want to recover.
post create_page '{"name":"Keep","parent":""}' >/dev/null
i=1; while [ "$i" -le 25 ]; do
  post save_page "{\"path\":\"Keep.json\",\"data\":{\"title\":\"v$i\",\"sections\":[]}}" >/dev/null
  i=$((i+1))
done
kn=$(ls "$DATA/.history/Keep.json" 2>/dev/null | wc -l | tr -d ' ')
eqs "25 saves prune to exactly HISTORY_KEEP (20) versions" "$kn" "20"
knew="$DATA/.history/Keep.json/$(ls "$DATA/.history/Keep.json" | sort -n | tail -1)"
kold="$DATA/.history/Keep.json/$(ls "$DATA/.history/Keep.json" | sort -n | head -1)"
# snapshots hold the content BEFORE each save: v1…v24 (the create_page stub is not
# versioned — see the create-then-save case below) → surviving window is v5…v24 (the
# 20 newest), so the extremes pin the direction of the prune.
has "the NEWEST surviving version is the most recent one (v24)" "$(cat "$knew")" '"title": "v24"'
has "the OLDEST surviving version is v5 (older ones were pruned)" "$(cat "$kold")" '"title": "v5"'
kl=$(curl -sG "$BASE" --data-urlencode "action=list_history" --data-urlencode "path=Keep.json")
eqs "list_history reports the same 20 versions" "$(printf '%s' "$kl" | grep -o '"ts":' | wc -l | tr -d ' ')" "20"

# --- create-then-save leaves NO destructive empty version in history --------------
# importPages restores a bundle as create_page (which writes {"title":…,"sections":[]})
# then save_page (the real content) — so every restored page's ONLY history version was
# that empty stub. The History panel presented it as a normal restorable version, and
# restoring it EMPTIED the page: a restored backup shipped with a loaded gun where its
# safety net should be. Same sequence in duplicatePageFromTree and in a queued
# create+save replaying on reconnect, so the guard lives in snapshotHistory, not in the
# importer: a page's FIRST snapshot is skipped when the prior content is exactly the
# create_page stub FOR THAT FILENAME.
hcount() { curl -sG "$BASE" --data-urlencode "action=list_history" --data-urlencode "path=$1" | grep -o '"ts":' | wc -l | tr -d ' '; }
post create_folder '{"name":"Restore","parent":""}' >/dev/null
post create_page '{"name":"Imported","parent":"Restore"}' >/dev/null
post save_page '{"path":"Restore/Imported.json","data":{"title":"Imported","sections":[{"title":"S","collapsed":false,"tags":["t"],"blocks":[{"type":"bash","label":"","code":"restored content"}],"subsections":[]}]}}' >/dev/null
has "the restored page holds the imported content" "$(cat "$DATA/Restore/Imported.json")" 'restored content'
eqs "create_page→save_page leaves ZERO history versions (no empty stub)" "$(hcount 'Restore/Imported.json')" "0"
# THE acceptance bar, stated directly: no version a user could restore would empty the page.
destructive=0
for v in "$DATA"/.history/Restore/Imported.json/*.json; do
  [ -e "$v" ] || continue
  php -r '$d=json_decode(@file_get_contents($argv[1]),true); exit((is_array($d) && empty($d["sections"]))?1:0);' "$v" || destructive=$((destructive+1))
done
eqs "no listed version of a restored page would destroy it if restored" "$destructive" "0"
# ...and normal history is UNAFFECTED — the next save versions the real prior content.
post save_page '{"path":"Restore/Imported.json","data":{"title":"Imported","sections":[{"title":"S2","collapsed":false,"tags":[],"blocks":[{"type":"bash","label":"","code":"second edit"}],"subsections":[]}]}}' >/dev/null
eqs "the next save DOES version (history still works after a restore)" "$(hcount 'Restore/Imported.json')" "1"
has "…and that version holds the real content, not an empty stub" "$(cat "$DATA"/.history/Restore/Imported.json/*.json)" 'restored content'

# CONSERVATIVE HALF: content a user could have authored is NEVER skipped.
# (a) a page a user deliberately EMPTIED is real data — its content versions normally,
#     and once the page has history even stub-shaped content is versioned, so the skip
#     can only ever apply to a page's very first snapshot.
post create_page '{"name":"Emptied","parent":""}' >/dev/null
post save_page '{"path":"Emptied.json","data":{"title":"Emptied","sections":[{"title":"S","collapsed":false,"tags":[],"blocks":[{"type":"bash","label":"","code":"authored work"}],"subsections":[]}]}}' >/dev/null
post save_page '{"path":"Emptied.json","data":{"title":"Emptied","sections":[]}}' >/dev/null
eqs "deliberately emptying a page versions the work it replaced" "$(hcount 'Emptied.json')" "1"
has "…and that version is the authored content" "$(cat "$DATA"/.history/Emptied.json/*.json)" 'authored work'
post save_page '{"path":"Emptied.json","data":{"title":"Emptied","sections":[{"title":"S","collapsed":false,"tags":[],"blocks":[{"type":"bash","label":"","code":"back again"}],"subsections":[]}]}}' >/dev/null
eqs "the emptied state itself is then versioned like any other content" "$(hcount 'Emptied.json')" "2"
# (b) a page whose only content IS its title (renamed, never given a section) keeps every
#     authored title — "sections is empty" alone must never qualify as the stub.
post create_page '{"name":"Titled","parent":""}' >/dev/null
post save_page '{"path":"Titled.json","data":{"title":"Renamed once","sections":[]}}' >/dev/null
post save_page '{"path":"Titled.json","data":{"title":"Renamed twice","sections":[]}}' >/dev/null
eqs "a title-only page's authored title IS versioned" "$(hcount 'Titled.json')" "1"
has "…holding the authored title, not the create_page stub" "$(cat "$DATA"/.history/Titled.json/*.json)" '"Renamed once"'
# (c) FAIL OPEN. isCreatePageStub decodes the PRIOR on-disk content, and anything it
#     cannot read as an array is NOT a stub — so it gets snapshotted. Un-decodable content
#     (an external editor, a truncated write, a hand-edited file) is the case with the MOST
#     to lose: calling it a stub would silently discard the only copy there is. Written
#     straight to disk, because no API call can produce it. The guard shipped untested.
printf '%s' 'this is not json at all' > "$DATA/Corrupt.json"
post save_page '{"path":"Corrupt.json","data":{"title":"Corrupt","sections":[]}}' >/dev/null
eqs "unreadable prior content is NEVER read as the stub (fail OPEN)" "$(hcount 'Corrupt.json')" "1"
has "…and the un-decodable bytes are what got snapshotted" "$(cat "$DATA"/.history/Corrupt.json/*.json)" 'not json at all'

# --- contentFileIterator: content scans NEVER descend into dot-dirs ----------------
# .history/.trash hold ~20 versions per page. A bare RecursiveDirectoryIterator would
# still pass every other assertion here while making search hit stale snapshots — and
# replace_content would REWRITE history, destroying the recovery net.
post create_page '{"name":"DotScan","parent":""}' >/dev/null
post save_page '{"path":"DotScan.json","data":{"title":"DotScan","sections":[{"title":"S","collapsed":false,"tags":["livetag"],"blocks":[{"type":"bash","label":"","code":"livemarker"}],"subsections":[]}]}}' >/dev/null
mkdir -p "$DATA/.history/DotScan.json"
printf '%s' '{"title":"old","sections":[{"title":"S","collapsed":false,"tags":["historyonlytag"],"blocks":[{"type":"bash","label":"","code":"historyonlymarker"}],"subsections":[]}]}' > "$DATA/.history/DotScan.json/1.json"
eqs "search_content finds nothing for a .history-only token" "$(sc 'historyonlymarker')" "[]"
has "search_content still matches the LIVE page content"     "$(sc 'livemarker')" "DotScan.json"
sbd=$(curl -sG "$BASE" --data-urlencode "action=search_blocks" --data-urlencode "q=historyonlymarker")
hasnt "search_blocks does not scan .history" "$sbd" "historyonlymarker"
# a trashed page's content is likewise out of scope for search
post create_page '{"name":"TrashScan","parent":""}' >/dev/null
post save_page '{"path":"TrashScan.json","data":{"title":"TrashScan","sections":[{"title":"S","collapsed":false,"tags":[],"blocks":[{"type":"bash","label":"","code":"trashonlymarker"}],"subsections":[]}]}}' >/dev/null
post delete '{"path":"TrashScan.json"}' >/dev/null
eqs "search_content finds nothing for a .trash-only token" "$(sc 'trashonlymarker')" "[]"
post rebuild_index '{}' >/dev/null   # force a full re-parse so list_tags can't hide behind a warm index
ltd=$(curl -sG "$BASE" --data-urlencode "action=list_tags")
hasnt "list_tags does not surface a .history-only tag" "$ltd" '"tag":"historyonlytag"'
has   "list_tags still surfaces the live tag"          "$ltd" '"tag":"livetag"'
# replace_content must leave the history snapshot byte-identical (it never walked in)
post replace_content '{"find":"historyonlymarker","replace":"CLOBBERED"}' >/dev/null
has "replace_content left the .history snapshot untouched" "$(cat "$DATA/.history/DotScan.json/1.json")" "historyonlymarker"

# --- rebuild_index ----------------------------------------------------------------
rm -f "$DATA/.index.json"
r=$(post rebuild_index '{}')
eqs "rebuild_index → 200" "$(code "$r")" "200"
has "rebuild_index → ok" "$(body "$r")" '"ok":true'
has "rebuild_index reports a page count" "$(body "$r")" '"pages":'
test -f "$DATA/.index.json" && ok "rebuild_index regenerated .index.json" || bad "rebuild_index regenerated .index.json" "missing"
ipages=$(body "$r" | grep -o '"pages":[0-9]*' | grep -o '[0-9]*')
[ "${ipages:-0}" -gt 0 ] && ok "rebuild_index indexed the library ($ipages pages)" || bad "rebuild_index indexed the library" "pages=$ipages"
hasnt "the index holds no .history entries" "$(cat "$DATA/.index.json")" ".history"
hasnt "the index holds no .trash entries"   "$(cat "$DATA/.index.json")" ".trash"

# --- reorder (manual child order in .order.json) ----------------------------------
post create_folder '{"name":"Ord","parent":""}' >/dev/null
for n in A B C; do post create_page "{\"name\":\"$n\",\"parent\":\"Ord\"}" >/dev/null; done
r=$(post reorder '{"parent":"Ord","order":["C.json","A.json","B.json"]}')
eqs "reorder → 200" "$(code "$r")" "200"
has "reorder → ok" "$(body "$r")" '"ok":true'
has "reorder persisted .order.json" "$(cat "$DATA/Ord/.order.json" 2>/dev/null)" '["C.json","A.json","B.json"]'
# and the tree actually comes back in that order
otree=$(curl -sG "$BASE" --data-urlencode "action=tree")
ordnames=$(printf '%s' "$otree" | tr '{' '\n' | grep -o '"name":"[ABC]"' | sed 's/.*:"//; s/"//' | tr -d '\n')
eqs "tree returns the folder's children in the stored order" "$ordnames" "CAB"
r=$(post reorder '{"parent":"../escape","order":["x"]}')
has "reorder traversal parent → invalid path" "$(body "$r")" '"error":"invalid path"'

# An EMPTY order array must be behaviourally identical to having no .order.json at all.
# There is no action that DELETES an order file, so the library-shape import sends [] to
# clear the reverse-creation artifact prependOrder leaves in a folder it created. If []
# meant anything else, that clear would itself be a corruption.
r=$(post reorder '{"parent":"Ord","order":[]}')
eqs "reorder with an empty order → 200" "$(code "$r")" "200"
eqs "…persists an empty .order.json" "$(cat "$DATA/Ord/.order.json" 2>/dev/null)" "[]"
otree=$(curl -sG "$BASE" --data-urlencode "action=tree")
ordnames=$(printf '%s' "$otree" | tr '{' '\n' | grep -o '"name":"[ABC]"' | sed 's/.*:"//; s/"//' | tr -d '\n')
eqs "…and the tree comes back in the DEFAULT order (== no order file)" "$ordnames" "ABC"
rm -f "$DATA/Ord/.order.json"
otree=$(curl -sG "$BASE" --data-urlencode "action=tree")
ordnames=$(printf '%s' "$otree" | tr '{' '\n' | grep -o '"name":"[ABC]"' | sed 's/.*:"//; s/"//' | tr -d '\n')
eqs "…exactly as with NO .order.json on disk" "$ordnames" "ABC"

# SERVER-BEHAVIOUR PIN: create_folder calls prependOrder UNCONDITIONALLY, so re-creating a
# folder that already exists jumps it to the top of its parent's order. That is why the
# client-side import SKIPS create_folder for folders it knows already exist — this pins the
# behaviour being worked around, so a future server change is caught here rather than
# silently making the client's skip redundant (or, worse, the wrong fix).
post create_folder '{"name":"OrdA","parent":"Ord"}' >/dev/null
post create_folder '{"name":"OrdB","parent":"Ord"}' >/dev/null
has "create_folder prepends a NEW folder to its parent's order" "$(cat "$DATA/Ord/.order.json")" '["OrdB","OrdA"]'
post create_folder '{"name":"OrdA","parent":"Ord"}' >/dev/null
has "create_folder on an EXISTING folder still prependOrders it (the client must skip it)" \
    "$(cat "$DATA/Ord/.order.json")" '["OrdA","OrdB"]'
rm -rf "$DATA/Ord/OrdA" "$DATA/Ord/OrdB"; rm -f "$DATA/Ord/.order.json"

# create_project under a PLAIN folder is refused (the client validates first and downgrades
# to create_folder, so this path should never be reached from the app — pinned regardless).
post create_folder '{"name":"PlainP","parent":""}' >/dev/null
r=$(post create_project '{"name":"Nope","parent":"PlainP"}')
has "create_project under a plain folder → refused" "$(body "$r")" '"error":"projects can only be created'
test ! -e "$DATA/PlainP/Nope" && ok "…and nothing was created" || bad "create_project under a plain folder created nothing" "PlainP/Nope exists"

# --- buildTree's DEFAULT child order: the cross-language comparator oracle ---------
# tree.js's defaultChildOrder must reproduce this EXACTLY — the library-shape export omits
# a folder's `order` whenever the two agree, so a divergence silently DROPS the user's
# manual order on the next restore. The two comparators are in different languages and
# cannot call each other, so both are pinned to this ONE literal, which also appears in
# codeman/tests.html; a CI invariant fails the build if the two copies ever diverge.
# The corpus is created DIRECTLY ON DISK (not via create_folder, whose prependOrder would
# install an order file and defeat the point), so this is buildTree's real fallback.
# Ｗide (U+FF37) and 😀emoji (U+1F600) are the load-bearing pair: byte order puts Ｗide
# FIRST (0xEF < 0xF0) while UTF-16 code-unit order puts the emoji first (0xD83D < 0xFF37),
# so they are the only two names in the corpus whose relative order tells cmpUtf8 apart
# from a plain JS string compare. Without a supplementary-plane name the whole corpus is
# BMP and the JS side could silently regress to string comparison — in the data-LOSING
# direction (a false "already default" verdict discards the user's manual order).
SORT_ORACLE_JSON='["10x","2x","_under","a b","a-b","a_b","Alpha","alpha2","beta","ZZ","Ångström","Ｗide","😀emoji","9lives.json","alpha.json","Beta.json","Zed.json","Émile.json"]'
mkdir -p "$DATA/Sortcase"
for d in "Alpha" "beta" "alpha2" "ZZ" "_under" "10x" "2x" "a b" "a-b" "a_b" "Ångström" "Ｗide" "😀emoji"; do mkdir -p "$DATA/Sortcase/$d"; done
for p in "Beta" "alpha" "Zed" "Émile" "9lives"; do
  printf '%s' '{"title":"x","sections":[]}' > "$DATA/Sortcase/$p.json"
done
got=$(curl -sG "$BASE" --data-urlencode "action=tree" | php -r '
$t = json_decode(stream_get_contents(STDIN), true);
$s = null; foreach ($t as $x) if ($x["type"] === "folder" && $x["name"] === "Sortcase") $s = $x;
if (!$s) { echo "NO Sortcase NODE"; exit; }
echo json_encode(array_map(function ($i) {
  return $i["type"] === "folder" ? $i["name"] : $i["name"] . ".json";
}, $s["children"]), JSON_UNESCAPED_UNICODE);
')
eqs "buildTree default order matches the shared comparator oracle" "$got" "$SORT_ORACLE_JSON"
rm -rf "$DATA/Sortcase"

# --- col_sorts / set_col_sort (per-column sort prefs, one root-level .colsort.json) --
r=$(post set_col_sort '{"parent":"","field":"name","dir":"desc"}')
eqs "set_col_sort root → 200" "$(code "$r")" "200"
cs=$(curl -sG "$BASE" --data-urlencode "action=col_sorts")
has "the ROOT column key is the empty string" "$cs" '"":{"field":"name","dir":"desc"}'
post set_col_sort '{"parent":"Ord","field":"kind","dir":"asc"}' >/dev/null
cs=$(curl -sG "$BASE" --data-urlencode "action=col_sorts")
has "a nested column keys off its folder rel path" "$cs" '"Ord":{"field":"kind","dir":"asc"}'
test -f "$DATA/.colsort.json" && ok "col sorts live in ONE root-level .colsort.json" || bad "col sorts live in one root-level .colsort.json" "missing"
test ! -e "$DATA/Ord/.colsort.json" && ok "no per-folder .colsort.json is written" || bad "no per-folder .colsort.json" "Ord/.colsort.json exists"
post set_col_sort '{"parent":"","field":"manual"}' >/dev/null
cs=$(curl -sG "$BASE" --data-urlencode "action=col_sorts")
hasnt "field=manual clears the root entry" "$cs" '"":{'
has   "clearing one column leaves the others" "$cs" '"Ord":{"field":"kind","dir":"asc"}'
post set_col_sort '{"parent":"Ord","field":"bogus","dir":"asc"}' >/dev/null
cs=$(curl -sG "$BASE" --data-urlencode "action=col_sorts")
eqs "an unknown sort field clears the entry (back to manual)" "$cs" "{}"
r=$(post set_col_sort '{"parent":"../escape","field":"name"}')
has "set_col_sort traversal parent → invalid path" "$(body "$r")" '"error":"invalid path"'

# --- CSRF enforcement: deny-by-default, header-less writes 403, reads 200 ----
# The post() helper always sends X-CodeMan-Request, so every write test above
# already exercises the header-carrying (accepted) path. Here we hit the raw
# header-less path with curl. Enforcement is ON (default server; CSRF unset).
r=$(curl -s -w $'\n%{http_code}' -X POST -H "Content-Type: application/json" -d '{"name":"NoHdr","parent":""}' "$BASE?action=create_page")
eqs "csrf: header-less write → 403" "$(code "$r")" "403"
has "csrf: 403 body is the clean error" "$(body "$r")" '"error":"missing request header"'
test ! -e "$DATA/NoHdr.json" && ok "csrf: rejected write touched nothing" || bad "csrf: rejected write touched nothing" "NoHdr.json exists"
# An unknown/future action also needs the header (deny-by-default, fail-closed).
r=$(curl -s -w $'\n%{http_code}' -X POST -H "Content-Type: application/json" -d '{}' "$BASE?action=some_future_write")
eqs "csrf: header-less unknown action → 403 (fail-closed, not 404)" "$(code "$r")" "403"
# Read-only allowlist actions pass without the header.
r=$(curl -s -w $'\n%{http_code}' "$BASE?action=tree");                         eqs "csrf: header-less read (tree) → 200"     "$(code "$r")" "200"
r=$(curl -s -w $'\n%{http_code}' "$BASE?action=get_page&path=P1.json");        eqs "csrf: header-less read (get_page) → 200" "$(code "$r")" "200"

# --- CSRF break-glass: CODEMAN_CSRF=off accepts header-less writes -----------
start_server "" "off"
r=$(curl -s -w $'\n%{http_code}' -X POST -H "Content-Type: application/json" -d '{"name":"OffHdr","parent":""}' "$BASE?action=create_page")
eqs "csrf off: header-less write accepted → 200" "$(code "$r")" "200"
test -f "$DATA/OffHdr.json" && ok "csrf off: header-less write persisted" || bad "csrf off: header-less write persisted" "missing"
start_server ""   # restore enforcement for any later run

# --- password gate ----------------------------------------------------------
start_server "testsecret"
r=$(curl -s -w $'\n%{http_code}' "$BASE?action=tree");                         eqs "gate: no token → 401" "$(code "$r")" "401"
has "gate: 401 body flags auth" "$(body "$r")" '"auth":true'
r=$(curl -s -w $'\n%{http_code}' -H "X-CodeMan-Auth: testsecret" "$BASE?action=tree"); eqs "gate: correct header → 200" "$(code "$r")" "200"
# ?token= is no longer accepted (secret-in-URL leaks into logs/Referer) — header only.
r=$(curl -s -w $'\n%{http_code}' "$BASE?action=tree&token=testsecret");          eqs "gate: correct ?token= no longer accepted → 401" "$(code "$r")" "401"
r=$(curl -s -w $'\n%{http_code}' -H "X-CodeMan-Auth: WRONG" "$BASE?action=tree"); eqs "gate: wrong token → 401" "$(code "$r")" "401"

echo ""
echo "API tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
