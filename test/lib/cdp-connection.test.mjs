import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { attachCdpConnection } = require('../../skills/browsing/lib/cdp-connection.js');

// Minimal fake WebSocketClient: resolves connect() immediately, no network.
function makeFakeWebSocketClient(_url) {
  return {
    on() {},
    isConnected() { return true; },
    async connect() {},
    send() {},
    close() {},
  };
}

describe('cdp-connection', () => {
  function setup() {
    const state = { connectionPool: new Map() };
    return { ...attachCdpConnection({ state }), state };
  }

  it('closePooledConnection removes a pooled entry that does not exist', () => {
    const { closePooledConnection } = setup();
    // No throw, just no-op.
    closePooledConnection('ws://nope');
  });

  it('closePooledConnection removes an entry from the pool', () => {
    const { closePooledConnection, state } = setup();
    const fakeWs = { close: () => {} };
    state.connectionPool.set('ws://x', { ws: fakeWs });
    closePooledConnection('ws://x');
    assert.equal(state.connectionPool.has('ws://x'), false);
  });

  it('closeAllConnections clears the pool', () => {
    const { closeAllConnections, state } = setup();
    state.connectionPool.set('ws://a', { ws: { close: () => {} } });
    state.connectionPool.set('ws://b', { ws: { close: () => {} } });
    closeAllConnections();
    assert.equal(state.connectionPool.size, 0);
  });

  it('exports the expected method set', () => {
    const conn = setup();
    assert.equal(typeof conn.sendCdpCommand, 'function');
    assert.equal(typeof conn.sendCdpCommandPooled, 'function');
    assert.equal(typeof conn.sendCdpCommandSingle, 'function');
    assert.equal(typeof conn.getPooledConnection, 'function');
    assert.equal(typeof conn.closePooledConnection, 'function');
    assert.equal(typeof conn.closeAllConnections, 'function');
    assert.equal(typeof conn.setDialogs, 'function');
  });
});

describe('cdp-connection setDialogs', () => {
  it('setDialogs wires dialogs after construction — attachToConnection fires on later connections', async () => {
    const calls = [];
    const dialogs = {
      attachToConnection: async (conn, wsUrl) => { calls.push({ conn, wsUrl }); },
    };
    const state = { connectionPool: new Map() };
    const api = attachCdpConnection({ state, WebSocketClient: makeFakeWebSocketClient });

    // No dialogs yet — first connection should NOT trigger attachToConnection.
    await api.getPooledConnection('ws://fake/a');
    assert.equal(calls.length, 0, 'no attachment before setDialogs');

    // Wire dialogs in.
    api.setDialogs(dialogs);

    // New connection (different URL) — should trigger attachToConnection.
    const conn = await api.getPooledConnection('ws://fake/b');
    assert.equal(calls.length, 1, 'attachToConnection fires after setDialogs');
    assert.equal(calls[0].wsUrl, 'ws://fake/b');
    assert.equal(calls[0].conn, conn);
  });
});

describe('cdp-connection dialog attachment', () => {
  it('calls dialogs.attachToConnection when creating a new pooled connection', async () => {
    const calls = [];
    const dialogs = {
      attachToConnection: async (conn, wsUrl) => { calls.push({ conn, wsUrl }); },
    };
    const state = { connectionPool: new Map() };
    const { getPooledConnection } = attachCdpConnection({
      state,
      dialogs,
      WebSocketClient: makeFakeWebSocketClient,
    });

    const wsUrl = 'ws://fake-host/devtools/page/test-1';
    const conn = await getPooledConnection(wsUrl);

    assert.equal(calls.length, 1, 'attachToConnection should fire once for the new pool entry');
    assert.equal(calls[0].wsUrl, wsUrl, 'wsUrl passed to attachToConnection matches');
    assert.equal(calls[0].conn, conn, 'conn passed to attachToConnection is the pooled connection object');
  });

  it('does not call dialogs.attachToConnection when no dialogs provided', async () => {
    const state = { connectionPool: new Map() };
    const { getPooledConnection } = attachCdpConnection({
      state,
      WebSocketClient: makeFakeWebSocketClient,
    });
    // Should not throw even without dialogs.
    const conn = await getPooledConnection('ws://fake-host/devtools/page/test-2');
    assert.ok(conn, 'connection returned without dialogs');
  });

  it('does not call dialogs.attachToConnection for an already-connected pooled entry', async () => {
    const calls = [];
    const dialogs = {
      attachToConnection: async (_conn, wsUrl) => { calls.push({ wsUrl }); },
    };
    const state = { connectionPool: new Map() };
    const { getPooledConnection } = attachCdpConnection({
      state,
      dialogs,
      WebSocketClient: makeFakeWebSocketClient,
    });

    const wsUrl = 'ws://fake-host/devtools/page/test-3';
    await getPooledConnection(wsUrl); // first call — creates and attaches
    await getPooledConnection(wsUrl); // second call — reuses; isConnected() is true

    assert.equal(calls.length, 1, 'attachToConnection fires only once across two getPooledConnection calls to the same wsUrl');
  });
});
