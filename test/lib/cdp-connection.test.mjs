import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { attachCdpConnection } = require('../../skills/browsing/lib/cdp-connection.js');

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
  });
});
