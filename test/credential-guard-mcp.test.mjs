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
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
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

// A bare base32 TOTP seed matches none of the
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

// Real case this default-pattern detection exists for: Slack's 2FA setup
// page renders the TOTP seed into a hidden `#init_key_code` element from
// the moment the page loads -- no click, no data-sen-secret marking (that
// can only happen AFTER a capture already ran), no token shape
// credential-guard.js recognizes. The very first navigate's auto-capture
// must still never write the seed to any artifact.
const INIT_KEY_CODE_PAGE = dataUrl(
  '<title>Set up two-step verification</title><h1>Scan this QR code</h1>' +
  `<input type="hidden" id="init_key_code" value="${BASE32_SEED}">` +
  '<button id="b">Done</button>'
);
// Marks the root of whole-page extraction itself, not a descendant of it.
const MARKER_BODY_PAGE = dataUrl(
  `<title>Marked body page</title><body data-sen-secret><p>${BASE32_SEED}</p></body>`
);

// set_attr fixtures (split-digit TOTP nonce write).
// PRIOR_NONCE stands in for whatever value a broker nonce field might
// already carry (e.g. left over from an earlier, unrelated capture) —
// the response must never echo it, same as it must never echo BASE32_SEED.
const PRIOR_NONCE = 'stale-prior-nonce-should-never-leak';
const SET_ATTR_PAGE = dataUrl(
  '<title>Split box</title><h1>Backup codes</h1>' +
  `<code id="secret" data-sen-secret>${BASE32_SEED}</code>` +
  `<input id="box0" data-sen-nonce="${PRIOR_NONCE}">` +
  '<span id="plain">unmarked control element</span>'
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

// A plain password and a plain 6-digit one-time code, neither shaped like
// any pattern credential-guard.js knows. Each field's change handler mirrors
// .value into both the `value` attribute and a `data-initial-value`
// attribute -- an as-you-type-validation pattern real login/2FA forms use.
// Submitting the form (never actually navigates: the handler calls
// preventDefault) proves the live fields still hold what was typed after
// auto-capture has run against them repeatedly.
//
// Scope note (round 2 / jc review): "no capture file... containing either
// value" below means the .html/.md/-diff.txt text artifacts. The OTP field
// is type="text" (one-time codes are meant to be visible), so the digits
// the user typed are visible pixels in the .png screenshots these same
// actions write -- screenshots aren't string-scrubbed, and were never
// claimed to be. Only the password field (type="password") is masked in
// its own screenshot by the browser's own rendering.
const PLAIN_PASSWORD = 'Correct-Horse-Battery42';
const PLAIN_OTP = '654321';
const SECRET_FORM_PAGE = dataUrl(
  '<title>Sign in</title>' +
  '<form id="frm">' +
  '<input id="pw" type="password">' +
  '<input id="otp" type="text" autocomplete="one-time-code">' +
  '<button id="submitBtn" type="submit">Submit</button>' +
  '</form>' +
  '<script>' +
  "function mirror(e) { e.target.setAttribute('data-initial-value', e.target.value); e.target.setAttribute('value', e.target.value); }" +
  "document.getElementById('pw').addEventListener('input', mirror);" +
  "document.getElementById('otp').addEventListener('input', mirror);" +
  // The submit handler reads .value into a JS variable, never into the DOM
  // (a visible "you submitted: ..." div would be an unrelated leak path --
  // plain page TEXT the existing shape-based guard was never meant to catch
  // -- and isn't what this fix is about). Keeping it JS-only means the only
  // question this page can test is whether the live fields still hold what
  // was typed, and whether the submit handler still reads it correctly.
  "document.getElementById('frm').addEventListener('submit', function(e) {" +
  "  e.preventDefault();" +
  "  window.__submitted = document.getElementById('pw').value + ':' + document.getElementById('otp').value;" +
  "});" +
  '</script>'
);

// Round 2 (jc review) coverage gaps: a password field toggled to show its
// value (type switched from password to text), a mixed-case multi-token
// autocomplete value, and a hidden mirror input that carries the secret in
// an attribute the visible field never has itself.
const PLAIN_PASSWORD2 = 'sw0rdfish-42-Xyz';
const PLAIN_OTP2 = '111222';
const ROUND2_FORM_PAGE = dataUrl(
  '<title>Sign in (round 2)</title>' +
  '<input id="pw2" type="password">' +
  '<input id="pw2Mirror" type="hidden">' +
  '<button id="toggle2" type="button">Show password</button>' +
  // Mixed case, multi-token autocomplete value (a real-world "section-2fa
  // one-time-code" style value), deliberately spelled with mixed case.
  '<input id="otp2" type="text" autocomplete="Section-2FA One-Time-Code">' +
  '<script>' +
  // The hidden mirror has no type=password, no sensitive autocomplete, and
  // no data-sen-secret marker of its own -- only value-based redaction can
  // catch it.
  "document.getElementById('pw2').addEventListener('input', e => " +
  "document.getElementById('pw2Mirror').setAttribute('value', e.target.value));" +
  // "Show password" toggle: flips type to text, and (like many real
  // implementations) also mirrors the value into a non-data-* attribute
  // once revealed, so attribute-based scrubbing keyed on the ORIGINAL
  // type=password selector can't reach it either.
  "document.getElementById('toggle2').addEventListener('click', () => {" +
  "  const pw2 = document.getElementById('pw2');" +
  "  pw2.type = (pw2.type === 'password') ? 'text' : 'password';" +
  "  pw2.setAttribute('title', pw2.value);" +
  '});' +
  "document.getElementById('otp2').addEventListener('input', e => " +
  "e.target.setAttribute('data-initial-value', e.target.value));" +
  '</script>'
);

// Round 3 (jc review) findings: no minimum length for value-redaction
// (short values mangle unrelated markup), entity-escaped values slip
// through, and the .md artifact is generated straight from the live DOM
// so a value echoed into visible text reached it unredacted.
const PLAIN_SHORT3 = '12';
const PLAIN_PASSWORD3 = 'Sup3r&Secret"Pw';
const PLAIN_OTP3 = '987654';
const ROUND3_FORM_PAGE = dataUrl(
  '<title>Checkout 1</title>' +
  '<h1>Order 100</h1>' +
  '<p id="totalText">Total: $12.00</p>' +
  '<div id="box" style="width:100px"></div>' +
  // A short value (standing in for a cc-exp-month/cc-exp-year/split-OTP-
  // digit field): must not be substring-redacted across the whole page,
  // which would mangle the title/heading/price/style above (all of which
  // merely happen to contain the same short digits).
  '<input id="short3" type="password">' +
  // A password containing & and ", mirrored into a hidden input's
  // `value` attribute -- outerHTML entity-escapes that attribute, so the
  // literal value never appears verbatim in the serialized HTML.
  '<input id="pw3" type="password">' +
  '<input id="pw3Mirror" type="hidden">' +
  // A one-time code whose value gets echoed into ordinary page TEXT
  // (a "verifying..." status message) -- the kind of thing the markdown
  // extractor picks up directly from the live DOM, never through the
  // HTML clone/scrub.
  '<input id="otp3" type="text" autocomplete="one-time-code">' +
  '<p id="echoP"></p>' +
  '<script>' +
  "document.getElementById('pw3').addEventListener('input', e => " +
  "document.getElementById('pw3Mirror').setAttribute('value', e.target.value));" +
  "document.getElementById('otp3').addEventListener('input', e => " +
  "document.getElementById('echoP').textContent = 'Verifying code ' + e.target.value);" +
  '</script>'
);

// A page whose <img> increments a counter every time its onerror handler
// fires. The src is a data: URI that is not valid image data, so the
// browser always fails to decode it and fires onerror -- no network wait.
const IMG_ERROR_PROBE_PAGE = dataUrl(
  '<title>Img probe</title>' +
  '<img src="data:image/png;base64,not-a-real-image" ' +
  'onerror="window.__senImgErrorCount = (window.__senImgErrorCount || 0) + 1">' +
  '<button id="b">Go</button>'
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

  // PRI-3360 round 3 (Reeve) briefly made whole-page extract('text')/eval
  // refuse OUTRIGHT on a page showing a credential-shaped token, via
  // sensitive-url.js's pageTextReadRefused. Round 4 (jc + Reeve's final
  // design) removed that again: TOKEN_PAGE's URL is a data: URL (NEVER
  // matched by urlLooksSensitive), so this page is "unlisted" the same
  // way Slack's own token-types docs page is (see
  // test/credential-guard-mcp.test.mjs's "Slack's token-types docs page"
  // suite) -- eval/extract run normally here again, same as before
  // PRI-3360 existed at all, with response-format.ts's own, separate,
  // unconditional redactCredentialShaped pass still masking the token in
  // whatever text reaches the agent. The "blind" length-only query
  // correctly still works too: it returns a NUMBER, never subject to any
  // string-shape check.
  it('extract/eval RUN on a page showing a credential-shaped token (unlisted URL), with the result text redacted', async () => {
    // NOT assertNoLeak here -- that helper also checks the page HEADING
    // text is absent, which was correct for the old fully-suppressed
    // behavior but is no longer the right check: this page's ordinary
    // prose (including its heading) legitimately reaches the agent now
    // that eval/extract run; only the TOKEN itself has to be absent.
    function assertTokenRedacted(text) {
      assert.ok(!text.includes(FAKE_TOKEN), `token leaked into tool result:\n${text}`);
      assert.ok(!text.includes('FAKEfake'), `token fragment leaked into tool result:\n${text}`);
    }

    const extracted = await server.call({ action: 'extract', payload: 'text' });
    assert.equal(extracted.isError, false, extracted.text);
    assert.ok(extracted.text.includes(REDACTION), extracted.text);
    assertTokenRedacted(extracted.text);

    const html = await server.call({ action: 'extract', payload: 'html' });
    assert.equal(html.isError, false, html.text);
    assertTokenRedacted(html.text);

    const leaked = await server.call({ action: 'eval', payload: "document.getElementById('tok').textContent" });
    assert.equal(leaked.isError, false, leaked.text);
    assert.ok(leaked.text.includes(`Result: ${REDACTION}`), leaked.text);
    assertTokenRedacted(leaked.text);

    // A number is never subject to any string-shape check (rules 1/2/3/4
    // all operate on strings only) -- this still reveals the token's
    // LENGTH even though its VALUE is redacted everywhere else.
    const blind = await server.call({ action: 'eval', payload: "document.getElementById('tok').textContent.length" });
    assert.equal(blind.isError, false, blind.text);
    assert.ok(blind.text.includes(`Result: ${FAKE_TOKEN.length}`), blind.text);

    const button = await server.call({ action: 'extract', selector: '#b', payload: 'text' });
    assert.equal(button.isError, false, button.text);
    assert.equal(button.text, 'Done');
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

// The data-sen-secret marker with content that matches no TOKEN_PATTERNS
// (a bare base32 seed): eval, extract and attr must refuse it, the same as
// screenshot/capture.
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

  // Two explicit cases: a caller doesn't have to name the marked element
  // to pull its value out of the page.
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

  it('extract html (selector form) strips the marked element and keeps the control element', async () => {
    const wrap = await server.call({ action: 'extract', selector: '#wrap', payload: 'html' });
    assert.equal(wrap.isError, false, wrap.text);
    assert.ok(!wrap.text.includes(BASE32_SEED), wrap.text);
    assert.ok(!wrap.text.includes('data-sen-secret'), wrap.text);
    assert.ok(wrap.text.includes(CONTROL_VALUE), wrap.text);
  });

  // PRI-3360: a WHOLE-PAGE extract (no selector) now refuses outright the
  // moment ANY marker is present anywhere on the page, rather than
  // stripping the marked subtree and returning the rest -- see
  // sensitive-url.js's pageTextReadRefused. The element-SCOPED form above
  // (a real selector, `#wrap`) is unaffected: it still strips and returns.
  it('extract html (whole page, no selector) refuses outright when a marker is present anywhere on the page', async () => {
    const whole = await server.call({ action: 'extract', payload: 'html' });
    assert.equal(whole.isError, true, whole.text);
    assert.match(whole.text, /extract refused/);
    assert.match(whole.text, /data-sen-secret/);
    assert.ok(!whole.text.includes(BASE32_SEED), whole.text);
  });

  it('extract markdown (whole page) refuses outright when a marker is present anywhere on the page', async () => {
    const { text, isError } = await server.call({ action: 'extract', payload: 'markdown' });
    assert.equal(isError, true, text);
    assert.match(text, /extract refused/);
    assert.match(text, /data-sen-secret/);
    assert.ok(!text.includes(BASE32_SEED), text);
  });

  // Stripping marked DESCENDANTS of <body>
  // leaves the seed in place when <body> itself carries the marker, so
  // whole-page extraction has to check the root too. markdown and text
  // refuse; html clones documentElement, where <body> is an ordinary
  // marked descendant and is stripped like any other.
  for (const format of ['markdown', 'text']) {
    it(`whole-page extract ${format} refuses when <body> itself carries the marker`, async () => {
      await server.call({ action: 'navigate', payload: MARKER_BODY_PAGE });
      const { text, isError } = await server.call({ action: 'extract', payload: format });
      assert.equal(isError, true, text);
      assert.match(text, /extract refused.*data-sen-secret/i);
      assert.ok(!text.includes(BASE32_SEED), text);
    });
  }

  // PRI-3360: same behavior change as the html/markdown tests above --
  // whole-page html now refuses outright on ANY marker, including one on
  // <body> itself, rather than stripping it and returning the rest.
  it('whole-page extract html refuses outright when <body> itself carries the marker', async () => {
    await server.call({ action: 'navigate', payload: MARKER_BODY_PAGE });
    const { text, isError } = await server.call({ action: 'extract', payload: 'html' });
    assert.equal(isError, true, text);
    assert.match(text, /extract refused/);
    assert.match(text, /data-sen-secret/);
    assert.ok(!text.includes(BASE32_SEED), text);
  });

  // On a marked page, the suppression notice and the screenshot refusal
  // must not recommend eval for value-blind queries, since the very next
  // eval there is refused.
  it('the suppression notice and screenshot refusal on a marked page say eval refuses there', async () => {
    const nav = await server.call({ action: 'navigate', payload: MARKER_TEXT_PAGE });
    assert.ok(nav.text.includes(NOTICE), nav.text);
    assert.match(nav.text, /eval refuses while any element is marked data-sen-secret/, nav.text);

    const shot = await server.call({ action: 'screenshot', payload: path.join(server.xdg, 'marked.png') });
    assert.equal(shot.isError, true, shot.text);
    assert.match(shot.text, /eval refuses while any element is marked data-sen-secret/, shot.text);
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

// set_attr is the write-only escape hatch from eval's page-wide
// fail-closed refusal, so that an agent entering a split-digit one-time
// code can stamp a broker nonce onto an unmarked digit-input box right
// after capturing a seed on the same (now marked) page. See
// skills/browsing/lib/set-attribute.js for the design.
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

  // set_attr is the write path for the marker itself (see
  // set-attribute.js's module doc). These are the two cases its
  // documented contract specifies -- marking an unmarked element
  // succeeds, and re-marking an already-marked one is a no-op, not a
  // refusal --
  // using #plain and #secret (NOT #box0, which later tests in this
  // describe block still need to be an ordinary data-sen-nonce target).
  it('(c) name=data-sen-secret marks a previously-unmarked element', async () => {
    const { text, isError } = await server.call({
      action: 'set_attr',
      selector: '#plain',
      payload: { name: 'data-sen-secret', value: '' },
    });
    assert.equal(isError, false, text);
    const marked = await readLiveValueDirectly(server.port, "document.getElementById('plain').hasAttribute('data-sen-secret')");
    assert.equal(marked, true);
  });

  it('(c) name=data-sen-secret re-marking an already-marked element (#secret) is a no-op, not a refusal', async () => {
    const { text, isError } = await server.call({
      action: 'set_attr',
      selector: '#secret',
      payload: { name: 'data-sen-secret', value: '' },
    });
    assert.equal(isError, false, text);
    assert.ok(!text.includes(BASE32_SEED), text);
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

// extract markdown's whole-page path runs against an inert clone
// (document.implementation.createHTMLDocument -- see __senInertClone in
// secret-marker.js), so cloned <img> elements never fire onload/onerror.
// That clone's OWN document has an about:blank URL, so `el.href` (the
// resolved DOM property) would resolve a relative link against
// about:blank instead of the real page, silently turning
// '/relative/path' into an unresolved relative string instead of an
// absolute URL -- on every ordinary, unmarked page, not just marked ones.
// Not credential-guard-specific, but it exercises the same inert-clone
// path as the marker tests in this file.
describe('extract markdown resolves relative href against the live page (real Chrome)', { skip: !CHROME_AVAILABLE && 'Chrome not installed' }, () => {
  let server;
  let dir;

  before(async () => {
    server = await startServer();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'href-regress-'));
    const file = path.join(dir, 'page.html');
    fs.writeFileSync(file, '<title>Href page</title><a href="/relative/path">Link text</a><a href="">Empty link</a>');
    await server.call({ action: 'navigate', payload: `file://${file}` });
  });
  after(async () => {
    await server?.stop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves a relative href to an absolute URL instead of leaving it unresolved', async () => {
    const { text, isError } = await server.call({ action: 'extract', payload: 'markdown' });
    assert.equal(isError, false, text);
    assert.match(text, /\[Link text\]\(file:\/\/\/relative\/path\)/, text);
    assert.ok(!text.includes('(/relative/path)'), `href must not be left unresolved: ${text}`);
  });

  it('resolves an empty href to the page URL, the way el.href does', async () => {
    const { text, isError } = await server.call({ action: 'extract', payload: 'markdown' });
    assert.equal(isError, false, text);
    const pageUrl = `file://${path.join(dir, 'page.html')}`;
    assert.ok(text.includes(`[Empty link](${pageUrl})`), text);
  });
});

// The live marker scan (HAS_SECRET_MARKER_SCRIPT) must descend into
// same-origin OBJECT and EMBED as well as IFRAME/FRAME: the top frame can
// read their embedded documents directly, so a marker there has to reach
// eval's point check AND the screenshot/capture guard.
//
// In Chrome, OBJECT gets a contentDocument for both text/html and SVG;
// EMBED gets none, and getSVGDocument() only covers SVG. A same-origin
// EMBED of text/html is reachable only through window.frames, so each
// tag/content-type pair gets its own page here: a shared page would let
// one tag's scan mask a gap in the other's.
//
// Real file:// pages (not data: URLs -- object/embed same-origin access
// needs a real hierarchical origin), with --allow-file-access-from-files
// so a file:// page can load a file:// subresource at all.
describe('eval and screenshot see a marker inside a same-origin OBJECT/EMBED (real Chrome)', { skip: !CHROME_AVAILABLE && 'Chrome not installed' }, () => {
  let server;
  let dir;
  const EMBED_PAGES = {
    'OBJECT text/html': '<object type="text/html" data="inner.html" width="50" height="50"></object>',
    'EMBED text/html': '<embed type="text/html" src="inner.html" width="50" height="50">',
    'OBJECT SVG': '<object type="image/svg+xml" data="inner.svg" width="50" height="50"></object>',
    'EMBED SVG': '<embed type="image/svg+xml" src="inner.svg" width="50" height="50">',
  };

  before(async () => {
    server = await startServer({ CHROME_EXTRA_ARGS: '--allow-file-access-from-files' });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'object-embed-'));
    fs.writeFileSync(
      path.join(dir, 'inner.svg'),
      `<svg xmlns="http://www.w3.org/2000/svg"><text data-sen-secret="">${BASE32_SEED}</text></svg>`
    );
    fs.writeFileSync(path.join(dir, 'inner.html'), `<p data-sen-secret>${BASE32_SEED}</p>`);
  });
  after(async () => {
    await server?.stop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  for (const [label, tag] of Object.entries(EMBED_PAGES)) {
    const file = `${label.replace(/\W+/g, '-')}.html`;

    it(`${label}: eval refuses although the top document has no marker itself`, async () => {
      fs.writeFileSync(path.join(dir, file), `<title>${label}</title>${tag}`);
      await server.call({ action: 'navigate', payload: `file://${path.join(dir, file)}` });
      const { text, isError } = await server.call({ action: 'eval', payload: '1 + 1' });
      assert.equal(isError, true, text);
      assert.match(text, /eval refused.*data-sen-secret/i);
      assert.ok(!text.includes(BASE32_SEED), text);
    });

    it(`${label}: screenshot refuses and writes no file`, async () => {
      const shot = path.join(server.xdg, `${file}.png`);
      const { text, isError } = await server.call({ action: 'screenshot', payload: shot });
      assert.equal(isError, true, text);
      assert.match(text, /screenshot refused/i);
      assert.equal(fs.existsSync(shot), false);
    });
  }
});

describe('password and one-time-code fields mirrored into attributes (real Chrome)', { skip: !CHROME_AVAILABLE && 'Chrome not installed' }, () => {
  let server;
  before(async () => { server = await startServer(); });
  after(async () => { await server?.stop(); });

  // .html, .md and -diff.txt are the text artifacts the scrub actually
  // covers (see the scope note above); .png is deliberately excluded.
  // Round 2 / jc review: the previous version of this helper only checked
  // .html/.md, so -diff.txt -- one of the three artifact kinds the fix
  // changes (see capturePageArtifacts's before/after diff path in
  // capture.js) -- was never actually exercised by this test.
  function textCaptureFiles() {
    return server.capturedFiles().filter(
      (f) => f.endsWith('.html') || f.endsWith('.md') || f.endsWith('-diff.txt')
    );
  }

  it('never writes the mirrored value to disk, and the live fields (and form submission) still see it', async () => {
    await server.call({ action: 'navigate', payload: SECRET_FORM_PAGE });

    await server.call({ action: 'type', selector: '#pw', payload: PLAIN_PASSWORD });
    await server.call({ action: 'type', selector: '#otp', payload: PLAIN_OTP });

    // Neither the password's nor the one-time code's mirrored attribute
    // copy may have reached any capture file written so far.
    const files = textCaptureFiles();
    assert.ok(files.length > 0, 'expected some capture files to have been written');
    for (const file of files) {
      const written = fs.readFileSync(file, 'utf8');
      assert.ok(!written.includes(PLAIN_PASSWORD), `password leaked into ${file}:\n${written}`);
      assert.ok(!written.includes(PLAIN_OTP), `one-time code leaked into ${file}:\n${written}`);
    }

    // The live page must be untouched: the clone-based scrub never mutates
    // the real DOM, so the fields still hold what was typed.
    const pwLive = await server.call({ action: 'eval', payload: "document.getElementById('pw').value" });
    assert.match(pwLive.text, new RegExp(PLAIN_PASSWORD), pwLive.text);
    const otpLive = await server.call({ action: 'eval', payload: "document.getElementById('otp').value" });
    assert.match(otpLive.text, new RegExp(PLAIN_OTP), otpLive.text);

    // ... and the form still submits with the right values, proving the
    // fields the browser actually uses were never swapped for the clone.
    await server.call({ action: 'click', selector: '#submitBtn' });
    const submitted = await server.call({ action: 'eval', payload: 'window.__submitted' });
    assert.match(submitted.text, new RegExp(`${PLAIN_PASSWORD}:${PLAIN_OTP}`), submitted.text);

    // Re-check every capture file written by the whole sequence (including
    // the eval and click actions above, each of which auto-captures too).
    for (const file of textCaptureFiles()) {
      const written = fs.readFileSync(file, 'utf8');
      assert.ok(!written.includes(PLAIN_PASSWORD), `password leaked into ${file}:\n${written}`);
      assert.ok(!written.includes(PLAIN_OTP), `one-time code leaked into ${file}:\n${written}`);
    }
  });
});

describe('round 2 coverage gaps: show-password toggle and hidden mirror (real Chrome)', { skip: !CHROME_AVAILABLE && 'Chrome not installed' }, () => {
  let server;
  before(async () => { server = await startServer(); });
  after(async () => { await server?.stop(); });

  function textCaptureFiles() {
    return server.capturedFiles().filter(
      (f) => f.endsWith('.html') || f.endsWith('.md') || f.endsWith('-diff.txt')
    );
  }

  it('keeps redacting after a show-password toggle, a hidden mirror input, and a mixed-case multi-token autocomplete value', async () => {
    await server.call({ action: 'navigate', payload: ROUND2_FORM_PAGE });

    await server.call({ action: 'type', selector: '#pw2', payload: PLAIN_PASSWORD2 });
    await server.call({ action: 'type', selector: '#otp2', payload: PLAIN_OTP2 });

    // Nothing leaked yet, from the password (mirrored into a hidden input)
    // or the mixed-case-multi-token-autocomplete OTP field.
    let files = textCaptureFiles();
    assert.ok(files.length > 0, 'expected some capture files to have been written');
    for (const file of files) {
      const written = fs.readFileSync(file, 'utf8');
      assert.ok(!written.includes(PLAIN_PASSWORD2), `password leaked into ${file} (pre-toggle):\n${written}`);
      assert.ok(!written.includes(PLAIN_OTP2), `one-time code leaked into ${file}:\n${written}`);
    }

    // Show-password toggle: flips #pw2's type to text, and mirrors the
    // value into its `title` attribute -- neither of which a scrub keyed
    // only on the *current* type=password selector would catch.
    await server.call({ action: 'click', selector: '#toggle2' });

    const typeAfterToggle = await server.call({ action: 'eval', payload: "document.getElementById('pw2').type" });
    assert.match(typeAfterToggle.text, /text/, typeAfterToggle.text);

    files = textCaptureFiles();
    assert.ok(files.length > 0, 'expected capture files after the toggle click');
    for (const file of files) {
      const written = fs.readFileSync(file, 'utf8');
      assert.ok(!written.includes(PLAIN_PASSWORD2), `password leaked into ${file} (post-toggle):\n${written}`);
    }

    // The live fields (and the hidden mirror, and the revealed title
    // attribute) still hold the real values -- the scrub never touches
    // the live document.
    const pwLive = await server.call({ action: 'eval', payload: "document.getElementById('pw2').value" });
    assert.match(pwLive.text, new RegExp(PLAIN_PASSWORD2), pwLive.text);
    const mirrorLive = await server.call({ action: 'eval', payload: "document.getElementById('pw2Mirror').value" });
    assert.match(mirrorLive.text, new RegExp(PLAIN_PASSWORD2), mirrorLive.text);
    const titleLive = await server.call({ action: 'eval', payload: "document.getElementById('pw2').title" });
    assert.match(titleLive.text, new RegExp(PLAIN_PASSWORD2), titleLive.text);

    // One more action after the toggle, to prove the redaction keeps
    // working (via the WeakSet tag), not just on the single capture that
    // happened to run while the field was still type=password.
    await server.call({ action: 'eval', payload: '1 + 1' });
    for (const file of textCaptureFiles()) {
      const written = fs.readFileSync(file, 'utf8');
      assert.ok(!written.includes(PLAIN_PASSWORD2), `password leaked into ${file} (final check):\n${written}`);
    }
  });
});

describe('round 3 coverage gaps: length floor, entity escaping, markdown redaction (real Chrome)', { skip: !CHROME_AVAILABLE && 'Chrome not installed' }, () => {
  let server;
  before(async () => { server = await startServer(); });
  after(async () => { await server?.stop(); });

  function textCaptureFiles() {
    return server.capturedFiles().filter(
      (f) => f.endsWith('.html') || f.endsWith('.md') || f.endsWith('-diff.txt')
    );
  }

  it('does not mangle unrelated short markup when a short value is typed into a sensitive field (jc round 2, finding 1)', async () => {
    await server.call({ action: 'navigate', payload: ROUND3_FORM_PAGE });
    await server.call({ action: 'type', selector: '#short3', payload: PLAIN_SHORT3 });

    const files = textCaptureFiles();
    assert.ok(files.length > 0, 'expected some capture files to have been written');
    for (const file of files) {
      const written = fs.readFileSync(file, 'utf8');
      if (file.endsWith('.html')) {
        assert.ok(written.includes('Checkout 1'), `title mangled in ${file}:\n${written}`);
        assert.ok(written.includes('Order 100'), `heading mangled in ${file}:\n${written}`);
        assert.ok(written.includes('Total: $12.00'), `price mangled in ${file}:\n${written}`);
        assert.ok(written.includes('width:100px'), `style mangled in ${file}:\n${written}`);
      }
    }
  });

  it('redacts a password mirrored into an attribute even when & and " force an HTML-entity-escaped form (jc round 2, finding 2)', async () => {
    await server.call({ action: 'navigate', payload: ROUND3_FORM_PAGE });
    await server.call({ action: 'type', selector: '#pw3', payload: PLAIN_PASSWORD3 });

    const files = textCaptureFiles();
    assert.ok(files.length > 0, 'expected some capture files to have been written');
    for (const file of files) {
      const written = fs.readFileSync(file, 'utf8');
      assert.ok(!written.includes('Sup3r'), `password leaked into ${file}:\n${written}`);
      assert.ok(!written.includes('Secret'), `password leaked into ${file}:\n${written}`);
    }
  });

  it('redacts a one-time code echoed into page text from the .md artifact, not just .html (jc round 2, finding 3)', async () => {
    await server.call({ action: 'navigate', payload: ROUND3_FORM_PAGE });
    await server.call({ action: 'type', selector: '#otp3', payload: PLAIN_OTP3 });

    const mdFiles = server.capturedFiles().filter((f) => f.endsWith('.md'));
    assert.ok(mdFiles.length > 0, 'expected some .md files to have been written');
    for (const file of mdFiles) {
      const written = fs.readFileSync(file, 'utf8');
      assert.ok(!written.includes(PLAIN_OTP3), `one-time code leaked into ${file}:\n${written}`);
    }
    // The same echo also reaches the .html text content (not just an
    // attribute), which the value-based redaction pass over the whole
    // serialized string already covers -- confirms the .md gap isn't
    // just the .html fix leaking through by coincidence.
    const htmlFiles = server.capturedFiles().filter((f) => f.endsWith('.html'));
    for (const file of htmlFiles) {
      const written = fs.readFileSync(file, 'utf8');
      assert.ok(!written.includes(PLAIN_OTP3), `one-time code leaked into ${file}:\n${written}`);
    }
  });
});

describe('the scrub never re-fires page handlers or reloads resources (real Chrome)', { skip: !CHROME_AVAILABLE && 'Chrome not installed' }, () => {
  let server;
  before(async () => { server = await startServer(); });
  after(async () => { await server?.stop(); });

  it('does not increment an <img> onerror counter across repeated auto-captures', async () => {
    // Regression guard for the obra#52 pattern: a live-document
    // cloneNode(true) still runs the image-loading algorithm for a cloned
    // <img> (gated on "fully active", which a same-document clone still
    // is), so every auto-capture re-fires onload/onerror. An inert clone
    // via document.implementation.createHTMLDocument never does.
    await server.call({ action: 'navigate', payload: IMG_ERROR_PROBE_PAGE });

    const afterNavigate = await server.call({ action: 'eval', payload: 'window.__senImgErrorCount' });
    const countAfterNavigate = Number(afterNavigate.text.match(/\d+/)?.[0]);
    assert.ok(countAfterNavigate >= 1, `expected the broken image to have failed at least once: ${afterNavigate.text}`);

    // Every one of these drives at least one auto-capture (getHtmlWithScrub
    // runs on each). If the clone ever re-attached to (or re-ran image
    // loading within) the live document, the counter would climb.
    await server.call({ action: 'click', selector: '#b' });
    await server.call({ action: 'eval', payload: '1 + 1' });
    await server.call({ action: 'click', selector: '#b' });

    const final = await server.call({ action: 'eval', payload: 'window.__senImgErrorCount' });
    const finalCount = Number(final.text.match(/\d+/)?.[0]);
    assert.equal(finalCount, countAfterNavigate, 'the image error handler must not re-fire on auto-capture');
  });
});

// Default secret-pattern detection (real Chrome): Slack's real case,
// loaded via navigate -- the very first auto-capture, before any click or
// marking is possible. The seed must appear in NO artifact at all, text
// or binary -- every file in the session dir, not just .html/.md.
describe('default secret-pattern detection: hidden #init_key_code at page load (real Chrome)', { skip: !CHROME_AVAILABLE && 'Chrome not installed' }, () => {
  let server;
  before(async () => { server = await startServer(); });
  after(async () => { await server?.stop(); });

  it('never writes the seed to any capture artifact from the first navigate onward', async () => {
    await server.call({ action: 'navigate', payload: INIT_KEY_CODE_PAGE });

    const files = server.capturedFiles();
    assert.ok(files.length > 0, 'expected some capture files to have been written');
    for (const file of files) {
      const written = fs.readFileSync(file);
      assert.ok(
        !written.includes(Buffer.from(BASE32_SEED)),
        `seed leaked into ${file}`
      );
    }

    // A further action (click) must keep it that way too, not just the
    // first navigate.
    await server.call({ action: 'click', selector: '#b' });
    for (const file of server.capturedFiles()) {
      const written = fs.readFileSync(file);
      assert.ok(!written.includes(Buffer.from(BASE32_SEED)), `seed leaked into ${file}`);
    }
  });
});

// URL-based suppression (sensitive-url.js, real Chrome): a page at a
// known-sensitive URL path is suppressed outright -- html/md and the
// screenshot -- regardless of its markup. Uses file:// URLs (data: URLs
// have no meaningful path) with a directory name matching the pattern
// list, the same way a real site's path would.
describe('URL-pattern suppression (sensitive-url.js, real Chrome)', { skip: !CHROME_AVAILABLE && 'Chrome not installed' }, () => {
  let server;
  let dir;
  before(async () => {
    server = await startServer();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sensitive-url-'));
    fs.mkdirSync(path.join(dir, 'account', 'settings', '2fa_app'), { recursive: true });
    // Ordinary markup, no token shape, no secret-pattern id/name/class --
    // isolates the URL check from the other two detectors.
    fs.writeFileSync(
      path.join(dir, 'account', 'settings', '2fa_app', 'index.html'),
      `<title>Set up two-step verification</title><h1>Scan this QR code</h1><p>${BASE32_SEED}</p>` +
      '<button id="b">Done</button>'
    );
  });
  after(async () => {
    await server?.stop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('suppresses html/md and the screenshot for a known-sensitive URL path, even with ordinary markup', async () => {
    const { text } = await server.call({
      action: 'navigate',
      payload: `file://${path.join(dir, 'account', 'settings', '2fa_app', 'index.html')}`,
    });
    assert.match(text, /known-sensitive pattern/);
    assert.doesNotMatch(text, new RegExp(BASE32_SEED));

    const files = server.capturedFiles();
    for (const file of files) {
      assert.ok(!file.endsWith('.png'), `no screenshot may be taken for a sensitive URL: ${file}`);
      const written = fs.readFileSync(file);
      assert.ok(!written.includes(Buffer.from(BASE32_SEED)), `seed leaked into ${file}`);
    }
  });

  // Round 4 (jc finding 6): an explicit `screenshot` action refused
  // because of URL suppression must say so, not the generic
  // credential-shape message -- the two reasons have different remedies
  // (SENSITIVE_URL_PATTERNS/ALLOW_CREDENTIAL_CAPTURE vs. the credential
  // broker advice).
  it('an explicit screenshot action on the same sensitive URL reports the URL-specific reason, not "credential-shaped content"', async () => {
    await server.call({
      action: 'navigate',
      payload: `file://${path.join(dir, 'account', 'settings', '2fa_app', 'index.html')}`,
    });
    const shot = path.join(server.xdg, 'explicit-sensitive-url.png');
    const { text, isError } = await server.call({ action: 'screenshot', payload: shot });
    assert.equal(isError, true, text);
    assert.match(text, /screenshot refused/i);
    assert.match(text, /known-sensitive pattern/i, `wrong refusal reason: ${text}`);
    assert.doesNotMatch(text, /credential-shaped content/i, `wrong refusal reason: ${text}`);
    assert.equal(fs.existsSync(shot), false);
  });
});

// PRI-3360: gate the explicit, caller-requested readers (eval/extract/attr)
// on a sensitive page the same way auto-capture/screenshot already are.
// Real incident this fixes: a worker's eval/extract read backup codes off
// a 2FA settings page into its own transcript, before the value was ever
// captured through the credential broker. Fixture codes below are
// obviously fake and have no real-world validity.
const FAKE_SESSION_TOKEN = 'sess_8f3k9d2mq7h1x0p4rr3ezz913bqa';
const FAKE_BACKUP_CODES = ['7f3k-9d2m', 'a83f-29dk', 'qq1z-88mn', 'x0p4-rr3e', '8k2j-m9vd', 'zz91-3bqa'];
// PRI-3360 round 4 (jc's rule): the SAME seed as BASE32_SEED above, split
// into 4-char groups with spaces -- jc's own "deliberately split to dodge
// a naive scan" test case. hasLongMixedAlnumRun strips ALL whitespace
// before scanning specifically to glue groups like this back together.
const BASE32_SEED_SPACED = 'JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP';
const FAKE_APP_TOKEN = ['xapp', '1', 'A01234ABCD', 'FAKEfakeFAKEfakeFAKEfakeFAKEfake'].join('-');

describe('PRI-3360: whole-page text reads refused on a sensitive page (real Chrome)', {
  skip: !CHROME_AVAILABLE && 'Chrome not installed',
}, () => {
  let server;
  let dir;
  before(async () => {
    server = await startServer();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pri-3360-'));
    fs.mkdirSync(path.join(dir, 'account', 'settings', '2fa_app'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'account', 'settings', '2fa_app', 'index.html'),
      '<title>Session page</title><h1>Signed in</h1>' +
      `<div id="tok">${FAKE_SESSION_TOKEN}</div>` +
      '<button id="b">Done</button>'
    );
    fs.mkdirSync(path.join(dir, 'account', 'recovery-codes'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'account', 'recovery-codes', 'index.html'),
      '<title>Backup codes</title><h1>Save these backup codes</h1>' +
      `<ul id="codes">${FAKE_BACKUP_CODES.map((c) => `<li>${c}</li>`).join('\n')}</ul>` +
      '<button id="b">Done</button>'
    );
    // PRI-3360 round 4 (jc + Reeve's final design): a TOTP setup page,
    // same /2fa_app sensitive route as SESSION_URL above, with a bare
    // base32 seed (rule 4, mixed), a harmless data-qa identifier that
    // must NOT false-positive (letters only, no digit at all), a SECOND
    // harmless data-qa identifier that is Slack's own real shape for the
    // App-Level Tokens row (an all-digit suffix, round 5's own must-allow
    // case), and an app-level-token-shaped field (rules 1/2) for Reeve's
    // truncation case.
    fs.mkdirSync(path.join(dir, 'account', 'settings', '2fa_app', 'totp'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'account', 'settings', '2fa_app', 'totp', 'index.html'),
      '<title>Set up two-factor authentication</title><h1>Scan this QR code</h1>' +
      `<span id="seed">${BASE32_SEED}</span>` +
      `<span id="spacedSeed">${BASE32_SEED_SPACED}</span>` +
      '<button id="qa" data-qa="app_level_token_string">Continue</button>' +
      '<button id="qaRow" data-qa="app_level_tokens_row_12277846587778">Row</button>' +
      `<input id="el" type="text" value="${FAKE_APP_TOKEN}">` +
      '<button id="b">Done</button>'
    );
  });
  after(async () => {
    await server?.stop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const SESSION_URL = () => `file://${path.join(dir, 'account', 'settings', '2fa_app', 'index.html')}`;
  const BACKUP_CODES_URL = () => `file://${path.join(dir, 'account', 'recovery-codes', 'index.html')}`;
  const TOTP_URL = () => `file://${path.join(dir, 'account', 'settings', '2fa_app', 'totp', 'index.html')}`;

  // PRI-3360 round 4 (jc + Reeve's final design): eval no longer refuses
  // up front merely because the URL is sensitive -- it RUNS, then the
  // RESULT is checked. This outerHTML read still refuses here, but now
  // because the RESULT (the session-token-like string, glued letters and
  // digits with no separator, 6+ chars, MIXING both) trips rule 4
  // (hasLongMixedAlnumRun) on the sensitive URL, not because of a
  // blanket pre-run block.
  it('an outerHTML eval on a sensitive URL is refused, because the result itself looks token-shaped', async () => {
    await server.call({ action: 'navigate', payload: SESSION_URL() });
    const { text, isError } = await server.call({
      action: 'eval',
      payload: 'document.documentElement.outerHTML',
    });
    assert.equal(isError, true, text);
    assert.match(text, /eval refused/);
    assert.match(text, /sensitive/i);
    assert.doesNotMatch(text, new RegExp(FAKE_SESSION_TOKEN), `token leaked into refusal text:\n${text}`);
  });

  it('extract (whole page, no selector) of a backup-codes page is refused, with no codes in the result', async () => {
    await server.call({ action: 'navigate', payload: BACKUP_CODES_URL() });
    const { text, isError } = await server.call({ action: 'extract', payload: 'text' });
    assert.equal(isError, true, text);
    assert.match(text, /extract refused/);
    for (const code of FAKE_BACKUP_CODES) {
      assert.doesNotMatch(text, new RegExp(code), `code leaked into refusal text:\n${text}`);
    }
  });

  it('the markdown whole-page extract on a sensitive URL is refused (the index.ts markdown branch -- no selector/HTML/text detour around it)', async () => {
    await server.call({ action: 'navigate', payload: BACKUP_CODES_URL() });
    const { text, isError } = await server.call({ action: 'extract', payload: 'markdown' });
    assert.equal(isError, true, text);
    assert.match(text, /extract refused/);
    for (const code of FAKE_BACKUP_CODES) {
      assert.doesNotMatch(text, new RegExp(code), `code leaked into refusal text:\n${text}`);
    }
  });

  it('an element read of a plain button label on the same sensitive URL still succeeds', async () => {
    await server.call({ action: 'navigate', payload: SESSION_URL() });
    const { text, isError } = await server.call({ action: 'extract', selector: '#b', payload: 'text' });
    assert.equal(isError, false, text);
    assert.equal(text, 'Done');
  });

  it('attr on a plain element on the same sensitive URL still succeeds', async () => {
    await server.call({ action: 'navigate', payload: SESSION_URL() });
    const { text, isError } = await server.call({ action: 'attr', selector: '#b', payload: 'id' });
    assert.equal(isError, false, text);
    assert.equal(text, 'b');
  });

  it('getSanitizedHtml (extract format=html) on body/html selectors is refused the same as no selector, on a sensitive URL', async () => {
    await server.call({ action: 'navigate', payload: SESSION_URL() });
    for (const selector of ['body', 'html']) {
      const { text, isError } = await server.call({ action: 'extract', selector, payload: 'html' });
      assert.equal(isError, true, `${selector}: ${text}`);
      assert.match(text, /extract refused/);
    }
  });

  // PRI-3360 round 4 (jc + Reeve's final design): eval's post-run result
  // check, on a real sensitive URL, real Chrome. See credential-guard.js's
  // stringLooksLikeSecret/valueLeaksSecret for the four rules.
  it('eval returning a bare base32 TOTP seed on a sensitive URL is refused (rule 4)', async () => {
    await server.call({ action: 'navigate', payload: TOTP_URL() });
    const { text, isError } = await server.call({ action: 'eval', payload: "document.getElementById('seed').textContent" });
    assert.equal(isError, true, text);
    assert.match(text, /eval refused/);
    assert.doesNotMatch(text, new RegExp(BASE32_SEED), `seed leaked into refusal text:\n${text}`);
  });

  it('eval returning the SAME seed deliberately split into spaced groups is refused too (rule 4, jc test case)', async () => {
    await server.call({ action: 'navigate', payload: TOTP_URL() });
    const { text, isError } = await server.call({ action: 'eval', payload: "document.getElementById('spacedSeed').textContent" });
    assert.equal(isError, true, text);
    assert.match(text, /eval refused/);
  });

  it('eval returning a number, a boolean, or undefined on this sensitive URL is allowed', async () => {
    await server.call({ action: 'navigate', payload: TOTP_URL() });

    const num = await server.call({ action: 'eval', payload: '3' });
    assert.equal(num.isError, false, num.text);
    assert.match(num.text, /Result: 3\b/);

    const bool = await server.call({ action: 'eval', payload: 'true' });
    assert.equal(bool.isError, false, bool.text);
    assert.match(bool.text, /Result: true\b/);

    const undef = await server.call({ action: 'eval', payload: 'undefined' });
    assert.equal(undef.isError, false, undef.text);
  });

  it('eval that dispatches a MouseEvent click on this sensitive URL is allowed', async () => {
    await server.call({ action: 'navigate', payload: TOTP_URL() });
    const { text, isError } = await server.call({
      action: 'eval',
      payload: "document.getElementById('b').dispatchEvent(new MouseEvent('click'))",
    });
    assert.equal(isError, false, text);
  });

  it('eval returning a data-qa identifier string (app_level_token_string) on this sensitive URL is allowed', async () => {
    await server.call({ action: 'navigate', payload: TOTP_URL() });
    const { text, isError } = await server.call({
      action: 'eval',
      payload: "document.getElementById('qa').getAttribute('data-qa')",
    });
    assert.equal(isError, false, text);
    assert.match(text, /app_level_token_string/);
  });

  // Round 5 (jc + Reeve): Slack's REAL data-qa shape for the App-Level
  // Tokens row -- an all-digit suffix, 14 characters. The original
  // any-digit version of rule 4 refused this outright; the mixed-only
  // version must allow it.
  it('eval returning app_level_tokens_row_<all-digit-id> on this sensitive URL is allowed (round 5, real Slack shape)', async () => {
    await server.call({ action: 'navigate', payload: TOTP_URL() });
    const { text, isError } = await server.call({
      action: 'eval',
      payload: "document.getElementById('qaRow').getAttribute('data-qa')",
    });
    assert.equal(isError, false, text);
    assert.match(text, /app_level_tokens_row_12277846587778/);
  });

  // Reeve's own case: truncating a real app-level token down to its first
  // 8 characters still names itself via its prefix (rule 2), even though
  // the truncated slice no longer matches the full-shape pattern (rule 1).
  it("eval returning el.value.slice(0,8) of a fake xapp token is refused (Reeve's case)", async () => {
    await server.call({ action: 'navigate', payload: TOTP_URL() });
    const { text, isError } = await server.call({
      action: 'eval',
      payload: "document.getElementById('el').value.slice(0,8)",
    });
    assert.equal(isError, true, text);
    assert.match(text, /eval refused/);
    assert.doesNotMatch(text, new RegExp(FAKE_APP_TOKEN), `token leaked into refusal text:\n${text}`);
  });

  it('eval returning an object with a NESTED token string is refused too', async () => {
    await server.call({ action: 'navigate', payload: TOTP_URL() });
    const { text, isError } = await server.call({
      action: 'eval',
      payload: "({ ok: true, meta: { token: document.getElementById('el').value } })",
    });
    assert.equal(isError, true, text);
    assert.match(text, /eval refused/);
    assert.doesNotMatch(text, new RegExp(FAKE_APP_TOKEN), `token leaked into refusal text:\n${text}`);
  });
});

// Code-list density signal: a page off the sensitive-URL pattern list,
// with no data-sen-secret marker, whose own visible text is a dense list
// of code-shaped tokens. data: URLs are NEVER matched by urlLooksSensitive
// (see sensitive-url.js), so this isolates the density signal from the
// URL-pattern signal entirely. PRI-3360 round 2 (jc review of #65): a
// WHOLE-PAGE refusal based on density alone also needs a nearby backup/
// recovery keyword now -- the heading below supplies one ("Save these
// backup codes") so this fixture still exercises the whole-page path, not
// just the (unconditional) element-scoped density check.
const CODE_DENSE_OFF_LIST_PAGE = dataUrl(
  '<title>Internal tool</title><h1>Save these backup codes</h1>' +
  `<ul id="codes">${FAKE_BACKUP_CODES.map((c) => `<li>${c}</li>`).join('\n')}</ul>` +
  '<button id="b">Done</button>'
);

describe('PRI-3360: code-list density signal, off the URL pattern list (real Chrome)', {
  skip: !CHROME_AVAILABLE && 'Chrome not installed',
}, () => {
  let server;
  before(async () => { server = await startServer(); });
  after(async () => { await server?.stop(); });

  it('extract (whole page) is refused via the density signal alone -- no sensitive URL, no marker', async () => {
    await server.call({ action: 'navigate', payload: CODE_DENSE_OFF_LIST_PAGE });
    const { text, isError } = await server.call({ action: 'extract', payload: 'text' });
    assert.equal(isError, true, text);
    assert.match(text, /extract refused/);
    assert.match(text, /dense list of secret-shaped codes/);
    for (const code of FAKE_BACKUP_CODES) {
      assert.doesNotMatch(text, new RegExp(code), `code leaked into refusal text:\n${text}`);
    }
  });

  it('an element read of the SAME dense codes, by selector, is refused by the element-scoped content check (not the whole-page gate)', async () => {
    await server.call({ action: 'navigate', payload: CODE_DENSE_OFF_LIST_PAGE });
    const { text, isError } = await server.call({ action: 'extract', selector: '#codes', payload: 'text' });
    assert.equal(isError, true, text);
    assert.match(text, /extract refused/);
    assert.match(text, /credential- or code-shaped/);
    for (const code of FAKE_BACKUP_CODES) {
      assert.doesNotMatch(text, new RegExp(code), `code leaked into refusal text:\n${text}`);
    }
  });

  it('an element read of an UNRELATED plain button on the same page still succeeds', async () => {
    await server.call({ action: 'navigate', payload: CODE_DENSE_OFF_LIST_PAGE });
    const { text, isError } = await server.call({ action: 'extract', selector: '#b', payload: 'text' });
    assert.equal(isError, false, text);
    assert.equal(text, 'Done');
  });
});

// PRI-3360 round 2 (jc review of #65, finding 1): real pages jc found
// tripping the density heuristic via document.body.textContent -- eval
// and every whole-page extract would have been refused outright on all
// four of these, with no narrower form for eval to fall back to. Saved,
// trimmed HTML (see test/lib/fixtures/code-list-negatives/README.md for
// provenance); navigated via file:// so these drive the exact same
// whole-page gate (sensitive-url.js's pageTextReadRefused) the dataUrl()
// fixtures elsewhere in this file do, over a real Chrome page -- not just
// the pure-function coverage in test/lib/code-list-detector.test.mjs.
describe('PRI-3360 round 2: real pages that must NOT be refused (jc review of #65, real Chrome)', {
  skip: !CHROME_AVAILABLE && 'Chrome not installed',
}, () => {
  let server;
  before(async () => { server = await startServer(); });
  after(async () => { await server?.stop(); });

  const FIXTURES_DIR = path.join(__dirname, 'lib', 'fixtures', 'code-list-negatives');
  const FIXTURES = [
    ['github-pr.html', 'a GitHub PR page'],
    ['github-repo.html', 'a GitHub repo page'],
    ['github-rest-docs.html', 'a GitHub REST API docs page (Next.js SSR __NEXT_DATA__ JSON)'],
    ['hn-front-page.html', 'the HN front page'],
  ];

  for (const [file, label] of FIXTURES) {
    // isError alone is the correct signal here -- NOT a /refused/i check
    // on the extracted text. github-pr.html IS this PR's own GitHub page,
    // which quotes refusal messages verbatim in its description and in
    // jc's review (the subject of this very fix), so the extracted text
    // legitimately contains the word "refused" many times over on a
    // SUCCESSFUL, unrefused read. Checking isError only is what actually
    // distinguishes "the tool refused" from "the page's real content
    // happens to mention the word."
    it(`eval(document.title) succeeds on ${label}, not refused by the code-list density signal`, async () => {
      const url = `file://${path.join(FIXTURES_DIR, file)}`;
      await server.call({ action: 'navigate', payload: url });
      const { text, isError } = await server.call({ action: 'eval', payload: 'document.title' });
      assert.equal(isError, false, text);
    });

    it(`extract (whole page, no selector) succeeds on ${label}, not refused by the code-list density signal`, async () => {
      const url = `file://${path.join(FIXTURES_DIR, file)}`;
      await server.call({ action: 'navigate', payload: url });
      const { text, isError } = await server.call({ action: 'extract', payload: 'text' });
      assert.equal(isError, false, text);
    });
  }
});

// The env override is read once from process.env of the already-running
// MCP server process (credential-guard.js's credentialCaptureAllowed) --
// nothing reachable from an MCP tool call can set it. eval's `expression`
// runs in the BROWSER PAGE's own JS realm over CDP, which is a different
// process (Chrome, not this Node server) and has no Node `process` global
// at all, so there is no reachable path from eval to that env var either
// way. These tests exercise both halves directly against a real Chrome.
describe('PRI-3360: the credential-capture override cannot be set from the agent side (real Chrome)', {
  skip: !CHROME_AVAILABLE && 'Chrome not installed',
}, () => {
  let server;
  before(async () => { server = await startServer(); });
  after(async () => { await server?.stop(); });

  it("eval's expression runs in the browser page's JS realm, which has no Node `process` global to touch", async () => {
    await server.call({ action: 'navigate', payload: CLEAN_PAGE });
    const { text, isError } = await server.call({ action: 'eval', payload: 'typeof process' });
    assert.equal(isError, false, text);
    assert.match(text, /undefined/);
  });

  // PRI-3360 round 4 (jc + Reeve's final design): eval no longer refuses
  // up front merely because the URL is sensitive, so this attempt now
  // RUNS -- which is itself the point: it runs, evaluates
  // `globalThis.process` (undefined in the browser realm) to the ELSE
  // branch, and returns the harmless string 'no process' with no Node
  // `process.env` ever touched. The override attempt was always going to
  // fail for this reason (no Node globals reachable from page JS at
  // all), independent of whether eval itself ran or was blocked -- this
  // version demonstrates that directly instead of relying on a refusal
  // that would have masked the real reason.
  it('an eval attempting to set the override runs harmlessly (no Node `process` global exists in the browser realm), and the override stays off afterward', async () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pri-3360-override-'));
    const fakeToken = ['xoxb', '1111111111', '2222222222', 'FAKEfakeFAKEfakeFAKEfake'].join('-');
    fs.mkdirSync(path.join(dir2, 'account', 'settings', '2fa_app'), { recursive: true });
    fs.writeFileSync(
      path.join(dir2, 'account', 'settings', '2fa_app', 'index.html'),
      '<title>Session page</title><h1>Signed in</h1>' +
      `<span id="tok">${fakeToken}</span>` +
      '<button id="b">Done</button>'
    );
    try {
      const url = `file://${path.join(dir2, 'account', 'settings', '2fa_app', 'index.html')}`;
      await server.call({ action: 'navigate', payload: url });
      const attempt = await server.call({
        action: 'eval',
        payload: "globalThis.process ? (process.env.SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE = '1') : 'no process'",
      });
      assert.equal(attempt.isError, false, attempt.text);
      assert.match(attempt.text, /no process/);

      // Proves the override is still OFF, not just that the attempt
      // above looked harmless: a token-shaped eval result on this SAME
      // sensitive URL is still refused. If the override had somehow been
      // set, this would succeed instead.
      const again = await server.call({ action: 'eval', payload: "document.getElementById('tok').textContent" });
      assert.equal(again.isError, true, again.text);
      assert.match(again.text, /eval refused/);
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });
});

const FAKE_SLACK_APP_TOKEN = ['xapp', '1', 'A01234ABCD', 'FAKEfakeFAKEfakeFAKEfakeFAKEfake'].join('-');

describe('PRI-3360 round 3 (Reeve): Slacks App-Level Tokens page (real Chrome)', {
  skip: !CHROME_AVAILABLE && 'Chrome not installed',
}, () => {
  let server;
  let dir;
  before(async () => {
    server = await startServer();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-app-token-'));
    fs.writeFileSync(
      path.join(dir, 'general.html'),
      '<title>Slack API: Applications</title><h1>Basic Information</h1>' +
      '<section><h2>App-Level Tokens</h2>' +
      '<div role="dialog" aria-label="Token generated">' +
      `<p>Add scopes to create an app-level token</p><code id="token">${FAKE_SLACK_APP_TOKEN}</code>` +
      '<button id="done">Done</button></div></section>'
    );
  });
  after(async () => {
    await server?.stop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the token never reaches an auto-capture file', async () => {
    const filesBefore = server.capturedFiles().length;
    await server.call({ action: 'navigate', payload: `file://${path.join(dir, 'general.html')}` });

    for (const file of server.capturedFiles().slice(filesBefore)) {
      const written = fs.readFileSync(file);
      assert.ok(!written.includes(Buffer.from(FAKE_SLACK_APP_TOKEN)), `token leaked into ${file}`);
      assert.ok(!written.includes(Buffer.from('FAKEfake')), `token fragment leaked into ${file}`);
    }
  });

  // PRI-3360 round 4 (jc + Reeve's final design): a file:// URL has no
  // real hostname, so this fixture does NOT exercise the host-qualified
  // sensitive-URL pattern the way a real api.slack.com navigation would
  // (that side is covered directly in test/lib/capture-credential-guard.
  // test.mjs, which controls location.href as a plain string) -- eval and
  // a whole-page extract now RUN on this page (their up-front refusal was
  // removed for exactly this "token with no other signal" case; see
  // sensitive-url.js's pageTextReadRefused doc). The token still never
  // reaches the agent, though: response-format.ts's redactUnlessAllowed
  // is a universal, unconditional last line of defense applied to EVERY
  // response, independent of anything capture.js decided.
  it('eval(outerHTML) now RUNS on this page, but the token is redacted in the result text', async () => {
    await server.call({ action: 'navigate', payload: `file://${path.join(dir, 'general.html')}` });
    const { text, isError } = await server.call({ action: 'eval', payload: 'document.documentElement.outerHTML' });
    assert.equal(isError, false, text);
    assert.doesNotMatch(text, new RegExp(FAKE_SLACK_APP_TOKEN), `token leaked into result text:\n${text}`);
    assert.match(text, /REDACTED credential-shaped/, `expected the redaction marker in:\n${text}`);
  });

  it('a whole-page extract also RUNS, with the same output-level redaction', async () => {
    await server.call({ action: 'navigate', payload: `file://${path.join(dir, 'general.html')}` });
    const { text, isError } = await server.call({ action: 'extract', payload: 'text' });
    assert.equal(isError, false, text);
    assert.doesNotMatch(text, new RegExp(FAKE_SLACK_APP_TOKEN), `token leaked into result text:\n${text}`);
    assert.match(text, /REDACTED credential-shaped/, `expected the redaction marker in:\n${text}`);
  });

  it('an element-scoped read of the token specifically is refused too (content-shape check, not just the whole-page gate)', async () => {
    await server.call({ action: 'navigate', payload: `file://${path.join(dir, 'general.html')}` });
    const { text, isError } = await server.call({ action: 'extract', selector: '#token', payload: 'text' });
    assert.equal(isError, true, text);
    assert.match(text, /extract refused/);
    assert.doesNotMatch(text, new RegExp(FAKE_SLACK_APP_TOKEN), `token leaked into refusal text:\n${text}`);
  });

  it('an element-scoped read of the UNRELATED Done button on the same page still succeeds', async () => {
    await server.call({ action: 'navigate', payload: `file://${path.join(dir, 'general.html')}` });
    const { text, isError } = await server.call({ action: 'extract', selector: '#done', payload: 'text' });
    assert.equal(isError, false, text);
    assert.equal(text, 'Done');
  });
});

// PRI-3360 round 4 (jc, round 4 review): Slack's own token-TYPES
// documentation page -- a real, unlisted page that legitimately prints
// EXAMPLE token strings to explain their format. This is the exact page
// class that motivated removing containsCredentialShaped as a whole-page
// refusal signal in round 3 (see sensitive-url.js's pageTextReadRefused
// doc comment): a page like this must stay fully readable (eval/extract
// are not refused at all), while the output-level redaction
// (response-format.ts's redactUnlessAllowed) still masks the example
// tokens in whatever text actually reaches the agent. Fetched and trimmed
// to just the <article> content -- see test/fixtures/sensitive-pages/
// README.md for provenance. The real example tokens shown there are
// replaced with {{EXAMPLE_TOKEN_N}} placeholders in the committed file;
// this test substitutes them with its OWN fake, assembled-at-runtime
// token strings of the same shape before serving the page.
describe("PRI-3360 round 4: Slack's token-types docs page stays readable (jc, real Chrome)", {
  skip: !CHROME_AVAILABLE && 'Chrome not installed',
}, () => {
  let server;
  let dir;
  const FAKE_EXAMPLE_TOKENS = [
    ['xoxp', '111', '222', '333', 'd6bc768406e5c2e6958cfc399b438004'].join('-'),
    ['xoxp', '111', '222', '333', 'd6bc768412'].join('-'),
    ['xoxp', '111', '222', '333', 'd6bc76'].join('-'),
  ];

  before(async () => {
    server = await startServer();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-token-docs-'));
    let html = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'sensitive-pages', 'slack-token-types-docs.html'),
      'utf8'
    );
    for (let i = 0; i < FAKE_EXAMPLE_TOKENS.length; i++) {
      html = html.split(`{{EXAMPLE_TOKEN_${i}}}`).join(FAKE_EXAMPLE_TOKENS[i]);
    }
    fs.writeFileSync(path.join(dir, 'tokens.html'), html);
  });
  after(async () => {
    await server?.stop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const DOCS_URL = () => `file://${path.join(dir, 'tokens.html')}`;

  it('the page URL is not on the sensitive-URL list (this is the "unlisted" case)', async () => {
    // Sanity check on the fixture itself, not the gate -- confirms this
    // test is actually exercising the unlisted path it claims to.
    const { urlLooksSensitive } = require('../skills/browsing/lib/sensitive-url.js');
    assert.equal(urlLooksSensitive('https://docs.slack.dev/authentication/tokens/'), false);
  });

  it('eval(document.title) succeeds -- not refused by anything on this page', async () => {
    await server.call({ action: 'navigate', payload: DOCS_URL() });
    const { text, isError } = await server.call({ action: 'eval', payload: 'document.title' });
    assert.equal(isError, false, text);
    assert.doesNotMatch(text, /refused/i, text);
  });

  // FINDING (not asked for, discovered via this exact fixture): Slack's
  // own page deliberately shows ONE of its three examples TRUNCATED, to
  // illustrate checking a token's length (the long form vs. a shortened
  // form of the same example shown just above it -- see
  // FAKE_EXAMPLE_TOKENS[2] above). That shortened
  // example is 18 characters after its prefix -- 2 short of
  // TOKEN_PATTERNS' {20,} minimum -- so redactCredentialShaped (the
  // output-level redaction every use_browser response goes through) does
  // NOT mask it, even though credential-guard.js's NEWER
  // hasKnownTokenPrefix (added this round specifically to catch a
  // truncated token) WOULD. hasKnownTokenPrefix is only wired into the
  // eval-result/element-scoped CHECKS this round added, not into
  // redactCredentialShaped's own regex -- extending that regex (or
  // routing redaction through hasKnownTokenPrefix too) was not part of
  // this round's design and is not changed here; this test documents the
  // gap instead of asserting something not true. The two LONGER examples
  // (the real secret value, and the same value re-shown slightly
  // differently) both meet the {20,} floor and ARE masked.
  it('a whole-page extract succeeds, with the two full-length example tokens redacted in the output', async () => {
    await server.call({ action: 'navigate', payload: DOCS_URL() });
    const { text, isError } = await server.call({ action: 'extract', payload: 'text' });
    assert.equal(isError, false, text);
    // index 0 and 1 are >=20 chars after the prefix; index 2 is the
    // deliberately-shortened 18-char example -- see the finding above.
    assert.doesNotMatch(text, new RegExp(FAKE_EXAMPLE_TOKENS[0]), `token leaked into result text:\n${text}`);
    assert.doesNotMatch(text, new RegExp(FAKE_EXAMPLE_TOKENS[1]), `token leaked into result text:\n${text}`);
    assert.match(text, new RegExp(FAKE_EXAMPLE_TOKENS[2]), 'expected the FINDING above: the 18-char shortened example is NOT masked by the existing output redaction');
    assert.match(text, /REDACTED credential-shaped/, `expected the redaction marker in:\n${text}`);
    // Confirms this is REDACTION, not a wholesale refusal: ordinary page
    // content around the tokens is still present.
    assert.match(text, /App-level tokens|token/i);
  });

  it('the tokens never reach an auto-capture file either', async () => {
    const filesBefore = server.capturedFiles().length;
    await server.call({ action: 'navigate', payload: DOCS_URL() });
    for (const file of server.capturedFiles().slice(filesBefore)) {
      const written = fs.readFileSync(file, 'utf8');
      for (const token of FAKE_EXAMPLE_TOKENS) {
        assert.ok(!written.includes(token), `token leaked into ${file}`);
      }
    }
  });
});
