import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { attachDialogs } = require('../../skills/browsing/lib/dialogs.js');

function setup() {
  const state = {};
  const api = attachDialogs({ state });
  return { api, state };
}

describe('dialogs state map', () => {
  it('getOpen returns null when no dialog is open', () => {
    const { api } = setup();
    assert.equal(api.getOpen('ws://x'), null);
  });

  it('clear is a no-op when no dialog is open', () => {
    const { api } = setup();
    api.clear('ws://x');
    assert.equal(api.getOpen('ws://x'), null);
  });
});


describe('action classification', () => {
  const { PAGE_TARGET_ACTIONS, BROWSER_TARGET_ACTIONS } = require('../../skills/browsing/lib/dialogs.js');

  it('PAGE_TARGET_ACTIONS contains the expected set', () => {
    const expected = [
      'navigate', 'click', 'type', 'extract', 'screenshot', 'eval', 'select', 'attr',
      'await_element', 'await_text', 'hover', 'drag_drop', 'mouse_move', 'scroll',
      'double_click', 'right_click', 'file_upload', 'keyboard_press',
      'set_viewport', 'clear_viewport', 'get_viewport',
    ];
    assert.deepEqual([...PAGE_TARGET_ACTIONS].sort(), expected.sort());
  });

  it('BROWSER_TARGET_ACTIONS contains the expected set', () => {
    const expected = [
      'list_tabs', 'new_tab', 'close_tab', 'show_browser', 'hide_browser',
      'browser_mode', 'set_profile', 'get_profile', 'help', 'clear_cookies',
    ];
    assert.deepEqual([...BROWSER_TARGET_ACTIONS].sort(), expected.sort());
  });

  it('the two sets are disjoint', () => {
    for (const a of PAGE_TARGET_ACTIONS) assert.ok(!BROWSER_TARGET_ACTIONS.has(a), `${a} in both`);
  });
});

describe('withDialogAwareness', () => {
  it('refuses page-target action when dialog is open', async () => {
    const { api, state } = setup();
    state.dialogs.set('ws://x', { kind: 'alert', openedAt: Date.now(), payload: { message: 'x', url: '' }, staged: {} });
    const r = await api.withDialogAwareness('click', 'ws://x', { selector: 'button' }, async () => 'body-ran');
    assert.equal(r.refused, true);
    assert.match(r.error, /Page is behind a dialog/);
    assert.equal(r.dialog.kind, 'alert');
  });

  it('passes through browser-target action when dialog is open', async () => {
    const { api, state } = setup();
    state.dialogs.set('ws://x', { kind: 'alert', openedAt: Date.now(), payload: { message: 'x' }, staged: {} });
    const r = await api.withDialogAwareness('list_tabs', 'ws://x', {}, async () => 'tabs-result');
    assert.equal(r, 'tabs-result');
  });

  it('allows page-target click with dialog::* selector through', async () => {
    const { api, state } = setup();
    state.dialogs.set('ws://x', { kind: 'alert', openedAt: Date.now(), payload: { message: 'x' }, staged: {} });
    const r = await api.withDialogAwareness('click', 'ws://x', { selector: 'dialog::accept' }, async () => 'click-ran');
    assert.equal(r, 'click-ran');
  });

  it('passes through page-target action when no dialog open', async () => {
    const { api } = setup();
    const r = await api.withDialogAwareness('click', 'ws://x', { selector: 'button' }, async () => 'ran');
    assert.equal(r, 'ran');
  });
});

describe('withDialogAwareness mid-flight', () => {
  it('replaces post-capture when a dialog opens during action', async () => {
    const { api, state } = setup();
    const r = await api.withDialogAwareness('eval', 'ws://x', { expression: 'x' }, async () => {
      // Simulate page firing alert while action body runs.
      state.dialogs.set('ws://x', { kind: 'alert', openedAt: Date.now(), payload: { message: 'm', url: '' }, staged: {} });
      return 'body-ok';
    });
    assert.equal(r.midFlight, true);
    assert.equal(r.actionResult, 'body-ok');
    assert.equal(r.dialog.kind, 'alert');
    assert.ok(r.artifacts.markdown.includes('# Dialog: alert'));
  });
});

describe('dialogs.attachToPageSession', () => {
  it('enables Page/DeviceAccess/Fetch/Runtime, adds script + binding via pageSession.send', async () => {
    const sent = [];
    const ps = {
      sessionId: 'S1',
      send: async (method, params) => { sent.push({ method, params }); return {}; },
      onEvent: () => () => {},
    };
    const state = { dialogs: new Map() };
    const dialogs = attachDialogs({ state });
    await dialogs.attachToPageSession(ps);
    const methods = sent.map(s => s.method);
    assert.ok(methods.includes('Page.enable'));
    assert.ok(methods.includes('DeviceAccess.enable'));
    assert.ok(methods.includes('Fetch.enable'));
    assert.ok(methods.includes('Runtime.enable'));
    assert.ok(methods.includes('Page.addScriptToEvaluateOnNewDocument'));
    assert.ok(methods.includes('Runtime.addBinding'));
  });

  it('registers a pageSession.onEvent handler that captures Page.javascriptDialogOpening keyed by sessionId', async () => {
    let registeredHandler = null;
    const ps = {
      sessionId: 'S1',
      send: async () => ({}),
      onEvent: (fn) => { registeredHandler = fn; return () => { registeredHandler = null; }; },
    };
    const state = { dialogs: new Map() };
    const dialogs = attachDialogs({ state });
    await dialogs.attachToPageSession(ps);
    assert.equal(typeof registeredHandler, 'function');
    // Fire a dialog event
    registeredHandler({ method: 'Page.javascriptDialogOpening', params: { type: 'alert', message: 'hi' } });
    assert.ok(state.dialogs.has('S1'));
    assert.equal(state.dialogs.get('S1').kind, 'alert');
    assert.equal(state.dialogs.get('S1').payload.message, 'hi');
  });

  it('captures permission-request via Runtime.bindingCalled __dialogShim', async () => {
    let handler = null;
    const ps = {
      sessionId: 'S1',
      send: async () => ({}),
      onEvent: (fn) => { handler = fn; return () => {}; },
    };
    const state = { dialogs: new Map() };
    const dialogs = attachDialogs({ state });
    await dialogs.attachToPageSession(ps);
    handler({
      method: 'Runtime.bindingCalled',
      params: {
        name: '__dialogShim',
        payload: JSON.stringify({ type: 'permission-request', name: 'notifications', origin: 'https://example.com', jsApi: 'Notification.requestPermission', id: 'shim-1' }),
      },
    });
    assert.ok(state.dialogs.has('S1'));
    assert.equal(state.dialogs.get('S1').kind, 'permission');
    assert.equal(state.dialogs.get('S1').payload.name, 'notifications');
  });

  it('clears dialog state on Page.javascriptDialogClosed', async () => {
    let handler = null;
    const ps = {
      sessionId: 'S1',
      send: async () => ({}),
      onEvent: (fn) => { handler = fn; return () => {}; },
    };
    const state = { dialogs: new Map([['S1', { kind: 'alert', staged: {} }]]) };
    const dialogs = attachDialogs({ state });
    await dialogs.attachToPageSession(ps);
    handler({ method: 'Page.javascriptDialogClosed', params: {} });
    assert.equal(state.dialogs.has('S1'), false);
  });

  it('clears dialog state on main-frame Page.frameNavigated', async () => {
    let handler = null;
    const ps = {
      sessionId: 'S1',
      send: async () => ({}),
      onEvent: (fn) => { handler = fn; return () => {}; },
    };
    const state = { dialogs: new Map([['S1', { kind: 'alert', staged: {} }]]) };
    const dialogs = attachDialogs({ state });
    await dialogs.attachToPageSession(ps);
    handler({ method: 'Page.frameNavigated', params: { frame: { parentId: undefined } } });
    assert.equal(state.dialogs.has('S1'), false);
  });

  it('does NOT clear dialog state on subframe Page.frameNavigated', async () => {
    let handler = null;
    const ps = {
      sessionId: 'S1',
      send: async () => ({}),
      onEvent: (fn) => { handler = fn; return () => {}; },
    };
    const state = { dialogs: new Map([['S1', { kind: 'alert', staged: {} }]]) };
    const dialogs = attachDialogs({ state });
    await dialogs.attachToPageSession(ps);
    handler({ method: 'Page.frameNavigated', params: { frame: { parentId: 'F-parent' } } });
    assert.equal(state.dialogs.has('S1'), true);
  });

  it('captures Fetch.authRequired as a basic-auth dialog (Chrome fires this, not Fetch.requestPaused with authChallenge)', async () => {
    let handler = null;
    const ps = {
      sessionId: 'S1',
      send: async () => ({}),
      onEvent: (fn) => { handler = fn; return () => {}; },
    };
    const state = { dialogs: new Map() };
    const dialogs = attachDialogs({ state });
    await dialogs.attachToPageSession(ps);

    handler({
      method: 'Fetch.authRequired',
      params: {
        requestId: 'interception-job-1.0',
        request: { url: 'http://example.com/', method: 'GET', headers: {} },
        frameId: 'F1',
        resourceType: 'Document',
        authChallenge: {
          source: 'Server',
          origin: 'http://example.com',
          scheme: 'basic',
          realm: 'Protected Area',
        },
      },
    });

    assert.ok(state.dialogs.has('S1'), 'dialog state should be set');
    const d = state.dialogs.get('S1');
    assert.equal(d.kind, 'basic-auth');
    assert.equal(d.payload.requestId, 'interception-job-1.0');
    assert.equal(d.payload.origin, 'http://example.com');
    assert.equal(d.payload.scheme, 'basic');
    assert.equal(d.payload.realm, 'Protected Area');
  });

  it('Fetch.requestPaused (non-auth) calls Fetch.continueRequest and does NOT set dialog state', async () => {
    let handler = null;
    const sent = [];
    const ps = {
      sessionId: 'S1',
      send: async (method, params) => { sent.push({ method, params }); return {}; },
      onEvent: (fn) => { handler = fn; return () => {}; },
    };
    const state = { dialogs: new Map() };
    const dialogs = attachDialogs({ state });
    await dialogs.attachToPageSession(ps);

    // Clear setup calls so we only see the event-handler calls below
    sent.length = 0;

    handler({
      method: 'Fetch.requestPaused',
      params: {
        requestId: 'req-1',
        request: { url: 'http://example.com/favicon.ico', method: 'GET', headers: {} },
        frameId: 'F1',
        resourceType: 'Image',
      },
    });

    // Allow the .catch() handler to settle
    await new Promise(r => setImmediate(r));

    assert.ok(!state.dialogs.has('S1'), 'no dialog state for plain request');
    const continueCall = sent.find(c => c.method === 'Fetch.continueRequest');
    assert.ok(continueCall, 'Fetch.continueRequest should be called for non-auth requests');
    assert.equal(continueCall.params.requestId, 'req-1');
  });

  it('suppresses a second javascriptDialogOpening while one is already open', async () => {
    let handler = null;
    const ps = {
      sessionId: 'S1',
      send: async () => ({}),
      onEvent: (fn) => { handler = fn; return () => {}; },
    };
    const state = { dialogs: new Map([['S1', { kind: 'confirm', payload: { message: 'first' }, staged: {} }]]) };
    const dialogs = attachDialogs({ state });
    await dialogs.attachToPageSession(ps);
    handler({ method: 'Page.javascriptDialogOpening', params: { type: 'alert', message: 'second' } });
    // First one preserved
    assert.equal(state.dialogs.get('S1').kind, 'confirm');
  });
});

describe('dialogs.withDialogAwarenessForSession', () => {
  it('refuses page-target actions when a dialog is open for the sessionId', async () => {
    const state = { dialogs: new Map() };
    state.dialogs.set('S1', { kind: 'alert', openedAt: 0, payload: { message: 'hi' }, staged: {} });
    const dialogs = attachDialogs({ state });
    const ps = { sessionId: 'S1' };
    const result = await dialogs.withDialogAwarenessForSession('click', ps, { selector: 'button' }, async () => 'ran');
    assert.equal(result.refused, true);
    assert.equal(result.dialog.kind, 'alert');
    assert.ok(result.artifacts);
  });

  it('passes through when no dialog open', async () => {
    const state = { dialogs: new Map() };
    const dialogs = attachDialogs({ state });
    const ps = { sessionId: 'S1' };
    const result = await dialogs.withDialogAwarenessForSession('click', ps, { selector: 'button' }, async () => 'ran');
    assert.equal(result, 'ran');
  });

  it('allows dialog:: selectors through even when a dialog is open', async () => {
    const state = { dialogs: new Map([['S1', { kind: 'confirm', staged: {} }]]) };
    const dialogs = attachDialogs({ state });
    const ps = { sessionId: 'S1' };
    const result = await dialogs.withDialogAwarenessForSession('click', ps, { selector: 'dialog::accept' }, async () => 'handled');
    assert.equal(result, 'handled');
  });

  it('detects mid-flight dialogs (action ran, dialog appeared)', async () => {
    const state = { dialogs: new Map() };
    const dialogs = attachDialogs({ state });
    const ps = { sessionId: 'S1' };
    const result = await dialogs.withDialogAwarenessForSession('click', ps, { selector: 'button' }, async () => {
      // Action triggers a dialog mid-flight
      state.dialogs.set('S1', { kind: 'confirm', openedAt: Date.now(), payload: { message: 'sure?' }, staged: {} });
      return 'action-result';
    });
    assert.equal(result.midFlight, true);
    assert.equal(result.actionResult, 'action-result');
    assert.equal(result.dialog.kind, 'confirm');
    assert.ok(result.artifacts);
  });

  it('does not refuse browser-target actions (e.g. list_tabs) when a dialog is open', async () => {
    const state = { dialogs: new Map([['S1', { kind: 'alert', staged: {} }]]) };
    const dialogs = attachDialogs({ state });
    const ps = { sessionId: 'S1' };
    const result = await dialogs.withDialogAwarenessForSession('list_tabs', ps, {}, async () => 'tabs');
    assert.equal(result, 'tabs');
  });
});
