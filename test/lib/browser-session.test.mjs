import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createBrowserSession } = require('../../skills/browsing/lib/browser-session.js');

// browser-session.js depends on a real WebSocketClient for the connect path,
// so the unit-testable surface here is small (lazy connect, send-after-close,
// onEvent registration, sendRaw refusal when not connected). The dispatch
// path is exercised by the cdp-router tests via a mock browser, and by the
// integration tests at /test/smoke.test.mjs.

describe('browser-session', () => {
  function setup({ chromeHttpResult } = {}) {
    const chromeHttp = async () => chromeHttpResult;
    return createBrowserSession({
      host: 'localhost',
      port: 9222,
      rewriteWsUrl: (u) => u,
      chromeHttp,
    });
  }

  it('isConnected returns false before connect', () => {
    const bs = setup();
    assert.equal(bs.isConnected(), false);
  });

  it('send rejects after close', async () => {
    const bs = setup();
    await bs.close();
    await assert.rejects(() => bs.send('X.y'), /closed/i);
  });

  it('sendRaw throws after close', async () => {
    const bs = setup();
    await bs.close();
    assert.throws(() => bs.sendRaw('{}'), /closed/i);
  });

  it('sendRaw throws when not connected', () => {
    const bs = setup();
    assert.throws(() => bs.sendRaw('{}'), /not connected/i);
  });

  it('onEvent returns an unsubscribe function', () => {
    const bs = setup();
    const unsub = bs.onEvent(() => {});
    assert.equal(typeof unsub, 'function');
    unsub(); // no throw
  });

  it('exports the expected method set', () => {
    const bs = setup();
    assert.equal(typeof bs.send, 'function');
    assert.equal(typeof bs.onEvent, 'function');
    assert.equal(typeof bs.close, 'function');
    assert.equal(typeof bs.isConnected, 'function');
    assert.equal(typeof bs.sendRaw, 'function');
  });

  it('send rejects with helpful error when chromeHttp returns no webSocketDebuggerUrl', async () => {
    const bs = setup({ chromeHttpResult: {} });
    await assert.rejects(() => bs.send('X.y'), /webSocketDebuggerUrl/i);
  });
});
