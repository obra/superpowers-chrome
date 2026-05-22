import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { makePageSessionFake } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachExtraction } = require('../../skills/browsing/lib/extraction.js');

describe('extraction', () => {
  function setup(handlers = {}) {
    const ps = makePageSessionFake(handlers);
    const getPageSession = async () => ps;
    return { ...attachExtraction({ getPageSession }), ps };
  }

  it('extractText sends the textContent expression and returns the value', async () => {
    const { extractText, ps } = setup({
      'Runtime.evaluate': () => ({ result: { value: 'hello' } })
    });
    const text = await extractText(0, '#headline');
    assert.equal(text, 'hello');
    const call = ps.calls.find(c => c.method === 'Runtime.evaluate');
    assert.ok(call, 'Runtime.evaluate should have been called');
    assert.match(call.params.expression, /\?\.textContent$/);
  });

  it('getHtml without selector returns documentElement.outerHTML', async () => {
    const { getHtml, ps } = setup({
      'Runtime.evaluate': () => ({ result: { value: '<html></html>' } })
    });
    const html = await getHtml(0);
    assert.equal(html, '<html></html>');
    const call = ps.calls.find(c => c.method === 'Runtime.evaluate');
    assert.equal(call.params.expression, 'document.documentElement.outerHTML');
  });

  it('getHtml with selector returns innerHTML', async () => {
    const { getHtml, ps } = setup({
      'Runtime.evaluate': () => ({ result: { value: '<p>x</p>' } })
    });
    const html = await getHtml(0, '.main');
    assert.equal(html, '<p>x</p>');
    const call = ps.calls.find(c => c.method === 'Runtime.evaluate');
    assert.match(call.params.expression, /\?\.innerHTML$/);
  });

  it('getAttribute sends the right expression and returns the value', async () => {
    const { getAttribute, ps } = setup({
      'Runtime.evaluate': () => ({ result: { value: '/foo' } })
    });
    const val = await getAttribute(0, 'a', 'href');
    assert.equal(val, '/foo');
    const call = ps.calls.find(c => c.method === 'Runtime.evaluate');
    assert.match(call.params.expression, /getAttribute\("href"\)$/);
  });

  it('extractText returns null when selector matches no element', async () => {
    // Optional chaining in the expression returns undefined from Runtime.evaluate
    // when the selector misses; the MCP layer must detect null/undefined and
    // return "Element not found: <selector>" rather than an empty content block.
    const { extractText } = setup({
      'Runtime.evaluate': () => ({ result: { value: undefined } })
    });
    const result = await extractText(0, '#missing');
    assert.equal(result, undefined);
  });

  it('getHtml returns null when selector matches no element', async () => {
    const { getHtml } = setup({
      'Runtime.evaluate': () => ({ result: { value: undefined } })
    });
    const result = await getHtml(0, '#missing');
    assert.equal(result, undefined);
  });

  it('extractText throws if exceptionDetails is set', async () => {
    const { extractText } = setup({
      'Runtime.evaluate': () => ({
        result: { value: undefined },
        exceptionDetails: { text: 'SyntaxError' }
      })
    });
    await assert.rejects(() => extractText(0, 'h1'));
  });

  it('getHtml throws if exceptionDetails is set', async () => {
    const { getHtml } = setup({
      'Runtime.evaluate': () => ({
        result: { value: undefined },
        exceptionDetails: { text: 'SyntaxError' }
      })
    });
    await assert.rejects(() => getHtml(0));
  });

  it('getAttribute throws if exceptionDetails is set', async () => {
    const { getAttribute } = setup({
      'Runtime.evaluate': () => ({
        result: { value: undefined },
        exceptionDetails: { text: 'SyntaxError' }
      })
    });
    await assert.rejects(() => getAttribute(0, 'a', 'href'));
  });
});
