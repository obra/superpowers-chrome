const { getElementSelector } = require('./element-selector');
const { DialogRefusedError } = require('./dialogs');
const { renderSyntheticArtifacts } = require('./dialogs-render');

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
    // console-logging.js (enableConsoleLogging / attachConsoleLogging) is the
    // single writer for state.consoleMessages.  Navigation must NOT also write
    // here — two writers for the same Runtime.consoleAPICalled event is the
    // root cause of the double-entry bug (Bug 1 / fix G follow-up).
    state.consoleMessages.set(sid, []);

    await ps.enableDomain('Page');
    if (autoCapture) {
      await ps.enableDomain('Runtime');
    }

    const unsubConsole = () => {};

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
    let loadTimeout, unsubLoad;
    const loadPromise = new Promise((resolve, reject) => {
      loadTimeout = setTimeout(() => {
        unsubLoad();
        reject(new Error(`navigate timeout: ${url} did not fire Page.loadEventFired within ${NAVIGATE_TIMEOUT_MS}ms`));
      }, NAVIGATE_TIMEOUT_MS);
      unsubLoad = ps.onEvent((msg) => {
        if (msg.method === 'Page.loadEventFired' && frameNavigated) {
          clearTimeout(loadTimeout);
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

    // Dialog detection: a basic-auth challenge, permission prompt, or other
    // dialog that fires *during* navigation will (a) pause Chrome so
    // Page.loadEventFired never arrives and often (b) leave the Page.navigate
    // request itself pending too. Without this race the navigate hangs until
    // the 30-second timeout fires, and the caller never learns there's a
    // dialog they need to handle. Resolve the dialogPromise as soon as
    // dialogs.js sets state.dialogs[sid] in response to a CDP event.
    const sawDialogBefore = state.dialogs && state.dialogs.has(sid);
    let unsubDialog;
    const dialogPromise = new Promise((resolve) => {
      unsubDialog = ps.onEvent(() => {
        const open = state.dialogs && state.dialogs.get(sid);
        if (open && !sawDialogBefore) {
          unsubDialog();
          resolve(open);
        }
      });
    });

    let navigateResult;
    let dialogWon = null;
    try {
      // Fire the navigate without awaiting — we race its completion against
      // loadPromise and dialogPromise below. Any rejection propagates via
      // the .catch attached on the race outcome.
      const navigatePromise = ps.send('Page.navigate', { url });
      // Suppress unhandled-rejection if the dialog race wins.
      navigatePromise.catch(() => {});

      const outcome = await Promise.race([
        navigatePromise.then((r) => ({ kind: 'send-resolved', r })),
        navigatePromise.catch((e) => ({ kind: 'send-rejected', e })),
        loadPromise.then(() => ({ kind: 'load' })),
        dialogPromise.then((d) => ({ kind: 'dialog', d })),
      ]);

      if (outcome.kind === 'send-rejected') {
        clearTimeout(loadTimeout);
        if (unsubLoad) unsubLoad();
        if (unsubDialog) unsubDialog();
        unsubConsole();
        unsubFrameNav();
        throw outcome.e;
      }

      if (outcome.kind === 'dialog') {
        dialogWon = outcome.d;
      } else {
        // 'send-resolved' or 'load' — make sure we have the navigate result.
        navigateResult = (outcome.kind === 'send-resolved') ? outcome.r : await navigatePromise;
      }
    } catch (err) {
      clearTimeout(loadTimeout);
      if (unsubLoad) unsubLoad();
      if (unsubDialog) unsubDialog();
      unsubConsole();
      unsubFrameNav();
      throw err;
    }

    if (dialogWon) {
      clearTimeout(loadTimeout);
      if (unsubLoad) unsubLoad();
      if (unsubDialog) unsubDialog();
      unsubConsole();
      unsubFrameNav();
      throw new DialogRefusedError({
        dialog: dialogWon,
        artifacts: renderSyntheticArtifacts(dialogWon),
      });
    }

    if (unsubDialog) unsubDialog();

    // CDP Page.navigate returns errorText when the host is unreachable (e.g. DNS
    // failure, refused connection). The navigation "succeeded" at the protocol
    // level but the page load failed — treat this as a hard error so the caller
    // doesn't silently believe the page loaded.
    if (navigateResult && navigateResult.errorText) {
      clearTimeout(loadTimeout);
      if (unsubLoad) unsubLoad();
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
