'use strict';

// Source of the shim that runs in every page at document_start.
// Exported as a string; `dialogs.attachToConnection` registers it via
// `Page.addScriptToEvaluateOnNewDocument`.

const SHIM_SOURCE = `
(() => {
  const BINDING = '__dialogShim';
  const pending = new Map();
  let nextId = 1;

  function ask(name, jsApi) {
    const id = String(nextId++);
    return new Promise((resolve) => {
      pending.set(id, resolve);
      window[BINDING](JSON.stringify({ type: 'permission-request', id, name, jsApi, origin: location.origin }));
    });
  }

  window[BINDING + '_resolve'] = (id, resolution) => {
    const r = pending.get(id);
    if (r) { pending.delete(id); r(resolution); }
  };

  // getUserMedia
  if (navigator.mediaDevices) {
    const origGetUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async function(constraints) {
      const name = constraints && constraints.video ? 'camera' : 'microphone';
      const decision = await ask(name, 'navigator.mediaDevices.getUserMedia');
      if (decision === 'grant') return origGetUM(constraints);
      throw new DOMException('Permission denied', 'NotAllowedError');
    };
  }

  // Notification.requestPermission
  if (typeof Notification !== 'undefined') {
    const orig = Notification.requestPermission.bind(Notification);
    Notification.requestPermission = async function(cb) {
      const decision = await ask('notifications', 'Notification.requestPermission');
      const result = decision === 'grant' ? 'granted' : 'denied';
      if (typeof cb === 'function') cb(result);
      return result;
    };
  }

  // Geolocation
  if (navigator.geolocation) {
    const origGet = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
    navigator.geolocation.getCurrentPosition = async function(success, error, opts) {
      const decision = await ask('geolocation', 'navigator.geolocation.getCurrentPosition');
      if (decision === 'grant') return origGet(success, error, opts);
      if (error) error(new DOMException('Permission denied', 'NotAllowedError'));
    };
  }

  // Clipboard
  if (navigator.clipboard) {
    if (navigator.clipboard.readText) {
      const orig = navigator.clipboard.readText.bind(navigator.clipboard);
      navigator.clipboard.readText = async function() {
        const decision = await ask('clipboard-read', 'navigator.clipboard.readText');
        if (decision === 'grant') return orig();
        throw new DOMException('Permission denied', 'NotAllowedError');
      };
    }
    if (navigator.clipboard.writeText) {
      const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = async function(text) {
        const decision = await ask('clipboard-write', 'navigator.clipboard.writeText');
        if (decision === 'grant') return orig(text);
        throw new DOMException('Permission denied', 'NotAllowedError');
      };
    }
  }
})();
`;

module.exports = { SHIM_SOURCE };
