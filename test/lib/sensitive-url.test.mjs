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

  // jc finding 8: /2fa, /totp, security-keys and security-info were still
  // unanchored PREFIXES (no word-boundary check at all on the open suffix
  // side), so each one also matched a longer, unrelated word that merely
  // happens to start with the same letters, with no separator of any
  // kind in between.
  describe('word-boundary false positives (jc finding 8): a longer unrelated word must not match', () => {
    const falsePositives = [
      ['/2fast', '2fa'],
      ['/totpal', 'totp'],
      ['/security-keyset-docs', 'security-keys'],
      ['/security-informant', 'security-info'],
    ];
    for (const [path, word] of falsePositives) {
      it(`${path} does not match (not a real ${word} route, just a longer word)`, () => {
        assert.equal(urlLooksSensitive(`https://example.test${path}`), false, path);
      });
    }
  });

  // The word-boundary fix must not regress the segment-or-segment-prefix
  // shape the task calls out explicitly, nor the real routes that need an
  // open (separator-joined) suffix.
  describe('word-boundary fix keeps matching real segment/segment-prefix routes', () => {
    const stillMatches = [
      '/settings/2fa', // whole final segment
      '/2fa/setup', // segment prefix followed by "/"
      '/account/settings/2fa_app', // segment prefix followed by "_" (Slack's real route)
      '/totp/verify',
    ];
    for (const path of stillMatches) {
      it(`${path} still matches`, () => {
        assert.equal(urlLooksSensitive(`https://example.test${path}`), true, path);
      });
    }

    it('a security-keys hash anchor with no leading slash still matches (word boundary allows a non-alphanumeric left edge)', () => {
      assert.equal(urlLooksSensitive('https://example.test/settings#security-keys'), true);
    });
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

  // PRI-3360 round 3 (Reeve): host-qualified patterns -- see
  // sensitive-url.js's module comment for why these are matched against
  // hostname+pathname+hash rather than pathname alone (the path segment
  // alone, on each of these, is too ordinary a word to accept matching
  // on any site the way "backup-codes"/"totp" are).
  describe('host-qualified patterns (hostname + pathname, not pathname alone)', () => {
    it("matches Slack's App-Level Tokens page (api.slack.com/apps/<id>/general)", () => {
      assert.equal(urlLooksSensitive('https://api.slack.com/apps/A01234ABCD/general'), true);
    });

    it('does not match an unrelated site with the same path shape ("apps"/"general" alone are too generic)', () => {
      assert.equal(urlLooksSensitive('https://example.test/apps/123/general'), false);
    });

    it('does not match a DIFFERENT tab on the same Slack app (only /general is the token page)', () => {
      assert.equal(urlLooksSensitive('https://api.slack.com/apps/A01234ABCD/oauth'), false);
    });

    for (const path of ['/settings/tokens', '/settings/tokens/new', '/settings/personal-access-tokens']) {
      it(`matches GitHub's personal access token page (github.com${path})`, () => {
        assert.equal(urlLooksSensitive(`https://github.com${path}`), true);
      });
    }

    it('does not match an unrelated site with a "/settings/tokens" path ("tokens" alone is too generic)', () => {
      assert.equal(urlLooksSensitive('https://example.test/settings/tokens'), false);
    });

    it("matches Google's App Passwords page (myaccount.google.com/apppasswords)", () => {
      assert.equal(urlLooksSensitive('https://myaccount.google.com/apppasswords'), true);
    });

    it("matches Linear's personal API keys page (linear.app/settings/account/security)", () => {
      assert.equal(urlLooksSensitive('https://linear.app/settings/account/security'), true);
    });

    it('does not match an unrelated site with the same generic settings path', () => {
      assert.equal(urlLooksSensitive('https://example.test/settings/account/security'), false);
    });

    it('a malformed URL (no parseable hostname) never matches a host-qualified pattern', () => {
      // DEFAULT_SENSITIVE_URL_PATTERNS (pathname-only) can still match a
      // raw, unparseable string -- but DEFAULT_SENSITIVE_HOST_PATH_PATTERNS
      // never does, since there's no reliable hostname to qualify
      // against (see urlLooksSensitive's catch block).
      assert.equal(urlLooksSensitive('github.com/settings/tokens'), false);
    });
  });
});

// PRI-3360: pageTextReadRefused -- the whole-page text-read gate for
// eval/extract/attr. (isWholePageSelector was retired in round 2 of jc's
// review -- whole-page-ness is now decided by resolving the selector IN
// THE PAGE and checking the resulting element, not by matching the
// selector STRING; see extraction.js's resolveIsWholePage and its own
// tests in test/lib/extraction.test.mjs for :root/*/html/body/html > body
// coverage.)
describe('pageTextReadRefused', () => {
  const { pageTextReadRefused } = require('../../skills/browsing/lib/sensitive-url.js');
  const CRED_ENV = 'SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE';
  afterEach(() => { delete process.env[CRED_ENV]; });

  // A minimal page-session fake: dispatches Runtime.evaluate by
  // expression content, the same discrimination extraction.test.mjs uses,
  // since pageTextReadRefused issues up to three DIFFERENT evaluate calls
  // (URL, marker, visible-text -- the last one checked against BOTH the
  // credential-shape pattern and code-list density/keyword) that a single
  // canned response can't usefully distinguish.
  function makePs({ url = 'https://example.test/dashboard', marker = false, text = 'Welcome to the dashboard.' } = {}) {
    const calls = [];
    return {
      calls,
      send: async (method, params) => {
        calls.push({ method, params });
        if (method !== 'Runtime.evaluate') return { result: { value: undefined } };
        const expr = params.expression;
        if (expr === 'location.href') return { result: { value: url } };
        if (expr.includes('hasMarker')) return { result: { value: marker } };
        if (expr.includes('__senVisibleText')) return { result: { value: text } };
        return { result: { value: undefined } };
      },
    };
  }

  it('allows a plain page (no URL match, no marker, no code density)', async () => {
    assert.equal(await pageTextReadRefused(makePs(), 'eval'), null);
  });

  it('refuses on a known-sensitive URL, with a message steering to an element-scoped read', async () => {
    const refusal = await pageTextReadRefused(
      makePs({ url: 'https://acme.slack.com/account/settings/2fa_app' }),
      'eval'
    );
    assert.match(refusal, /eval refused/);
    assert.match(refusal, /sensitive/i);
    assert.match(refusal, /ELEMENT-SCOPED/);
    assert.match(refusal, /button|status message|error-banner/i);
  });

  it('refuses when a live data-sen-secret marker is present, even off the URL list', async () => {
    const refusal = await pageTextReadRefused(makePs({ marker: true }), 'extract');
    assert.match(refusal, /extract refused/);
    assert.match(refusal, /data-sen-secret/);
  });

  it('refuses via the code-list density signal, on a page off the URL list with no marker, when a backup/recovery keyword is near the code cluster', async () => {
    const codeDenseText = 'Save these backup codes: 7f3k-9d2m a83f-29dk qq1z-88mn x0p4-rr3e 8k2j-m9vd zz91-3bqa';
    const refusal = await pageTextReadRefused(makePs({ text: codeDenseText }), 'attr');
    assert.match(refusal, /attr refused/);
    assert.match(refusal, /dense list of secret-shaped codes/);
  });

  // PRI-3360 round 3 (Reeve) briefly added a fourth signal here --
  // containsCredentialShaped on the page's own visible text, unconditional
  // -- specifically to catch a lone credential-shaped token with no other
  // signal. Round 4 (jc) removed it again: it false-positived on an
  // UNLISTED page that legitimately prints example token strings (Slack's
  // own token-types documentation -- see
  // test/lib/fixtures/code-list-negatives/ and
  // test/credential-guard-mcp.test.mjs's "Slack token-types docs page"
  // coverage). A lone token with nothing else wrong on the page is now
  // eval's job specifically, checked AFTER running and only on a page
  // whose URL is ALREADY on the sensitive-URL list -- see
  // credential-guard.js's valueLeaksSecret and capture.js's
  // evaluateWithCapture. extractPageText/getSanitizedHtml's whole-page
  // form (this function's other two callers) never gets this check at
  // all, by design: they have no narrower, value-blind fallback the way
  // eval's "check a length/boolean instead" advice does.
  it('does NOT refuse a whole-page read on a lone credential-shaped token alone, off the URL list, with no marker and no code-list density', async () => {
    // Assembled from parts at runtime, like FAKE_TOKEN elsewhere in this
    // codebase, so no complete token-shaped literal sits in the source
    // (GitHub push protection rejects those even when obviously fake).
    const fakeToken = ['xoxb', '1111111111', '2222222222', 'FAKEfakeFAKEfakeFAKEfake'].join('-');
    const tokenOnlyText = `Your new bot token: ${fakeToken}`;
    assert.equal(await pageTextReadRefused(makePs({ text: tokenOnlyText }), 'extract'), null);
  });

  // PRI-3360 round 2 (jc review of #65): density ALONE, with no nearby
  // backup/recovery cue, must NOT refuse a whole-page read on its own --
  // this is exactly the false-positive jc found on ordinary pages (GitHub
  // PR/repo/REST-docs, HN) whose visible text happens to cluster densely
  // for reasons that have nothing to do with a secret.
  it('does NOT refuse on code density alone with no nearby backup/recovery keyword', async () => {
    const codeDenseTextNoKeyword = '7f3k-9d2m a83f-29dk qq1z-88mn x0p4-rr3e 8k2j-m9vd zz91-3bqa';
    assert.equal(await pageTextReadRefused(makePs({ text: codeDenseTextNoKeyword }), 'attr'), null);
  });

  it('is not overridable from anything the agent controls: only credentialCaptureAllowed() (an env var read once at process startup) can suppress it', async () => {
    const ps = makePs({ url: 'https://acme.slack.com/account/settings/2fa_app' });
    assert.notEqual(await pageTextReadRefused(ps, 'eval'), null);
    process.env[CRED_ENV] = '1';
    assert.equal(await pageTextReadRefused(ps, 'eval'), null);
    // The refusal message itself documents that this is operator-only,
    // not something settable mid-session.
    delete process.env[CRED_ENV];
    const refusal = await pageTextReadRefused(ps, 'eval');
    assert.match(refusal, /cannot be lifted by the agent at runtime/);
    assert.match(refusal, /no tool call, page script, or eval expression/);
  });
});
