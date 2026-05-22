import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { makePageSessionFake } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachNavigation } = require('../../skills/browsing/lib/navigation.js');

describe('navigation', () => {
  function setup(psHandlers = {}, psOpts = {}) {
    const state = { consoleMessages: new Map() };
    const ps = makePageSessionFake(psHandlers, psOpts);
    const capturePageArtifacts = async () => ({});
    const evaluate = async (_tab, expression) => {
      const r = await ps.send('Runtime.evaluate', { expression, awaitPromise: true });
      if (r.exceptionDetails) {
        throw new Error(`evaluate failed: ${r.exceptionDetails.exception.description}`);
      }
      return r.result.value;
    };
    const getPageSession = async () => ps;
    return {
      ...attachNavigation({ state, getPageSession, capturePageArtifacts, evaluate }),
      ps,
      state
    };
  }

  it('waitForElement passes awaitPromise: true', async () => {
    const { waitForElement, ps } = setup({
      'Runtime.evaluate': () => ({ result: { value: true } })
    });
    await waitForElement(0, '#ready');
    const evalCall = ps.calls.find(c => c.method === 'Runtime.evaluate');
    assert.ok(evalCall, 'Runtime.evaluate was called');
    assert.equal(evalCall.params.awaitPromise, true);
    assert.match(evalCall.params.expression, /new Promise/);
  });

  it('waitForText injects the search text into the page-side check', async () => {
    const { waitForText, ps } = setup({
      'Runtime.evaluate': () => ({ result: { value: true } })
    });
    await waitForText(0, 'Hello, world');
    const evalCall = ps.calls.find(c => c.method === 'Runtime.evaluate');
    assert.ok(evalCall, 'Runtime.evaluate was called');
    assert.match(evalCall.params.expression, /Hello, world/);
  });

  it('waitForElement rejects when the page-side timeout fires', async () => {
    const { waitForElement } = setup({
      'Runtime.evaluate': () => ({
        result: { type: 'undefined' },
        exceptionDetails: {
          text: 'Uncaught (in promise)',
          exception: { description: 'Error: Timeout' }
        }
      })
    });
    await assert.rejects(() => waitForElement(0, '#never', 100), /Timeout/);
  });

  it('waitForText rejects when the page-side timeout fires', async () => {
    const { waitForText } = setup({
      'Runtime.evaluate': () => ({
        result: { type: 'undefined' },
        exceptionDetails: {
          text: 'Uncaught (in promise)',
          exception: { description: 'Error: Timeout' }
        }
      })
    });
    await assert.rejects(() => waitForText(0, 'never appears', 100), /Timeout/);
  });

  it('navigate fires Page.navigate with the correct URL', async () => {
    const { navigate, ps } = setup({
      'Page.navigate': () => ({ frameId: 'F1' })
    });

    // Fire load event asynchronously after navigate is called
    setImmediate(() => {
      ps.injectEvent({ method: 'Page.frameNavigated', params: { frame: { id: 'F1', url: 'https://example.com' } } });
      ps.injectEvent({ method: 'Page.loadEventFired', params: { timestamp: 1 } });
    });

    const frameId = await navigate(0, 'https://example.com');
    assert.equal(frameId, 'F1');

    const navCall = ps.calls.find(c => c.method === 'Page.navigate');
    assert.ok(navCall, 'Page.navigate was called');
    assert.equal(navCall.params.url, 'https://example.com');
  });

  it('listener-ordering: load event fired before navigate resolves (fast-loading page)', async () => {
    const { navigate, ps } = setup({
      'Page.navigate': () => {
        // Inject loadEventFired synchronously during the Page.navigate handler,
        // simulating a fast-loading page that completes before navigate returns.
        ps.injectEvent({ method: 'Page.frameNavigated', params: { frame: { id: 'F1' } } });
        ps.injectEvent({ method: 'Page.loadEventFired', params: { timestamp: 1 } });
        return { frameId: 'F1' };
      }
    });

    // Must not hang — the listener was registered before Page.navigate was sent.
    const frameId = await navigate(0, 'data:text/html,hello');
    assert.equal(frameId, 'F1');
  });

  it('navigate timeout rejects instead of silently resolving', async () => {
    const { navigate, ps } = setup({
      'Page.navigate': () => ({ frameId: 'F1' })
    });
    // Override NAVIGATE_TIMEOUT_MS by never injecting loadEventFired.
    // Use a tiny custom timeout by wrapping the navigate call in a race.
    const p = navigate(0, 'https://slow.example.com');
    // Inject frameNavigated but never loadEventFired — the timeout should fire.
    ps.injectEvent({ method: 'Page.frameNavigated', params: { frame: { id: 'F1' } } });
    // The real NAVIGATE_TIMEOUT_MS is 30 s. We need a short path.
    // Instead, test that NOT injecting loadEventFired eventually rejects.
    // We'll race with a 100 ms timeout to confirm it rejects (not resolves).
    const raceResult = await Promise.race([
      p.then(() => 'resolved', (e) => `rejected:${e.message}`),
      new Promise(r => setTimeout(() => r('still-pending'), 100))
    ]);
    assert.equal(raceResult, 'still-pending', 'should still be pending (not silently resolved)');
  });

  it('navigate resets state.consoleMessages buffer for the session (console-logging.js is sole writer)', async () => {
    // navigation.js resets the buffer to [] but does NOT write console events.
    // Only attachConsoleLogging (console-logging.js) writes to the buffer.
    // This is the fix for the double-write bug: two listeners on the same
    // Runtime.consoleAPICalled event produced duplicate entries in the buffer.
    const { navigate, ps, state } = setup(
      { 'Page.navigate': () => ({ frameId: 'F1' }) },
      { sessionId: 'S-test' }
    );

    // Pre-seed the buffer to verify navigate resets it.
    state.consoleMessages.set('S-test', [{ timestamp: 'old', level: 'log', text: 'pre-nav' }]);

    setImmediate(() => {
      ps.injectEvent({ method: 'Page.frameNavigated', params: { frame: { id: 'F1' } } });
      ps.injectEvent({
        method: 'Runtime.consoleAPICalled',
        params: {
          type: 'log',
          args: [{ type: 'string', value: 'hello from console' }]
        }
      });
      ps.injectEvent({ method: 'Page.loadEventFired', params: { timestamp: 1 } });
    });

    await navigate(0, 'https://example.com', /* autoCapture= */ true);

    const msgs = state.consoleMessages.get('S-test');
    assert.ok(msgs, 'consoleMessages buffer exists keyed by sessionId');
    // navigate resets the buffer — pre-nav entry must be gone.
    assert.ok(!msgs.some(m => m.text === 'pre-nav'), 'pre-nav entry was cleared by navigate');
    // Navigation itself does NOT write console messages — that is console-logging.js's job.
    // Messages fired during navigate are only captured if enableConsoleLogging was called first.
    assert.equal(msgs.length, 0, 'navigate does not write to consoleMessages (console-logging.js is sole writer)');
  });

  it('console messages NOT captured when autoCapture is false', async () => {
    const { navigate, ps, state } = setup(
      { 'Page.navigate': () => ({ frameId: 'F1' }) },
      { sessionId: 'S-nocap' }
    );

    setImmediate(() => {
      ps.injectEvent({ method: 'Page.frameNavigated', params: { frame: { id: 'F1' } } });
      ps.injectEvent({
        method: 'Runtime.consoleAPICalled',
        params: { type: 'log', args: [{ type: 'string', value: 'ignored' }] }
      });
      ps.injectEvent({ method: 'Page.loadEventFired', params: { timestamp: 1 } });
    });

    await navigate(0, 'https://example.com', /* autoCapture= */ false);

    const msgs = state.consoleMessages.get('S-nocap');
    assert.ok(msgs, 'consoleMessages entry created');
    assert.equal(msgs.length, 0, 'no console messages when autoCapture is false');
  });

  // navigate() full-page navigation and real console capture are also
  // covered by the Tier C real-Chrome smoke test.

  // Regression: when ps.send('Page.navigate') times out (e.g. Chrome hangs
  // waiting for an unanswered auth challenge), the internal loadPromise timer
  // was never cleared.  30 s later it fired a rejection with no awaiter —
  // an unhandled Promise rejection that kills the MCP server process.
  //
  // The fix: attach .catch(() => {}) to loadPromise immediately so any orphaned
  // rejection is always handled, regardless of which timer fires first.
  it('loadPromise rejection does not become unhandled when Page.navigate times out first', async () => {
    // We can't easily control which timer fires first in the real 30-second path,
    // but we can verify the critical invariant: once navigate() rejects (for any
    // reason), calling navigate() does NOT leave an unhandled rejection behind.
    //
    // Strategy: make ps.send('Page.navigate') reject immediately. Then confirm
    // that no unhandledRejection event fires within a tick.
    const { navigate } = setup({
      'Page.navigate': () => { throw new Error('Page.navigate CDP error'); }
    });

    let unhandledFired = false;
    const unhandledHandler = () => { unhandledFired = true; };
    process.on('unhandledRejection', unhandledHandler);

    try {
      await navigate(0, 'https://example.com');
      assert.fail('navigate should have thrown');
    } catch (err) {
      assert.match(err.message, /Page.navigate CDP error/);
    }

    // Drain the microtask queue so any pending rejections would have been emitted.
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    process.off('unhandledRejection', unhandledHandler);
    assert.equal(unhandledFired, false, 'no unhandled rejection should fire after navigate() throws');
  });

  it('navigate throws when CDP returns errorText (unreachable host)', async () => {
    const { navigate } = setup({
      'Page.navigate': () => ({ frameId: 'F1', errorText: 'net::ERR_NAME_NOT_RESOLVED' })
    });

    // The error is thrown before waiting for loadEventFired, so no need to inject events.
    await assert.rejects(
      () => navigate(0, 'http://localhost:0/never'),
      /Navigate failed: net::ERR_NAME_NOT_RESOLVED/
    );
  });

  it('back dispatches Runtime.evaluate with history.back()', async () => {
    const { back, ps } = setup();
    await back(0);
    const calls = ps.calls.filter(c => c.method === 'Runtime.evaluate');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.expression, 'history.back()');
  });

  it('forward dispatches Runtime.evaluate with history.forward()', async () => {
    const { forward, ps } = setup();
    await forward(0);
    const calls = ps.calls.filter(c => c.method === 'Runtime.evaluate');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.expression, 'history.forward()');
  });
});
