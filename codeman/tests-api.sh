#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# CodeMan server-side API tests (api.php).
#
# Spins a throwaway `php -S` against a TEMP CODEMAN_DATA dir, asserts responses
# + on-disk effects, then tears everything down. No deps beyond php + curl.
# Pairs with codeman/tests.html (the client unit tests). Covers the server-side
# fixes that can't run in the browser: path-traversal confinement, parent-dir
# guards, unicode content search, same-second history retention, the empty_trash
# history-prune + its traversal guard, and the optional password gate.
#
#   Run:  bash codeman/tests-api.sh           (exit 0 = all green)
#         bash codeman/tests-api.sh 8099       (override the port)
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

start_server() { # $1 = optional CODEMAN_PASSWORD (empty = gate off)
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; SERVER_PID=""; fi
  CODEMAN_DATA="$DATA" CODEMAN_PASSWORD="${1:-}" php -S "127.0.0.1:$PORT" -t "$SCRIPT_DIR" >/dev/null 2>&1 &
  SERVER_PID=$!
  curl -s -o /dev/null --retry 40 --retry-connrefused --retry-delay 1 "http://127.0.0.1:$PORT/" || { echo "server failed to start"; exit 2; }
}

# POST helper: post <action> <json-body> [authtoken]  → echoes "<body>\n<httpcode>"
# (avoids empty-array expansion — macOS bash 3.2 errors on "${arr[@]}" under set -u)
post() {
  if [ -n "${3:-}" ]; then
    curl -s -w $'\n%{http_code}' -H "X-CodeMan-Auth: $3" -X POST -H "Content-Type: application/json" -d "$2" "$BASE?action=$1"
  else
    curl -s -w $'\n%{http_code}' -X POST -H "Content-Type: application/json" -d "$2" "$BASE?action=$1"
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

# --- password gate ----------------------------------------------------------
start_server "testsecret"
r=$(curl -s -w $'\n%{http_code}' "$BASE?action=tree");                         eqs "gate: no token → 401" "$(code "$r")" "401"
has "gate: 401 body flags auth" "$(body "$r")" '"auth":true'
r=$(curl -s -w $'\n%{http_code}' -H "X-CodeMan-Auth: testsecret" "$BASE?action=tree"); eqs "gate: correct header → 200" "$(code "$r")" "200"
r=$(curl -s -w $'\n%{http_code}' "$BASE?action=tree&token=testsecret");          eqs "gate: correct ?token → 200" "$(code "$r")" "200"
r=$(curl -s -w $'\n%{http_code}' -H "X-CodeMan-Auth: WRONG" "$BASE?action=tree"); eqs "gate: wrong token → 401" "$(code "$r")" "401"

echo ""
echo "API tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
