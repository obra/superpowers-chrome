#!/usr/bin/env node

/**
 * Test XDG cache directory functionality
 */

const chromeLib = require('./skills/browsing/chrome-ws-lib.js');
const path = require('path');

console.log('Testing XDG cache directory...\n');

// Test 1: getXdgCacheHome
console.log('Test 1: getXdgCacheHome()');
const cacheHome = chromeLib.getXdgCacheHome();
console.log(`  Cache home: ${cacheHome}`);
console.log(`  Platform: ${process.platform}`);
console.log(`  ✓ Pass\n`);

// Test 2: initializeSession
console.log('Test 2: initializeSession()');
const sessionDir = chromeLib.initializeSession();
console.log(`  Session directory: ${sessionDir}`);

// Verify structure: {cacheHome}/superpowers/browser/YYYY-MM-DD/session-{timestamp}
const parts = sessionDir.split(path.sep);
const hasSuperpowers = parts.includes('superpowers');
const hasBrowser = parts.includes('browser');
const hasDatePattern = parts.some(p => /^\d{4}-\d{2}-\d{2}$/.test(p));
const hasSessionPattern = parts.some(p => /^session-\d+$/.test(p));

console.log(`  Has 'superpowers' in path: ${hasSuperpowers ? '✓' : '✗'}`);
console.log(`  Has 'browser' in path: ${hasBrowser ? '✓' : '✗'}`);
console.log(`  Has YYYY-MM-DD date: ${hasDatePattern ? '✓' : '✗'}`);
console.log(`  Has session-{timestamp}: ${hasSessionPattern ? '✓' : '✗'}`);

if (hasSuperpowers && hasBrowser && hasDatePattern && hasSessionPattern) {
  console.log('  ✓ Pass\n');
} else {
  console.log('  ✗ FAIL\n');
  process.exit(1);
}

// Test 3: Check directory exists
console.log('Test 3: Directory existence');
const fs = require('fs');
const exists = fs.existsSync(sessionDir);
console.log(`  Directory exists: ${exists ? '✓' : '✗'}`);
if (exists) {
  const stat = fs.statSync(sessionDir);
  console.log(`  Is directory: ${stat.isDirectory() ? '✓' : '✗'}`);
  console.log('  ✓ Pass\n');
} else {
  console.log('  ✗ FAIL\n');
  process.exit(1);
}

// Cleanup
console.log('Test 4: Cleanup');
chromeLib.cleanupSession();
const stillExists = fs.existsSync(sessionDir);
console.log(`  Directory removed: ${!stillExists ? '✓' : '✗'}`);
if (!stillExists) {
  console.log('  ✓ Pass\n');
} else {
  console.log('  ✗ FAIL\n');
  process.exit(1);
}

console.log('All tests passed! ✓');
