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

  // Round 3 (jc finding 2): segment-anchoring two_factor to
  // (^|/)two[-_]?factor(/|$) -- the fix for "mfa"'s over-suppression --
  // silently broke every one of these real 2FA setup routes, none of
  // which have "two_factor"/"two-factor" as its OWN whole path segment.
  for (const [site, url] of [
    ['GitHub', 'https://github.com/settings/two_factor_authentication/setup/intro'],
    ['GitLab', 'https://gitlab.com/-/profile/two_factor_auth'],
    ['1Password', 'https://my.1password.com/settings/two-factor-authentication'],
  ]) {
    it(`matches ${site}'s real 2FA settings route`, () => {
      assert.equal(urlLooksSensitive(url), true, url);
    });
  }

  // Round 3 (jc finding 3): a data: URL's `pathname` IS the percent-
  // encoded document body, not a path -- the real-Chrome #init_key_code
  // end-to-end test's own fixture title ("Set up two-step verification")
  // leaked into that pathname and self-triggered suppression via the
  // unanchored two[-_]?step pattern, failing the PR's own headline test.
  describe('never matches data:, blob: or about: URLs (their "pathname" is not a page location)', () => {
    it('a data: URL whose body happens to contain sensitive-looking text', () => {
      const url = 'data:text/html,' + encodeURIComponent('<title>Set up two-step verification</title><span id="init_key_code">SEED</span>');
      assert.equal(urlLooksSensitive(url), false, url);
    });

    it('a blob: URL', () => {
      assert.equal(urlLooksSensitive('blob:https://example.com/2fa-setup-abc123'), false);
    });

    it('an about: URL', () => {
      assert.equal(urlLooksSensitive('about:blank'), false);
    });
  });

  it('still matches a file:// URL\'s real path (unlike data:/blob:/about:, its pathname is a real location)', () => {
    assert.equal(urlLooksSensitive('file:///tmp/fixture/account/settings/2fa_app/index.html'), true);
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

  it('does NOT match based on the query string alone (matches path/hash segments only)', () => {
    // This test used to be named 'matches a sensitive query string...' and
    // asserted true for the second case below, even though the query
    // string was never actually part of the matched target for the
    // security-keys case right above it -- the test's own name
    // contradicted its first assertion. The query string is now
    // deliberately excluded from the match target entirely (see the
    // module comment: a query value like `next=/settings/2fa` describes a
    // REDIRECT TARGET, not the current page), so both cases are false.
    assert.equal(urlLooksSensitive('https://example.test/settings?tab=security%2Fkeys'), false);
    assert.equal(urlLooksSensitive('https://example.test/settings?section=/mfa'), false);
  });

  it('does not over-suppress a login redirect whose NEXT-page query value happens to mention a sensitive path', () => {
    // jc finding 3/9: /login?next=/settings/2fa must not be suppressed --
    // /login itself is an ordinary page; the "2fa" text lives entirely in
    // a query value describing where the user goes AFTER login, not the
    // current page's own content.
    assert.equal(urlLooksSensitive('https://example.test/login?next=/settings/2fa'), false);
  });

  it('does not over-suppress a docs page merely ABOUT mfa (bare-prefix, no segment boundary)', () => {
    // jc finding 3/9: an unanchored "/mfa" prefix also matched this docs
    // URL. "mfa" must be its own path segment, not a prefix of a longer,
    // unrelated slug.
    assert.equal(urlLooksSensitive('https://example.test/docs/mfa-best-practices'), false);
  });

  it('matches a hash-routed SPA whose real route lives entirely after the #', () => {
    // jc finding 3: urlLooksSensitive used to match only pathname+search,
    // so a hash-routed single-page app (no full page load per route)
    // never matched at all, no matter what the hash said.
    assert.equal(urlLooksSensitive('https://app.example.test/#/account/2fa'), true);
  });

  it("matches AWS IAM's real hash-routed MFA management route", () => {
    assert.equal(
      urlLooksSensitive('https://console.aws.amazon.com/iam/home#/security_credentials/mfa'),
      true
    );
  });

  it("matches Google's real /two-step-verification route (one hyphenated slug, not its own path segment)", () => {
    assert.equal(
      urlLooksSensitive('https://myaccount.google.com/signinoptions/two-step-verification'),
      true
    );
  });

  it('matches a security-keys hash anchor with no leading slash', () => {
    assert.equal(urlLooksSensitive('https://example.test/settings#security-keys'), true);
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
