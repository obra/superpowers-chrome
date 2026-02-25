/**
 * Simple test for cookie functions
 * Run with: node test-cookies.js
 */

const chromeLib = require('./chrome-ws-lib.js');

async function testCookieFunctionsExist() {
  console.log('Testing that cookie functions are exported...');

  if (typeof chromeLib.clearCookies !== 'function') {
    throw new Error('clearCookies not exported');
  }

  console.log('All cookie functions exported');
}

testCookieFunctionsExist().catch(err => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
