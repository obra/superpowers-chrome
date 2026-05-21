// Shared test helpers for Tier A unit tests.
//
// makeCdpSpy() returns a sendCdpCommand-shaped function that records every
// call and returns a configurable result. Use:
//
//   const sendCdpCommand = makeCdpSpy({
//     'Runtime.evaluate': () => ({ result: { value: 'fake' } }),
//     'Page.captureScreenshot': () => ({ data: '' }),
//   });
//   ... await someAction(...);
//   assert.equal(sendCdpCommand.calls.length, 1);
//   assert.equal(sendCdpCommand.calls[0].method, 'Runtime.evaluate');
//
// makeResolveWsUrl() returns a stub that always resolves to the given URL.
// Default 'ws://test/devtools/page/abc'.

export function makeCdpSpy(handlers = {}) {
  const calls = [];
  async function sendCdpCommand(wsUrl, method, params = {}, timeout) {
    calls.push({ wsUrl, method, params, timeout });
    const handler = handlers[method];
    if (typeof handler === 'function') return handler(params);
    if (handler !== undefined) return handler;
    return { result: { value: undefined } };
  }
  sendCdpCommand.calls = calls;
  return sendCdpCommand;
}

export function makeResolveWsUrl(wsUrl = 'ws://test/devtools/page/abc') {
  return async () => wsUrl;
}

// makeFakeWs() returns a deterministic WebSocket fake for bridge tests.
// Useful for testing transport primitives in isolation. Features:
//
//   const ws = makeFakeWs();
//   await ws.connect();
//   ws.on('message', (msg) => { ... });
//   ws.send(payload);
//   ws.injectMessage(raw);  // Simulate server message
//   ws.close();
//   assert.deepEqual(ws.sent, [...]);  // Inspect all sent messages
//
// Single-listener semantics: calling on(event, cb) replaces any previous
// listener for that event (matching the real WebSocketClient interface).
//
export function makeFakeWs() {
  const callbacks = { message: null, close: null, error: null };
  let connected = false;
  const sent = [];
  return {
    on(event, fn) { callbacks[event] = fn; },
    send(payload) { sent.push(payload); },
    async connect() { connected = true; },
    close() {
      connected = false;
      if (callbacks.close) callbacks.close();
    },
    isConnected() { return connected; },
    injectMessage(raw) {
      if (callbacks.message) callbacks.message(raw);
    },
    injectError(err) {
      if (callbacks.error) callbacks.error(err);
    },
    sent,
  };
}
