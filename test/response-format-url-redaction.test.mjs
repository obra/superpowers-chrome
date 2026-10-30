/**
 * Unit tests for formatActionResponse's "Current URL:" redaction
 * (mcp/src/response-format.ts, compiled to mcp/dist/response-format.js).
 *
 * PRI-3265 (child): this line was unconditional before this change -- a
 * token revealed only by the URL itself (a password-reset / magic-link
 * flow) reached the agent here even when the rest of the capture was
 * suppressed. These are direct unit tests of the pure formatter (no real
 * Chrome needed, following response-format-capture-pause.test.mjs's own
 * pattern for the same function) covering both signals it's gated on:
 * capture.js's already-computed credentialSuppressed flag (the marker/
 * credential-shape case) and a direct urlLooksSensitive(actionResult.url)
 * check (the case no capture-layer signal happened to cover, e.g.
 * navigation.js's catch branch, where credentialSuppressed is never set
 * at all).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { formatActionResponse, REDACTED_LABEL } =
  await import(path.join(__dirname, '..', 'mcp', 'dist', 'response-format.js'));

const SENSITIVE_URL = 'https://example.com/account/settings/2fa_app';
const PLAIN_URL = 'https://example.test/';

describe('formatActionResponse: "Current URL:" redaction (PRI-3265)', () => {
  it('redacts Current URL when credentialSuppressed is set (marker/credential-shape case)', () => {
    const text = formatActionResponse(
      {
        url: PLAIN_URL, // URL itself is ordinary -- credentialSuppressed alone must trigger this
        credentialSuppressed: true,
        suppressedReason: 'credential-shape',
        pageSize: { width: 800, height: 600 },
        capturePrefix: '001-click',
        sessionDir: '/tmp/x',
        files: {},
      },
      'Clicked: #button',
    );
    assert.match(text, new RegExp(`Current URL: \\[redacted: secret page\\]`));
    assert.ok(!text.includes(PLAIN_URL));
  });

  it('redacts Current URL when the URL itself looks sensitive, even with no credentialSuppressed flag at all', () => {
    // Shape navigation.js's catch branch produces (capturePageArtifacts
    // threw, e.g. a screenshot failure): { frameId, url, error } -- no
    // credentialSuppressed field exists on this result at all.
    const text = formatActionResponse(
      { url: SENSITIVE_URL, files: {} },
      'Clicked: #button',
    );
    assert.equal(text.split('\n').find((l) => l.startsWith('Current URL: ')), `Current URL: ${REDACTED_LABEL}`);
    assert.ok(!text.includes(SENSITIVE_URL));
  });

  it('unpaused, unsuppressed, ordinary URL (sanity): Current URL still prints in full (unchanged behavior)', () => {
    const text = formatActionResponse(
      { url: PLAIN_URL, pageSize: { width: 800, height: 600 }, capturePrefix: '001-click', sessionDir: '/tmp/x', files: { html: 'a.html', markdown: 'a.md', screenshot: 'a.png', consoleLog: 'a-console.txt' } },
      'Clicked: #button',
    );
    assert.match(text, new RegExp(`Current URL: ${PLAIN_URL.replace(/[.]/g, '\\.')}`));
  });
});
