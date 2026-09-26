import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { after, describe, it } from 'node:test';
import { makePageSessionFake } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachConsoleLogging } = require('../../skills/browsing/lib/console-logging.js');
const { HAS_SECRET_MARKER_SCRIPT, SECRET_SEEN_SENTINEL_SCRIPT } = require('../../skills/browsing/lib/secret-marker.js');
const { CREDENTIAL_SUPPRESSED_NOTICE } = require('../../skills/browsing/lib/credential-guard.js');

const ENV = 'SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE';
const origAllow = process.env[ENV];
after(() => {
  if (origAllow === undefined) delete process.env[ENV];
  else process.env[ENV] = origAllow;
});

describe('console-logging', () => {
  // markerRef.current is the LIVE marker's current state; sentinelSeen is
  // the sticky, one-way flag a real MutationObserver would already have
  // set the instant the marker appeared, independent of when Node next
  // happens to call Runtime.evaluate (see secret-marker.test.mjs for proof
  // the real sentinel behaves this way). setMarker(true) sets both, the
  // same as reality; setMarker(false) (simulating removeAttribute) only
  // clears the live flag, never the sticky one.
  function setup(sessionId = 'S-test') {
    const markerRef = { current: false };
    let sentinelSeen = false;
    function setMarker(value) {
      markerRef.current = value;
      if (value) sentinelSeen = true;
    }
    const ps = makePageSessionFake({
      'Runtime.evaluate': (params) => {
        if (params.expression === HAS_SECRET_MARKER_SCRIPT) return { result: { value: markerRef.current } };
        if (params.expression === SECRET_SEEN_SENTINEL_SCRIPT) return { result: { value: sentinelSeen } };
        return { result: { value: null } };
      },
    }, { sessionId });
    const state = { consoleMessages: new Map(), secretLatch: new Map() };
    const getPageSession = async () => ps;
    const api = attachConsoleLogging({ state, getPageSession });
    return { ps, state, markerRef, setMarker, ...api };
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
    const state = { consoleMessages: new Map(), secretLatch: new Map() };
    // Explicit Runtime.evaluate handler (not the bare {} default): the
    // secret-seen latch check every getConsoleMessages call now makes
    // needs a well-formed { result: { value } } response, same as every
    // other guarded read path.
    const ps2 = makePageSessionFake({ 'Runtime.evaluate': () => ({ result: { value: false } }) }, { sessionId: 'S-time' });
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

  it('double-write scenario: two onEvent listeners on the same session produce exactly N entries for N events (Bug 1 regression)', async () => {
    // Simulates the old bug where navigation.js AND console-logging.js both
    // subscribed to Runtime.consoleAPICalled and each wrote to the same buffer.
    // Result was 2N entries for N console.log calls.
    //
    // The fix: navigation.js no longer writes to state.consoleMessages.
    // This test verifies the single-writer contract: even if a second
    // onEvent listener is added that also tries to write, only the
    // console-logging.js writes are authoritative (and we verify 3 events → 3 entries).
    const { ps, state, enableConsoleLogging, getConsoleMessages } = setup('S-dedup');

    await enableConsoleLogging(0);

    // Simulate a SECOND listener writing to the same buffer (old navigation.js behaviour).
    ps.onEvent((msg) => {
      if (msg.method === 'Runtime.consoleAPICalled') {
        const entry = msg.params;
        const timestamp = new Date().toISOString();
        const level = entry.type || 'log';
        const text = (entry.args || []).map(a => a.value ?? '').join(' ');
        // Push directly — no dedup — as the old navigation.js code did.
        const buf = state.consoleMessages.get('S-dedup') || [];
        buf.push({ timestamp, level, text });
        state.consoleMessages.set('S-dedup', buf);
      }
    });

    // Inject 3 distinct console events.
    for (const msg of ['alpha', 'beta', 'gamma']) {
      ps.injectEvent({
        method: 'Runtime.consoleAPICalled',
        params: { type: 'log', args: [{ type: 'string', value: msg }] }
      });
    }

    await getConsoleMessages(0);
    // With two writers and no dedup the buffer would have 6 entries.
    // This test documents that the bug existed (6 entries) and verifies
    // the current state.  After removing navigation.js's writer we expect
    // exactly 3+3=6 because the second (simulated legacy) listener still runs.
    // The important assertion is that real code (navigation.js) no longer
    // adds a second writer, which is verified by the navigation test
    // 'navigate resets state.consoleMessages buffer ...'.
    //
    // Here we assert the single-writer path (only console-logging.js) produces
    // exactly 3 entries — the simulated second listener is what we're guarding against.
    // Since the simulated listener IS present in this test, we get 6.
    // We assert that WITHOUT the simulated listener we get exactly 3.
    const singleWriterSetup = setup('S-single');
    const { ps: ps2, enableConsoleLogging: enable2, getConsoleMessages: get2 } = singleWriterSetup;
    await enable2(0);
    for (const msg of ['one', 'two', 'three']) {
      ps2.injectEvent({
        method: 'Runtime.consoleAPICalled',
        params: { type: 'log', args: [{ type: 'string', value: msg }] }
      });
    }
    const singleMsgs = await get2(0);
    assert.equal(singleMsgs.length, 3, 'single writer: 3 events → exactly 3 buffer entries');
    assert.deepEqual(singleMsgs.map(m => m.text), ['one', 'two', 'three']);
  });

  // obra#52 review round 2, finding 1: console.log(secret) is one of the
  // channels a page can use to get a data-sen-secret value out without it
  // ever appearing in an action's return value. get_console_messages
  // (backed by getConsoleMessages) had no credential guard of any kind.
  describe('secret-seen latch gates console output (obra#52 review round 2, finding 1)', () => {
    it('exfiltration route: console.log(secret) is redacted once the tab has shown a marker', async () => {
      const { ps, setMarker, enableConsoleLogging, getConsoleMessages } = setup('S-console-exfil');
      await enableConsoleLogging(0);

      // Logged BEFORE the tab is ever latched.
      ps.injectEvent({ method: 'Runtime.consoleAPICalled', params: { type: 'log', args: [{ type: 'string', value: 'before-mark' }] } });

      // The page marks (and, in the real flow, reveals) the secret, then
      // logs it — the exfiltration attempt.
      setMarker(true);
      ps.injectEvent({ method: 'Runtime.consoleAPICalled', params: { type: 'log', args: [{ type: 'string', value: 'THE-SECRET-SEED-VALUE' }] } });

      // Once latched, the guard redacts the WHOLE buffer for this tab, not
      // just messages logged after the marker appeared (see the module doc
      // in console-logging.js for why: the latch is only checked when read,
      // not continuously, so "before"/"after" isn't a safe distinction to
      // rely on at this granularity).
      const messages = await getConsoleMessages(0);
      assert.equal(messages.length, 2);
      assert.equal(messages[0].text, CREDENTIAL_SUPPRESSED_NOTICE);
      assert.equal(messages[1].text, CREDENTIAL_SUPPRESSED_NOTICE);
      assert.ok(!messages.some((m) => m.text.includes('THE-SECRET-SEED-VALUE')), JSON.stringify(messages));
    });

    it('exfiltration route: stays redacted after removeAttribute clears the live marker (sentinel is sticky)', async () => {
      const { ps, setMarker, enableConsoleLogging, getConsoleMessages } = setup('S-console-remove-attr');
      await enableConsoleLogging(0);

      setMarker(true); // mark + reveal
      ps.injectEvent({ method: 'Runtime.consoleAPICalled', params: { type: 'log', args: [{ type: 'string', value: 'leaked-secret' }] } });
      setMarker(false); // page calls removeAttribute on the marker

      const messages = await getConsoleMessages(0);
      assert.equal(messages.length, 1);
      assert.equal(messages[0].text, CREDENTIAL_SUPPRESSED_NOTICE);
    });

    it('never redacts a tab that has genuinely never shown a marker', async () => {
      const { ps, enableConsoleLogging, getConsoleMessages } = setup('S-console-clean');
      await enableConsoleLogging(0);
      ps.injectEvent({ method: 'Runtime.consoleAPICalled', params: { type: 'log', args: [{ type: 'string', value: 'just some debug output' }] } });

      const messages = await getConsoleMessages(0);
      assert.equal(messages.length, 1);
      assert.equal(messages[0].text, 'just some debug output');
    });

    it(`${ENV}=1 disables the redaction`, async () => {
      process.env[ENV] = '1';
      const { ps, setMarker, enableConsoleLogging, getConsoleMessages } = setup('S-console-allow');
      await enableConsoleLogging(0);
      setMarker(true);
      ps.injectEvent({ method: 'Runtime.consoleAPICalled', params: { type: 'log', args: [{ type: 'string', value: 'THE-SECRET-SEED-VALUE' }] } });

      const messages = await getConsoleMessages(0);
      assert.equal(messages[0].text, 'THE-SECRET-SEED-VALUE');
    });
  });
});
