/**
 * End-to-end: the bundled MCP server driving a real headless Chrome must
 * not copy credential-shaped page content into the session dir or into
 * use_browser tool results.
 *
 * Pages are data: URLs; every token string is an obviously fake,
 * token-SHAPED value.
 */

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = path.join(__dirname, '..', 'mcp', 'dist', 'index.js');

// Fake tokens are assembled from prefix + body at runtime so no complete
// token-shaped literal sits in the source (GitHub push protection rejects
// those even when they are obviously fake).
const FAKE_TOKEN = ['xoxb', '1111111111', '2222222222', 'FAKEfakeFAKEfakeFAKEfake'].join('-');
const SECRET_HEADING = 'Your new bot token';
const NOTICE = '⚠️ Page shows credential-shaped content; auto-capture and DOM output suppressed.';
const REDACTION = '[REDACTED credential-shaped]';

// Skip if Chrome isn't available locally (matches smoke.test.mjs).
function detectChrome() {
  const candidates = {
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    linux: ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'],
    win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
  };
  return (candidates[os.platform()] || []).some((p) => fs.existsSync(p));
}
const CHROME_AVAILABLE = detectChrome();

function dataUrl(html) {
  return `data:text/html,${encodeURIComponent(html)}`;
}

const TOKEN_PAGE = dataUrl(
  `<title>Token page</title><h1>${SECRET_HEADING}</h1><code id="tok">${FAKE_TOKEN}</code>` +
  '<button id="b">Done</button>'
);
const CLEAN_PAGE = dataUrl('<title>Clean page</title><h1>Plain welcome</h1><button id="b">Go</button>');

// obra#50 follow-up: a bare base32 TOTP seed matches none of the
// TOKEN_PATTERNS in credential-guard.js (no xoxb/ghp/ops_/otpauth prefix),
// so the only thing that can catch it is the data-sen-secret marker
// checked LIVE — by the time eval/extract/attr hand back a plain-text or
// attribute result, the marker tag itself is long gone.
const BASE32_SEED = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const CONTROL_VALUE = 'not-a-secret-control-value';
const MARKER_TEXT_PAGE = dataUrl(
  '<title>Marker page</title><h1>Backup codes</h1>' +
  `<div id="wrap"><code id="secret" data-sen-secret>${BASE32_SEED}</code>` +
  `<code id="control">${CONTROL_VALUE}</code></div>`
);
const MARKER_INPUT_PAGE = dataUrl(
  '<title>Marker input page</title><h1>Backup codes</h1>' +
  `<input id="secret" data-sen-secret value="${BASE32_SEED}">` +
  `<input id="control" value="${CONTROL_VALUE}">`
);

// set_attr fixtures (obra#50 follow-up: split-digit TOTP nonce write).
// PRIOR_NONCE stands in for whatever value a broker nonce field might
// already carry (e.g. left over from an earlier, unrelated capture) —
// the response must never echo it, same as it must never echo BASE32_SEED.
const PRIOR_NONCE = 'stale-prior-nonce-should-never-leak';
const SET_ATTR_PAGE = dataUrl(
  '<title>Split box</title><h1>Backup codes</h1>' +
  `<code id="secret" data-sen-secret>${BASE32_SEED}</code>` +
  `<input id="box0" data-sen-nonce="${PRIOR_NONCE}">`
);
const DIGIT_COUNT = 6;
const DIGITS = '123456';
const SPLIT_DIGIT_BOX_PAGE = dataUrl(
  '<title>Split-digit TOTP</title><h1>Enter your 2FA code</h1>' +
  `<code id="secret" data-sen-secret>${BASE32_SEED}</code>` +
  Array.from({ length: DIGIT_COUNT }, (_, i) => `<input id="box${i}" maxlength="1">`).join('')
);
// Pressing Enter reveals a token (drives the before/after diff capture path).
const REVEAL_ON_ENTER_PAGE = dataUrl(
  '<title>Reveal page</title><h1>Create token</h1><div id="out"></div>' +
  `<script>document.addEventListener('keydown', e => { if (e.key === 'Enter') ` +
  `document.getElementById('out').textContent = '${FAKE_TOKEN}'; });</script>`
);

// A free port for this server's Chrome, so it never shares 9222 with the
// other real-Chrome suites running in parallel.
function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// The token as a JS expression that assembles it at runtime, so it never
// appears whole in a page's HTML source (only in what the page renders).
const TOKEN_JS_EXPR = FAKE_TOKEN.match(/.{1,8}/g).map((part) => `'${part}'`).join(' + ');

// The token split across inline spans: rendered as one run of text, but
// never whole in outerHTML or in the markdown extractor's elements.
const SPLIT_SPAN_PAGE = dataUrl(
  '<title>Split page</title><div>' +
  FAKE_TOKEN.match(/.{1,6}/g).map((part) => `<span>${part}</span>`).join('') +
  '</div>'
);
// The token inside an open shadow root.
const SHADOW_ROOT_PAGE = dataUrl(
  '<title>Shadow page</title><div id="host"></div>' +
  `<script>document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<p>' + ${TOKEN_JS_EXPR} + '</p>';</script>`
);
// Clicking "Show" reveals the token 20ms later, i.e. while the post-click
// auto-capture is running (the XHR-after-"Generate" shape).
const DELAYED_REVEAL_PAGE = dataUrl(
  '<title>Delayed page</title><button id="show">Show</button><div id="out"></div>' +
  `<script>document.getElementById('show').addEventListener('click', () => setTimeout(() => { ` +
  `document.getElementById('out').textContent = ${TOKEN_JS_EXPR}; }, 20));</script>`
);

// Typing into the field opens an alert whose message is the token. The
// alert is deferred with setTimeout so the typing call itself returns
// (a dialog opened synchronously inside an input handler blocks the CDP
// input call until the dialog closes); it opens during type's post-keystroke
// delay, which drives captureActionWithDiff's after-dialog branch. The token
// is assembled at runtime so only the dialog shows it, never the page.
const ALERT_ON_INPUT_PAGE = dataUrl(
  '<title>Alert page</title><h1>Create token</h1><input id="f">' +
  `<script>document.getElementById('f').addEventListener('input', () => ` +
  `setTimeout(() => alert(${TOKEN_JS_EXPR}), 0), { once: true });</script>`
);

/**
 * One MCP server process with its own XDG cache (so its Chrome profile and
 * session dir are private to this test). call() issues a use_browser
 * tools/call and resolves with the CallToolResult.
 */
async function startServer(extraEnv = {}) {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-guard-mcp-'));
  // CHROME_WS_PORT rather than --port: --port skips the reconnect-to-own-
  // Chrome step, so each action would spawn another Chrome that kill_chrome
  // can't find.
  const port = await reserveFreePort();
  const proc = spawn('node', [BUNDLE_PATH, '--headless'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, XDG_CACHE_HOME: xdg, CHROME_WS_PORT: String(port), ...extraEnv },
  });
  let stdout = '';
  let stderr = '';
  let nextId = 1;
  const pending = new Map();

  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  proc.stdout.on('data', (d) => {
    stdout += d.toString();
    let nl;
    while ((nl = stdout.indexOf('\n')) >= 0) {
      const line = stdout.slice(0, nl);
      stdout = stdout.slice(nl + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const waiter = pending.get(msg.id);
      if (!waiter) continue;
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(`protocol error: ${JSON.stringify(msg.error)}`));
      else waiter.resolve(msg.result);
    }
  });

  function request(method, params, timeoutMs = 60000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out\nstderr:\n${stderr}`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'credential-guard-test', version: '0' },
  });
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  async function call(args) {
    const result = await request('tools/call', { name: 'use_browser', arguments: args });
    return { text: result.content?.[0]?.text ?? '', isError: result.isError === true };
  }

  // Every file under the session root (the session dir is created at startup).
  function capturedFiles() {
    const root = path.join(xdg, 'superpowers', 'browser');
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root, { recursive: true })
      .map((rel) => path.join(root, rel))
      .filter((p) => fs.statSync(p).isFile());
  }

  async function stop() {
    try { await call({ action: 'kill_chrome' }); } catch {}
    const exited = new Promise((resolve) => proc.on('exit', resolve));
    proc.stdin.end();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    if (proc.exitCode === null) proc.kill('SIGKILL');
    fs.rmSync(xdg, { recursive: true, force: true });
  }

  return { call, capturedFiles, stop, xdg, port };
}

/**
 * Test-oracle-only direct CDP connection — completely bypasses use_browser
 * (and therefore every guard under test) to read ground-truth live DOM
 * state. This is NOT something the agent can do (its only channel is
 * use_browser's guarded action set); it exists purely so the set_attr
 * end-to-end test below can confirm the digit-box recipe actually worked
 * without relying on the very eval path that's supposed to stay refused
 * for the whole scenario.
 */
async function readLiveValueDirectly(port, expression) {
  const listResp = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await listResp.json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('readLiveValueDirectly: no page target found');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', (e) => reject(new Error(String(e))), { once: true });
  });
  try {
    const id = 1;
    const resultPromise = new Promise((resolve, reject) => {
      ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id !== id) return;
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      });
    });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    const result = await resultPromise;
    return result.result.value;
  } finally {
    ws.close();
  }
}

function assertNoLeak(text) {
  assert.ok(!text.includes(FAKE_TOKEN), `token leaked into tool result:\n${text}`);
  assert.ok(!text.includes('FAKEfake'), `token fragment leaked into tool result:\n${text}`);
  assert.ok(!text.includes(SECRET_HEADING), `page text leaked into tool result:\n${text}`);
}

describe('credential guard through the MCP server (real Chrome)', { skip: !CHROME_AVAILABLE && 'Chrome not installed' }, () => {
  let server;
  before(async () => { server = await startServer(); });
  after(async () => { await server?.stop(); });

  it('navigate to a page showing a token writes no files and returns only metadata', async () => {
    const filesBefore = server.capturedFiles().length;
    const { text, isError } = await server.call({ action: 'navigate', payload: TOKEN_PAGE });

    assert.equal(isError, false, text);
    assert.ok(text.includes(NOTICE), text);
    assertNoLeak(text);
    assert.match(text, /Interactive: 1 buttons/);
    assert.equal(server.capturedFiles().length, filesBefore, 'no capture artifacts may be written');
  });

  it('click on that page writes no files and returns only metadata', async () => {
    const filesBefore = server.capturedFiles().length;
    const { text } = await server.call({ action: 'click', selector: '#b' });

    assert.ok(text.includes(NOTICE), text);
    assertNoLeak(text);
    assert.equal(server.capturedFiles().length, filesBefore);
  });

  it('extract redacts the token and eval redacts it but still returns ordinary values', async () => {
    const extracted = await server.call({ action: 'extract', payload: 'text' });
    assert.equal(extracted.isError, false, extracted.text);
    assert.ok(extracted.text.includes(REDACTION), extracted.text);
    assert.ok(!extracted.text.includes(FAKE_TOKEN), extracted.text);

    const html = await server.call({ action: 'extract', payload: 'html' });
    assert.ok(!html.text.includes(FAKE_TOKEN), html.text);

    const leaked = await server.call({ action: 'eval', payload: "document.getElementById('tok').textContent" });
    assert.ok(leaked.text.includes(`Result: ${REDACTION}`), leaked.text);
    assertNoLeak(leaked.text);

    const blind = await server.call({ action: 'eval', payload: "document.getElementById('tok').textContent.length" });
    assert.ok(blind.text.includes(`Result: ${FAKE_TOKEN.length}`), blind.text);
  });

  it('screenshot refuses on a page showing a token', async () => {
    const shot = path.join(server.xdg, 'refused.png');
    const { text, isError } = await server.call({ action: 'screenshot', payload: shot });

    assert.equal(isError, true, text);
    assert.match(text, /screenshot refused/i);
    assertNoLeak(text);
    assert.equal(fs.existsSync(shot), false);
  });

  it('an action that reveals a token (before/after diff path) leaves no files and no diff', async () => {
    await server.call({ action: 'navigate', payload: REVEAL_ON_ENTER_PAGE });
    const filesBefore = server.capturedFiles().length;
    const { text } = await server.call({ action: 'keyboard_press', payload: 'Enter' });

    assert.ok(text.includes(NOTICE), text);
    assertNoLeak(text);
    assert.ok(!text.includes('DOM Changes'), text);
    assert.equal(server.capturedFiles().length, filesBefore, 'no before/after/diff files may remain');
  });

  it('an action that opens a token-bearing dialog returns the notice, the accept/dismiss instructions and the redacted message, and writes no dialog files', async () => {
    await server.call({ action: 'navigate', payload: ALERT_ON_INPUT_PAGE });
    const filesBefore = new Set(server.capturedFiles());
    const { text } = await server.call({ action: 'type', selector: '#f', payload: 'x' });

    assert.ok(text.includes(NOTICE), text);
    assert.ok(text.includes('dialog::accept'), text);
    assert.ok(text.includes(REDACTION), text);
    assertNoLeak(text);
    // The BEFORE screenshot of the (clean) page is taken before the action
    // opens the dialog and is the only file this action may leave.
    const newFiles = server.capturedFiles().filter((f) => !filesBefore.has(f));
    assert.deepEqual(newFiles.map((f) => path.basename(f).replace(/^\d+-/, '')), ['type-before.png']);

    const accepted = await server.call({ action: 'click', selector: 'dialog::accept' });
    assert.equal(accepted.isError, false, accepted.text);
  });

  for (const [name, page] of [
    ['split across inline spans', SPLIT_SPAN_PAGE],
    ['inside an open shadow root', SHADOW_ROOT_PAGE],
  ]) {
    it(`a token ${name} is suppressed and refuses screenshot`, async () => {
      const filesBefore = server.capturedFiles().length;
      const { text } = await server.call({ action: 'navigate', payload: page });

      assert.ok(text.includes(NOTICE), text);
      assertNoLeak(text);
      assert.equal(server.capturedFiles().length, filesBefore, 'no capture artifacts may be written');

      const shot = path.join(server.xdg, 'hidden-token.png');
      const shotResult = await server.call({ action: 'screenshot', payload: shot });
      assert.equal(shotResult.isError, true, shotResult.text);
      assert.equal(fs.existsSync(shot), false);
    });
  }

  it('a token revealed while the post-click capture runs leaves no files', async () => {
    await server.call({ action: 'navigate', payload: DELAYED_REVEAL_PAGE });
    const filesBefore = server.capturedFiles().length;
    const { text } = await server.call({ action: 'click', selector: '#show' });

    assertNoLeak(text);
    assert.equal(server.capturedFiles().length, filesBefore, 'no artifact (PNG included) may survive');
  });

  it('a normal page still captures files and DOM text as before', async () => {
    const filesBefore = server.capturedFiles().length;
    const { text } = await server.call({ action: 'navigate', payload: CLEAN_PAGE });

    assert.ok(!text.includes(NOTICE), text);
    assert.match(text, /Files: \d+-navigate\.html/);
    assert.match(text, /Headings: "Plain welcome"/);
    const newFiles = server.capturedFiles().length - filesBefore;
    assert.equal(newFiles, 4, 'html, md, png and console files');

    const shot = path.join(server.xdg, 'clean.png');
    const shotResult = await server.call({ action: 'screenshot', payload: shot });
    assert.equal(shotResult.isError, false, shotResult.text);
    assert.ok(fs.existsSync(shot));
  });
});

describe('SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE=1 (real Chrome)', { skip: !CHROME_AVAILABLE && 'Chrome not installed' }, () => {
  let server;
  before(async () => { server = await startServer({ SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE: '1' }); });
  after(async () => { await server?.stop(); });

  it('restores capture and unredacted output', async () => {
    const filesBefore = new Set(server.capturedFiles());
    const { text } = await server.call({ action: 'navigate', payload: TOKEN_PAGE });

    assert.ok(!text.includes(NOTICE), text);
    assert.match(text, new RegExp(`Headings: "${SECRET_HEADING}"`));
    const newFiles = server.capturedFiles().filter((f) => !filesBefore.has(f));
    assert.equal(newFiles.length, 4);
    const htmlFile = newFiles.find((f) => f.endsWith('.html'));
    assert.ok(fs.readFileSync(htmlFile, 'utf8').includes(FAKE_TOKEN));

    const extracted = await server.call({ action: 'extract', payload: 'text' });
    assert.ok(extracted.text.includes(FAKE_TOKEN), extracted.text);
  });
});

// obra#50 follow-up: the data-sen-secret marker with content that matches
// no TOKEN_PATTERNS (a bare base32 seed). Screenshot/capture already
// refused correctly per #49/#50; this covers eval, extract and attr, which
// didn't.
describe('data-sen-secret marker with no token-shaped content (real Chrome)', { skip: !CHROME_AVAILABLE && 'Chrome not installed' }, () => {
  let server;
  before(async () => { server = await startServer(); });
  after(async () => { await server?.stop(); });

  it('eval on the marked element refuses and never returns the seed', async () => {
    await server.call({ action: 'navigate', payload: MARKER_TEXT_PAGE });
    const { text, isError } = await server.call({
      action: 'eval',
      payload: "document.getElementById('secret').textContent",
    });
    assert.equal(isError, true, text);
    assert.match(text, /eval refused.*data-sen-secret/i);
    assert.ok(!text.includes(BASE32_SEED), text);
  });

  it('eval on an unmarked control element on the same page ALSO refuses (fail closed page-wide)', async () => {
    // Intentional: eval has no way to know in advance whether an
    // expression is value-blind, so the marker's mere presence anywhere on
    // the page blocks eval outright, not just reads of the marked element.
    const { text, isError } = await server.call({
      action: 'eval',
      payload: "document.getElementById('control').textContent",
    });
    assert.equal(isError, true, text);
    assert.match(text, /eval refused.*data-sen-secret/i);
  });

  // Two explicit cases requested in review (obra#50 follow-up): a caller
  // doesn't have to name the marked element to pull its value out of the page.
  // eval's guard checks for the marker's presence, not for whether the
  // expression happens to name `#secret` by id, so both must refuse
  // identically to the direct-reference case above.
  it("eval of document.body.innerText refuses and the seed appears nowhere in the response", async () => {
    const { text, isError } = await server.call({ action: 'eval', payload: 'document.body.innerText' });
    assert.equal(isError, true, text);
    assert.match(text, /eval refused.*data-sen-secret/i);
    assert.ok(!text.includes(BASE32_SEED), text);
  });

  for (const [name, expression] of [
    [
      'querySelectorAll("*") + map + join, naming no element by id or marker',
      "[...document.querySelectorAll('*')].map(e => e.textContent).join('')",
    ],
    [
      'querySelector("[data-sen-secret]") read via split/join instead of a bare .textContent',
      "document.querySelector('[data-sen-secret]').textContent.split('').join('')",
    ],
    [
      'reassembled via string concatenation from character-indexed reads',
      "(() => { const s = document.querySelector('[data-sen-secret]').textContent; let out = ''; for (let i = 0; i < s.length; i++) out = out + s[i]; return out; })()",
    ],
  ]) {
    it(`eval of an expression that builds the value without naming the marked element directly refuses (${name})`, async () => {
      const { text, isError } = await server.call({ action: 'eval', payload: expression });
      assert.equal(isError, true, text);
      assert.match(text, /eval refused.*data-sen-secret/i);
      assert.ok(!text.includes(BASE32_SEED), text);
    });
  }

  it('extract text with no selector (whole page) refuses rather than gluing the seed to other text', async () => {
    const { text, isError } = await server.call({ action: 'extract', payload: 'text' });
    assert.equal(isError, true, text);
    assert.match(text, /extract refused.*data-sen-secret/i);
    assert.ok(!text.includes(BASE32_SEED), text);
  });

  it('extract text with a selector on the marked element refuses', async () => {
    const { text, isError } = await server.call({ action: 'extract', selector: '#secret', payload: 'text' });
    assert.equal(isError, true, text);
    assert.match(text, /extract refused.*data-sen-secret/i);
  });

  it('extract text with a selector on the unmarked control element still works', async () => {
    const { text, isError } = await server.call({ action: 'extract', selector: '#control', payload: 'text' });
    assert.equal(isError, false, text);
    assert.equal(text, CONTROL_VALUE);
  });

  it('extract text on a wrapper containing both elements strips only the marked one', async () => {
    const { text, isError } = await server.call({ action: 'extract', selector: '#wrap', payload: 'text' });
    assert.equal(isError, false, text);
    assert.ok(!text.includes(BASE32_SEED), text);
    assert.ok(text.includes(CONTROL_VALUE), text);
  });

  it('extract html strips the marked element and keeps the control element, whole-page and selector forms', async () => {
    const wrap = await server.call({ action: 'extract', selector: '#wrap', payload: 'html' });
    assert.equal(wrap.isError, false, wrap.text);
    assert.ok(!wrap.text.includes(BASE32_SEED), wrap.text);
    assert.ok(!wrap.text.includes('data-sen-secret'), wrap.text);
    assert.ok(wrap.text.includes(CONTROL_VALUE), wrap.text);

    const whole = await server.call({ action: 'extract', payload: 'html' });
    assert.equal(whole.isError, false, whole.text);
    assert.ok(!whole.text.includes(BASE32_SEED), whole.text);
    assert.ok(whole.text.includes(CONTROL_VALUE), whole.text);
  });

  it('extract markdown strips the marked element and keeps the control element', async () => {
    const { text, isError } = await server.call({ action: 'extract', payload: 'markdown' });
    assert.equal(isError, false, text);
    assert.ok(!text.includes(BASE32_SEED), text);
    assert.ok(text.includes(CONTROL_VALUE), text);
  });

  it('attr on the marked element refuses, even for an attribute that is not the marker itself', async () => {
    await server.call({ action: 'navigate', payload: MARKER_INPUT_PAGE });
    const { text, isError } = await server.call({ action: 'attr', selector: '#secret', payload: 'value' });
    assert.equal(isError, true, text);
    assert.match(text, /attr refused.*data-sen-secret/i);
    assert.ok(!text.includes(BASE32_SEED), text);
  });

  it('attr on the unmarked control element still works', async () => {
    const { text, isError } = await server.call({ action: 'attr', selector: '#control', payload: 'value' });
    assert.equal(isError, false, text);
    assert.equal(text, CONTROL_VALUE);
  });
});

describe(
  'SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE=1 restores eval/extract/attr on a data-sen-secret page (real Chrome)',
  { skip: !CHROME_AVAILABLE && 'Chrome not installed' },
  () => {
    let server;
    before(async () => { server = await startServer({ SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE: '1' }); });
    after(async () => { await server?.stop(); });

    it('eval, extract and attr all return the marked value unredacted', async () => {
      await server.call({ action: 'navigate', payload: MARKER_TEXT_PAGE });

      const ev = await server.call({ action: 'eval', payload: "document.getElementById('secret').textContent" });
      assert.equal(ev.isError, false, ev.text);
      assert.ok(ev.text.includes(BASE32_SEED), ev.text);

      const ext = await server.call({ action: 'extract', payload: 'text' });
      assert.equal(ext.isError, false, ext.text);
      assert.ok(ext.text.includes(BASE32_SEED), ext.text);

      await server.call({ action: 'navigate', payload: MARKER_INPUT_PAGE });
      const attr = await server.call({ action: 'attr', selector: '#secret', payload: 'value' });
      assert.equal(attr.isError, false, attr.text);
      assert.equal(attr.text, BASE32_SEED);
    });
  }
);

// obra#50 follow-up, second round: set_attr is the write-only escape hatch
// from eval's page-wide fail-closed refusal, added specifically so an
// agent entering a split-digit one-time code can stamp a broker nonce
// onto an unmarked digit-input box right after capturing a seed on the
// same (now marked) page. See skills/browsing/lib/set-attribute.js for
// the design.
describe('set_attr (real Chrome)', { skip: !CHROME_AVAILABLE && 'Chrome not installed' }, () => {
  let server;
  before(async () => { server = await startServer(); });
  after(async () => { await server?.stop(); });

  it('(a) sets data-sen-nonce on an unmarked box while a marked seed is on the page, and eval is still refused there', async () => {
    await server.call({ action: 'navigate', payload: SET_ATTR_PAGE });

    const set = await server.call({
      action: 'set_attr',
      selector: '#box0',
      payload: { name: 'data-sen-nonce', value: 'fresh-nonce-abc' },
    });
    assert.equal(set.isError, false, set.text);

    const ev = await server.call({ action: 'eval', payload: "document.getElementById('box0').textContent" });
    assert.equal(ev.isError, true, ev.text);
    assert.match(ev.text, /eval refused.*data-sen-secret/i);
  });

  it('(a, necessity) the equivalent write via eval is refused, which is why set_attr exists', async () => {
    const { text, isError } = await server.call({
      action: 'eval',
      payload: "document.getElementById('box0').setAttribute('data-sen-nonce', 'via-eval')",
    });
    assert.equal(isError, true, text);
    assert.match(text, /eval refused.*data-sen-secret/i);
  });

  it('(b) set_attr on the marked element itself is refused', async () => {
    const { text, isError } = await server.call({
      action: 'set_attr',
      selector: '#secret',
      payload: { name: 'data-sen-nonce', value: 'x' },
    });
    assert.equal(isError, true, text);
    assert.match(text, /set_attr refused.*data-sen-secret/i);
  });

  it('(c) name=data-sen-secret is refused (cannot strip or overwrite the marker)', async () => {
    const { text, isError } = await server.call({
      action: 'set_attr',
      selector: '#box0',
      payload: { name: 'data-sen-secret', value: 'x' },
    });
    assert.equal(isError, true, text);
    assert.match(text, /set_attr refused.*not allowed/i);
  });

  // The allowlist is a single exact name (data-sen-nonce), not a
  // data-*/aria-* prefix: page JS and frameworks routinely wire arbitrary
  // data-*/aria-* attributes to behavior (data-action, aria-controls, and
  // more a hostile page could invent), so "any data-*/aria-* name" is not
  // guaranteed inert. These three cover that narrowing explicitly, each
  // under its own name, per review feedback.
  it('(c) name=onclick is refused', async () => {
    const { text, isError } = await server.call({
      action: 'set_attr',
      selector: '#box0',
      payload: { name: 'onclick', value: 'x' },
    });
    assert.equal(isError, true, text);
    assert.match(text, /set_attr refused.*not allowed/i);
  });

  it('(c) name=href is refused', async () => {
    const { text, isError } = await server.call({
      action: 'set_attr',
      selector: '#box0',
      payload: { name: 'href', value: 'javascript:alert(1)' },
    });
    assert.equal(isError, true, text);
    assert.match(text, /set_attr refused.*not allowed/i);
  });

  it('(c) an arbitrary data-* name (data-foo) is refused, not just data-sen-secret', async () => {
    const { text, isError } = await server.call({
      action: 'set_attr',
      selector: '#box0',
      payload: { name: 'data-foo', value: 'x' },
    });
    assert.equal(isError, true, text);
    assert.match(text, /set_attr refused.*not allowed/i);
  });

  it("(d) the response contains neither the seed nor the attribute's prior value", async () => {
    // SET_ATTR_PAGE's #box0 already carries data-sen-nonce=PRIOR_NONCE.
    const { text, isError } = await server.call({
      action: 'set_attr',
      selector: '#box0',
      payload: { name: 'data-sen-nonce', value: 'brand-new-nonce-xyz' },
    });
    assert.equal(isError, false, text);
    assert.ok(!text.includes(BASE32_SEED), text);
    assert.ok(!text.includes(PRIOR_NONCE), text);
    // Not even the just-written value is echoed back.
    assert.ok(!text.includes('brand-new-nonce-xyz'), text);
  });

  it('(e) end-to-end split-digit recipe: set_attr the nonce, then type digits, with the seed never appearing in any response', async () => {
    await server.call({ action: 'navigate', payload: SPLIT_DIGIT_BOX_PAGE });

    // (e, necessity) attempting the recipe's first step via eval instead of
    // set_attr fails, same as case (a) above — this is what set_attr fixes.
    const evalAttempt = await server.call({
      action: 'eval',
      payload: "document.getElementById('box0').setAttribute('data-sen-nonce', 'via-eval')",
    });
    assert.equal(evalAttempt.isError, true, evalAttempt.text);
    assert.match(evalAttempt.text, /eval refused.*data-sen-secret/i);

    // The real recipe: set_attr instead of eval.
    const setNonce = await server.call({
      action: 'set_attr',
      selector: '#box0',
      payload: { name: 'data-sen-nonce', value: 'recipe-nonce-001' },
    });
    assert.equal(setNonce.isError, false, setNonce.text);
    assert.ok(!setNonce.text.includes(BASE32_SEED), setNonce.text);

    // Type one digit into each box.
    const typeResponses = [];
    for (let i = 0; i < DIGIT_COUNT; i++) {
      const r = await server.call({ action: 'type', selector: `#box${i}`, payload: DIGITS[i] });
      typeResponses.push(r);
      assert.equal(r.isError, false, r.text);
    }

    // Ground truth check, via a direct CDP connection that bypasses
    // use_browser entirely (see readLiveValueDirectly's doc comment) —
    // the only way to confirm the recipe actually worked, since every
    // use_browser read action is (correctly) still refusing or redacting
    // on this page.
    const joined = await readLiveValueDirectly(
      server.port,
      `Array.from({length:${DIGIT_COUNT}}, (_, i) => document.getElementById('box'+i).value).join('')`
    );
    assert.equal(joined, DIGITS);
    const nonce = await readLiveValueDirectly(server.port, "document.getElementById('box0').getAttribute('data-sen-nonce')");
    assert.equal(nonce, 'recipe-nonce-001');

    // Nothing returned by any use_browser call along the way carried the
    // seed.
    for (const r of [evalAttempt, setNonce, ...typeResponses]) {
      assert.ok(!r.text.includes(BASE32_SEED), r.text);
    }
  });
});
