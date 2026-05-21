import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSession } = require('../../skills/browsing/chrome-ws-lib.js');

// Minimal fakes for a fully self-contained test (no real Chrome required)
function makeFakeChromeHttp() {
  return async (path) => {
    if (path === '/json/version') return { webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' };
    if (path === '/json/list') return [];
    throw new Error('unexpected: ' + path);
  };
}

function makeFakeWebSocketClient() {
  return function WebSocketClient() {
    const listeners = { message: null, close: null, error: null };
    let connected = false;
    return {
      on(event, fn) { listeners[event] = fn; },
      send(json) {
        const m = JSON.parse(json);
        // Auto-respond to root-session commands with a vacuous result
        if (m.id !== undefined && !m.sessionId) {
          queueMicrotask(() => { if (listeners.message) listeners.message(JSON.stringify({ id: m.id, result: {} })); });
        }
      },
      close() { connected = false; if (listeners.close) listeners.close(); },
      isConnected() { return connected; },
      async connect() { connected = true; },
    };
  };
}

describe('chrome-ws-lib: bridge init', () => {
  it('createSession constructs a browser-session and stores it on state', () => {
    const session = createSession({
      host: '127.0.0.1', port: 9222,
      _testFakes: {
        chromeHttp: makeFakeChromeHttp(),
        WebSocketClient: makeFakeWebSocketClient(),
      },
    });
    assert.ok(session.state.browserSession, 'browser-session attached to state');
    assert.equal(typeof session.state.browserSession.send, 'function');
    assert.equal(typeof session.state.ensureBridge, 'function');
    assert.equal(session.state.browserBridge, null, 'bridge not attached yet (lazy)');
  });

  it('state.ensureBridge() attaches the bridge on first call and memoizes', async () => {
    const session = createSession({
      host: '127.0.0.1', port: 9222,
      _testFakes: {
        chromeHttp: makeFakeChromeHttp(),
        WebSocketClient: makeFakeWebSocketClient(),
      },
    });
    const bridge1 = await session.state.ensureBridge();
    assert.equal(session.state.browserBridge, bridge1);
    assert.equal(typeof bridge1.attachPageSession, 'function');
    // Second call returns the same handle
    const bridge2 = await session.state.ensureBridge();
    assert.equal(bridge1, bridge2);
  });
});
