import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { makeResolveWsUrl } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachConsoleLogging } = require('../../skills/browsing/lib/console-logging.js');

describe('console-logging', () => {
  function setup() {
    const state = { consoleMessages: new Map() };
    return { ...attachConsoleLogging({ state, resolveWsUrl: makeResolveWsUrl('ws://test/x') }), state };
  }

  it('getConsoleMessages returns [] for unknown tab', async () => {
    const { getConsoleMessages } = setup();
    assert.deepEqual(await getConsoleMessages(0), []);
  });

  it('getConsoleMessages returns the buffered messages', async () => {
    const { getConsoleMessages, state } = setup();
    state.consoleMessages.set('ws://test/x', [
      { timestamp: '2026-01-01T00:00:00Z', level: 'log', text: 'hi' }
    ]);
    const msgs = await getConsoleMessages(0);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].text, 'hi');
  });

  it('getConsoleMessages with sinceTime filters older messages', async () => {
    const { getConsoleMessages, state } = setup();
    state.consoleMessages.set('ws://test/x', [
      { timestamp: '2026-01-01T00:00:00Z', level: 'log', text: 'old' },
      { timestamp: '2026-01-02T00:00:00Z', level: 'log', text: 'new' }
    ]);
    const since = new Date('2026-01-01T12:00:00Z');
    const msgs = await getConsoleMessages(0, since);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].text, 'new');
  });

  it('clearConsoleMessages empties the buffer for that tab', async () => {
    const { clearConsoleMessages, state } = setup();
    state.consoleMessages.set('ws://test/x', [{ text: 'a' }]);
    await clearConsoleMessages(0);
    assert.deepEqual(state.consoleMessages.get('ws://test/x'), []);
  });
});
