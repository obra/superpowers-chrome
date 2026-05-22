import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { makePageSessionFake } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachKeyboardInput } = require('../../skills/browsing/lib/keyboard-input.js');
const { attachDialogs } = require('../../skills/browsing/lib/dialogs.js');

describe('keyboard-input', () => {
  function setup({ headless = true, handlers = {}, click = async () => ({ clicked: true }) } = {}) {
    const state = { chromeHeadless: headless };
    const ps = makePageSessionFake({
      'Runtime.evaluate': () => ({ result: { value: { isTextarea: false } } }),
      'Input.insertText': () => ({}),
      'Input.dispatchKeyEvent': () => ({}),
      ...handlers
    });
    const getPageSession = async () => ps;
    return {
      ...attachKeyboardInput({ state, getPageSession, click }),
      ps,
      state
    };
  }

  it('keyboardPress(Enter) sends keyDown + keyUp with text="\\r"', async () => {
    const { keyboardPress, ps } = setup();
    await keyboardPress(0, 'Enter');
    const keys = ps.calls.filter(c => c.method === 'Input.dispatchKeyEvent');
    assert.equal(keys.length, 2);
    assert.equal(keys[0].params.type, 'keyDown');
    assert.equal(keys[0].params.text, '\r');
    assert.equal(keys[1].params.type, 'keyUp');
  });

  it('keyboardPress with modifiers sets the modifier bitmask', async () => {
    const { keyboardPress, ps } = setup();
    await keyboardPress(0, 'Tab', { shift: true });
    const keys = ps.calls.filter(c => c.method === 'Input.dispatchKeyEvent');
    assert.equal(keys[0].params.modifiers, 8); // shift = 8
  });

  it('keyboardPress throws on unknown key', async () => {
    const { keyboardPress } = setup();
    await assert.rejects(() => keyboardPress(0, 'NotAKey'), /Unknown key/);
  });

  it('keyboardPress accepts a lowercase letter key', async () => {
    const { keyboardPress, ps } = setup();
    await keyboardPress(0, 'a');
    const keys = ps.calls.filter(c => c.method === 'Input.dispatchKeyEvent');
    assert.equal(keys.length, 2);
    assert.equal(keys[0].params.key, 'a');
    assert.equal(keys[0].params.code, 'KeyA');
  });

  it('keyboardPress accepts an uppercase letter key', async () => {
    const { keyboardPress, ps } = setup();
    await keyboardPress(0, 'Z');
    const keys = ps.calls.filter(c => c.method === 'Input.dispatchKeyEvent');
    assert.equal(keys.length, 2);
    assert.equal(keys[0].params.key, 'Z');
    assert.equal(keys[0].params.code, 'KeyZ');
  });

  it('keyboardPress accepts a digit key', async () => {
    const { keyboardPress, ps } = setup();
    await keyboardPress(0, '5');
    const keys = ps.calls.filter(c => c.method === 'Input.dispatchKeyEvent');
    assert.equal(keys.length, 2);
    assert.equal(keys[0].params.key, '5');
    assert.equal(keys[0].params.code, 'Digit5');
  });

  it('keyboardPress accepts a punctuation key', async () => {
    const { keyboardPress, ps } = setup();
    await keyboardPress(0, '.');
    const keys = ps.calls.filter(c => c.method === 'Input.dispatchKeyEvent');
    assert.equal(keys.length, 2);
    assert.equal(keys[0].params.key, '.');
  });

  it('keyboardPress with shift+letter sends uppercase text so CDP inserts the right character', async () => {
    const { keyboardPress, ps } = setup();
    await keyboardPress(0, 'a', { shift: true });
    const keys = ps.calls.filter(c => c.method === 'Input.dispatchKeyEvent');
    const keyDown = keys.find(k => k.params.type === 'keyDown');
    assert.ok(keyDown, 'keyDown event should be sent');
    assert.equal(keyDown.params.text, 'A', 'shift+a should send uppercase text "A"');
    assert.equal(keyDown.params.modifiers, 8, 'shift modifier flag (8) should be set');
  });

  it('keyboardPress without shift sends lowercase text for a letter', async () => {
    const { keyboardPress, ps } = setup();
    await keyboardPress(0, 'a');
    const keys = ps.calls.filter(c => c.method === 'Input.dispatchKeyEvent');
    const keyDown = keys.find(k => k.params.type === 'keyDown');
    assert.ok(keyDown, 'keyDown event should be sent');
    assert.equal(keyDown.params.text, 'a', 'plain a should send lowercase text "a"');
  });

  it('keyboardPress shift+Enter still sends \\r (non-letter text unchanged by shift)', async () => {
    const { keyboardPress, ps } = setup();
    await keyboardPress(0, 'Enter', { shift: true });
    const keys = ps.calls.filter(c => c.method === 'Input.dispatchKeyEvent');
    const keyDown = keys.find(k => k.params.type === 'keyDown');
    assert.ok(keyDown, 'keyDown event should be sent');
    assert.equal(keyDown.params.text, '\r', 'shift+Enter text should remain \\r');
  });

  it('fill in headed mode types each char as insertText (not keyDown for plain chars)', async () => {
    // (humanType is per-char keyDown/keyUp; fill is buffered insertText.)
    const { fill, ps } = setup({ headless: false });
    await fill(0, null, 'abc');
    const inserts = ps.calls.filter(c => c.method === 'Input.insertText');
    // fill buffers and sends one insertText with the full string
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].params.text, 'abc');
  });

  it('fill splits on \\t and emits Tab key press between segments', async () => {
    const { fill, ps } = setup();
    await fill(0, null, 'foo\tbar');
    const calls = ps.calls;
    // insertText('foo'), keyDown(Tab), keyUp(Tab), insertText('bar')
    const inserts = calls.filter(c => c.method === 'Input.insertText');
    const keys = calls.filter(c => c.method === 'Input.dispatchKeyEvent');
    assert.deepEqual(inserts.map(c => c.params.text), ['foo', 'bar']);
    assert.equal(keys.length, 2);
    assert.equal(keys[0].params.code, 'Tab');
  });

  it('fill in textarea inserts \\n as literal newline rather than Enter', async () => {
    const { fill, ps } = setup({
      handlers: {
        'Runtime.evaluate': () => ({ result: { value: { isTextarea: true } } })
      }
    });
    await fill(0, null, 'a\nb');
    const calls = ps.calls;
    const inserts = calls.filter(c => c.method === 'Input.insertText');
    // 'a' buffered + flushed; '\n' inserted as literal; 'b' buffered + flushed
    assert.deepEqual(inserts.map(c => c.params.text), ['a', '\n', 'b']);
  });

  it('humanType in headed mode sends keyDown/keyUp around each char', async () => {
    const { humanType, ps } = setup({ headless: false });
    await humanType(0, null, 'ab', { delay: 0, jitter: 0 });
    const inserts = ps.calls.filter(c => c.method === 'Input.insertText');
    const keys = ps.calls.filter(c => c.method === 'Input.dispatchKeyEvent');
    assert.equal(inserts.length, 2);
    // 2 chars × (rawKeyDown + keyUp) = 4 key events
    assert.equal(keys.length, 4);
  });

  it('humanType in headless mode skips keyDown/keyUp (rawKeyDown navigates away)', async () => {
    const { humanType, ps } = setup({ headless: true });
    await humanType(0, null, 'ab', { delay: 0, jitter: 0 });
    const keys = ps.calls.filter(c => c.method === 'Input.dispatchKeyEvent');
    assert.equal(keys.length, 0);
  });
});

describe('keyboard-input fill routes dialog::* selectors', () => {
  it('type dialog::prompt stages text without DOM resolution', async () => {
    const ps = makePageSessionFake();
    const dialogState = { kind: 'prompt', payload: { message: 'q', url: '', defaultPrompt: '', hasBrowserHandler: false }, staged: {} };
    const dialogs = { getOpen: () => dialogState, clear: () => {} };
    const getPageSession = async () => ps;
    const { fill } = attachKeyboardInput({
      state: {}, getPageSession, click: async () => {}, dialogs,
    });
    await fill(0, 'dialog::prompt', 'answer');
    assert.equal(dialogState.staged.promptText, 'answer');
    assert.ok(!ps.calls.some(c => c.method === 'Runtime.evaluate'));
  });
});

describe('keyboard-input humanType routes dialog::* selectors', () => {
  it('humanType with dialog::username selector stages basic-auth username via the dialog router', async () => {
    const ps = makePageSessionFake({}, { sessionId: 'S1', targetId: 'T1' });
    const getPageSession = async () => ps;
    const state = { dialogs: new Map([['S1', { kind: 'basic-auth', payload: {}, staged: {} }]]) };
    const dialogs = attachDialogs({ state });

    const { humanType } = attachKeyboardInput({ state, getPageSession, click: async () => {}, dialogs });

    await humanType(0, 'dialog::username', 'alice');

    assert.equal(state.dialogs.get('S1').staged.username, 'alice');
  });
});
