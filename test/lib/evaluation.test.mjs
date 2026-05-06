import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { makeCdpSpy, makeResolveWsUrl } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachEvaluation } = require('../../skills/browsing/lib/evaluation.js');

describe('evaluation', () => {
  function setup(handlers = {}) {
    const sendCdpCommand = makeCdpSpy(handlers);
    return { ...attachEvaluation({ resolveWsUrl: makeResolveWsUrl(), sendCdpCommand }), sendCdpCommand };
  }

  it('evaluate passes returnByValue and awaitPromise', async () => {
    const { evaluate, sendCdpCommand } = setup({
      'Runtime.evaluate': () => ({ result: { value: 42 } })
    });
    const result = await evaluate(0, '21+21');
    assert.equal(result, 42);
    assert.equal(sendCdpCommand.calls[0].params.returnByValue, true);
    assert.equal(sendCdpCommand.calls[0].params.awaitPromise, true);
    assert.equal(sendCdpCommand.calls[0].params.expression, '21+21');
  });

  it('evaluateJson wraps the expression in a serialiser IIFE', async () => {
    const { evaluateJson, sendCdpCommand } = setup({
      'Runtime.evaluate': () => ({ result: { value: { foo: 'bar' } } })
    });
    await evaluateJson(0, 'document.body');
    const expr = sendCdpCommand.calls[0].params.expression;
    assert.match(expr, /document\.body/);
    assert.match(expr, /__type: 'Element'/);
  });

  it('evaluateRaw returns full result.result, not just value', async () => {
    const { evaluateRaw } = setup({
      'Runtime.evaluate': () => ({ result: { value: 7, type: 'number' } })
    });
    const result = await evaluateRaw(0, '7');
    assert.deepEqual(result, { value: 7, type: 'number' });
  });

  it('evaluateRaw passes returnByValue: false', async () => {
    const { evaluateRaw, sendCdpCommand } = setup();
    await evaluateRaw(0, 'x');
    assert.equal(sendCdpCommand.calls[0].params.returnByValue, false);
  });
});
