/**
 * Behavioral tests for formatActionResponse's handling of the `midFlight`
 * wrapper shape (mcp/src/response-format.ts, compiled to
 * mcp/dist/response-format.js).
 *
 * obra/superpowers-chrome#53: when `clickWithCapture`, `fillWithCapture`,
 * `selectOptionWithCapture` or `evaluateWithCapture` opens a native dialog,
 * `withDialogAwarenessForSession` (skills/browsing/lib/dialogs.js) wraps the
 * result as `{ midFlight, actionResult, dialog, artifacts }`.
 * `formatActionResponse` didn't know that shape: it read `url`, `pageSize`,
 * `capturePrefix` and `credentialSuppressed` off the top level, where they
 * are all undefined on a midFlight wrapper, so the agent got
 * `Current URL: unknown` and a `Files: ???.html, ...` line instead of the
 * dialog artifacts and the dialog::accept/dialog::dismiss instructions. This
 * file pins the fix: a midFlight result renders the same way
 * formatCaptureResponse's null-capture dialog branch does.
 *
 * mcp/dist/response-format.js is emitted directly by `tsc` as a plain,
 * side-effect-free ES module, so it can be imported here without booting
 * Chrome or an MCP server.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { formatActionResponse, formatEvalDescription } = await import(path.join(__dirname, '..', 'mcp', 'dist', 'response-format.js'));
const { CREDENTIAL_SUPPRESSED_NOTICE } = require(
  path.join(__dirname, '..', 'skills', 'browsing', 'lib', 'credential-guard.js')
);

const DIALOG_MARKDOWN = [
  '# Dialog: alert',
  'Tab origin: https://example.test',
  '',
  '> Are you sure?',
  '',
  'Buttons:',
  '  - dialog::accept   (OK)',
].join('\n');

describe('formatActionResponse: midFlight wrapper (click/select/eval opened a dialog)', () => {
  it('renders the dialog artifacts and instructions instead of "Current URL: unknown"', () => {
    const text = formatActionResponse(
      {
        midFlight: true,
        actionResult: { consoleLog: [] },
        dialog: { kind: 'alert' },
        artifacts: { markdown: DIALOG_MARKDOWN },
      },
      'Clicked: #open-alert'
    );

    assert.ok(text.includes('dialog::accept'), `accept instruction missing from: ${text}`);
    assert.ok(text.includes('Dialog is now open'), `dialog-open framing missing from: ${text}`);
    assert.ok(!text.includes('Current URL: unknown'), `regressed to the capture-shaped fallback: ${text}`);
    assert.ok(!text.includes('???.html'), `regressed to the capture-shaped fallback: ${text}`);
    assert.ok(!text.includes('Dialog opened:'), `fallback line appended despite artifacts: ${text}`);
  });

  it('surfaces the credential-suppressed notice when the wrapped actionResult carries it', () => {
    const text = formatActionResponse(
      {
        midFlight: true,
        actionResult: { credentialSuppressed: true },
        dialog: { kind: 'alert' },
        artifacts: { markdown: '# Dialog: alert\n\n> [REDACTED credential-shaped]\n' },
      },
      'Clicked: #open-alert'
    );

    assert.ok(text.includes(CREDENTIAL_SUPPRESSED_NOTICE), `notice missing from: ${text}`);
  });

  it('falls back to "Dialog opened: <kind>" only when no artifacts were supplied at all', () => {
    const text = formatActionResponse(
      { midFlight: true, actionResult: {}, dialog: { kind: 'confirm' } },
      'Clicked: #x'
    );
    assert.ok(text.includes('Dialog opened: confirm'));
  });

  it('leaves the non-midFlight (normal capture) path unchanged', () => {
    const text = formatActionResponse(
      {
        url: 'https://example.test/',
        pageSize: { width: 800, height: 600 },
        sessionDir: '/tmp/whatever',
        capturePrefix: 'click-1',
        domSummary: 'Interactive: 0 buttons',
        consoleLog: [],
      },
      'Clicked: #ok'
    );
    assert.ok(text.includes('Current URL: https://example.test/'));
    assert.ok(text.includes('Files: click-1.html'));
  });
});

describe('formatEvalDescription: the eval result survives the midFlight wrapper', () => {
  it('reads the value from the wrapped actionResult when the eval opened a dialog', () => {
    const text = formatEvalDescription('setTimeout(() => alert("x"), 0), 42', {
      midFlight: true,
      actionResult: { result: 42 },
      dialog: { kind: 'alert' },
      artifacts: { markdown: DIALOG_MARKDOWN },
    });
    assert.equal(text, 'Evaluated: setTimeout(() => alert("x"), 0), 42\nResult: 42');
  });

  it('reads the value from the top level on the normal capture path', () => {
    const text = formatEvalDescription('1 + 1', { result: 2, url: 'https://example.test/' });
    assert.equal(text, 'Evaluated: 1 + 1\nResult: 2');
  });
});
