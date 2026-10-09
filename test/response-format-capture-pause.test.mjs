/**
 * Behavioral tests for the three response formatters' handling of
 * `capturePaused` (mcp/src/response-format.ts, compiled to
 * mcp/dist/response-format.js).
 *
 * Pins each paused branch directly, against the shape its real caller in mcp/src/index.ts actually produces:
 *   - formatCaptureFiles: the capturePaused:true branch (used standalone
 *     by formatActionResponse's non-midFlight path, and by the NAVIGATE
 *     case's inline response array).
 *   - formatActionResponse: the midFlight-while-paused wrapper shape
 *     (actionResult.actionResult.capturePaused), and the plain paused
 *     result shape (no midFlight), which must also skip the
 *     "Current URL"/"Size" lines rather than print placeholder values
 *    .
 *   - formatCaptureResponse: both the null-capture (dialog) paused shape
 *     and the normal paused capture shape.
 *
 * mcp/dist/response-format.js is emitted directly by `tsc` as a plain,
 * side-effect-free ES module, so it can be imported here without booting
 * Chrome or an MCP server.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { formatCaptureFiles, formatActionResponse, formatCaptureResponse, formatDialogRefusal } =
  await import(path.join(__dirname, '..', 'mcp', 'dist', 'response-format.js'));

const PAUSE_NOTICE_FRAGMENT = 'Capture is paused for this session';

describe('formatCaptureFiles: capturePaused', () => {
  it('shows the pause notice instead of a Files: ???.html/.md/.png/-console.txt line', () => {
    const lines = formatCaptureFiles({ capturePaused: true, files: null, capturePrefix: null, sessionDir: '/tmp/x' });
    assert.equal(lines.length, 1);
    assert.match(lines[0], new RegExp(PAUSE_NOTICE_FRAGMENT));
    assert.ok(!lines[0].includes('???'), 'must not fall through to the ???.html placeholder line');
  });

  it('capturePaused takes priority over credentialSuppressed if somehow both are set', () => {
    const lines = formatCaptureFiles({ capturePaused: true, credentialSuppressed: true, suppressedReason: 'credential-shape', files: null });
    assert.match(lines[0], new RegExp(PAUSE_NOTICE_FRAGMENT));
  });

  it('unpaused credentialSuppressed still shows its own notice (unchanged behavior)', () => {
    const lines = formatCaptureFiles({ credentialSuppressed: true, suppressedReason: 'credential-shape', files: null });
    assert.doesNotMatch(lines[0], new RegExp(PAUSE_NOTICE_FRAGMENT));
  });
});

describe('formatActionResponse: capturePaused', () => {
  it('plain paused result (no midFlight): shows the pause notice via formatCaptureFiles, and skips Current URL/Size', () => {
    // Shape clickWithCapture/fillWithCapture/selectOptionWithCapture/
    // evaluateWithCapture/setAttributeWithCapture/navigate actually produce
    // while paused: no url, no pageSize (capturePageArtifacts never read
    // the page), capturePaused:true, files:null.
    const text = formatActionResponse(
      { capturePaused: true, files: null, capturePrefix: null, sessionDir: '/tmp/x' },
      'Clicked: #button',
    );
    assert.match(text, new RegExp(PAUSE_NOTICE_FRAGMENT));
    assert.ok(!text.includes('Current URL:'), 'must not print "Current URL: unknown" while paused');
    assert.ok(!text.includes('Size:'), 'must not print "Size: undefined×undefined" while paused');
  });

  it('midFlight-while-paused wrapper: shows the pause notice, dialog kind only, and no dialog message', () => {
    // Shape dialogs.js's withDialogAwarenessForSession produces for a
    // dialog that opens mid-action while paused (see dialogs.test.mjs).
    const text = formatActionResponse(
      {
        midFlight: true,
        actionResult: { action: 'click', selector: '#button' },
        dialog: { kind: 'alert' },
        artifacts: null,
        capturePaused: true,
      },
      'Clicked: #button',
    );
    assert.match(text, /Dialog is now open/);
    assert.match(text, new RegExp(PAUSE_NOTICE_FRAGMENT));
    assert.match(text, /Dialog opened: alert/);
  });

  it('unpaused (sanity): Current URL and Size are still printed (unchanged behavior)', () => {
    const text = formatActionResponse(
      { url: 'https://example.test', pageSize: { width: 800, height: 600 }, capturePrefix: '001-click', sessionDir: '/tmp/x', files: { html: 'a.html', markdown: 'a.md', screenshot: 'a.png', consoleLog: 'a-console.txt' } },
      'Clicked: #button',
    );
    assert.match(text, /Current URL: https:\/\/example\.test/);
    assert.match(text, /Size: 800×600/);
  });
});

describe('formatCaptureResponse: capturePaused', () => {
  it('null-capture (dialog) branch: shows the pause notice instead of the rendered dialog markdown', () => {
    // Shape captureActionWithDiff produces for TYPE/HOVER/DRAG_DROP/... when
    // a dialog opens mid-action while paused: capture is null, dialog is
    // {kind} only, artifacts is null, capturePaused:true passed as the
    // trailing arg (see mcp/src/index.ts's TYPE case).
    const text = formatCaptureResponse(
      'Typed',
      'into #password',
      null,
      { kind: 'prompt' },
      null,
      false,
      undefined,
      true,
    );
    assert.match(text, new RegExp(PAUSE_NOTICE_FRAGMENT));
    assert.match(text, /Dialog is now open/);
    assert.ok(!text.includes('Dialog: prompt'), 'must not fall through to a rendered dialog markdown body');
  });

  it('normal (non-null) capture branch: shows the pause notice when capture.capturePaused is set', () => {
    // Shape captureActionWithDiff produces for a normal paused action (no
    // dialog): capture is a plain object with capturePaused:true and
    // files:{} (see capture.js's captureActionWithDiff pause branch).
    const text = formatCaptureResponse(
      'Hovered',
      '#button',
      { prefix: null, sessionDir: '/tmp/x', files: {}, capturePaused: true },
    );
    assert.match(text, new RegExp(PAUSE_NOTICE_FRAGMENT));
  });

  it('unpaused (sanity): credentialSuppressed still renders its own notice, not the pause one', () => {
    const text = formatCaptureResponse(
      'Hovered',
      '#button',
      null,
      { kind: 'alert' },
      { markdown: '# Dialog: alert' },
      true,
      'credential-shape',
    );
    assert.doesNotMatch(text, new RegExp(PAUSE_NOTICE_FRAGMENT));
  });
});

describe('formatDialogRefusal: paused refusal (artifacts: null)', () => {
  it('still names the dialog kind, and never a message', () => {
    const text = formatDialogRefusal({
      refused: true,
      message: 'Page is behind a dialog. Handle dialog::accept or dialog::dismiss first.',
      dialog: { kind: 'alert' },
      artifacts: null,
    });
    assert.match(text, /Dialog open: alert/);
    assert.match(text, /dialog::accept or dialog::dismiss/);
  });
});
