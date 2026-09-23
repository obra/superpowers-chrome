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

  return { call, capturedFiles, stop, xdg };
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
