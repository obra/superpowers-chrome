// looksSecretByPattern: the shared word/segment-boundary secret-identifier
// detector used by both html-with-scrub.js and markdown.js (see
// skills/browsing/lib/secret-pattern.js for the full rationale).
//
// The pre-fix version of this detector was a single regex tested with
// `.test(value)` -- a raw substring match, no word boundaries at all. Two
// concrete false positives from that shape:
//   - /otp/i.test('footprint') -> true (the letters o-t-p happen to run
//     together inside an unrelated word).
//   - /token/i.test('token-list') -> true (a page section that lists
//     token NAMES/metadata, not a token VALUE).
// These tests pin the fixed (word-boundary) behavior for both, alongside
// every real-world id/class this repo already relies on matching.
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { looksSecretByPattern, isCompoundSecretMatch } = require('../../skills/browsing/lib/secret-pattern.js');

describe('looksSecretByPattern', () => {
  describe('negative: raw-substring false positives that word boundaries must fix', () => {
    it('"footprint" does not match "otp" (the letters only coincidentally run together)', () => {
      assert.equal(looksSecretByPattern('footprint'), false);
    });

    it('"token-list" does not match "token" (a list of token NAMES, not a token VALUE)', () => {
      assert.equal(looksSecretByPattern('token-list'), false);
    });

    it('plural and alternate-separator forms of the same collection shape also do not match', () => {
      assert.equal(looksSecretByPattern('tokens-list'), false);
      assert.equal(looksSecretByPattern('token_table'), false);
      assert.equal(looksSecretByPattern('tokenHistoryLog'), false);
    });

    it('other raw-substring coincidences do not match either', () => {
      // "seed" inside "disseeded"? -- more realistically: "key" is not a
      // standalone secret word at all (only the key+code/api+key PAIRS
      // are), so a bare design-system or database use of "key" must not
      // match.
      assert.equal(looksSecretByPattern('primary-key'), false);
      assert.equal(looksSecretByPattern('foreign_key'), false);
    });
  });

  describe('positive: real cases this detector exists to catch', () => {
    const shouldMatch = [
      'init_key_code', // Slack's real hidden-seed element id
      'totp-secret',
      'totp-seed-display',
      'totpPin', // Google's real one-time-code field id (camelCase)
      'totpWrapper',
      'api_key', // aria-label
      'backup_code',
      'backup-codes',
      'recovery-codes',
      'recovery_codes',
      'copy-seed-btn', // control id referencing the secret it operates on
      'reveal-totp-link',
      '2fa',
      'section-2fa',
      'csrf-token', // accepted false-positive tradeoff, documented in the PR: still matches
      'authToken',
    ];
    for (const value of shouldMatch) {
      it(`"${value}" matches`, () => {
        assert.equal(looksSecretByPattern(value), true, value);
      });
    }
  });

  describe('negative: ordinary identifiers that must never match', () => {
    const shouldNotMatch = [
      'two-factor-setup', // no secret word present at all -- see the wrapping-container test
      'username',
      'submit',
      'class',
      'navbar',
    ];
    for (const value of shouldNotMatch) {
      it(`"${value}" does not match`, () => {
        assert.equal(looksSecretByPattern(value), false, value);
      });
    }
  });

  it('returns false for empty/falsy input', () => {
    assert.equal(looksSecretByPattern(''), false);
    assert.equal(looksSecretByPattern(null), false);
    assert.equal(looksSecretByPattern(undefined), false);
  });
});

describe('isCompoundSecretMatch (container-blanking strength gate, round 3 / jc finding 4)', () => {
  describe('positive: exact compounds that DO justify blanking a whole container', () => {
    const strongValues = [
      'totp-secret',
      'secret-key',
      'recovery-codes',
      'recovery_code',
      'backup-codes',
      'api-key',
      'private-key',
      'init_key_code',
    ];
    for (const value of strongValues) {
      it(value + ' is a strong compound match', () => {
        assert.equal(isCompoundSecretMatch(value), true, value);
      });
    }
  });

  describe('negative: broad single-word matches that must NOT justify blanking a whole container', () => {
    const weakValues = [
      'sn-token-provider',
      'module-secrets',
      'totp-setup',
      'two-factor-setup',
      'footprint',
    ];
    for (const value of weakValues) {
      it(value + ' is NOT a strong compound match', () => {
        assert.equal(isCompoundSecretMatch(value), false, value);
      });
    }
  });

  it('returns false for empty/falsy input', () => {
    assert.equal(isCompoundSecretMatch(''), false);
    assert.equal(isCompoundSecretMatch(null), false);
    assert.equal(isCompoundSecretMatch(undefined), false);
  });
});
