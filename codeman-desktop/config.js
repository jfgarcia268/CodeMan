// Default server URL baked into the build. The server is the PHP backend
// (the folder containing api.php) — on a NAS, in a container, or any PHP host.
//
// Leave this blank to require per-machine configuration: on first launch the app
// opens a "Server URL" screen, and you can change it anytime via the menu
// (CodeMan ▸ Server URL…). That value is stored in the OS user-data dir, NOT in
// this repo, so a public build ships no personal URL.
//
// You can also override at launch with the CODEMAN_NAS_BASE env var.
//
// If you do set a default here, point it at the folder containing api.php and end
// it with a trailing slash, e.g.  http://my-nas.local:8080/codeman/
module.exports = { DEFAULT_SERVER_URL: '' };
