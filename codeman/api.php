<?php
header('Content-Type: application/json');

// Optional gzip of API responses. OFF by default — a NAS deploy might already gzip
// PHP output at the nginx layer, and double-compressing would corrupt the body. Turn
// it on with CODEMAN_GZIP=1 (env or fastcgi_param) ONLY after confirming nginx isn't
// compressing api.php (see the deploy gate in CLAUDE.md / docs/TEST_CASES.md).
// ob_gzhandler self-skips when the client sends no `Accept-Encoding: gzip`, and the
// desktop proxy's fetch() decompresses transparently then re-serves identity content,
// so enabling it never affects the desktop wrapper (CODEMAN_SMOKE asserts that).
$gzipOn = getenv('CODEMAN_GZIP');
if (!$gzipOn && isset($_SERVER['CODEMAN_GZIP'])) $gzipOn = $_SERVER['CODEMAN_GZIP'];
if ($gzipOn === '1' && !ini_get('zlib.output_compression') && function_exists('ob_gzhandler')) {
    @ob_start('ob_gzhandler');
}

// Storage location for persisted pages/folders.
// Set CODEMAN_DATA (e.g. /config/data/codeman on the NAS) to keep data
// OUTSIDE the cloned repo so git operations never touch it and the files
// are not web-served. Falls back to a local ./structures folder for dev.
// Resolve in order: real env (clear_env=no), nginx fastcgi_param / $_SERVER,
// then a local fallback for dev. PHP-FPM strips Docker env vars by default,
// so passing it via nginx fastcgi_param is the reliable path on the NAS.
$base = getenv('CODEMAN_DATA');
if (!$base && !empty($_SERVER['CODEMAN_DATA'])) {
    $base = $_SERVER['CODEMAN_DATA'];
}
if (!$base) {
    $base = __DIR__ . '/structures';
}
$base = rtrim($base, '/');
if (!is_dir($base)) mkdir($base, 0777, true);

$trashDir = $base . '/.trash';      // soft-deleted items (recoverable)
$historyDir = $base . '/.history';  // per-page prior versions
const HISTORY_KEEP = 20;            // max versions retained per page

// Metadata index: caches each page's tags/langs keyed by path, validated by
// file mtime. Self-heals on any change (incl. edits made outside the app) and
// only re-parses files whose mtime moved. Lives next to the data, hidden.
$indexFile = $base . '/.index.json';
$index = [];           // path => ['tags'=>[], 'langs'=>[], 'mtime'=>int]
$indexDirty = false;   // set when an entry is added/updated/pruned
$indexSeen = [];       // paths encountered this request (for pruning)
$indexLoaded = false;  // read from disk lazily — see loadIndex()

// Lazily read .index.json into $index. Only the index-using actions (tree,
// rebuild_index, list_tags) call this, so EVERY other request skips the
// (potentially large) index read entirely. Idempotent within a request.
function loadIndex() {
    global $index, $indexFile, $indexLoaded;
    if ($indexLoaded) return;
    $indexLoaded = true;
    if (file_exists($indexFile)) {
        $loaded = json_decode(@file_get_contents($indexFile), true);
        if (is_array($loaded)) $index = $loaded;
    }
}

// Emit an error response and stop. Keeps PHP warnings out of the JSON body.
function jsonError($msg, $code = 400) {
    http_response_code($code);
    echo json_encode(['error' => $msg]);
    exit;
}

// Validate that required fields are present and non-empty.
function requireFields($input, $fields) {
    if (!is_array($input)) jsonError('invalid request body');
    foreach ($fields as $f) {
        if (!isset($input[$f]) || $input[$f] === '') jsonError("missing field: $f");
    }
}

// A single safe path segment (folder name or page base name). Rejects anything
// that could escape the data root or create a hidden/system file.
function safeName($n) {
    if (!is_string($n)) return null;
    $n = trim($n);
    if ($n === '' || $n === '.' || $n === '..') return null;
    if (strpbrk($n, "/\\") !== false) return null; // no path separators
    if ($n[0] === '.') return null;                 // no hidden files
    return $n;
}

// Resolve a relative path under $base, or return NULL if any segment is unsafe.
// A segment that is '.', '..', or dot-prefixed (a hidden/system file) REJECTS the
// whole path (returns null) — mirroring safeName, so a traversal or a dotfile read
// can never resolve to a real location. Empty segments (from doubled slashes or a
// leading/trailing slash) are silently dropped. An empty $rel resolves to $base
// itself (root operations), never null. EVERY caller must treat null as "reject".
function safePath($base, $rel) {
    $rel = str_replace('\\', '/', $rel);
    $parts = [];
    foreach (explode('/', $rel) as $p) {
        if ($p === '') continue;                                   // doubled/edge slash → drop
        if ($p === '.' || $p === '..' || $p[0] === '.') return null; // traversal / dotfile → reject
        $parts[] = $p;
    }
    return $base . '/' . implode('/', $parts);
}

// Atomically write $json to $path: write to a per-write-unique, dot-prefixed temp
// file in the SAME directory, then rename() over the target. rename() is atomic on
// POSIX, so a crash between the write and the rename can never truncate or corrupt
// the real file — a concurrent reader sees either the whole old bytes or the whole
// new, never a half-written page. THE TEMP NAME MUST BE PER-WRITE UNIQUE (uniqid):
// a fixed "<path>.tmp" would let two concurrent save_pages clobber each other's temp
// before either renames, defeating the serialization LOCK_EX gives us. The dot
// prefix keeps an orphaned temp (e.g. a crash before the rename) invisible to
// buildTree. Returns the bytes written, or false on failure.
// (Caveat: Windows rename() can't replace an existing file — but api.php only ever
// runs on the Linux NAS / macOS dev, never Windows, so the POSIX guarantee holds.)
function writeJsonAtomic($path, $json) {
    $tmp = dirname($path) . '/.tmp-' . uniqid('', true);
    $bytes = @file_put_contents($tmp, $json, LOCK_EX);
    if ($bytes === false) { @unlink($tmp); return false; }
    @chmod($tmp, 0644);
    if (!@rename($tmp, $path)) { @unlink($tmp); return false; }
    return $bytes;
}

// Move a page/folder's .history subtree when it's renamed or moved, so its version
// history follows it (a page: .history/<rel>.json/ ; a folder: .history/<rel>/, whole
// subtree). Best-effort: History is a recovery net, never a hard dependency — a
// missing/locked .history (or a name collision at the destination) must NOT fail the
// rename/move. Both rels are run through safePath so a crafted path can't escape
// .history (same posture as empty_trash's origPath).
function migrateHistory($oldRel, $newRel) {
    global $historyDir;
    $from = safePath($historyDir, $oldRel);
    $to = safePath($historyDir, $newRel);
    if ($from === null || $to === null) return; // unsafe rel → skip (best-effort, never fail the move)
    if ($from === $to || $from === $historyDir . '/' || !file_exists($from)) return;
    $parent = dirname($to);
    if (!is_dir($parent)) @mkdir($parent, 0777, true);
    if (!file_exists($to)) { @rename($from, $to); return; } // fast path: nothing at the destination
    // The destination history already exists (a prior same-named item left it behind).
    // Don't strand the source AND don't let the moved page inherit only the stale dest
    // history: MERGE the source's non-colliding version files in (deduped by filename =
    // timestamp), then drop whatever's left of the source so it can't mislead.
    mergeHistoryDir($from, $to);
}
// Recursively merge history dir $from into $to: carry across any file/subtree not already
// present at the destination (a colliding timestamp filename = the same version, skipped),
// then remove the drained source. Best-effort — never fails the calling rename/move.
function mergeHistoryDir($from, $to) {
    if (!is_dir($to)) @mkdir($to, 0777, true);
    foreach (@scandir($from) ?: [] as $e) {
        if ($e === '.' || $e === '..') continue;
        $sf = $from . '/' . $e;
        $tf = $to . '/' . $e;
        if (is_dir($sf)) mergeHistoryDir($sf, $tf);
        else if (!file_exists($tf)) @rename($sf, $tf);
    }
    @rrmdir($from);
}

// Manual child ordering per folder, persisted in a hidden .order.json holding
// child entry names (folder names and "page.json" filenames) in display order.
function readOrder($dir) {
    $f = rtrim($dir, '/') . '/.order.json';
    if (file_exists($f)) { $o = json_decode(@file_get_contents($f), true); if (is_array($o)) return $o; }
    return [];
}
function writeOrder($dir, $order) {
    writeJsonAtomic(rtrim($dir, '/') . '/.order.json', json_encode(array_values($order)));
}
// Put a freshly created entry first in its folder's order.
function prependOrder($dir, $name) {
    $order = array_values(array_filter(readOrder($dir), function($n) use ($name) { return $n !== $name; }));
    array_unshift($order, $name);
    writeOrder($dir, $order);
}

// Per-column sort preferences for the double (Miller) layout, persisted in a single
// hidden .colsort.json at the data root: { "<folderRelPath>": {"field","dir"} } with
// ""=root. Absent key = manual/default order. Sorting itself runs client-side; this
// only stores the preference so it survives reloads and follows the user across devices.
function colSortFile($base) { return rtrim($base, '/') . '/.colsort.json'; }
function readColSorts($base) {
    $f = colSortFile($base);
    if (file_exists($f)) { $o = json_decode(@file_get_contents($f), true); if (is_array($o)) return $o; }
    return [];
}
function writeColSorts($base, $map) {
    writeJsonAtomic(colSortFile($base), json_encode((object)$map));
}

// Walk a section (any depth, legacy or tabbed) collecting tags and block langs.
function collectMeta($section, &$tags, &$langs) {
    if (!empty($section['tags']) && is_array($section['tags'])) {
        foreach ($section['tags'] as $t) $tags[$t] = true;
    }
    $containers = [];
    if (!empty($section['tabs']) && is_array($section['tabs'])) {
        $containers = $section['tabs'];
    } else {
        $containers = [$section]; // legacy: blocks/subsections directly on section
    }
    foreach ($containers as $c) {
        if (!empty($c['blocks']) && is_array($c['blocks'])) {
            foreach ($c['blocks'] as $b) {
                if (!empty($b['type'])) $langs[$b['type']] = true;
            }
        }
        if (!empty($c['subsections']) && is_array($c['subsections'])) {
            foreach ($c['subsections'] as $sub) collectMeta($sub, $tags, $langs);
        }
    }
}

// Rename (or, when $to === '', delete) a tag throughout a section tree, in
// place. Handles both the flat and legacy tabbed shapes. Returns true if any
// tag was changed so the caller knows whether to rewrite the file.
function renameTagInSection(&$section, $from, $to) {
    $changed = false;
    if (!empty($section['tags']) && is_array($section['tags'])) {
        $new = [];
        foreach ($section['tags'] as $t) {
            if ($t === $from) {
                $changed = true;
                if ($to !== '' && !in_array($to, $new, true)) $new[] = $to;
            } else if (!in_array($t, $new, true)) {
                $new[] = $t;
            }
        }
        if ($changed) $section['tags'] = array_values($new);
    }
    if (!empty($section['tabs']) && is_array($section['tabs'])) {
        foreach ($section['tabs'] as &$tab) {
            if (!empty($tab['subsections']) && is_array($tab['subsections'])) {
                foreach ($tab['subsections'] as &$sub) { if (renameTagInSection($sub, $from, $to)) $changed = true; }
                unset($sub);
            }
        }
        unset($tab);
    }
    if (!empty($section['subsections']) && is_array($section['subsections'])) {
        foreach ($section['subsections'] as &$sub) { if (renameTagInSection($sub, $from, $to)) $changed = true; }
        unset($sub);
    }
    return $changed;
}

// Build a [pattern, replacement] PCRE pair from a user find/replace. When
// $isRegex is false the find is matched literally (preg_quote) and the
// replacement is neutralised so `$1`/`\1` are inserted verbatim. Returns null
// for an invalid regex.
function cm_buildReplace($find, $replace, $isRegex, $ci) {
    $delim = '~';
    foreach (['~', '#', '%', '!', '@', "\x01"] as $d) { if (strpos($find, $d) === false) { $delim = $d; break; } }
    $flags = ($ci ? 'i' : '') . 'u';
    if ($isRegex) {
        $pat = $delim . $find . $delim . $flags;
        $repl = $replace;
    } else {
        $pat = $delim . preg_quote($find, $delim) . $delim . $flags;
        $repl = str_replace(['\\', '$'], ['\\\\', '\\$'], $replace);
    }
    if (@preg_match($pat, '') === false) return null; // invalid pattern
    return [$pat, $repl];
}

// Apply a callback to every block's code in a section (flat or legacy tabbed),
// recursing into subsections. The callback receives the code string and returns
// a replacement string (or null for "unchanged"). Returns true if any changed.
function cm_walkBlocks(&$node, $cb) {
    $changed = false;
    if (!empty($node['tabs']) && is_array($node['tabs'])) {
        foreach ($node['tabs'] as &$t) { if (cm_walkBlocks($t, $cb)) $changed = true; }
        unset($t);
        return $changed;
    }
    if (!empty($node['blocks']) && is_array($node['blocks'])) {
        foreach ($node['blocks'] as &$b) {
            if (!isset($b['code'])) continue;
            $r = $cb($b['code']);
            if ($r !== null && $r !== $b['code']) { $b['code'] = $r; $changed = true; }
        }
        unset($b);
    }
    if (!empty($node['subsections']) && is_array($node['subsections'])) {
        foreach ($node['subsections'] as &$s) { if (cm_walkBlocks($s, $cb)) $changed = true; }
        unset($s);
    }
    return $changed;
}

// Walk a section list (flat or legacy tabbed) collecting blocks whose code,
// label or type contains the lowercased query $q, appending to $out with a
// breadcrumb trail. Used by search_blocks.
function collectBlocksMatching($sections, $trail, $q, $rel, $page, &$out) {
    foreach ($sections as $sec) {
        if (!is_array($sec)) continue;
        $t = array_merge($trail, [$sec['title'] ?? 'Untitled']);
        $content = (!empty($sec['tabs']) && is_array($sec['tabs'])) ? ($sec['tabs'][0] ?? []) : $sec;
        if (!empty($content['blocks']) && is_array($content['blocks'])) {
            foreach ($content['blocks'] as $b) {
                $hay = strtolower(($b['code'] ?? '') . ' ' . ($b['label'] ?? '') . ' ' . ($b['type'] ?? ''));
                if (strpos($hay, $q) !== false) {
                    $out[] = [
                        'path' => $rel, 'page' => $page,
                        'label' => $b['label'] ?? '', 'type' => $b['type'] ?? 'plaintext',
                        'code' => $b['code'] ?? '', 'note' => !empty($b['note']),
                        'trail' => implode(' › ', $t)
                    ];
                }
            }
        }
        if (!empty($content['subsections']) && is_array($content['subsections'])) {
            collectBlocksMatching($content['subsections'], $t, $q, $rel, $page, $out);
        }
    }
}

// Reads a page file and returns ['tags' => [...], 'langs' => [...]].
function pageMeta($file) {
    $tags = [];
    $langs = [];
    $data = json_decode(@file_get_contents($file), true);
    if (is_array($data) && !empty($data['sections'])) {
        foreach ($data['sections'] as $section) collectMeta($section, $tags, $langs);
    }
    return ['tags' => array_keys($tags), 'langs' => array_keys($langs)];
}

// Index-backed metadata: returns cached tags/langs if the file's mtime is
// unchanged, otherwise re-parses and updates the index.
function pageMetaIndexed($file, $rel) {
    global $index, $indexDirty, $indexSeen;
    $indexSeen[$rel] = true;
    $mtime = @filemtime($file);
    if (isset($index[$rel]) && ($index[$rel]['mtime'] ?? null) === $mtime) {
        return ['tags' => $index[$rel]['tags'], 'langs' => $index[$rel]['langs']];
    }
    $meta = pageMeta($file);
    $index[$rel] = ['tags' => $meta['tags'], 'langs' => $meta['langs'], 'mtime' => $mtime];
    $indexDirty = true;
    return $meta;
}

function buildTree($dir, $base) {
    $items = [];
    $entries = scandir($dir);
    foreach ($entries as $entry) {
        if ($entry === '.' || $entry === '..') continue;
        if ($entry[0] === '.') continue; // skip hidden files incl. .index.json/.trash/.history
        $full = $dir . '/' . $entry;
        $rel = ltrim(substr($full, strlen($base)), '/');
        if (is_dir($full)) {
            $node = [
                'type' => 'folder',
                'name' => $entry,
                'path' => $rel,
                'children' => buildTree($full, $base)
            ];
            // A folder marked with a hidden .project file is a "project".
            if (file_exists($full . '/.project')) $node['project'] = true;
            $items[] = $node;
        } else if (substr($entry, -5) === '.json') {
            $name = substr($entry, 0, -5);
            $meta = pageMetaIndexed($full, $rel);
            $items[] = [
                'type' => 'page',
                'name' => $name,
                'path' => $rel,
                'tags' => $meta['tags'],
                'langs' => $meta['langs']
            ];
        }
    }
    // Order: folders before pages; within each, manual .order.json order if set,
    // otherwise alphabetical. Unlisted entries fall after listed ones.
    $orderIndex = array_flip(readOrder($dir));
    usort($items, function($a, $b) use ($orderIndex) {
        if ($a['type'] !== $b['type']) return $a['type'] === 'folder' ? -1 : 1;
        $an = $a['type'] === 'folder' ? $a['name'] : $a['name'] . '.json';
        $bn = $b['type'] === 'folder' ? $b['name'] : $b['name'] . '.json';
        $ai = array_key_exists($an, $orderIndex) ? $orderIndex[$an] : PHP_INT_MAX;
        $bi = array_key_exists($bn, $orderIndex) ? $orderIndex[$bn] : PHP_INT_MAX;
        if ($ai !== $bi) return $ai <=> $bi;
        return strcasecmp($a['name'], $b['name']);
    });
    return $items;
}

// Persist the index if it changed, pruning entries for deleted pages.
function flushIndex() {
    global $index, $indexDirty, $indexSeen, $indexFile;
    foreach (array_keys($index) as $k) {
        if (!isset($indexSeen[$k])) { unset($index[$k]); $indexDirty = true; }
    }
    if ($indexDirty) {
        writeJsonAtomic($indexFile, json_encode($index));
    }
}

// A recursive file iterator over the data root that NEVER descends into hidden
// dot-directories (.history/.trash/.index.json/…). The content-scanning actions
// (list_tags, search_content, search_blocks, replace_content, rename_tag) use this so
// they don't stat tens of thousands of history/trash files on a mature library (history
// keeps up to 20 versions per page). The delete path (rrmdir) deliberately does NOT use
// it — it MUST walk dot-dirs. Each caller keeps its in-loop "/."-in-path skip as
// belt-and-suspenders; buildTree is already immune (scandir + dot-skip).
function contentFileIterator($base) {
    $dir = new RecursiveDirectoryIterator($base, RecursiveDirectoryIterator::SKIP_DOTS);
    // Returning false for a dot-dir prevents descent into it entirely (not just skipping
    // the entry) — so .history/.trash subtrees are never walked.
    $filter = new RecursiveCallbackFilterIterator($dir, function ($current) {
        return substr($current->getFilename(), 0, 1) !== '.';
    });
    return new RecursiveIteratorIterator($filter);
}

// Recursively remove a directory and its contents.
function rrmdir($path) {
    if (is_dir($path)) {
        $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($path, RecursiveDirectoryIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($it as $file) {
            $file->isDir() ? rmdir($file->getPathname()) : unlink($file->getPathname());
        }
        rmdir($path);
    } else if (file_exists($path)) {
        unlink($path);
    }
}

// Snapshot a page's current content into .history before it's overwritten,
// pruning to the most recent HISTORY_KEEP versions.
function snapshotHistory($base, $rel, $path) {
    global $historyDir;
    if (!file_exists($path)) return;
    $old = @file_get_contents($path);
    if ($old === false) return;
    // Confine $rel INSIDE the helper (not just at the callers): today every caller passes
    // an already-validated path, but this used to be a raw concat — the same latent-trap
    // class as the list_history hole. safePath returns null for a traversal/dotfile rel →
    // best-effort no-op so a future unguarded caller can't reintroduce a .history escape.
    $hdir = safePath($historyDir, $rel);
    if ($hdir === null) return;
    if (!is_dir($hdir)) mkdir($hdir, 0777, true);
    $stamp = @filemtime($path) ?: time();
    $vfile = $hdir . '/' . $stamp . '.json';
    // mtime is second-granularity, so two saves in the same second collide on the
    // version filename. Bump to the next free integer key (filenames must stay
    // pure-integer for restore-by-ts) so a concurrent same-second version is still
    // retained and recoverable instead of being silently dropped.
    while (file_exists($vfile)) { $stamp++; $vfile = $hdir . '/' . $stamp . '.json'; }
    writeJsonAtomic($vfile, $old);
    $vers = glob($hdir . '/*.json') ?: [];
    if (count($vers) > HISTORY_KEEP) {
        sort($vers); // oldest mtimes first (numeric filenames)
        foreach (array_slice($vers, 0, count($vers) - HISTORY_KEEP) as $v) @unlink($v);
    }
}

$action = $_GET['action'] ?? '';
$input = json_decode(file_get_contents('php://input'), true);

// Optional shared-secret gate. OFF by default: with no CODEMAN_PASSWORD set the
// API stays open (the trusted-LAN/NAS assumption). Set CODEMAN_PASSWORD (env or
// nginx fastcgi_param, same delivery as CODEMAN_DATA) to require it on every
// request — the client sends it in the X-CodeMan-Auth header. Since page data lives
// outside the webroot and is only reachable through this script, gating here protects
// the data. hash_equals avoids timing leaks. (The old ?token= query fallback was
// removed: a secret in the URL leaks into logs/history/Referer — header only now.)
$authPass = getenv('CODEMAN_PASSWORD');
if (!$authPass && !empty($_SERVER['CODEMAN_PASSWORD'])) $authPass = $_SERVER['CODEMAN_PASSWORD'];
if ($authPass) {
    $provided = $_SERVER['HTTP_X_CODEMAN_AUTH'] ?? '';
    if (!is_string($provided) || !hash_equals((string)$authPass, $provided)) {
        http_response_code(401);
        echo json_encode(['error' => 'authentication required', 'auth' => true]);
        exit;
    }
}

// CSRF enforcement (deny-by-default). Every mutating action requires the
// X-CodeMan-Request header — attached at the client's single choke point
// apiHeaders() (core.js) on normal calls, offline flushQueue replay, and the
// keepalive unload-save. The client has been SENDING it since R3, so flipping
// enforcement on here rejects only header-less cross-site/forged writes.
// READ-ONLY allowlist mirrors the desktop proxy's READ_ONLY_ACTIONS
// (codeman-desktop/main.js) EXACTLY — keep the two in sync. Anything NOT on
// this list (including any future action) needs the header: fail-CLOSED, so a
// newly added write is protected by default rather than slipping through.
// Break-glass: set CODEMAN_CSRF=off (env or nginx fastcgi_param, same delivery
// as CODEMAN_DATA) to accept header-less writes during a migration / straggler
// window. A rejection is a clean 4xx so a stale offline client DEAD-LETTERS the
// write (visible/recoverable) rather than treating it as "offline" and retrying.
$csrfReadOnly = [
    'tree', 'col_sorts', 'get_page', 'list_tags', 'list_trash', 'list_history',
    'get_history_version', 'search_content', 'search_blocks',
];
$csrfOff = getenv('CODEMAN_CSRF');
if ($csrfOff === false && isset($_SERVER['CODEMAN_CSRF'])) $csrfOff = $_SERVER['CODEMAN_CSRF'];
if ($csrfOff !== 'off'
    && !in_array($action, $csrfReadOnly, true)
    && empty($_SERVER['HTTP_X_CODEMAN_REQUEST'])) {
    jsonError('missing request header', 403);
}

switch ($action) {
    case 'tree':
        loadIndex();
        $tree = buildTree($base, $base);
        flushIndex();
        echo json_encode($tree);
        break;

    case 'rebuild_index':
        // Force a full re-parse: drop the index, then rebuild from disk.
        loadIndex();
        $index = [];
        $indexDirty = true;
        $indexSeen = [];
        buildTree($base, $base);
        flushIndex();
        echo json_encode(['ok' => true, 'pages' => count($index)]);
        break;

    case 'search_content':
        // Returns rel paths of pages whose stored content contains the query.
        $q = strtolower(trim($_GET['q'] ?? ''));
        $matches = [];
        if ($q !== '') {
            $it = contentFileIterator($base);
            foreach ($it as $file) {
                if (substr($file->getFilename(), 0, 1) === '.') continue;
                // skip anything inside hidden dirs (.trash/.history)
                if (strpos(str_replace('\\', '/', $file->getPathname()), '/.') !== false) continue;
                if (substr($file->getFilename(), -5) !== '.json') continue;
                $content = @file_get_contents($file->getPathname());
                if ($content === false) continue;
                // HTML-project blocks store binary assets as one-line base64 under the
                // reserved "b64" key. Random base64 runs produce false search hits (and
                // needless scan cost), so blank those spans out. Guarded by a presence
                // strpos so the 99.9% of pages with no html block pay one substring check
                // and nothing else. The base64 alphabet contains no quote or backslash, so
                // the char class can never run past its string. save_page writes with
                // JSON_PRETTY_PRINT, hence the \s* around the colon.
                if (strpos($content, '"b64"') !== false) {
                    $content = preg_replace('/"b64"\s*:\s*"[A-Za-z0-9+\/=]*"/', '"b64":""', $content);
                }
                // Fast path: scan the raw JSON directly (save_page stores
                // JSON_UNESCAPED_UNICODE, so most content — incl. UTF-8 — matches as-is).
                $matched = stripos($content, $q) !== false;
                // Only when the raw haystack MISSES and the query could differ from what's on
                // disk do we pay for a decode + re-encode-unescaped: non-ASCII (a page written
                // with \uXXXX escapes) OR a query containing '/' or '\' (JSON_PRETTY_PRINT
                // escapes '/' → '\/', so a page last written by replace_content / rename_tag /
                // an external editor stores the slash escaped and the raw query would miss).
                // Keeps the fast path for the common ASCII-no-slash query. Preserves the pinned
                // Unicode search cases (search_blocks decodes too — consistent on Unicode).
                if (!$matched && (preg_match('/[^\x00-\x7F]/', $q) || strpbrk($q, '/\\') !== false)) {
                    $decoded = json_decode($content, true);
                    if ($decoded !== null) {
                        $hay = json_encode($decoded, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
                        // the same b64 strip, or a non-ASCII / slash-bearing query would
                        // reintroduce the false positives through this branch
                        if (strpos($hay, '"b64"') !== false) {
                            $hay = preg_replace('/"b64"\s*:\s*"[A-Za-z0-9+\/=]*"/', '"b64":""', $hay);
                        }
                        $matched = stripos($hay, $q) !== false;
                    }
                }
                if ($matched) {
                    $rel = ltrim(substr($file->getPathname(), strlen($base)), '/');
                    $matches[] = $rel;
                }
            }
        }
        echo json_encode($matches);
        break;

    case 'search_blocks':
        // Returns individual blocks whose code/label/type matches the query,
        // across all pages — powers the quick-paste palette. Capped at 100.
        $q = strtolower(trim($_GET['q'] ?? ''));
        $out = [];
        if ($q !== '') {
            $it = contentFileIterator($base);
            foreach ($it as $file) {
                if (count($out) >= 100) break;
                if (substr($file->getFilename(), -5) !== '.json') continue;
                if (strpos(str_replace('\\', '/', $file->getPathname()), '/.') !== false) continue;
                $data = json_decode(@file_get_contents($file->getPathname()), true);
                if (!is_array($data) || empty($data['sections'])) continue;
                $rel = ltrim(substr($file->getPathname(), strlen($base)), '/');
                $page = preg_replace('/\.json$/', '', basename($rel));
                collectBlocksMatching($data['sections'], [], $q, $rel, $page, $out);
            }
        }
        echo json_encode(array_slice($out, 0, 100));
        break;

    case 'replace_content':
        // Find/replace across every page's block code. Literal or regex, optional
        // case-insensitive. With preview:true it only COUNTS (dry run, no writes);
        // otherwise it rewrites each changed page, history-snapshotting it first.
        requireFields($input, ['find']);
        $find = (string)$input['find'];
        if ($find === '') jsonError('find is empty');
        $replace = isset($input['replace']) ? (string)$input['replace'] : '';
        $isRegex = !empty($input['regex']);
        $ci = !empty($input['ci']);
        $preview = !empty($input['preview']);
        $built = cm_buildReplace($find, $replace, $isRegex, $ci);
        if ($built === null) jsonError('invalid regular expression');
        list($pat, $repl) = $built;
        // Bound PCRE so a pathological (catastrophic-backtracking) user regex fails fast
        // instead of hanging the request. When a match/replace hits the limit PCRE returns
        // false/null (PREG_BACKTRACK_LIMIT_ERROR) — we surface that as a clean error below
        // rather than silently skipping the block (which would drop real matches).
        ini_set('pcre.backtrack_limit', '2000000');
        ini_set('pcre.recursion_limit', '100000');
        $regexError = false;
        $totalMatches = 0; $changedPages = 0; $pageList = [];
        $it = contentFileIterator($base);
        foreach ($it as $file) {
            if (substr($file->getFilename(), -5) !== '.json') continue;
            if (strpos(str_replace('\\', '/', $file->getPathname()), '/.') !== false) continue;
            $data = json_decode(@file_get_contents($file->getPathname()), true);
            if (!is_array($data) || empty($data['sections'])) continue;
            $pageMatches = 0;
            $cb = function($code) use ($pat, $repl, $preview, &$pageMatches, &$regexError) {
                if ($preview) {
                    $n = preg_match_all($pat, $code, $m);
                    if ($n === false) { $regexError = true; return null; }
                    $pageMatches += $n; return null;
                }
                $new = preg_replace($pat, $repl, $code, -1, $c);
                if ($new === null) { $regexError = true; return null; }
                $pageMatches += $c; return $new;
            };
            $changed = false;
            foreach ($data['sections'] as &$s) { if (cm_walkBlocks($s, $cb)) $changed = true; }
            unset($s);
            if ($regexError) jsonError('regex too complex'); // PCRE limit hit → fail cleanly
            if ($pageMatches > 0) {
                $totalMatches += $pageMatches;
                $rel = ltrim(substr($file->getPathname(), strlen($base)), '/');
                $pageList[] = ['path' => $rel, 'matches' => $pageMatches];
                if (!$preview && $changed) {
                    snapshotHistory($base, $rel, $file->getPathname());
                    // Match save_page's on-disk encoding (unescaped unicode + slashes) so a
                    // rewritten page stores '/' and UTF-8 literally — keeps the search_content
                    // raw fast path matching without a decode (see the search_content fallback).
                    writeJsonAtomic($file->getPathname(), json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
                    clearstatcache(true, $file->getPathname());
                    $changedPages++;
                }
            }
        }
        usort($pageList, function($a, $b) { return $b['matches'] <=> $a['matches']; });
        echo json_encode(['ok' => true, 'preview' => $preview, 'totalMatches' => $totalMatches, 'pages' => $pageList, 'changedPages' => $changedPages]);
        break;

    case 'list_tags':
        // Aggregate every tag across all pages → [{tag, count}] (count = pages
        // using it), sorted by frequency then name. Index-backed (pageMetaIndexed +
        // flushIndex, mirroring `tree`) so a warm call reuses cached tags and only
        // re-parses pages whose mtime moved.
        loadIndex();
        $counts = [];
        $it = contentFileIterator($base);
        foreach ($it as $file) {
            $full = $file->getPathname();
            if (substr($file->getFilename(), -5) !== '.json') continue;
            if (strpos(str_replace('\\', '/', $full), '/.') !== false) continue;
            $rel = ltrim(substr($full, strlen($base)), '/');
            $meta = pageMetaIndexed($full, $rel);
            foreach ($meta['tags'] as $t) { $counts[$t] = ($counts[$t] ?? 0) + 1; }
        }
        flushIndex();
        $out = [];
        foreach ($counts as $t => $c) $out[] = ['tag' => $t, 'count' => $c];
        usort($out, function($a, $b) { return $b['count'] <=> $a['count'] ?: strcasecmp($a['tag'], $b['tag']); });
        echo json_encode($out);
        break;

    case 'rename_tag':
        // Rename (or delete, when `to` is empty) a tag across every page. Each
        // changed page is history-snapshotted before being rewritten.
        requireFields($input, ['from']);
        $from = (string)$input['from'];
        $to = isset($input['to']) ? trim((string)$input['to']) : '';
        $changedPages = 0;
        $it = contentFileIterator($base);
        foreach ($it as $file) {
            $full = $file->getPathname();
            if (substr($file->getFilename(), -5) !== '.json') continue;
            if (strpos(str_replace('\\', '/', $full), '/.') !== false) continue;
            $data = json_decode(@file_get_contents($full), true);
            if (!is_array($data) || empty($data['sections'])) continue;
            $changed = false;
            foreach ($data['sections'] as &$section) { if (renameTagInSection($section, $from, $to)) $changed = true; }
            unset($section);
            if ($changed) {
                $rel = ltrim(substr($full, strlen($base)), '/');
                snapshotHistory($base, $rel, $full);
                // Match save_page's on-disk encoding (unescaped unicode + slashes) — see the
                // matching note in replace_content: keeps '/' and UTF-8 literal on disk so the
                // search_content raw fast path matches a rewritten page without a decode.
                writeJsonAtomic($full, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
                clearstatcache(true, $full);
                $changedPages++;
            }
        }
        echo json_encode(['ok' => true, 'pages' => $changedPages]);
        break;

    case 'create_folder':
        requireFields($input, ['name']);
        $name = safeName($input['name']);
        if ($name === null) jsonError('invalid name');
        $parent = $input['parent'] ?? '';
        $path = safePath($base, $parent . '/' . $name);
        $parentDir = safePath($base, $parent);
        if ($path === null || $parentDir === null) jsonError('invalid path');
        if (!is_dir($path)) mkdir($path, 0777, true);
        prependOrder($parentDir, $name); // new folder at top
        echo json_encode(['ok' => true]);
        break;

    case 'create_project':
        // A project is a folder with a hidden .project marker. Projects may live
        // anywhere, but only inside another project or at the root — never inside
        // a plain folder.
        requireFields($input, ['name']);
        $name = safeName($input['name']);
        if ($name === null) jsonError('invalid name');
        $parent = $input['parent'] ?? '';
        $parentDir = safePath($base, $parent);
        $path = safePath($base, $parent . '/' . $name);
        if ($parentDir === null || $path === null) jsonError('invalid path');
        if ($parent !== '' && !file_exists($parentDir . '/.project')) {
            jsonError('projects can only be created at the top level or inside another project');
        }
        if (!is_dir($path)) mkdir($path, 0777, true);
        @file_put_contents($path . '/.project', '');
        prependOrder($parentDir, $name); // new project at top of its parent
        echo json_encode(['ok' => true]);
        break;

    case 'reorder':
        // Persist a folder's child display order. input: { parent, order: [names] }
        $dir = safePath($base, $input['parent'] ?? '');
        if ($dir === null) jsonError('invalid path');
        if (is_dir(rtrim($dir, '/')) && isset($input['order']) && is_array($input['order'])) {
            writeOrder($dir, $input['order']);
        }
        echo json_encode(['ok' => true]);
        break;

    case 'col_sorts':
        // Return the per-column sort-preference map for the double (Miller) layout.
        echo json_encode((object)readColSorts($base));
        break;

    case 'set_col_sort':
        // Persist (or clear) a column's sort preference. input: { parent, field, dir }.
        // field=manual (or unknown) clears the entry → back to manual/default order.
        $dir = safePath($base, $input['parent'] ?? '');
        if ($dir === null) jsonError('invalid path');
        if (is_dir(rtrim($dir, '/'))) {
            $key = ltrim(substr(rtrim($dir, '/'), strlen($base)), '/');
            $map = readColSorts($base);
            $field = $input['field'] ?? 'manual';
            $sortDir = ($input['dir'] ?? 'asc') === 'desc' ? 'desc' : 'asc';
            if (in_array($field, ['name', 'lang', 'kind'], true)) {
                $map[$key] = ['field' => $field, 'dir' => $sortDir];
            } else {
                unset($map[$key]);
            }
            writeColSorts($base, $map);
        }
        echo json_encode(['ok' => true]);
        break;

    case 'create_page':
        requireFields($input, ['name']);
        $name = safeName($input['name']);
        if ($name === null) jsonError('invalid name');
        $path = safePath($base, ($input['parent'] ?? '') . '/' . $name . '.json');
        if ($path === null) jsonError('invalid path');
        // Parent must exist — otherwise file_put_contents emits a raw PHP warning into
        // the response body (invalid JSON → the client false-trips offline) yet still
        // reports ok. Same guard as save_page.
        if (!is_dir(dirname($path))) jsonError('parent folder does not exist', 404);
        if (!file_exists($path)) {
            if (writeJsonAtomic($path, json_encode(['title' => $name, 'sections' => []], JSON_PRETTY_PRINT)) === false) jsonError('failed to create page', 500);
        }
        echo json_encode(['ok' => true]);
        break;

    case 'get_page':
        $rel = $input['path'] ?? ($_GET['path'] ?? '');
        $path = safePath($base, $rel);
        if ($path === null) jsonError('invalid path'); // e.g. a dotfile read like .index.json
        if (file_exists($path)) {
            $data = json_decode(file_get_contents($path), true);
            if (!is_array($data)) $data = ['title' => '', 'sections' => []];
            $data['_mtime'] = @filemtime($path);
            echo json_encode($data);
        } else {
            echo json_encode(['title' => '', 'sections' => [], '_mtime' => null]);
        }
        break;

    case 'save_page':
        requireFields($input, ['path']);
        $path = safePath($base, $input['path']);
        if ($path === null) jsonError('invalid path');
        // Optimistic concurrency: if the caller passed the mtime it read and the
        // file has changed since (another tab/device/edit), refuse unless forced.
        if (file_exists($path) && array_key_exists('baseMtime', $input) && $input['baseMtime'] !== null && empty($input['force'])) {
            $cur = @filemtime($path);
            if ((int)$input['baseMtime'] !== (int)$cur) {
                echo json_encode(['conflict' => true, 'mtime' => $cur]);
                break;
            }
        }
        // Strip transient field before persisting.
        $data = $input['data'];
        if (is_array($data)) unset($data['_mtime']);
        // The parent folder must already exist (created via create_folder/create_page).
        // Bail with clean JSON rather than letting file_put_contents emit a raw PHP
        // warning into the response body and still report ok:true.
        $dir = dirname($path);
        if (!is_dir($dir)) jsonError('parent folder does not exist', 404);
        snapshotHistory($base, $input['path'], $path); // version the prior content
        $bytes = writeJsonAtomic($path, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
        if ($bytes === false) jsonError('failed to write page', 500);
        clearstatcache(true, $path);
        echo json_encode(['ok' => true, 'mtime' => @filemtime($path)]);
        break;

    case 'rename':
        requireFields($input, ['path', 'newName']);
        $newName = safeName($input['newName']);
        if ($newName === null) jsonError('invalid name');
        $oldPath = safePath($base, $input['path']);
        if ($oldPath === null) jsonError('invalid path');
        if (!file_exists($oldPath)) jsonError('source not found', 404);
        $isFolder = is_dir($oldPath);
        $dir = dirname($oldPath);
        $newPath = $isFolder ? $dir . '/' . $newName : $dir . '/' . $newName . '.json';
        if (file_exists($newPath)) jsonError('name already exists');
        rename($oldPath, $newPath);
        // Carry the version history over to the new name (best-effort).
        $parentRel = (strpos($input['path'], '/') !== false) ? substr($input['path'], 0, strrpos($input['path'], '/')) : '';
        $newRel = ($parentRel !== '' ? $parentRel . '/' : '') . ($isFolder ? $newName : $newName . '.json');
        migrateHistory($input['path'], $newRel);
        echo json_encode(['ok' => true]);
        break;

    case 'move':
        // Move a page or folder into a target folder ('' = root).
        requireFields($input, ['path']);
        $src = safePath($base, $input['path']);
        $destDir = safePath($base, $input['target'] ?? '');
        if ($src === null || $destDir === null) jsonError('invalid path');
        if (!file_exists($src)) { jsonError('source not found', 404); }
        if (!is_dir($destDir)) { jsonError('target not found', 404); }
        $name = basename($src);
        $dest = $destDir . '/' . $name;
        // No-op if already there; block moving a folder into itself/its descendant.
        $realSrc = realpath($src);
        $realDestDir = realpath($destDir);
        if (is_dir($src) && strpos($realDestDir, $realSrc) === 0) {
            jsonError('cannot move a folder into itself');
        }
        // Projects may only sit at the root or nest inside another project —
        // never inside a plain folder.
        if (is_dir($src) && file_exists($src . '/.project')
            && $realDestDir !== realpath($base) && !file_exists($realDestDir . '/.project')) {
            jsonError('projects can only be moved into another project or the top level');
        }
        if (dirname($src) === $destDir) { echo json_encode(['ok' => true]); break; }
        if (file_exists($dest)) { jsonError('name already exists in target'); }
        rename($src, $dest);
        // Carry the version history over to the new location (best-effort).
        migrateHistory($input['path'], (($input['target'] ?? '') !== '' ? $input['target'] . '/' : '') . $name);
        echo json_encode(['ok' => true]);
        break;

    case 'delete':
        // Soft delete: move into .trash with a sidecar .meta so it can be restored.
        requireFields($input, ['path']);
        $path = safePath($base, $input['path']);
        if ($path === null) jsonError('invalid path'); // e.g. delete {path:".history"}
        if (!file_exists($path)) { echo json_encode(['ok' => true]); break; }
        if (!is_dir($trashDir)) mkdir($trashDir, 0777, true);
        $stamp = time();
        $name = basename($path);
        $entry = $stamp . '__' . $name;
        $dest = $trashDir . '/' . $entry;
        $i = 0;
        while (file_exists($dest)) { $entry = $stamp . '_' . (++$i) . '__' . $name; $dest = $trashDir . '/' . $entry; }
        $wasDir = is_dir($path);
        rename($path, $dest);
        writeJsonAtomic($dest . '.meta', json_encode([
            'origPath' => $input['path'],
            'name' => preg_replace('/\.json$/', '', $name),
            'deletedAt' => $stamp,
            'isDir' => $wasDir
        ]));
        echo json_encode(['ok' => true, 'trashId' => $entry]);
        break;

    case 'list_trash':
        $out = [];
        if (is_dir($trashDir)) {
            foreach (scandir($trashDir) as $e) {
                if ($e === '.' || $e === '..') continue;
                if (substr($e, -5) === '.meta') continue;
                $meta = json_decode(@file_get_contents($trashDir . '/' . $e . '.meta'), true) ?: [];
                $out[] = [
                    'id' => $e,
                    'origPath' => $meta['origPath'] ?? $e,
                    'name' => $meta['name'] ?? $e,
                    'deletedAt' => $meta['deletedAt'] ?? null,
                    'isDir' => $meta['isDir'] ?? is_dir($trashDir . '/' . $e)
                ];
            }
            usort($out, function($a, $b) { return ($b['deletedAt'] ?? 0) <=> ($a['deletedAt'] ?? 0); });
        }
        echo json_encode($out);
        break;

    case 'restore_trash':
        requireFields($input, ['id']);
        $id = basename($input['id']);
        $src = $trashDir . '/' . $id;
        if (!file_exists($src)) jsonError('trash item not found', 404);
        $meta = json_decode(@file_get_contents($src . '.meta'), true) ?: [];
        $orig = $meta['origPath'] ?? null;
        if (!$orig) jsonError('cannot determine original location');
        $dest = safePath($base, $orig);
        if ($dest === null) jsonError('invalid original path'); // a crafted/evil .meta stays inert
        $parent = dirname($dest);
        if (!is_dir($parent)) mkdir($parent, 0777, true);
        if (file_exists($dest)) jsonError('an item already exists at the original path');
        rename($src, $dest);
        @unlink($src . '.meta');
        echo json_encode(['ok' => true, 'path' => $orig]);
        break;

    case 'empty_trash':
        if (is_dir($trashDir)) {
            foreach (scandir($trashDir) as $e) {
                if ($e === '.' || $e === '..') continue;
                if (substr($e, -5) === '.meta') continue; // handled with its entry
                // Permanent delete: also drop the item's version history so it can't
                // accumulate unbounded (or leak stale history onto a future same-named
                // page). History survives soft-delete/restore — only pruned here.
                $meta = json_decode(@file_get_contents($trashDir . '/' . $e . '.meta'), true) ?: [];
                $orig = $meta['origPath'] ?? '';
                if ($orig !== '') {
                    // Route through safePath (like restore_trash) — origPath is the RAW
                    // client path from delete, so a '../'-bearing value would otherwise
                    // let rrmdir escape .history.
                    $hp = safePath($historyDir, $orig); // page: .history/<rel>.json/ · folder: .history/<rel>/ (subtree)
                    // safePath now returns null for an unsafe origPath (traversal/dotfile):
                    // skip the history prune for this entry entirely — NEVER rrmdir a null/bad
                    // path — while still permanently removing the trash entry itself below.
                    if ($hp !== null && $hp !== $historyDir . '/' && is_dir($hp)) rrmdir($hp);
                }
                rrmdir($trashDir . '/' . $e);
                @unlink($trashDir . '/' . $e . '.meta');
            }
        }
        echo json_encode(['ok' => true]);
        break;

    case 'list_history':
        // Versions for a page, newest first. input/query: path
        $rel = $input['path'] ?? ($_GET['path'] ?? '');
        $hdir = safePath($historyDir, $rel); // was a raw concat → traversal hole; confine it
        $out = [];
        if ($hdir !== null && is_dir($hdir)) {
            foreach (glob($hdir . '/*.json') ?: [] as $v) {
                $ts = (int)basename($v, '.json');
                $out[] = ['ts' => $ts, 'size' => @filesize($v)];
            }
            usort($out, function($a, $b) { return $b['ts'] <=> $a['ts']; });
        }
        echo json_encode($out);
        break;

    case 'get_history_version':
        requireFields($input, ['path', 'ts']);
        $hfile = safePath($historyDir, $input['path'] . '/' . (int)$input['ts'] . '.json');
        if ($hfile === null) jsonError('invalid path');
        if (!file_exists($hfile)) jsonError('version not found', 404);
        echo file_get_contents($hfile);
        break;

    case 'restore_history':
        // Snapshot current, then overwrite the page with the chosen version.
        requireFields($input, ['path', 'ts']);
        $path = safePath($base, $input['path']);
        $hfile = safePath($historyDir, $input['path'] . '/' . (int)$input['ts'] . '.json');
        if ($path === null || $hfile === null) jsonError('invalid path');
        if (!file_exists($hfile)) jsonError('version not found', 404);
        snapshotHistory($base, $input['path'], $path);
        copy($hfile, $path);
        clearstatcache(true, $path);
        echo json_encode(['ok' => true, 'mtime' => @filemtime($path)]);
        break;

    default:
        jsonError('unknown action', 404);
}
