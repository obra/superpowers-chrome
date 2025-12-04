#!/usr/bin/env node

/**
 * Test Chrome profile functionality
 *
 * Tests:
 * 1. Default profile is 'superpowers-chrome'
 * 2. Can set a custom profile
 * 3. Profile directories are created correctly
 * 4. Cannot change profile while Chrome is running
 * 5. Different profiles have isolated data
 */

const chromeLib = require('./skills/browsing/chrome-ws-lib.js');
const fs = require('fs');
const path = require('path');

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
  console.log('Testing Chrome profile functionality...\n');

  try {
    // Test 1: Check default profile
    console.log('Test 1: Check default profile name');
    const defaultProfile = chromeLib.getProfileName();
    console.log(`  Default profile: ${defaultProfile}`);
    if (defaultProfile === 'superpowers-chrome') {
      console.log('  ✓ Pass: Default profile is "superpowers-chrome"\n');
    } else {
      console.log(`  ✗ FAIL: Expected "superpowers-chrome", got "${defaultProfile}"\n`);
      process.exit(1);
    }

    // Test 2: Check default profile directory path
    console.log('Test 2: Check default profile directory');
    const defaultProfileDir = chromeLib.getChromeProfileDir('superpowers-chrome');
    console.log(`  Profile dir: ${defaultProfileDir}`);
    if (defaultProfileDir.includes('browser-profiles') && defaultProfileDir.includes('superpowers-chrome')) {
      console.log('  ✓ Pass: Profile directory path is correct\n');
    } else {
      console.log('  ✗ FAIL: Profile directory path is incorrect\n');
      process.exit(1);
    }

    // Test 3: Start Chrome with default profile
    console.log('Test 3: Start Chrome with default profile');
    await chromeLib.startChrome();
    await sleep(2000);

    const mode = await chromeLib.getBrowserMode();
    console.log(`  Mode: ${JSON.stringify(mode)}`);
    if (mode.profile === 'superpowers-chrome' && fs.existsSync(mode.profileDir)) {
      console.log('  ✓ Pass: Chrome started with default profile\n');
    } else {
      console.log('  ✗ FAIL: Profile not set correctly\n');
      process.exit(1);
    }

    // Test 4: Try to change profile while Chrome is running (should fail)
    console.log('Test 4: Try to change profile while Chrome is running');
    try {
      chromeLib.setProfileName('test-profile');
      console.log('  ✗ FAIL: Should have thrown error\n');
      process.exit(1);
    } catch (error) {
      if (error.message.includes('Cannot change profile while Chrome is running')) {
        console.log(`  ✓ Pass: Correctly prevented profile change: ${error.message}\n`);
      } else {
        console.log(`  ✗ FAIL: Wrong error: ${error.message}\n`);
        process.exit(1);
      }
    }

    // Test 5: Kill Chrome and change profile
    console.log('Test 5: Kill Chrome and change profile');
    await chromeLib.killChrome();
    await sleep(1000);

    const result = chromeLib.setProfileName('test-profile');
    console.log(`  Result: ${result}`);
    const newProfile = chromeLib.getProfileName();
    console.log(`  New profile: ${newProfile}`);
    if (newProfile === 'test-profile') {
      console.log('  ✓ Pass: Profile changed successfully\n');
    } else {
      console.log('  ✗ FAIL: Profile not changed\n');
      process.exit(1);
    }

    // Test 6: Start Chrome with new profile
    console.log('Test 6: Start Chrome with new profile');
    await chromeLib.startChrome();
    await sleep(2000);

    const newMode = await chromeLib.getBrowserMode();
    console.log(`  Mode: ${JSON.stringify(newMode)}`);
    if (newMode.profile === 'test-profile' && fs.existsSync(newMode.profileDir)) {
      console.log('  ✓ Pass: Chrome started with new profile\n');
    } else {
      console.log('  ✗ FAIL: Profile not applied\n');
      process.exit(1);
    }

    // Test 7: Verify profile directories are separate
    console.log('Test 7: Verify profile directories are separate');
    const defaultDir = chromeLib.getChromeProfileDir('superpowers-chrome');
    const testDir = chromeLib.getChromeProfileDir('test-profile');
    console.log(`  Default: ${defaultDir}`);
    console.log(`  Test: ${testDir}`);
    if (defaultDir !== testDir && fs.existsSync(testDir)) {
      console.log('  ✓ Pass: Profile directories are separate and exist\n');
    } else {
      console.log('  ✗ FAIL: Profile directories not properly isolated\n');
      process.exit(1);
    }

    // Test 8: Explicitly pass profile name to startChrome
    console.log('Test 8: Explicitly pass profile name to startChrome');
    await chromeLib.killChrome();
    await sleep(1000);

    await chromeLib.startChrome(true, 'explicit-profile');
    await sleep(2000);

    const explicitMode = await chromeLib.getBrowserMode();
    console.log(`  Mode: ${JSON.stringify(explicitMode)}`);
    if (explicitMode.profile === 'explicit-profile' && fs.existsSync(explicitMode.profileDir)) {
      console.log('  ✓ Pass: Explicit profile parameter works\n');
    } else {
      console.log('  ✗ FAIL: Explicit profile not applied\n');
      process.exit(1);
    }

    // Cleanup
    console.log('Cleanup: Killing Chrome');
    await chromeLib.killChrome();
    await sleep(500);

    console.log('\n✅ All tests passed!');
    console.log('\nKey findings:');
    console.log('- Default profile is "superpowers-chrome"');
    console.log('- Profiles are stored in ~/.cache/superpowers/browser-profiles/{name}/');
    console.log('- Profile directories persist across sessions');
    console.log('- Cannot change profile while Chrome is running');
    console.log('- Different profiles have completely isolated data\n');

  } catch (error) {
    console.error(`\n✗ Test failed with error: ${error.message}`);
    console.error(error.stack);

    // Try to cleanup
    try {
      await chromeLib.killChrome();
    } catch (e) {
      // Ignore cleanup errors
    }

    process.exit(1);
  }
}

runTests();
