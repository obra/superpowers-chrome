import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeFakeWs } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { createBrowserSession } = require('../../skills/browsing/lib/browser-session.js');

function makeFixtures() {
  const ws = makeFakeWs();
  let connectCalled = 0;
  const chromeHttp = async (path) => {
    if (path !== '/json/version') throw new Error('unexpected path: ' + path);
    return { webSocketDebuggerUrl: 'ws://localhost:9222/devtools/browser/abc' };
  };
  const rewriteWsUrl = (url) => url;
  function WebSocketClient() { connectCalled++; return ws; }
  return { ws, chromeHttp, rewriteWsUrl, WebSocketClient, connectCalled: () => connectCalled };
}

describe('browser-session: connect lifecycle', () => {
  it('does not connect until first send()', async () => {
    const f = makeFixtures();
    const bs = createBrowserSession({
      host: 'localhost', port: 9222,
      rewriteWsUrl: f.rewriteWsUrl, chromeHttp: f.chromeHttp,
      WebSocketClient: f.WebSocketClient,
    });
    assert.equal(f.connectCalled(), 0);
    assert.equal(bs.isConnected(), false);
  });

  it('connects on first send and resolves the command via id correlation', async () => {
    const f = makeFixtures();
    const bs = createBrowserSession({
      host: 'localhost', port: 9222,
      rewriteWsUrl: f.rewriteWsUrl, chromeHttp: f.chromeHttp,
      WebSocketClient: f.WebSocketClient,
    });
    const p = bs.send('Target.getTargets');
    // Wait for the lazy connect + send to complete
    await new Promise((r) => setImmediate(r));
    assert.equal(f.connectCalled(), 1);
    const sentPayload = JSON.parse(f.ws.sent[0]);
    assert.equal(sentPayload.method, 'Target.getTargets');
    f.ws.injectMessage(JSON.stringify({ id: sentPayload.id, result: { targetInfos: [] } }));
    assert.deepEqual(await p, { targetInfos: [] });
  });

  it('only opens one WebSocket under concurrent first calls', async () => {
    const f = makeFixtures();
    const bs = createBrowserSession({
      host: 'localhost', port: 9222,
      rewriteWsUrl: f.rewriteWsUrl, chromeHttp: f.chromeHttp,
      WebSocketClient: f.WebSocketClient,
    });
    const p1 = bs.send('A');
    const p2 = bs.send('B');
    await new Promise((r) => setImmediate(r));
    assert.equal(f.connectCalled(), 1);
    const [r1, r2] = f.ws.sent.map(JSON.parse);
    f.ws.injectMessage(JSON.stringify({ id: r1.id, result: { a: 1 } }));
    f.ws.injectMessage(JSON.stringify({ id: r2.id, result: { b: 2 } }));
    assert.deepEqual(await p1, { a: 1 });
    assert.deepEqual(await p2, { b: 2 });
  });
});

describe('browser-session: failure recovery', () => {
  it('allows retry after chromeHttp fails on first attempt', async () => {
    const ws = makeFakeWs();
    let attempts = 0;
    const chromeHttp = async () => {
      attempts++;
      if (attempts === 1) throw new Error('connection refused');
      return { webSocketDebuggerUrl: 'ws://localhost:9222/devtools/browser/abc' };
    };
    const bs = createBrowserSession({
      host: 'localhost', port: 9222,
      rewriteWsUrl: (u) => u,
      chromeHttp,
      WebSocketClient: function () { return ws; },
    });
    await assert.rejects(bs.send('A'), /connection refused/);
    // Retry should succeed
    const p = bs.send('B');
    await new Promise((r) => setImmediate(r));
    const sent = JSON.parse(ws.sent[0]);
    ws.injectMessage(JSON.stringify({ id: sent.id, result: { ok: true } }));
    assert.deepEqual(await p, { ok: true });
    assert.equal(attempts, 2);
  });

  it('allows retry after WebSocket connect fails on first attempt', async () => {
    let attempts = 0;
    const ws2 = makeFakeWs(); // the successful ws
    function WebSocketClient() {
      attempts++;
      if (attempts === 1) {
        // Return a ws whose connect() rejects
        return {
          on() {}, send() {}, close() {},
          isConnected() { return false; },
          async connect() { throw new Error('ECONNREFUSED'); },
        };
      }
      return ws2;
    }
    const chromeHttp = async () => ({ webSocketDebuggerUrl: 'ws://localhost:9222/devtools/browser/abc' });
    const bs = createBrowserSession({
      host: 'localhost', port: 9222,
      rewriteWsUrl: (u) => u,
      chromeHttp,
      WebSocketClient,
    });
    await assert.rejects(bs.send('A'), /ECONNREFUSED/);
    const p = bs.send('B');
    await new Promise((r) => setImmediate(r));
    const sent = JSON.parse(ws2.sent[0]);
    ws2.injectMessage(JSON.stringify({ id: sent.id, result: { ok: true } }));
    assert.deepEqual(await p, { ok: true });
    assert.equal(attempts, 2);
  });
});
