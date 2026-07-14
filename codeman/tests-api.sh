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
# reconstruction shapes round-tripping post-safePath, and the optional password
# gate (header-only; ?token= no longer accepted).
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
r=$(post save_page '{"path":"OProj/OFold/OPage.json","data":{"title":"OPage","sections":[]},"force":true}')
eqs "replay save_page (nested, force) → 200" "$(code "$r")" "200"
test -f "$DATA/OProj/OFold/OPage.json" && ok "replay wrote the nested page on disk" || bad "replay wrote the nested page" "missing"
r=$(post get_page '{"path":"OProj/OFold/OPage.json"}')
has "replay round-trips the nested page" "$(body "$r")" '"title":"OPage"'
# snapshotHistory now routes $rel through safePath internally — a legit nested re-save
# must still snapshot the prior version (best-effort guard doesn't break valid paths).
post save_page '{"path":"OProj/OFold/OPage.json","data":{"title":"OPage2","sections":[]},"force":true}' >/dev/null
test -d "$DATA/.history/OProj/OFold/OPage.json" && ok "snapshotHistory still snapshots a legit nested save" || bad "snapshotHistory still snapshots a legit nested save" "no history dir"

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
