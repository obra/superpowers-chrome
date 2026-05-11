import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { makePageSessionSpy, makeGetPageSession } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachKeyboardInput } = require('../../skills/browsing/lib/keyboard-input.js');

describe('keyboard-input', () => {
  function setup({ headless = true, handlers = {}, click = async () => ({ clicked: true }) } = {}) {
    const state = { chromeHeadless: headless };
    const ps = makePageSessionSpy({
      'Runtime.evaluate': () => ({ result: { value: { isTextarea: false } } }),
      'Input.insertText': () => ({}),
      'Input.dispatchKeyEvent': () => ({}),
      ...handlers,
    });
    return {
      ...attachKeyboardInput({ state, getPageSession: makeGetPageSession(ps), click }),
      ps,
      state,
    };
  }

  it('keyboardPress(Enter) sends keyDown + keyUp with text="\\r"', async () => {
    const { keyboardPress, ps } = setup();
    await keyboardPress(0, 'Enter');
    const keys = ps.calls.filter((c) => c.method === 'Input.dispatchKeyEvent');
    assert.equal(keys.length, 2);
    assert.equal(keys[0].params.type, 'keyDown');
    assert.equal(keys[0].params.text, '\r');
    assert.equal(keys[1].params.type, 'keyUp');
  });

  it('keyboardPress with modifiers sets the modifier bitmask', async () => {
    const { keyboardPress, ps } = setup();
    await keyboardPress(0, 'Tab', { shift: true });
    const keys = ps.calls.filter((c) => c.method === 'Input.dispatchKeyEvent');
    assert.equal(keys[0].params.modifiers, 8); // shift = 8
  });

  it('keyboardPress throws on unknown key', async () => {
    const { keyboardPress } = setup();
    await assert.rejects(() => keyboardPress(0, 'NotAKey'), /Unknown key/);
  });

  it('fill in headed mode types each char as insertText (not keyDown for plain chars)', async () => {
    const { fill, ps } = setup({ headless: false });
    await fill(0, null, 'abc');
    const inserts = ps.calls.filter((c) => c.method === 'Input.insertText');
    // fill buffers and sends one insertText with the full string
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].params.text, 'abc');
  });

  it('fill splits on \\t and emits Tab key press between segments', async () => {
    const { fill, ps } = setup();
    await fill(0, null, 'foo\tbar');
    const inserts = ps.calls.filter((c) => c.method === 'Input.insertText');
    const keys = ps.calls.filter((c) => c.method === 'Input.dispatchKeyEvent');
    assert.deepEqual(inserts.map((c) => c.params.text), ['foo', 'bar']);
    assert.equal(keys.length, 2);
    assert.equal(keys[0].params.code, 'Tab');
  });

  it('fill in textarea inserts \\n as literal newline rather than Enter', async () => {
    const { fill, ps } = setup({
      handlers: {
        'Runtime.evaluate': () => ({ result: { value: { isTextarea: true } } }),
      },
    });
    await fill(0, null, 'a\nb');
    const inserts = ps.calls.filter((c) => c.method === 'Input.insertText');
    // 'a' buffered + flushed; '\n' inserted as literal; 'b' buffered + flushed
    assert.deepEqual(inserts.map((c) => c.params.text), ['a', '\n', 'b']);
  });

  it('humanType in headed mode sends keyDown/keyUp around each char', async () => {
    const { humanType, ps } = setup({ headless: false });
    await humanType(0, null, 'ab', { delay: 0, jitter: 0 });
    const inserts = ps.calls.filter((c) => c.method === 'Input.insertText');
    const keys = ps.calls.filter((c) => c.method === 'Input.dispatchKeyEvent');
    assert.equal(inserts.length, 2);
    // 2 chars × (rawKeyDown + keyUp) = 4 key events
    assert.equal(keys.length, 4);
  });

  it('humanType in headless mode skips keyDown/keyUp (rawKeyDown navigates away)', async () => {
    const { humanType, ps } = setup({ headless: true });
    await humanType(0, null, 'ab', { delay: 0, jitter: 0 });
    const keys = ps.calls.filter((c) => c.method === 'Input.dispatchKeyEvent');
    assert.equal(keys.length, 0);
  });
});
