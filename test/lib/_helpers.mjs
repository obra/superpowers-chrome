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
