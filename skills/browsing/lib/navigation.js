const { getElementSelector } = require('./element-selector');

// Hard cap on the navigate() wait — covers slow servers and pages that
// never fire Page.loadEventFired.
const NAVIGATE_TIMEOUT_MS = 30000;

// After Page.loadEventFired, keep the console capture subscription open
// this long so console messages emitted in the load handler get captured.
const CONSOLE_LINGER_MS = 1000;

/**
 * Navigation: page-level navigation, SPA pushState navigation, and the
 * "wait for" predicates.
 *
 * The full-page `navigate` flow opens a pageSession (via the bridge) and
 * subscribes to events on the shared browser-WS instead of opening a second
 * WebSocket connection. consoleMessages are keyed by sessionId (not wsUrl) so
 * that getConsoleMessages (console-logging.js) can read them after the fact.
 *
 * Listener-ordering invariant: ps.waitForEvent('Page.loadEventFired') registers
 * the listener synchronously before `await ps.send('Page.navigate')` fires —
 * preserving the guarantee that even a fast-loading (data: URL) page won't
 * lose the event.
 *
 * `attachNavigation({ state, getPageSession, capturePageArtifacts, evaluate })`
 * returns the bound methods.
 */
function attachNavigation({ state, getPageSession, capturePageArtifacts, evaluate }) {
  async function navigate(tabIndexOrWsUrl, url, autoCapture = false) {
    const ps = await getPageSession(tabIndexOrWsUrl);
    const sid = ps.sessionId;

    // Reset console buffer for this session (keyed by sessionId, not wsUrl).
    // E10 (console-logging) reads from the same key.
    state.consoleMessages.set(sid, []);
    const consoleMessages = state.consoleMessages.get(sid);

    await ps.enableDomain('Page');
    if (autoCapture) {
      await ps.enableDomain('Runtime');
    }

    let unsubConsole = () => {};
    if (autoCapture) {
      // Subscribe to console messages — capture into the buffer.
      unsubConsole = ps.onEvent((msg) => {
        if (msg.method === 'Runtime.consoleAPICalled') {
          const entry = msg.params;
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

          consoleMessages.push({ timestamp, level, text });
        }
      });
    }

    // Chrome broadcasts Page.loadEventFired to all clients that have Page.enable
    // active when ANY other client first enables Page on an already-loaded tab.
    // Guard: only accept Page.loadEventFired after Page.frameNavigated — which
    // only fires for real navigation events, not for the synthetic broadcast.
    let frameNavigated = false;
    const unsubFrameNav = ps.onEvent((msg) => {
      if (msg.method === 'Page.frameNavigated') {
        const frame = msg.params && msg.params.frame;
        if (frame && !frame.parentId) {
          frameNavigated = true;
        }
      }
    });

    // Listener-ordering invariant: register the Page.loadEventFired listener
    // BEFORE sending Page.navigate so a fast-loading page (data: URL) cannot
    // fire the event before we're ready.
    const loadPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubLoad();
        reject(new Error(`navigate timeout: ${url} did not fire Page.loadEventFired within ${NAVIGATE_TIMEOUT_MS}ms`));
      }, NAVIGATE_TIMEOUT_MS);
      const unsubLoad = ps.onEvent((msg) => {
        if (msg.method === 'Page.loadEventFired' && frameNavigated) {
          clearTimeout(timeout);
          unsubLoad();
          resolve(msg);
        }
      });
    });

    // Guard against an orphaned loadPromise rejection: if ps.send('Page.navigate')
    // times out (or fails) before loadPromise settles, loadPromise's own 30-second
    // timer will fire later with no awaiter → unhandled rejection → process exit.
    // Attaching .catch here makes that eventual rejection handled, without
    // interfering with the `await loadPromise` path below (Promises can have
    // multiple handlers).
    loadPromise.catch(() => {});

    let navigateResult;
    try {
      navigateResult = await ps.send('Page.navigate', { url });
    } catch (err) {
      unsubConsole();
      unsubFrameNav();
      throw err;
    }

    // CDP Page.navigate returns errorText when the host is unreachable (e.g. DNS
    // failure, refused connection). The navigation "succeeded" at the protocol
    // level but the page load failed — treat this as a hard error so the caller
    // doesn't silently believe the page loaded.
    if (navigateResult && navigateResult.errorText) {
      unsubConsole();
      unsubFrameNav();
      throw new Error(`Navigate failed: ${navigateResult.errorText} (${url})`);
    }

    try {
      await loadPromise;
    } catch (err) {
      unsubConsole();
      unsubFrameNav();
      throw err;
    }

    // Linger to catch trailing console output emitted during load event handlers.
    if (autoCapture) {
      await new Promise(r => setTimeout(r, CONSOLE_LINGER_MS));
    }

    unsubConsole();
    unsubFrameNav();

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

  async function back(tabIndexOrWsUrl) {
    const ps = await getPageSession(tabIndexOrWsUrl);
    await ps.send('Runtime.evaluate', { expression: 'history.back()' });
  }

  async function forward(tabIndexOrWsUrl) {
    const ps = await getPageSession(tabIndexOrWsUrl);
    await ps.send('Runtime.evaluate', { expression: 'history.forward()' });
  }

  return { navigate, waitForElement, waitForText, back, forward };
}

module.exports = { attachNavigation };
