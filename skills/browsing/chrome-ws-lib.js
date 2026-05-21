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
const { attachTabs, createPageSessionResolver } = require('./lib/tabs');
const { createBrowserSession } = require('./lib/browser-session');
const { attachBrowserBridge } = require('./lib/browser-bridge');
const { attachFileUpload } = require('./lib/file-upload');
const { attachCdpConnection } = require('./lib/cdp-connection');
const { attachConsoleLogging } = require('./lib/console-logging');
const { attachSelectOption } = require('./lib/select-option');
const { attachDialogs, DialogRefusedError } = require('./lib/dialogs');
const { renderSyntheticArtifacts } = require('./lib/dialogs-render');
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
 * Session methods whose CDP work targets the page (tab) target.
 * When a native browser dialog is open, these methods will wedge waiting for a
 * CDP response that never arrives because the dialog blocks the JS runtime.
 * The session-boundary wrapper below refuses them with a descriptive error
 * rather than hanging until timeout.
 *
 * Browser-target methods (getTabs, newTab, closeTab, startChrome, …) are NOT
 * listed here — they route through the browser target and work fine while a
 * dialog is open.
 */
const PAGE_TARGET_SESSION_METHODS = new Set([
  'navigate',
  'click',
  'fill',
  'selectOption',
  'evaluate',
  'extractText',
  'getHtml',
  'getAttribute',
  'waitForElement',
  'waitForText',
  'screenshot',
  'hover',
  'drag',
  'mouseMove',
  'scroll',
  'doubleClick',
  'rightClick',
  'humanType',
  'fileUpload',
  'keyboardPress',
  'clickWithCapture',
  'fillWithCapture',
  'selectOptionWithCapture',
  'evaluateWithCapture',
  'captureActionWithDiff',
  'setViewport',
  'clearViewport',
  'getViewport',
]);

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
function createSession({ host, port, _testFakes } = {}) {
  const state = createState({ host, port });

  // =============================================================================
  const cdpApi = attachCdpConnection({ state });
  const {
    sendCdpCommand,
    closePooledConnection,
    closeAllConnections,
  } = cdpApi;

  const dialogs = attachDialogs({ state, sendCdpCommand });
  cdpApi.setDialogs(dialogs);

  const { chromeHttp, resolveWsUrl, getTabs, newTab, closeTab } = attachTabs({ state });

  // Bridge primitives — coexist with the per-tab pool during the migration.
  // The browser-session is constructed immediately (lazy connect on first use).
  // attachBrowserBridge issues Target.setDiscoverTargets which connects the root
  // WS, so we defer it behind state.ensureBridge() (lazy).
  const effectiveChromeHttp = (_testFakes && _testFakes.chromeHttp) ? _testFakes.chromeHttp : chromeHttp;
  state.browserSession = createBrowserSession({
    host: state.hostOverride.getHost(),
    port: state.hostOverride.getPort(),
    rewriteWsUrl: state.rewriteWsUrl,
    chromeHttp: effectiveChromeHttp,
    WebSocketClient: _testFakes && _testFakes.WebSocketClient,
  });

  let bridgePromise = null;
  state.ensureBridge = () => {
    if (state.browserBridge) return Promise.resolve(state.browserBridge);
    if (bridgePromise) return bridgePromise;
    bridgePromise = (async () => {
      const bridge = await attachBrowserBridge({
        browser: state.browserSession,
        host: state.hostOverride.getHost(),
        port: state.hostOverride.getPort(),
        rewriteWsUrl: state.rewriteWsUrl,
      });
      state.browserBridge = bridge;
      state.pageSessionResolver = createPageSessionResolver({ bridge });
      return bridge;
    })();
    // Clear bridgePromise on failure so the next call retries
    bridgePromise.catch(() => { bridgePromise = null; });
    return bridgePromise;
  };

  // getPageSession(tabIndexOrWsUrl) — shared resolver for pageSession-migrated libs.
  // Accepts either a numeric tab index or a ws:// URL, lazy-boots the bridge, and
  // returns a cached pageSession for the target. Reused by E2-E13 migration libs.
  async function getPageSession(tabIndexOrWsUrl) {
    await state.ensureBridge();
    let tab;
    if (typeof tabIndexOrWsUrl === 'number') {
      const tabs = await getTabs();
      tab = tabs[tabIndexOrWsUrl];
      if (!tab) throw new Error(`No tab at index ${tabIndexOrWsUrl}`);
    } else if (typeof tabIndexOrWsUrl === 'string') {
      // Extract targetId from a ws URL like ws://host:port/devtools/page/<targetId>
      const m = /\/devtools\/page\/([^/]+)$/.exec(tabIndexOrWsUrl);
      if (!m) throw new Error(`Cannot extract targetId from: ${tabIndexOrWsUrl}`);
      tab = { id: m[1] };
    } else if (tabIndexOrWsUrl && tabIndexOrWsUrl.id) {
      // Already a tab handle
      tab = tabIndexOrWsUrl;
    } else {
      throw new Error('Unrecognized tabIndexOrWsUrl');
    }
    return state.pageSessionResolver(tab);
  }

  const { click, hover, drag, mouseMove, scroll, doubleClick, rightClick } =
    attachMouse({ resolveWsUrl, sendCdpCommand, dialogs });

  const { keyboardPress, fill, humanType } =
    attachKeyboardInput({ state, resolveWsUrl, sendCdpCommand, click, dialogs });

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
    dialogs,
  });

  const { navigate, waitForElement, waitForText } =
    attachNavigation({ state, resolveWsUrl, sendCdpCommand, capturePageArtifacts, evaluate });

  const { setViewport, clearViewport, getViewport } = attachViewport({ resolveWsUrl, sendCdpCommand });
  const { clearCookies } = attachCookies({ getPageSession });

  // ---------------------------------------------------------------------------
  // Session-boundary dialog gate
  //
  // Wraps every page-target method so that any call issued while a native dialog
  // is open returns a structured refusal instead of hanging until a CDP timeout.
  //
  // Convention (mirrors all other page-target methods in this library):
  //   fn(tabIndexOrWsUrl, selectorOrArg, ...rest)
  //
  // If the second argument is a string beginning with "dialog::", it is a
  // dialog-selector call (e.g. click("dialog::accept")) and must be allowed
  // through so the existing internal routers in mouse.js and keyboard-input.js
  // can handle it.
  // ---------------------------------------------------------------------------
  function wrapWithDialogGate(_name, fn) {
    return async function dialogGated(tabIndexOrWsUrl, secondArg, ...rest) {
      // Resolve the ws URL so we can look up dialog state.
      // resolveWsUrl may throw (e.g., no Chrome running) — let it propagate
      // naturally; that's not a dialog problem.
      let wsUrl;
      try {
        wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
      } catch {
        // Can't resolve the URL — delegate and let the method surface the error.
        return fn(tabIndexOrWsUrl, secondArg, ...rest);
      }

      const open = dialogs.getOpen(wsUrl);
      const isDialogSelector = typeof secondArg === 'string' && secondArg.startsWith('dialog::');

      if (open && !isDialogSelector) {
        throw new DialogRefusedError({ dialog: open, artifacts: renderSyntheticArtifacts(open) });
      }

      return fn(tabIndexOrWsUrl, secondArg, ...rest);
    };
  }

  // Build the raw session object, then wrap page-target methods.
  const rawSession = {
    // State bag (exposed for bridge consumers and testing)
    state,

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

  // Apply the session-boundary dialog gate to every page-target method.
  for (const name of PAGE_TARGET_SESSION_METHODS) {
    if (typeof rawSession[name] === 'function') {
      rawSession[name] = wrapWithDialogGate(name, rawSession[name]);
    }
  }

  return rawSession;
}

module.exports = { createSession, PAGE_TARGET_SESSION_METHODS, DialogRefusedError };
