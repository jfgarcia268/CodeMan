# CodeMan

A self-hosted **code-snippet manager**. Browse a folder tree of "pages"; each page
holds collapsible sections/subsections; each section holds code / note / rich-text /
checklist blocks with syntax highlighting, tags, search, trash & history, and a
quick-paste palette. It runs as plain static files plus a small PHP API — **no build
step, no database, no external services.** Works offline and (optionally) as a native
desktop app.

```
codeman/          the web app + PHP API (this is what you host)
codeman-desktop/  optional macOS desktop wrapper (Electron)
```

---

## 1. Install the server

The "server" is just the `codeman/` folder served by **any web server that can run
PHP** (PHP 7.4+). It has no database — pages are stored as `.json` files on disk.

### Quick start (local / testing)

```bash
cd codeman
php -S localhost:8090
```

Open <http://localhost:8090/>. With no configuration, data is written to
`codeman/structures/` (created automatically). Good for trying it out; for real use,
configure a data directory **outside** the web root (below).

### Production (nginx + PHP-FPM)

1. Copy/clone the `codeman/` folder somewhere your web server serves, e.g. `/var/www/codeman`.
2. Make sure `*.php` is handled by PHP-FPM. A minimal nginx location:

   ```nginx
   root /var/www;                      # so /codeman/ resolves to /var/www/codeman

   location ~ \.php$ {
       include /etc/nginx/fastcgi_params;
       fastcgi_pass unix:/run/php/php-fpm.sock;   # your PHP-FPM socket
       fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;

       # --- CodeMan configuration (see section 2) ---
       fastcgi_param CODEMAN_DATA /srv/codeman-data;   # data dir OUTSIDE the web root
       # fastcgi_param CODEMAN_PASSWORD changeme;       # optional auth (see below)
   }
   ```
3. Reload nginx. Visit `http://<host>/codeman/`.

> **Apache:** ensure PHP is enabled, then set the data dir with
> `SetEnv CODEMAN_DATA /srv/codeman-data` in your vhost/`.htaccess`.

### NAS / Docker (e.g. linuxserver/nginx)

Same as above, but two gotchas:

- **Deliver config via `fastcgi_param`, not the container's Environment variables.**
  PHP-FPM runs with `clear_env` on, so a `CODEMAN_DATA` set in the container's env list
  **never reaches PHP**. Put it in the nginx PHP `location` block as a `fastcgi_param`
  (as shown above), then restart the container.
- Put the data dir on a **persisted volume outside the web root**, e.g.
  `fastcgi_param CODEMAN_DATA /config/data/codeman;`

---

## 2. Configure the server

All configuration is environment variables, read by `codeman/api.php`:

| Variable | Required | What it does |
|----------|----------|--------------|
| `CODEMAN_DATA` | Recommended | Absolute path to the data directory (pages, `.trash/`, `.history/`, index). **Keep it outside the web root** so it's never web-served or committed. Defaults to `codeman/structures/` if unset. |
| `CODEMAN_PASSWORD` | Optional | If set, the API requires this shared secret on every request (`X-CodeMan-Auth` header, or `?token=`). The browser prompts once and remembers it. **Off by default** (open, for a trusted LAN). Set it if the app is reachable beyond your trusted network, and serve over HTTPS. |

Deliver them however your server passes env to PHP: real env vars (`getenv`),
`$_SERVER` (nginx `fastcgi_param`, Apache `SetEnv`), etc. `api.php` checks `getenv`
then `$_SERVER`, then falls back to the local `structures/` dir.

> **Why outside the web root?** Page data can contain anything you paste in. Keeping
> `CODEMAN_DATA` outside the served folder means the raw `.json` is never reachable over
> HTTP and never tracked by git.

### Backups

Just back up the `CODEMAN_DATA` directory — it's all plain `.json` files. The app also
keeps a soft-delete `.trash/` and per-page `.history/` (last 20 versions) inside it.

---

## 3. Use it in a browser

Open `http://<host>/codeman/` in any modern browser. That's it — create projects,
folders, and pages; add code/note/checklist blocks; tag and search.

**Offline:** while a tab is open, edits keep working if the server blips (they're
mirrored to IndexedDB and synced back on reconnect). For full **offline boot** (opening
the app when the server is unreachable) the browser needs a *secure context* — i.e.
HTTPS with a trusted certificate, or `localhost`. Over plain HTTP on a LAN address the
service worker can't register, so use the **desktop app** below if you want reliable
offline away from the server.

---

## 4. Desktop app (macOS, optional)

`codeman-desktop/` wraps the UI in a small Electron app that **opens and works fully
offline** — it bundles the app shell locally and talks to your server only when
reachable. No certificate, no PWA setup required.

### Install

1. Download the latest `CodeMan-*.dmg` from the repo's **[Releases](../../releases)**
   page (built by CI), or build it yourself (below).
2. Open the `.dmg` and drag **CodeMan** into **Applications**.
3. It's **unsigned**, so first launch: **right-click the app → Open → Open** (this
   clears Gatekeeper; you only do it once).
4. macOS will ask to **allow Local Network access** — click **Allow** (required to reach
   a server on your LAN).

### First launch — connect a server or go offline-only

The desktop app is **not** hard-wired to a server. On first launch a setup screen lets you
choose:

- **Connect a server** — enter the URL of your CodeMan folder (the one serving `api.php`),
  e.g. `http://my-nas.local:8080/codeman/`, and click **Save & open**. The app shows live
  server data and syncs, and still works from its local cache when the server is unreachable.
- **Use offline only** — no server at all. Everything is stored locally on this Mac (in the
  app's own storage). Good for a personal scratchpad. You can connect a server later.

You can change either choice anytime from the menu: **CodeMan ▸ Server / Offline…**

The choice is stored per-machine in the OS user-data dir (`settings.json`), so the app
itself contains no personal URL. (Advanced: `CODEMAN_NAS_BASE` env overrides at launch.)

> Note: in **offline-only** mode the sync badge may show a growing "queued" count — that's
> normal; with no server, local edits just accumulate locally. If you later connect a
> server, those queued edits sync up to it.

### Build from source

```bash
cd codeman-desktop
npm install
npm run dist      # → dist/CodeMan-<version>-arm64.dmg  (Apple Silicon)
npm start         # run in dev without packaging
```

The build is unsigned. To run on an **Intel** Mac, change the build to a universal
target. Releases are produced automatically by the GitHub Actions workflow
(`.github/workflows/codeman-desktop.yml`) when you push a version tag, e.g.:

```bash
git tag v3.2.0 && git push origin v3.2.0
```

---

## How it fits together

```
Browser  ─┐
          ├─►  http(s)://host/codeman/  ──►  api.php  ──►  CODEMAN_DATA/*.json
Desktop  ─┘     (static shell)            (PHP, no DB)      (outside web root)
  app          bundles the shell locally; proxies api.php to your server URL
```

- **No build step** for the web app: the `src/*.js` files are plain scripts loaded in
  order by `index.html`. Edit a file, reload.
- **Vendored Prism** for syntax highlighting (no CDN — works offline).
- Open `codeman/tests.html` in a browser to run the unit tests.

## License

[MIT](LICENSE) © Juan Felipe Garcia
