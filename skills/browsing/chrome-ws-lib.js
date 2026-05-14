/**
 * Chrome WebSocket Library - Core CDP automation functions
 * Used by both CLI and MCP server
 *
 * Fixes implemented:
 * - JRV-130: Connection pooling for persistent focus
 * - JRV-127: keyboard_press action for special keys
 * - JRV-123: React-compatible input via Input.insertText
 * - JRV-124: React-compatible click via Input.dispatchMouseEvent
 * - JRV-125: Tab key handling (via keyboard_press)
 * - JRV-126: Better eval return handling
 * - JRV-128: SPA navigation support
 * - JRV-129: Multi-element selector warnings
 */


const { getElementSelector } = require('./lib/element-selector');
const { KEY_DEFINITIONS } = require('./lib/key-definitions');
const { generateHtmlDiff } = require('./lib/html-diff');
const { createState } = require('./lib/session-state');
const { attachCookies } = require('./lib/cookies');
const { attachViewport } = require('./lib/viewport');
const { attachEvaluation } = require('./lib/evaluation');
const { attachMouse } = require('./lib/mouse');
const { attachChromeProcess } = require('./lib/chrome-process');
const { attachCapture } = require('./lib/capture');
const { attachNavigation } = require('./lib/navigation');
const { attachKeyboardInput } = require('./lib/keyboard-input');
const { attachExtraction } = require('./lib/extraction');
const { attachScreenshot } = require('./lib/screenshot');
const { attachTabs } = require('./lib/tabs');
const { attachFileUpload } = require('./lib/file-upload');
const { attachCdpConnection } = require('./lib/cdp-connection');
const { attachConsoleLogging } = require('./lib/console-logging');
const { attachSelectOption } = require('./lib/select-option');
const { attachDialogs } = require('./lib/dialogs');
const {
  getXdgCacheHome,
  getChromeProfileDir,
  getProfileMetaPath,
  readProfileMeta,
  writeProfileMeta,
  clearProfileMeta,
  findAvailablePort,
  buildChromeArgs,
} = require('./lib/chrome-launcher-helpers');

/**
 * Build a fresh Chrome session — a state-bag scoped to a single Chrome target.
 *
 * Pre-factory, every consumer that required this file shared module-level
 * state: the connection pool, console-message buffers, the chosen profile
 * name, the launched Chrome process handle, the active CDP port, and the
 * host-override config. Two consumers in the same process therefore drove a
 * single Chrome — fine for the CLI and the MCP server (each owns its
 * process), but a hazard for any caller that wants to drive multiple Chromes
 * concurrently from one Node process (different ports, different profiles).
 *
 * `createSession({ host, port })` returns a fresh instance with private state
 * and methods bound to that state. Two instances do not share a connection
 * pool, console-message map, profile, Chrome process, or host-override —
 * mutating one (e.g. setProfileName, startChrome) has no effect on the other.
 * Pass `host`/`port` to seed the host-override; omit them to seed from the
 * `CHROME_WS_HOST` / `CHROME_WS_PORT` env vars exactly as before.
 *
 * The returned object preserves the legacy module-level export shape — the
 * one-line consumer migration is `require(...)` becomes
 * `require(...).createSession()`.
 */
function createSession({ host, port } = {}) {
  const state = createState({ host, port });

  // =============================================================================
  const {
    sendCdpCommand,
    closePooledConnection,
    closeAllConnections,
  } = attachCdpConnection({ state });

  const dialogs = attachDialogs({ state, sendCdpCommand });

  const { chromeHttp, resolveWsUrl, getTabs, newTab, closeTab } = attachTabs({ state });

  const { click, hover, drag, mouseMove, scroll, doubleClick, rightClick } =
    attachMouse({ resolveWsUrl, sendCdpCommand });

  const { keyboardPress, fill, humanType } =
    attachKeyboardInput({ state, resolveWsUrl, sendCdpCommand, click });

  const { fileUpload } = attachFileUpload({ resolveWsUrl, sendCdpCommand });

  const { selectOption } = attachSelectOption({ resolveWsUrl, sendCdpCommand });

  const { evaluate } = attachEvaluation({ resolveWsUrl, sendCdpCommand });

  // =============================================================================

  const { extractText, getHtml, getAttribute } = attachExtraction({ resolveWsUrl, sendCdpCommand });


  const { screenshot } = attachScreenshot({ resolveWsUrl, sendCdpCommand });

  const { startChrome, killChrome, showBrowser, hideBrowser, getBrowserMode, getChromePid, getActivePort, getProfileName, setProfileName } =
    attachChromeProcess({ state, chromeHttp, getTabs, newTab });

  const { enableConsoleLogging, getConsoleMessages, clearConsoleMessages } =
    attachConsoleLogging({ state, resolveWsUrl });

  const {
    initializeSession,
    cleanupSession,
    createCapturePrefix,
    generateDomSummary,
    getPageSize,
    generateMarkdown,
    capturePageArtifacts,
    captureActionWithDiff,
    clickWithCapture,
    fillWithCapture,
    selectOptionWithCapture,
    evaluateWithCapture,
  } = attachCapture({
    state,
    resolveWsUrl,
    sendCdpCommand,
    getHtml,
    screenshot,
    actions: { click, fill, selectOption, evaluate },
  });

  const { navigate, waitForElement, waitForText } =
    attachNavigation({ state, resolveWsUrl, sendCdpCommand, capturePageArtifacts, evaluate });

  const { setViewport, clearViewport, getViewport } = attachViewport({ resolveWsUrl, sendCdpCommand });
  const { clearCookies } = attachCookies({ resolveWsUrl, sendCdpCommand });

  return {
    // Internal helpers (exported for testing)
    getElementSelector,

    // Core browser actions (click/fill now use CDP events by default for React compatibility)
    getTabs,
    newTab,
    closeTab,
    navigate,
    click,           // Uses CDP mouse events, falls back to el.click()
    fill,            // Uses CDP insertText, falls back to el.value=
    selectOption,    // Warns if selector matches multiple elements
    evaluate,
    extractText,
    getHtml,
    getAttribute,
    waitForElement,
    waitForText,
    screenshot,

    // Mouse actions (CDP-level, bypasses synthetic event restrictions)
    hover,            // Move mouse over element (CSS :hover, tooltips)
    drag,             // Drag-and-drop via native mouse event sequence
    mouseMove,        // Raw coordinate mouse movement
    scroll,           // Mouse wheel scrolling
    doubleClick,      // Double-click with dblclick event
    rightClick,       // Right-click with contextmenu event

    // Human-like typing (individual keyDown/keyUp with realistic timing)
    humanType,

    // File upload (DOM.setFileInputFiles — can't be done via JS)
    fileUpload,

    // Keyboard support for special keys (Tab, Enter, Escape, Arrow keys, etc.)
    keyboardPress,
    KEY_DEFINITIONS,

    // Chrome lifecycle
    startChrome,
    buildChromeArgs,
    killChrome,
    showBrowser,
    hideBrowser,
    getBrowserMode,
    getChromePid,

    // Profile management
    getChromeProfileDir,
    getProfileName,
    setProfileName,

    // Console logging
    enableConsoleLogging,
    getConsoleMessages,
    clearConsoleMessages,

    // Session management
    getXdgCacheHome,
    initializeSession,
    cleanupSession,
    createCapturePrefix,

    // Auto-capture utilities
    generateDomSummary,
    getPageSize,
    generateMarkdown,
    capturePageArtifacts,
    clickWithCapture,
    fillWithCapture,
    selectOptionWithCapture,
    evaluateWithCapture,

    // DOM diff capture (before/after with diff)
    generateHtmlDiff,
    captureActionWithDiff,

    // Connection management (JRV-130)
    closePooledConnection,
    closeAllConnections,

    // Dynamic port allocation and per-profile meta.json
    getActivePort,
    findAvailablePort,
    getProfileMetaPath,
    readProfileMeta,
    writeProfileMeta,
    clearProfileMeta,

    // Viewport/device emulation
    setViewport,
    clearViewport,
    getViewport,

    // Cookie management
    clearCookies,

    // Dialog awareness
    dialogs,

  };
}

module.exports = { createSession };
