// Auto-capture must not copy credential-shaped page content to disk or back
// into the tool result. These tests drive capture.js with a fake page whose
// HTML / markdown / DOM summary / rendered text are controlled per test.
// The token strings are obviously fake.
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { attachCapture } = require('../../skills/browsing/lib/capture.js');
const markdownScript = require('../../skills/browsing/lib/page-scripts/markdown.js');
const domSummaryScript = require('../../skills/browsing/lib/page-scripts/dom-summary.js');
const { HAS_SECRET_MARKER_SCRIPT } = require('../../skills/browsing/lib/secret-marker.js');

// Fake tokens are assembled from prefix + body at runtime so no complete
// token-shaped literal sits in the source (GitHub push protection rejects
// those even when they are obviously fake).
const FAKE_TOKEN = ['xoxb', '1111111111', '2222222222', 'FAKEfakeFAKEfakeFAKEfake'].join('-');
const SECRET_HEADING = 'Your new bot token';

const CLEAN_PAGE = {
  html: '<html><body><h1>Welcome</h1></body></html>',
  markdown: '# Welcome',
  domSummary: 'Welcome\nInteractive: 1 buttons, 0 inputs, 2 links\nHeadings: "Welcome"\nLayout: body',
  renderedText: '',
};

const TOKEN_PAGE = {
  html: `<html><body><h1>${SECRET_HEADING}</h1><code>${FAKE_TOKEN}</code></body></html>`,
  markdown: `# ${SECRET_HEADING}\n\n${FAKE_TOKEN}`,
  domSummary: `Token page\nInteractive: 1 buttons, 1 inputs, 0 links\nHeadings: "${SECRET_HEADING}"\nLayout: body`,
  renderedText: '',
};

// A token that appears only in the rendered text (a live input value set by
// script, text split across inline spans, or an open shadow root), so it is
// not in outerHTML or the markdown.
const TOKEN_IN_INPUT_VALUE_PAGE = {
  ...CLEAN_PAGE,
  renderedText: FAKE_TOKEN,
};

const MARKER_PAGE = {
  html: '<html><body><h1>Backup codes</h1><ul data-sen-secret><li>1234 5678</li></ul></body></html>',
  markdown: '# Backup codes\n\n- 1234 5678',
  domSummary: 'Backup codes\nInteractive: 0 buttons, 0 inputs, 0 links\nHeadings: "Backup codes"\nLayout: body',
  renderedText: '',
};

// A native dialog (alert/confirm/prompt/beforeunload) whose message is
// page/JS-controlled and can carry a credential-shaped string. See
// dialogs-render.js's renderSyntheticArtifacts for the payload shape.
const DIALOG_WITH_TOKEN = {
  kind: 'alert',
  payload: {
    message: `Your new bot token is ${FAKE_TOKEN}`,
    url: 'https://example.test',
    defaultPrompt: '',
    hasBrowserHandler: false,
  },
};

const DIALOG_BENIGN = {
  kind: 'confirm',
  payload: {
    message: 'Are you sure you want to leave this page?',
    url: 'https://example.test',
    defaultPrompt: '',
    hasBrowserHandler: false,
  },
};

const ENV = 'SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE';

// Fresh XDG cache per test so each gets its own, initially empty, session dir.
let tmpRoots = [];
const origXdg = process.env.XDG_CACHE_HOME;
const origAllow = process.env[ENV];

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-guard-'));
  tmpRoots.push(root);
  process.env.XDG_CACHE_HOME = root;
  delete process.env[ENV];
});

afterEach(() => {
  if (origAllow === undefined) delete process.env[ENV];
  else process.env[ENV] = origAllow;
});

after(() => {
  if (origXdg === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = origXdg;
  for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
  tmpRoots = [];
});

// pages: the page state before the action and after it. `pageRef.current`
// is flipped by the fake action so getHtml & friends report the new page.
// revealOnScreenshot: { call, page } flips the page to `page` while the
// call-th screenshot is being taken — a token revealed (e.g. by an XHR)
// between the content check and the pixels.
// dialog / dialogAfterAction: what dialogs.getOpen reports before and after
// the action, for the dialog short-circuit branches. null means no dialog.
function setup({
  before,
  after: afterPage = before,
  revealOnScreenshot = null,
  dialog = null,
  dialogAfterAction = dialog,
  secretMarkerLive = false,
}) {
  const pageRef = { current: before };
  const dialogRef = { current: dialog };
  const calls = { screenshot: 0, action: 0 };
  const ps = {
    sessionId: 'S1',
    targetId: 'T1',
    send: async (method, params) => {
      if (method !== 'Runtime.evaluate') return {};
      const expr = params.expression;
      const page = pageRef.current;
      if (expr === HAS_SECRET_MARKER_SCRIPT) return { result: { value: secretMarkerLive } };
      if (expr === markdownScript) return { result: { value: page.markdown } };
      if (expr === domSummaryScript) return { result: { value: page.domSummary } };
      if (expr === 'document.body.innerText') return { result: { value: page.renderedText } };
      if (expr.includes('window.innerWidth')) {
        return { result: { value: { width: 800, height: 600, documentWidth: 800, documentHeight: 600 } } };
      }
      // Matches both the rendered-text script and its input-values-only predecessor.
      if (expr.includes("querySelectorAll('input, textarea')")) return { result: { value: page.renderedText } };
      return { result: { value: null } };
    },
  };
  const state = { sessionDir: null, captureCounter: 0 };
  const dialogs = { getOpen: () => dialogRef.current };
  const api = attachCapture({
    state,
    getPageSession: async () => ps,
    getHtml: async () => pageRef.current.html,
    screenshot: async (_tab, file) => {
      calls.screenshot++;
      if (revealOnScreenshot && revealOnScreenshot.call === calls.screenshot) pageRef.current = revealOnScreenshot.page;
      fs.writeFileSync(file, 'PNG');
      return file;
    },
    actions: {
      click: async () => { calls.action++; pageRef.current = afterPage; dialogRef.current = dialogAfterAction; return { clicked: true }; },
      evaluate: async (_tab, expression) => { calls.action++; return expression === 'document.body.innerText' ? pageRef.current.renderedText : 42; },
    },
    dialogs,
  });
  const act = async () => { calls.action++; pageRef.current = afterPage; dialogRef.current = dialogAfterAction; return 'acted'; };
  return { ...api, state, calls, act, dialogRef };
}

function sessionFiles(state) {
  const dir = state.sessionDir;
  return dir && fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

function assertNoLeak(result) {
  const text = JSON.stringify(result);
  assert.ok(!text.includes(FAKE_TOKEN), `token leaked into result: ${text}`);
  assert.ok(!text.includes('FAKEfake'), `token fragment leaked into result: ${text}`);
  assert.ok(!text.includes(SECRET_HEADING), `page text leaked into result: ${text}`);
  assert.ok(!text.includes('Backup codes'), `page text leaked into result: ${text}`);
}

describe('capturePageArtifacts credential guard', () => {
  for (const [name, page] of [
    ['a token in the HTML', TOKEN_PAGE],
    ['a token only in a live input value', TOKEN_IN_INPUT_VALUE_PAGE],
    ['the data-sen-secret marker', MARKER_PAGE],
  ]) {
    it(`writes no files and returns only metadata for ${name}`, async () => {
      const { capturePageArtifacts, state, calls } = setup({ before: page });
      const result = await capturePageArtifacts(0, 'navigate');

      assert.equal(result.credentialSuppressed, true);
      assert.deepEqual(sessionFiles(state), [], 'no capture artifacts may be written');
      assert.equal(calls.screenshot, 0, 'no screenshot may be taken');
      assert.equal(result.files, null);
      assert.deepEqual(result.pageSize, { width: 800, height: 600, documentWidth: 800, documentHeight: 600 });
      assertNoLeak(result);
    });
  }

  it('keeps element counts and layout but drops the title and headings lines', async () => {
    const { capturePageArtifacts } = setup({ before: TOKEN_PAGE });
    const result = await capturePageArtifacts(0, 'navigate');
    assert.equal(result.domSummary, 'Interactive: 1 buttons, 1 inputs, 0 links\nLayout: body');
  });

  it('captures a normal page exactly as before', async () => {
    const { capturePageArtifacts, state, calls } = setup({ before: CLEAN_PAGE });
    const result = await capturePageArtifacts(0, 'navigate');

    assert.ok(!result.credentialSuppressed);
    assert.deepEqual(sessionFiles(state).sort(),
      ['001-navigate-console.txt', '001-navigate.html', '001-navigate.md', '001-navigate.png']);
    assert.equal(calls.screenshot, 1);
    assert.equal(result.domSummary, CLEAN_PAGE.domSummary);
    assert.equal(fs.readFileSync(result.files.html, 'utf8'), CLEAN_PAGE.html);
  });

  it(`${ENV}=1 restores capture of a credential-shaped page`, async () => {
    process.env[ENV] = '1';
    const { capturePageArtifacts, state } = setup({ before: TOKEN_PAGE });
    const result = await capturePageArtifacts(0, 'navigate');

    assert.ok(!result.credentialSuppressed);
    assert.equal(sessionFiles(state).length, 4);
    assert.ok(fs.readFileSync(result.files.html, 'utf8').includes(FAKE_TOKEN));
  });

  it('leaves no files when a token appears while the screenshot is taken', async () => {
    const { capturePageArtifacts, state } = setup({
      before: CLEAN_PAGE,
      revealOnScreenshot: { call: 1, page: TOKEN_PAGE },
    });
    const result = await capturePageArtifacts(0, 'click');

    assert.equal(result.credentialSuppressed, true);
    assert.deepEqual(sessionFiles(state), [], 'the PNG and every other artifact must be gone');
    assertNoLeak(result);
  });

  it('the *WithCapture wrappers pass the suppression through', async () => {
    const { clickWithCapture, evaluateWithCapture } = setup({ before: TOKEN_PAGE });
    const clicked = await clickWithCapture(0, '#reveal');
    assert.equal(clicked.credentialSuppressed, true);
    assert.equal(clicked.files, null);
    assertNoLeak(clicked);

    const evaluated = await evaluateWithCapture(0, '21+21');
    assert.equal(evaluated.credentialSuppressed, true);
    assert.equal(evaluated.result, 42, 'eval still returns its (non-secret) value');
  });
});

// obra#50 follow-up: the data-sen-secret marker (unlike a token-shaped
// value) has no shape a returned result can be checked against after the
// fact, so eval and the whole-page extract('text') path fail closed on the
// marker's live presence, checked BEFORE running anything — unlike the
// TOKEN_PAGE case above, where eval still runs and only the capture
// metadata is suppressed.
describe('evaluateWithCapture fails closed on a live data-sen-secret marker', () => {
  it('refuses without running the expression when the marker is present', async () => {
    const { evaluateWithCapture, calls } = setup({ before: CLEAN_PAGE, secretMarkerLive: true });
    await assert.rejects(
      () => evaluateWithCapture(0, 'document.getElementById("secret").textContent'),
      /eval refused.*data-sen-secret/
    );
    assert.equal(calls.action, 0, 'the expression must never run');
  });

  it('runs normally when no marker is present', async () => {
    const { evaluateWithCapture, calls } = setup({ before: CLEAN_PAGE, secretMarkerLive: false });
    const result = await evaluateWithCapture(0, '21+21');
    assert.equal(result.result, 42);
    assert.equal(calls.action, 1);
  });

  it(`${ENV}=1 skips the marker check and runs the expression`, async () => {
    process.env[ENV] = '1';
    const { evaluateWithCapture, calls } = setup({ before: CLEAN_PAGE, secretMarkerLive: true });
    const result = await evaluateWithCapture(0, '21+21');
    assert.equal(result.result, 42);
    assert.equal(calls.action, 1);
  });
});

describe("extractPageText fails closed on a live data-sen-secret marker (extract action's whole-page text mode)", () => {
  it('refuses when the marker is present, without reading innerText', async () => {
    const page = { ...CLEAN_PAGE, renderedText: 'should never be read' };
    const { extractPageText, calls } = setup({ before: page, secretMarkerLive: true });
    await assert.rejects(
      () => extractPageText(0),
      /extract refused.*data-sen-secret/
    );
    assert.equal(calls.action, 0, 'innerText must never be read');
  });

  it('returns the rendered text normally when no marker is present', async () => {
    const page = { ...CLEAN_PAGE, renderedText: 'Welcome to the page' };
    const { extractPageText } = setup({ before: page, secretMarkerLive: false });
    assert.equal(await extractPageText(0), 'Welcome to the page');
  });

  it(`${ENV}=1 skips the marker check and returns the text`, async () => {
    process.env[ENV] = '1';
    const page = { ...MARKER_PAGE, renderedText: '1234 5678' };
    const { extractPageText } = setup({ before: page, secretMarkerLive: true });
    assert.equal(await extractPageText(0), '1234 5678');
  });
});

describe('captureActionWithDiff credential guard', () => {
  for (const [name, pages] of [
    ['the action reveals a token', { before: CLEAN_PAGE, after: TOKEN_PAGE }],
    ['the token was on the page before the action', { before: TOKEN_PAGE, after: CLEAN_PAGE }],
    ['the token is only in a live input value after the action', { before: CLEAN_PAGE, after: TOKEN_IN_INPUT_VALUE_PAGE }],
    ['the page carries the data-sen-secret marker', { before: CLEAN_PAGE, after: MARKER_PAGE }],
  ]) {
    it(`writes no files and returns no diff when ${name}`, async () => {
      const { captureActionWithDiff, state, calls, act } = setup(pages);
      const result = await captureActionWithDiff(0, 'keypress', act, 0);

      assert.equal(result.actionResult, 'acted', 'the action itself still runs');
      assert.equal(calls.action, 1);
      assert.equal(result.capture.credentialSuppressed, true);
      assert.deepEqual(sessionFiles(state), [], 'no before/after/diff/md/png files may remain');
      assert.deepEqual(result.capture.files, {});
      assert.equal(result.capture.diffSummary, '');
      assertNoLeak(result);
    });
  }

  for (const [name, call] of [['BEFORE', 1], ['AFTER', 2]]) {
    it(`leaves no files when a token appears while the ${name} screenshot is taken`, async () => {
      const { captureActionWithDiff, state, act } = setup({
        before: CLEAN_PAGE,
        after: CLEAN_PAGE,
        revealOnScreenshot: { call, page: TOKEN_PAGE },
      });
      const result = await captureActionWithDiff(0, 'keypress', act, 0);

      assert.equal(result.capture.credentialSuppressed, true);
      assert.deepEqual(sessionFiles(state), [], 'no before/after/diff/md/png files may remain');
      assertNoLeak(result);
    });
  }

  it('does not take a before-screenshot of a page that already shows a token', async () => {
    const { captureActionWithDiff, calls, act } = setup({ before: TOKEN_PAGE, after: CLEAN_PAGE });
    await captureActionWithDiff(0, 'keypress', act, 0);
    assert.equal(calls.screenshot, 0);
  });

  it('captures a normal before/after pair exactly as before', async () => {
    const { captureActionWithDiff, state, act } = setup({ before: CLEAN_PAGE, after: CLEAN_PAGE });
    const result = await captureActionWithDiff(0, 'keypress', act, 0);

    assert.ok(!result.capture.credentialSuppressed);
    assert.deepEqual(sessionFiles(state).sort(), [
      '001-keypress-after.html', '001-keypress-after.png', '001-keypress-before.html',
      '001-keypress-before.png', '001-keypress-diff.txt', '001-keypress.md',
    ]);
    assert.equal(result.capture.domSummary, CLEAN_PAGE.domSummary);
  });

  it(`${ENV}=1 restores the before/after capture`, async () => {
    process.env[ENV] = '1';
    const { captureActionWithDiff, state, act } = setup({ before: CLEAN_PAGE, after: TOKEN_PAGE });
    const result = await captureActionWithDiff(0, 'keypress', act, 0);

    assert.ok(!result.capture.credentialSuppressed);
    assert.equal(sessionFiles(state).length, 6);
    assert.ok(result.capture.diffSummary.includes(FAKE_TOKEN));
  });
});

// The dialog short-circuits skip all page reads (a dialog suspends the page's
// execution context), so they check the synthetic dialog artifacts instead of
// html/markdown/domSummary/renderedText — same guard, different inputs.
describe('capturePageArtifacts dialog short-circuit credential guard', () => {
  it('writes no files and returns credentialSuppressed when the dialog message carries a token', async () => {
    const { capturePageArtifacts, state } = setup({ before: CLEAN_PAGE, dialog: DIALOG_WITH_TOKEN });
    const result = await capturePageArtifacts(0, 'navigate');

    assert.equal(result.credentialSuppressed, true);
    assert.equal(result.files, null);
    assert.deepEqual(sessionFiles(state), [], 'no dialog capture artifacts may be written');
    assert.deepEqual(result.dialog, { kind: 'alert' }, 'only the dialog kind survives, never its payload');
    assertNoLeak(result);
  });

  it('captures a benign dialog normally', async () => {
    const { capturePageArtifacts, state } = setup({ before: CLEAN_PAGE, dialog: DIALOG_BENIGN });
    const result = await capturePageArtifacts(0, 'navigate');

    assert.ok(!result.credentialSuppressed);
    assert.deepEqual(sessionFiles(state).sort(),
      ['001-navigate-console.txt', '001-navigate.html', '001-navigate.md']);
    assert.ok(result.markdown.includes(DIALOG_BENIGN.payload.message));
  });

  it(`${ENV}=1 restores capture of a dialog with a credential-shaped message`, async () => {
    process.env[ENV] = '1';
    const { capturePageArtifacts, state } = setup({ before: CLEAN_PAGE, dialog: DIALOG_WITH_TOKEN });
    const result = await capturePageArtifacts(0, 'navigate');

    assert.ok(!result.credentialSuppressed);
    assert.equal(sessionFiles(state).length, 3);
    assert.ok(result.markdown.includes(FAKE_TOKEN));
  });
});

describe('captureActionWithDiff after-dialog short-circuit credential guard', () => {
  it('writes no after-dialog files but returns the dialog artifacts (redacted later by the MCP layer) and the dialog kind when the action opens a dialog with a token in its message', async () => {
    const { captureActionWithDiff, state, act } = setup({
      before: CLEAN_PAGE,
      dialog: null,
      dialogAfterAction: DIALOG_WITH_TOKEN,
    });
    const result = await captureActionWithDiff(0, 'click', act, 0);

    assert.equal(result.actionResult, 'acted', 'the action itself still runs');
    assert.equal(result.capture, null, 'same no-capture shape as any other dialog-opened result');
    assert.equal(result.credentialSuppressed, true, 'the disk write is suppressed');
    assert.deepEqual(result.dialog, { kind: 'alert' }, 'only the dialog kind survives, never its raw payload');
    // Only the disk write is suppressed. The synthetic artifacts (including
    // the dialog::accept/dismiss instructions) still come back so the MCP
    // layer's formatCaptureResponse + redactUnlessAllowed can build the
    // redacted response + notice, instead of losing the instructions.
    assert.ok(result.artifacts, 'the synthetic dialog artifacts must still be returned');
    assert.ok(result.artifacts.markdown.includes('dialog::accept'),
      'the accept/dismiss instructions must survive suppression');
    assert.ok(result.artifacts.markdown.includes(FAKE_TOKEN),
      'the raw (unredacted-at-this-layer) message survives here; redaction happens in mcp/src/index.ts');
    assert.deepEqual(sessionFiles(state), ['001-click-before.png'],
      'only the clean BEFORE screenshot may remain; no after-dialog artifacts written to disk');
  });

  it('captures a benign after-dialog normally', async () => {
    const { captureActionWithDiff, state, act } = setup({
      before: CLEAN_PAGE,
      dialog: null,
      dialogAfterAction: DIALOG_BENIGN,
    });
    const result = await captureActionWithDiff(0, 'click', act, 0);

    assert.equal(result.capture, null);
    assert.ok(!result.credentialSuppressed);
    assert.ok(result.dialog);
    assert.ok(result.artifacts.markdown.includes(DIALOG_BENIGN.payload.message));
    assert.deepEqual(sessionFiles(state).sort(),
      ['001-click-before.png', '002-click-console.txt', '002-click.html', '002-click.md']);
  });

  it(`${ENV}=1 restores the after-dialog capture of a credential-shaped message`, async () => {
    process.env[ENV] = '1';
    const { captureActionWithDiff, state, act } = setup({
      before: CLEAN_PAGE,
      dialog: null,
      dialogAfterAction: DIALOG_WITH_TOKEN,
    });
    const result = await captureActionWithDiff(0, 'click', act, 0);

    assert.ok(!result.credentialSuppressed);
    assert.equal(sessionFiles(state).length, 4);
    assert.ok(result.artifacts.markdown.includes(FAKE_TOKEN));
  });
});

describe('pageContainsCredentialShaped', () => {
  it('is true for a token in the HTML, a token in a live input value, or the marker', async () => {
    for (const page of [TOKEN_PAGE, TOKEN_IN_INPUT_VALUE_PAGE, MARKER_PAGE]) {
      const { pageContainsCredentialShaped } = setup({ before: page });
      assert.equal(await pageContainsCredentialShaped(0), true);
    }
  });

  it('is false for a normal page', async () => {
    const { pageContainsCredentialShaped } = setup({ before: CLEAN_PAGE });
    assert.equal(await pageContainsCredentialShaped(0), false);
  });
});

describe('screenshotUnlessCredentialShaped', () => {
  function shotPath() {
    return path.join(process.env.XDG_CACHE_HOME, 'explicit.png');
  }

  it('saves a screenshot of a normal page', async () => {
    const { screenshotUnlessCredentialShaped } = setup({ before: CLEAN_PAGE });
    const saved = await screenshotUnlessCredentialShaped(0, shotPath());
    assert.equal(saved, shotPath());
    assert.ok(fs.existsSync(shotPath()));
  });

  it('takes no screenshot of a page that already shows a token', async () => {
    const { screenshotUnlessCredentialShaped, calls } = setup({ before: TOKEN_IN_INPUT_VALUE_PAGE });
    assert.equal(await screenshotUnlessCredentialShaped(0, shotPath()), null);
    assert.equal(calls.screenshot, 0);
    assert.equal(fs.existsSync(shotPath()), false);
  });

  it('deletes the screenshot when a token appears while it is taken', async () => {
    const { screenshotUnlessCredentialShaped } = setup({
      before: CLEAN_PAGE,
      revealOnScreenshot: { call: 1, page: TOKEN_PAGE },
    });
    assert.equal(await screenshotUnlessCredentialShaped(0, shotPath()), null);
    assert.equal(fs.existsSync(shotPath()), false);
  });

  it(`${ENV}=1 saves the screenshot regardless`, async () => {
    process.env[ENV] = '1';
    const { screenshotUnlessCredentialShaped } = setup({ before: TOKEN_PAGE });
    assert.equal(await screenshotUnlessCredentialShaped(0, shotPath()), shotPath());
    assert.ok(fs.existsSync(shotPath()));
  });
});
