/**
 * Test: --autoConnect via DevToolsActivePort
 *
 * Prerequisites:
 *   - Chrome running with remote debugging enabled (chrome://inspect/#remote-debugging)
 *   - DevToolsActivePort file present in Chrome's user data dir
 *
 * Run: node test-auto-connect.cjs
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const chromeLib = require('./skills/browsing/chrome-ws-lib.js');

const defaultDirs = {
  darwin: path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome'),
  win32: path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data'),
  linux: path.join(os.homedir(), '.config', 'google-chrome')
};

const dataDir = defaultDirs[os.platform()];
const portFile = path.join(dataDir, 'DevToolsActivePort');

if (!fs.existsSync(portFile)) {
  console.log('SKIP: No DevToolsActivePort found — Chrome not running with remote debugging');
  console.log(`  Looked in: ${portFile}`);
  console.log('  Enable at: chrome://inspect/#remote-debugging');
  process.exit(0);
}

console.log(`Found DevToolsActivePort at ${portFile}`);
console.log(`  Contents: ${fs.readFileSync(portFile, 'utf8').trim().replace('\n', ' | ')}`);

(async () => {
  try {
    // Step 1: connect
    const info = chromeLib.connectViaDevToolsActivePort();
    console.log(`PASS: connected on port ${info.port}`);

    // Step 2: list tabs
    const tabs = await chromeLib.getTabs();
    console.log(`PASS: getTabs returned ${tabs.length} tab(s)`);
    for (const t of tabs) {
      console.log(`  [${t.id.slice(0, 8)}] ${t.url}`);
    }

    // Step 3: create a tab, then close it
    const tab = await chromeLib.newTab('about:blank');
    console.log(`PASS: created tab ${tab.id.slice(0, 8)}`);

    const tabsAfter = await chromeLib.getTabs();
    console.log(`PASS: now ${tabsAfter.length} tab(s)`);

    await chromeLib.closeTab(tabsAfter.length - 1);
    const tabsFinal = await chromeLib.getTabs();
    console.log(`PASS: closed tab, back to ${tabsFinal.length}`);

    console.log('\nAll tests passed.');
  } catch (err) {
    console.error(`FAIL: ${err.message}`);
    process.exit(1);
  }
})();
