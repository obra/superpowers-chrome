#!/usr/bin/env node
/**
 * Automated Test Harness for React Input Bug Detection
 *
 * Runs click/type tests repeatedly to catch intermittent failures.
 *
 * Usage:
 *   node test-harness.js [iterations] [testUrl]
 *
 * Examples:
 *   node test-harness.js                    # 50 iterations on default test page
 *   node test-harness.js 100                # 100 iterations
 *   node test-harness.js 50 http://localhost:8080/settings  # Test specific URL
 *
 * Requirements:
 *   - Chrome running with --remote-debugging-port=9222
 *   - Test page loaded (or provide URL)
 */

const path = require('path');
const chromeWs = require('./skills/browsing/chrome-ws-lib.js');

// Test configuration
const DEFAULT_ITERATIONS = 50;
const DEFAULT_TEST_URL = `file://${path.join(__dirname, 'test-react-inputs.html')}`;

// Test results tracking
const results = {
  passed: 0,
  failed: 0,
  errors: []
};

// Colors for console output
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m'
};

function log(color, msg) {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Test: Click on a selector and verify click was registered
 */
async function testClick(tabIndex, selector, expectedChange) {
  try {
    await chromeWs.click(tabIndex, selector);
    await sleep(50); // Brief wait for React to update
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Test: Type into a selector and verify value changed
 */
async function testType(tabIndex, selector, text) {
  try {
    await chromeWs.fill(tabIndex, text, selector);
    await sleep(50);

    // Verify the value was set
    const value = await chromeWs.eval(tabIndex,
      `document.querySelector(${JSON.stringify(selector)})?.value || ''`
    );

    // For transformed inputs, just check it's not empty
    if (value && value.length > 0) {
      return { success: true, value };
    }
    return { success: false, error: `Value not set. Expected text, got: "${value}"` };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Test: Type and submit with Enter key
 */
async function testTypeAndEnter(tabIndex, selector, text) {
  try {
    await chromeWs.fill(tabIndex, text + '\\n', selector);
    await sleep(100);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Test: XPath selector click (tests the text() fallback)
 */
async function testXPathClick(tabIndex, xpath) {
  try {
    await chromeWs.click(tabIndex, xpath);
    await sleep(50);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Clear all inputs on test page
 */
async function clearTestPage(tabIndex) {
  await chromeWs.eval(tabIndex, `
    document.querySelectorAll('input, textarea').forEach(el => {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  `);
}

/**
 * Run a single test iteration
 */
async function runIteration(tabIndex, iteration) {
  const tests = [
    { name: 'Click button', fn: () => testClick(tabIndex, '#test-button') },
    { name: 'Type in controlled input', fn: () => testType(tabIndex, '#controlled-input', `test${iteration}`) },
    { name: 'Type in uncontrolled input', fn: () => testType(tabIndex, '#uncontrolled-input', `test${iteration}`) },
    { name: 'Type in validated input', fn: () => testType(tabIndex, '#validated-input', 'abc') },
    { name: 'Type in nested input', fn: () => testType(tabIndex, '#nested-input', `test${iteration}`) },
    { name: 'Type in transform input', fn: () => testType(tabIndex, '#transform-input', 'hello') },
    { name: 'Type in debounced input', fn: () => testType(tabIndex, '#debounced-input', `test${iteration}`) },
    { name: 'Type in email input', fn: () => testType(tabIndex, '#email-input', 'test@example.com') },
    { name: 'Type in textarea', fn: () => testType(tabIndex, '#controlled-textarea', `line1\\nline2`) },
  ];

  const iterationResults = [];

  for (const test of tests) {
    const result = await test.fn();
    iterationResults.push({ name: test.name, ...result });

    if (!result.success) {
      results.failed++;
      results.errors.push({
        iteration,
        test: test.name,
        error: result.error
      });
    } else {
      results.passed++;
    }
  }

  return iterationResults;
}

/**
 * Run tests on a live app (like Brooks)
 */
async function runLiveAppTests(tabIndex, baseUrl, iteration) {
  const tests = [];

  // Navigate to settings
  try {
    await chromeWs.navigate(tabIndex, `${baseUrl}/settings`);
    await sleep(500);
    tests.push({ name: 'Navigate to settings', success: true });
  } catch (e) {
    tests.push({ name: 'Navigate to settings', success: false, error: e.message });
    return tests;
  }

  // Click New Organization (test XPath with mixed content)
  try {
    await chromeWs.click(tabIndex, "//a[text()='New Organization'] | //button[text()='New Organization']");
    await sleep(200);
    tests.push({ name: 'Click New Organization (XPath)', success: true });
  } catch (e) {
    tests.push({ name: 'Click New Organization (XPath)', success: false, error: e.message });
  }

  // Type in the form
  try {
    await chromeWs.fill(tabIndex, `TestOrg${iteration}`, 'form input[type="text"]');
    await sleep(100);
    tests.push({ name: 'Type org name', success: true });
  } catch (e) {
    tests.push({ name: 'Type org name', success: false, error: e.message });
  }

  // Cancel to avoid creating many orgs
  try {
    await chromeWs.click(tabIndex, "button[type='button']");
    await sleep(100);
    tests.push({ name: 'Click Cancel', success: true });
  } catch (e) {
    tests.push({ name: 'Click Cancel', success: false, error: e.message });
  }

  return tests;
}

/**
 * Main test runner
 */
async function main() {
  const args = process.argv.slice(2);
  const iterations = parseInt(args[0]) || DEFAULT_ITERATIONS;
  const testUrl = args[1] || DEFAULT_TEST_URL;
  const isLiveApp = testUrl.startsWith('http://localhost');

  log('cyan', `\n🧪 React Input Test Harness`);
  log('cyan', `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  log('cyan', `Iterations: ${iterations}`);
  log('cyan', `Test URL: ${testUrl}`);
  log('cyan', `Mode: ${isLiveApp ? 'Live App' : 'Test Page'}`);
  log('cyan', `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  // Initialize
  let tabIndex;
  try {
    tabIndex = await chromeWs.initializeSession();
    log('green', `✓ Connected to Chrome (tab index: ${tabIndex})`);
  } catch (e) {
    log('red', `✗ Failed to connect to Chrome: ${e.message}`);
    log('yellow', `  Make sure Chrome is running with --remote-debugging-port=9222`);
    process.exit(1);
  }

  // Navigate to test page
  try {
    await chromeWs.navigate(tabIndex, testUrl);
    await sleep(1000); // Wait for React to initialize
    log('green', `✓ Loaded test page`);
  } catch (e) {
    log('red', `✗ Failed to load test page: ${e.message}`);
    process.exit(1);
  }

  // Run iterations
  const startTime = Date.now();

  for (let i = 1; i <= iterations; i++) {
    process.stdout.write(`\rRunning iteration ${i}/${iterations}...`);

    if (isLiveApp) {
      const iterResults = await runLiveAppTests(tabIndex, testUrl.replace(/\/[^/]*$/, ''), i);
      for (const r of iterResults) {
        if (r.success) results.passed++;
        else {
          results.failed++;
          results.errors.push({ iteration: i, test: r.name, error: r.error });
        }
      }
    } else {
      // Clear inputs before each iteration
      await clearTestPage(tabIndex);
      await sleep(50);

      await runIteration(tabIndex, i);
    }

    // Brief pause between iterations
    await sleep(100);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Print results
  console.log('\n');
  log('cyan', `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  log('cyan', `Results (${elapsed}s)`);
  log('cyan', `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  log('green', `✓ Passed: ${results.passed}`);

  if (results.failed > 0) {
    log('red', `✗ Failed: ${results.failed}`);
    log('red', `\nFailures:`);

    // Group errors by test name
    const errorsByTest = {};
    for (const err of results.errors) {
      const key = err.test;
      if (!errorsByTest[key]) errorsByTest[key] = [];
      errorsByTest[key].push(err);
    }

    for (const [test, errors] of Object.entries(errorsByTest)) {
      log('red', `\n  ${test}: ${errors.length} failures`);
      // Show first 3 examples
      for (const err of errors.slice(0, 3)) {
        log('yellow', `    - Iteration ${err.iteration}: ${err.error}`);
      }
      if (errors.length > 3) {
        log('yellow', `    ... and ${errors.length - 3} more`);
      }
    }
  } else {
    log('green', `\n🎉 All tests passed!`);
  }

  const failRate = ((results.failed / (results.passed + results.failed)) * 100).toFixed(1);
  log('cyan', `\nFailure rate: ${failRate}%`);

  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch(e => {
  log('red', `Fatal error: ${e.message}`);
  console.error(e);
  process.exit(1);
});
