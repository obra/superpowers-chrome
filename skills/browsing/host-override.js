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

module.exports = {
  CHROME_DEBUG_HOST,
  CHROME_DEBUG_PORT,
  CHROME_DEBUG_BASE,
  rewriteWsUrl,
  WS_OVERRIDE_ENABLED
};
