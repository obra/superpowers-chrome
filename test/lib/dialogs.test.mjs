import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { makeCdpSpy, makeResolveWsUrl } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachDialogs } = require('../../skills/browsing/lib/dialogs.js');

function setup(handlers = {}) {
  const state = {};
  const sendCdpCommand = makeCdpSpy(handlers);
  const api = attachDialogs({ state, sendCdpCommand, resolveWsUrl: makeResolveWsUrl() });
  return { api, sendCdpCommand, state };
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

describe('dialogs attachToConnection', () => {
  it('enables Page, DeviceAccess, and Fetch domains once', async () => {
    const { api, sendCdpCommand } = setup();
    const conn = { eventHandler: null };
    await api.attachToConnection(conn, 'ws://x');
    const methods = sendCdpCommand.calls.map(c => c.method);
    assert.deepEqual(methods, ['Page.enable', 'DeviceAccess.enable', 'Fetch.enable']);
  });

  it('Fetch.enable passes handleAuthRequests and wildcard pattern', async () => {
    const { api, sendCdpCommand } = setup();
    const conn = { eventHandler: null };
    await api.attachToConnection(conn, 'ws://x');
    const fetchCall = sendCdpCommand.calls.find(c => c.method === 'Fetch.enable');
    assert.equal(fetchCall.params.handleAuthRequests, true);
    assert.deepEqual(fetchCall.params.patterns, [{ urlPattern: '*' }]);
  });

  it('installs an eventHandler on the connection', async () => {
    const { api } = setup();
    const conn = { eventHandler: null };
    await api.attachToConnection(conn, 'ws://x');
    assert.equal(typeof conn.eventHandler, 'function');
  });
});

describe('Page.javascriptDialogOpening', () => {
  async function fireEvent(api, conn, wsUrl, params) {
    await api.attachToConnection(conn, wsUrl);
    conn.eventHandler({ method: 'Page.javascriptDialogOpening', params });
  }

  it('populates state with kind: alert', async () => {
    const { api } = setup();
    const conn = {};
    await fireEvent(api, conn, 'ws://x', {
      type: 'alert', message: 'hi', defaultPrompt: '', url: 'http://e.com', hasBrowserHandler: false,
    });
    const s = api.getOpen('ws://x');
    assert.equal(s.kind, 'alert');
    assert.equal(s.payload.message, 'hi');
    assert.equal(s.payload.url, 'http://e.com');
    assert.equal(typeof s.openedAt, 'number');
  });

  it('populates state with kind: confirm', async () => {
    const { api } = setup();
    const conn = {};
    await fireEvent(api, conn, 'ws://x', { type: 'confirm', message: 'q', defaultPrompt: '', url: '', hasBrowserHandler: false });
    assert.equal(api.getOpen('ws://x').kind, 'confirm');
  });

  it('populates state with kind: prompt including defaultPrompt', async () => {
    const { api } = setup();
    const conn = {};
    await fireEvent(api, conn, 'ws://x', { type: 'prompt', message: 'name?', defaultPrompt: 'guest', url: '', hasBrowserHandler: false });
    const s = api.getOpen('ws://x');
    assert.equal(s.kind, 'prompt');
    assert.equal(s.payload.defaultPrompt, 'guest');
  });

  it('populates state with kind: beforeunload', async () => {
    const { api } = setup();
    const conn = {};
    await fireEvent(api, conn, 'ws://x', { type: 'beforeunload', message: '', defaultPrompt: '', url: '', hasBrowserHandler: false });
    assert.equal(api.getOpen('ws://x').kind, 'beforeunload');
  });

  it('initializes staged with empty object', async () => {
    const { api } = setup();
    const conn = {};
    await fireEvent(api, conn, 'ws://x', { type: 'alert', message: 'x', defaultPrompt: '', url: '', hasBrowserHandler: false });
    assert.deepEqual(api.getOpen('ws://x').staged, {});
  });
});

describe('second-open guard', () => {
  it('preserves the original dialog and logs a warning on second open', async () => {
    const { api } = setup();
    const conn = {};
    await api.attachToConnection(conn, 'ws://x');
    conn.eventHandler({ method: 'Page.javascriptDialogOpening', params: { type: 'alert', message: 'first', defaultPrompt: '', url: '', hasBrowserHandler: false } });

    // Capture console.error
    const errors = [];
    const origErr = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    try {
      conn.eventHandler({ method: 'Page.javascriptDialogOpening', params: { type: 'confirm', message: 'second', defaultPrompt: '', url: '', hasBrowserHandler: false } });
    } finally {
      console.error = origErr;
    }

    assert.equal(api.getOpen('ws://x').payload.message, 'first');
    assert.equal(api.getOpen('ws://x').kind, 'alert');
    assert.ok(errors.some(e => e.includes('second javascriptDialogOpening')));
  });
});

describe('dialog state clearing', () => {
  it('Page.javascriptDialogClosed clears state', async () => {
    const { api } = setup();
    const conn = {};
    await api.attachToConnection(conn, 'ws://x');
    conn.eventHandler({ method: 'Page.javascriptDialogOpening', params: { type: 'alert', message: 'x', defaultPrompt: '', url: '', hasBrowserHandler: false } });
    conn.eventHandler({ method: 'Page.javascriptDialogClosed', params: { result: true, userInput: '' } });
    assert.equal(api.getOpen('ws://x'), null);
  });

  it('Page.frameNavigated clears state defensively (main frame only)', async () => {
    const { api } = setup();
    const conn = {};
    await api.attachToConnection(conn, 'ws://x');
    conn.eventHandler({ method: 'Page.javascriptDialogOpening', params: { type: 'alert', message: 'x', defaultPrompt: '', url: '', hasBrowserHandler: false } });
    conn.eventHandler({ method: 'Page.frameNavigated', params: { frame: { id: 'main', parentId: undefined } } });
    assert.equal(api.getOpen('ws://x'), null);
  });

  it('Page.frameNavigated does NOT clear state for subframes', async () => {
    const { api } = setup();
    const conn = {};
    await api.attachToConnection(conn, 'ws://x');
    conn.eventHandler({ method: 'Page.javascriptDialogOpening', params: { type: 'alert', message: 'x', defaultPrompt: '', url: '', hasBrowserHandler: false } });
    conn.eventHandler({ method: 'Page.frameNavigated', params: { frame: { id: 'sub', parentId: 'main' } } });
    assert.notEqual(api.getOpen('ws://x'), null);
  });
});

describe('DeviceAccess.deviceRequestPrompted', () => {
  it('populates device-chooser state', async () => {
    const { api } = setup();
    const conn = {};
    await api.attachToConnection(conn, 'ws://x');
    conn.eventHandler({ method: 'DeviceAccess.deviceRequestPrompted', params: {
      id: 'req-1',
      devices: [{ id: 'd1', name: 'USB' }],
    }});
    const s = api.getOpen('ws://x');
    assert.equal(s.kind, 'device-chooser');
    assert.equal(s.payload.requestId, 'req-1');
    assert.deepEqual(s.payload.devices, [{ id: 'd1', name: 'USB' }]);
  });
});

describe('Fetch.requestPaused', () => {
  it('continues plain requests immediately', async () => {
    const { api, sendCdpCommand } = setup();
    const conn = {};
    await api.attachToConnection(conn, 'ws://x');
    sendCdpCommand.calls.length = 0;
    conn.eventHandler({ method: 'Fetch.requestPaused', params: { requestId: 'r1' /* no authChallenge */ } });
    const call = sendCdpCommand.calls.find(c => c.method === 'Fetch.continueRequest');
    assert.equal(call.params.requestId, 'r1');
    assert.equal(api.getOpen('ws://x'), null);
  });

  it('surfaces basic-auth challenge as dialog state', async () => {
    const { api, sendCdpCommand } = setup();
    const conn = {};
    await api.attachToConnection(conn, 'ws://x');
    sendCdpCommand.calls.length = 0;
    conn.eventHandler({ method: 'Fetch.requestPaused', params: {
      requestId: 'r2',
      authChallenge: { source: 'Server', origin: 'https://x.com', scheme: 'basic', realm: 'Admin' },
    }});
    const s = api.getOpen('ws://x');
    assert.equal(s.kind, 'basic-auth');
    assert.equal(s.payload.requestId, 'r2');
    assert.equal(s.payload.realm, 'Admin');
    // No automatic continue yet — agent must respond.
    assert.equal(sendCdpCommand.calls.find(c => c.method === 'Fetch.continueWithAuth'), undefined);
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
  function simulateDialog(_api, conn) {
    conn.eventHandler({ method: 'Page.javascriptDialogOpening', params: { type: 'alert', message: 'x', defaultPrompt: '', url: '', hasBrowserHandler: false } });
  }

  it('refuses page-target action when dialog is open', async () => {
    const { api } = setup();
    const conn = {};
    await api.attachToConnection(conn, 'ws://x');
    simulateDialog(api, conn);
    const r = await api.withDialogAwareness('click', 'ws://x', { selector: 'button' }, async () => 'body-ran');
    assert.equal(r.refused, true);
    assert.match(r.error, /Page is behind a dialog/);
    assert.equal(r.dialog.kind, 'alert');
  });

  it('passes through browser-target action when dialog is open', async () => {
    const { api } = setup();
    const conn = {};
    await api.attachToConnection(conn, 'ws://x');
    simulateDialog(api, conn);
    const r = await api.withDialogAwareness('list_tabs', 'ws://x', {}, async () => 'tabs-result');
    assert.equal(r, 'tabs-result');
  });

  it('allows page-target click with dialog::* selector through', async () => {
    const { api } = setup();
    const conn = {};
    await api.attachToConnection(conn, 'ws://x');
    simulateDialog(api, conn);
    const r = await api.withDialogAwareness('click', 'ws://x', { selector: 'dialog::accept' }, async () => 'click-ran');
    assert.equal(r, 'click-ran');
  });

  it('passes through page-target action when no dialog open', async () => {
    const { api } = setup();
    const conn = {};
    await api.attachToConnection(conn, 'ws://x');
    const r = await api.withDialogAwareness('click', 'ws://x', { selector: 'button' }, async () => 'ran');
    assert.equal(r, 'ran');
  });
});

describe('withDialogAwareness mid-flight', () => {
  it('replaces post-capture when a dialog opens during action', async () => {
    const { api } = setup();
    const conn = {};
    await api.attachToConnection(conn, 'ws://x');
    const r = await api.withDialogAwareness('eval', 'ws://x', { expression: 'x' }, async () => {
      // Simulate page firing alert while action body runs.
      conn.eventHandler({ method: 'Page.javascriptDialogOpening', params: { type: 'alert', message: 'm', defaultPrompt: '', url: '', hasBrowserHandler: false } });
      return 'body-ok';
    });
    assert.equal(r.midFlight, true);
    assert.equal(r.actionResult, 'body-ok');
    assert.equal(r.dialog.kind, 'alert');
    assert.ok(r.artifacts.markdown.includes('# Dialog: alert'));
  });
});
