import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { makeCdpSpy } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { tryHandleDialogSelector } = require('../../skills/browsing/lib/dialogs-router.js');

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
