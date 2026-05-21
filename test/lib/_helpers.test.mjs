import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeWs } from './_helpers.mjs';

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
