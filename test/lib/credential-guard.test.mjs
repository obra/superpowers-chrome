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
  hasSplitBase32Seed,
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

// hasKnownTokenPrefix is rule 2 of the unified string check -- a bare
// PREFIX, no minimum trailing length, so a value TRUNCATED down to just
// its prefix still names itself even though it no longer matches
// containsCredentialShaped's full-shape regex (rule 1).
describe('hasKnownTokenPrefix', () => {
  it('matches a bare prefix with nothing after it', () => {
    assert.equal(hasKnownTokenPrefix('xoxb-'), true);
    assert.equal(hasKnownTokenPrefix('ghp_'), true);
    assert.equal(hasKnownTokenPrefix('lin_api_'), true);
  });

  it('matches a token sliced down to its first 8 characters', () => {
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

// Rule 4: a bare TOTP/HOTP seed with no prefix at all. Requires a MIX of
// letters and digits in the run -- an all-digit or all-letter run of 6+
// is exempt, since that's an ordinary DOM identifier shape, not a
// secret. A real base32 seed always mixes the two by construction, so
// this doesn't weaken the seed detection at all.
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

  // A data-qa identifier for a settings-page row: an all-digit suffix,
  // 14 characters long -- an ordinary DOM id, not a secret, must NOT
  // trip this rule just because it is long.
  it('does not match an all-digit run, however long (a data-qa id case)', () => {
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

  // Stripping all whitespace before scanning would glue any number onto
  // an adjacent word -- this function does not strip whitespace at all
  // (see its own doc comment for why), so none of these trip it.
  for (const text of ['Version 2 of the API', 'Open 24 hours', 'Released in 2026 by Prime Radiant', 'Merged #66 into main']) {
    it(`does not match ordinary prose with a number in it: ${JSON.stringify(text)}`, () => {
      assert.equal(hasLongMixedAlnumRun(text), false);
    });
  }

  // "commit 3382d73" is NOT fixed by the whitespace change, and should
  // not be: the hash itself ("3382d73") mixes letters and digits with NO
  // join across whitespace needed at all -- it was always one contiguous
  // token. Same for "sha256" (s/h/a + 2/5/6).
  it('still matches a run that is ALREADY contiguous in the original text, no join needed ("commit 3382d73")', () => {
    assert.equal(hasLongMixedAlnumRun('commit 3382d73'), true);
  });

  it('still matches "sha256" on its own, no join needed', () => {
    assert.equal(hasLongMixedAlnumRun('sha256 checksum'), true);
  });
});

// hasSplitBase32Seed: the ONE whitespace/hyphen-crossing join rule 4
// still performs, narrowed to the specific shape a chunked TOTP seed
// has (restricted base32 alphabet, uniform 4-char groups) rather than
// any digit sitting next to any word.
describe('hasSplitBase32Seed', () => {
  it('matches 4 groups of 4, space-separated (16 chars)', () => {
    assert.equal(hasSplitBase32Seed('JBSW Y3DP EHPK 3PXP'), true);
  });

  it('matches hyphen-separated groups too', () => {
    assert.equal(hasSplitBase32Seed('JBSW-Y3DP-EHPK-3PXP'), true);
  });

  it('does not match only 3 groups (12 chars, below the 16-char floor)', () => {
    assert.equal(hasSplitBase32Seed('JBSW Y3DP EHPK'), false);
  });

  it('does not match groups outside the base32 alphabet (no 0/1/8/9, lowercase)', () => {
    assert.equal(hasSplitBase32Seed('abcd efgh ijkl mnop'), false);
    assert.equal(hasSplitBase32Seed('AB01 CD89 EFGH IJKL'), false);
  });

  it('does not match ordinary space-separated short words', () => {
    assert.equal(hasSplitBase32Seed('Open 24 hours right now'), false);
  });
});

// stringLooksLikeSecret: the unified check. Rule 1 (full-shape token) is
// unconditional, any URL. Rules 2 (bare prefix) and 4 (mixed alnum run)
// apply ONLY when densityAloneSufficient is true (the page's URL is
// already on the sensitive-URL list) -- off that list, both would
// misfire on ordinary text (a library name containing 'sk-', a version
// number next to a word). Rule 3 (density) keeps its own on/off-list
// split (density alone vs. density+keyword).
describe('stringLooksLikeSecret', () => {
  it('allows an ordinary identifier-shaped string with no digit', () => {
    assert.equal(stringLooksLikeSecret('app_level_token_string'), false);
    assert.equal(stringLooksLikeSecret('app_level_token_string', { densityAloneSufficient: true }), false);
  });

  it('allows ordinary prose, on or off the sensitive-URL list', () => {
    assert.equal(stringLooksLikeSecret('Welcome back, Jordan.'), false);
    assert.equal(stringLooksLikeSecret('Welcome back, Jordan.', { densityAloneSufficient: true }), false);
  });

  it('refuses a full-shape token (rule 1) -- unconditional, any URL', () => {
    const token = fake('ghp', `_${'F'.repeat(36)}`);
    assert.equal(stringLooksLikeSecret(token), true);
    assert.equal(stringLooksLikeSecret(token, { densityAloneSufficient: true }), true);
  });

  it('rule 2 (bare token prefix): only applies on the sensitive-URL list', () => {
    assert.equal(stringLooksLikeSecret('xoxb-111'), false);
    assert.equal(stringLooksLikeSecret('xoxb-111', { densityAloneSufficient: true }), true);
  });

  // A library name containing a known prefix mid-word-boundary ('sk-'
  // as in scikit-learn) must not refuse an ordinary page off the
  // sensitive-URL list.
  it("rule 2 does not false-positive on an ordinary library name off the list ('scikit sk-learn docs')", () => {
    assert.equal(stringLooksLikeSecret('scikit sk-learn docs'), false);
  });

  it('rule 4 (mixed alnum run): only applies on the sensitive-URL list', () => {
    assert.equal(stringLooksLikeSecret('JBSWY3DPEHPK3PXP'), false);
    assert.equal(stringLooksLikeSecret('JBSWY3DPEHPK3PXP', { densityAloneSufficient: true }), true);
  });

  it('rule 4: refuses a bare TOTP seed, spaced or not, on the sensitive-URL list', () => {
    assert.equal(stringLooksLikeSecret('JBSWY3DPEHPK3PXP', { densityAloneSufficient: true }), true);
    assert.equal(stringLooksLikeSecret('JBSW Y3DP EHPK 3PXP', { densityAloneSufficient: true }), true);
  });

  // Ordinary prose/identifiers that a whitespace-stripping version of
  // rule 4 would refuse. Must be allowed OFF the sensitive-URL list
  // (rule 4 doesn't even run there); checked again ON the list below,
  // where results diverge.
  for (const text of ['Version 2 of the API', 'Open 24 hours', 'commit 3382d73']) {
    it(`allows ${JSON.stringify(text)} off the sensitive-URL list`, () => {
      assert.equal(stringLooksLikeSecret(text), false);
    });
  }

  // On a sensitive URL, rule 4 DOES run -- and "commit 3382d73" still
  // refuses there: the hash "3382d73" mixes letters and digits ON ITS
  // OWN, with no whitespace-join needed, so narrowing the join behavior
  // (not re-joining across arbitrary whitespace) does not change this
  // one. This is accepted: a commit hash is itself shaped exactly like a
  // truncated token tail, and this only matters on a page ALREADY
  // flagged sensitive by its URL, where erring toward refusal is the
  // whole point of the gate. The other two strings have no internal
  // digit+letter run and still pass.
  it('on a sensitive URL: "Version 2 of the API" and "Open 24 hours" are still allowed, but "commit 3382d73" refuses', () => {
    assert.equal(stringLooksLikeSecret('Version 2 of the API', { densityAloneSufficient: true }), false);
    assert.equal(stringLooksLikeSecret('Open 24 hours', { densityAloneSufficient: true }), false);
    assert.equal(stringLooksLikeSecret('commit 3382d73', { densityAloneSufficient: true }), true);
  });

  // Rule 3 (density) is bare density, UNCONDITIONALLY -- no keyword
  // requirement, on OR off the sensitive-URL list: this function's only
  // off-list caller is an element-scoped read with a real selector,
  // never the whole page (see the function's own doc comment). Making
  // rule 3 keyword-gated off-list, the same as rules 2/4, would break a
  // dense code list read via a SPECIFIC element selector, with no
  // keyword inside that selector's own text -- a real, narrower read
  // than a whole-page scan, so density alone is already a strong enough
  // signal there.
  it('rule 3 (density): density ALONE is sufficient, with no keyword needed, on OR off the sensitive-URL list', () => {
    const codeDenseNoKeyword = '7f3k-9d2m,a83f-29dk,qq1z-88mn,x0p4-rr3e,8k2j-m9vd,zz91-3bqa';
    assert.equal(stringLooksLikeSecret(codeDenseNoKeyword), true);
    assert.equal(stringLooksLikeSecret(codeDenseNoKeyword, { densityAloneSufficient: false }), true);
    assert.equal(stringLooksLikeSecret(codeDenseNoKeyword, { densityAloneSufficient: true }), true);
  });

  // A hyphen-joined code list (each pair's halves are only 4 characters,
  // below rule 4's 6-character floor either side of the hyphen) does not
  // trip rule 4 at all, on or off the list, since rule 4 no longer
  // strips whitespace before scanning. Rule 3 (density) still catches
  // it, either way, as its own, separate, unconditional signal.
  it('a whitespace-separated code list does not trip rule 4 on its own', () => {
    const spaceSeparated = '7f3k-9d2m a83f-29dk qq1z-88mn x0p4-rr3e 8k2j-m9vd zz91-3bqa';
    assert.equal(hasLongMixedAlnumRun(spaceSeparated), false);
    assert.equal(stringLooksLikeSecret(spaceSeparated), true); // via rule 3, not rule 4
    assert.equal(stringLooksLikeSecret(spaceSeparated, { densityAloneSufficient: true }), true); // via rule 3, not rule 4
  });
});

// valueLeaksSecret: the recursive tree-walker eval's result goes
// through. Non-string/array/object values always pass through
// unconditionally.
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

  // Rule 3 (density) is unconditional (see
  // stringLooksLikeSecret's own doc comment), so this has to use rule 4
  // (mixed alnum run) instead to demonstrate densityAloneSufficient
  // actually propagating through the recursive walk -- rule 4 is the
  // one still gated by it.
  it('passes densityAloneSufficient through to nested strings (rule 4, the gated one)', () => {
    assert.equal(valueLeaksSecret({ text: 'JBSWY3DPEHPK3PXP' }, { densityAloneSufficient: false }), false);
    assert.equal(valueLeaksSecret({ text: 'JBSWY3DPEHPK3PXP' }, { densityAloneSufficient: true }), true);
  });

  // Past MAX_VALUE_DEPTH, returning false ("no secret found") would be a
  // fail-OPEN bug -- a token nested deep enough would walk straight past
  // the check. It refuses (returns true) past the limit instead.
  it('REFUSES (fails closed) past the depth limit, rather than passing a deeply-nested token', () => {
    const fakeToken = fake('xoxb', '-1234567890-1234567890123-abcdefghijklmnopqrstuvwx');
    let nested = fakeToken;
    for (let i = 0; i < 12; i++) nested = [nested];
    assert.equal(valueLeaksSecret(nested, { densityAloneSufficient: true }), true);
  });

  it('does NOT refuse an ordinary value nested within the depth limit', () => {
    let nested = 'fine';
    for (let i = 0; i < 5; i++) nested = [nested];
    assert.equal(valueLeaksSecret(nested, { densityAloneSufficient: true }), false);
  });

  // Object.values alone never sees a token placed in a KEY rather than a
  // value -- ({ [el.value]: 1 }) is exactly the shape an eval expression
  // computing a dynamic key would produce.
  it('refuses a token placed in an OBJECT KEY, not just a value', () => {
    const fakeToken = fake('xoxb', '-1234567890-1234567890123-abcdefghijklmnopqrstuvwx');
    assert.equal(valueLeaksSecret({ [fakeToken]: 1 }, { densityAloneSufficient: true }), true);
  });

  it('refuses a token in a NESTED object key too', () => {
    const fakeToken = fake('xoxb', '-1234567890-1234567890123-abcdefghijklmnopqrstuvwx');
    assert.equal(valueLeaksSecret({ outer: { [fakeToken]: 1 } }, { densityAloneSufficient: true }), true);
  });

  it('allows ordinary object keys with no secret in them', () => {
    assert.equal(valueLeaksSecret({ ok: 1, count: 2, label: 3 }, { densityAloneSufficient: true }), false);
  });
});
