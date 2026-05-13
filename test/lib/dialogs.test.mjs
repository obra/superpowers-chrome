import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { makeCdpSpy, makeResolveWsUrl } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachDialogs } = require('../../skills/browsing/lib/dialogs.js');

function setup(handlers = {}) {
  const state = {};
  const sendCdpCommand = makeCdpSpy(handlers);
  const api = attachDialogs({ state, sendCdpCommand, resolveWsUrl: makeResolveWsUrl() });
  return { api, sendCdpCommand, state };
}

describe('dialogs state map', () => {
  it('getOpen returns null when no dialog is open', () => {
    const { api } = setup();
    assert.equal(api.getOpen('ws://x'), null);
  });

  it('clear is a no-op when no dialog is open', () => {
    const { api } = setup();
    api.clear('ws://x');
    assert.equal(api.getOpen('ws://x'), null);
  });
});

describe('dialogs attachToConnection', () => {
  it('enables Page, DeviceAccess, and Fetch domains once', async () => {
    const { api, sendCdpCommand } = setup();
    const conn = { eventHandler: null };
    await api.attachToConnection(conn, 'ws://x');
    const methods = sendCdpCommand.calls.map(c => c.method);
    assert.deepEqual(methods, ['Page.enable', 'DeviceAccess.enable', 'Fetch.enable']);
  });

  it('Fetch.enable passes handleAuthRequests and wildcard pattern', async () => {
    const { api, sendCdpCommand } = setup();
    const conn = { eventHandler: null };
    await api.attachToConnection(conn, 'ws://x');
    const fetchCall = sendCdpCommand.calls.find(c => c.method === 'Fetch.enable');
    assert.equal(fetchCall.params.handleAuthRequests, true);
    assert.deepEqual(fetchCall.params.patterns, [{ urlPattern: '*' }]);
  });

  it('installs an eventHandler on the connection', async () => {
    const { api } = setup();
    const conn = { eventHandler: null };
    await api.attachToConnection(conn, 'ws://x');
    assert.equal(typeof conn.eventHandler, 'function');
  });
});
