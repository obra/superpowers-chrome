const { WebSocketClient } = require('./websocket-client');

// Default per-CDP-call timeout. Caller can override via the `timeout`
// parameter on sendCdpCommand.
const DEFAULT_CDP_TIMEOUT_MS = 30000;

/**
 * CDP transport — pooled WebSocket connections to Chrome's debugger.
 *
 * Why pooling matters (JRV-130): the original single-use connection per
 * `Runtime.evaluate` call lost focus between calls because each new
 * connection re-attached to the page as a fresh debugger client. The
 * pool keeps one persistent ws per tab, so focus/state survives across
 * commands.
 *
 * `sendCdpCommand` is the public entry point. It tries the pool first
 * and falls back to a single-use connection if the pooled call throws —
 * the fallback is a safety net for the rare case where the pooled
 * connection is wedged (broken socket, frame parse error) but a fresh
 * connection would still work.
 *
 * Per-connection request ids start at 1 in each pooled `conn`. The
 * single-use path always uses id=1 because each fresh ws has nothing to
 * collide with.
 *
 * The pool eventHandler hook (`conn.eventHandler`) is consumed by
 * `enableConsoleLogging` (and any future caller that wants to listen on
 * the persistent socket without spinning up a second one).
 *
 * `attachCdpConnection({ state })` returns the bound API.
 */
function attachCdpConnection({ state }) {
  async function getPooledConnection(wsUrl) {
    let conn = state.connectionPool.get(wsUrl);

    if (conn && conn.ws.isConnected()) {
      return conn;
    }

    const ws = new WebSocketClient(wsUrl);
    conn = {
      ws,
      pendingRequests: new Map(), // id -> { resolve, reject, timeout }
      messageIdCounter: 1
    };

    ws.on('message', (msg) => {
      try {
        const data = JSON.parse(msg);
        if (data.id !== undefined) {
          const pending = conn.pendingRequests.get(data.id);
          if (pending) {
            clearTimeout(pending.timeout);
            conn.pendingRequests.delete(data.id);
            if (data.error) {
              pending.reject(new Error(data.error.message || JSON.stringify(data.error)));
            } else {
              pending.resolve(data.result);
            }
          }
        }
        // Forward events (e.g. Runtime.consoleAPICalled) to the per-connection
        // eventHandler if one was attached — used by enableConsoleLogging.
        if (data.method && conn.eventHandler) {
          conn.eventHandler(data);
        }
      } catch (e) {
        console.error('Error processing CDP message:', e);
      }
    });

    ws.on('close', () => {
      state.connectionPool.delete(wsUrl);
      // Reject any in-flight requests so callers don't hang forever.
      for (const [_id, pending] of conn.pendingRequests) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Connection closed'));
      }
      conn.pendingRequests.clear();
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
    });

    await ws.connect();
    state.connectionPool.set(wsUrl, conn);

    return conn;
  }

  async function sendCdpCommandPooled(wsUrl, method, params = {}, timeout = DEFAULT_CDP_TIMEOUT_MS) {
    const conn = await getPooledConnection(wsUrl);
    const id = conn.messageIdCounter++;

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        conn.pendingRequests.delete(id);
        reject(new Error(`CDP command timeout: ${method}`));
      }, timeout);

      conn.pendingRequests.set(id, { resolve, reject, timeout: timeoutHandle });
      conn.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // Single-use ws — fallback when the pool is wedged. Each call opens a
  // fresh connection, sends one request, waits for the matching id,
  // closes. Less efficient (re-handshakes per call) but recovers from
  // broken pooled connections without wedging the rest of the session.
  async function sendCdpCommandSingle(wsUrl, method, params = {}, timeout = DEFAULT_CDP_TIMEOUT_MS) {
    const ws = new WebSocketClient(wsUrl);

    return new Promise((resolve, reject) => {
      // Single-use ws sends exactly one request — id=1 is fine because the
      // connection is fresh and there's nothing to collide with.
      const id = 1;
      let resolved = false;

      ws.on('message', (msg) => {
        const data = JSON.parse(msg);
        if (data.id === id) {
          resolved = true;
          ws.close();
          if (data.error) {
            reject(new Error(data.error.message || JSON.stringify(data.error)));
          } else {
            resolve(data.result);
          }
        }
      });

      ws.on('error', (err) => {
        if (!resolved) {
          reject(err);
        }
      });

      ws.connect()
        .then(() => {
          ws.send(JSON.stringify({ id, method, params }));
        })
        .catch(reject);

      setTimeout(() => {
        if (!resolved) {
          ws.close();
          reject(new Error('CDP command timeout'));
        }
      }, timeout);
    });
  }

  async function sendCdpCommand(wsUrl, method, params = {}, timeout = DEFAULT_CDP_TIMEOUT_MS) {
    try {
      return await sendCdpCommandPooled(wsUrl, method, params, timeout);
    } catch (e) {
      console.error('Pooled connection failed, using single-use:', e.message);
      return await sendCdpCommandSingle(wsUrl, method, params, timeout);
    }
  }

  function closePooledConnection(wsUrl) {
    const conn = state.connectionPool.get(wsUrl);
    if (conn) {
      conn.ws.close();
      state.connectionPool.delete(wsUrl);
    }
  }

  function closeAllConnections() {
    for (const [_wsUrl, conn] of state.connectionPool) {
      conn.ws.close();
    }
    state.connectionPool.clear();
  }

  return {
    getPooledConnection,
    sendCdpCommand,
    sendCdpCommandPooled,
    sendCdpCommandSingle,
    closePooledConnection,
    closeAllConnections,
  };
}

module.exports = { attachCdpConnection };
