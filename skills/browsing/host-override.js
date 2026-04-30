const DEFAULT_PORT = 9222;
const DEFAULT_HOST = '127.0.0.1';

const CHROME_DEBUG_PORT = (() => {
  const parsed = parseInt(process.env.CHROME_WS_PORT || `${DEFAULT_PORT}`, 10);
  return Number.isNaN(parsed) ? DEFAULT_PORT : parsed;
})();

const HAS_HOST_OVERRIDE = process.env.CHROME_WS_HOST !== undefined;
const HAS_PORT_OVERRIDE = process.env.CHROME_WS_PORT !== undefined;

const WS_OVERRIDE_ENABLED = HAS_HOST_OVERRIDE || HAS_PORT_OVERRIDE;

const CHROME_DEBUG_HOST = HAS_HOST_OVERRIDE ? process.env.CHROME_WS_HOST : DEFAULT_HOST;
const CHROME_DEBUG_BASE = `http://${CHROME_DEBUG_HOST}:${CHROME_DEBUG_PORT}`;

function rewriteWsUrl(originalUrl, host = CHROME_DEBUG_HOST, port = CHROME_DEBUG_PORT) {
  if (!originalUrl || typeof originalUrl !== 'string') {
    return originalUrl;
  }
  if (!WS_OVERRIDE_ENABLED) {
    return originalUrl;
  }
  try {
    const url = new URL(originalUrl);
    url.hostname = host;
    url.port = `${port}`;
    return url.toString();
  } catch {
    return originalUrl;
  }
}

/**
 * Build a per-instance host-override configuration.
 *
 * The legacy module-level constants and `rewriteWsUrl` above are baked at
 * module-load time and shared across every consumer that requires this
 * file. That's fine for the single-Chrome use case — the CLI and the MCP
 * server each own their process, so module-level state is effectively
 * per-process. It breaks down when one process needs to drive several
 * independent Chrome instances concurrently (different host/port pairs):
 * the load-time constants can only describe one of them.
 *
 * `createOverride({ host, port })` returns a fresh state-bag with its own
 * host/port/override-enabled flag, plus methods (`getHost`, `getPort`,
 * `getBase`, `isOverrideEnabled`, `rewriteWsUrl`, `setDefaults`) bound to
 * that state. Two instances do not share state — mutating one via
 * `setDefaults()` does not affect the other. Callers that don't need
 * per-instance isolation can keep using the module-level constants and
 * `rewriteWsUrl` exactly as before; nothing about the legacy API has
 * changed.
 *
 * Defaults: if both `host` and `port` are omitted, the instance seeds from
 * the same `CHROME_WS_HOST` / `CHROME_WS_PORT` env vars the module-level
 * constants use. If either argument is supplied, both are taken from the
 * arguments (filling in defaults for the missing one) and the instance's
 * `overrideEnabled` flag starts true — matching `setDefaults()` semantics.
 */
function createOverride({ host, port } = {}) {
  let instanceHost;
  let instancePort;
  let instanceOverrideEnabled;

  if (host !== undefined || port !== undefined) {
    instanceHost = host !== undefined ? host : DEFAULT_HOST;
    instancePort = port !== undefined ? port : DEFAULT_PORT;
    instanceOverrideEnabled = true;
  } else {
    instanceHost = process.env.CHROME_WS_HOST || DEFAULT_HOST;
    const parsed = parseInt(process.env.CHROME_WS_PORT || `${DEFAULT_PORT}`, 10);
    instancePort = Number.isNaN(parsed) ? DEFAULT_PORT : parsed;
    instanceOverrideEnabled =
      process.env.CHROME_WS_HOST !== undefined || process.env.CHROME_WS_PORT !== undefined;
  }

  function setDefaults(nextHost, nextPort) {
    instanceHost = nextHost;
    instancePort = nextPort;
    instanceOverrideEnabled = true;
  }

  function getHost() {
    return instanceHost;
  }

  function getPort() {
    return instancePort;
  }

  function getBase() {
    return `http://${instanceHost}:${instancePort}`;
  }

  function isOverrideEnabled() {
    return instanceOverrideEnabled;
  }

  function instanceRewriteWsUrl(originalUrl, overrideHost, overridePort) {
    if (!originalUrl || typeof originalUrl !== 'string') {
      return originalUrl;
    }
    if (!instanceOverrideEnabled) {
      return originalUrl;
    }
    const useHost = overrideHost !== undefined ? overrideHost : instanceHost;
    const usePort = overridePort !== undefined ? overridePort : instancePort;
    try {
      const url = new URL(originalUrl);
      url.hostname = useHost;
      url.port = `${usePort}`;
      return url.toString();
    } catch {
      return originalUrl;
    }
  }

  return {
    setDefaults,
    getHost,
    getPort,
    getBase,
    isOverrideEnabled,
    rewriteWsUrl: instanceRewriteWsUrl,
  };
}

module.exports = {
  CHROME_DEBUG_HOST,
  CHROME_DEBUG_PORT,
  CHROME_DEBUG_BASE,
  rewriteWsUrl,
  WS_OVERRIDE_ENABLED,
  createOverride
};
