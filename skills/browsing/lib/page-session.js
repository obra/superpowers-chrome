'use strict';

/**
 * Per-page CDP session over the browser-WS, attached via Target.attachToTarget({flatten:true}).
 *
 * Each pageSession wraps:
 *   - sessionId (from Target.attachToTarget)
 *   - targetId  (underlying CDP target)
 *   - a per-session message-id counter (independent of other sessions — collapsing
 *     id space across sessions would silently misroute responses)
 *   - pendingRequests + eventListeners (held in the cdp-router)
 *
 * pageSession.send is the only way page-action commands reach Chrome via this transport.
 * There is no fallback. If the browser-WS dies, the call rejects and the caller decides
 * what to do.
 */

/**
 * buildPageSessionFromAttached — constructs a pageSession from an already-attached
 * sessionId (e.g. from Target.attachedToTarget autoAttach) without making any CDP
 * calls. The caller is responsible for registering the session with the router
 * BEFORE calling this function — or passing the sess object from registerSession.
 *
 * Both attachPageSession and the auto-attach handler in browser-bridge use this.
 */
function buildPageSessionFromAttached({ browser, router, sessionId, targetId }) {
  const sess = router.registerSession(sessionId);
  let messageIdCounter = 1;
  let detached = false;
  const enabledDomains = new Set();

  async function send(method, params = {}, { timeoutMs = 30000 } = {}) {
    if (detached) throw new Error(`Page session detached (sessionId=${sessionId})`);
    const id = messageIdCounter++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        sess.pendingRequests.delete(id);
        reject(new Error(`Page session timeout: ${method}`));
      }, timeoutMs);
      sess.pendingRequests.set(id, { resolve, reject, timeout });
      // browser.send doesn't natively envelope by sessionId, so we use the sendRaw
      // escape hatch with a pre-built JSON payload. The cdp-router correlates the
      // response by sessionId.
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
   * Enable a CDP domain idempotently. Multiple callers (navigation auto-capture +
   * console-logging stream, etc.) can call enableDomain('Runtime') without
   * coordinating — it's a no-op if already enabled.
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
    } catch {
      // best-effort — Chrome may already have torn down the target
    }
    router.unregisterSession(sessionId);
  }

  return { sessionId, targetId, send, onEvent, waitForEvent, enableDomain, detach };
}

async function attachPageSession({ browser, router }, targetId) {
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  return buildPageSessionFromAttached({ browser, router, sessionId, targetId });
}

module.exports = { attachPageSession, buildPageSessionFromAttached };
