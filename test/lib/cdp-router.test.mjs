import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCdpRouter } = require('../../skills/browsing/lib/cdp-router.js');

function makeBrowserFake() {
  const handlers = new Set();
  return {
    onEvent(fn) { handlers.add(fn); return () => handlers.delete(fn); },
    inject(msg) { for (const fn of handlers) fn(msg); },
  };
}

describe('cdp-router', () => {
  it('dispatches tagged responses to per-session pendingRequests', async () => {
    const browser = makeBrowserFake();
    const router = createCdpRouter({ browser });
    const sess = router.registerSession('S1');
    const p = new Promise((resolve, reject) => {
      sess.pendingRequests.set(7, { resolve, reject, timeout: setTimeout(() => {}, 1000) });
    });
    browser.inject({ id: 7, sessionId: 'S1', result: { value: 42 } });
    assert.deepEqual(await p, { value: 42 });
  });

  it('dispatches tagged events to per-session listeners', () => {
    const browser = makeBrowserFake();
    const router = createCdpRouter({ browser });
    const sess = router.registerSession('S1');
    const seen = [];
    sess.eventListeners.add((m) => seen.push(m));
    browser.inject({ sessionId: 'S1', method: 'Page.loadEventFired', params: {} });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'Page.loadEventFired');
  });

  it('silently drops messages for unregistered sessionId (post-detach stragglers)', () => {
    const browser = makeBrowserFake();
    createCdpRouter({ browser });
    assert.doesNotThrow(() => {
      browser.inject({ sessionId: 'ghost', method: 'X', params: {} });
      browser.inject({ sessionId: 'ghost', id: 1, result: {} });
    });
  });

  it('routes untagged events to root listeners', () => {
    const browser = makeBrowserFake();
    const router = createCdpRouter({ browser });
    const seen = [];
    router.getRootListeners().add((m) => seen.push(m));
    browser.inject({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'T1' } } });
    assert.equal(seen.length, 1);
  });

  it('does NOT route untagged responses anywhere (browser-session owns correlation)', () => {
    const browser = makeBrowserFake();
    const router = createCdpRouter({ browser });
    const seen = [];
    router.getRootListeners().add((m) => seen.push(m));
    browser.inject({ id: 1, result: {} });
    assert.equal(seen.length, 0);
  });

  it('unregisterSession rejects pending requests so awaiters do not hang', async () => {
    const browser = makeBrowserFake();
    const router = createCdpRouter({ browser });
    const sess = router.registerSession('S1');
    const p = new Promise((resolve, reject) => {
      sess.pendingRequests.set(1, { resolve, reject, timeout: setTimeout(() => {}, 1000) });
    });
    router.unregisterSession('S1');
    await assert.rejects(p, /detached/);
  });
});
