// Shared test helpers for Tier A unit tests.
//
// Two spy shapes:
//
// makeCdpSpy() returns a sendCdpCommand-shaped function that records every
// call and returns a configurable result. Used by the legacy
// (resolveWsUrl, sendCdpCommand) callers and any pre-flatten test.
//
// makePageSessionSpy() returns a pageSession-shaped object whose .send()
// records every call and returns a configurable result. The post-flatten
// action libs take a getPageSession callback; pair this spy with
// makeGetPageSession(ps) to wire it in.
//
// Example:
//
//   const ps = makePageSessionSpy({
//     'Runtime.evaluate': () => ({ result: { value: 'fake' } }),
//   });
//   ... await someAction(...);
//   assert.equal(ps.calls.length, 1);
//   assert.equal(ps.calls[0].method, 'Runtime.evaluate');

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

/**
 * Create a fake pageSession: records send() calls in `.calls`, dispatches
 * configurable handler results, and supports onEvent / waitForEvent /
 * enableDomain / detach so action libs that touch those keep working.
 *
 * `ps.deliver(msg)` is a test-only escape hatch — call it to push a fake
 * inbound message to all currently-registered onEvent listeners. Mirrors
 * what the cdp-router does in production.
 */
export function makePageSessionSpy(handlers = {}) {
  const calls = [];
  const eventListeners = new Set();
  const enabledDomains = new Set();
  const ps = {
    sessionId: 'TEST-SESSION',
    targetId: 'TEST-TARGET',
    async send(method, params = {}, opts) {
      calls.push({ method, params, opts });
      const handler = handlers[method];
      if (typeof handler === 'function') return handler(params);
      if (handler !== undefined) return handler;
      return { result: { value: undefined } };
    },
    onEvent(fn) { eventListeners.add(fn); return () => eventListeners.delete(fn); },
    waitForEvent(method, opts = {}) {
      return new Promise((resolve, reject) => {
        const t = opts.timeoutMs ? setTimeout(() => {
          eventListeners.delete(handler);
          reject(new Error(`waitForEvent ${method}: timed out`));
        }, opts.timeoutMs) : null;
        const handler = (m) => {
          if (m.method === method) {
            if (t) clearTimeout(t);
            eventListeners.delete(handler);
            resolve(m);
          }
        };
        eventListeners.add(handler);
      });
    },
    async enableDomain(name) {
      if (enabledDomains.has(name)) return;
      await ps.send(`${name}.enable`, {});
      enabledDomains.add(name);
    },
    async detach() { /* noop */ },
    deliver(msg) { for (const fn of [...eventListeners]) fn(msg); },
  };
  ps.calls = calls;
  return ps;
}

/**
 * Returns an async function that resolves to the given page session,
 * matching the orchestrator's getPageSession resolver shape.
 */
export function makeGetPageSession(ps) {
  return async () => ps;
}
