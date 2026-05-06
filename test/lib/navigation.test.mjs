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
    return {
      ...attachNavigation({ state, resolveWsUrl: makeResolveWsUrl(), sendCdpCommand, capturePageArtifacts }),
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

  // navigate() and spaNavigate/hrefNavigate (now removed in Section 4) are
  // covered by the Tier C real-Chrome smoke test.
});
