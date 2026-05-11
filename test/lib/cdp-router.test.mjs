import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCdpRouter } = require('../../skills/browsing/lib/cdp-router.js');

// Mock browser-session: captures the onEvent handler so the test can drive
// it directly. Each test manually calls browserSession.deliver(msg) to
// simulate an inbound CDP message.
function makeMockBrowser() {
  let handler = null;
  return {
    onEvent(fn) { handler = fn; return () => { handler = null; }; },
    deliver(msg) { if (handler) handler(msg); },
  };
}

describe('cdp-router', () => {
  it('routes session command response to the matching pendingRequest', () => {
    const browser = makeMockBrowser();
    const router = createCdpRouter({ browser });

    const sess = router.registerSession('SID1');
    let resolved;
    sess.pendingRequests.set(7, {
      resolve: (v) => { resolved = v; },
      reject: () => { throw new Error('should not reject'); },
      timeout: setTimeout(() => {}, 1000),
    });

    browser.deliver({ id: 7, sessionId: 'SID1', result: { ok: true } });

    assert.deepEqual(resolved, { ok: true });
    assert.equal(sess.pendingRequests.has(7), false);
  });

  it('routes session command error to reject', () => {
    const browser = makeMockBrowser();
    const router = createCdpRouter({ browser });

    const sess = router.registerSession('SID1');
    let rejected;
    sess.pendingRequests.set(1, {
      resolve: () => { throw new Error('should not resolve'); },
      reject: (e) => { rejected = e; },
      timeout: setTimeout(() => {}, 1000),
    });

    browser.deliver({ id: 1, sessionId: 'SID1', error: { message: 'boom' } });

    assert.equal(rejected.message, 'boom');
  });

  it('routes session events to that session\'s eventListeners', () => {
    const browser = makeMockBrowser();
    const router = createCdpRouter({ browser });

    const sess = router.registerSession('SID1');
    const seen = [];
    sess.eventListeners.add((m) => seen.push(m));

    browser.deliver({ method: 'Page.loadEventFired', params: {}, sessionId: 'SID1' });

    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'Page.loadEventFired');
  });

  it('does not fire other sessions\' listeners', () => {
    const browser = makeMockBrowser();
    const router = createCdpRouter({ browser });

    const a = router.registerSession('A');
    const b = router.registerSession('B');
    const seenA = [];
    const seenB = [];
    a.eventListeners.add((m) => seenA.push(m));
    b.eventListeners.add((m) => seenB.push(m));

    browser.deliver({ method: 'X.y', sessionId: 'A' });

    assert.equal(seenA.length, 1);
    assert.equal(seenB.length, 0);
  });

  it('routes sessionless events to root listeners', () => {
    const browser = makeMockBrowser();
    const router = createCdpRouter({ browser });

    const seen = [];
    router.getRootListeners().add((m) => seen.push(m));

    browser.deliver({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 't1' } } });

    assert.equal(seen.length, 1);
    assert.equal(seen[0].params.targetInfo.targetId, 't1');
  });

  it('does NOT route sessionless command responses to root listeners', () => {
    // Regression: root command responses are correlated by browser-session.js's
    // pendingRequests, NOT the router. The router must NOT also try, or we'd
    // have two correlation paths fighting.
    const browser = makeMockBrowser();
    const router = createCdpRouter({ browser });

    const seen = [];
    router.getRootListeners().add((m) => seen.push(m));

    browser.deliver({ id: 42, result: { ok: true } });

    assert.equal(seen.length, 0);
  });

  it('drops messages for an unregistered sessionId silently', () => {
    const browser = makeMockBrowser();
    createCdpRouter({ browser });

    // No session registered for 'GHOST'. Should not throw.
    browser.deliver({ id: 1, sessionId: 'GHOST', result: {} });
    browser.deliver({ method: 'X.y', sessionId: 'GHOST' });
  });

  it('unregisterSession rejects in-flight pendingRequests', () => {
    const browser = makeMockBrowser();
    const router = createCdpRouter({ browser });

    const sess = router.registerSession('SID');
    let rejected;
    sess.pendingRequests.set(1, {
      resolve: () => {},
      reject: (e) => { rejected = e; },
      timeout: setTimeout(() => {}, 1000),
    });

    router.unregisterSession('SID');

    assert.match(rejected.message, /detached/i);
    assert.equal(sess.pendingRequests.size, 0);
  });

  it('unregisterSession on missing session is a no-op', () => {
    const browser = makeMockBrowser();
    const router = createCdpRouter({ browser });
    // No throw.
    router.unregisterSession('NOPE');
  });
});
