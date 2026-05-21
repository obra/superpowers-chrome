import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeBrowserSessionFake } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachPageSession } = require('../../skills/browsing/lib/page-session.js');
const { createCdpRouter } = require('../../skills/browsing/lib/cdp-router.js');

function setup() {
  const browser = makeBrowserSessionFake();
  const router = createCdpRouter({ browser });
  browser.setResolver('Target.attachToTarget', () => ({ sessionId: 'S1' }));
  return { browser, router };
}

describe('page-session', () => {
  it('attachPageSession calls Target.attachToTarget({flatten:true}) and registers the session', async () => {
    const { browser, router } = setup();
    const ps = await attachPageSession({ browser, router }, 'T1');
    assert.equal(ps.sessionId, 'S1');
    assert.equal(ps.targetId, 'T1');
    assert.equal(browser.sendCalls[0].method, 'Target.attachToTarget');
    assert.deepEqual(browser.sendCalls[0].params, { targetId: 'T1', flatten: true });
  });

  it('send() pushes a sessionId-tagged envelope through sendRaw and resolves on matching id', async () => {
    const { browser, router } = setup();
    const ps = await attachPageSession({ browser, router }, 'T1');
    const p = ps.send('Page.navigate', { url: 'about:blank' });
    await new Promise((r) => setImmediate(r));
    const sent = JSON.parse(browser.sentRaw[0]);
    assert.equal(sent.method, 'Page.navigate');
    assert.equal(sent.sessionId, 'S1');
    assert.equal(typeof sent.id, 'number');
    browser.inject({ sessionId: 'S1', id: sent.id, result: { frameId: 'F1' } });
    assert.deepEqual(await p, { frameId: 'F1' });
  });

  it('per-session id counter starts at 1 and is independent across page sessions', async () => {
    const { browser, router } = setup();
    let nextSid = 1;
    browser.setResolver('Target.attachToTarget', () => ({ sessionId: `S${nextSid++}` }));
    const psA = await attachPageSession({ browser, router }, 'T1');
    const psB = await attachPageSession({ browser, router }, 'T2');
    psA.send('X').catch(() => {});
    psB.send('Y').catch(() => {});
    await new Promise((r) => setImmediate(r));
    const a = JSON.parse(browser.sentRaw[0]);
    const b = JSON.parse(browser.sentRaw[1]);
    assert.equal(a.id, 1);
    assert.equal(b.id, 1);
    assert.notEqual(a.sessionId, b.sessionId);
  });

  it('detach() calls Target.detachFromTarget and unregisters the router session', async () => {
    const { browser, router } = setup();
    browser.setResolver('Target.detachFromTarget', () => ({}));
    const ps = await attachPageSession({ browser, router }, 'T1');
    await ps.detach();
    assert.ok(browser.sendCalls.some(c => c.method === 'Target.detachFromTarget'));
    await assert.rejects(ps.send('X'), /detached/);
  });

  it('enableDomain is idempotent', async () => {
    const { browser, router } = setup();
    const ps = await attachPageSession({ browser, router }, 'T1');
    // Tap into sendRaw to auto-respond to enable calls
    const origSendRaw = browser.sendRaw;
    browser.sendRaw = (json) => {
      origSendRaw(json);
      const parsed = JSON.parse(json);
      // Echo a success response so the enable() promise resolves
      setImmediate(() => browser.inject({ sessionId: parsed.sessionId, id: parsed.id, result: {} }));
    };
    await ps.enableDomain('Runtime');
    await ps.enableDomain('Runtime');
    const enableCalls = browser.sentRaw.map(JSON.parse).filter(m => m.method === 'Runtime.enable');
    assert.equal(enableCalls.length, 1);
  });
});
