import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { makePageSessionSpy, makeGetPageSession } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachExtraction } = require('../../skills/browsing/lib/extraction.js');

describe('extraction', () => {
  function setup(handlers = {}) {
    const ps = makePageSessionSpy(handlers);
    return { ...attachExtraction({ getPageSession: makeGetPageSession(ps) }), ps };
  }

  it('extractText sends the textContent expression', async () => {
    const { extractText, ps } = setup({
      'Runtime.evaluate': () => ({ result: { value: 'hello' } }),
    });
    const text = await extractText(0, '#headline');
    assert.equal(text, 'hello');
    assert.match(ps.calls[0].params.expression, /\?\.textContent$/);
  });

  it('getHtml without selector returns documentElement.outerHTML', async () => {
    const { getHtml, ps } = setup({
      'Runtime.evaluate': () => ({ result: { value: '<html></html>' } }),
    });
    await getHtml(0);
    assert.equal(ps.calls[0].params.expression, 'document.documentElement.outerHTML');
  });

  it('getHtml with selector returns innerHTML', async () => {
    const { getHtml, ps } = setup({
      'Runtime.evaluate': () => ({ result: { value: '<p>x</p>' } }),
    });
    await getHtml(0, '.main');
    assert.match(ps.calls[0].params.expression, /\?\.innerHTML$/);
  });

  it('getAttribute escapes the attribute name', async () => {
    const { getAttribute, ps } = setup({
      'Runtime.evaluate': () => ({ result: { value: '/foo' } }),
    });
    await getAttribute(0, 'a', 'href');
    assert.match(ps.calls[0].params.expression, /getAttribute\("href"\)$/);
  });
});
