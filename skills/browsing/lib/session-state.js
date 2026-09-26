const { createOverride } = require('../host-override');

/**
 * Build the per-session mutable state bag.
 *
 * Every Chrome session has a small set of mutable values that the rest of
 * the library reads and writes: the active CDP port, per-tab
 * console-message buffers, the launched Chrome process handle, the chosen
 * profile name and data directory, the headless flag, and the auto-capture
 * session directory and counter.
 *
 * Pulling them into one object (and one file) makes the per-session
 * surface explicit, lets methods that get extracted to sibling files
 * accept it as a single parameter, and keeps the rest of chrome-ws-lib
 * focused on behaviour rather than state.
 *
 * `host`/`port` are forwarded to `createOverride` to seed the per-session
 * host-override; omitting them seeds from the `CHROME_WS_HOST` /
 * `CHROME_WS_PORT` env vars (see host-override.js).
 */
function createState({ host, port } = {}) {
  const hostOverride = createOverride({ host, port });

  // CHROME_WS_PROFILE is the way to opt into a stable named profile from
  // outside this process — typically used to share a Chrome instance across
  // MCP restarts or between cooperating tools. When it's set, we treat the
  // profile as explicit and skip auto-disambiguation in chrome-process.js.
  const envProfile = process.env.CHROME_WS_PROFILE;
  const profileFromEnv = envProfile && /^[a-zA-Z0-9_-]+$/.test(envProfile)
    ? envProfile
    : null;

  return {
    hostOverride,
    rewriteWsUrl: hostOverride.rewriteWsUrl,

    // Dynamic port: updated by startChrome() when Chrome launches or reconnects.
    activePort: hostOverride.getPort(),

    // Per-tab buffer of console messages for auto-capture.
    consoleMessages: new Map(),

    // Auto-capture session: lazily initialised on first capture.
    sessionDir: null,
    captureCounter: 0,

    // Chrome process management.
    chromeProcess: null,
    chromeHeadless: true,
    chromeUserDataDir: null,
    chromeProfileName: profileFromEnv || 'superpowers-chrome',
    // True when the profile name came from env/set_profile rather than the
    // default. chrome-process.js uses this to decide whether to auto-pick an
    // unused alternate name on startup.
    _profileExplicit: profileFromEnv !== null,

    // Bridge primitives: the session's BrowserBridge instance and active BrowserSession.
    browserBridge: null,
    browserSession: null,

    // Sticky tab state: updated by switch_tab, new_tab, close_tab.
    activeTab: 0,
  };
}

module.exports = { createState };
