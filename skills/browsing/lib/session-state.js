const { createOverride } = require('../host-override');

/**
 * Build the per-session mutable state bag.
 *
 * Every Chrome session has a small set of mutable values that the rest of
 * the library reads and writes: the active CDP port, the connection pool,
 * per-tab console-message buffers, the launched Chrome process handle,
 * the chosen profile name and data directory, the headless flag, and the
 * auto-capture session directory and counter.
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
  return {
    hostOverride,
    rewriteWsUrl: hostOverride.rewriteWsUrl,

    // Dynamic port: updated by startChrome() when Chrome launches or reconnects.
    activePort: hostOverride.getPort(),

    // wsUrl -> { ws: WebSocketClient, pendingRequests: Map, messageIdCounter: number }
    connectionPool: new Map(),

    // Per-tab buffer of console messages for auto-capture.
    consoleMessages: new Map(),

    // Auto-capture session: lazily initialised on first capture.
    sessionDir: null,
    captureCounter: 0,

    // Chrome process management.
    chromeProcess: null,
    chromeHeadless: true,
    chromeUserDataDir: null,
    chromeProfileName: 'superpowers-chrome',
  };
}

module.exports = { createState };
