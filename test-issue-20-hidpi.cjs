/**
 * TDD tests for issue #20: HiDPI screenshot sizing fix
 *
 * The bug: without explicit clip, Chrome uses DPI-scaled dimensions on Linux
 * HiDPI displays, producing oversized screenshots.
 *
 * The fix: viewport screenshots (no selector, no fullPage) should use explicit
 * clip based on CSS pixel dimensions (window.innerWidth/innerHeight) with scale:1,
 * and pass fromSurface:true.
 *
 * Run: node test-issue-20-hidpi.cjs
 */

const assert = require('assert');
const lib = require('./skills/browsing/chrome-ws-lib.js').createSession();

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL: ${name}`);
    console.log(`        ${e.message}`);
    failed++;
  }
}

console.log('\n=== Issue #20: HiDPI screenshot fix - source inspection ===\n');

test('screenshot is exported', () => {
  assert.strictEqual(typeof lib.screenshot, 'function', 'screenshot must be exported');
});

test('screenshot uses fromSurface:true for reliable captures', () => {
  const src = lib.screenshot.toString();
  assert.ok(
    src.includes('fromSurface'),
    'screenshot should pass fromSurface:true to Page.captureScreenshot to get consistent pixel output across DPI settings'
  );
});

test('screenshot uses explicit clip for viewport (no selector) screenshots', () => {
  const src = lib.screenshot.toString();
  // The fix: even with no selector, pass an explicit clip with CSS dimensions
  // rather than letting Chrome choose (which uses DPI-scaled dimensions on Linux).
  // We check that the code reads innerWidth/innerHeight and uses them as clip.
  assert.ok(
    src.includes('innerWidth') || src.includes('innerHeight'),
    'screenshot should read CSS pixel dimensions (innerWidth/innerHeight) to set explicit clip, avoiding HiDPI scaling issues'
  );
});

test('screenshot clip uses scale:1 (CSS pixel mapping)', () => {
  const src = lib.screenshot.toString();
  // The clip object must include scale:1 so CDP treats coordinates as CSS pixels
  assert.ok(
    src.includes('scale: 1') || src.includes('scale:1'),
    'screenshot clip should use scale:1 to ensure CSS pixel coordinate mapping'
  );
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
