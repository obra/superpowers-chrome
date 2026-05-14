'use strict';

const JS_KINDS = new Set(['alert', 'confirm', 'prompt', 'beforeunload']);
const DEVICE_SELECTOR_RE = /^dialog::device\[id="([^"]+)"\]$/;

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

  if (op === 'click') {
    const m = DEVICE_SELECTOR_RE.exec(selector);
    if (m && state.kind === 'device-chooser') {
      await sendCdpCommand(wsUrl, 'DeviceAccess.selectPrompt', {
        id: state.payload.requestId,
        deviceId: m[1],
      });
      return { handled: true, result: { ok: true } };
    }
    if (selector === 'dialog::dismiss' && state.kind === 'device-chooser') {
      await sendCdpCommand(wsUrl, 'DeviceAccess.cancelPrompt', { id: state.payload.requestId });
      return { handled: true, result: { ok: true } };
    }
  }

  if (op === 'click' && state.kind === 'basic-auth') {
    if (selector === 'dialog::accept') {
      await sendCdpCommand(wsUrl, 'Fetch.continueWithAuth', {
        requestId: state.payload.requestId,
        authChallengeResponse: {
          response: 'ProvideCredentials',
          username: state.staged.username || '',
          password: state.staged.password || '',
        },
      });
      return { handled: true, result: { ok: true } };
    }
    if (selector === 'dialog::dismiss') {
      await sendCdpCommand(wsUrl, 'Fetch.continueWithAuth', {
        requestId: state.payload.requestId,
        authChallengeResponse: { response: 'CancelAuth' },
      });
      return { handled: true, result: { ok: true } };
    }
  }

  if (op === 'click' && state.kind === 'permission') {
    const decision = selector === 'dialog::accept' ? 'grant' : (selector === 'dialog::dismiss' ? 'deny' : null);
    if (decision) {
      const id = state.staged._shimId;
      await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
        expression: `window.__dialogShim_resolve('${id}', '${decision}')`,
      });
      return { handled: true, result: { ok: true } };
    }
  }

  const validSelectors = ['dialog::accept', 'dialog::dismiss', 'dialog::prompt', 'dialog::device[id="..."]', 'dialog::username', 'dialog::password'];
  if (op !== 'click' && op !== 'type') {
    return { handled: true, error: `Unsupported operation '${op}' on dialog selector. Only 'click' and 'type' are supported.` };
  }
  return { handled: true, error: `Unknown dialog selector: ${selector}. Valid: ${validSelectors.join(', ')}.` };
}

module.exports = { tryHandleDialogSelector };
