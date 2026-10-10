// Unit tests for the credential-shaped content detector that gates
// auto-capture. Every token string here is an obviously fake,
// token-SHAPED value — none is a real credential.
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { afterEach, describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const {
  containsCredentialShaped,
  hasKnownTokenPrefix,
  hasLongMixedAlnumRun,
  stringLooksLikeSecret,
  valueLeaksSecret,
  redactCredentialShaped,
  credentialCaptureAllowed,
  REDACTION,
} = require('../../skills/browsing/lib/credential-guard.js');

// Fake, token-shaped fixtures. Built from repeated filler so they are
// visibly not real.
// Fake tokens are assembled from prefix + body at runtime so no complete
// token-shaped literal sits in the source (GitHub push protection rejects
// those even when they are obviously fake).
const fake = (prefix, body) => `${prefix}${body}`;
const FAKE = {
  slackBot: fake('xoxb', '-1111111111-2222222222-FAKEfakeFAKEfakeFAKEfake'),
  slackUser: fake('xoxp', '-1111111111-2222222222-3333333333-FAKEfakeFAKEfakeFAKEfakeFAKEfake'),
  slackApp: fake('xoxa', '-2-FAKEfakeFAKEfakeFAKEfake1111'),
  slackOauthRefresh: fake('xoxr', '-FAKEfakeFAKEfakeFAKEfake1111'),
  slackLegacy: fake('xoxs', '-1111111111-FAKEfakeFAKEfakeFAKE'),
  slackOther: fake('xoxo', '-1111111111-FAKEfakeFAKEfakeFAKE'),
  slackRotatingDot: fake('xoxe.xoxb', '-1-FAKEfakeFAKEfakeFAKEfakeFAKEfake'),
  slackRotatingDash: fake('xoxe', '-1-FAKEfakeFAKEfakeFAKEfakeFAKEfake1111'),
  slackAppLevel: fake('xapp', '-1-A0FAKEFAKE1-1111111111111-fakefakefakefakefakefakefakefake'),
  githubClassic: fake('ghp', `_${'F'.repeat(36)}`),
  githubOauth: fake('gho', `_${'F'.repeat(36)}`),
  githubUserToServer: fake('ghu', `_${'F'.repeat(36)}`),
  githubServerToServer: fake('ghs', `_${'F'.repeat(36)}`),
  githubRefresh: fake('ghr', `_${'F'.repeat(36)}`),
  githubFineGrained: fake('github_pat', `_11${'F'.repeat(20)}_${'f'.repeat(59)}`),
  onePasswordServiceAccount: fake('ops', `_eyJ${'FAKEfake'.repeat(8)}`),
  onePasswordSecretKey: fake('A3', '-FAKE11-FAKE22-FAKE3-FAKE4-FAKE5-FAKE6'),
  otpauthUri: fake('otpauth', '://totp/Slack:me@example.com?secret=FAKEFAKEFAKEFAKE2345&issuer=Slack'),
};

describe('containsCredentialShaped: true positives', () => {
  for (const [name, token] of Object.entries(FAKE)) {
    it(`matches ${name}`, () => {
      assert.equal(containsCredentialShaped(token), true, token);
    });
    it(`matches ${name} embedded in HTML`, () => {
      assert.equal(containsCredentialShaped(`<div><code>${token}</code></div>`), true);
    });
  }

  it('matches a token glued to preceding text, e.g. URL-encoded after %3E', () => {
    for (const token of Object.values(FAKE)) {
      assert.equal(containsCredentialShaped(`data:text/html,%3Ccode%3E${token}%3C%2Fcode%3E`), true, token);
      assert.equal(containsCredentialShaped(`token${token}`), true, token);
    }
  });

  it('matches an otpauth URI whose & is HTML-escaped', () => {
    const escaped = 'otpauth://totp/Slack?issuer=Slack&amp;secret=FAKEFAKEFAKEFAKE2345';
    assert.equal(containsCredentialShaped(`<img alt="${escaped}">`), true);
  });

  it('matches the data-sen-secret page marker on any element', () => {
    assert.equal(containsCredentialShaped('<span data-sen-secret>JBSWY3DPEHPK3PXP</span>'), true);
    assert.equal(containsCredentialShaped('<li class="code" data-sen-secret="backup">1234-5678</li>'), true);
    assert.equal(containsCredentialShaped('<DIV DATA-SEN-SECRET>x</DIV>'), true);
  });
});

describe('containsCredentialShaped: false positives', () => {
  const benign = [
    '',
    'Bot tokens start with xoxb- and user tokens with xoxp-.',
    'Use an xoxb-your-token here',
    'App-level tokens look like xapp-1-…',
    'Personal access tokens (ghp_…) and fine-grained tokens (github_pat_…) are supported.',
    `ghp_${'F'.repeat(20)}`,
    'github_pat_short',
    'Set OP_SERVICE_ACCOUNT_TOKEN to your ops_ token.',
    'shops_and_stops_are_not_tokens_at_all_even_when_they_are_long',
    'Your Secret Key starts with A3- and is in your Emergency Kit.',
    'A3-ABC-DEF',
    'Scan the QR code with your otpauth:// capable app.',
    '<p>The attribute data-sen-secret marks secrets.</p>',
    '<div data-sen-secretary="no">x</div>',
    '<html><body><h1>Hello world</h1><a href="/docs">docs</a></body></html>',
  ];
  for (const text of benign) {
    it(`does not match ${JSON.stringify(text).slice(0, 70)}`, () => {
      assert.equal(containsCredentialShaped(text), false);
    });
  }

  it('treats non-strings as not credential-shaped', () => {
    assert.equal(containsCredentialShaped(undefined), false);
    assert.equal(containsCredentialShaped(null), false);
    assert.equal(containsCredentialShaped(42), false);
  });

  it('is stateless across repeated calls (no lastIndex carry-over)', () => {
    for (let i = 0; i < 3; i++) {
      assert.equal(containsCredentialShaped(FAKE.slackBot), true);
    }
  });
});

describe('redactCredentialShaped', () => {
  it('replaces every credential-shaped match and keeps surrounding text', () => {
    const text = `bot=${FAKE.slackBot} app=${FAKE.slackAppLevel} gh=${FAKE.githubClassic} end`;
    const out = redactCredentialShaped(text);
    assert.equal(out, `bot=${REDACTION} app=${REDACTION} gh=${REDACTION} end`);
    assert.equal(REDACTION, '[REDACTED credential-shaped]');
  });

  it('redacts every pattern in the fixture set', () => {
    for (const token of Object.values(FAKE)) {
      const out = redactCredentialShaped(`before ${token} after`);
      assert.ok(!out.includes(token), `${token} survived redaction: ${out}`);
      assert.match(out, /^before \[REDACTED credential-shaped\]/);
    }
  });

  it('leaves benign text unchanged', () => {
    const text = 'Bot tokens start with xoxb- and 21+21 = 42';
    assert.equal(redactCredentialShaped(text), text);
  });

  it('passes non-strings through unchanged', () => {
    assert.equal(redactCredentialShaped(undefined), undefined);
    assert.equal(redactCredentialShaped(42), 42);
  });
});

describe('credentialCaptureAllowed', () => {
  const orig = process.env.SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE;
  afterEach(() => {
    if (orig === undefined) delete process.env.SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE;
    else process.env.SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE = orig;
  });

  it('defaults to false (safe)', () => {
    delete process.env.SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE;
    assert.equal(credentialCaptureAllowed(), false);
  });

  it('is true only for the value 1', () => {
    process.env.SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE = '1';
    assert.equal(credentialCaptureAllowed(), true);
    process.env.SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE = '0';
    assert.equal(credentialCaptureAllowed(), false);
    process.env.SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE = 'yes';
    assert.equal(credentialCaptureAllowed(), false);
  });
});

// PRI-3360 round 4 (jc + Reeve's final design): hasKnownTokenPrefix is
// rule 2 of the unified string check -- a bare PREFIX, no minimum
// trailing length, so a value TRUNCATED down to just its prefix still
// names itself even though it no longer matches containsCredentialShaped's
// full-shape regex (rule 1).
describe('hasKnownTokenPrefix', () => {
  it('matches a bare prefix with nothing after it', () => {
    assert.equal(hasKnownTokenPrefix('xoxb-'), true);
    assert.equal(hasKnownTokenPrefix('ghp_'), true);
    assert.equal(hasKnownTokenPrefix('lin_api_'), true);
  });

  it("matches Reeve's case: a token sliced down to its first 8 characters", () => {
    const fakeToken = fake('xoxb', '-1111111111-2222222222-FAKEfakeFAKEfakeFAKEfake');
    assert.equal(hasKnownTokenPrefix(fakeToken.slice(0, 8)), true);
  });

  it('matches at a word start mid-string, not just at index 0', () => {
    assert.equal(hasKnownTokenPrefix('Your token: xoxb-abc'), true);
  });

  it('does not match a prefix glued onto a preceding word character', () => {
    assert.equal(hasKnownTokenPrefix('faxoxb-abc'), false);
  });

  it('does not match ordinary text with no prefix at all', () => {
    assert.equal(hasKnownTokenPrefix('app_level_token_string'), false);
    assert.equal(hasKnownTokenPrefix('Skip to content'), false);
  });

  it('treats non-strings and empty strings as no match', () => {
    assert.equal(hasKnownTokenPrefix(''), false);
    assert.equal(hasKnownTokenPrefix(null), false);
    assert.equal(hasKnownTokenPrefix(undefined), false);
    assert.equal(hasKnownTokenPrefix(42), false);
  });
});

// Rule 4: jc's rule for a bare TOTP/HOTP seed with no prefix at all.
// Round 5 (jc + Reeve): narrowed to require a MIX of letters and digits
// in the run -- an all-digit or all-letter run of 6+ is exempt, since
// that's an ordinary DOM identifier shape, not a secret. A real base32
// seed always mixes the two by construction, so this doesn't weaken the
// seed detection at all.
describe('hasLongMixedAlnumRun', () => {
  it('matches a bare base32 TOTP seed', () => {
    assert.equal(hasLongMixedAlnumRun('JBSWY3DPEHPK3PXP'), true);
  });

  it('matches the SAME seed deliberately split into spaced groups', () => {
    assert.equal(hasLongMixedAlnumRun('JBSW Y3DP EHPK 3PXP'), true);
  });

  it('does not match a run with no digit in it at all', () => {
    assert.equal(hasLongMixedAlnumRun('abcdefghijklmnop'), false);
  });

  // Slack's own data-qa identifier for the App-Level Tokens row: an
  // all-digit suffix, 14 characters long -- an ordinary DOM id, not a
  // secret, must NOT trip this rule just because it is long.
  it("does not match an all-digit run, however long (Slack's app_level_tokens_row_<id> case)", () => {
    assert.equal(hasLongMixedAlnumRun('app_level_tokens_row_12277846587778'), false);
  });

  it('does not match an all-letter run, however long', () => {
    assert.equal(hasLongMixedAlnumRun('abcdefghijklmnopqrstuvwxyz'), false);
  });

  it('does not match a short run even with a digit', () => {
    assert.equal(hasLongMixedAlnumRun('a1b2'), false);
  });

  it('treats non-strings and empty strings as no match', () => {
    assert.equal(hasLongMixedAlnumRun(''), false);
    assert.equal(hasLongMixedAlnumRun(null), false);
    assert.equal(hasLongMixedAlnumRun(undefined), false);
  });
});

// stringLooksLikeSecret: the unified check (rules 1/2/4 unconditional,
// rule 3 gated by densityAloneSufficient).
describe('stringLooksLikeSecret', () => {
  it('allows an ordinary identifier-shaped string with no digit (jc test case)', () => {
    assert.equal(stringLooksLikeSecret('app_level_token_string'), false);
  });

  it('allows ordinary prose', () => {
    assert.equal(stringLooksLikeSecret('Welcome back, Jordan.'), false);
  });

  it('refuses a full-shape token (rule 1)', () => {
    assert.equal(stringLooksLikeSecret(fake('ghp', `_${'F'.repeat(36)}`)), true);
  });

  it('refuses a truncated token prefix (rule 2)', () => {
    assert.equal(stringLooksLikeSecret('xoxb-111'), true);
  });

  it('refuses a bare TOTP seed, spaced or not (rule 4)', () => {
    assert.equal(stringLooksLikeSecret('JBSWY3DPEHPK3PXP'), true);
    assert.equal(stringLooksLikeSecret('JBSW Y3DP EHPK 3PXP'), true);
  });

  it('rule 3 (density): requires a nearby keyword when densityAloneSufficient is false (the default)', () => {
    const codeDenseNoKeyword = '7f3k-9d2m,a83f-29dk,qq1z-88mn,x0p4-rr3e,8k2j-m9vd,zz91-3bqa'; // commas, not spaces, so whitespace-collapsing (rule 4) does not also trip here -- isolates rule 3 specifically.
    assert.equal(stringLooksLikeSecret(codeDenseNoKeyword), false);
    assert.equal(stringLooksLikeSecret(codeDenseNoKeyword, { densityAloneSufficient: false }), false);
  });

  it('rule 3 (density): density ALONE is enough when densityAloneSufficient is true', () => {
    const codeDenseNoKeyword = '7f3k-9d2m,a83f-29dk,qq1z-88mn,x0p4-rr3e,8k2j-m9vd,zz91-3bqa'; // commas, not spaces, so whitespace-collapsing (rule 4) does not also trip here -- isolates rule 3 specifically.
    assert.equal(stringLooksLikeSecret(codeDenseNoKeyword, { densityAloneSufficient: true }), true);
  });

  // PRI-3360 round 4: found while isolating rule 3 above, not asked for
  // in the design but worth recording -- a whitespace-SEPARATED code list
  // (spaces between pairs, like a backup-codes page would plausibly
  // render one) trips rule 4 on its own too, because collapsing the
  // spaces glues the tail of one pair onto the head of the next
  // ("...9d2m a83f..." -> "...9d2ma83f...", an 8-char run with digits).
  // Harmless here (a real backup-codes page SHOULD refuse either way),
  // but it means rules 3 and 4 are not as independent as their separate
  // numbering suggests for this common a layout.
  it('a whitespace-separated (not comma-separated) code list also trips rule 4 on its own, independent of rule 3', () => {
    const spaceSeparated = '7f3k-9d2m a83f-29dk qq1z-88mn x0p4-rr3e 8k2j-m9vd zz91-3bqa';
    assert.equal(hasLongMixedAlnumRun(spaceSeparated), true);
    assert.equal(stringLooksLikeSecret(spaceSeparated, { densityAloneSufficient: false }), true);
  });
});

// valueLeaksSecret: the recursive tree-walker eval's result goes
// through. Non-string/array/object values always pass -- exactly the
// types PRI-3360 round 4 keeps allowed through unconditionally.
describe('valueLeaksSecret', () => {
  it('allows numbers, booleans, null and undefined', () => {
    assert.equal(valueLeaksSecret(3), false);
    assert.equal(valueLeaksSecret(true), false);
    assert.equal(valueLeaksSecret(false), false);
    assert.equal(valueLeaksSecret(null), false);
    assert.equal(valueLeaksSecret(undefined), false);
  });

  it('allows an ordinary string', () => {
    assert.equal(valueLeaksSecret('app_level_token_string'), false);
  });

  it('refuses a bare token string', () => {
    const fakeToken = fake('xoxb', '-1111111111-2222222222-FAKEfakeFAKEfakeFAKEfake');
    assert.equal(valueLeaksSecret(fakeToken), true);
  });

  it('refuses an object with a NESTED token string', () => {
    const fakeToken = fake('xoxb', '-1111111111-2222222222-FAKEfakeFAKEfakeFAKEfake');
    assert.equal(valueLeaksSecret({ ok: true, meta: { token: fakeToken } }), true);
  });

  it('refuses an array containing a token string', () => {
    const fakeToken = fake('xoxb', '-1111111111-2222222222-FAKEfakeFAKEfakeFAKEfake');
    assert.equal(valueLeaksSecret(['fine', fakeToken]), true);
  });

  it('allows an object/array with no secret anywhere in it', () => {
    assert.equal(valueLeaksSecret({ ok: true, count: 3, label: 'Done' }), false);
    assert.equal(valueLeaksSecret(['fine', 'also fine', 3, true]), false);
  });

  it('passes densityAloneSufficient through to nested strings', () => {
    const codeDenseNoKeyword = '7f3k-9d2m,a83f-29dk,qq1z-88mn,x0p4-rr3e,8k2j-m9vd,zz91-3bqa'; // commas, not spaces, so whitespace-collapsing (rule 4) does not also trip here -- isolates rule 3 specifically.
    assert.equal(valueLeaksSecret({ text: codeDenseNoKeyword }, { densityAloneSufficient: false }), false);
    assert.equal(valueLeaksSecret({ text: codeDenseNoKeyword }, { densityAloneSufficient: true }), true);
  });
});
