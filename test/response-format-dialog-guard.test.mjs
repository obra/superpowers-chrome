/**
 * Behavioral tests for formatCaptureResponse's dialog-suppression path
 * (mcp/src/response-format.ts, compiled to mcp/dist/response-format.js).
 *
 * obra/superpowers-chrome#51 added a credential guard for native-dialog
 * messages (alert/confirm/prompt/beforeunload can render a token via
 * page-controlled JS). The first version of that guard, when a dialog's
 * message was credential-shaped, dropped `artifacts` entirely — so the
 * agent only ever saw `Dialog opened: alert`, losing both the
 * dialog::accept/dismiss instructions and the ⚠️ suppression notice
 * (`credentialSuppressed` was on the discarded `capture` object, never
 * read from the top-level result when `capture` is null). This file pins
 * the fix: suppression must still surface the redacted response, the
 * notice, and the instructions — it may only suppress the disk write
 * (that guarantee is covered separately in
 * test/lib/capture-credential-guard.test.mjs, which drives capture.js
 * itself and asserts no files land on disk).
 *
 * mcp/dist/response-format.js is emitted directly by `tsc` as a plain,
 * side-effect-free ES module (see its header comment), so it can be
 * imported here without booting Chrome or an MCP server — unlike
 * mcp/dist/index.js, which runs main() as an unconditional side effect of
 * being imported.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { formatCaptureResponse } = await import(path.join(__dirname, '..', 'mcp', 'dist', 'response-format.js'));
const { CREDENTIAL_SUPPRESSED_NOTICE } = require(
  path.join(__dirname, '..', 'skills', 'browsing', 'lib', 'credential-guard.js')
);

// Fake token, assembled at runtime so no complete token-shaped literal sits
// in the source (GitHub push protection rejects real-looking secrets even
// in test fixtures).
const FAKE_TOKEN = 'xoxb-' + '1234567890123-FAKEfaketoken000000000000';

// The shape capture.js's captureActionWithDiff returns for the AFTER-dialog
// short-circuit when the dialog's message is credential-shaped: `capture`
// is null, but `artifacts` (with the dialog::accept/dismiss instructions)
// and `dialog` (stripped to `kind`) still come back — only the disk write
// was suppressed.
const SUPPRESSED_DIALOG_ARTIFACTS = {
  markdown: [
    '# Dialog: alert',
    'Tab origin: https://example.test',
    '',
    `> Your new bot token is ${FAKE_TOKEN}`,
    '',
    'Buttons:',
    '  - dialog::accept   (OK)',
    '',
    'To interact:',
    '  click selector="dialog::accept"',
  ].join('\n'),
};

describe('formatCaptureResponse: suppressed after-dialog short-circuit (capture=null)', () => {
  it('includes the notice, the dialog::accept instructions, and the (unredacted-here) message', () => {
    const text = formatCaptureResponse(
      'Clicked',
      '#open-alert',
      null,
      { kind: 'alert' },
      SUPPRESSED_DIALOG_ARTIFACTS,
      /* credentialSuppressed */ true
    );

    assert.ok(text.includes(CREDENTIAL_SUPPRESSED_NOTICE), `notice missing from: ${text}`);
    assert.ok(text.includes('dialog::accept'), `accept instruction missing from: ${text}`);
    assert.ok(text.includes('Dialog is now open'), `dialog-open framing missing from: ${text}`);
    // formatCaptureResponse itself doesn't redact — that's redactUnlessAllowed's
    // job, applied once to the whole tool response in mcp/src/index.ts. Here
    // the raw message legitimately passes through this function.
    assert.ok(text.includes(FAKE_TOKEN));
  });

  it('never falls back to the bare "Dialog opened: <kind>" line when artifacts are present', () => {
    const text = formatCaptureResponse(
      'Clicked', '#open-alert', null, { kind: 'alert' }, SUPPRESSED_DIALOG_ARTIFACTS, true
    );
    assert.ok(!text.includes('Dialog opened: alert'), `regressed to the bare fallback: ${text}`);
  });

  it('omits the notice for a benign (non-suppressed) dialog', () => {
    const text = formatCaptureResponse(
      'Clicked',
      '#open-alert',
      null,
      { kind: 'confirm' },
      { markdown: '# Dialog: confirm\n\n> Are you sure?\n\nButtons:\n  - dialog::accept\n  - dialog::dismiss' },
      /* credentialSuppressed */ false
    );
    assert.ok(!text.includes(CREDENTIAL_SUPPRESSED_NOTICE), `unexpected notice in: ${text}`);
    assert.ok(text.includes('dialog::accept') && text.includes('dialog::dismiss'));
  });

  it('falls back to "Dialog opened: <kind>" only when no artifacts were supplied at all', () => {
    const text = formatCaptureResponse('Clicked', '#x', null, { kind: 'alert' });
    assert.ok(text.includes('Dialog opened: alert'));
  });
});

describe('formatCaptureResponse: suppressed capture (capture.credentialSuppressed, non-dialog)', () => {
  it('still reports the notice and no file list (regression guard, pre-existing behavior)', () => {
    const text = formatCaptureResponse('Clicked', '#x', {
      sessionDir: '/tmp/whatever',
      files: {},
      diffSummary: '',
      domSummary: 'Interactive: 0 buttons\nLayout: body',
      pageSize: { width: 800, height: 600 },
      credentialSuppressed: true,
    });
    assert.ok(text.includes(CREDENTIAL_SUPPRESSED_NOTICE));
    assert.ok(!text.includes('Capture saved to'));
  });
});
