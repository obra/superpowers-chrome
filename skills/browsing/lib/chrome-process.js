const {
  readProfileMeta,
  writeProfileMeta,
  clearProfileMeta,
  isPortAlive,
  findAvailablePort,
  findPidOnPort,
  buildChromeArgs,
  getChromeProfileDir,
} = require('./chrome-launcher-helpers');
const { spawn } = require('child_process');
const { existsSync, mkdirSync } = require('fs');
const os = require('os');

/**
 * Chrome process lifecycle + profile management. Reads and writes session
 * state heavily, so it gets the state bag directly (not just helpers like
 * the action modules do). Also takes the few cross-section helpers it
 * needs — chromeHttp for graceful shutdown, getTabs/newTab for the
 * show/hide tab-restoration flow.
 *
 * `attachChromeProcess({ state, chromeHttp, getTabs, newTab })` returns
 * the bound methods.
 */
function attachChromeProcess({ state, chromeHttp, getTabs, newTab }) {
  // Read-once derived constants from the per-session host-override.
  const CHROME_DEBUG_HOST = state.hostOverride.getHost();
  const CHROME_DEBUG_PORT = state.hostOverride.getPort();

  async function startChrome(headless = null, profileName = null, port = null) {
    if (headless !== null) {
      state.chromeHeadless = headless;
    }
    if (profileName !== null) {
      state.chromeProfileName = profileName;
    }

    // --- Step 1: Reuse an already-running Chrome on this profile ---
    // Enables reconnection after MCP restart while Chrome is still alive.
    if (!port) {
      const meta = readProfileMeta(state.chromeProfileName);
      if (meta && meta.port) {
        if (await isPortAlive(CHROME_DEBUG_HOST, meta.port, meta.pid)) {
          state.activePort = meta.port;
          console.error(`Reconnected to existing Chrome (port: ${meta.port}, PID: ${meta.pid}, profile: ${state.chromeProfileName})`);
          return;
        }
        // Stale meta.json — Chrome died without cleanup
        clearProfileMeta(state.chromeProfileName);
      }
    }

    // --- Step 2: Choose a port ---
    // Priority: explicit port param > CHROME_WS_PORT env var > dynamic allocation.
    const HAS_ENV_PORT = process.env.CHROME_WS_PORT !== undefined;
    let chosenPort;
    if (port) {
      chosenPort = port;
    } else if (HAS_ENV_PORT) {
      chosenPort = CHROME_DEBUG_PORT; // already parsed from env by host-override.js
    } else {
      chosenPort = await findAvailablePort();
    }

    // --- Step 3: Find Chrome binary ---
    const chromePaths = {
      darwin: [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium'
      ],
      linux: [
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium'
      ],
      win32: [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
      ]
    };

    const platform = os.platform();
    const paths = chromePaths[platform] || [];

    let chromePath = null;
    for (const path of paths) {
      if (existsSync(path)) {
        chromePath = path;
        break;
      }
    }

    if (!chromePath) {
      throw new Error(`Chrome not found. Searched: ${paths.join(', ')}`);
    }

    // Persistent profile directory (re-used across sessions).
    if (!state.chromeUserDataDir) {
      state.chromeUserDataDir = getChromeProfileDir(state.chromeProfileName);
      mkdirSync(state.chromeUserDataDir, { recursive: true });
    }

    // --- Step 4: Launch Chrome with the chosen port ---
    const args = buildChromeArgs({
      chosenPort,
      chromeUserDataDir: state.chromeUserDataDir,
      chromeHeadless: state.chromeHeadless,
    });

    const proc = spawn(chromePath, args, {
      detached: true,
      stdio: 'ignore'
    });

    proc.unref();
    state.chromeProcess = proc;
    state.activePort = chosenPort;

    // Poll until Chrome's debug port is accepting connections (or 15s timeout).
    const POLL_INTERVAL_MS = 200;
    const POLL_TIMEOUT_MS = 15000;
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await isPortAlive(CHROME_DEBUG_HOST, chosenPort)) break;
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    if (!(await isPortAlive(CHROME_DEBUG_HOST, chosenPort))) {
      throw new Error(`Chrome did not become ready on port ${chosenPort} within ${POLL_TIMEOUT_MS}ms`);
    }

    // --- Step 5: Persist port assignment in meta.json ---
    writeProfileMeta(state.chromeProfileName, {
      port: chosenPort,
      pid: proc.pid,
      headless: state.chromeHeadless,
      profileName: state.chromeProfileName,
      userDataDir: state.chromeUserDataDir,
      startedAt: new Date().toISOString()
    });

    const mode = state.chromeHeadless ? 'headless' : 'headed';
    console.error(`Chrome started in ${mode} mode (PID: ${proc.pid}, port: ${chosenPort}, profile: ${state.chromeProfileName})`);
  }

  async function killChrome() {
    let pidToKill = null;

    if (state.chromeProcess && state.chromeProcess.pid) {
      pidToKill = state.chromeProcess.pid;
    } else if (state.activePort) {
      // We didn't launch this Chrome (or already dropped the handle), but we
      // know the port. Kill whoever holds it so showBrowser/hideBrowser can
      // restart cleanly in the target mode.
      pidToKill = findPidOnPort(state.activePort);
    }

    if (pidToKill === null) {
      // Nothing to kill. Still clear meta.json so other sessions don't
      // think there's a Chrome here.
      clearProfileMeta(state.chromeProfileName);
      state.chromeProcess = null;
      state.activePort = CHROME_DEBUG_PORT;
      return;
    }

    try {
      // Try graceful shutdown via CDP first.
      try {
        await chromeHttp('/json/close', 'GET');
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (_e) {
        // Ignore — Chrome might already be dead.
      }

      try {
        process.kill(pidToKill, 'SIGTERM');
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (_e) {
        // Process might already be dead.
      }
    } catch (e) {
      console.error(`Error killing Chrome: ${e.message}`);
    }

    clearProfileMeta(state.chromeProfileName);
    state.chromeProcess = null;
    state.activePort = CHROME_DEBUG_PORT;
  }

  // Switch headless/headed by killing and restarting Chrome on the same port,
  // then reopening any non-blank tabs that were open. Pages re-request via GET,
  // so POST-based state is lost — this is a deliberate trade-off documented in
  // the showBrowser/hideBrowser return strings.
  async function restartInMode({ targetHeadless, alreadyMessage, doneMessage }) {
    if (state.chromeHeadless === targetHeadless) {
      return alreadyMessage;
    }

    const transition = targetHeadless ? 'headless mode (hiding browser window)' : 'headed mode (browser window will be visible)';
    console.error(`Switching to ${transition}...`);
    console.error('WARNING: This will restart Chrome and lose any POST-based page state');

    let currentTabs = [];
    try {
      const tabs = await getTabs();
      currentTabs = tabs.map(t => t.url).filter(url => url && url !== 'about:blank');
    } catch (_e) {
      // Chrome not running — nothing to capture.
    }

    const savedPort = state.activePort;
    await killChrome();
    await startChrome(targetHeadless, null, savedPort);

    if (currentTabs.length > 0) {
      console.error(`Reopening ${currentTabs.length} tab(s)...`);
      for (const url of currentTabs) {
        try {
          await newTab(url);
        } catch (e) {
          console.error(`Failed to reopen ${url}: ${e.message}`);
        }
      }
    }

    return doneMessage;
  }

  async function showBrowser() {
    return restartInMode({
      targetHeadless: false,
      alreadyMessage: 'Browser is already visible',
      doneMessage: 'Browser window is now visible. Note: Pages were reloaded via GET requests.',
    });
  }

  async function hideBrowser() {
    return restartInMode({
      targetHeadless: true,
      alreadyMessage: 'Browser is already in headless mode',
      doneMessage: 'Browser is now in headless mode. Note: Pages were reloaded via GET requests.',
    });
  }

  async function getBrowserMode() {
    return {
      headless: state.chromeHeadless,
      mode: state.chromeHeadless ? 'headless' : 'headed',
      running: state.chromeProcess !== null,
      pid: state.chromeProcess ? state.chromeProcess.pid : null,
      port: state.activePort,
      profile: state.chromeProfileName,
      profileDir: state.chromeUserDataDir
    };
  }

  function getChromePid() {
    return state.chromeProcess ? state.chromeProcess.pid : null;
  }

  function getActivePort() {
    return state.activePort;
  }

  function getProfileName() {
    return state.chromeProfileName;
  }

  function setProfileName(profileName) {
    if (!/^[a-zA-Z0-9_-]+$/.test(profileName)) {
      throw new Error('Invalid profile name. Only alphanumeric characters, hyphens, and underscores are allowed.');
    }
    if (state.chromeProcess) {
      throw new Error('Cannot change profile while Chrome is running. Kill Chrome first.');
    }
    state.chromeProfileName = profileName;
    state.chromeUserDataDir = null; // Reset so next startChrome() uses new profile
    return `Profile set to: ${profileName}`;
  }

  return {
    startChrome,
    killChrome,
    showBrowser,
    hideBrowser,
    getBrowserMode,
    getChromePid,
    getActivePort,
    getProfileName,
    setProfileName,
  };
}

module.exports = { attachChromeProcess };
