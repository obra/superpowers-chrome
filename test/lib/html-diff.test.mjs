import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { generateHtmlDiff } = require('../../skills/browsing/lib/html-diff.js');

describe('generateHtmlDiff', () => {
  it('returns "(no changes detected)" for identical input', () => {
    const html = '<div>hello</div>\n<div>world</div>';
    assert.equal(generateHtmlDiff(html, html), '(no changes detected)');
  });

  it('shows pure additions in ADDED section only', () => {
    const before = '<p>a</p>';
    const after = '<p>a</p>\n<p>b</p>';
    const diff = generateHtmlDiff(before, after);
    assert.match(diff, /=== ADDED ===/);
    assert.match(diff, /\+ <p>b<\/p>/);
    assert.doesNotMatch(diff, /=== REMOVED ===/);
  });

  it('shows pure removals in REMOVED section only', () => {
    const before = '<p>a</p>\n<p>b</p>';
    const after = '<p>a</p>';
    const diff = generateHtmlDiff(before, after);
    assert.match(diff, /=== REMOVED ===/);
    assert.match(diff, /- <p>b<\/p>/);
    assert.doesNotMatch(diff, /=== ADDED ===/);
  });

  it('detects reorderings of identical lines (Myers)', () => {
    // The bug-fix case: set-based logic returned "no changes" for this.
    const before = '<p>first</p>\n<p>second</p>';
    const after = '<p>second</p>\n<p>first</p>';
    const diff = generateHtmlDiff(before, after);
    assert.notEqual(diff, '(no changes detected)');
  });

  it('caps each side at 50 lines with "and N more" footer', () => {
    const before = '';
    const after = Array.from({ length: 200 }, (_, i) => `<p>line ${i}</p>`).join('\n');
    const diff = generateHtmlDiff(before, after);
    const addedLines = diff.split('\n').filter(l => l.startsWith('+ '));
    assert.equal(addedLines.length, 50);
    assert.match(diff, /and 150 more added lines/);
  });

  it('handles null/empty input', () => {
    assert.equal(generateHtmlDiff(null, null), '(no changes detected)');
    assert.equal(generateHtmlDiff('', ''), '(no changes detected)');
  });
});
