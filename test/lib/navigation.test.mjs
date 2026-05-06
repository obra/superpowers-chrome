import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { makeCdpSpy, makeResolveWsUrl } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachNavigation } = require('../../skills/browsing/lib/navigation.js');

describe('navigation', () => {
  function setup(handlers = {}) {
    const state = { consoleMessages: new Map() };
    const sendCdpCommand = makeCdpSpy(handlers);
    const capturePageArtifacts = async () => ({});
    const evaluate = async (_tab, expression) => {
      const r = await sendCdpCommand('ws://x', 'Runtime.evaluate', { expression, awaitPromise: true });
      if (r.exceptionDetails) {
        throw new Error(`evaluate failed: ${r.exceptionDetails.exception.description}`);
      }
      return r.result.value;
    };
    return {
      ...attachNavigation({ state, resolveWsUrl: makeResolveWsUrl(), sendCdpCommand, capturePageArtifacts, evaluate }),
      sendCdpCommand,
      state
    };
  }

  it('waitForElement passes awaitPromise: true', async () => {
    const { waitForElement, sendCdpCommand } = setup({
      'Runtime.evaluate': () => ({ result: { value: true } })
    });
    await waitForElement(0, '#ready');
    assert.equal(sendCdpCommand.calls[0].params.awaitPromise, true);
    assert.match(sendCdpCommand.calls[0].params.expression, /new Promise/);
  });

  it('waitForText injects the search text into the page-side check', async () => {
    const { waitForText, sendCdpCommand } = setup({
      'Runtime.evaluate': () => ({ result: { value: true } })
    });
    await waitForText(0, 'Hello, world');
    assert.match(sendCdpCommand.calls[0].params.expression, /Hello, world/);
  });

  it('waitForElement rejects when the page-side timeout fires', async () => {
    const sendCdpCommand = makeCdpSpy({
      'Runtime.evaluate': () => ({
        result: { type: 'undefined' },
        exceptionDetails: {
          text: 'Uncaught (in promise)',
          exception: { description: 'Error: Timeout' }
        }
      })
    });
    const evaluate = async (_tab, expression) => {
      const r = await sendCdpCommand('ws://x', 'Runtime.evaluate', { expression, awaitPromise: true });
      if (r.exceptionDetails) {
        throw new Error(`evaluate failed: ${r.exceptionDetails.exception.description}`);
      }
      return r.result.value;
    };
    const { waitForElement } = attachNavigation({
      state: { consoleMessages: new Map() },
      resolveWsUrl: makeResolveWsUrl(),
      sendCdpCommand,
      capturePageArtifacts: async () => ({}),
      evaluate
    });
    await assert.rejects(() => waitForElement(0, '#never', 100), /Timeout/);
  });

  it('waitForText rejects when the page-side timeout fires', async () => {
    const sendCdpCommand = makeCdpSpy({
      'Runtime.evaluate': () => ({
        result: { type: 'undefined' },
        exceptionDetails: {
          text: 'Uncaught (in promise)',
          exception: { description: 'Error: Timeout' }
        }
      })
    });
    const evaluate = async (_tab, expression) => {
      const r = await sendCdpCommand('ws://x', 'Runtime.evaluate', { expression, awaitPromise: true });
      if (r.exceptionDetails) {
        throw new Error(`evaluate failed: ${r.exceptionDetails.exception.description}`);
      }
      return r.result.value;
    };
    const { waitForText } = attachNavigation({
      state: { consoleMessages: new Map() },
      resolveWsUrl: makeResolveWsUrl(),
      sendCdpCommand,
      capturePageArtifacts: async () => ({}),
      evaluate
    });
    await assert.rejects(() => waitForText(0, 'never appears', 100), /Timeout/);
  });

  // navigate() and spaNavigate/hrefNavigate (now removed in Section 4) are
  // covered by the Tier C real-Chrome smoke test.
});
