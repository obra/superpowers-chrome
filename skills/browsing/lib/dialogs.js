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

function attachDialogs({ state, sendCdpCommand, _resolveWsUrl }) {
  if (!state.dialogs) state.dialogs = new Map();
  // Maps CDP targetId → sessionId for bridge-path sessions. Allows getOpen(wsUrl)
  // to find dialog state stored under sessionId by extracting targetId from the wsUrl.
  if (!state._targetIdToSessionId) state._targetIdToSessionId = new Map();

  function getOpen(wsUrlOrSid) {
    // Direct lookup (works for both wsUrl keys and sessionId keys).
    const direct = state.dialogs.get(wsUrlOrSid);
    if (direct) return direct;
    // Fall back: extract targetId from a ws:// URL and look up the bridge sessionId.
    const m = /\/devtools\/page\/([^/]+)$/.exec(wsUrlOrSid);
    if (m) {
      const sid = state._targetIdToSessionId.get(m[1]);
      if (sid) return state.dialogs.get(sid) || null;
    }
    return null;
  }

  function clear(wsUrl) {
    state.dialogs.delete(wsUrl);
    // Also clear the bridge-path sessionId entry (stored under sessionId, not wsUrl).
    // When a dialog was opened via the bridge, it is stored under sessionId; the
    // pool-path clear(wsUrl) call would miss it without this fallback.
    const m = /\/devtools\/page\/([^/]+)$/.exec(wsUrl);
    if (m) {
      const sid = state._targetIdToSessionId.get(m[1]);
      if (sid) state.dialogs.delete(sid);
    }
  }

  async function attachToConnection(conn, wsUrl) {
    await sendCdpCommand(wsUrl, 'Page.enable', {});
    await sendCdpCommand(wsUrl, 'DeviceAccess.enable', {});
    await sendCdpCommand(wsUrl, 'Fetch.enable', {
      handleAuthRequests: true,
      patterns: [{ urlPattern: '*' }],
    });
    await sendCdpCommand(wsUrl, 'Runtime.enable', {});
    await sendCdpCommand(wsUrl, 'Page.addScriptToEvaluateOnNewDocument', { source: SHIM_SOURCE });
    await sendCdpCommand(wsUrl, 'Runtime.addBinding', { name: '__dialogShim' });
    conn.eventHandler = (msg) => handleCdpEvent(wsUrl, msg);
  }

  function handleCdpEvent(wsUrl, msg) {
    if (msg.method === 'Runtime.bindingCalled') {
      if (msg.params.name !== '__dialogShim') return;
      let data;
      try { data = JSON.parse(msg.params.payload); } catch { return; }
      if (data.type === 'permission-request') {
        if (state.dialogs.has(wsUrl)) {
          console.error(`[dialogs] permission request while dialog open on ${wsUrl}; preserving original`);
          return;
        }
        state.dialogs.set(wsUrl, {
          kind: 'permission',
          openedAt: Date.now(),
          payload: { name: data.name, origin: data.origin, jsApi: data.jsApi },
          staged: { _shimId: data.id },
        });
      }
      return;
    }
    if (msg.method === 'Page.javascriptDialogOpening') {
      if (state.dialogs.has(wsUrl)) {
        console.error(`[dialogs] second javascriptDialogOpening on ${wsUrl}; preserving original`);
        return;
      }
      const p = msg.params;
      state.dialogs.set(wsUrl, {
        kind: p.type, // CDP uses 'alert' | 'confirm' | 'prompt' | 'beforeunload'
        openedAt: Date.now(),
        payload: {
          message: p.message,
          defaultPrompt: p.defaultPrompt,
          url: p.url,
          hasBrowserHandler: p.hasBrowserHandler,
        },
        staged: {},
      });
      return;
    }
    if (msg.method === 'DeviceAccess.deviceRequestPrompted') {
      if (state.dialogs.has(wsUrl)) {
        console.error(`[dialogs] second prompt on ${wsUrl}; preserving original`);
        return;
      }
      state.dialogs.set(wsUrl, {
        kind: 'device-chooser',
        openedAt: Date.now(),
        payload: {
          requestId: msg.params.id,
          deviceKind: msg.params.deviceKind || 'usb', // CDP older versions may omit; default to usb
          devices: msg.params.devices || [],
        },
        staged: {},
      });
      return;
    }
    if (msg.method === 'Page.javascriptDialogClosed') {
      state.dialogs.delete(wsUrl);
      return;
    }
    if (msg.method === 'Page.frameNavigated') {
      if (msg.params.frame && !msg.params.frame.parentId) {
        state.dialogs.delete(wsUrl);
      }
      return;
    }
    if (msg.method === 'Fetch.requestPaused') {
      const p = msg.params;
      if (p.authChallenge) {
        if (state.dialogs.has(wsUrl)) {
          console.error(`[dialogs] auth challenge while dialog open on ${wsUrl}; preserving original`);
          return;
        }
        state.dialogs.set(wsUrl, {
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
      } else {
        sendCdpCommand(wsUrl, 'Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
      }
      return;
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
    pageSession.onEvent((msg) => handleCdpEventForSession(sid, msg));
  }

  // Equivalent of handleCdpEvent but keyed by sessionId. This is a faithful port —
  // every state.dialogs.get(wsUrl)/set(wsUrl, ...) becomes get(sid)/set(sid, ...).
  function handleCdpEventForSession(sid, msg) {
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
      if (p.authChallenge) {
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
      }
      // For non-auth Fetch.requestPaused, the wsUrl path calls Fetch.continueRequest via sendCdpCommand.
      // In the pageSession path, the dialog router will handle continuation via pageSession.send when migrated in D3.
      // For now, do nothing here — non-auth requests will block until the dialog router catches up.
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

  return { getOpen, clear, attachToConnection, attachToPageSession, withDialogAwareness, withDialogAwarenessForSession };
}

module.exports = { attachDialogs, PAGE_TARGET_ACTIONS, BROWSER_TARGET_ACTIONS, DialogRefusedError };
