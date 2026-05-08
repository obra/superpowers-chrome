import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { attachBrowserBridge } = require('../../skills/browsing/lib/browser-bridge.js');

// Mock browser-session that lets the test drive inbound CDP messages.
function makeMockBrowser({ contextId = 'CTX1', attachSessionId = 'SID1' } = {}) {
  let handler = null;
  const sentCommands = [];
  return {
    onEvent(fn) { handler = fn; return () => { handler = null; }; },
    deliver(msg) { if (handler) handler(msg); },
    sentCommands,
    async send(method, params) {
      sentCommands.push({ method, params });
      if (method === 'Target.setDiscoverTargets') return {};
      if (method === 'Target.createBrowserContext') return { browserContextId: contextId };
      if (method === 'Target.disposeBrowserContext') return {};
      if (method === 'Target.createTarget') return { targetId: 'new-target' };
      if (method === 'Target.attachToTarget') return { sessionId: attachSessionId };
      return {};
    },
    sendRaw() {},
  };
}

const idRewriteWsUrl = (u) => u;

describe('browser-bridge', () => {
  it('subscribes to Target.setDiscoverTargets on attach', async () => {
    const browser = makeMockBrowser();
    await attachBrowserBridge({ browser, host: 'localhost', port: 9222, rewriteWsUrl: idRewriteWsUrl });
    const sub = browser.sentCommands.find((c) => c.method === 'Target.setDiscoverTargets');
    assert.ok(sub);
    assert.equal(sub.params.discover, true);
  });

  it('targets.list reflects targetCreated / targetDestroyed events', async () => {
    const browser = makeMockBrowser();
    const bridge = await attachBrowserBridge({ browser, host: 'localhost', port: 9222, rewriteWsUrl: idRewriteWsUrl });

    browser.deliver({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'A', type: 'page', url: 'about:blank' } } });
    browser.deliver({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'B', type: 'page', url: 'about:blank' } } });

    let list = bridge.targets.list();
    assert.equal(list.length, 2);

    browser.deliver({ method: 'Target.targetDestroyed', params: { targetId: 'A' } });

    list = bridge.targets.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].targetId, 'B');
  });

  it('targets.onCreated fires for new targets and unsub stops it', async () => {
    const browser = makeMockBrowser();
    const bridge = await attachBrowserBridge({ browser, host: 'localhost', port: 9222, rewriteWsUrl: idRewriteWsUrl });

    const seen = [];
    const unsub = bridge.targets.onCreated((t) => seen.push(t.targetId));

    browser.deliver({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'A', type: 'page' } } });
    assert.deepEqual(seen, ['A']);

    unsub();
    browser.deliver({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'B', type: 'page' } } });
    assert.deepEqual(seen, ['A']);
  });

  it('targets.onDestroyed fires only after a matching create', async () => {
    const browser = makeMockBrowser();
    const bridge = await attachBrowserBridge({ browser, host: 'localhost', port: 9222, rewriteWsUrl: idRewriteWsUrl });

    const seen = [];
    bridge.targets.onDestroyed((t) => seen.push(t.targetId));

    browser.deliver({ method: 'Target.targetDestroyed', params: { targetId: 'never-seen' } });
    assert.deepEqual(seen, []); // unknown — bridge has no info to deliver

    browser.deliver({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'A', type: 'page' } } });
    browser.deliver({ method: 'Target.targetDestroyed', params: { targetId: 'A' } });
    assert.deepEqual(seen, ['A']);
  });

  it('targets.waitForNew resolves on first matching predicate', async () => {
    const browser = makeMockBrowser();
    const bridge = await attachBrowserBridge({ browser, host: 'localhost', port: 9222, rewriteWsUrl: idRewriteWsUrl });

    const p = bridge.targets.waitForNew((t) => t.openerId === 'parent', { timeoutMs: 5000 });

    browser.deliver({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'irrelevant', type: 'page' } } });
    browser.deliver({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'popup', type: 'page', openerId: 'parent' } } });

    const t = await p;
    assert.equal(t.targetId, 'popup');
  });

  it('targets.waitForNew rejects on timeout', async () => {
    const browser = makeMockBrowser();
    const bridge = await attachBrowserBridge({ browser, host: 'localhost', port: 9222, rewriteWsUrl: idRewriteWsUrl });
    await assert.rejects(() => bridge.targets.waitForNew(() => false, { timeoutMs: 25 }), /timed out/i);
  });

  it('createBrowserContext returns {browserContextId, createPage, dispose}', async () => {
    const browser = makeMockBrowser({ contextId: 'CTX-7' });
    const bridge = await attachBrowserBridge({ browser, host: 'localhost', port: 9222, rewriteWsUrl: idRewriteWsUrl });

    const ctx = await bridge.createBrowserContext();
    assert.equal(ctx.browserContextId, 'CTX-7');
    assert.equal(typeof ctx.createPage, 'function');
    assert.equal(typeof ctx.dispose, 'function');
  });

  it('createBrowserContext.createPage builds a tab handle with correct WS URL', async () => {
    const browser = makeMockBrowser({ contextId: 'CTX-7' });
    const bridge = await attachBrowserBridge({ browser, host: 'localhost', port: 9222, rewriteWsUrl: idRewriteWsUrl });

    const ctx = await bridge.createBrowserContext();
    const tab = await ctx.createPage('https://example.com');

    assert.equal(tab.targetId, 'new-target');
    assert.equal(tab.id, 'new-target');
    assert.equal(tab.type, 'page');
    assert.equal(tab.browserContextId, 'CTX-7');
    assert.equal(tab.webSocketDebuggerUrl, 'ws://localhost:9222/devtools/page/new-target');
  });

  it('createBrowserContext.dispose calls Target.disposeBrowserContext exactly once', async () => {
    const browser = makeMockBrowser({ contextId: 'CTX-7' });
    const bridge = await attachBrowserBridge({ browser, host: 'localhost', port: 9222, rewriteWsUrl: idRewriteWsUrl });

    const ctx = await bridge.createBrowserContext();
    await ctx.dispose();
    await ctx.dispose(); // idempotent

    const disposes = browser.sentCommands.filter((c) => c.method === 'Target.disposeBrowserContext');
    assert.equal(disposes.length, 1);
    assert.equal(disposes[0].params.browserContextId, 'CTX-7');
  });

  it('createPage after dispose throws', async () => {
    const browser = makeMockBrowser();
    const bridge = await attachBrowserBridge({ browser, host: 'localhost', port: 9222, rewriteWsUrl: idRewriteWsUrl });

    const ctx = await bridge.createBrowserContext();
    await ctx.dispose();
    await assert.rejects(() => ctx.createPage(), /disposed/i);
  });
});
