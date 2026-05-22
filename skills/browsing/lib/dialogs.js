'use strict';

const { renderSyntheticArtifacts } = require('./dialogs-render.js');
const { SHIM_SOURCE } = require('./page-scripts/permission-shim.js');

/**
 * Thrown by the session-boundary dialog gate (wrapWithDialogGate in
 * chrome-ws-lib.js) when a page-target action is attempted while a native
 * browser dialog is open.  Callers that want to surface a human-readable
 * refusal (e.g. the MCP layer) catch this and format it; callers that just
 * want to propagate the error can let it bubble.
 */
class DialogRefusedError extends Error {
  constructor({ dialog, artifacts }) {
    super('Page is behind a dialog. Handle dialog::accept or dialog::dismiss first.');
    this.name = 'DialogRefusedError';
    this.refused = true;
    this.dialog = dialog;
    this.artifacts = artifacts;
  }
}

const PAGE_TARGET_ACTIONS = new Set([
  'navigate', 'click', 'type', 'extract', 'screenshot', 'eval', 'select', 'attr',
  'await_element', 'await_text', 'hover', 'drag_drop', 'mouse_move', 'scroll',
  'double_click', 'right_click', 'file_upload', 'keyboard_press',
  'set_viewport', 'clear_viewport', 'get_viewport',
]);

const BROWSER_TARGET_ACTIONS = new Set([
  'list_tabs', 'new_tab', 'close_tab', 'show_browser', 'hide_browser',
  'browser_mode', 'set_profile', 'get_profile', 'help', 'clear_cookies',
]);

function attachDialogs({ state }) {
  if (!state.dialogs) state.dialogs = new Map();
  // Maps CDP targetId → sessionId for bridge-path sessions. Allows getOpen(wsUrl)
  // to find dialog state stored under sessionId by extracting targetId from the wsUrl.
  if (!state._targetIdToSessionId) state._targetIdToSessionId = new Map();

  function getOpen(wsUrlOrSid) {
    // Direct lookup (works for sessionId keys).
    const direct = state.dialogs.get(wsUrlOrSid);
    if (direct) return direct;
    // Fall back: extract targetId from a ws:// URL and look up the bridge sessionId.
    // Used by callers (e.g. popup integration test, wrapWithDialogGate) that have a
    // wsUrl rather than a sessionId. The _targetIdToSessionId map is populated by
    // attachToPageSession.
    const m = /\/devtools\/page\/([^/]+)$/.exec(wsUrlOrSid);
    if (m) {
      const sid = state._targetIdToSessionId.get(m[1]);
      if (sid) return state.dialogs.get(sid) || null;
    }
    return null;
  }

  function clear(wsUrlOrSid) {
    state.dialogs.delete(wsUrlOrSid);
    // If called with a wsUrl: also clear the bridge-path sessionId entry.
    const wsMatch = /\/devtools\/page\/([^/]+)$/.exec(wsUrlOrSid);
    if (wsMatch) {
      const sid = state._targetIdToSessionId.get(wsMatch[1]);
      if (sid) state.dialogs.delete(sid);
    }
  }

  // Track which page sessions have already had dialog setup applied.
  if (!state._dialogPageSessions) state._dialogPageSessions = new Set();

  async function attachToPageSession(pageSession) {
    const sid = pageSession.sessionId;
    if (state._dialogPageSessions.has(sid)) return;
    state._dialogPageSessions.add(sid);
    // Register targetId → sessionId so getOpen(wsUrl) can find dialog state
    // stored under sessionId by extracting targetId from the wsUrl.
    if (pageSession.targetId) {
      state._targetIdToSessionId.set(pageSession.targetId, sid);
    }
    await pageSession.send('Page.enable', {});
    await pageSession.send('DeviceAccess.enable', {});
    await pageSession.send('Fetch.enable', {
      handleAuthRequests: true,
      patterns: [{ urlPattern: '*' }],
    });
    await pageSession.send('Runtime.enable', {});
    await pageSession.send('Page.addScriptToEvaluateOnNewDocument', { source: SHIM_SOURCE });
    await pageSession.send('Runtime.addBinding', { name: '__dialogShim' });
    pageSession.onEvent((msg) => handleCdpEventForSession(sid, msg, pageSession.send));
  }

  // Equivalent of handleCdpEvent but keyed by sessionId. This is a faithful port —
  // every state.dialogs.get(wsUrl)/set(wsUrl, ...) becomes get(sid)/set(sid, ...).
  // sendPageCmd is pageSession.send — needed to continue intercepted Fetch requests.
  function handleCdpEventForSession(sid, msg, sendPageCmd) {
    if (msg.method === 'Runtime.bindingCalled') {
      if (msg.params.name !== '__dialogShim') return;
      let data;
      try { data = JSON.parse(msg.params.payload); } catch { return; }
      if (data.type === 'permission-request') {
        if (state.dialogs.has(sid)) {
          console.error(`[dialogs] permission request while dialog open on ${sid}; preserving original`);
          return;
        }
        state.dialogs.set(sid, {
          kind: 'permission',
          openedAt: Date.now(),
          payload: { name: data.name, origin: data.origin, jsApi: data.jsApi },
          staged: { _shimId: data.id },
        });
      }
      return;
    }
    if (msg.method === 'Page.javascriptDialogOpening') {
      if (state.dialogs.has(sid)) {
        console.error(`[dialogs] second javascriptDialogOpening on ${sid}; preserving original`);
        return;
      }
      const p = msg.params;
      state.dialogs.set(sid, {
        kind: p.type,
        openedAt: Date.now(),
        payload: {
          message: p.message, defaultPrompt: p.defaultPrompt, url: p.url, hasBrowserHandler: p.hasBrowserHandler,
        },
        staged: {},
      });
      return;
    }
    if (msg.method === 'DeviceAccess.deviceRequestPrompted') {
      if (state.dialogs.has(sid)) {
        console.error(`[dialogs] second prompt on ${sid}; preserving original`);
        return;
      }
      state.dialogs.set(sid, {
        kind: 'device-chooser',
        openedAt: Date.now(),
        payload: {
          requestId: msg.params.id,
          deviceKind: msg.params.deviceKind || 'usb',
          devices: msg.params.devices || [],
        },
        staged: {},
      });
      return;
    }
    if (msg.method === 'Page.javascriptDialogClosed') {
      state.dialogs.delete(sid);
      return;
    }
    if (msg.method === 'Page.frameNavigated') {
      if (msg.params.frame && !msg.params.frame.parentId) {
        state.dialogs.delete(sid);
      }
      return;
    }
    if (msg.method === 'Fetch.requestPaused') {
      const p = msg.params;
      // For non-auth Fetch.requestPaused, continue the request immediately.
      // Auth challenges arrive as Fetch.authRequired (see handler below), not
      // as Fetch.requestPaused with authChallenge — that field is never set by
      // Chrome when handleAuthRequests:true is enabled.
      if (sendPageCmd) {
        sendPageCmd('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
      }
      return;
    }
    if (msg.method === 'Fetch.authRequired') {
      const p = msg.params;
      if (state.dialogs.has(sid)) {
        console.error(`[dialogs] auth challenge while dialog open on ${sid}; preserving original`);
        return;
      }
      state.dialogs.set(sid, {
        kind: 'basic-auth',
        openedAt: Date.now(),
        payload: {
          requestId: p.requestId,
          origin: p.authChallenge.origin,
          scheme: p.authChallenge.scheme,
          realm: p.authChallenge.realm || '',
        },
        staged: {},
      });
      return;
    }
  }

  async function withDialogAwareness(actionName, wsUrl, args, fn) {
    const open = getOpen(wsUrl);
    const isDialogSelector = typeof args?.selector === 'string' && args.selector.startsWith('dialog::');

    if (open && PAGE_TARGET_ACTIONS.has(actionName) && !isDialogSelector) {
      return {
        refused: true,
        error: 'Page is behind a dialog. Handle dialog::accept or dialog::dismiss first.',
        dialog: open,
        artifacts: renderSyntheticArtifacts(open),
      };
    }

    if (!open && PAGE_TARGET_ACTIONS.has(actionName)) {
      const before = state.dialogs.has(wsUrl);
      const actionResult = await fn();
      const afterOpen = getOpen(wsUrl);
      if (!before && afterOpen) {
        return {
          midFlight: true,
          actionResult,
          dialog: afterOpen,
          artifacts: renderSyntheticArtifacts(afterOpen),
        };
      }
      return actionResult;
    }

    return fn();
  }

  async function withDialogAwarenessForSession(actionName, pageSession, args, fn) {
    const sid = pageSession && pageSession.sessionId;
    const open = sid ? state.dialogs.get(sid) : null;
    const isDialogSelector = typeof args?.selector === 'string' && args.selector.startsWith('dialog::');

    if (open && PAGE_TARGET_ACTIONS.has(actionName) && !isDialogSelector) {
      return {
        refused: true,
        error: 'Page is behind a dialog. Handle dialog::accept or dialog::dismiss first.',
        dialog: open,
        artifacts: renderSyntheticArtifacts(open),
      };
    }

    if (!open && PAGE_TARGET_ACTIONS.has(actionName)) {
      const before = sid ? state.dialogs.has(sid) : false;
      const actionResult = await fn();
      const afterOpen = sid ? state.dialogs.get(sid) : null;
      if (!before && afterOpen) {
        return {
          midFlight: true,
          actionResult,
          dialog: afterOpen,
          artifacts: renderSyntheticArtifacts(afterOpen),
        };
      }
      return actionResult;
    }

    return fn();
  }

  return { getOpen, clear, attachToPageSession, withDialogAwareness, withDialogAwarenessForSession };
}

module.exports = { attachDialogs, PAGE_TARGET_ACTIONS, BROWSER_TARGET_ACTIONS, DialogRefusedError };
