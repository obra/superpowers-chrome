import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeBrowserSessionFake } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachBrowserBridge } = require('../../skills/browsing/lib/browser-bridge.js');

function setup() {
  const browser = makeBrowserSessionFake();
  browser.setResolver('Target.setDiscoverTargets', () => ({}));
  return { browser };
}

describe('browser-bridge: targets tracking', () => {
  it('subscribes via Target.setDiscoverTargets on attach', async () => {
    const { browser } = setup();
    await attachBrowserBridge({
      browser, host: 'localhost', port: 9222, rewriteWsUrl: (u) => u,
    });
    assert.ok(browser.sendCalls.some(c => c.method === 'Target.setDiscoverTargets'));
  });

  it('tracks created targets and fires onCreated listeners', async () => {
    const { browser } = setup();
    const bridge = await attachBrowserBridge({
      browser, host: 'localhost', port: 9222, rewriteWsUrl: (u) => u,
    });
    const seen = [];
    bridge.targets.onCreated((t) => seen.push(t));
    browser.inject({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'T1', type: 'page' } } });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].targetId, 'T1');
    assert.deepEqual(bridge.targets.list().map(t => t.targetId), ['T1']);
  });

  it('drops destroyed targets and fires onDestroyed listeners', async () => {
    const { browser } = setup();
    const bridge = await attachBrowserBridge({
      browser, host: 'localhost', port: 9222, rewriteWsUrl: (u) => u,
    });
    const destroyed = [];
    bridge.targets.onDestroyed((t) => destroyed.push(t));
    browser.inject({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'T1', type: 'page' } } });
    browser.inject({ method: 'Target.targetDestroyed', params: { targetId: 'T1' } });
    assert.equal(destroyed.length, 1);
    assert.equal(destroyed[0].targetId, 'T1');
    assert.equal(bridge.targets.list().length, 0);
  });
});

describe('browser-bridge: BrowserContext', () => {
  it('createBrowserContext + createPage round-trip', async () => {
    const { browser } = setup();
    browser.setResolver('Target.createBrowserContext', () => ({ browserContextId: 'BC1' }));
    browser.setResolver('Target.createTarget', () => ({ targetId: 'T-new' }));
    browser.setResolver('Target.disposeBrowserContext', () => ({}));
    const bridge = await attachBrowserBridge({
      browser, host: 'localhost', port: 9222, rewriteWsUrl: (u) => u,
    });
    const ctx = await bridge.createBrowserContext();
    assert.equal(ctx.browserContextId, 'BC1');
    const page = await ctx.createPage('https://example.com');
    assert.equal(page.targetId, 'T-new');
    assert.match(page.webSocketDebuggerUrl, /\/devtools\/page\/T-new$/);
    await ctx.dispose();
    assert.ok(browser.sendCalls.some(c => c.method === 'Target.disposeBrowserContext'));
  });
});
