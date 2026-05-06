import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { makeCdpSpy, makeResolveWsUrl } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachExtraction } = require('../../skills/browsing/lib/extraction.js');

describe('extraction', () => {
  function setup(handlers = {}) {
    const sendCdpCommand = makeCdpSpy(handlers);
    return { ...attachExtraction({ resolveWsUrl: makeResolveWsUrl(), sendCdpCommand }), sendCdpCommand };
  }

  it('extractText sends the textContent expression', async () => {
    const { extractText, sendCdpCommand } = setup({
      'Runtime.evaluate': () => ({ result: { value: 'hello' } })
    });
    const text = await extractText(0, '#headline');
    assert.equal(text, 'hello');
    assert.match(sendCdpCommand.calls[0].params.expression, /\?\.textContent$/);
  });

  it('getHtml without selector returns documentElement.outerHTML', async () => {
    const { getHtml, sendCdpCommand } = setup({
      'Runtime.evaluate': () => ({ result: { value: '<html></html>' } })
    });
    await getHtml(0);
    assert.equal(sendCdpCommand.calls[0].params.expression, 'document.documentElement.outerHTML');
  });

  it('getHtml with selector returns innerHTML', async () => {
    const { getHtml, sendCdpCommand } = setup({
      'Runtime.evaluate': () => ({ result: { value: '<p>x</p>' } })
    });
    await getHtml(0, '.main');
    assert.match(sendCdpCommand.calls[0].params.expression, /\?\.innerHTML$/);
  });

  it('getAttribute escapes the attribute name', async () => {
    const { getAttribute, sendCdpCommand } = setup({
      'Runtime.evaluate': () => ({ result: { value: '/foo' } })
    });
    await getAttribute(0, 'a', 'href');
    assert.match(sendCdpCommand.calls[0].params.expression, /getAttribute\("href"\)$/);
  });
});
