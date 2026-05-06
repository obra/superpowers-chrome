const { WebSocketClient } = require('./websocket-client');
const { getElementSelector } = require('./element-selector');

// Hard cap on the navigate() wait — covers slow servers and pages that
// never fire Page.loadEventFired.
const NAVIGATE_TIMEOUT_MS = 30000;

// After Page.loadEventFired, keep the secondary console-capture WebSocket
// open this long so console messages emitted in the load handler get
// captured before we close the socket.
const CONSOLE_LINGER_MS = 1000;

// Fixed CDP request ids for the listener-WS setup commands. Scoped to one
// connection's lifetime — there's nothing else on this WS sending requests.
const CMD_PAGE_ENABLE = 100;
const CMD_RUNTIME_ENABLE = 101;

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
function attachNavigation({ state, resolveWsUrl, sendCdpCommand, capturePageArtifacts, evaluate }) {
  async function navigate(tabIndexOrWsUrl, url, autoCapture = false) {
    const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

    // Clear any stale console messages so the auto-capture log is scoped
    // to just this navigation. (Inline rather than calling
    // clearConsoleMessages to avoid re-resolving wsUrl.)
    if (autoCapture) {
      state.consoleMessages.set(wsUrl, []);
    }

    // Open a second WebSocket to listen for Page.loadEventFired before
    // issuing Page.navigate — this order matters for fast-loading pages
    // (e.g. data: URLs) that complete synchronously: if we navigated first
    // the load event would fire before the listener was ready, causing every
    // call to wait for the full 30-second hard cap.
    let navigateResult;
    await new Promise((resolve, reject) => {
      const ws = new WebSocketClient(wsUrl);
      let pageLoaded = false;
      let settled = false; // guard against double-resolve from race between events
      let pageEnableConfirmed = false;
      let runtimeEnableConfirmed = !autoCapture; // skip if not needed

      function settle(action) {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch (_e) { /* ignore */ }
        action();
      }

      function startNavigateIfReady() {
        if (!pageEnableConfirmed || !runtimeEnableConfirmed) return;
        sendCdpCommand(wsUrl, 'Page.navigate', { url })
          .then((navResult) => { navigateResult = navResult; })
          .catch((err) => settle(() => reject(err)));
      }

      // Listener WS errors / unexpected close → reject the navigate. Without
      // this, a dropped WS mid-flight hangs until the hard-cap timeout.
      ws.on('error', (err) => {
        settle(() => reject(new Error(`navigate listener WebSocket error: ${err.message || err}`)));
      });
      ws.on('close', () => {
        if (!pageLoaded) {
          settle(() => reject(new Error('navigate listener WebSocket closed before Page.loadEventFired')));
        }
      });

      ws.on('message', (msg) => {
        const data = JSON.parse(msg);

        // Wait for our setup commands to be confirmed before navigating.
        if (data.id === CMD_PAGE_ENABLE) {
          if (data.error) {
            settle(() => reject(new Error(`Page.enable failed: ${data.error.message || JSON.stringify(data.error)}`)));
            return;
          }
          pageEnableConfirmed = true;
          startNavigateIfReady();
          return;
        }
        if (data.id === CMD_RUNTIME_ENABLE) {
          if (data.error) {
            settle(() => reject(new Error(`Runtime.enable failed: ${data.error.message || JSON.stringify(data.error)}`)));
            return;
          }
          runtimeEnableConfirmed = true;
          startNavigateIfReady();
          return;
        }

        if (data.method === 'Page.loadEventFired' && !pageLoaded) {
          pageLoaded = true;
          if (autoCapture) {
            // Linger so any console messages emitted during the load
            // event handler get captured before we close the socket.
            setTimeout(() => settle(() => resolve()), CONSOLE_LINGER_MS);
          } else {
            settle(() => resolve());
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
        // Send Page.enable (and Runtime.enable if auto-capturing) on THIS
        // connection — Chrome scopes events per-connection, so the pooled
        // sendCdpCommand won't receive Page events here.  Page.navigate is
        // sent from the message handler above once both enables are confirmed.
        ws.send(JSON.stringify({ id: CMD_PAGE_ENABLE, method: 'Page.enable' }));
        if (autoCapture) {
          ws.send(JSON.stringify({ id: CMD_RUNTIME_ENABLE, method: 'Runtime.enable' }));
        }
      }).catch((err) => settle(() => reject(err)));

      // Hard cap on the wait — slow servers, hung pages. Reject (don't
      // silently resolve) so the caller knows the page never loaded.
      setTimeout(() => {
        if (!pageLoaded) {
          settle(() => reject(new Error(`navigate timeout: ${url} did not fire Page.loadEventFired within ${NAVIGATE_TIMEOUT_MS}ms`)));
        }
      }, NAVIGATE_TIMEOUT_MS);
    });

    if (autoCapture) {
      try {
        const artifacts = await capturePageArtifacts(tabIndexOrWsUrl, 'navigate');
        // TODO: console logging is captured into state.consoleMessages above
        // but the return value still placeholder-empty — the *WithCapture
        // wrappers in capture.js have the same TODO.
        const consoleLog = [];

        return {
          frameId: navigateResult?.frameId,
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
          frameId: navigateResult?.frameId,
          url,
          error: `Auto-capture failed: ${error.message}`
        };
      }
    }

    return navigateResult?.frameId;
  }

  async function waitForElement(tabIndexOrWsUrl, selector, timeout = 5000) {
    const js = `
      new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('waitForElement timeout: ' + ${JSON.stringify(selector)})), ${timeout});
        const check = () => {
          if (${getElementSelector(selector)}) {
            clearTimeout(t);
            resolve(true);
          } else {
            setTimeout(check, 100);
          }
        };
        check();
      })
    `;
    await evaluate(tabIndexOrWsUrl, js);
  }

  async function waitForText(tabIndexOrWsUrl, text, timeout = 5000) {
    const js = `
      new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('waitForText timeout: ' + ${JSON.stringify(text)})), ${timeout});
        const check = () => {
          if (document.body.textContent.includes(${JSON.stringify(text)})) {
            clearTimeout(t);
            resolve(true);
          } else {
            setTimeout(check, 100);
          }
        };
        check();
      })
    `;
    await evaluate(tabIndexOrWsUrl, js);
  }

  return { navigate, waitForElement, waitForText };
}

module.exports = { attachNavigation };
