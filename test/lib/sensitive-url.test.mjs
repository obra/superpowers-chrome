import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('sensitive-url', () => {
  // Fresh require per test when the env var matters, since the module
  // caches nothing stateful -- extraPatterns() reads process.env on every
  // call, so no cache-busting is actually needed, but clearing the env
  // var after each test keeps tests order-independent regardless.
  const ENV_VAR = 'SUPERPOWERS_CHROME_SENSITIVE_URL_PATTERNS';
  const orig = process.env[ENV_VAR];
  afterEach(() => {
    if (orig === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = orig;
  });

  const { urlLooksSensitive } = require('../../skills/browsing/lib/sensitive-url.js');

  it('matches Slack\'s real 2FA setup page path', () => {
    assert.equal(urlLooksSensitive('https://acme.slack.com/account/settings/2fa_app'), true);
  });

  for (const path of [
    '/account/settings/2fa_app',
    '/settings/two-factor',
    '/settings/two_factor',
    '/mfa/setup',
    '/totp/verify',
    '/security/keys',
    '/account/recovery-codes',
    '/account/recovery_codes',
    '/account/backup-codes',
    '/account/backup_codes',
  ]) {
    it(`matches sensitive path ${path}`, () => {
      assert.equal(urlLooksSensitive(`https://example.test${path}`), true, path);
    });
  }

  for (const path of [
    '/',
    '/dashboard',
    '/account/settings',
    '/login',
    '/confirmation',
    '/profile',
  ]) {
    it(`does not match ordinary path ${path}`, () => {
      assert.equal(urlLooksSensitive(`https://example.test${path}`), false, path);
    });
  }

  it('matches a sensitive query string even on an otherwise-generic path', () => {
    assert.equal(urlLooksSensitive('https://example.test/settings?tab=security%2Fkeys'), false);
    // The query string is matched verbatim (not decoded), so an
    // unencoded sensitive fragment in it still matches.
    assert.equal(urlLooksSensitive('https://example.test/settings?section=/mfa'), true);
  });

  it('returns false for non-string or empty input, never throws', () => {
    assert.equal(urlLooksSensitive(undefined), false);
    assert.equal(urlLooksSensitive(null), false);
    assert.equal(urlLooksSensitive(''), false);
    assert.equal(urlLooksSensitive(42), false);
  });

  it('falls back to matching the raw string for an unparseable URL instead of throwing', () => {
    assert.equal(urlLooksSensitive('not a url but mentions /2fa anyway'), true);
    assert.equal(urlLooksSensitive('not a url, nothing sensitive'), false);
  });

  it('is additive, not a replacement: the env var only widens the default list', () => {
    assert.equal(urlLooksSensitive('https://example.test/widget-setup'), false);
    process.env[ENV_VAR] = 'widget-setup';
    assert.equal(urlLooksSensitive('https://example.test/widget-setup'), true);
    // The defaults still apply even with the env var set.
    assert.equal(urlLooksSensitive('https://example.test/account/settings/2fa_app'), true);
  });

  it('ignores a malformed extra pattern instead of throwing', () => {
    process.env[ENV_VAR] = '(unterminated[';
    assert.equal(urlLooksSensitive('https://example.test/dashboard'), false);
  });
});
