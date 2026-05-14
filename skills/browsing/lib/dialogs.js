'use strict';

const { renderSyntheticArtifacts } = require('./dialogs-render.js');

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

  function getOpen(wsUrl) {
    return state.dialogs.get(wsUrl) || null;
  }

  function clear(wsUrl) {
    state.dialogs.delete(wsUrl);
  }

  async function attachToConnection(conn, wsUrl) {
    await sendCdpCommand(wsUrl, 'Page.enable', {});
    await sendCdpCommand(wsUrl, 'DeviceAccess.enable', {});
    await sendCdpCommand(wsUrl, 'Fetch.enable', {
      handleAuthRequests: true,
      patterns: [{ urlPattern: '*' }],
    });
    conn.eventHandler = (msg) => handleCdpEvent(wsUrl, msg);
  }

  function handleCdpEvent(wsUrl, msg) {
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
    return fn();
  }

  return { getOpen, clear, attachToConnection, withDialogAwareness };
}

module.exports = { attachDialogs, PAGE_TARGET_ACTIONS, BROWSER_TARGET_ACTIONS };
