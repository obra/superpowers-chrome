import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { makeCdpSpy } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { tryHandleDialogSelector, tryHandleDialogSelectorForSession } = require('../../skills/browsing/lib/dialogs-router.js');

function jsAlert() {
  return { kind: 'alert', payload: { message: 'x', url: '', defaultPrompt: '', hasBrowserHandler: false }, staged: {} };
}
function jsConfirm() {
  return { kind: 'confirm', payload: { message: 'q', url: '', defaultPrompt: '', hasBrowserHandler: false }, staged: {} };
}
function jsPrompt(staged = {}) {
  return { kind: 'prompt', payload: { message: 'n?', url: '', defaultPrompt: '', hasBrowserHandler: false }, staged };
}

describe('tryHandleDialogSelector', () => {
  it('falls through for non-dialog selectors', async () => {
    const r = await tryHandleDialogSelector({ selector: 'body', op: 'click', state: null, sendCdpCommand: makeCdpSpy(), wsUrl: 'ws://x' });
    assert.deepEqual(r, { handled: false });
  });

  it('errors on dialog::accept when no dialog open', async () => {
    const r = await tryHandleDialogSelector({ selector: 'dialog::accept', op: 'click', state: null, sendCdpCommand: makeCdpSpy(), wsUrl: 'ws://x' });
    assert.equal(r.handled, true);
    assert.match(r.error, /no dialog open/i);
  });

  it('dialog::accept on alert calls handleJavaScriptDialog accept=true', async () => {
    const cdp = makeCdpSpy();
    const r = await tryHandleDialogSelector({ selector: 'dialog::accept', op: 'click', state: jsAlert(), sendCdpCommand: cdp, wsUrl: 'ws://x' });
    assert.equal(r.handled, true);
    const call = cdp.calls.find(c => c.method === 'Page.handleJavaScriptDialog');
    assert.equal(call.params.accept, true);
  });

  it('dialog::accept on prompt includes staged promptText', async () => {
    const cdp = makeCdpSpy();
    await tryHandleDialogSelector({ selector: 'dialog::accept', op: 'click', state: jsPrompt({ promptText: 'hello' }), sendCdpCommand: cdp, wsUrl: 'ws://x' });
    const call = cdp.calls.find(c => c.method === 'Page.handleJavaScriptDialog');
    assert.equal(call.params.promptText, 'hello');
  });

  it('dialog::dismiss on confirm calls handleJavaScriptDialog accept=false', async () => {
    const cdp = makeCdpSpy();
    await tryHandleDialogSelector({ selector: 'dialog::dismiss', op: 'click', state: jsConfirm(), sendCdpCommand: cdp, wsUrl: 'ws://x' });
    const call = cdp.calls.find(c => c.method === 'Page.handleJavaScriptDialog');
    assert.equal(call.params.accept, false);
  });

  // Regression for scenario 03 step 6: JS-kind dialog::accept used to rely
  // solely on Chrome firing Page.javascriptDialogClosed for state cleanup.
  // When that event didn't reach the bridge session promptly, the dialog
  // state stayed in state.dialogs and the very next extract was refused
  // with "Page is behind a dialog" even though Chrome had moved on. The
  // router must now signal clearDialog so the caller does the cleanup
  // immediately; Chrome's event becomes a redundant best-effort sweep.
  it('dialog::accept on JS dialogs signals clearDialog=true', async () => {
    const cdp = makeCdpSpy();
    const r = await tryHandleDialogSelector({ selector: 'dialog::accept', op: 'click', state: jsConfirm(), sendCdpCommand: cdp, wsUrl: 'ws://x' });
    assert.equal(r.handled, true);
    assert.equal(r.clearDialog, true, 'JS dialog accept must signal eager state cleanup');
  });

  it('dialog::dismiss on JS dialogs signals clearDialog=true', async () => {
    const cdp = makeCdpSpy();
    const r = await tryHandleDialogSelector({ selector: 'dialog::dismiss', op: 'click', state: jsConfirm(), sendCdpCommand: cdp, wsUrl: 'ws://x' });
    assert.equal(r.handled, true);
    assert.equal(r.clearDialog, true, 'JS dialog dismiss must signal eager state cleanup');
  });
});

describe('router staging', () => {
  it('type dialog::prompt stages promptText, no CDP call', async () => {
    const cdp = makeCdpSpy();
    const state = jsPrompt();
    const r = await tryHandleDialogSelector({ selector: 'dialog::prompt', op: 'type', payload: 'hello', state, sendCdpCommand: cdp, wsUrl: 'ws://x' });
    assert.equal(r.handled, true);
    assert.equal(state.staged.promptText, 'hello');
    assert.equal(cdp.calls.length, 0);
  });

  it('type dialog::username stages username', async () => {
    const cdp = makeCdpSpy();
    const state = { kind: 'basic-auth', payload: { requestId: 'r', origin: 'x', scheme: 'basic', realm: '' }, staged: {} };
    await tryHandleDialogSelector({ selector: 'dialog::username', op: 'type', payload: 'alice', state, sendCdpCommand: cdp, wsUrl: 'ws://x' });
    assert.equal(state.staged.username, 'alice');
  });

  it('type dialog::password stages password', async () => {
    const cdp = makeCdpSpy();
    const state = { kind: 'basic-auth', payload: { requestId: 'r', origin: 'x', scheme: 'basic', realm: '' }, staged: {} };
    await tryHandleDialogSelector({ selector: 'dialog::password', op: 'type', payload: 'p4ss', state, sendCdpCommand: cdp, wsUrl: 'ws://x' });
    assert.equal(state.staged.password, 'p4ss');
  });
});

describe('router device selection', () => {
  it('click dialog::device[id="d1"] calls DeviceAccess.selectPrompt', async () => {
    const cdp = makeCdpSpy();
    const state = { kind: 'device-chooser', payload: { requestId: 'req-1', deviceKind: 'usb', devices: [{ id: 'd1', name: 'D' }] }, staged: {} };
    const r = await tryHandleDialogSelector({ selector: 'dialog::device[id="d1"]', op: 'click', state, sendCdpCommand: cdp, wsUrl: 'ws://x' });
    assert.equal(r.handled, true);
    const call = cdp.calls.find(c => c.method === 'DeviceAccess.selectPrompt');
    assert.equal(call.params.id, 'req-1');
    assert.equal(call.params.deviceId, 'd1');
  });

  it('click dialog::dismiss on device-chooser calls cancelPrompt', async () => {
    const cdp = makeCdpSpy();
    const state = { kind: 'device-chooser', payload: { requestId: 'req-1', deviceKind: 'usb', devices: [] }, staged: {} };
    await tryHandleDialogSelector({ selector: 'dialog::dismiss', op: 'click', state, sendCdpCommand: cdp, wsUrl: 'ws://x' });
    const call = cdp.calls.find(c => c.method === 'DeviceAccess.cancelPrompt');
    assert.equal(call.params.id, 'req-1');
  });
});

describe('basic-auth router', () => {
  function authState(staged = {}) {
    return { kind: 'basic-auth', payload: { requestId: 'r', origin: 'x', scheme: 'basic', realm: 'R' }, staged };
  }

  it('dialog::accept calls Fetch.continueWithAuth with ProvideCredentials', async () => {
    const cdp = makeCdpSpy();
    await tryHandleDialogSelector({ selector: 'dialog::accept', op: 'click', state: authState({ username: 'u', password: 'p' }), sendCdpCommand: cdp, wsUrl: 'ws://x' });
    const call = cdp.calls.find(c => c.method === 'Fetch.continueWithAuth');
    assert.equal(call.params.requestId, 'r');
    assert.equal(call.params.authChallengeResponse.response, 'ProvideCredentials');
    assert.equal(call.params.authChallengeResponse.username, 'u');
    assert.equal(call.params.authChallengeResponse.password, 'p');
  });

  it('dialog::dismiss calls Fetch.continueWithAuth with CancelAuth', async () => {
    const cdp = makeCdpSpy();
    await tryHandleDialogSelector({ selector: 'dialog::dismiss', op: 'click', state: authState(), sendCdpCommand: cdp, wsUrl: 'ws://x' });
    const call = cdp.calls.find(c => c.method === 'Fetch.continueWithAuth');
    assert.equal(call.params.authChallengeResponse.response, 'CancelAuth');
  });
});

describe('permission router', () => {
  function permState(shimId = '7') {
    return { kind: 'permission', payload: { name: 'camera', origin: 'x', jsApi: 'getUserMedia' }, staged: { _shimId: shimId } };
  }
  it('dialog::accept resolves shim with grant via Runtime.evaluate', async () => {
    const cdp = makeCdpSpy();
    await tryHandleDialogSelector({ selector: 'dialog::accept', op: 'click', state: permState('42'), sendCdpCommand: cdp, wsUrl: 'ws://x' });
    const call = cdp.calls.find(c => c.method === 'Runtime.evaluate');
    assert.ok(call);
    assert.match(call.params.expression, /__dialogShim_resolve\('42', 'grant'\)/);
  });
  it('dialog::dismiss resolves shim with deny', async () => {
    const cdp = makeCdpSpy();
    await tryHandleDialogSelector({ selector: 'dialog::dismiss', op: 'click', state: permState('9'), sendCdpCommand: cdp, wsUrl: 'ws://x' });
    const call = cdp.calls.find(c => c.method === 'Runtime.evaluate');
    assert.match(call.params.expression, /__dialogShim_resolve\('9', 'deny'\)/);
  });
});

describe('router errors', () => {
  it('unknown dialog selector returns error listing valid ones', async () => {
    const cdp = makeCdpSpy();
    const r = await tryHandleDialogSelector({ selector: 'dialog::garbage', op: 'click', state: jsAlert(), sendCdpCommand: cdp, wsUrl: 'ws://x' });
    assert.equal(r.handled, true);
    assert.match(r.error, /Unknown dialog selector/);
    assert.match(r.error, /dialog::accept/);
  });

  it('attr on dialog::accept returns refusal (unsupported op)', async () => {
    const cdp = makeCdpSpy();
    const r = await tryHandleDialogSelector({ selector: 'dialog::accept', op: 'attr', state: jsAlert(), sendCdpCommand: cdp, wsUrl: 'ws://x' });
    assert.equal(r.handled, true);
    assert.match(r.error, /unsupported operation/i);
  });
});

describe('tryHandleDialogSelectorForSession', () => {
  function makePageSessionSpy() {
    const calls = [];
    return {
      sessionId: 'S1',
      send: async (method, params) => {
        calls.push({ method, params });
        return {};
      },
      calls,
    };
  }

  it('returns unhandled for non-dialog selectors', async () => {
    const ps = makePageSessionSpy();
    const r = await tryHandleDialogSelectorForSession({
      selector: 'button.foo', op: 'click', payload: null, state: null, pageSession: ps,
    });
    assert.equal(r.handled, false);
    assert.equal(ps.calls.length, 0);
  });

  it('returns error when dialog selector used with no dialog open', async () => {
    const ps = makePageSessionSpy();
    const r = await tryHandleDialogSelectorForSession({
      selector: 'dialog::accept', op: 'click', payload: null, state: null, pageSession: ps,
    });
    assert.equal(r.handled, true);
    assert.match(r.error, /No dialog open/);
    assert.equal(ps.calls.length, 0);
  });

  it('dialog::accept on a confirm calls Page.handleJavaScriptDialog({accept:true}) via pageSession.send', async () => {
    const ps = makePageSessionSpy();
    const state = { kind: 'confirm', staged: {}, payload: {} };
    const r = await tryHandleDialogSelectorForSession({
      selector: 'dialog::accept', op: 'click', payload: null, state, pageSession: ps,
    });
    assert.equal(r.handled, true);
    assert.deepEqual(ps.calls[0], { method: 'Page.handleJavaScriptDialog', params: { accept: true } });
  });

  it('dialog::accept on a prompt with staged promptText forwards the text', async () => {
    const ps = makePageSessionSpy();
    const state = { kind: 'prompt', staged: { promptText: 'hello' }, payload: {} };
    const r = await tryHandleDialogSelectorForSession({
      selector: 'dialog::accept', op: 'click', payload: null, state, pageSession: ps,
    });
    assert.equal(r.handled, true);
    assert.deepEqual(ps.calls[0], { method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: 'hello' } });
  });

  it('dialog::dismiss on a JS dialog calls Page.handleJavaScriptDialog({accept:false})', async () => {
    const ps = makePageSessionSpy();
    const state = { kind: 'confirm', staged: {}, payload: {} };
    const r = await tryHandleDialogSelectorForSession({
      selector: 'dialog::dismiss', op: 'click', payload: null, state, pageSession: ps,
    });
    assert.equal(r.handled, true);
    assert.deepEqual(ps.calls[0], { method: 'Page.handleJavaScriptDialog', params: { accept: false } });
  });

  it('dialog::prompt with type op stages promptText', async () => {
    const ps = makePageSessionSpy();
    const state = { kind: 'prompt', staged: {}, payload: {} };
    const r = await tryHandleDialogSelectorForSession({
      selector: 'dialog::prompt', op: 'type', payload: 'typed text', state, pageSession: ps,
    });
    assert.equal(r.handled, true);
    assert.equal(state.staged.promptText, 'typed text');
    assert.equal(ps.calls.length, 0); // staging only, no CDP send yet
  });

  it('dialog::device[id="X"] on device-chooser sends DeviceAccess.selectPrompt', async () => {
    const ps = makePageSessionSpy();
    const state = { kind: 'device-chooser', staged: {}, payload: { requestId: 'REQ-1' } };
    const r = await tryHandleDialogSelectorForSession({
      selector: 'dialog::device[id="dev-42"]', op: 'click', payload: null, state, pageSession: ps,
    });
    assert.equal(r.handled, true);
    assert.equal(r.clearDialog, true);
    assert.deepEqual(ps.calls[0], { method: 'DeviceAccess.selectPrompt', params: { id: 'REQ-1', deviceId: 'dev-42' } });
  });

  it('dialog::accept on basic-auth sends Fetch.continueWithAuth with staged credentials', async () => {
    const ps = makePageSessionSpy();
    const state = { kind: 'basic-auth', staged: { username: 'u', password: 'p' }, payload: { requestId: 'REQ-2' } };
    const r = await tryHandleDialogSelectorForSession({
      selector: 'dialog::accept', op: 'click', payload: null, state, pageSession: ps,
    });
    assert.equal(r.handled, true);
    assert.equal(r.clearDialog, true);
    assert.equal(ps.calls[0].method, 'Fetch.continueWithAuth');
    assert.equal(ps.calls[0].params.authChallengeResponse.username, 'u');
    assert.equal(ps.calls[0].params.authChallengeResponse.password, 'p');
  });

  it('dialog::dismiss on basic-auth sends Fetch.continueWithAuth with CancelAuth', async () => {
    const ps = makePageSessionSpy();
    const state = { kind: 'basic-auth', staged: {}, payload: { requestId: 'REQ-3' } };
    const r = await tryHandleDialogSelectorForSession({
      selector: 'dialog::dismiss', op: 'click', payload: null, state, pageSession: ps,
    });
    assert.equal(r.handled, true);
    assert.equal(ps.calls[0].params.authChallengeResponse.response, 'CancelAuth');
  });

  it('dialog::accept on permission resolves the shim via Runtime.evaluate', async () => {
    const ps = makePageSessionSpy();
    const state = { kind: 'permission', staged: { _shimId: 'SHIM-A' }, payload: {} };
    const r = await tryHandleDialogSelectorForSession({
      selector: 'dialog::accept', op: 'click', payload: null, state, pageSession: ps,
    });
    assert.equal(r.handled, true);
    assert.equal(ps.calls[0].method, 'Runtime.evaluate');
    assert.match(ps.calls[0].params.expression, /window\.__dialogShim_resolve\('SHIM-A',\s*'grant'\)/);
  });

  it('unknown dialog selector returns handled+error', async () => {
    const ps = makePageSessionSpy();
    const state = { kind: 'confirm', staged: {}, payload: {} };
    const r = await tryHandleDialogSelectorForSession({
      selector: 'dialog::weird', op: 'click', payload: null, state, pageSession: ps,
    });
    assert.equal(r.handled, true);
    assert.match(r.error, /Unknown dialog selector/);
  });
});
