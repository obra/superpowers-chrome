/**
 * TDD tests for issue #19: fullpage screenshot support
 *
 * Tests screenshot() accepts fullPage param and MCP schema has fullpage field.
 * Run: node test-issue-19-fullpage.cjs
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

console.log('\n=== Issue #19: fullpage screenshot - export & signature ===\n');

test('screenshot is exported', () => {
  assert.strictEqual(typeof lib.screenshot, 'function', 'screenshot should be a function in module.exports');
});

test('screenshot accepts a fullPage 4th parameter (length >= 3)', () => {
  // function screenshot(tabIndexOrWsUrl, filename, selector = null, fullPage = false)
  // We check length >= 3; default params don't count toward .length but named params do
  // The key check: calling with 4 args doesn't throw a TypeError
  const fn = lib.screenshot;
  assert.ok(typeof fn === 'function', 'screenshot must be a function');
  // We can't call it without Chrome but we can inspect the source for fullPage
  const src = fn.toString();
  assert.ok(
    src.includes('fullPage') || src.includes('full_page') || src.includes('fullpage'),
    'screenshot function body should reference fullPage parameter'
  );
});

test('screenshot source includes captureBeyondViewport for fullpage', () => {
  const src = lib.screenshot.toString();
  assert.ok(
    src.includes('captureBeyondViewport'),
    'screenshot should use captureBeyondViewport CDP param for fullpage mode'
  );
});

test('screenshot source uses getLayoutMetrics for fullpage dimensions', () => {
  const src = lib.screenshot.toString();
  assert.ok(
    src.includes('getLayoutMetrics') || src.includes('contentSize'),
    'screenshot should query page dimensions via getLayoutMetrics for fullpage mode'
  );
});

console.log('\n=== Issue #19: fullpage - CLI chrome-ws handles --fullpage flag ===\n');

test('chrome-ws CLI source includes --fullpage flag handling', () => {
  const fs = require('fs');
  const cliSrc = fs.readFileSync('./skills/browsing/chrome-ws', 'utf8');
  assert.ok(
    cliSrc.includes('--fullpage') || cliSrc.includes('fullpage') || cliSrc.includes('fullPage'),
    'chrome-ws CLI should handle --fullpage flag for screenshot command'
  );
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
