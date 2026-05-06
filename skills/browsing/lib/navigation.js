const { WebSocketClient } = require('./websocket-client');
const { getElementSelector } = require('./element-selector');

/**
 * Navigation: page-level navigation, SPA pushState navigation, and the
 * "wait for" predicates.
 *
 * The full-page `navigate` flow is the complex one — it opens a second
 * (persistent) WebSocket alongside the pooled CDP connection so it can
 * stream console messages while waiting for `Page.loadEventFired`. This
 * second connection runs for the duration of the navigation and then
 * closes; the messages it captures land in `state.consoleMessages` so
 * `getConsoleMessages` (still in chrome-ws-lib) can read them after.
 *
 * SPA navigation, href navigation, and waitForElement/waitForText are
 * thin wrappers around `Runtime.evaluate` and don't need any of that
 * machinery.
 *
 * `attachNavigation({ state, resolveWsUrl, sendCdpCommand,
 * capturePageArtifacts })` returns the bound methods.
 */
function attachNavigation({ state, resolveWsUrl, sendCdpCommand, capturePageArtifacts }) {
  async function navigate(tabIndexOrWsUrl, url, autoCapture = false) {
    const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

    // Clear any stale console messages so the auto-capture log is scoped
    // to just this navigation. (Inline rather than calling
    // clearConsoleMessages to avoid re-resolving wsUrl.)
    if (autoCapture) {
      state.consoleMessages.set(wsUrl, []);
    }

    const result = await sendCdpCommand(wsUrl, 'Page.navigate', { url });

    // Open a second WebSocket purely to listen for Page.loadEventFired and,
    // when auto-capture is on, Runtime.consoleAPICalled. Keeping this off
    // the pooled connection avoids polluting the request/response flow.
    await new Promise((resolve) => {
      const ws = new WebSocketClient(wsUrl);
      let pageLoaded = false;

      ws.on('message', (msg) => {
        const data = JSON.parse(msg);

        if (data.method === 'Page.loadEventFired' && !pageLoaded) {
          pageLoaded = true;
          if (autoCapture) {
            // Linger 1s so any console messages emitted during the load
            // event handler get captured before we close the socket.
            setTimeout(() => { ws.close(); resolve(); }, 1000);
          } else {
            ws.close();
            resolve();
          }
        }

        if (autoCapture && data.method === 'Runtime.consoleAPICalled') {
          const entry = data.params;
          const timestamp = new Date().toISOString();
          const level = entry.type || 'log';
          const args = entry.args || [];

          const text = args.map(arg => {
            if (arg.type === 'string') return arg.value;
            if (arg.type === 'number') return String(arg.value);
            if (arg.type === 'boolean') return String(arg.value);
            if (arg.type === 'object') return arg.description || '[Object]';
            return String(arg.value || arg.description || arg.type);
          }).join(' ');

          const messages = state.consoleMessages.get(wsUrl) || [];
          messages.push({ timestamp, level, text });
          state.consoleMessages.set(wsUrl, messages);
        }
      });

      ws.connect().then(() => {
        sendCdpCommand(wsUrl, 'Page.enable');
        if (autoCapture) {
          sendCdpCommand(wsUrl, 'Runtime.enable');
        }
      });

      // Hard cap on the wait — slow servers, hung pages.
      setTimeout(() => {
        if (!pageLoaded) {
          ws.close();
          resolve();
        }
      }, 30000);
    });

    if (autoCapture) {
      try {
        const artifacts = await capturePageArtifacts(tabIndexOrWsUrl, 'navigate');
        // TODO: console logging is captured into state.consoleMessages above
        // but the return value still placeholder-empty — the *WithCapture
        // wrappers in capture.js have the same TODO.
        const consoleLog = [];

        return {
          frameId: result.frameId,
          url,
          pageSize: artifacts.pageSize,
          capturePrefix: artifacts.capturePrefix,
          sessionDir: artifacts.sessionDir,
          files: artifacts.files,
          domSummary: artifacts.domSummary,
          consoleLog
        };
      } catch (error) {
        // Auto-capture failed (e.g. screenshot failed) — return success
        // with an error note so the navigation itself isn't reported as failed.
        return {
          frameId: result.frameId,
          url,
          error: `Auto-capture failed: ${error.message}`
        };
      }
    }

    return result.frameId;
  }

  /**
   * SPA-compatible navigation using history.pushState (JRV-128).
   * Doesn't reload the page — works with React Router / Vue Router /
   * etc. Pass `dispatchPopstate: false` to skip the popstate event if
   * the consumer router doesn't want it.
   */
  async function spaNavigate(tabIndexOrWsUrl, path, options = {}) {
    const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

    const { state: pushState = {}, title = '', dispatchPopstate = true } = options;

    const js = `
      (() => {
        const path = ${JSON.stringify(path)};
        const state = ${JSON.stringify(pushState)};
        const title = ${JSON.stringify(title)};

        history.pushState(state, title, path);
        ${dispatchPopstate ? `window.dispatchEvent(new PopStateEvent('popstate', { state }));` : ''}

        return {
          success: true,
          path,
          href: window.location.href
        };
      })()
    `;

    const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
      expression: js,
      returnByValue: true
    });

    return result.result.value;
  }

  /**
   * Navigate using location.href — triggers a full page reload (not SPA).
   * Provided as an alternative to `navigate` when the caller wants the
   * browser-side navigation semantics (e.g. for back-button history).
   */
  async function hrefNavigate(tabIndexOrWsUrl, url) {
    const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

    const js = `
      (() => {
        window.location.href = ${JSON.stringify(url)};
        return { navigating: true, url: ${JSON.stringify(url)} };
      })()
    `;

    const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
      expression: js,
      returnByValue: true
    });

    return result.result.value;
  }

  async function waitForElement(tabIndexOrWsUrl, selector, timeout = 5000) {
    const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
    const js = `
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout')), ${timeout});
        const check = () => {
          if (${getElementSelector(selector)}) {
            clearTimeout(timeout);
            resolve(true);
          } else {
            setTimeout(check, 100);
          }
        };
        check();
      })
    `;
    await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
      expression: js,
      awaitPromise: true
    });
  }

  async function waitForText(tabIndexOrWsUrl, text, timeout = 5000) {
    const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
    const js = `
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout')), ${timeout});
        const check = () => {
          if (document.body.textContent.includes(${JSON.stringify(text)})) {
            clearTimeout(timeout);
            resolve(true);
          } else {
            setTimeout(check, 100);
          }
        };
        check();
      })
    `;
    await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
      expression: js,
      awaitPromise: true
    });
  }

  return { navigate, spaNavigate, hrefNavigate, waitForElement, waitForText };
}

module.exports = { attachNavigation };
