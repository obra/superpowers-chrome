/**
 * TDD tests for issue #18: chrome-ws pid / chrome-ws info command
 *
 * Tests getChromePid() export and getBrowserMode() pid field.
 * Run: node test-issue-18-pid.cjs
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

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL: ${name}`);
    console.log(`        ${e.message}`);
    failed++;
  }
}

console.log('\n=== Issue #18: getChromePid() export ===\n');

test('getChromePid is exported', () => {
  assert.strictEqual(typeof lib.getChromePid, 'function', 'getChromePid should be a function in module.exports');
});

test('getChromePid returns null when Chrome is not running', () => {
  const pid = lib.getChromePid();
  assert.strictEqual(pid, null, `getChromePid() should return null when Chrome is not running, got: ${pid}`);
});

test('getChromePid returns a number or null (never undefined)', () => {
  const pid = lib.getChromePid();
  assert.ok(pid === null || typeof pid === 'number', `getChromePid() should return null or a number, got: ${typeof pid}`);
});

console.log('\n=== Issue #18: getBrowserMode() includes pid ===\n');

(async () => {
  await asyncTest('getBrowserMode returns pid field', async () => {
    const mode = await lib.getBrowserMode();
    assert.ok('pid' in mode, `getBrowserMode() result should have a 'pid' field, got keys: ${Object.keys(mode).join(', ')}`);
  });

  await asyncTest('getBrowserMode pid is null when Chrome not running', async () => {
    const mode = await lib.getBrowserMode();
    assert.strictEqual(mode.pid, null, `getBrowserMode().pid should be null when Chrome not running, got: ${mode.pid}`);
  });

  await asyncTest('getBrowserMode pid is a number or null', async () => {
    const mode = await lib.getBrowserMode();
    assert.ok(mode.pid === null || typeof mode.pid === 'number',
      `getBrowserMode().pid should be null or number, got: ${typeof mode.pid}`);
  });

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
