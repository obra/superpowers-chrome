import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
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

describe('real Chrome smoke', { skip: !CHROME_AVAILABLE && 'Chrome not installed' }, () => {
  let session;
  let tmpProfileDir;
  let originalXdgCacheHome;

  before(async () => {
    // Use a unique profile so we don't clobber the user's normal profile.
    tmpProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-smoke-'));
    originalXdgCacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = tmpProfileDir;
    session = createSession();
    session.setProfileName(`smoke-${Date.now()}`);
    await session.startChrome(true); // headless
  });

  after(async () => {
    try { await session.killChrome(); } catch {}
    try { fs.rmSync(tmpProfileDir, { recursive: true, force: true }); } catch {}
    if (originalXdgCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = originalXdgCacheHome;
    }
  });

  it('navigate + extractText returns expected content', async () => {
    await session.navigate(0, 'data:text/html,<h1 id="hello">Hello smoke test</h1>');
    const text = await session.extractText(0, '#hello');
    assert.equal(text, 'Hello smoke test');
  });

  it('click triggers a JS handler', async () => {
    const html = `data:text/html,<button id="btn" onclick="this.textContent='clicked'">click me</button>`;
    await session.navigate(0, html);
    await session.click(0, '#btn');
    const text = await session.extractText(0, '#btn');
    assert.equal(text, 'clicked');
  });

  it('fill puts text into an input', async () => {
    await session.navigate(0, 'data:text/html,<input id="i">');
    await session.fill(0, '#i', 'typed text');
    const value = await session.evaluate(0, 'document.getElementById("i").value');
    assert.equal(value, 'typed text');
  });

  it('selectOption sets the value (label match)', async () => {
    const html = `data:text/html,<select id="s"><option value="a">Apple</option><option value="b">Banana</option></select>`;
    await session.navigate(0, html);
    await session.selectOption(0, '#s', 'Banana');
    const value = await session.evaluate(0, 'document.getElementById("s").value');
    assert.equal(value, 'b');
  });

  it('keyboardPress(Tab) advances focus', async () => {
    await session.navigate(0, 'data:text/html,<input id="a"><input id="b">');
    await session.evaluate(0, 'document.getElementById("a").focus()');
    await session.keyboardPress(0, 'Tab');
    const focused = await session.evaluate(0, 'document.activeElement.id');
    assert.equal(focused, 'b');
  });

  it('screenshot writes a non-empty PNG file', async () => {
    await session.navigate(0, 'data:text/html,<h1>screenshot</h1>');
    const tmpFile = path.join(tmpProfileDir, 'shot.png');
    await session.screenshot(0, tmpFile);
    const stat = fs.statSync(tmpFile);
    assert.ok(stat.size > 100); // PNG is at least header-sized
  });

  it('clearCookies executes without error', async () => {
    await session.clearCookies(0);
  });

  it('hideBrowser kills a Chrome the current session reconnected to', async () => {
    const s2 = createSession();
    s2.setProfileName(session.getProfileName());

    // s2 reconnects: state.activePort gets set, state.chromeProcess stays null.
    // Without the port-lookup fallback, this would fail because the original
    // Chrome (owned by `session`) holds the port.
    await s2.startChrome(false /* headed — flips mode if currently headless */);

    assert.equal((await s2.getBrowserMode()).mode, 'headed');

    // s2 owns the new Chrome now; tear it down so the outer after() doesn't
    // try to kill an already-dead process.
    await s2.killChrome();
  });
});
