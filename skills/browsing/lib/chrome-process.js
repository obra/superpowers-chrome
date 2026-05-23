const {
  readProfileMeta,
  writeProfileMeta,
  clearProfileMeta,
  isPortAlive,
  findAvailablePort,
  findPidOnPort,
  findOrphanChromeForProfile,
  buildChromeArgs,
  getChromeProfileDir,
} = require('./chrome-launcher-helpers');
const profileLock = require('./profile-lock');
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

  // Per-MCP-instance lock on the profile name. Acquired lazily on the first
  // startChrome that uses the default-derived profile. Released by the exit
  // handler below.
  function ensureProfileLock() {
    if (state._profileLockPath) return; // already locked

    // Don't auto-disambiguate when the caller (or env) was explicit about the
    // profile. An explicit profile signals intentional sharing — the user
    // wants subsequent MCPs to reconnect to that exact Chrome.
    if (state._profileExplicit) {
      const lockPath = profileLock.acquire(state.chromeProfileName);
      if (lockPath) state._profileLockPath = lockPath;
      // If we can't get it (another live MCP holds the same explicit name),
      // we still proceed — the existing reconnect/adopt flow takes over and
      // the user gets what they asked for: a shared Chrome.
      return;
    }

    const { profileName, lockPath, slot } =
      profileLock.acquireWithFallback(state.chromeProfileName);
    if (slot > 1) {
      console.error(
        `Another MCP holds profile '${state.chromeProfileName}'; ` +
        `using '${profileName}' instead. Set CHROME_WS_PROFILE to opt out of auto-disambiguation.`
      );
      state.chromeProfileName = profileName;
      // Force the launcher to rederive userDataDir from the new name on next
      // spawn — the cached one points at the old (locked) profile dir.
      state.chromeUserDataDir = null;
    }
    state._profileLockPath = lockPath;
  }

  // Release the lock when this MCP process exits. Registered once per attach.
  // Both 'exit' (clean) and the SIG* paths are covered. fs.unlinkSync in the
  // 'exit' handler is intentional — async work can't run there.
  if (!state._profileLockExitHandlerRegistered) {
    state._profileLockExitHandlerRegistered = true;
    const releaseOnce = () => {
      if (state._profileLockPath) {
        profileLock.release(state._profileLockPath);
        state._profileLockPath = null;
      }
    };
    process.on('exit', releaseOnce);
    process.on('SIGINT', () => { releaseOnce(); process.exit(130); });
    process.on('SIGTERM', () => { releaseOnce(); process.exit(143); });
  }

  async function startChrome(headless = null, profileName = null, port = null) {
    if (headless !== null) {
      state.chromeHeadless = headless;
    }
    if (profileName !== null) {
      state.chromeProfileName = profileName;
      state._profileExplicit = true;
    }

    // First-call lock acquisition. Auto-disambiguates when the default profile
    // is contended; respects explicit profile choice.
    ensureProfileLock();

    // --- Step 1: Reuse an already-running Chrome on this profile ---
    // Enables reconnection after MCP restart while Chrome is still alive.
    if (!port) {
      const meta = readProfileMeta(state.chromeProfileName);
      if (meta && meta.port) {
        if (await isPortAlive(CHROME_DEBUG_HOST, meta.port, meta.pid)) {
          state.activePort = meta.port;
          console.error(`Reconnected to existing Chrome (port: ${meta.port}, PID: ${meta.pid}, profile: ${state.chromeProfileName})`);
          return false; // reconnected — no new Chrome spawned
        }
        // Stale meta.json — Chrome died without cleanup
        clearProfileMeta(state.chromeProfileName);
      }

      // --- Step 1.5: Adopt an orphan Chrome that holds our profile lock ---
      // If a previous MCP session exited without cleanup, there may be a Chrome
      // still running with our profile. Detect via process inspection: filter ps for
      // chrome processes with --user-data-dir=<our profile dir> and --remote-debugging-port=N.
      const orphanInfo = await Promise.resolve().then(() => findOrphanChromeForProfile(state.chromeProfileName));
      if (orphanInfo && await isPortAlive(CHROME_DEBUG_HOST, orphanInfo.port, orphanInfo.pid)) {
        state.activePort = orphanInfo.port;
        // Persist meta.json so subsequent runs hit Step 1 directly.
        writeProfileMeta(state.chromeProfileName, { port: orphanInfo.port, pid: orphanInfo.pid });
        console.error(`Adopted orphan Chrome (port: ${orphanInfo.port}, PID: ${orphanInfo.pid}, profile: ${state.chromeProfileName})`);
        return false; // adopted — no new Chrome spawned
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

    // Clear the handle if Chrome exits on its own after launch.
    proc.on('exit', () => {
      if (state.chromeProcess === proc) {
        state.chromeProcess = null;
      }
    });

    // Poll until Chrome's debug port is accepting connections (or 15s timeout).
    const POLL_INTERVAL_MS = 200;
    const POLL_TIMEOUT_MS = 15000;
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await isPortAlive(CHROME_DEBUG_HOST, chosenPort)) break;
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    if (!(await isPortAlive(CHROME_DEBUG_HOST, chosenPort))) {
      state.chromeProcess = null;
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
    return true; // new Chrome was spawned
  }

  async function closeBridge() {
    if (!state.browserSession) return;
    // Race against a short timeout — don't let a hung close block SIGTERM.
    await Promise.race([
      Promise.resolve().then(() => state.browserSession.close()).catch(() => {}),
      new Promise((r) => setTimeout(r, 500)),
    ]);
  }

  async function killChrome() {
    await closeBridge();
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
      state.resetBridge?.();
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
    state.resetBridge?.();
  }

  // Switch headless/headed by killing and restarting Chrome on the same port,
  // then reopening any non-blank tabs that were open. Pages re-request via GET,
  // so POST-based state is lost — this is a deliberate trade-off documented in
  // the showBrowser/hideBrowser return strings.
  async function restartInMode({ targetHeadless, alreadyMessage, doneMessage }) {
    // Only skip the restart if Chrome is actually running in the desired mode.
    // After an external kill the mode flag may be stale, so cross-check with
    // an actual liveness probe before returning the "already X" short-circuit.
    if (state.chromeHeadless === targetHeadless) {
      const chromeAlive = state.activePort
        ? await isPortAlive(CHROME_DEBUG_HOST, state.activePort)
        : false;
      if (chromeAlive) {
        return alreadyMessage;
      }
      // Chrome is dead despite matching mode flag — fall through and restart.
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

    await killChrome();
    // killChrome() resets state.activePort to CHROME_DEBUG_PORT; use that
    // reset value rather than a pre-kill snapshot which may carry a wedged port.
    await startChrome(targetHeadless, null, null);

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
    // If we spawned Chrome ourselves, trust the handle and report directly.
    // killChrome/exit handlers clear chromeProcess, so a non-null handle is
    // the strongest signal that Chrome is alive.
    let running, pid;
    if (state.chromeProcess) {
      running = true;
      pid = state.chromeProcess.pid;
    } else {
      // Bridge reconnected to a Chrome we didn't spawn — either via
      // meta.json (prior MCP session left it running) or orphan adoption.
      // state.chromeProcess is null but state.activePort is set and the
      // CDP works. Resolve the pid from meta.json or port scan, then
      // verify Chrome is actually answering on activePort.
      const meta = readProfileMeta(state.chromeProfileName);
      pid = (meta && meta.pid) ? meta.pid : (state.activePort ? findPidOnPort(state.activePort) : null);
      running = state.activePort
        ? await isPortAlive(CHROME_DEBUG_HOST, state.activePort, pid)
        : false;
      if (!running) pid = null;
    }

    // Always report the configured profile/profileDir/port so the caller knows
    // what would happen on next start, regardless of whether Chrome is running.
    // When stopped, chromeUserDataDir may be null (not yet derived); derive it
    // lazily from the profile name so the response is always informative.
    const profileDir = state.chromeUserDataDir ?? getChromeProfileDir(state.chromeProfileName);
    return {
      headless: state.chromeHeadless,
      mode: state.chromeHeadless ? 'headless' : 'headed',
      running,
      pid,
      port: state.activePort,
      profile: state.chromeProfileName,
      profileDir,
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
    // An explicit set_profile is the user opting OUT of auto-disambiguation:
    // they want to share Chrome with another process that uses this exact
    // name. Release whatever default-slot lock we already hold (if any), set
    // the flag so ensureProfileLock() takes the explicit path next time, and
    // forget the previous lock path.
    if (state._profileLockPath) {
      profileLock.release(state._profileLockPath);
      state._profileLockPath = null;
    }
    state._profileExplicit = true;
    state.chromeProfileName = profileName;
    state.chromeUserDataDir = null; // Reset so next startChrome() uses new profile
    state.activePort = CHROME_DEBUG_PORT; // Reset so a prior rotated port doesn't carry forward
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
