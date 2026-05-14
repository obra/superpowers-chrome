'use strict';

const JS_KINDS = new Set(['alert', 'confirm', 'prompt', 'beforeunload']);

async function tryHandleDialogSelector({ selector, op, payload, state, sendCdpCommand, wsUrl }) {
  if (!selector || !selector.startsWith('dialog::')) {
    return { handled: false };
  }
  if (!state) {
    return { handled: true, error: 'No dialog open on this tab.' };
  }

  if (selector === 'dialog::accept' && op === 'click') {
    if (JS_KINDS.has(state.kind)) {
      const params = { accept: true };
      if (state.kind === 'prompt' && state.staged.promptText !== undefined) {
        params.promptText = state.staged.promptText;
      }
      await sendCdpCommand(wsUrl, 'Page.handleJavaScriptDialog', params);
      return { handled: true, result: { ok: true } };
    }
  }

  if (selector === 'dialog::dismiss' && op === 'click') {
    if (JS_KINDS.has(state.kind)) {
      await sendCdpCommand(wsUrl, 'Page.handleJavaScriptDialog', { accept: false });
      return { handled: true, result: { ok: true } };
    }
  }

  if (op === 'type') {
    if (selector === 'dialog::prompt' && state.kind === 'prompt') {
      state.staged.promptText = String(payload ?? '');
      return { handled: true, result: { staged: 'promptText' } };
    }
    if (selector === 'dialog::username' && state.kind === 'basic-auth') {
      state.staged.username = String(payload ?? '');
      return { handled: true, result: { staged: 'username' } };
    }
    if (selector === 'dialog::password' && state.kind === 'basic-auth') {
      state.staged.password = String(payload ?? '');
      return { handled: true, result: { staged: 'password' } };
    }
  }

  return { handled: true, error: `Unknown dialog selector or operation: ${op} ${selector}` };
}

module.exports = { tryHandleDialogSelector };
