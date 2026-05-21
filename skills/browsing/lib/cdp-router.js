'use strict';

/**
 * createCdpRouter({browser}) — sessionId-aware dispatcher for browser-WS messages.
 *
 * Routing rules:
 *   - msg.sessionId set         -> per-session pendingRequests (if msg.id) or eventListeners (if msg.method)
 *   - msg.method, no sessionId  -> root listeners (target events, etc.)
 *   - msg.id, no sessionId      -> falls through (browser-session.js owns root correlation)
 *
 * Per-session message-id counters are independent. {id:1, sessionId:"A"} and
 * {id:1, sessionId:"B"} correlate independently on one WS — collapsing id space
 * across sessions would silently break correlation.
 */
function createCdpRouter({ browser }) {
  const sessions = new Map(); // sessionId -> { pendingRequests, eventListeners }
  const rootListeners = new Set();

  browser.onEvent((msg) => {
    const sid = msg.sessionId;
    if (sid) {
      const sess = sessions.get(sid);
      if (!sess) return; // detached or never registered — drop silently
      if (msg.id !== undefined) {
        const pending = sess.pendingRequests.get(msg.id);
        if (pending) {
          clearTimeout(pending.timeout);
          sess.pendingRequests.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            pending.resolve(msg.result);
          }
        }
      } else if (msg.method) {
        for (const fn of sess.eventListeners) {
          try { fn(msg); } catch (e) { console.error('cdp-router page listener threw:', e); }
        }
      }
    } else if (msg.method) {
      for (const fn of rootListeners) {
        try { fn(msg); } catch (e) { console.error('cdp-router root listener threw:', e); }
      }
    }
    // Untagged responses (msg.id with no sessionId, no method) intentionally
    // fall through — browser-session.js's pendingRequests Map handles them.
  });

  function registerSession(sessionId) {
    const sess = { pendingRequests: new Map(), eventListeners: new Set() };
    sessions.set(sessionId, sess);
    return sess;
  }

  function unregisterSession(sessionId) {
    const sess = sessions.get(sessionId);
    if (!sess) return;
    for (const [, p] of sess.pendingRequests) {
      clearTimeout(p.timeout);
      p.reject(new Error('Page session detached'));
    }
    sess.pendingRequests.clear();
    sess.eventListeners.clear();
    sessions.delete(sessionId);
  }

  function getRootListeners() { return rootListeners; }

  return { registerSession, unregisterSession, getRootListeners };
}

module.exports = { createCdpRouter };
