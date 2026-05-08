import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { makePageSessionSpy, makeGetPageSession } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachNavigation } = require('../../skills/browsing/lib/navigation.js');

describe('navigation', () => {
  function setup(handlers = {}) {
    const state = { consoleMessages: new Map() };
    const ps = makePageSessionSpy(handlers);
    const capturePageArtifacts = async () => ({});
    const evaluate = async (_arg, expression) => {
      const r = await ps.send('Runtime.evaluate', { expression, awaitPromise: true });
      if (r.exceptionDetails) {
        throw new Error(`evaluate failed: ${r.exceptionDetails.exception.description}`);
      }
      return r.result.value;
    };
    return {
      ...attachNavigation({ state, getPageSession: makeGetPageSession(ps), capturePageArtifacts, evaluate }),
      ps,
      state,
    };
  }

  it('waitForElement passes awaitPromise: true', async () => {
    const { waitForElement, ps } = setup({
      'Runtime.evaluate': () => ({ result: { value: true } }),
    });
    await waitForElement(0, '#ready');
    assert.equal(ps.calls[0].params.awaitPromise, true);
    assert.match(ps.calls[0].params.expression, /new Promise/);
  });

  it('waitForText injects the search text into the page-side check', async () => {
    const { waitForText, ps } = setup({
      'Runtime.evaluate': () => ({ result: { value: true } }),
    });
    await waitForText(0, 'Hello, world');
    assert.match(ps.calls[0].params.expression, /Hello, world/);
  });

  it('waitForElement rejects when the page-side timeout fires', async () => {
    const { waitForElement } = setup({
      'Runtime.evaluate': () => ({
        result: { type: 'undefined' },
        exceptionDetails: {
          text: 'Uncaught (in promise)',
          exception: { description: 'Error: Timeout' },
        },
      }),
    });
    await assert.rejects(() => waitForElement(0, '#never', 100), /Timeout/);
  });

  it('waitForText rejects when the page-side timeout fires', async () => {
    const { waitForText } = setup({
      'Runtime.evaluate': () => ({
        result: { type: 'undefined' },
        exceptionDetails: {
          text: 'Uncaught (in promise)',
          exception: { description: 'Error: Timeout' },
        },
      }),
    });
    await assert.rejects(() => waitForText(0, 'never appears', 100), /Timeout/);
  });

  // navigate() is covered by the Tier C real-Chrome smoke test — it depends
  // on Page.loadEventFired arriving on the page-session event stream, which
  // requires real CDP plumbing.
});
