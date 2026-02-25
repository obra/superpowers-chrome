/**
 * Simple test for viewport functions
 * Run with: node test-viewport.js
 */

const chromeLib = require('./chrome-ws-lib.js');

async function testViewportFunctionsExist() {
  console.log('Testing that viewport functions are exported...');

  if (typeof chromeLib.setViewport !== 'function') {
    throw new Error('setViewport not exported');
  }
  if (typeof chromeLib.clearViewport !== 'function') {
    throw new Error('clearViewport not exported');
  }
  if (typeof chromeLib.getViewport !== 'function') {
    throw new Error('getViewport not exported');
  }

  console.log('All viewport functions exported');
}

testViewportFunctionsExist().catch(err => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
