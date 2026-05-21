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

/**
 * makeBrowserSessionFake — pretends to be a browser-session for page-session tests.
 * Records send() calls, lets the test inject responses via onEvent listeners
 * (the cdp-router subscribes there), exposes sendRaw passthrough that captures the
 * raw JSON.
 *
 * Usage:
 *   const browser = makeBrowserSessionFake();
 *   browser.setResolver('Target.attachToTarget', () => ({ sessionId: 'S1' }));
 *   const router = createCdpRouter({ browser });
 *   const ps = await attachPageSession({ browser, router }, 'T1');
 *   ps.send('Page.navigate', { url: '...' }).then(...);
 *   const sent = JSON.parse(browser.sentRaw[0]);
 *   browser.inject({ sessionId: 'S1', id: sent.id, result: {} });
 */
export function makeBrowserSessionFake() {
  const sentRaw = [];
  const sendCalls = [];
  const resolvers = new Map();
  const handlers = new Set();
  return {
    send: async (method, params, opts) => {
      sendCalls.push({ method, params, opts });
      const r = resolvers.get(method);
      if (!r) throw new Error(`makeBrowserSessionFake: no resolver for ${method}`);
      return r(params);
    },
    sendRaw: (json) => { sentRaw.push(json); },
    onEvent: (fn) => { handlers.add(fn); return () => handlers.delete(fn); },
    isConnected: () => true,
    inject: (msg) => { for (const fn of handlers) fn(msg); },
    setResolver: (method, fn) => resolvers.set(method, fn),
    sentRaw, sendCalls,
  };
}

/**
 * makePageSessionFake — pretends to be a page-session for action-lib tests.
 *
 * Records send() calls in `calls`. Returns configured handler result, or {} if
 * no handler is registered for the method. enableDomain is idempotent and is
 * also recorded as a `<Domain>.enable` send() call.
 *
 * Usage:
 *   const ps = makePageSessionFake({
 *     'Page.captureScreenshot': () => ({ data: 'base64data' }),
 *   });
 *   await doAction(ps);
 *   assert.equal(ps.calls.some(c => c.method === 'Page.captureScreenshot'), true);
 */
export function makePageSessionFake(handlers = {}, { sessionId = 'S-fake', targetId = 'T-fake' } = {}) {
  const calls = [];
  const enabled = new Set();
  const listeners = new Set();
  async function send(method, params = {}, opts) {
    calls.push({ method, params, opts });
    const handler = handlers[method];
    if (typeof handler === 'function') return handler(params);
    if (handler !== undefined) return handler;
    return {};
  }
  async function enableDomain(name) {
    if (enabled.has(name)) return;
    enabled.add(name);
    await send(name + '.enable', {});
  }
  function onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function injectEvent(msg) { for (const fn of listeners) fn(msg); }
  return { sessionId, targetId, send, enableDomain, onEvent, injectEvent, calls };
}
