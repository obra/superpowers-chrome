'use strict';

const { WebSocketClient: DefaultWebSocketClient } = require('./websocket-client');

/**
 * createBrowserSession({host, port, rewriteWsUrl, chromeHttp, WebSocketClient?}) -> bridge handle.
 *
 * Owns the one root WebSocket to /devtools/browser/<id>. Page-action commands ride
 * per-page sessions (attached via Target.attachToTarget({flatten:true})) and envelope
 * messages with a sessionId via sendRaw — the page session manages its own pendingRequests
 * (in the cdp-router). browser-session correlates ROOT-session command responses only.
 *
 * Returned API:
 *   send(method, params?, {timeoutMs?})  -> Promise<result>  // root command
 *   onEvent(handler)                     -> unsub fn
 *   close()                              -> Promise<void>
 *   isConnected()                        -> boolean
 *   sendRaw(json)                        -> void
 */
function createBrowserSession({ host, port, rewriteWsUrl, chromeHttp, WebSocketClient = DefaultWebSocketClient }) {
  let ws = null;
  const pendingRequests = new Map(); // id -> {resolve, reject, timeout}
  let messageIdCounter = 1;
  const eventListeners = new Set();
  let connectPromise = null;
  let closed = false;

  async function ensureConnected() {
    if (ws && ws.isConnected()) return;
    if (connectPromise) { await connectPromise; return; }
    connectPromise = (async () => {
      try {
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
          // Correlate ROOT-session command responses (id without sessionId). Page-session
          // responses carry {id, result, sessionId} and fall through to event listeners
          // for the cdp-router to dispatch.
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
              return;
            }
          }
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
        // Assign ws only after a successful connect so concurrent callers that hit the
        // `ws && ws.isConnected()` early-return don't see a half-initialized socket.
        ws = next;
      } catch (e) {
        // Allow retry after a transient failure (network blip, Chrome not yet ready, etc.).
        // We do NOT null on success — leaving the resolved promise in place makes subsequent
        // ensureConnected() awaits a no-op.
        connectPromise = null;
        throw e;
      }
    })();
    await connectPromise;
  }

  async function send(method, params = {}, { timeoutMs = 10000 } = {}) {
    if (closed) throw new Error('Browser session closed');
    await ensureConnected();
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
