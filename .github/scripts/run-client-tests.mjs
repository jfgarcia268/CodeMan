#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CI runner for the CodeMan CLIENT unit suite (codeman/tests.html).
//
// tests.html is a plain browser page (no test framework): it runs ~200
// assertions and publishes `window.__testResult = { pass, fail, done }` —
// `done` flips true only after the async (IndexedDB/offline) tests finish.
// This script serves codeman/ with `php -S` (the documented dev loop), opens
// the page headless via Playwright, polls __testResult, and fails on:
//   - fail > 0                  (an assertion failed)
//   - !done within TIMEOUT_MS   (the suite hung or crashed mid-run)
//   - pass < FLOOR              (the suite silently shrank — e.g. an early
//                               script error swallowed half the assertions)
//
// FLOOR must be bumped when assertions are intentionally added/removed —
// keep it equal to the suite's actual total.
//
// Playwright is a CI-only dependency installed under .github/ (never inside
// codeman/ — the app has no build step and no npm deps). Locally you can run
// this too: it falls back to the installed Chrome when the bundled chromium
// hasn't been downloaded.
// ---------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.CODEMAN_ROOT || path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.CODEMAN_TEST_PORT || 8123);
const FLOOR = 511;            // = tests.html's current assertion total
const TIMEOUT_MS = 60000;

function fail(msg) { console.error('✗ ' + msg); process.exit(1); }

// Serve codeman/ (tests.html loads src/*.js + vendored libs relative to it).
const php = spawn('php', ['-S', `127.0.0.1:${PORT}`, '-t', path.join(ROOT, 'codeman')], { stdio: 'ignore' });
php.on('error', () => fail('php not found — the client suite needs `php -S` to serve tests.html'));
process.on('exit', () => { try { php.kill(); } catch (e) { /* already gone */ } });

const base = `http://127.0.0.1:${PORT}`;
let up = false;
for (let i = 0; i < 50 && !up; i++) {
  try { await fetch(base + '/tests.html', { method: 'HEAD' }); up = true; }
  catch (e) { await new Promise((r) => setTimeout(r, 200)); }
}
if (!up) fail(`php -S did not come up on ${base}`);

let browser;
try { browser = await chromium.launch(); }
catch (e) { browser = await chromium.launch({ channel: 'chrome' }); } // local fallback

const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
await page.goto(base + '/tests.html');

const deadline = Date.now() + TIMEOUT_MS;
let result = null;
while (Date.now() < deadline) {
  result = await page.evaluate(() => window.__testResult || null);
  if (result && result.done) break;
  await new Promise((r) => setTimeout(r, 250));
}
await browser.close();

if (!result || !result.done) {
  fail(`tests.html did not finish within ${TIMEOUT_MS / 1000}s ` +
       `(last result: ${JSON.stringify(result)}; page errors: ${pageErrors.join(' | ') || 'none'})`);
}
if (result.fail > 0) fail(`${result.fail} assertion(s) failed (${result.pass} passed)`);
if (result.pass < FLOOR) {
  fail(`only ${result.pass} assertions ran — expected at least ${FLOOR}. ` +
       `Did an early error swallow part of the suite? (page errors: ${pageErrors.join(' | ') || 'none'}) ` +
       `If assertions were removed on purpose, update FLOOR in .github/scripts/run-client-tests.mjs.`);
}
console.log(`✓ tests.html: ${result.pass} passed, 0 failed (floor ${FLOOR})`);
process.exit(0);
