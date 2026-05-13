'use strict';

function attachDialogs({ state, sendCdpCommand, resolveWsUrl }) {
  if (!state.dialogs) state.dialogs = new Map();

  function getOpen(wsUrl) {
    return state.dialogs.get(wsUrl) || null;
  }

  function clear(wsUrl) {
    state.dialogs.delete(wsUrl);
  }

  return { getOpen, clear };
}

module.exports = { attachDialogs };
