'use strict';

function attachDialogs({ state, sendCdpCommand, resolveWsUrl }) {
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
  }

  return { getOpen, clear, attachToConnection };
}

module.exports = { attachDialogs };
