const { WebSocketClient } = require('./websocket-client');

// Fixed CDP request id used to mark the Runtime.enable response so the
// message handler can distinguish setup-acknowledged from runtime-event
// without tracking ids generally.
const RUNTIME_ENABLE_REQUEST_ID = 999999;

// How long to wait for Runtime.enable to acknowledge before failing the
// console-logging setup.
const ENABLE_TIMEOUT_MS = 5000;

/**
 * Page console-message capture.
 *
 * `enableConsoleLogging` opens a persistent WebSocket alongside the
 * pooled CDP connection (kept separate so the request/response flow
 * isn't polluted with `Runtime.consoleAPICalled` events) and streams
 * console output into `state.consoleMessages` keyed by tab ws URL.
 * `getConsoleMessages` reads them out — optionally filtered by
 * timestamp — and `clearConsoleMessages` resets the buffer for a tab.
 *
 * The fixed id `999999` is used for the `Runtime.enable` request/response
 * pair so the message handler can tell setup-acknowledged from
 * runtime-event without tracking ids generally.
 *
 * `attachConsoleLogging({ state, resolveWsUrl })` returns the bound API.
 */
function attachConsoleLogging({ state, resolveWsUrl }) {
  async function enableConsoleLogging(tabIndexOrWsUrl) {
    const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

    if (!state.consoleMessages.has(wsUrl)) {
      state.consoleMessages.set(wsUrl, []);
    }

    // Persistent ws — kept open after Runtime.enable so we keep receiving
    // Runtime.consoleAPICalled events. Separate from the pooled CDP
    // connection so RPC traffic doesn't fight event traffic.
    const ws = new WebSocketClient(wsUrl);

    return new Promise((resolve, reject) => {
      let enabledRuntime = false;

      ws.on('message', (msg) => {
        const data = JSON.parse(msg);

        // Fixed id marks the Runtime.enable response; everything
        // after that is event traffic.
        if (data.id === RUNTIME_ENABLE_REQUEST_ID && !enabledRuntime) {
          enabledRuntime = true;
          resolve();
          return;
        }

        if (data.method === 'Runtime.consoleAPICalled') {
          const entry = data.params;
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

          const messages = state.consoleMessages.get(wsUrl) || [];
          messages.push({ timestamp, level, text });
          state.consoleMessages.set(wsUrl, messages);
        }
      });

      ws.on('error', (err) => {
        if (!enabledRuntime) {
          reject(err);
        }
      });

      ws.connect()
        .then(() => {
          ws.send(JSON.stringify({
            id: RUNTIME_ENABLE_REQUEST_ID,
            method: 'Runtime.enable'
          }));
        })
        .catch(reject);

      setTimeout(() => {
        if (!enabledRuntime) {
          ws.close();
          reject(new Error('Console logging enable timeout'));
        }
      }, ENABLE_TIMEOUT_MS);
    });
  }

  async function getConsoleMessages(tabIndexOrWsUrl, sinceTime = null) {
    const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
    const messages = state.consoleMessages.get(wsUrl) || [];

    if (!sinceTime) {
      return messages;
    }

    return messages.filter(msg => new Date(msg.timestamp) > sinceTime);
  }

  async function clearConsoleMessages(tabIndexOrWsUrl) {
    const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
    state.consoleMessages.set(wsUrl, []);
  }

  return { enableConsoleLogging, getConsoleMessages, clearConsoleMessages };
}

module.exports = { attachConsoleLogging };
