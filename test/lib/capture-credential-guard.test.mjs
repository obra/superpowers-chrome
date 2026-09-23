// Auto-capture must not copy credential-shaped page content to disk or back
// into the tool result. These tests drive capture.js with a fake page whose
// HTML / markdown / DOM summary / live form values are controlled per test.
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

// Fake tokens are assembled from prefix + body at runtime so no complete
// token-shaped literal sits in the source (GitHub push protection rejects
// those even when they are obviously fake).
const FAKE_TOKEN = ['xoxb', '1111111111', '2222222222', 'FAKEfakeFAKEfakeFAKEfake'].join('-');
const SECRET_HEADING = 'Your new bot token';

const CLEAN_PAGE = {
  html: '<html><body><h1>Welcome</h1></body></html>',
  markdown: '# Welcome',
  domSummary: 'Welcome\nInteractive: 1 buttons, 0 inputs, 2 links\nHeadings: "Welcome"\nLayout: body',
  formValues: '',
};

const TOKEN_PAGE = {
  html: `<html><body><h1>${SECRET_HEADING}</h1><code>${FAKE_TOKEN}</code></body></html>`,
  markdown: `# ${SECRET_HEADING}\n\n${FAKE_TOKEN}`,
  domSummary: `Token page\nInteractive: 1 buttons, 1 inputs, 0 links\nHeadings: "${SECRET_HEADING}"\nLayout: body`,
  formValues: '',
};

// A token that appears only in a live input value (set by script, so it is
// not in outerHTML or the markdown).
const TOKEN_IN_INPUT_VALUE_PAGE = {
  ...CLEAN_PAGE,
  formValues: FAKE_TOKEN,
};

const MARKER_PAGE = {
  html: '<html><body><h1>Backup codes</h1><ul data-sen-secret><li>1234 5678</li></ul></body></html>',
  markdown: '# Backup codes\n\n- 1234 5678',
  domSummary: 'Backup codes\nInteractive: 0 buttons, 0 inputs, 0 links\nHeadings: "Backup codes"\nLayout: body',
  formValues: '',
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
function setup({ before, after: afterPage = before }) {
  const pageRef = { current: before };
  const calls = { screenshot: 0, action: 0 };
  const ps = {
    sessionId: 'S1',
    targetId: 'T1',
    send: async (method, params) => {
      if (method !== 'Runtime.evaluate') return {};
      const expr = params.expression;
      const page = pageRef.current;
      if (expr === markdownScript) return { result: { value: page.markdown } };
      if (expr === domSummaryScript) return { result: { value: page.domSummary } };
      if (expr.includes('window.innerWidth')) {
        return { result: { value: { width: 800, height: 600, documentWidth: 800, documentHeight: 600 } } };
      }
      if (expr.includes("querySelectorAll('input, textarea')")) return { result: { value: page.formValues } };
      return { result: { value: null } };
    },
  };
  const state = { sessionDir: null, captureCounter: 0 };
  const api = attachCapture({
    state,
    getPageSession: async () => ps,
    getHtml: async () => pageRef.current.html,
    screenshot: async (_tab, file) => { calls.screenshot++; fs.writeFileSync(file, 'PNG'); return file; },
    actions: {
      click: async () => { calls.action++; pageRef.current = afterPage; return { clicked: true }; },
      evaluate: async () => { calls.action++; return 42; },
    },
  });
  const act = async () => { calls.action++; pageRef.current = afterPage; return 'acted'; };
  return { ...api, state, calls, act };
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
