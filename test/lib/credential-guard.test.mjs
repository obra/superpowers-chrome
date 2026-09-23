// Unit tests for the credential-shaped content detector that gates
// auto-capture. Every token string here is an obviously fake,
// token-SHAPED value — none is a real credential.
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { afterEach, describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const {
  containsCredentialShaped,
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
