// sessionId-aware dispatcher for browser-WS messages.
//
// Routes incoming browser-WS messages by sessionId:
//   - msg.sessionId set         → page session's pendingRequests / event listeners
//   - msg.method, no sessionId  → root listeners (target events, etc.)
//   - msg.id, no sessionId      → falls through. browser-session.js's existing
//                                 pendingRequests Map correlates root command
//                                 responses; the router does NOT also try to.
//                                 (Avoids duplicate correlation paths.)
//
// Per-session message id counters are independent. {id:1, sessionId:"A"}
// and {id:1, sessionId:"B"} correlate independently on one WS — collapsing
// id space across sessions would silently break correlation.

function createCdpRouter({ browser }) {
  // sessionId -> { pendingRequests: Map<id, {resolve, reject, timeout}>,
  //                 eventListeners: Set<(msg) => void> }
  const sessions = new Map();

  // Root browser-session event listeners (events only — command responses are
  // correlated in browser-session.js's pendingRequests, not here).
  const rootListeners = new Set();

  browser.onEvent((msg) => {
    const sid = msg.sessionId;
    if (sid) {
      const sess = sessions.get(sid);
      if (!sess) return; // detached or never registered
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
      // Root session events (e.g. Target.targetCreated). Command responses
      // (msg.id without sessionId) intentionally fall through —
      // browser-session.js handles them.
      for (const fn of rootListeners) {
        try { fn(msg); } catch (e) { console.error('cdp-router root listener threw:', e); }
      }
    }
  });

  function registerSession(sessionId) {
    const sess = {
      pendingRequests: new Map(),
      eventListeners: new Set(),
    };
    sessions.set(sessionId, sess);
    return sess;
  }

  function unregisterSession(sessionId) {
    const sess = sessions.get(sessionId);
    if (!sess) return;
    // Reject any in-flight requests so awaiting callers don't hang.
    for (const [, p] of sess.pendingRequests) {
      clearTimeout(p.timeout);
      p.reject(new Error('Page session detached'));
    }
    sess.pendingRequests.clear();
    sess.eventListeners.clear();
    sessions.delete(sessionId);
  }

  function getRootListeners() { return rootListeners; }

  return {
    registerSession,
    unregisterSession,
    getRootListeners,
  };
}

module.exports = { createCdpRouter };
