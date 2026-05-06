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
  // CONNECTION POOL (JRV-130: Fix focus lost between eval calls)
  // =============================================================================

  /**
   * Get or create a pooled connection for a tab
   */
  async function getPooledConnection(wsUrl) {
    let conn = state.connectionPool.get(wsUrl);

    if (conn && conn.ws.isConnected()) {
      return conn;
    }

    // Create new connection
    const ws = new WebSocketClient(wsUrl);
    conn = {
      ws,
      pendingRequests: new Map(), // id -> { resolve, reject, timeout }
      messageIdCounter: 1
    };

    ws.on('message', (msg) => {
      try {
        const data = JSON.parse(msg);
        if (data.id !== undefined) {
          const pending = conn.pendingRequests.get(data.id);
          if (pending) {
            clearTimeout(pending.timeout);
            conn.pendingRequests.delete(data.id);
            if (data.error) {
              pending.reject(new Error(data.error.message || JSON.stringify(data.error)));
            } else {
              pending.resolve(data.result);
            }
          }
        }
        // Handle events (console messages, etc.)
        if (data.method && conn.eventHandler) {
          conn.eventHandler(data);
        }
      } catch (e) {
        console.error('Error processing CDP message:', e);
      }
    });

    ws.on('close', () => {
      state.connectionPool.delete(wsUrl);
      // Reject all pending requests
      for (const [id, pending] of conn.pendingRequests) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Connection closed'));
      }
      conn.pendingRequests.clear();
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
    });

    await ws.connect();
    state.connectionPool.set(wsUrl, conn);

    return conn;
  }

  /**
   * Send CDP command using pooled connection (maintains focus/state)
   */
  async function sendCdpCommandPooled(wsUrl, method, params = {}, timeout = 30000) {
    const conn = await getPooledConnection(wsUrl);
    const id = conn.messageIdCounter++;

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        conn.pendingRequests.delete(id);
        reject(new Error(`CDP command timeout: ${method}`));
      }, timeout);

      conn.pendingRequests.set(id, { resolve, reject, timeout: timeoutHandle });
      conn.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Close pooled connection for a tab
   */
  function closePooledConnection(wsUrl) {
    const conn = state.connectionPool.get(wsUrl);
    if (conn) {
      conn.ws.close();
      state.connectionPool.delete(wsUrl);
    }
  }

  /**
   * Close all pooled connections
   */
  function closeAllConnections() {
    for (const [wsUrl, conn] of state.connectionPool) {
      conn.ws.close();
    }
    state.connectionPool.clear();
  }

  // HTTP helper with explicit host/port — used for probing ports before setting state.activePort
  // Helper to make HTTP requests to Chrome on the active port
  async function chromeHttp(path, method = 'GET') {
    return chromeHttpAt(CHROME_DEBUG_HOST, state.activePort, path, method);
  }

  // Helper to resolve tab index or ws URL to actual ws URL
  async function resolveWsUrl(wsUrlOrIndex) {
    // If it's already a WebSocket URL, rewrite and return it
    if (typeof wsUrlOrIndex === 'string' && wsUrlOrIndex.startsWith('ws://')) {
      return rewriteWsUrl(wsUrlOrIndex, CHROME_DEBUG_HOST, state.activePort);
    }

    // If it's a number (tab index), resolve it
    const index = typeof wsUrlOrIndex === 'number' ? wsUrlOrIndex : parseInt(wsUrlOrIndex);
    if (!isNaN(index)) {
      const tabs = await chromeHttp('/json');
      if (!Array.isArray(tabs)) {
        throw new Error('Chrome DevTools returned an invalid response — is Chrome running?');
      }
      const pageTabs = tabs.filter(t => t.type === 'page');

      // Auto-create tab if none exist (similar to auto-start Chrome behavior)
      if (pageTabs.length === 0) {
        const newTabInfo = await newTab();
        return newTabInfo.webSocketDebuggerUrl;
      }

      if (index < 0 || index >= pageTabs.length) {
        throw new Error(`Tab index ${index} out of range (0-${pageTabs.length - 1})`);
      }
      return pageTabs[index].webSocketDebuggerUrl;
    }

    throw new Error(`Invalid tab specifier: ${wsUrlOrIndex}`);
  }

  /**
   * Send CDP command using pooled connection (default - maintains focus)
   * Falls back to single-use connection if pool fails
   */
  async function sendCdpCommand(wsUrl, method, params = {}, timeout = 30000) {
    try {
      return await sendCdpCommandPooled(wsUrl, method, params, timeout);
    } catch (e) {
      // Fallback to single-use connection for reliability
      console.error('Pooled connection failed, using single-use:', e.message);
      return await sendCdpCommandSingle(wsUrl, method, params, timeout);
    }
  }

  /**
   * Legacy single-use connection (for backwards compatibility)
   */
  async function sendCdpCommandSingle(wsUrl, method, params = {}, timeout = 30000) {
    const ws = new WebSocketClient(wsUrl);

    return new Promise((resolve, reject) => {
      const id = state.messageIdCounter++;
      let resolved = false;

      ws.on('message', (msg) => {
        const data = JSON.parse(msg);
        if (data.id === id) {
          resolved = true;
          ws.close();
          if (data.error) {
            reject(new Error(data.error.message || JSON.stringify(data.error)));
          } else {
            resolve(data.result);
          }
        }
      });

      ws.on('error', (err) => {
        if (!resolved) {
          reject(err);
        }
      });

      ws.connect()
        .then(() => {
          ws.send(JSON.stringify({ id, method, params }));
        })
        .catch(reject);

      setTimeout(() => {
        if (!resolved) {
          ws.close();
          reject(new Error('CDP command timeout'));
        }
      }, timeout);
    });
  }

  // API Functions

  async function getTabs() {
    const tabs = await chromeHttp('/json');
    if (!Array.isArray(tabs)) {
      return [];
    }
    return tabs
      .filter(tab => tab.type === 'page')
      .map(tab => ({
        ...tab,
        webSocketDebuggerUrl: rewriteWsUrl(tab.webSocketDebuggerUrl, CHROME_DEBUG_HOST, state.activePort)
      }));
  }

  async function newTab(url = 'about:blank') {
    const encoded = encodeURIComponent(url);
    const tab = await chromeHttp(`/json/new?${encoded}`, 'PUT');
    if (tab && typeof tab === 'object') {
      tab.webSocketDebuggerUrl = rewriteWsUrl(tab.webSocketDebuggerUrl, CHROME_DEBUG_HOST, state.activePort);
    }
    return tab;
  }

  async function closeTab(tabIndexOrWsUrl) {
    const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
    const tabs = await chromeHttp('/json');
    if (!Array.isArray(tabs)) return;
    const tab = tabs.find(t => t.webSocketDebuggerUrl === wsUrl);
    if (tab) {
      await chromeHttp(`/json/close/${tab.id}`, 'GET');
    }
  }


  const { click, hover, drag, mouseMove, scroll, doubleClick, rightClick } =
    attachMouse({ resolveWsUrl, sendCdpCommand });
  // Legacy alias for backwards compatibility
  const cdpClick = click;

  const { keyboardPress, keyboardType, fill, humanType } =
    attachKeyboardInput({ state, resolveWsUrl, sendCdpCommand, click });
  // Legacy alias
  const insertText = fill;

  // =============================================================================
  // FILE UPLOAD - Set files on input[type=file] elements
  // =============================================================================

  /**
   * Upload files to an input[type=file] element using DOM.setFileInputFiles.
   * This is the only way to programmatically set files on a file input
   * (security restrictions prevent JavaScript from doing it).
   *
   * @param {number|string} tabIndexOrWsUrl - Tab index or WebSocket URL
   * @param {string} selector - CSS/XPath selector for the file input
   * @param {string[]} filePaths - Array of absolute file paths to upload
   */
  async function fileUpload(tabIndexOrWsUrl, selector, filePaths) {
    const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

    // Get the DOM node ID for the file input
    const docResult = await sendCdpCommand(wsUrl, 'DOM.getDocument', {});
    const rootNodeId = docResult.root.nodeId;

    // Find the element
    let nodeId;
    if (selector.startsWith('/') || selector.startsWith('//')) {
      // XPath
      const searchResult = await sendCdpCommand(wsUrl, 'DOM.performSearch', {
        query: selector
      });
      if (searchResult.resultCount === 0) {
        throw new Error(`File input not found: ${selector}`);
      }
      const nodesResult = await sendCdpCommand(wsUrl, 'DOM.getSearchResults', {
        searchId: searchResult.searchId,
        fromIndex: 0,
        toIndex: 1
      });
      nodeId = nodesResult.nodeIds[0];
    } else {
      // CSS selector
      const queryResult = await sendCdpCommand(wsUrl, 'DOM.querySelector', {
        nodeId: rootNodeId,
        selector: selector
      });
      nodeId = queryResult.nodeId;
    }

    if (!nodeId) {
      throw new Error(`File input not found: ${selector}`);
    }

    // Set the files
    await sendCdpCommand(wsUrl, 'DOM.setFileInputFiles', {
      files: filePaths,
      nodeId: nodeId
    });

    return { uploaded: true, files: filePaths.length };
  }

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


  async function screenshot(tabIndexOrWsUrl, filename, selector = null, fullPage = false) {
    const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

    let clip = undefined;
    if (fullPage) {
      // Full-page capture: get total content dimensions via layout metrics,
      // then capture beyond the visible viewport.
      const metrics = await sendCdpCommand(wsUrl, 'Page.getLayoutMetrics');
      const { width, height } = metrics.contentSize;
      clip = { x: 0, y: 0, width, height, scale: 1 };
    } else if (selector) {
      // Element capture: use element's CSS bounding rect
      const js = `
        (() => {
          const el = ${getElementSelector(selector)};
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          return {
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
            scale: 1
          };
        })()
      `;
      const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
        expression: js,
        returnByValue: true
      });
      clip = result.result.value;
    } else {
      // Viewport capture: explicitly clip to CSS pixel dimensions.
      // Without an explicit clip, Chrome uses its internal (DPI-scaled) dimensions,
      // which produces oversized screenshots on Linux HiDPI displays.
      const vpResult = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
        expression: '({ width: window.innerWidth, height: window.innerHeight })',
        returnByValue: true
      });
      const { width, height } = vpResult.result.value;
      clip = { x: 0, y: 0, width, height, scale: 1 };
    }

    const result = await sendCdpCommand(wsUrl, 'Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: fullPage,
      clip
    });

    const fs = require('fs');
    const path = require('path');
    const buffer = Buffer.from(result.data, 'base64');
    fs.writeFileSync(filename, buffer);

    // Auto-downscale if image exceeds safe dimensions for Claude API
    // (Claude's many-image mode limits to 2000px max dimension)
    await downscaleImageIfNeeded(filename, 1800);

    // Return absolute path so caller knows exactly where file is
    return path.resolve(filename);
  }

  /**
   * Downscale image if any dimension exceeds maxDimension
   * Uses platform-native tools (sips on macOS, ImageMagick on Linux)
   * @param {string} filepath - Path to image file
   * @param {number} maxDimension - Maximum allowed dimension (default 1800)
   */
  async function downscaleImageIfNeeded(filepath, maxDimension = 1800) {
    const { execSync } = require('child_process');
    const os = require('os');
    const fs = require('fs');

    // Read image dimensions using platform-native tools
    const platform = os.platform();

    try {
      let width, height;

      if (platform === 'darwin') {
        // macOS: use sips to get dimensions
        const output = execSync(`sips -g pixelWidth -g pixelHeight "${filepath}" 2>/dev/null`, { encoding: 'utf8' });
        const widthMatch = output.match(/pixelWidth:\s*(\d+)/);
        const heightMatch = output.match(/pixelHeight:\s*(\d+)/);
        width = widthMatch ? parseInt(widthMatch[1]) : 0;
        height = heightMatch ? parseInt(heightMatch[1]) : 0;
      } else if (platform === 'linux') {
        // Linux: try ImageMagick identify
        try {
          const output = execSync(`identify -format "%w %h" "${filepath}" 2>/dev/null`, { encoding: 'utf8' });
          [width, height] = output.trim().split(' ').map(Number);
        } catch {
          // ImageMagick not available, skip downscaling
          return;
        }
      } else {
        // Windows or other: skip for now
        return;
      }

      // Check if downscaling is needed
      if (width <= maxDimension && height <= maxDimension) {
        return; // No downscaling needed
      }

      // Downscale to fit within maxDimension box
      if (platform === 'darwin') {
        // macOS: sips -Z scales to fit in a square box
        execSync(`sips -Z ${maxDimension} "${filepath}" 2>/dev/null`);
      } else if (platform === 'linux') {
        // Linux: ImageMagick convert with resize
        execSync(`convert "${filepath}" -resize ${maxDimension}x${maxDimension}\\> "${filepath}" 2>/dev/null`);
      }
    } catch (e) {
      // Silently ignore downscaling failures - better to have large image than no image
      // Could log to stderr for debugging: console.error(`Downscaling failed: ${e.message}`);
    }
  }

  const { startChrome, killChrome, showBrowser, hideBrowser, getBrowserMode, getChromePid, getActivePort, getProfileName, setProfileName } =
    attachChromeProcess({ state, chromeHttp, getTabs, newTab });

  // Console logging utilities
  async function enableConsoleLogging(tabIndexOrWsUrl) {
    const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

    // Initialize console messages array for this tab
    if (!state.consoleMessages.has(wsUrl)) {
      state.consoleMessages.set(wsUrl, []);
    }

    // Start persistent WebSocket connection for console logging
    const ws = new WebSocketClient(wsUrl);

    return new Promise((resolve, reject) => {
      let enabledRuntime = false;

      ws.on('message', (msg) => {
        const data = JSON.parse(msg);

        // Handle Runtime.enable response
        if (data.id === 999999 && !enabledRuntime) {
          enabledRuntime = true;
          // Don't close the WebSocket - keep it open for console messages
          resolve();
          return;
        }

        // Capture console messages
        if (data.method === 'Runtime.consoleAPICalled') {
          const entry = data.params;
          const timestamp = new Date().toISOString();
          const level = entry.type || 'log';
          const args = entry.args || [];

          // Extract text from arguments
          const text = args.map(arg => {
            if (arg.type === 'string') return arg.value;
            if (arg.type === 'number') return String(arg.value);
            if (arg.type === 'boolean') return String(arg.value);
            if (arg.type === 'object') return arg.description || '[Object]';
            return String(arg.value || arg.description || arg.type);
          }).join(' ');

          const messages = state.consoleMessages.get(wsUrl) || [];
          messages.push({
            timestamp,
            level,
            text
          });
          state.consoleMessages.set(wsUrl, messages);
        }
      });

      ws.on('error', (err) => {
        if (!enabledRuntime) {
          reject(err);
        }
      });

      ws.connect()
        .then(() => {
          // Enable Runtime domain to receive console messages
          ws.send(JSON.stringify({
            id: 999999, // Use fixed ID to identify this response
            method: 'Runtime.enable'
          }));
        })
        .catch(reject);

      // Timeout after 5s
      setTimeout(() => {
        if (!enabledRuntime) {
          ws.close();
          reject(new Error('Console logging enable timeout'));
        }
      }, 5000);
    });
  }

  async function getConsoleMessages(tabIndexOrWsUrl, sinceTime = null) {
    const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
    const messages = state.consoleMessages.get(wsUrl) || [];

    if (!sinceTime) {
      return messages;
    }

    // Filter messages since the specified time
    return messages.filter(msg => new Date(msg.timestamp) > sinceTime);
  }

  async function clearConsoleMessages(tabIndexOrWsUrl) {
    const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
    state.consoleMessages.set(wsUrl, []);
  }

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
