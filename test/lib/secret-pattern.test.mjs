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
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const {
  looksSecretByPattern, isCompoundSecretMatch, elementLooksSecretByPattern,
  isStrongContainerMatch, isStrongCompoundMatch, shouldBlankWholesale, isPrismTokenSpan,
  CONTAINER_BLANK_TEXT_CAP, SHORT_LEAF_BLANK_CAP,
} = require('../../skills/browsing/lib/secret-pattern.js');

const SECRET_ATTRS = ['id', 'name', 'class', 'autocomplete', 'aria-label'];
function el(html, selector) {
  const dom = new JSDOM(html);
  return selector ? dom.window.document.querySelector(selector) : dom.window.document.body.firstElementChild;
}

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

// Round 4 (jc finding 2): Prism.js / prism-react-renderer syntax-highlighting
// spans collide with the standalone "token" secret word.
describe('isPrismTokenSpan / elementLooksSecretByPattern: Prism exemption', () => {
  it('a real Prism-highlighted span (class="token keyword" inside pre/code) is exempted', () => {
    const span = el('<pre><code><span class="token keyword">const</span></code></pre>', 'span');
    assert.equal(isPrismTokenSpan(span), true);
    assert.equal(elementLooksSecretByPattern(span, SECRET_ATTRS), false);
  });

  it('a bare "token" class with no Prism type-word neighbor, even inside pre/code, is NOT exempted', () => {
    const span = el('<pre><code><span class="token">x</span></code></pre>', 'span');
    assert.equal(isPrismTokenSpan(span), false);
    assert.equal(elementLooksSecretByPattern(span, SECRET_ATTRS), true);
  });

  it('a genuine secret-naming class, one hyphenated token (api-token), still matches -- never exempted', () => {
    const code = el('<code class="api-token">ghp_abc123</code>', 'code');
    assert.equal(isPrismTokenSpan(code), false);
    assert.equal(elementLooksSecretByPattern(code, SECRET_ATTRS), true);
  });

  it('a genuine secret class matches even when it ALSO sits inside a pre/code block', () => {
    const code = el('<pre><code class="api-token">ghp_abc123</code></pre>', 'code');
    assert.equal(elementLooksSecretByPattern(code, SECRET_ATTRS), true);
  });

  it('a prism-react-renderer "token-line" wrapper inside pre/code is exempted', () => {
    const div = el('<pre><code><div class="token-line">line</div></code></pre>', 'div');
    assert.equal(elementLooksSecretByPattern(div, SECRET_ATTRS), false);
  });

  it('a "token-line" class OUTSIDE pre/code is NOT exempted (still a generic standalone token match)', () => {
    const div = el('<div class="token-line">not code</div>', 'div');
    assert.equal(elementLooksSecretByPattern(div, SECRET_ATTRS), true);
  });

  it('an element matching via a DIFFERENT attribute still matches even when its class is Prism-shaped', () => {
    const span = el('<pre><code><span id="totp-secret" class="token keyword">SEED</span></code></pre>', 'span');
    assert.equal(elementLooksSecretByPattern(span, SECRET_ATTRS), true);
  });
});

const PRISM_WORD_CASES = ['operator', 'punctuation', 'string', 'function', 'comment', 'number', 'class-name'];
describe('isPrismTokenSpan: each named Prism type-word companion is exempted', () => {
  for (const word of PRISM_WORD_CASES) {
    it('class="token ' + word + '" inside pre/code is exempted', () => {
      const span = el('<pre><code><span class="token ' + word + '">x</span></code></pre>', 'span');
      assert.equal(elementLooksSecretByPattern(span, SECRET_ATTRS), false, word);
    });
  }
});

// Round 4 (jc finding 1): ONE shared gate, used identically by
// html-with-scrub.js and markdown.js -- jc's own four examples,
// reproduced verbatim.
describe('isStrongContainerMatch: the cap-gated compound check used by shouldBlankWholesale', () => {
  it('a strong compound under the cap is a strong container match', () => {
    const div = el('<div id="totp-secret"><code>SEED</code></div>', 'div');
    assert.equal(isStrongContainerMatch(div, SECRET_ATTRS, CONTAINER_BLANK_TEXT_CAP), true);
  });

  it('a weak (non-compound) match is never a strong container match, regardless of size', () => {
    const div = el('<div id="module-secrets"><p>short</p></div>', 'div');
    assert.equal(isStrongContainerMatch(div, SECRET_ATTRS, CONTAINER_BLANK_TEXT_CAP), false);
  });
});

describe('shouldBlankWholesale: the shared leaf-or-strong-container gate (jc finding 1)', () => {
  const cases = [
    ['<li class="mfa-tip"><strong>Tip:</strong> Turn on MFA</li>', 'li', false,
      'weak container WITH children -- kept, not wholesale-blanked'],
    ['<h2 id="managing-secrets">Managing secrets<a class="headerlink">#</a></h2>', 'h2', false,
      'weak container WITH children (MkDocs heading) -- kept'],
    ['<p class="otp-secret">Key: <strong>JBSWY3DPEHPK3PXP</strong></p>', 'p', true,
      'now a strong compound (otpsecret) -- blanked'],
    ['<div id="mfa-secret"><span>SEED</span></div>', 'div', true,
      'now a strong compound (mfasecret) -- blanked'],
  ];
  for (const [html, selector, expected, label] of cases) {
    it(selector + ' ' + label, () => {
      const node = el(html, selector);
      assert.equal(shouldBlankWholesale(node, SECRET_ATTRS, CONTAINER_BLANK_TEXT_CAP), expected);
    });
  }
});

// Round 4 (jc minor #3): no existing test pinned the cap's actual VALUE
// -- setting it to 1e9 left every page-scripts/secret-pattern test
// passing. These do pin it: each asserts a decision that would FLIP if
// the cap were raised to something as large as 1e9.
describe('CONTAINER_BLANK_TEXT_CAP pin (jc minor #3): setting the cap to 1e9 must fail one of these', () => {
  it('a strong-compound container just UNDER the real cap (2000) is blanked', () => {
    const text = 'abcde-12345 ' + 'x'.repeat(CONTAINER_BLANK_TEXT_CAP - 20);
    const div = el('<div class="recovery-codes"><p>' + text + '</p></div>', 'div');
    assert.ok((div.textContent || '').length <= CONTAINER_BLANK_TEXT_CAP, 'fixture must actually be under the cap');
    assert.equal(shouldBlankWholesale(div, SECRET_ATTRS, CONTAINER_BLANK_TEXT_CAP), true);
  });

  it('a strong-compound container just OVER the real cap (2000) is NOT wholesale-blanked -- exactly what would flip if the cap were raised to 1e9', () => {
    const text = 'x'.repeat(CONTAINER_BLANK_TEXT_CAP + 20);
    const div = el('<div class="recovery-codes"><p>' + text + '</p></div>', 'div');
    assert.ok((div.textContent || '').length > CONTAINER_BLANK_TEXT_CAP, 'fixture must actually be over the cap');
    assert.equal(shouldBlankWholesale(div, SECRET_ATTRS, CONTAINER_BLANK_TEXT_CAP), false);
    // isStrongCompoundMatch (ignoring the cap) is still true -- the exact
    // distinction the over-cap short-leaf fallback below needs.
    assert.equal(isStrongCompoundMatch(div, SECRET_ATTRS), true);
  });
});

// Round 4 (jc minor #3): a strong-named container OVER the cap used to
// leak its own unnamed children entirely in both artifacts. The
// simplest fallback that blanks the codes and keeps the prose: still
// blank a SHORT leaf descendant (<= SHORT_LEAF_BLANK_CAP chars) even
// when the container itself is too big to blank wholesale.
describe('SHORT_LEAF_BLANK_CAP (jc minor #3): pins the short-leaf fallback threshold', () => {
  it('a short code-like leaf (well under the cap) is short enough for the fallback', () => {
    assert.ok('abcde-12345'.length <= SHORT_LEAF_BLANK_CAP);
  });

  it('a realistic paragraph of guidance text is NOT short enough for the fallback', () => {
    const prose = 'Store these recovery codes somewhere safe. Each code can only be used once to regain access to your account if you lose your two-factor device.';
    assert.ok(prose.trim().length > SHORT_LEAF_BLANK_CAP);
  });
});
