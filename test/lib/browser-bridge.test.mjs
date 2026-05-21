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

describe('browser-bridge: autoAttach', () => {
  it('calls Target.setAutoAttach with waitForDebuggerOnStart:true and flatten:true when autoAttach option is true', async () => {
    const { browser } = setup();
    browser.setResolver('Target.setAutoAttach', () => ({}));
    await attachBrowserBridge({
      browser, host: 'localhost', port: 9222, rewriteWsUrl: (u) => u,
      autoAttach: true,
    });
    const aa = browser.sendCalls.find(c => c.method === 'Target.setAutoAttach');
    assert.ok(aa, 'Target.setAutoAttach was called');
    assert.deepEqual(aa.params, {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
  });

  it('does NOT call Target.setAutoAttach when autoAttach option is false (default)', async () => {
    const { browser } = setup();
    await attachBrowserBridge({
      browser, host: 'localhost', port: 9222, rewriteWsUrl: (u) => u,
    });
    assert.ok(!browser.sendCalls.some(c => c.method === 'Target.setAutoAttach'));
  });
});

describe('browser-bridge: Target.attachedToTarget handling', () => {
  it('on attachedToTarget with autoAttach, registers session, runs onPageSession hook, then resumes via Runtime.runIfWaitingForDebugger', async () => {
    const { browser } = setup();
    browser.setResolver('Target.setAutoAttach', () => ({}));
    const hookCalls = [];

    await attachBrowserBridge({
      browser, host: 'localhost', port: 9222, rewriteWsUrl: (u) => u,
      autoAttach: true,
      onPageSession: async (ps) => {
        hookCalls.push({ sessionId: ps.sessionId, targetId: ps.targetId });
      },
    });

    // Clear send-call log so we can observe ordering after the attach event
    browser.sendCalls.length = 0;
    browser.sentRaw.length = 0;

    // Auto-respond to Runtime.runIfWaitingForDebugger so the send promise resolves
    // cleanly and doesn't leak a 30-second timeout into the test runner output.
    const origSendRaw = browser.sendRaw.bind(browser);
    browser.sendRaw = (json) => {
      origSendRaw(json);
      const parsed = JSON.parse(json);
      if (parsed.method === 'Runtime.runIfWaitingForDebugger') {
        setImmediate(() => browser.inject({ sessionId: parsed.sessionId, id: parsed.id, result: {} }));
      }
    };

    // Inject the auto-attach event
    browser.inject({
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'S-popup',
        targetInfo: { targetId: 'T-popup', type: 'page' },
        waitingForDebugger: true,
      },
    });

    // Drain microtasks so the async handler completes
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(hookCalls.length, 1);
    assert.equal(hookCalls[0].sessionId, 'S-popup');
    assert.equal(hookCalls[0].targetId, 'T-popup');

    // Runtime.runIfWaitingForDebugger should have been sent via sendRaw (sessionId-enveloped)
    const runMsg = browser.sentRaw.map(JSON.parse).find(m => m.method === 'Runtime.runIfWaitingForDebugger');
    assert.ok(runMsg, 'Runtime.runIfWaitingForDebugger was sent');
    assert.equal(runMsg.sessionId, 'S-popup');
  });

  it('does NOT call Runtime.runIfWaitingForDebugger when waitingForDebugger is false', async () => {
    const { browser } = setup();
    browser.setResolver('Target.setAutoAttach', () => ({}));
    await attachBrowserBridge({
      browser, host: 'localhost', port: 9222, rewriteWsUrl: (u) => u,
      autoAttach: true,
      onPageSession: async () => {},
    });
    browser.sendCalls.length = 0;
    browser.sentRaw.length = 0;
    browser.inject({
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'S-2',
        targetInfo: { targetId: 'T-2', type: 'page' },
        waitingForDebugger: false,
      },
    });
    await new Promise((r) => setImmediate(r));
    const runMsg = browser.sentRaw.map(JSON.parse).find(m => m.method === 'Runtime.runIfWaitingForDebugger');
    assert.ok(!runMsg, 'no runIfWaitingForDebugger should be sent');
  });

  it('continues to handle Target.targetCreated events normally even when autoAttach is on', async () => {
    const { browser } = setup();
    browser.setResolver('Target.setAutoAttach', () => ({}));
    const bridge = await attachBrowserBridge({
      browser, host: 'localhost', port: 9222, rewriteWsUrl: (u) => u,
      autoAttach: true,
      onPageSession: async () => {},
    });
    const seen = [];
    bridge.targets.onCreated((t) => seen.push(t));
    browser.inject({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'T3', type: 'page' } } });
    assert.equal(seen.length, 1);
  });
});
