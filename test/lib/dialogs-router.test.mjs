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
