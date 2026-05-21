import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { makePageSessionFake } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachSelectOption } = require('../../skills/browsing/lib/select-option.js');

describe('selectOption (jsdom)', () => {
  // Build a fake pageSession that evaluates Runtime.evaluate against a jsdom DOM.
  function setup(html) {
    // runScripts: 'dangerously' is required for window.eval to have access to
    // document and the DOM globals — the standard jsdom approach for unit tests
    // that exercise page-side code paths.
    const dom = new JSDOM(html, { runScripts: 'dangerously' });
    const { window } = dom;
    const ps = makePageSessionFake({
      'Runtime.evaluate': (params) => {
        // Evaluate the expression directly in jsdom's window context.
        // IIFEs evaluate to their return value; plain expressions evaluate
        // to their value. No function wrapper needed.
        const result = window.eval(params.expression);
        // wrap to match returnByValue: true CDP shape
        return { result: { value: result } };
      }
    });
    const getPageSession = async () => ps;
    return attachSelectOption({ getPageSession });
  }

  const SINGLE = `<select id="single">
    <option value="a">Apple</option>
    <option value="b">Banana</option>
    <option value="c">Cherry</option>
  </select>`;

  const MULTI = `<select id="multi" multiple>
    <option value="a">Apple</option>
    <option value="b">Banana</option>
    <option value="c">Cherry</option>
  </select>`;

  it('matches by value attribute', async () => {
    const { selectOption } = setup(SINGLE);
    const r = await selectOption(0, '#single', 'b');
    assert.equal(r.success, true);
    assert.equal(r.matched[0].value, 'b');
  });

  it('matches by visible label when value does not match', async () => {
    const { selectOption } = setup(SINGLE);
    const r = await selectOption(0, '#single', 'Cherry');
    assert.equal(r.matched[0].value, 'c');
    assert.equal(r.matched[0].text, 'Cherry');
  });

  it('multi-select with array selects multiple options', async () => {
    const { selectOption } = setup(MULTI);
    const r = await selectOption(0, '#multi', ['a', 'c']);
    assert.equal(r.matched.length, 2);
    assert.equal(r.matched[0].value, 'a');
    assert.equal(r.matched[1].value, 'c');
  });

  it('throws when array passed to non-multiple select', async () => {
    const { selectOption } = setup(SINGLE);
    await assert.rejects(() => selectOption(0, '#single', ['a', 'b']), /non-multiple/);
  });

  it('throws when no option matches', async () => {
    const { selectOption } = setup(SINGLE);
    await assert.rejects(() => selectOption(0, '#single', 'nope'), /No matching option/);
  });

  it('replace semantics: previous selections are cleared', async () => {
    // Pre-select option 'a', then call selectOption with 'b'. Only 'b' should be selected.
    const { selectOption } = setup(MULTI);
    // Prime: select all three.
    await selectOption(0, '#multi', ['a', 'b', 'c']);
    // Replace: select only 'b'.
    const r = await selectOption(0, '#multi', ['b']);
    assert.equal(r.matched.length, 1);
    assert.equal(r.matched[0].value, 'b');
  });
});
