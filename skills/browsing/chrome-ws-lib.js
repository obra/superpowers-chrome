/**
 * Chrome WebSocket Library — Core CDP automation functions
 *
 * The orchestrator: a thin wiring layer over `lib/*.js` modules.
 *
 * Page-action commands ride a single browser-level CDP WebSocket
 * (lib/browser-session.js) via `Target.attachToTarget({flatten:true})`
 * sessions. Per-page WebSockets are no longer used as the transport for
 * actions — the page session (lib/page-session.js) does the work, with
 * sessionId routing handled by lib/cdp-router.js. That subsystem
 * (browser-session + cdp-router + page-session + browser-bridge) replaces
 * the per-page connection pool that previously lived in lib/cdp-connection.js.
 *
 * The bridge is lazy: the browser-WS is opened on first targets/context/
 * page-session access, not at createSession() time. That way the
 * remote-Chrome path (where the caller passes `{host, port}` of an
 * already-running Chrome and skips startChrome) works through the same
 * code path as the local-launched case.
 *
 * Fixes implemented:
 * - JRV-130: focus survives across Runtime.evaluate calls (now via the
 *   persistent page session — same property as the old pool, simpler
 *   substrate)
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
const { attachConsoleLogging } = require('./lib/console-logging');
const { attachSelectOption } = require('./lib/select-option');
const { createBrowserSession } = require('./lib/browser-session');
const { attachBrowserBridge } = require('./lib/browser-bridge');
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
 * state: console-message buffers, the chosen profile name, the launched
 * Chrome process handle, the active CDP port, and the host-override config.
 * Two consumers in the same process therefore drove a single Chrome.
 *
 * `createSession({ host, port })` returns a fresh instance with private state
 * and methods bound to that state. Two instances do not share a console-message
 * map, profile, Chrome process, host-override, or browser-WS bridge.
 * Pass `host`/`port` to seed the host-override; omit them to seed from the
 * `CHROME_WS_HOST` / `CHROME_WS_PORT` env vars.
 */
function createSession({ host, port } = {}) {
  const state = createState({ host, port });

  // ===== Tabs / chromeHttp / resolveWsUrl =====
  const tabsApi = attachTabs({ state });
  const { chromeHttp, getTabs, newTab, closeTab } = tabsApi;

  // ===== Browser-WS bridge (lazy) =====
  // The browser-WS is opened the first time a consumer reaches for the
  // bridge surface (targets, createBrowserContext, attachPageSession, or
  // any action lib via getPageSession). It is NOT opened in startChrome —
  // the remote-Chrome path bypasses startChrome entirely, and lazy-open
  // serves both modes with one code path.
  let _browser = null;
  let _bridge = null;

  async function _ensureBridge() {
    if (_bridge) return _bridge;
    if (!_browser) {
      _browser = createBrowserSession({
        host: state.hostOverride.getHost(),
        port: state.activePort,
        rewriteWsUrl: state.rewriteWsUrl,
        chromeHttp,
      });
    }
    _bridge = await attachBrowserBridge({
      browser: _browser,
      host: state.hostOverride.getHost(),
      port: state.activePort,
      rewriteWsUrl: state.rewriteWsUrl,
    });
    return _bridge;
  }

  async function _closeBridge() {
    if (_browser) {
      try { await _browser.close(); } catch { /* best-effort */ }
      _browser = null;
      _bridge = null;
    }
  }

  // Public bridge wrappers — each lazy-opens the browser-WS on first use.
  const targets = {
    async list()                        { return (await _ensureBridge()).targets.list(); },
    async onCreated(fn)                 { return (await _ensureBridge()).targets.onCreated(fn); },
    async onDestroyed(fn)               { return (await _ensureBridge()).targets.onDestroyed(fn); },
    async waitForNew(predicate, opts)   { return (await _ensureBridge()).targets.waitForNew(predicate, opts); },
  };

  async function createBrowserContext(opts) {
    return (await _ensureBridge()).createBrowserContext(opts);
  }

  /**
   * Attach a page session to an existing target. Returns
   * `{sessionId, targetId, send, onEvent, waitForEvent, enableDomain, detach}`.
   * Page sessions ride the browser-WS via `Target.attachToTarget({flatten:true})`
   * — no per-page WebSocket, no per-page WS-drop race.
   */
  async function attachPageSession(targetId) {
    return (await _ensureBridge()).attachPageSession(targetId);
  }

  // Wire the lazy attacher into tabs.js so tab handles returned by
  // getTabs() / newTab() carry a `getPageSession()` thunk. The thunk goes
  // through _ensureBridge → bridge.attachPageSession at call time, so
  // there's no construction-order dependency between tabs and the bridge.
  tabsApi.setPageSessionAttacher((targetId) => attachPageSession(targetId));

  /**
   * Action-lib argument resolver.
   *
   * Accepts the legacy shapes that tools/tests use today (numeric tab index,
   * `ws://...` URL, numeric string) AND the new shape (an existing
   * pageSession object) and returns the corresponding pageSession.
   */
  async function getPageSession(arg) {
    // Already a pageSession? Pass through.
    if (arg && typeof arg.send === 'function' && arg.sessionId) {
      return arg;
    }

    // Numeric or numeric-string index — index into the current tabs list.
    if (typeof arg === 'number' || (typeof arg === 'string' && /^\d+$/.test(arg))) {
      const idx = typeof arg === 'number' ? arg : parseInt(arg, 10);
      const allTabs = await getTabs();
      const pageTabs = allTabs.filter((t) => t.type === 'page');

      // Auto-create a tab if none exist (matches the legacy auto-start
      // behaviour of resolveWsUrl — tools shouldn't have to special-case
      // fresh Chrome).
      if (pageTabs.length === 0) {
        const newTabInfo = await newTab();
        if (!newTabInfo || !newTabInfo.getPageSession) {
          throw new Error('getPageSession: newTab failed to return a tab handle');
        }
        return newTabInfo.getPageSession();
      }

      if (!pageTabs[idx]) throw new Error(`getPageSession: no tab at index ${idx} (have ${pageTabs.length})`);
      return pageTabs[idx].getPageSession();
    }

    // ws:// URL — find the matching tab.
    if (typeof arg === 'string' && arg.startsWith('ws://')) {
      const allTabs = await getTabs();
      const rewritten = state.rewriteWsUrl(arg, state.hostOverride.getHost(), state.activePort);
      const tab = allTabs.find((t) => t.webSocketDebuggerUrl === rewritten || t.webSocketDebuggerUrl === arg);
      if (!tab) throw new Error(`getPageSession: no tab found for ${arg}`);
      return tab.getPageSession();
    }

    throw new Error(`getPageSession: unsupported arg type: ${typeof arg}`);
  }

  // ===== Action libs =====
  const { click, hover, drag, mouseMove, scroll, doubleClick, rightClick } =
    attachMouse({ getPageSession });

  const { keyboardPress, fill, humanType } =
    attachKeyboardInput({ state, getPageSession, click });

  const { fileUpload } = attachFileUpload({ getPageSession });

  const { selectOption } = attachSelectOption({ getPageSession });

  const { evaluate } = attachEvaluation({ getPageSession });

  const { extractText, getHtml, getAttribute } = attachExtraction({ getPageSession });

  const { screenshot } = attachScreenshot({ getPageSession });

  const { startChrome, killChrome, showBrowser, hideBrowser, getBrowserMode, getChromePid, getActivePort, getProfileName, setProfileName } =
    attachChromeProcess({ state, chromeHttp, getTabs, newTab, closeBridge: _closeBridge });

  const { enableConsoleLogging, getConsoleMessages, clearConsoleMessages } =
    attachConsoleLogging({ state, getPageSession });

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
    getPageSession,
    getHtml,
    screenshot,
    actions: { click, fill, selectOption, evaluate },
  });

  const { navigate, waitForElement, waitForText } =
    attachNavigation({ state, getPageSession, capturePageArtifacts, evaluate });

  const { setViewport, clearViewport, getViewport } = attachViewport({ getPageSession });
  const { clearCookies } = attachCookies({ getPageSession });

  return {
    // Internal helpers (exported for testing)
    getElementSelector,

    // Core browser actions (click/fill use CDP events by default for React compatibility)
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

    // Browser-WS bridge — Target.* events, BrowserContext create/dispose,
    // and per-page CDP sessions over the shared browser-WS.
    targets,
    createBrowserContext,
    attachPageSession,

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

  };
}

module.exports = { createSession };
