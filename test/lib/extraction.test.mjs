import { afterEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { makePageSessionFake } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachExtraction } = require('../../skills/browsing/lib/extraction.js');

const ENV = 'SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE';

function setup(handlers = {}) {
  const ps = makePageSessionFake(handlers);
  const getPageSession = async () => ps;
  return { ...attachExtraction({ getPageSession }), ps };
}

describe('extraction', () => {
  it('extractText sends a textContent expression and returns the value', async () => {
    const { extractText, ps } = setup({
      'Runtime.evaluate': () => ({ result: { value: 'hello' } })
    });
    const text = await extractText(0, '#headline');
    assert.equal(text, 'hello');
    const call = ps.calls.find(c => c.method === 'Runtime.evaluate');
    assert.ok(call, 'Runtime.evaluate should have been called');
    // Reads off a clone with data-sen-secret descendants stripped (see the
    // credential-guard tests below) rather than the bare `?.textContent` of
    // pre-fix code, so this checks for the operation rather than the exact
    // expression shape.
    assert.match(call.params.expression, /clone\.textContent/);
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
    assert.match(call.params.expression, /getAttribute\("href"\)/);
    assert.match(call.params.expression, /data-sen-secret/, 'must guard the marker before reading any attribute');
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

// obra#50 follow-up: extractText/getAttribute/getSanitizedHtml each ask the
// page (via the expression they send) whether the resolved element itself
// carries data-sen-secret, and refuse on a `{ __secretMarked: true }`
// sentinel reply instead of returning it as if it were an ordinary result.
// The page-side clone-and-strip logic that produces that sentinel (or a
// descendant-stripped value) only runs in a real browser — see
// test/credential-guard-mcp.test.mjs for that end-to-end proof; these tests
// cover the Node-side wiring: the right expression shape goes out, and the
// sentinel is never handed back to the caller as data.
describe('extractText / getAttribute / getSanitizedHtml: data-sen-secret guard', () => {
  afterEach(() => { delete process.env[ENV]; });

  it('extractText refuses when the resolved element itself is marked', async () => {
    const { extractText } = setup({
      'Runtime.evaluate': () => ({ result: { value: { __secretMarked: true } } })
    });
    await assert.rejects(() => extractText(0, '#secret'), /extract refused.*data-sen-secret/);
  });

  it('getAttribute refuses when the resolved element itself is marked', async () => {
    const { getAttribute } = setup({
      'Runtime.evaluate': () => ({ result: { value: { __secretMarked: true } } })
    });
    await assert.rejects(() => getAttribute(0, '#secret', 'value'), /attr refused.*data-sen-secret/);
  });

  it('getSanitizedHtml refuses when the resolved element itself is marked', async () => {
    const { getSanitizedHtml } = setup({
      'Runtime.evaluate': () => ({ result: { value: { __secretMarked: true } } })
    });
    await assert.rejects(() => getSanitizedHtml(0, '#secret'), /extract refused.*data-sen-secret/);
  });

  it('getSanitizedHtml (selector form) sends a clone-and-strip expression, unlike getHtml', async () => {
    const { getSanitizedHtml, ps } = setup({
      'Runtime.evaluate': () => ({ result: { value: '<p>x</p>' } })
    });
    const html = await getSanitizedHtml(0, '.main');
    assert.equal(html, '<p>x</p>');
    const call = ps.calls.find(c => c.method === 'Runtime.evaluate');
    assert.match(call.params.expression, /data-sen-secret/);
    assert.match(call.params.expression, /clone\.innerHTML/);
  });

  it('getSanitizedHtml with no selector strips a whole-page clone, not the live document', async () => {
    const { getSanitizedHtml, ps } = setup({
      'Runtime.evaluate': () => ({ result: { value: '<html></html>' } })
    });
    await getSanitizedHtml(0);
    const call = ps.calls.find(c => c.method === 'Runtime.evaluate');
    assert.match(call.params.expression, /const el = document\.documentElement/);
    assert.match(call.params.expression, /clone\.cloneNode|el\.cloneNode/);
    assert.match(call.params.expression, /clone\.outerHTML/);
  });

  it('getHtml (the raw, capture.js-internal form) is untouched: no clone, no marker check', async () => {
    const { getHtml, ps } = setup({
      'Runtime.evaluate': () => ({ result: { value: '<html></html>' } })
    });
    await getHtml(0);
    const call = ps.calls.find(c => c.method === 'Runtime.evaluate');
    assert.equal(call.params.expression, 'document.documentElement.outerHTML');
  });

  it(`${ENV}=1 restores the pre-fix, unguarded expressions`, async () => {
    process.env[ENV] = '1';
    const { extractText, getAttribute, getSanitizedHtml, ps } = setup({
      'Runtime.evaluate': () => ({ result: { value: 'raw' } })
    });
    await extractText(0, '#secret');
    await getAttribute(0, '#secret', 'value');
    await getSanitizedHtml(0, '#secret');
    for (const call of ps.calls) {
      assert.doesNotMatch(call.params.expression, /data-sen-secret/, call.params.expression);
    }
  });
});
