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
