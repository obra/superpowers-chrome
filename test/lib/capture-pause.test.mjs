// pause_capture/resume_capture: a pause switch for every automatic capture
// (DOM snapshot, markdown, screenshot, console-log placeholder, synthetic
// dialog artifacts). See lib/capture-pause.js for the full rationale.
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { attachCapture } = require('../../skills/browsing/lib/capture.js');
const markdownScript = require('../../skills/browsing/lib/page-scripts/markdown.js');
const domSummaryScript = require('../../skills/browsing/lib/page-scripts/dom-summary.js');
const htmlWithScrubScript = require('../../skills/browsing/lib/page-scripts/html-with-scrub.js');
const { capturePausedScreenshotRefusal } = require('../../skills/browsing/lib/capture-pause.js');

const PAGE = {
  html: '<html><body><h1>Dashboard</h1></body></html>',
  markdown: '# Dashboard',
  domSummary: 'Dashboard\nInteractive: 1 buttons, 0 inputs, 2 links\nHeadings: "Dashboard"\nLayout: body',
  renderedText: '',
};

let tmpRoots = [];
const origXdg = process.env.XDG_CACHE_HOME;

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-pause-'));
  tmpRoots.push(root);
  process.env.XDG_CACHE_HOME = root;
});

after(() => {
  if (origXdg === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = origXdg;
  for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
  tmpRoots = [];
});

// dialogOpen: when set, dialogs.getOpen() reports it -- lets tests exercise
// the dialog-aware branches without a real dialogs.js instance.
function setup({ dialogOpen = null } = {}) {
  const calls = { screenshot: 0, evaluate: 0 };
  const ps = {
    sessionId: 'S1',
    targetId: 'T1',
    send: async (method, params) => {
      calls.evaluate++;
      if (method !== 'Runtime.evaluate') return {};
      const expr = params.expression;
      if (expr === markdownScript) return { result: { value: PAGE.markdown } };
      if (expr === domSummaryScript) return { result: { value: PAGE.domSummary } };
      if (expr === 'document.body.innerText') return { result: { value: PAGE.renderedText } };
      if (expr === 'location.href') return { result: { value: 'https://example.test/dashboard' } };
      if (expr === htmlWithScrubScript) {
        return { result: { value: { raw: PAGE.html, scrubbed: PAGE.html, secretValues: [] } } };
      }
      if (expr.includes('window.innerWidth')) {
        return { result: { value: { width: 800, height: 600, documentWidth: 800, documentHeight: 600 } } };
      }
      if (expr.includes("querySelectorAll('input, textarea')")) return { result: { value: PAGE.renderedText } };
      return { result: { value: null } };
    },
  };
  const state = { sessionDir: null, captureCounter: 0 };
  const dialogRef = { current: dialogOpen };
  const dialogs = { getOpen: () => dialogRef.current };
  const api = attachCapture({
    state,
    getPageSession: async () => ps,
    getHtml: async () => PAGE.html,
    screenshot: async (_tab, file) => { calls.screenshot++; fs.writeFileSync(file, 'PNG'); return file; },
    actions: {
      click: async () => ({ clicked: true }),
      evaluate: async () => 42,
    },
    dialogs,
  });
  return { ...api, state, calls, dialogRef };
}

function sessionFiles(state) {
  const dir = state.sessionDir;
  return dir && fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

describe('pause_capture / resume_capture', () => {
  it('isCapturePaused starts false', () => {
    const { isCapturePaused } = setup();
    assert.equal(isCapturePaused(), false);
  });

  it('pauseCapture flips isCapturePaused to true', () => {
    const { pauseCapture, isCapturePaused } = setup();
    pauseCapture();
    assert.equal(isCapturePaused(), true);
  });

  describe('capturePageArtifacts while paused', () => {
    it('writes no files and returns capturePaused:true, without reading the page at all', async () => {
      const { pauseCapture, capturePageArtifacts, state, calls } = setup();
      pauseCapture();
      const result = await capturePageArtifacts(0, 'navigate');

      assert.equal(result.capturePaused, true);
      assert.equal(result.files, null);
      assert.deepEqual(sessionFiles(state), [], 'no capture artifacts may be written');
      assert.equal(calls.screenshot, 0, 'no screenshot may be taken while paused');
      assert.equal(calls.evaluate, 0, 'no CDP call may be made while paused (no dialog open)');
    });

    it('still reports an open dialog by kind, but writes no synthetic dialog artifact files', async () => {
      const { pauseCapture, capturePageArtifacts, state, calls } = setup({
        dialogOpen: { kind: 'alert', payload: { message: 'Your new password is Sup3rSecret!', url: 'https://example.test' } },
      });
      pauseCapture();
      const result = await capturePageArtifacts(0, 'click');

      assert.equal(result.capturePaused, true);
      assert.equal(result.dialog.kind, 'alert');
      assert.equal(result.files, null);
      assert.deepEqual(sessionFiles(state), [], 'no dialog artifact files may be written while paused');
      assert.equal(calls.screenshot, 0);
      // The dialog message itself must never appear in the metadata-only result.
      assert.ok(!JSON.stringify(result).includes('Sup3rSecret'), 'the dialog message must not leak into the paused result');
    });
  });

  describe('captureActionWithDiff while paused', () => {
    it('still runs the action, but writes no before/after/diff/markdown files', async () => {
      const { pauseCapture, captureActionWithDiff, state, calls } = setup();
      pauseCapture();
      let actionRan = false;
      const result = await captureActionWithDiff(0, 'keypress', async () => { actionRan = true; return 'acted'; }, 0);

      assert.equal(actionRan, true, 'the action itself must still run while paused');
      assert.equal(result.actionResult, 'acted');
      assert.equal(result.capture.capturePaused, true);
      assert.deepEqual(result.capture.files, {});
      assert.deepEqual(sessionFiles(state), [], 'no before/after/diff/md/png files may be written while paused');
      assert.equal(calls.screenshot, 0);
    });

    it('still reports a dialog that opens mid-action (kind only), so TYPE/HOVER/... callers that key off `!result.capture` still see it', async () => {
      const { pauseCapture, captureActionWithDiff, dialogRef, state } = setup();
      pauseCapture();
      const result = await captureActionWithDiff(0, 'type', async () => {
        dialogRef.current = { kind: 'confirm', payload: { message: 'Delete account?', url: 'https://example.test' } };
        return 'typed';
      }, 0);

      assert.equal(result.actionResult, 'typed');
      assert.equal(result.capture, null, 'capture must be null so the mid-flight-dialog branch in mcp/src/index.ts fires');
      assert.equal(result.dialog.kind, 'confirm');
      assert.equal(result.capturePaused, true);
      assert.deepEqual(sessionFiles(state), []);
      assert.ok(!JSON.stringify(result).includes('Delete account'), 'the dialog message must not leak into the paused result');
    });
  });

  describe('pause persists across actions within a session', () => {
    it('stays paused across two captures with no resumeCapture call in between', async () => {
      const { pauseCapture, capturePageArtifacts, state } = setup();
      pauseCapture();

      const first = await capturePageArtifacts(0, 'click');
      const second = await capturePageArtifacts(0, 'click');

      assert.equal(first.capturePaused, true);
      assert.equal(second.capturePaused, true);
      assert.deepEqual(sessionFiles(state), []);
    });
  });

  describe('resumeCapture restores normal capture', () => {
    it('writes files again on the next capture after resumeCapture', async () => {
      const { pauseCapture, resumeCapture, capturePageArtifacts, state } = setup();
      pauseCapture();
      const paused = await capturePageArtifacts(0, 'click');
      assert.equal(paused.capturePaused, true);

      resumeCapture();
      const resumed = await capturePageArtifacts(0, 'click');

      assert.ok(!resumed.capturePaused);
      assert.ok(!resumed.credentialSuppressed);
      assert.deepEqual(sessionFiles(state).sort(),
        ['001-click-console.txt', '001-click.html', '001-click.md', '001-click.png']);
    });
  });

  describe('clickWithCapture (and the other *WithCapture wrappers) while paused', () => {
    it('propagates capturePaused:true onto the merged result, so formatCaptureFiles shows the pause notice instead of a bogus ???.html/.md/.png file list', async () => {
      const { pauseCapture, clickWithCapture, state, calls } = setup();
      pauseCapture();
      const result = await clickWithCapture(0, '#button');

      assert.equal(result.capturePaused, true, "clickWithCapture must forward capturePageArtifacts' capturePaused flag");
      assert.equal(result.files, null);
      assert.deepEqual(sessionFiles(state), []);
      assert.equal(calls.screenshot, 0);
    });

    it('takes effect again once resumed', async () => {
      const { pauseCapture, resumeCapture, clickWithCapture } = setup();
      pauseCapture();
      resumeCapture();
      const result = await clickWithCapture(0, '#button');
      assert.ok(!result.capturePaused);
      assert.ok(result.files);
    });
  });

  describe('explicit screenshot while paused', () => {
    it('screenshotUnlessCredentialShaped refuses outright, with a clear message, instead of taking the shot', async () => {
      const { pauseCapture, screenshotUnlessCredentialShaped, calls } = setup();
      pauseCapture();
      await assert.rejects(
        () => screenshotUnlessCredentialShaped(0, '/tmp/whatever-pause-test.png'),
        new RegExp(capturePausedScreenshotRefusal().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      );
      assert.equal(calls.screenshot, 0, 'no screenshot may be taken while paused');
    });

    it('takes the shot normally once resumed', async () => {
      const { pauseCapture, resumeCapture, screenshotUnlessCredentialShaped, calls } = setup();
      pauseCapture();
      await assert.rejects(() => screenshotUnlessCredentialShaped(0, '/tmp/whatever-pause-test-2.png'));
      resumeCapture();
      const saved = await screenshotUnlessCredentialShaped(0, '/tmp/whatever-pause-test-2.png');
      assert.equal(saved, '/tmp/whatever-pause-test-2.png');
      assert.equal(calls.screenshot, 1);
      fs.rmSync(saved, { force: true });
    });
  });
});
