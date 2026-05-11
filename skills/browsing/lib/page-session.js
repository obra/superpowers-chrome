// Per-page CDP session over the browser-WS, attached via
// Target.attachToTarget({flatten:true}).
//
// Each pageSession wraps:
//   - a sessionId (from Target.attachToTarget)
//   - a targetId (the underlying CDP target)
//   - a per-session message id counter (independent of other sessions)
//   - pendingRequests + eventListeners (held in the cdp-router)
//
// pageSession.send is the only way page-action commands reach Chrome
// through this transport. There is no fallback. If the browser-WS dies,
// the call rejects and the caller decides what to do — the deliberate
// contract that retires the per-page WS pool's silent single-use fallback.

async function attachPageSession({ browser, router }, targetId) {
  const { sessionId } = await browser.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });

  const sess = router.registerSession(sessionId);
  let messageIdCounter = 1;
  let detached = false;
  const enabledDomains = new Set(); // domains we've already sent X.enable for

  async function send(method, params = {}, { timeoutMs = 30000 } = {}) {
    if (detached) throw new Error(`Page session detached (sessionId=${sessionId})`);
    const id = messageIdCounter++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        sess.pendingRequests.delete(id);
        reject(new Error(`Page session timeout: ${method}`));
      }, timeoutMs);
      sess.pendingRequests.set(id, { resolve, reject, timeout });
      // Send via browser-session, with the sessionId envelope.
      // browser.send doesn't natively envelope by sessionId, so we use the
      // sendRaw escape hatch with a pre-built JSON payload.
      try {
        browser.sendRaw(JSON.stringify({ id, method, params, sessionId }));
      } catch (e) {
        clearTimeout(timeout);
        sess.pendingRequests.delete(id);
        reject(e);
      }
    });
  }

  function onEvent(handler) {
    sess.eventListeners.add(handler);
    return () => sess.eventListeners.delete(handler);
  }

  function waitForEvent(method, { timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      let unsub = null;
      const timeout = setTimeout(() => {
        if (unsub) unsub();
        reject(new Error(`waitForEvent ${method}: timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      unsub = onEvent((msg) => {
        if (msg.method === method) {
          clearTimeout(timeout);
          unsub();
          resolve(msg);
        }
      });
    });
  }

  /**
   * Enable a CDP domain for this page session, idempotently. Multiple
   * callers (navigation auto-capture + console-logging stream, e.g.) can
   * call enableDomain('Runtime') without coordination — it's a no-op if
   * already enabled.
   */
  async function enableDomain(name) {
    if (enabledDomains.has(name)) return;
    await send(`${name}.enable`, {});
    enabledDomains.add(name);
  }

  async function detach() {
    if (detached) return;
    detached = true;
    try {
      await browser.send('Target.detachFromTarget', { sessionId });
    } catch { /* best-effort — Chrome may already have torn down the target */ }
    router.unregisterSession(sessionId);
  }

  return { sessionId, targetId, send, onEvent, waitForEvent, enableDomain, detach };
}

module.exports = { attachPageSession };
