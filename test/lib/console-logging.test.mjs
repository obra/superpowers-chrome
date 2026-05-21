import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { makePageSessionFake } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachConsoleLogging } = require('../../skills/browsing/lib/console-logging.js');

describe('console-logging', () => {
  function setup(sessionId = 'S-test') {
    const ps = makePageSessionFake({}, { sessionId });
    const state = { consoleMessages: new Map() };
    const getPageSession = async () => ps;
    const api = attachConsoleLogging({ state, getPageSession });
    return { ps, state, ...api };
  }

  it('enableConsoleLogging enables Runtime domain and registers event handler', async () => {
    const { ps, enableConsoleLogging } = setup();
    await enableConsoleLogging(0);
    assert.ok(ps.calls.some(c => c.method === 'Runtime.enable'), 'Runtime.enable should be called');
  });

  it('Runtime.consoleAPICalled string arg is captured into sessionId buffer', async () => {
    const { ps, enableConsoleLogging, getConsoleMessages } = setup('S1');
    await enableConsoleLogging(0);

    ps.injectEvent({
      method: 'Runtime.consoleAPICalled',
      params: {
        type: 'log',
        args: [{ type: 'string', value: 'hello world' }]
      }
    });

    const msgs = await getConsoleMessages(0);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].text, 'hello world');
    assert.equal(msgs[0].level, 'log');
    assert.ok(msgs[0].timestamp, 'timestamp should be set');
  });

  it('Runtime.consoleAPICalled number arg is formatted as string', async () => {
    const { ps, enableConsoleLogging, getConsoleMessages } = setup();
    await enableConsoleLogging(0);

    ps.injectEvent({
      method: 'Runtime.consoleAPICalled',
      params: {
        type: 'warn',
        args: [{ type: 'number', value: 42 }]
      }
    });

    const msgs = await getConsoleMessages(0);
    assert.equal(msgs[0].text, '42');
    assert.equal(msgs[0].level, 'warn');
  });

  it('Runtime.consoleAPICalled boolean arg is formatted as string', async () => {
    const { ps, enableConsoleLogging, getConsoleMessages } = setup();
    await enableConsoleLogging(0);

    ps.injectEvent({
      method: 'Runtime.consoleAPICalled',
      params: {
        type: 'log',
        args: [{ type: 'boolean', value: false }]
      }
    });

    const msgs = await getConsoleMessages(0);
    assert.equal(msgs[0].text, 'false');
  });

  it('Runtime.consoleAPICalled object arg uses description', async () => {
    const { ps, enableConsoleLogging, getConsoleMessages } = setup();
    await enableConsoleLogging(0);

    ps.injectEvent({
      method: 'Runtime.consoleAPICalled',
      params: {
        type: 'log',
        args: [{ type: 'object', description: 'Error: boom' }]
      }
    });

    const msgs = await getConsoleMessages(0);
    assert.equal(msgs[0].text, 'Error: boom');
  });

  it('Runtime.consoleAPICalled object arg with no description falls back to [Object]', async () => {
    const { ps, enableConsoleLogging, getConsoleMessages } = setup();
    await enableConsoleLogging(0);

    ps.injectEvent({
      method: 'Runtime.consoleAPICalled',
      params: {
        type: 'log',
        args: [{ type: 'object' }]
      }
    });

    const msgs = await getConsoleMessages(0);
    assert.equal(msgs[0].text, '[Object]');
  });

  it('getConsoleMessages returns [] for tab with no messages', async () => {
    const { getConsoleMessages } = setup();
    assert.deepEqual(await getConsoleMessages(0), []);
  });

  it('getConsoleMessages with sinceTime filters older messages', async () => {
    const state = { consoleMessages: new Map() };
    const ps2 = makePageSessionFake({}, { sessionId: 'S-time' });
    const getPageSession2 = async () => ps2;
    const { enableConsoleLogging: enable2, getConsoleMessages: get2 } =
      attachConsoleLogging({ state, getPageSession: getPageSession2 });

    await enable2(0);

    // Seed the buffer with controlled timestamps for deterministic filtering.
    state.consoleMessages.set('S-time', [
      { timestamp: '2026-01-01T00:00:00Z', level: 'log', text: 'old' },
      { timestamp: '2026-01-02T00:00:00Z', level: 'log', text: 'new' }
    ]);

    const since = new Date('2026-01-01T12:00:00Z');
    const msgs = await get2(0, since);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].text, 'new');
  });

  it('clearConsoleMessages resets the buffer', async () => {
    const { ps, state, enableConsoleLogging, clearConsoleMessages } = setup('S-clr');
    await enableConsoleLogging(0);

    ps.injectEvent({
      method: 'Runtime.consoleAPICalled',
      params: { type: 'log', args: [{ type: 'string', value: 'msg' }] }
    });

    assert.equal(state.consoleMessages.get('S-clr').length, 1);
    await clearConsoleMessages(0);
    assert.deepEqual(state.consoleMessages.get('S-clr'), []);
  });

  it('non-Runtime.consoleAPICalled events are ignored', async () => {
    const { ps, enableConsoleLogging, getConsoleMessages } = setup();
    await enableConsoleLogging(0);

    ps.injectEvent({ method: 'Page.loadEventFired', params: {} });
    ps.injectEvent({ method: 'Runtime.executionContextCreated', params: {} });

    const msgs = await getConsoleMessages(0);
    assert.deepEqual(msgs, []);
  });
});
