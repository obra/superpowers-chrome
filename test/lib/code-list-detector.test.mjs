import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { codeListDetected } = require('../../skills/browsing/lib/code-list-detector.js');

describe('codeListDetected', () => {
  it('detects a mixed-alnum backup-code list (hyphenated pairs, like real recovery codes)', () => {
    const text = [
      'Your backup codes',
      '7f3k-9d2m',
      'a83f-29dk',
      'qq1z-88mn',
      'x0p4-rr3e',
      '8k2j-m9vd',
      'zz91-3bqa',
    ].join('\n');
    assert.equal(codeListDetected(text), true);
  });

  it('detects a bare 6-digit numeric code list (TOTP-style backup codes)', () => {
    const text = 'Recovery codes: 482910, 839201, 710284, 920817, 118402, 553291';
    assert.equal(codeListDetected(text), true);
  });

  it('detects codes even with surrounding prose, as long as they cluster', () => {
    const text =
      'If you lose access to your authenticator app, use one of these one-time ' +
      'backup codes to sign in: 7f3k-9d2m a83f-29dk qq1z-88mn x0p4-rr3e 8k2j-m9vd ' +
      'zz91-3bqa. Each code can only be used once.';
    assert.equal(codeListDetected(text), true);
  });

  it('does not flag a plain button label', () => {
    assert.equal(codeListDetected('Submit'), false);
  });

  it('does not flag ordinary prose', () => {
    const text =
      'The quick brown fox jumps over the lazy dog near the riverbank at dawn ' +
      'every single morning without fail this year, according to the report.';
    assert.equal(codeListDetected(text), false);
  });

  it('does not flag a short count or a year', () => {
    assert.equal(codeListDetected('You have 3 items in your cart. Checkout before 2026.'), false);
  });

  it('does not flag a changelog (versions are too short once split on dots)', () => {
    const text = 'Changelog: v4.2.1, v4.2.0, v4.1.9, v4.1.8, v4.1.7, v4.1.6, v4.1.5';
    assert.equal(codeListDetected(text), false);
  });

  it('does not flag a sequentially-numbered SKU table', () => {
    const text =
      'SKU-1001 widget, SKU-1002 gadget, SKU-1003 gizmo, SKU-1004 doohickey, ' +
      'SKU-1005 thingamajig, SKU-1006 contraption';
    assert.equal(codeListDetected(text), false);
  });

  it('does not flag an inline <code> snippet (too few distinct tokens)', () => {
    const text = 'Run `npm install --save-dev @biomejs/biome` to add the linter.';
    assert.equal(codeListDetected(text), false);
  });

  it('does not flag codes spread far apart across a long document (not clustered)', () => {
    const filler = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod. '.repeat(20);
    const text = `7f3k-9d2m ${filler} a83f-29dk ${filler} qq1z-88mn ${filler} x0p4-rr3e ${filler} 8k2j-m9vd ${filler} zz91-3bqa`;
    assert.equal(codeListDetected(text), false);
  });

  it('treats non-strings and empty strings as not code-listed', () => {
    assert.equal(codeListDetected(''), false);
    assert.equal(codeListDetected(null), false);
    assert.equal(codeListDetected(undefined), false);
    assert.equal(codeListDetected(42), false);
  });

  it('requires at least 6 distinct codes -- 5 similar codes do not trigger it', () => {
    // Each hyphenated pair contributes TWO qualifying tokens (the left
    // and right half), so this uses single bare-numeric codes instead --
    // one qualifying token per code -- to actually exercise the 5-vs-6
    // boundary.
    const text = 'Recovery codes: 482910, 839201, 710284, 920817, 118402';
    assert.equal(codeListDetected(text), false);
  });
});
