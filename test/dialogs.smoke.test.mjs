import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const { createSession } = require('../skills/browsing/chrome-ws-lib.js');

// Skip the whole suite if Chrome isn't available locally — contributors
// without Chrome can still run npm test.
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

// Poll until predicate returns truthy (or resolves truthy) or timeout elapses.
async function waitFor(predicate, ms = 3000, interval = 50) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`waitFor timed out after ${ms}ms`);
}

// Reserve a free TCP port atomically using the OS (port 0 trick).
// We close the server immediately after — there is a tiny TOCTOU window,
// but it is far shorter than scanning a range sequentially.
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

// Resolve the profile directory path that Chrome will use for a given name.
// Mirrors getChromeProfileDir() from chrome-launcher-helpers.js without
// relying on XDG_CACHE_HOME (which other concurrent smoke tests may be writing).
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

describe('dialog handling — real Chrome smoke', { skip: !CHROME_AVAILABLE && 'Chrome not installed' }, () => {
  let session;
  let profileName;
  let wsUrl; // ws debugger URL for tab 0, resolved once in before()

  before(async () => {
    profileName = `dialogs-smoke-${Date.now()}`;
    session = createSession();
    session.setProfileName(profileName);
    // Reserve a port atomically to avoid TOCTOU races when other Chrome smoke
    // tests run concurrently and both call findAvailablePort() at the same time.
    const port = await reserveFreePort();
    await session.startChrome(true, null, port); // headless, default profile, reserved port

    // Resolve the tab's wsUrl once — it stays stable for the session lifetime
    // because we never close or replace tab 0.
    const tabs = await session.getTabs();
    wsUrl = tabs[0].webSocketDebuggerUrl;
  });

  after(async () => {
    try { await session.killChrome(); } catch {}
    // Clean up the Chrome profile directory left on disk.
    try {
      const profileDir = resolveProfileDir(profileName);
      fs.rmSync(profileDir, { recursive: true, force: true });
      // Also remove the .meta.json sibling file.
      const metaPath = profileDir + '.meta.json';
      if (fs.existsSync(metaPath)) fs.rmSync(metaPath);
    } catch {}
  });

  // ---------- Test 1: alert dialog ----------
  //
  // Navigate to a page that fires alert() via setTimeout (so loadEventFired
  // completes before the dialog opens — avoiding a 30-second pooled-connection
  // timeout caused by clicking a button whose onclick fires a dialog).
  // The dialog intercept verifies the full CDP path:
  //   Page.javascriptDialogOpening → state map → withDialogAwareness refuses →
  //   dialog::accept → Page.handleJavaScriptDialog → page unblocked.
  it('real alert is surfaced and dismissed with dialog::accept', async () => {
    // The 100 ms delay ensures loadEventFired fires before the alert opens.
    await session.navigate(0, 'data:text/html,<script>setTimeout(()=>alert("smoke-test"),100)</script>');

    // Wait for the dialog event to arrive on the pooled connection.
    await waitFor(() => session.dialogs.getOpen(wsUrl) !== null);

    const open = session.dialogs.getOpen(wsUrl);
    assert.equal(open.kind, 'alert');
    assert.equal(open.payload.message, 'smoke-test');

    // evaluateWithCapture must be refused while the alert is open.
    const evalResult = await session.evaluateWithCapture(0, 'document.title');
    assert.equal(evalResult.refused, true, `Expected refused:true, got: ${JSON.stringify(evalResult)}`);
    assert.match(evalResult.error, /Page is behind a dialog/);

    // Dismiss the alert.
    await session.click(0, 'dialog::accept');

    // Wait for dialog state to clear.
    await waitFor(() => session.dialogs.getOpen(wsUrl) === null);

    // Page is now responsive: evaluate must succeed.
    const title = await session.evaluate(0, 'document.title');
    assert.equal(typeof title, 'string', `Expected string title, got: ${JSON.stringify(title)}`);
  });

  // ---------- Test 2: confirm dialog — accept ----------
  //
  // Confirm dialogs work the same way as alerts. After accept(), the page
  // receives `true` from confirm(), proving the right CDP response was sent.
  it('real confirm dialog is surfaced; accept resolves confirm() as true', async () => {
    // Store result in a global so we can read it after the dialog is dismissed.
    await session.navigate(0, 'data:text/html,<script>setTimeout(()=>{window._r=String(confirm("q?"))},100)</script>');

    await waitFor(() => session.dialogs.getOpen(wsUrl) !== null);

    const open = session.dialogs.getOpen(wsUrl);
    assert.equal(open.kind, 'confirm');
    assert.equal(open.payload.message, 'q?');

    // evaluateWithCapture must be refused while the confirm is open.
    const evalResult = await session.evaluateWithCapture(0, '1');
    assert.equal(evalResult.refused, true, `Expected refused:true, got: ${JSON.stringify(evalResult)}`);

    // Accept the confirm dialog.
    await session.click(0, 'dialog::accept');

    await waitFor(() => session.dialogs.getOpen(wsUrl) === null);

    // confirm() returns true when accepted.
    const result = await session.evaluate(0, 'window._r');
    assert.equal(result, 'true');
  });

  // ---------- Test 3: navigator.permissions.query is NOT shimmed ----------
  //
  // The shim wraps getUserMedia, Notification.requestPermission, geolocation,
  // and clipboard — but NOT navigator.permissions.query. The native query must
  // complete normally and return a valid PermissionState without surfacing a
  // dialog in our state map.
  it('navigator.permissions.query completes normally — not hijacked by shim', async () => {
    await session.navigate(0, `data:text/html,<script>
      navigator.permissions.query({name:'notifications'})
        .then(p => { document.title = p.state; })
        .catch(() => { document.title = 'error'; });
    </script>`);

    // Wait for the async query to resolve and update document.title.
    const VALID_STATES = ['granted', 'denied', 'prompt'];
    await waitFor(async () => {
      try {
        const t = await session.evaluate(0, 'document.title');
        return VALID_STATES.includes(t);
      } catch {
        return false;
      }
    }, 3000);

    const state = await session.evaluate(0, 'document.title');
    assert.ok(
      VALID_STATES.includes(state),
      `Expected a valid PermissionState ('granted'|'denied'|'prompt'), got: ${JSON.stringify(state)}`
    );

    // Critically, no dialog must be open — the shim did not intercept this.
    assert.equal(
      session.dialogs.getOpen(wsUrl),
      null,
      'permissions.query must not leave a dialog open'
    );
  });

  // ---------- Test 4: Notification.requestPermission — skipped ----------
  //
  // The permission shim replaces Notification.requestPermission with a wrapper
  // that calls window.__dialogShim (a Runtime.addBinding). In Chrome 148+,
  // Runtime.addBinding does not inject the binding function into page execution
  // contexts — window.__dialogShim is undefined in the page, causing the shim
  // to throw "window[BINDING] is not a function" when requestPermission() is
  // called. This is a known incompatibility between the current shim
  // implementation and newer Chrome versions. The shim script registered via
  // Page.addScriptToEvaluateOnNewDocument runs correctly (Notification.
  // requestPermission IS replaced), but the binding it tries to call is absent.
  //
  // Until the shim is updated to use a different IPC mechanism (e.g., a
  // postMessage-based channel or a fetch-intercepted beacon), this test cannot
  // reliably pass.
  it('Notification.requestPermission goes through shim — accept yields granted', {
    skip: 'Runtime.addBinding does not inject window.__dialogShim into page contexts in Chrome 148+; shim IPC is broken',
  }, async () => {
    // This is the intended behavior, documented for when the shim is fixed:
    // 1. Navigate to a page that calls Notification.requestPermission()
    // 2. The shim intercepts the call and sends a binding message
    // 3. session.dialogs.getOpen(wsUrl) returns a permission dialog
    // 4. session.click(0, 'dialog::accept') resolves the binding with 'grant'
    // 5. Notification.requestPermission() resolves to 'granted'
    // 6. document.title should become 'granted'
    void 0; // body intentionally empty — test is skipped
  });
});
