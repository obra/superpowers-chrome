/**
 * CDP key definitions for keyboard.press support (JRV-127).
 *
 * Maps human-readable key names to the CDP `Input.dispatchKeyEvent` payload
 * fields. Keys with a `text` property trigger native browser behaviors
 * (form submit on Enter, focus advance on Tab) — keys without `text` are
 * dispatched as `rawKeyDown`/`keyUp` only.
 */

const KEY_DEFINITIONS = {
  // Navigation keys - text property needed for Enter/Tab to trigger native behaviors
  'Tab': { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t' },
  'Enter': { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  'Escape': { key: 'Escape', code: 'Escape', keyCode: 27 },
  'Backspace': { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  'Delete': { key: 'Delete', code: 'Delete', keyCode: 46 },
  'Space': { key: ' ', code: 'Space', keyCode: 32, text: ' ' },

  // Arrow keys
  'ArrowUp': { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  'ArrowLeft': { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  'ArrowRight': { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },

  // Modifier keys
  'Shift': { key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
  'Control': { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  'Alt': { key: 'Alt', code: 'AltLeft', keyCode: 18 },
  'Meta': { key: 'Meta', code: 'MetaLeft', keyCode: 91 },

  // Function keys
  'F1': { key: 'F1', code: 'F1', keyCode: 112 },
  'F2': { key: 'F2', code: 'F2', keyCode: 113 },
  'F3': { key: 'F3', code: 'F3', keyCode: 114 },
  'F4': { key: 'F4', code: 'F4', keyCode: 115 },
  'F5': { key: 'F5', code: 'F5', keyCode: 116 },
  'F6': { key: 'F6', code: 'F6', keyCode: 117 },
  'F7': { key: 'F7', code: 'F7', keyCode: 118 },
  'F8': { key: 'F8', code: 'F8', keyCode: 119 },
  'F9': { key: 'F9', code: 'F9', keyCode: 120 },
  'F10': { key: 'F10', code: 'F10', keyCode: 121 },
  'F11': { key: 'F11', code: 'F11', keyCode: 122 },
  'F12': { key: 'F12', code: 'F12', keyCode: 123 },

  // Other
  'Home': { key: 'Home', code: 'Home', keyCode: 36 },
  'End': { key: 'End', code: 'End', keyCode: 35 },
  'PageUp': { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  'PageDown': { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  'Insert': { key: 'Insert', code: 'Insert', keyCode: 45 },
};

module.exports = { KEY_DEFINITIONS };
