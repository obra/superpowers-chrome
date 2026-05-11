const { KEY_DEFINITIONS, charToKeyDef } = require('./key-definitions');
const { getElementSelector } = require('./element-selector');
const { throwIfExceptionDetails } = require('./cdp-utils');

/**
 * Keyboard and text-input actions: keyboardPress (named keys + modifiers),
 * fill (smart text input with \t/\n handling), and humanType (realistic
 * per-keystroke timing for bot-detection-resistant input).
 *
 * The headless/headed split inside humanType is load-bearing: in headed
 * mode we send full keyDown/keyUp events so JS keyboard event handlers
 * fire (and bot-detection sees them), but in headless mode rawKeyDown
 * triggers Chrome browser shortcuts that navigate away from the page —
 * so headless skips key events and relies on `Input.insertText` plus
 * per-character timing for whatever realism it can offer.
 *
 * Helpers accept `tabIndexOrPageSession` (the orchestrator's
 * `getPageSession` resolver handles all shapes) and route through
 * `pageSession.send`. `click` is the mouse-side click — humanType uses
 * it to focus a target before typing.
 */
function attachKeyboardInput({ state, getPageSession, click }) {
  /**
   * Press a named key (Tab, Enter, F1-F12, arrows, etc.) with optional
   * modifiers. Sends both keyDown and keyUp; if the key has a `text`
   * field (Tab → '\t', Enter → '\r'), it's included on keyDown so the
   * browser fires the matching `input`/`keypress` events that form
   * submission depends on.
   */
  async function keyboardPress(tabIndexOrPageSession, keyName, modifiers = {}) {
    const ps = await getPageSession(tabIndexOrPageSession);

    const keyDef = KEY_DEFINITIONS[keyName];
    if (!keyDef) {
      throw new Error(`Unknown key: ${keyName}. Supported keys: ${Object.keys(KEY_DEFINITIONS).join(', ')}`);
    }

    let modifierFlags = 0;
    if (modifiers.alt) modifierFlags |= 1;
    if (modifiers.ctrl) modifierFlags |= 2;
    if (modifiers.meta) modifierFlags |= 4;
    if (modifiers.shift) modifierFlags |= 8;

    await ps.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: keyDef.key,
      code: keyDef.code,
      windowsVirtualKeyCode: keyDef.keyCode,
      nativeVirtualKeyCode: keyDef.keyCode,
      modifiers: modifierFlags,
      ...(keyDef.text && { text: keyDef.text }),
    });

    await ps.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: keyDef.key,
      code: keyDef.code,
      windowsVirtualKeyCode: keyDef.keyCode,
      nativeVirtualKeyCode: keyDef.keyCode,
      modifiers: modifierFlags,
    });

    return { pressed: keyName, modifiers };
  }

  /**
   * Smart text input. If `selector` is supplied, focuses the element
   * (via JS focus to avoid mouse-click side effects). Then types the
   * value, treating \t as Tab, \n as Enter (unless current focus is a
   * <textarea>, in which case \n is inserted as a literal newline).
   * Buffers runs of plain characters into single insertText calls.
   *
   * Special characters in `value`: \t = Tab, \n = Enter (or newline in textarea).
   * Literal "\\t" / "\\n" in the input are also normalised — MCP payloads
   * often arrive with the escapes un-evaluated.
   */
  async function fill(tabIndexOrPageSession, selector, value) {
    const ps = await getPageSession(tabIndexOrPageSession);

    if (selector) {
      const focusJs = `
        (() => {
          const el = ${getElementSelector(selector)};
          if (!el) return { success: false, error: 'Element not found' };
          el.focus();
          return { success: true, focused: document.activeElement === el };
        })()
      `;
      const focusResult = await ps.send('Runtime.evaluate', {
        expression: focusJs,
        returnByValue: true,
      });
      throwIfExceptionDetails(focusResult);
      if (!focusResult.result?.value?.success) {
        throw new Error(focusResult.result?.value?.error || 'Failed to focus element');
      }
    }

    // Normalise literal escape sequences from MCP payloads.
    const processedValue = value
      .replace(/\\t/g, '\t')
      .replace(/\\n/g, '\n');

    const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

    let buffer = '';

    for (let i = 0; i < processedValue.length; i++) {
      const char = processedValue[i];

      if (char === '\t') {
        if (buffer) {
          await ps.send('Input.insertText', { text: buffer });
          await settle();
          buffer = '';
        }
        await keyboardPress(ps, 'Tab');
        await settle();
      } else if (char === '\n') {
        if (buffer) {
          await ps.send('Input.insertText', { text: buffer });
          await settle();
          buffer = '';
        }
        // Re-check focus — Tab may have shifted it to a different element type.
        const currentFocus = await ps.send('Runtime.evaluate', {
          expression: `({ isTextarea: document.activeElement?.tagName === 'TEXTAREA' })`,
          returnByValue: true,
        });
        throwIfExceptionDetails(currentFocus);
        const currentlyInTextarea = currentFocus.result?.value?.isTextarea || false;

        if (currentlyInTextarea) {
          await ps.send('Input.insertText', { text: '\n' });
        } else {
          await keyboardPress(ps, 'Enter');
        }
        await settle();
      } else {
        buffer += char;
      }
    }

    if (buffer) {
      await ps.send('Input.insertText', { text: buffer });
    }

    return { typed: true, value };
  }

  /**
   * Type text character-by-character with realistic per-keystroke timing.
   * In headed mode, sends keyDown/keyUp around each insertText so JS
   * keyboard events fire — important for bot-detection-resistant input.
   * In headless mode, skips key events because rawKeyDown is interpreted
   * as a browser shortcut and navigates away from the page; relies on
   * insertText + per-character delay for whatever realism it can offer.
   *
   * @param {object} options
   * @param {number} [options.delay=80] - Base delay between keystrokes (ms)
   * @param {number} [options.jitter=80] - Random jitter range (ms) — total ~80–160ms/char
   */
  async function humanType(tabIndexOrPageSession, selector, text, options = {}) {
    const ps = await getPageSession(tabIndexOrPageSession);
    const delay = options.delay !== undefined ? options.delay : 80;
    const jitter = options.jitter !== undefined ? options.jitter : 80;

    if (selector) {
      await click(ps, selector);
    }

    for (const char of text) {
      const keyDef = charToKeyDef(char);

      if (keyDef.special) {
        // \n / \t — delegate to keyboardPress for the named-key path.
        await keyboardPress(ps, keyDef.special);
      } else {
        const sendKeyEvents = !state.chromeHeadless;
        const modifiers = keyDef.shift ? 8 : 0; // 8 = Shift

        if (sendKeyEvents) {
          if (keyDef.shift) {
            await ps.send('Input.dispatchKeyEvent', {
              type: 'keyDown',
              key: 'Shift',
              code: 'ShiftLeft',
              windowsVirtualKeyCode: 16,
              nativeVirtualKeyCode: 16,
              modifiers,
            });
          }

          await ps.send('Input.dispatchKeyEvent', {
            type: 'rawKeyDown',
            key: keyDef.key,
            code: keyDef.code,
            windowsVirtualKeyCode: keyDef.keyCode,
            nativeVirtualKeyCode: keyDef.keyCode,
            modifiers,
          });
        }

        // insertText drives the character into the field reliably in both modes.
        await ps.send('Input.insertText', {
          text: keyDef.text,
        });

        if (sendKeyEvents) {
          await ps.send('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: keyDef.key,
            code: keyDef.code,
            windowsVirtualKeyCode: keyDef.keyCode,
            nativeVirtualKeyCode: keyDef.keyCode,
            modifiers,
          });

          if (keyDef.shift) {
            await ps.send('Input.dispatchKeyEvent', {
              type: 'keyUp',
              key: 'Shift',
              code: 'ShiftLeft',
              windowsVirtualKeyCode: 16,
              nativeVirtualKeyCode: 16,
              modifiers: 0,
            });
          }
        }
      }

      if (delay > 0 || jitter > 0) {
        const wait = delay + Math.random() * jitter;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }

    return { typed: text, chars: text.length };
  }

  return { keyboardPress, fill, humanType };
}

module.exports = { attachKeyboardInput };
