// One CDP WebSocket per Chrome process, talking to /devtools/browser/<id>.
//
// This is the transport for Target.* events, BrowserContext create/dispose,
// and every page session attached via Target.attachToTarget({flatten:true}).
// Page-action commands ride the per-page sessions (lib/page-session.js),
// which envelope into this socket via sendRaw and correlate responses
// through the cdp-router.
//
// Lazy: connect happens on first send() / onEvent() call. Both local and
// remote-Chrome callers exercise the same code path — for the remote case
// startChrome() is skipped entirely, and lazy-connect on first bridge use is
// what serves both.

const { WebSocketClient } = require('./websocket-client');

/**
 * createBrowserSession({host, port, rewriteWsUrl, chromeHttp}) -> bridge handle.
 *
 * Discovers the WS URL via chromeHttp('/json/version').webSocketDebuggerUrl
 * and pipes it through rewriteWsUrl (same pattern getTabs/newTab use for
 * per-page URLs).
 *
 * Returned API:
 *   send(method, params?, {timeoutMs?})   -> Promise<result>   // root-session command
 *   onEvent(handler)                      -> unsub fn
 *   close()                               -> Promise<void>
 *   isConnected()                         -> boolean
 *   sendRaw(json)                         -> void              // pre-built envelope
 *
 * `sendRaw` is the page-session escape hatch: page sessions need to send
 * messages with a `sessionId` envelope, but `send()` builds its own
 * envelope (and would clash on the id-counter). The page session pre-builds
 * the JSON, manages its own id-counter via the cdp-router, and pushes it
 * onto the WS through `sendRaw`. Caller is responsible for matching
 * responses (the cdp-router does this).
 */
function createBrowserSession({ host, port, rewriteWsUrl, chromeHttp }) {
  let ws = null;
  const pendingRequests = new Map();   // id -> {resolve, reject, timeout}
  let messageIdCounter = 1;
  const eventListeners = new Set();    // (msg) => void
  let connectPromise = null;           // memoized in-flight connect
  let closed = false;

  async function ensureConnected() {
    if (ws && ws.isConnected()) return;
    if (connectPromise) { await connectPromise; return; }
    connectPromise = (async () => {
      const versionInfo = await chromeHttp('/json/version');
      if (!versionInfo || !versionInfo.webSocketDebuggerUrl) {
        throw new Error('chromeHttp(/json/version) returned no webSocketDebuggerUrl');
      }
      const url = rewriteWsUrl(versionInfo.webSocketDebuggerUrl, host, port);
      const next = new WebSocketClient(url);
      next.on('message', (raw) => {
        let data;
        try { data = JSON.parse(raw); } catch (e) {
          console.error('browser-session: bad JSON from CDP:', e);
          return;
        }
        // Id correlation here is for ROOT-session command responses
        // only. Page-session responses arrive with {id, result, sessionId}
        // — they go to event listeners (the cdp-router dispatches by
        // sessionId). Without this guard, a root id=1 would incorrectly
        // resolve when a page-session id=1 response arrives, since each
        // session has its own id-counter.
        if (data.id !== undefined && data.sessionId === undefined) {
          const pending = pendingRequests.get(data.id);
          if (pending) {
            clearTimeout(pending.timeout);
            pendingRequests.delete(data.id);
            if (data.error) {
              pending.reject(new Error(data.error.message || JSON.stringify(data.error)));
            } else {
              pending.resolve(data.result);
            }
            return; // handled — don't deliver to event listeners
          }
        }
        // Everything else (events with method, or page-session command
        // responses with sessionId) goes to event listeners. The router
        // dispatches by sessionId from there.
        for (const fn of eventListeners) {
          try { fn(data); } catch (e) { console.error('browser-session listener threw:', e); }
        }
      });
      next.on('close', () => {
        for (const [, p] of pendingRequests) {
          clearTimeout(p.timeout);
          p.reject(new Error('Browser session WS closed'));
        }
        pendingRequests.clear();
      });
      await next.connect();
      // Only assign `ws` after a successful connect so concurrent callers
      // that fall through the `ws && ws.isConnected()` early-return don't
      // observe a partially-initialized socket. Don't null connectPromise —
      // leaving the resolved promise in place makes subsequent awaits a no-op.
      ws = next;
    })();
    await connectPromise;
  }

  async function send(method, params = {}, { timeoutMs = 10000 } = {}) {
    if (closed) throw new Error('Browser session closed');
    await ensureConnected();
    // Re-check after the await — close() may have run during ensureConnected().
    if (closed) throw new Error('Browser session closed');
    const id = messageIdCounter++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(`Browser session timeout: ${method}`));
      }, timeoutMs);
      pendingRequests.set(id, { resolve, reject, timeout });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        clearTimeout(timeout);
        pendingRequests.delete(id);
        reject(e);
      }
    });
  }

  function onEvent(handler) {
    eventListeners.add(handler);
    return () => eventListeners.delete(handler);
  }

  async function close() {
    closed = true;
    if (ws) { ws.close(); ws = null; }
    for (const [, p] of pendingRequests) {
      clearTimeout(p.timeout);
      p.reject(new Error('Browser session closed'));
    }
    pendingRequests.clear();
    eventListeners.clear();
  }

  function isConnected() { return ws !== null && ws.isConnected(); }

  /**
   * Send a pre-formed JSON payload. Used by page-session.js to send messages
   * with a sessionId envelope without browser-session needing to know about
   * sessionIds. Caller is responsible for response correlation (the
   * cdp-router does this for page sessions).
   *
   * Caller must ensure the browser-WS is open. Page sessions reach this
   * path only after `attachPageSession` has already issued
   * `Target.attachToTarget` via the regular `send`, which lazy-opens the WS.
   */
  function sendRaw(json) {
    if (closed) throw new Error('Browser session closed');
    if (!ws || !ws.isConnected()) {
      throw new Error('Browser WS not connected (call send() first to lazy-open)');
    }
    ws.send(json);
  }

  return { send, onEvent, close, isConnected, sendRaw };
}

module.exports = { createBrowserSession };
