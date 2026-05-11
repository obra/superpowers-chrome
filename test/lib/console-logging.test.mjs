import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { makePageSessionSpy, makeGetPageSession } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachConsoleLogging } = require('../../skills/browsing/lib/console-logging.js');

describe('console-logging', () => {
  function setup() {
    const state = { consoleMessages: new Map() };
    const ps = makePageSessionSpy();
    return {
      ...attachConsoleLogging({ state, getPageSession: makeGetPageSession(ps) }),
      state,
      ps,
    };
  }

  it('getConsoleMessages returns [] for unknown tab', async () => {
    const { getConsoleMessages } = setup();
    assert.deepEqual(await getConsoleMessages(0), []);
  });

  it('getConsoleMessages returns the buffered messages', async () => {
    const { getConsoleMessages, state, ps } = setup();
    state.consoleMessages.set(ps.sessionId, [
      { timestamp: '2026-01-01T00:00:00Z', level: 'log', text: 'hi' },
    ]);
    const msgs = await getConsoleMessages(0);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].text, 'hi');
  });

  it('getConsoleMessages with sinceTime filters older messages', async () => {
    const { getConsoleMessages, state, ps } = setup();
    state.consoleMessages.set(ps.sessionId, [
      { timestamp: '2026-01-01T00:00:00Z', level: 'log', text: 'old' },
      { timestamp: '2026-01-02T00:00:00Z', level: 'log', text: 'new' },
    ]);
    const since = new Date('2026-01-01T12:00:00Z');
    const msgs = await getConsoleMessages(0, since);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].text, 'new');
  });

  it('clearConsoleMessages empties the buffer for that tab', async () => {
    const { clearConsoleMessages, state, ps } = setup();
    state.consoleMessages.set(ps.sessionId, [{ text: 'a' }]);
    await clearConsoleMessages(0);
    assert.deepEqual(state.consoleMessages.get(ps.sessionId), []);
  });

  it('enableConsoleLogging captures Runtime.consoleAPICalled events into state', async () => {
    const { enableConsoleLogging, state, ps } = setup();
    await enableConsoleLogging(0);

    // Simulate Chrome emitting a console event.
    ps.deliver({
      method: 'Runtime.consoleAPICalled',
      params: {
        type: 'log',
        args: [{ type: 'string', value: 'hello' }],
      },
    });

    const msgs = state.consoleMessages.get(ps.sessionId);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].text, 'hello');
    assert.equal(msgs[0].level, 'log');
  });

  it('enableConsoleLogging returns a close fn that stops capturing', async () => {
    const { enableConsoleLogging, state, ps } = setup();
    const handle = await enableConsoleLogging(0);
    handle.close();
    ps.deliver({
      method: 'Runtime.consoleAPICalled',
      params: { type: 'log', args: [{ type: 'string', value: 'shouldnt-appear' }] },
    });
    const msgs = state.consoleMessages.get(ps.sessionId) || [];
    assert.equal(msgs.length, 0);
  });
});
