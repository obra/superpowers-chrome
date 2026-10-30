/**
 * Unit tests for tab-sensitivity.js's tabContentIsSensitive -- the shared
 * check mcp/src/index.ts's list_tabs/switch_tab/navigate use to decide
 * whether to redact a tab's title/url (PRI-3265 child, PR #70 follow-up).
 *
 * All dependencies are injected (attachTabSensitivity's own factory
 * signature), so these stub pageHasSecretMarker/getPageSession/
 * urlLooksSensitive directly -- no real Chrome, no CDP, no MCP server.
 */

import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { attachTabSensitivity } = require('../../skills/browsing/lib/tab-sensitivity.js');

describe('tabContentIsSensitive', () => {
  function build(overrides = {}) {
    return attachTabSensitivity({
      credentialCaptureAllowed: () => false,
      urlLooksSensitive: () => false,
      getPageSession: async () => ({}),
      pageHasSecretMarker: async () => false,
      ...overrides,
    }).tabContentIsSensitive;
  }

  it('fails CLOSED (treats the tab as sensitive) when pageHasSecretMarker throws', async () => {
    const tabContentIsSensitive = build({
      pageHasSecretMarker: async () => { throw new Error('Runtime.evaluate: Inspected target navigated or closed'); },
    });
    assert.equal(await tabContentIsSensitive(0, 'https://example.test/', 'page'), true);
  });

  it('fails CLOSED when getPageSession itself throws (the tab closed between getTabs() and here)', async () => {
    const tabContentIsSensitive = build({
      getPageSession: async () => { throw new Error('No tab at index 0'); },
    });
    assert.equal(await tabContentIsSensitive(0, 'https://example.test/', 'page'), true);
  });

  it('sanity: returns true on a live marker finding (no error)', async () => {
    const tabContentIsSensitive = build({ pageHasSecretMarker: async () => true });
    assert.equal(await tabContentIsSensitive(0, 'https://example.test/', 'page'), true);
  });

  it('sanity: returns false for an ordinary page with no marker and no error', async () => {
    const tabContentIsSensitive = build();
    assert.equal(await tabContentIsSensitive(0, 'https://example.test/', 'page'), false);
  });

  it('sanity: urlLooksSensitive alone is sufficient, with no CDP call at all', async () => {
    let getPageSessionCalled = false;
    const tabContentIsSensitive = build({
      urlLooksSensitive: () => true,
      getPageSession: async () => { getPageSessionCalled = true; return {}; },
    });
    assert.equal(await tabContentIsSensitive(0, 'https://example.com/account/settings/2fa_app', 'page'), true);
    assert.equal(getPageSessionCalled, false, 'urlLooksSensitive alone must short-circuit before any CDP call');
  });

  it('sanity: a non-page target type skips the marker check and is not sensitive by default', async () => {
    let getPageSessionCalled = false;
    const tabContentIsSensitive = build({
      getPageSession: async () => { getPageSessionCalled = true; return {}; },
    });
    assert.equal(await tabContentIsSensitive(0, 'https://example.test/', 'service_worker'), false);
    assert.equal(getPageSessionCalled, false);
  });

  it('sanity: SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE disables every check, including the fail-closed error path', async () => {
    const tabContentIsSensitive = build({
      credentialCaptureAllowed: () => true,
      urlLooksSensitive: () => true,
      pageHasSecretMarker: async () => { throw new Error('would normally fail closed'); },
    });
    assert.equal(await tabContentIsSensitive(0, 'https://example.com/2fa_app', 'page'), false);
  });
});
