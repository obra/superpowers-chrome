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


const { createOverride } = require('./host-override');
const { getElementSelector, getElementSelectorAll } = require('./lib/element-selector');
const { KEY_DEFINITIONS, charToKeyDef } = require('./lib/key-definitions');
const { generateHtmlDiff } = require('./lib/html-diff');
const { createState } = require('./lib/session-state');
const { attachCookies } = require('./lib/cookies');
const { attachViewport } = require('./lib/viewport');
const { attachEvaluation } = require('./lib/evaluation');
const { attachMouse } = require('./lib/mouse');
const { attachChromeProcess } = require('./lib/chrome-process');
const { attachCapture } = require('./lib/capture');
const { WebSocketClient } = require('./lib/websocket-client');
const { attachNavigation } = require('./lib/navigation');
const { attachKeyboardInput } = require('./lib/keyboard-input');
const { attachExtraction } = require('./lib/extraction');
const { attachScreenshot } = require('./lib/screenshot');
const { attachTabs } = require('./lib/tabs');
const { attachFileUpload } = require('./lib/file-upload');
const { attachCdpConnection } = require('./lib/cdp-connection');
const { attachConsoleLogging } = require('./lib/console-logging');
const {
  PORT_RANGE_START,
  PORT_RANGE_END,
  chromeHttpAt,
  getXdgCacheHome,
  getChromeProfileDir,
  getProfileMetaPath,
  readProfileMeta,
  writeProfileMeta,
  clearProfileMeta,
  isPortAlive,
  isPortFree,
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
  // Convenience aliases for read-once derived values. The hostOverride that
  // backs these is on `state` for any extracted module that needs it.
  const { hostOverride, rewriteWsUrl } = state;
  const CHROME_DEBUG_HOST = hostOverride.getHost();
  const CHROME_DEBUG_PORT = hostOverride.getPort();

  // =============================================================================
  const {
    getPooledConnection,
    sendCdpCommand,
    sendCdpCommandPooled,
    sendCdpCommandSingle,
    closePooledConnection,
    closeAllConnections,
  } = attachCdpConnection({ state });

  const { chromeHttp, resolveWsUrl, getTabs, newTab, closeTab } = attachTabs({ state });



  const { click, hover, drag, mouseMove, scroll, doubleClick, rightClick } =
    attachMouse({ resolveWsUrl, sendCdpCommand });
  // Legacy alias for backwards compatibility
  const cdpClick = click;

  const { keyboardPress, keyboardType, fill, humanType } =
    attachKeyboardInput({ state, resolveWsUrl, sendCdpCommand, click });
  // Legacy alias
  const insertText = fill;

  const { fileUpload } = attachFileUpload({ resolveWsUrl, sendCdpCommand });

  // =============================================================================
  // SELECT FUNCTION (JRV-129: Multi-element warning)
  // =============================================================================

  /**
   * Select dropdown option(s).
   *
   * `value` is a string or array of strings. Each entry matches an <option> by
   * value attribute first, then by trimmed visible label. Arrays require
   * <select multiple>. Replaces the current selection (does not append).
   */
  async function selectOption(tabIndexOrWsUrl, selector, value, index = 0) {
    const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
    const values = Array.isArray(value) ? value : [value];

    // Check how many elements match and warn if multiple
    const countJs = `${getElementSelectorAll(selector)}.length`;
    const countResult = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
      expression: countJs,
      returnByValue: true
    });
    const matchCount = countResult.result.value || 0;

    let warning = null;
    if (matchCount > 1) {
      warning = `Selector "${selector}" matches ${matchCount} elements. Using element at index ${index}. Use a more specific selector or pass index parameter.`;
      console.error(`WARNING: ${warning}`);
    }

    const js = `
      (() => {
        const elements = ${getElementSelectorAll(selector)};
        const el = elements[${index}];
        if (!el) return { success: false, error: 'Element not found at index ${index}' };
        if (el.tagName !== 'SELECT') return { success: false, error: 'Element is not a SELECT' };

        const requested = ${JSON.stringify(values)};
        if (requested.length > 1 && !el.multiple) {
          return { success: false, error: 'Cannot select multiple values on a non-multiple <select>' };
        }

        const options = Array.from(el.options);
        const matched = [];
        const unmatched = [];
        for (const v of requested) {
          const opt = options.find(o => o.value === v) ||
                      options.find(o => o.textContent.trim() === v);
          if (opt) matched.push(opt);
          else unmatched.push(v);
        }
        if (unmatched.length) {
          return { success: false, error: 'No matching option for: ' + JSON.stringify(unmatched) };
        }

        for (const o of options) o.selected = false;
        for (const o of matched) o.selected = true;
        el.dispatchEvent(new Event('change', { bubbles: true }));

        return {
          success: true,
          matchCount: elements.length,
          matched: matched.map(o => ({ value: o.value, text: o.textContent.trim() }))
        };
      })()
    `;

    const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
      expression: js,
      returnByValue: true
    });

    const resultValue = result.result.value;
    if (!resultValue.success) {
      throw new Error(resultValue.error);
    }

    return {
      success: true,
      matchCount: resultValue.matchCount,
      matched: resultValue.matched,
      warning,
      selectedIndex: index
    };
  }

  const { evaluate, evaluateJson, evaluateRaw } = attachEvaluation({ resolveWsUrl, sendCdpCommand });

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

  const { navigate, spaNavigate, hrefNavigate, waitForElement, waitForText } =
    attachNavigation({ state, resolveWsUrl, sendCdpCommand, capturePageArtifacts });

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

    // Legacy aliases (for backwards compatibility)
    cdpClick: click,
    insertText: fill,
  };
}

module.exports = { createSession };
