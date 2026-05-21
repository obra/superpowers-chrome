import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeWs, makePageSessionFake } from './_helpers.mjs';

describe('makeFakeWs', () => {
  it('starts disconnected; connect() resolves and sets isConnected', async () => {
    const ws = makeFakeWs();
    assert.equal(ws.isConnected(), false);
    await ws.connect();
    assert.equal(ws.isConnected(), true);
  });

  it('echoes back messages via injectMessage to "message" listeners', async () => {
    const ws = makeFakeWs();
    await ws.connect();
    const seen = [];
    ws.on('message', (m) => seen.push(m));
    ws.injectMessage('{"id":1,"result":{}}');
    assert.deepEqual(seen, ['{"id":1,"result":{}}']);
  });

  it('records every send() call', async () => {
    const ws = makeFakeWs();
    await ws.connect();
    ws.send('hello');
    assert.deepEqual(ws.sent, ['hello']);
  });

  it('fires "close" listeners on close()', async () => {
    const ws = makeFakeWs();
    await ws.connect();
    let closed = false;
    ws.on('close', () => { closed = true; });
    ws.close();
    assert.equal(closed, true);
    assert.equal(ws.isConnected(), false);
  });

  it('replaces the listener when on() is called twice for the same event', async () => {
    const ws = makeFakeWs();
    await ws.connect();
    let aCalled = 0, bCalled = 0;
    ws.on('message', () => { aCalled++; });
    ws.on('message', () => { bCalled++; });
    ws.injectMessage('x');
    assert.equal(aCalled, 0);
    assert.equal(bCalled, 1);
  });
});

describe('makePageSessionFake', () => {
  it('records send() calls and returns configured results', async () => {
    const ps = makePageSessionFake({
      'Runtime.evaluate': () => ({ result: { value: 'fake' } }),
    });
    const r = await ps.send('Runtime.evaluate', { expression: '1+1' });
    assert.equal(r.result.value, 'fake');
    assert.equal(ps.calls.length, 1);
    assert.equal(ps.calls[0].method, 'Runtime.evaluate');
    assert.equal(ps.sessionId, 'S-fake');
    assert.equal(ps.targetId, 'T-fake');
  });

  it('returns vacuous {} when no handler is configured', async () => {
    const ps = makePageSessionFake();
    const r = await ps.send('Network.clearBrowserCookies', {});
    assert.deepEqual(r, {});
    assert.equal(ps.calls.length, 1);
  });

  it('enableDomain is recorded as a method call and is idempotent', async () => {
    const ps = makePageSessionFake();
    await ps.enableDomain('Runtime');
    await ps.enableDomain('Runtime');
    const enables = ps.calls.filter(c => c.method === 'Runtime.enable');
    assert.equal(enables.length, 1);
  });

  it('onEvent + injectEvent allows tests to push events through to listeners', () => {
    const ps = makePageSessionFake();
    const seen = [];
    ps.onEvent((msg) => seen.push(msg));
    ps.injectEvent({ method: 'Page.loadEventFired', params: {} });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'Page.loadEventFired');
  });

  it('sessionId and targetId are configurable via options', () => {
    const ps = makePageSessionFake({}, { sessionId: 'S-custom', targetId: 'T-custom' });
    assert.equal(ps.sessionId, 'S-custom');
    assert.equal(ps.targetId, 'T-custom');
  });
});
