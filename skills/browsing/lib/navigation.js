const { getElementSelector } = require('./element-selector');

// Hard cap on the navigate() wait — covers slow servers and pages that
// never fire Page.loadEventFired.
const NAVIGATE_TIMEOUT_MS = 30000;

// After Page.loadEventFired, keep the console-capture subscription alive
// briefly so console messages emitted during the load handler get captured
// before navigate() returns.
const CONSOLE_LINGER_MS = 1000;

/**
 * Navigation: page-level navigation, SPA pushState navigation, and the
 * "wait for" predicates.
 *
 * `Page.loadEventFired` rides `pageSession.onEvent` over the browser-WS
 * — no second WebSocket per navigation. The 30s hard cap and the
 * "listener-ready-before-navigate" ordering are preserved (Page.enable +
 * waitForEvent registered before Page.navigate so fast-loading data: URLs
 * can't fire loadEventFired before we're listening).
 *
 * Auto-capture: when `autoCapture: true`, Runtime.consoleAPICalled events
 * are subscribed via the page session's event stream. Idempotent —
 * pageSession.enableDomain('Runtime') is a no-op if console-logging.js's
 * enableConsoleLogging has already enabled it.
 */
function attachNavigation({ state, getPageSession, capturePageArtifacts, evaluate }) {
  async function navigate(tabIndexOrPageSession, url, autoCapture = false) {
    const ps = await getPageSession(tabIndexOrPageSession);

    // Clear any stale console messages so the auto-capture log is scoped
    // to just this navigation. Keyed by sessionId.
    if (autoCapture) {
      state.consoleMessages.set(ps.sessionId, []);
    }

    // Enable the Page domain so loadEventFired actually fires (idempotent —
    // a previous navigate() call on the same page session already enabled it).
    await ps.enableDomain('Page');

    let unsubConsole = null;
    if (autoCapture) {
      await ps.enableDomain('Runtime');
      unsubConsole = ps.onEvent((msg) => {
        if (msg.method !== 'Runtime.consoleAPICalled') return;
        const entry = msg.params || {};
        const timestamp = new Date().toISOString();
        const level = entry.type || 'log';
        const args = entry.args || [];
        const text = args.map((arg) => {
          if (arg.type === 'string') return arg.value;
          if (arg.type === 'number') return String(arg.value);
          if (arg.type === 'boolean') return String(arg.value);
          if (arg.type === 'object') return arg.description || '[Object]';
          return String(arg.value || arg.description || arg.type);
        }).join(' ');
        const messages = state.consoleMessages.get(ps.sessionId) || [];
        messages.push({ timestamp, level, text });
        state.consoleMessages.set(ps.sessionId, messages);
      });
    }

    // Register the loadEventFired listener BEFORE Page.navigate so fast
    // loading pages (data: URLs) can't fire loadEventFired before we're
    // listening. waitForEvent's promise is registered synchronously.
    const loadP = ps.waitForEvent('Page.loadEventFired', { timeoutMs: NAVIGATE_TIMEOUT_MS });

    let navigateResult;
    try {
      navigateResult = await ps.send('Page.navigate', { url });
      await loadP;
    } catch (err) {
      if (unsubConsole) try { unsubConsole(); } catch { /* best-effort */ }
      // Decorate timeout errors with the URL for friendlier diagnostics.
      if (err && /timed out/i.test(err.message)) {
        throw new Error(`navigate timeout: ${url} did not fire Page.loadEventFired within ${NAVIGATE_TIMEOUT_MS}ms`);
      }
      throw err;
    }

    if (autoCapture) {
      // Linger so any console messages emitted during the load event
      // handler get captured before we drop the listener.
      await new Promise((r) => setTimeout(r, CONSOLE_LINGER_MS));
      if (unsubConsole) try { unsubConsole(); } catch { /* best-effort */ }

      try {
        const artifacts = await capturePageArtifacts(ps, 'navigate');
        // TODO: console logging is captured into state.consoleMessages above
        // but the return value here still placeholder-empty — the
        // *WithCapture wrappers in capture.js have the same TODO.
        const consoleLog = [];

        return {
          frameId: navigateResult?.frameId,
          url,
          pageSize: artifacts.pageSize,
          capturePrefix: artifacts.capturePrefix,
          sessionDir: artifacts.sessionDir,
          files: artifacts.files,
          domSummary: artifacts.domSummary,
          consoleLog,
        };
      } catch (error) {
        return {
          frameId: navigateResult?.frameId,
          url,
          error: `Auto-capture failed: ${error.message}`,
        };
      }
    }

    return navigateResult?.frameId;
  }

  async function waitForElement(tabIndexOrPageSession, selector, timeout = 5000) {
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
    await evaluate(tabIndexOrPageSession, js);
  }

  async function waitForText(tabIndexOrPageSession, text, timeout = 5000) {
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
    await evaluate(tabIndexOrPageSession, js);
  }

  return { navigate, waitForElement, waitForText };
}

module.exports = { attachNavigation };
