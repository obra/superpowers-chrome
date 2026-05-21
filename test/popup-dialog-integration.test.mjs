/**
 * Integration test: popup with synchronously-fired dialog — Phase F headline win.
 *
 * Proves that when a page opens a popup via window.open() and the popup fires
 * confirm() synchronously in its first inline script, the system:
 *   1. Pauses the popup at start (autoAttach + waitForDebuggerOnStart)
 *   2. Installs the dialog shim (via onPageSession → dialogs.attachToPageSession)
 *   3. Resumes the popup
 *   4. Captures the confirm dialog event under the popup's sessionId
 *
 * Without the F1–F3 wiring this would race: the popup script could run before
 * the shim is installed, missing the dialog entirely.
 */

import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createSession } = require('../skills/browsing/chrome-ws-lib.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');

// ---------------------------------------------------------------------------
// Chrome detection (matches smoke.test.mjs)
// ---------------------------------------------------------------------------
function detectChrome() {
  const platform = os.platform();
  const candidates = {
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    linux: ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'],
    win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
  };
  for (const p of (candidates[platform] || [])) {
    if (fs.existsSync(p)) return true;
  }
  return false;
}

const CHROME_AVAILABLE = detectChrome();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Poll until predicate returns truthy or timeout elapses (matches dialogs.smoke.test.mjs).
async function waitFor(predicate, ms = 5000, interval = 50) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`waitFor timed out after ${ms}ms`);
}

// Reserve a free TCP port atomically (matches dialogs.smoke.test.mjs).
function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// Mirrors resolveProfileDir from dialogs.smoke.test.mjs.
function resolveProfileDir(profileName) {
  const platform = os.platform();
  const homeDir = os.homedir();
  let base;
  if (process.env.XDG_CACHE_HOME) {
    base = process.env.XDG_CACHE_HOME;
  } else if (platform === 'darwin') {
    base = path.join(homeDir, 'Library', 'Caches');
  } else if (platform === 'win32') {
    base = process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
  } else {
    base = path.join(homeDir, '.cache');
  }
  return path.join(base, 'superpowers', 'browser-profiles', profileName);
}

// Minimal HTTP server that serves HTML files from the fixtures directory.
function startFixtureServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // Accept /popup-opener.html, /popup-with-confirm.html, or /
      const name = (req.url === '/' || req.url === '') ? 'popup-opener.html' : path.basename(req.url);
      const full = path.join(FIXTURES, name);
      if (!fs.existsSync(full)) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(fs.readFileSync(full));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
    server.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('popup dialog integration (Phase F headline win)', {
  skip: !CHROME_AVAILABLE && 'Chrome not installed',
  timeout: 30000,
}, () => {
  let fixtureServer;
  let session;
  let profileName;

  before(async () => {
    fixtureServer = await startFixtureServer();

    profileName = `popup-dialog-${Date.now()}`;
    session = createSession();
    session.setProfileName(profileName);

    // Reserve a port atomically — avoid races with other concurrent Chrome tests.
    const port = await reserveFreePort();
    await session.startChrome(true, null, port); // headless

    // NOTE: We do NOT call ensureBridge() here. The bridge is booted inside the
    // test AFTER the opener page loads, so autoAttach only needs to be active
    // when the popup is opened — not during the initial navigate.
  });

  after(async () => {
    try { await session.killChrome(); } catch {}
    try { fixtureServer.server.close(); } catch {}
    try {
      const profileDir = resolveProfileDir(profileName);
      fs.rmSync(profileDir, { recursive: true, force: true });
      const metaPath = profileDir + '.meta.json';
      if (fs.existsSync(metaPath)) fs.rmSync(metaPath);
    } catch {}
  });

  it('observes a confirm dialog fired synchronously on popup load', async () => {
    const openerUrl = `http://127.0.0.1:${fixtureServer.port}/popup-opener.html`;

    // Navigate the opener tab and wait for it to load.
    // Do this BEFORE ensureBridge() so the navigate() doesn't race with the
    // bridge's autoAttach machinery setting up on the initial blank tab.
    await session.navigate(0, openerUrl);

    // Now boot the bridge so autoAttach is active before we click.
    // ensureBridge() sets up Target.setAutoAttach + waitForDebuggerOnStart.
    const bridge = await session.state.ensureBridge();

    // Record the existing page targets so we can identify the new popup by exclusion.
    const existingTargetIds = new Set(
      bridge.targets.list().filter(t => t.type === 'page').map(t => t.targetId),
    );

    // Arrange: subscribe to new page targets BEFORE clicking so we don't miss the event.
    // We accept ANY new page target — Chrome fires Target.targetCreated with an empty or
    // about:blank URL before the popup navigates to its final URL. The URL-based check
    // happens after we've confirmed the target is new.
    const popupTargetPromise = bridge.targets.waitForNew(
      (t) => t.type === 'page' && !existingTargetIds.has(t.targetId),
      { timeoutMs: 10000 },
    );

    // Act: click the opener button — this calls window.open() synchronously.
    // The popup's first script fires confirm() immediately.
    // The autoAttach machinery should:
    //   1. Pause the popup (waitForDebuggerOnStart)
    //   2. Call onPageSession → dialogs.attachToPageSession (installs shim + Page events)
    //   3. Resume via Runtime.runIfWaitingForDebugger
    //   4. Popup script executes confirm() → Page.javascriptDialogOpening → stored in state.dialogs
    //
    // No dialog is blocking the opener tab, so click proceeds normally.
    await session.click(0, '#open');

    // Wait for Chrome to report the new popup target.
    const popupTarget = await popupTargetPromise;
    assert.ok(popupTarget, 'new popup page target appeared in bridge targets');
    assert.ok(popupTarget.targetId, 'popup target has a targetId');

    // Build the popup's pseudo-wsUrl so dialogs.getOpen() can cross-reference
    // targetId → sessionId via the _targetIdToSessionId map populated by
    // attachToPageSession. The targetId embedded in the path is what getOpen()
    // uses to find the bridge-path sessionId.
    const activePort = session.getActivePort();
    const popupWsUrl = `ws://127.0.0.1:${activePort}/devtools/page/${popupTarget.targetId}`;

    // Wait for the dialog to be recorded in state.dialogs under the popup's sessionId.
    // autoAttach → onPageSession → dialogs.attachToPageSession sets this up before
    // Runtime.runIfWaitingForDebugger is called, so by the time the popup's script
    // runs the Page.javascriptDialogOpening event has a registered handler.
    await waitFor(() => session.dialogs.getOpen(popupWsUrl) !== null, 5000);

    const dialog = session.dialogs.getOpen(popupWsUrl);
    assert.ok(dialog, 'confirm dialog from popup was observed in session.dialogs');
    assert.equal(dialog.kind, 'confirm');
    assert.match(dialog.payload.message, /Proceed/);
  });
});
