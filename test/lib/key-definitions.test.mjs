import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { KEY_DEFINITIONS, charToKeyDef } = require('../../skills/browsing/lib/key-definitions.js');

describe('key-definitions', () => {
  it('KEY_DEFINITIONS includes Tab, Enter, Escape with the expected key codes', () => {
    assert.equal(KEY_DEFINITIONS.Tab.keyCode, 9);
    assert.equal(KEY_DEFINITIONS.Enter.keyCode, 13);
    assert.equal(KEY_DEFINITIONS.Escape.keyCode, 27);
    assert.equal(KEY_DEFINITIONS.Tab.text, '\t');
    assert.equal(KEY_DEFINITIONS.Enter.text, '\r');
  });

  it('KEY_DEFINITIONS includes all F1-F12', () => {
    for (let i = 1; i <= 12; i++) {
      assert.ok(KEY_DEFINITIONS[`F${i}`], `missing F${i}`);
    }
  });

  it('charToKeyDef maps lowercase letters', () => {
    assert.deepEqual(charToKeyDef('a'), {
      key: 'a', code: 'KeyA', keyCode: 65, text: 'a', shift: false
    });
  });

  it('charToKeyDef maps uppercase letters with shift: true', () => {
    const def = charToKeyDef('A');
    assert.equal(def.code, 'KeyA');
    assert.equal(def.shift, true);
  });

  it('charToKeyDef maps shifted symbols', () => {
    const def = charToKeyDef('!');
    assert.equal(def.code, 'Digit1');
    assert.equal(def.shift, true);
  });

  it('charToKeyDef maps newline and tab to special routing', () => {
    assert.deepEqual(charToKeyDef('\n'), { special: 'Enter' });
    assert.deepEqual(charToKeyDef('\t'), { special: 'Tab' });
  });

  it('charToKeyDef maps space', () => {
    const def = charToKeyDef(' ');
    assert.equal(def.code, 'Space');
    assert.equal(def.text, ' ');
  });

  it('charToKeyDef maps digits', () => {
    assert.equal(charToKeyDef('5').code, 'Digit5');
  });

  it('charToKeyDef maps unshifted punctuation', () => {
    assert.equal(charToKeyDef('-').code, 'Minus');
    assert.equal(charToKeyDef('.').code, 'Period');
  });
});
