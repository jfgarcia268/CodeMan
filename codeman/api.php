<?php
header('Content-Type: application/json');

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
if (file_exists($indexFile)) {
    $loaded = json_decode(@file_get_contents($indexFile), true);
    if (is_array($loaded)) $index = $loaded;
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

function safePath($base, $rel) {
    $rel = str_replace('\\', '/', $rel);
    $parts = array_filter(explode('/', $rel), function($p) {
        return $p !== '' && $p !== '.' && $p !== '..';
    });
    return $base . '/' . implode('/', $parts);
}

// Manual child ordering per folder, persisted in a hidden .order.json holding
// child entry names (folder names and "page.json" filenames) in display order.
function readOrder($dir) {
    $f = rtrim($dir, '/') . '/.order.json';
    if (file_exists($f)) { $o = json_decode(@file_get_contents($f), true); if (is_array($o)) return $o; }
    return [];
}
function writeOrder($dir, $order) {
    file_put_contents(rtrim($dir, '/') . '/.order.json', json_encode(array_values($order)), LOCK_EX);
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
    file_put_contents(colSortFile($base), json_encode((object)$map), LOCK_EX);
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
        file_put_contents($indexFile, json_encode($index), LOCK_EX);
    }
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
    $hdir = $historyDir . '/' . $rel;
    if (!is_dir($hdir)) mkdir($hdir, 0777, true);
    $stamp = @filemtime($path) ?: time();
    $vfile = $hdir . '/' . $stamp . '.json';
    if (!file_exists($vfile)) file_put_contents($vfile, $old, LOCK_EX);
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
// request — the client sends it in the X-CodeMan-Auth header (or ?token=). Since
// page data lives outside the webroot and is only reachable through this script,
// gating here protects the data. hash_equals avoids timing leaks.
$authPass = getenv('CODEMAN_PASSWORD');
if (!$authPass && !empty($_SERVER['CODEMAN_PASSWORD'])) $authPass = $_SERVER['CODEMAN_PASSWORD'];
if ($authPass) {
    $provided = $_SERVER['HTTP_X_CODEMAN_AUTH'] ?? ($_GET['token'] ?? '');
    if (!is_string($provided) || !hash_equals((string)$authPass, $provided)) {
        http_response_code(401);
        echo json_encode(['error' => 'authentication required', 'auth' => true]);
        exit;
    }
}

switch ($action) {
    case 'tree':
        $tree = buildTree($base, $base);
        flushIndex();
        echo json_encode($tree);
        break;

    case 'rebuild_index':
        // Force a full re-parse: drop the index, then rebuild from disk.
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
            $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($base, RecursiveDirectoryIterator::SKIP_DOTS));
            foreach ($it as $file) {
                if (substr($file->getFilename(), 0, 1) === '.') continue;
                // skip anything inside hidden dirs (.trash/.history)
                if (strpos(str_replace('\\', '/', $file->getPathname()), '/.') !== false) continue;
                if (substr($file->getFilename(), -5) !== '.json') continue;
                $content = @file_get_contents($file->getPathname());
                if ($content !== false && stripos($content, $q) !== false) {
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
            $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($base, RecursiveDirectoryIterator::SKIP_DOTS));
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
        $totalMatches = 0; $changedPages = 0; $pageList = [];
        $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($base, RecursiveDirectoryIterator::SKIP_DOTS));
        foreach ($it as $file) {
            if (substr($file->getFilename(), -5) !== '.json') continue;
            if (strpos(str_replace('\\', '/', $file->getPathname()), '/.') !== false) continue;
            $data = json_decode(@file_get_contents($file->getPathname()), true);
            if (!is_array($data) || empty($data['sections'])) continue;
            $pageMatches = 0;
            $cb = function($code) use ($pat, $repl, $preview, &$pageMatches) {
                if ($preview) { $pageMatches += preg_match_all($pat, $code, $m); return null; }
                $new = preg_replace($pat, $repl, $code, -1, $c); $pageMatches += $c; return $new;
            };
            $changed = false;
            foreach ($data['sections'] as &$s) { if (cm_walkBlocks($s, $cb)) $changed = true; }
            unset($s);
            if ($pageMatches > 0) {
                $totalMatches += $pageMatches;
                $rel = ltrim(substr($file->getPathname(), strlen($base)), '/');
                $pageList[] = ['path' => $rel, 'matches' => $pageMatches];
                if (!$preview && $changed) {
                    snapshotHistory($base, $rel, $file->getPathname());
                    file_put_contents($file->getPathname(), json_encode($data, JSON_PRETTY_PRINT), LOCK_EX);
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
        // using it), sorted by frequency then name.
        $counts = [];
        $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($base, RecursiveDirectoryIterator::SKIP_DOTS));
        foreach ($it as $file) {
            if (substr($file->getFilename(), -5) !== '.json') continue;
            if (strpos(str_replace('\\', '/', $file->getPathname()), '/.') !== false) continue;
            $meta = pageMeta($file->getPathname());
            foreach ($meta['tags'] as $t) { $counts[$t] = ($counts[$t] ?? 0) + 1; }
        }
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
        $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($base, RecursiveDirectoryIterator::SKIP_DOTS));
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
                file_put_contents($full, json_encode($data, JSON_PRETTY_PRINT), LOCK_EX);
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
        if (!is_dir($path)) mkdir($path, 0777, true);
        prependOrder(safePath($base, $parent), $name); // new folder at top
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
        if ($parent !== '' && !file_exists($parentDir . '/.project')) {
            jsonError('projects can only be created at the top level or inside another project');
        }
        $path = safePath($base, $parent . '/' . $name);
        if (!is_dir($path)) mkdir($path, 0777, true);
        @file_put_contents($path . '/.project', '');
        prependOrder($parentDir, $name); // new project at top of its parent
        echo json_encode(['ok' => true]);
        break;

    case 'reorder':
        // Persist a folder's child display order. input: { parent, order: [names] }
        $dir = safePath($base, $input['parent'] ?? '');
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
        if (!file_exists($path)) {
            file_put_contents($path, json_encode(['title' => $name, 'sections' => []], JSON_PRETTY_PRINT));
        }
        echo json_encode(['ok' => true]);
        break;

    case 'get_page':
        $rel = $input['path'] ?? ($_GET['path'] ?? '');
        $path = safePath($base, $rel);
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
        snapshotHistory($base, $input['path'], $path); // version the prior content
        file_put_contents($path, json_encode($data, JSON_PRETTY_PRINT), LOCK_EX);
        clearstatcache(true, $path);
        echo json_encode(['ok' => true, 'mtime' => @filemtime($path)]);
        break;

    case 'rename':
        requireFields($input, ['path', 'newName']);
        $newName = safeName($input['newName']);
        if ($newName === null) jsonError('invalid name');
        $oldPath = safePath($base, $input['path']);
        if (!file_exists($oldPath)) jsonError('source not found', 404);
        $isFolder = is_dir($oldPath);
        $dir = dirname($oldPath);
        $newPath = $isFolder ? $dir . '/' . $newName : $dir . '/' . $newName . '.json';
        if (file_exists($newPath)) jsonError('name already exists');
        rename($oldPath, $newPath);
        echo json_encode(['ok' => true]);
        break;

    case 'move':
        // Move a page or folder into a target folder ('' = root).
        requireFields($input, ['path']);
        $src = safePath($base, $input['path']);
        $destDir = safePath($base, $input['target'] ?? '');
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
        echo json_encode(['ok' => true]);
        break;

    case 'delete':
        // Soft delete: move into .trash with a sidecar .meta so it can be restored.
        requireFields($input, ['path']);
        $path = safePath($base, $input['path']);
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
        @file_put_contents($dest . '.meta', json_encode([
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
                rrmdir($trashDir . '/' . $e);
            }
        }
        echo json_encode(['ok' => true]);
        break;

    case 'list_history':
        // Versions for a page, newest first. input/query: path
        $rel = $input['path'] ?? ($_GET['path'] ?? '');
        $hdir = $historyDir . '/' . $rel;
        $out = [];
        if (is_dir($hdir)) {
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
        if (!file_exists($hfile)) jsonError('version not found', 404);
        echo file_get_contents($hfile);
        break;

    case 'restore_history':
        // Snapshot current, then overwrite the page with the chosen version.
        requireFields($input, ['path', 'ts']);
        $path = safePath($base, $input['path']);
        $hfile = safePath($historyDir, $input['path'] . '/' . (int)$input['ts'] . '.json');
        if (!file_exists($hfile)) jsonError('version not found', 404);
        snapshotHistory($base, $input['path'], $path);
        copy($hfile, $path);
        clearstatcache(true, $path);
        echo json_encode(['ok' => true, 'mtime' => @filemtime($path)]);
        break;

    default:
        jsonError('unknown action', 404);
}
