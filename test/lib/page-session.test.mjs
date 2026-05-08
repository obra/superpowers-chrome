import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { attachPageSession } = require('../../skills/browsing/lib/page-session.js');
const { createCdpRouter } = require('../../skills/browsing/lib/cdp-router.js');

// Mock browser that stores Target.attachToTarget responses, captures sendRaw
// payloads, and lets the test deliver inbound messages via deliver().
function makeMockBrowser({ attachSessionId = 'SID1' } = {}) {
  let handler = null;
  const sentRaw = [];
  const sentCommands = [];
  return {
    onEvent(fn) { handler = fn; return () => { handler = null; }; },
    deliver(msg) { if (handler) handler(msg); },
    sentRaw,
    sentCommands,
    async send(method, params) {
      sentCommands.push({ method, params });
      if (method === 'Target.attachToTarget') return { sessionId: attachSessionId };
      if (method === 'Target.detachFromTarget') return {};
      return {};
    },
    sendRaw(json) { sentRaw.push(JSON.parse(json)); },
  };
}

describe('page-session', () => {
  it('attaches via Target.attachToTarget({flatten:true}) and returns a session handle', async () => {
    const browser = makeMockBrowser({ attachSessionId: 'SID-X' });
    const router = createCdpRouter({ browser });
    const ps = await attachPageSession({ browser, router }, 'target-1');

    assert.equal(ps.sessionId, 'SID-X');
    assert.equal(ps.targetId, 'target-1');
    assert.equal(browser.sentCommands[0].method, 'Target.attachToTarget');
    assert.equal(browser.sentCommands[0].params.targetId, 'target-1');
    assert.equal(browser.sentCommands[0].params.flatten, true);
  });

  it('send() builds a sessionId-enveloped JSON payload via sendRaw and resolves on response', async () => {
    const browser = makeMockBrowser({ attachSessionId: 'SID-A' });
    const router = createCdpRouter({ browser });
    const ps = await attachPageSession({ browser, router }, 'target-1');

    const sendP = ps.send('Page.navigate', { url: 'about:blank' });

    // The send should have pushed a JSON envelope through sendRaw.
    const env = browser.sentRaw[0];
    assert.equal(env.method, 'Page.navigate');
    assert.deepEqual(env.params, { url: 'about:blank' });
    assert.equal(env.sessionId, 'SID-A');
    assert.equal(typeof env.id, 'number');

    // Simulate the response arriving via the router.
    browser.deliver({ id: env.id, sessionId: 'SID-A', result: { frameId: 'F1' } });

    const result = await sendP;
    assert.deepEqual(result, { frameId: 'F1' });
  });

  it('send() uses an independent id-counter per session', async () => {
    const browser = makeMockBrowser({ attachSessionId: 'A' });
    const router = createCdpRouter({ browser });
    const ps = await attachPageSession({ browser, router }, 'target-1');

    const p1 = ps.send('X.y');
    const p2 = ps.send('X.z');

    const ids = browser.sentRaw.map((e) => e.id);
    assert.equal(ids[0], 1);
    assert.equal(ids[1], 2);

    // Resolve to keep the test clean.
    browser.deliver({ id: 1, sessionId: 'A', result: { ok: 1 } });
    browser.deliver({ id: 2, sessionId: 'A', result: { ok: 2 } });
    await p1; await p2;
  });

  it('onEvent receives session-tagged events', async () => {
    const browser = makeMockBrowser({ attachSessionId: 'A' });
    const router = createCdpRouter({ browser });
    const ps = await attachPageSession({ browser, router }, 't1');

    const seen = [];
    ps.onEvent((m) => seen.push(m));

    browser.deliver({ method: 'Page.loadEventFired', params: {}, sessionId: 'A' });
    browser.deliver({ method: 'Other', sessionId: 'B' }); // different session, must not fire

    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'Page.loadEventFired');
  });

  it('waitForEvent resolves on first matching event', async () => {
    const browser = makeMockBrowser({ attachSessionId: 'A' });
    const router = createCdpRouter({ browser });
    const ps = await attachPageSession({ browser, router }, 't1');

    const p = ps.waitForEvent('Page.loadEventFired');
    browser.deliver({ method: 'Runtime.consoleAPICalled', sessionId: 'A' }); // ignore
    browser.deliver({ method: 'Page.loadEventFired', sessionId: 'A', params: { timestamp: 1 } });

    const got = await p;
    assert.equal(got.method, 'Page.loadEventFired');
  });

  it('enableDomain is idempotent', async () => {
    const browser = makeMockBrowser({ attachSessionId: 'A' });
    const router = createCdpRouter({ browser });
    const ps = await attachPageSession({ browser, router }, 't1');

    // Drive responses for the enable() call.
    const drive = (env) => browser.deliver({ id: env.id, sessionId: 'A', result: {} });

    const p1 = ps.enableDomain('Runtime');
    drive(browser.sentRaw[browser.sentRaw.length - 1]);
    await p1;

    // Second call: must not push another command through sendRaw.
    const before = browser.sentRaw.length;
    await ps.enableDomain('Runtime');
    assert.equal(browser.sentRaw.length, before);
  });

  it('detach issues Target.detachFromTarget and unregisters the session', async () => {
    const browser = makeMockBrowser({ attachSessionId: 'A' });
    const router = createCdpRouter({ browser });
    const ps = await attachPageSession({ browser, router }, 't1');

    await ps.detach();

    const detachCalls = browser.sentCommands.filter((c) => c.method === 'Target.detachFromTarget');
    assert.equal(detachCalls.length, 1);
    assert.equal(detachCalls[0].params.sessionId, 'A');

    // After detach, send rejects.
    await assert.rejects(() => ps.send('X.y'), /detached/i);
  });

  it('detach is idempotent', async () => {
    const browser = makeMockBrowser({ attachSessionId: 'A' });
    const router = createCdpRouter({ browser });
    const ps = await attachPageSession({ browser, router }, 't1');

    await ps.detach();
    await ps.detach(); // no throw

    const detachCalls = browser.sentCommands.filter((c) => c.method === 'Target.detachFromTarget');
    assert.equal(detachCalls.length, 1);
  });
});
