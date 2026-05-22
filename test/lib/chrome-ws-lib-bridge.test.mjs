import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSession } = require('../../skills/browsing/chrome-ws-lib.js');

// Minimal fakes for a fully self-contained test (no real Chrome required)
function makeFakeChromeHttp() {
  return async (path) => {
    if (path === '/json/version') return { webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' };
    if (path === '/json/list') return [];
    throw new Error('unexpected: ' + path);
  };
}

function makeFakeWebSocketClient() {
  return function WebSocketClient() {
    const listeners = { message: null, close: null, error: null };
    let connected = false;
    return {
      on(event, fn) { listeners[event] = fn; },
      send(json) {
        const m = JSON.parse(json);
        // Auto-respond to root-session commands with a vacuous result
        if (m.id !== undefined && !m.sessionId) {
          queueMicrotask(() => { if (listeners.message) listeners.message(JSON.stringify({ id: m.id, result: {} })); });
        }
      },
      close() { connected = false; if (listeners.close) listeners.close(); },
      isConnected() { return connected; },
      async connect() { connected = true; },
    };
  };
}

// Extended WS fake that also auto-responds to sessionId-scoped commands.
// Needed so that page-session sends (e.g. Page.enable during attachToPageSession)
// resolve without hanging.
function makeFakeWebSocketClientAllRespond() {
  return function WebSocketClient() {
    const listeners = { message: null, close: null, error: null };
    let connected = false;
    const sent = [];
    return {
      on(event, fn) { listeners[event] = fn; },
      send(json) {
        sent.push(json);
        const m = JSON.parse(json);
        // Auto-respond to any command (root or session-scoped)
        if (m.id !== undefined) {
          const reply = { id: m.id, result: {} };
          if (m.sessionId) reply.sessionId = m.sessionId;
          queueMicrotask(() => { if (listeners.message) listeners.message(JSON.stringify(reply)); });
        }
      },
      // Expose an inject method so tests can simulate server-push events
      inject(raw) { if (listeners.message) listeners.message(raw); },
      close() { connected = false; if (listeners.close) listeners.close(); },
      isConnected() { return connected; },
      async connect() { connected = true; },
      sent,
      get _listeners() { return listeners; },
    };
  };
}

describe('chrome-ws-lib: bridge init', () => {
  it('createSession constructs a browser-session and stores it on state', () => {
    const session = createSession({
      host: '127.0.0.1', port: 9222,
      _testFakes: {
        chromeHttp: makeFakeChromeHttp(),
        WebSocketClient: makeFakeWebSocketClient(),
      },
    });
    assert.ok(session.state.browserSession, 'browser-session attached to state');
    assert.equal(typeof session.state.browserSession.send, 'function');
    assert.equal(typeof session.state.ensureBridge, 'function');
    assert.equal(session.state.browserBridge, null, 'bridge not attached yet (lazy)');
  });

  it('state.ensureBridge() attaches the bridge on first call and memoizes', async () => {
    const session = createSession({
      host: '127.0.0.1', port: 9222,
      _testFakes: {
        chromeHttp: makeFakeChromeHttp(),
        WebSocketClient: makeFakeWebSocketClient(),
      },
    });
    const bridge1 = await session.state.ensureBridge();
    assert.equal(session.state.browserBridge, bridge1);
    assert.equal(typeof bridge1.attachPageSession, 'function');
    // Second call returns the same handle
    const bridge2 = await session.state.ensureBridge();
    assert.equal(bridge1, bridge2);
  });
});

describe('chrome-ws-lib: bridge state reset on Chrome restart', () => {
  it('state.resetBridge() is exposed and clears browserBridge, pageSessionResolver, and re-arms the lazy attach', async () => {
    const session = createSession({
      host: '127.0.0.1', port: 9222,
      _testFakes: {
        chromeHttp: makeFakeChromeHttp(),
        WebSocketClient: makeFakeWebSocketClient(),
      },
    });
    // Boot the bridge
    await session.state.ensureBridge();
    assert.ok(session.state.browserBridge, 'bridge was set');
    assert.ok(session.state.pageSessionResolver, 'resolver was set');

    const sessionBefore = session.state.browserSession;

    // Reset
    session.state.resetBridge();

    assert.equal(session.state.browserBridge, null, 'browserBridge cleared');
    assert.equal(session.state.pageSessionResolver, null, 'pageSessionResolver cleared');
    // browserSession is replaced with a fresh instance (not nulled) so ensureBridge
    // can re-use it without needing to re-create it.
    assert.notEqual(session.state.browserSession, sessionBefore, 'browserSession replaced with fresh instance');
  });

  it('ensureBridge creates a fresh bridge after resetBridge', async () => {
    // The second connect needs a fresh chromeHttp mock that returns a valid version URL
    const session = createSession({
      host: '127.0.0.1', port: 9222,
      _testFakes: {
        chromeHttp: makeFakeChromeHttp(),
        WebSocketClient: makeFakeWebSocketClient(),
      },
    });
    const bridge1 = await session.state.ensureBridge();

    session.state.resetBridge();

    // After reset, ensureBridge should re-create the bridge
    const bridge2 = await session.state.ensureBridge();
    assert.ok(bridge2, 'new bridge was created');
    assert.notEqual(bridge1, bridge2, 'fresh bridge instance after reset');
  });

  it('ensureBridge auto-resets stale bridge when browserSession.isConnected() is false', async () => {
    // Track how many WebSocketClient instances are constructed
    let wsInstances = 0;
    const TrackingWsClient = function WebSocketClient(...args) {
      wsInstances++;
      const inner = makeFakeWebSocketClient()(...args);
      return inner;
    };

    const session = createSession({
      host: '127.0.0.1', port: 9222,
      _testFakes: {
        chromeHttp: makeFakeChromeHttp(),
        WebSocketClient: TrackingWsClient,
      },
    });

    const bridge1 = await session.state.ensureBridge();
    const wsCount1 = wsInstances;

    // Simulate Chrome dying: disconnect the browserSession
    session.state.browserSession.close();
    assert.equal(session.state.browserSession.isConnected(), false, 'session is disconnected');

    // ensureBridge should detect the stale state and re-attach
    const bridge2 = await session.state.ensureBridge();
    assert.ok(bridge2, 'new bridge after stale detection');
    assert.notEqual(bridge1, bridge2, 'fresh bridge instance was created');
    assert.ok(wsInstances > wsCount1, 'a new WebSocket connection was made');
  });
});

describe('chrome-ws-lib: autoAttach wires onPageSession to install dialog shim', () => {
  it('injects Target.attachedToTarget → dialogs.attachToPageSession sends Page.enable etc.', async () => {
    // We need the WS fake to respond to both root-session and page-session commands
    // because attachToPageSession issues Page.enable / Runtime.enable etc. via the page session.
    const WsConstructor = makeFakeWebSocketClientAllRespond();
    let wsInstance = null;
    const CapturingWsClient = function WebSocketClient(...args) {
      wsInstance = new (WsConstructor)(...args);
      return wsInstance;
    };

    const session = createSession({
      host: '127.0.0.1', port: 9222,
      _testFakes: {
        chromeHttp: makeFakeChromeHttp(),
        WebSocketClient: CapturingWsClient,
      },
    });

    // Boot the bridge (sends Target.setDiscoverTargets + Target.setAutoAttach)
    await session.state.ensureBridge();
    assert.ok(wsInstance, 'WS instance was created');

    // Drain any pending microtasks from bridge boot
    await new Promise((r) => setImmediate(r));

    // Snapshot current sent messages so we can observe only the new ones
    const sentBefore = wsInstance.sent.length;

    // Auto-respond to Runtime.runIfWaitingForDebugger so it resolves cleanly
    // (the existing auto-respond logic in CapturingWsClient already handles this
    // because it replies to every command including sessionId-scoped ones).

    // Inject the auto-attach event: Chrome signalling a new popup attached
    wsInstance.inject(JSON.stringify({
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'S-popup',
        targetInfo: { targetId: 'T-popup', type: 'page' },
        waitingForDebugger: true,
      },
    }));

    // Drain microtasks so the async onPageSession handler completes
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Extract only the messages sent after we injected the event
    const newSent = wsInstance.sent.slice(sentBefore).map(JSON.parse);
    const newMethods = newSent.map((m) => m.method).filter(Boolean);

    // dialogs.attachToPageSession calls these on the page session
    assert.ok(newMethods.includes('Page.enable'), `expected Page.enable in ${JSON.stringify(newMethods)}`);
    assert.ok(newMethods.includes('Runtime.enable'), `expected Runtime.enable in ${JSON.stringify(newMethods)}`);
    assert.ok(newMethods.includes('Page.addScriptToEvaluateOnNewDocument'),
      `expected Page.addScriptToEvaluateOnNewDocument in ${JSON.stringify(newMethods)}`);
    assert.ok(newMethods.includes('Runtime.addBinding'),
      `expected Runtime.addBinding in ${JSON.stringify(newMethods)}`);

    // All those sends should carry the popup's sessionId
    const shimSends = newSent.filter((m) => m.method && m.sessionId === 'S-popup');
    assert.ok(shimSends.length > 0, 'dialog shim commands were scoped to S-popup session');

    // Runtime.runIfWaitingForDebugger should also have been sent (resume after shim install)
    assert.ok(newMethods.includes('Runtime.runIfWaitingForDebugger'),
      `expected Runtime.runIfWaitingForDebugger in ${JSON.stringify(newMethods)}`);
  });
});
