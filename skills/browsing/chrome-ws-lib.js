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
  'back',
  'forward',
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
  // captureActionWithDiff is intentionally excluded: it is a meta-wrapper whose
  // second arg is an action-type string ('type', 'click', …), not a selector.
  // The inner actions it wraps (humanType, click, hover, etc.) are individually
  // listed above and each have their own dialog gating via
  // withDialogAwarenessForSession in capture.js.  Re-gating the wrapper at this
  // boundary would cause it to refuse dialog::* selectors before the inner action
  // ever sees them (scenario 10C basic-auth typing bug).
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
  const dialogs = attachDialogs({ state });

  const { chromeHttp, resolveWsUrl, getTabs, newTab, closeTab } = attachTabs({ state });

  // Bridge primitives — single root WebSocket with flatten-mode page sessions.
  // The browser-session is constructed immediately (lazy connect on first use).
  // attachBrowserBridge issues Target.setDiscoverTargets which connects the root
  // WS, so we defer it behind state.ensureBridge() (lazy).
  const effectiveChromeHttp = (_testFakes && _testFakes.chromeHttp) ? _testFakes.chromeHttp : chromeHttp;
  const browserSessionFactory = () => createBrowserSession({
    host: state.hostOverride.getHost(),
    port: state.hostOverride.getPort(),
    rewriteWsUrl: state.rewriteWsUrl,
    chromeHttp: effectiveChromeHttp,
    WebSocketClient: _testFakes && _testFakes.WebSocketClient,
  });
  state.browserSession = browserSessionFactory();

  let bridgePromise = null;

  // Reset all bridge-layer state so the next ensureBridge() call re-attaches from
  // scratch. Called by killChrome (explicit kill) and ensureBridge (stale detection).
  // Does NOT call detach on cached pageSessions — the underlying WebSocket is
  // already dead at call time, so detach would fail. Use resolver.release() per-tab
  // before calling resetBridge if graceful cleanup is possible.
  state.resetBridge = () => {
    if (state.pageSessionResolver) {
      state.pageSessionResolver.releaseAll();
    }
    state.pageSessionResolver = null;
    state.browserBridge = null;
    state.browserSession = browserSessionFactory();
    bridgePromise = null;
  };

  state.ensureBridge = () => {
    // Detect stale bridge: if the cached browserSession is no longer connected,
    // reset everything so we re-attach to the restarted Chrome process.
    if (state.browserBridge && state.browserSession && !state.browserSession.isConnected()) {
      state.resetBridge();
    }
    if (state.browserBridge) return Promise.resolve(state.browserBridge);
    if (bridgePromise) return bridgePromise;
    bridgePromise = (async () => {
      const bridge = await attachBrowserBridge({
        browser: state.browserSession,
        host: state.hostOverride.getHost(),
        port: state.hostOverride.getPort(),
        rewriteWsUrl: state.rewriteWsUrl,
        autoAttach: true,
        onPageSession: async (ps) => {
          // Install dialog shim before the paused target resumes.
          // This gives popups, OAuth windows, and child frames dialog
          // handling from their very first script.
          try {
            await dialogs.attachToPageSession(ps);
          } catch (e) {
            console.error('onPageSession dialog attach failed:', e);
          }
          // Prime the pageSession resolver cache so subsequent getPageSession(popup)
          // calls return THIS session rather than issuing a duplicate Target.attachToTarget.
          // The dialog is registered under THIS session's sessionId; agent commands
          // must route through the same session to handle the dialog.
          if (state.pageSessionResolver && ps.targetId) {
            state.pageSessionResolver.prime(ps.targetId, ps);
          }
        },
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
    const ps = await state.pageSessionResolver(tab);
    // Ensure dialog event listeners are wired up on the bridge session the first
    // time a page session is obtained. This enables Page.javascriptDialogOpening
    // events to arrive via the bridge path (stored under sessionId).
    await dialogs.attachToPageSession(ps);
    return ps;
  }

  const { click, hover, drag, mouseMove, scroll, doubleClick, rightClick } =
    attachMouse({ getPageSession, dialogs });

  const { keyboardPress, fill, humanType } =
    attachKeyboardInput({ state, getPageSession, click, dialogs });

  const { fileUpload } = attachFileUpload({ getPageSession });

  const { selectOption } = attachSelectOption({ getPageSession });

  const { evaluate } = attachEvaluation({ getPageSession });

  // =============================================================================

  const { extractText, getHtml, getAttribute } = attachExtraction({ getPageSession });


  // getSessionDir is a lazy thunk: capture.js populates state.sessionDir via
  // initializeSession(). We close over `state` so screenshot.js always reads
  // the freshly-set value. If no capture has happened yet, we delegate to
  // captureInitializer (set below after attachCapture) to create the dir.
  // The ref itself must live before attachScreenshot and attachCapture, but the
  // actual initializeSession function is injected after attachCapture runs.
  const screenshotDirRef = { initializeSession: null };

  const { screenshot } = attachScreenshot({
    getPageSession,
    state,
    initializeSession: () => {
      if (screenshotDirRef.initializeSession) return screenshotDirRef.initializeSession();
      // Fallback if called before attachCapture (shouldn't happen in normal flow).
      if (state.sessionDir) return state.sessionDir;
      throw new Error('Session directory not yet initialized. Call an auto-capture action first.');
    },
  });

  const { startChrome, killChrome, showBrowser, hideBrowser, getBrowserMode, getChromePid, getActivePort, getProfileName, setProfileName } =
    attachChromeProcess({ state, chromeHttp, getTabs, newTab });

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
    dialogs,
  });

  // Wire the forward reference so screenshot.js can call initializeSession.
  screenshotDirRef.initializeSession = initializeSession;

  const { navigate, waitForElement, waitForText, back, forward } =
    attachNavigation({ state, getPageSession, capturePageArtifacts, evaluate });

  const { setViewport, clearViewport, getViewport } = attachViewport({ getPageSession });
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

      // Look up dialog state keyed by sessionId (via targetId→sessionId map populated
      // by attachToPageSession). dialogs.getOpen() handles both direct sessionId keys
      // and wsUrl paths by extracting the targetId from the URL.
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
    back,
    forward,
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
