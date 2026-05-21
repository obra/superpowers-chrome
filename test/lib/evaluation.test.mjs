import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { makePageSessionFake } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachEvaluation } = require('../../skills/browsing/lib/evaluation.js');

describe('evaluation', () => {
  function setup(handlers = {}) {
    const ps = makePageSessionFake(handlers);
    const getPageSession = async () => ps;
    return { ...attachEvaluation({ getPageSession }), ps };
  }

  it('evaluate passes returnByValue and awaitPromise', async () => {
    const { evaluate, ps } = setup({
      'Runtime.evaluate': () => ({ result: { value: 42 } })
    });
    const result = await evaluate(0, '21+21');
    assert.equal(result, 42);
    const call = ps.calls.find(c => c.method === 'Runtime.evaluate');
    assert.equal(call.params.returnByValue, true);
    assert.equal(call.params.awaitPromise, true);
    assert.equal(call.params.expression, '21+21');
  });

  it('evaluateJson wraps the expression in a serialiser IIFE', async () => {
    const { evaluateJson, ps } = setup({
      'Runtime.evaluate': () => ({ result: { value: { foo: 'bar' } } })
    });
    await evaluateJson(0, 'document.body');
    const call = ps.calls.find(c => c.method === 'Runtime.evaluate');
    assert.match(call.params.expression, /document\.body/);
    assert.match(call.params.expression, /__type: 'Element'/);
  });

  it('evaluateRaw returns full result.result, not just value', async () => {
    const { evaluateRaw } = setup({
      'Runtime.evaluate': () => ({ result: { value: 7, type: 'number' } })
    });
    const result = await evaluateRaw(0, '7');
    assert.deepEqual(result, { value: 7, type: 'number' });
  });

  it('evaluateRaw passes returnByValue: false', async () => {
    const { evaluateRaw, ps } = setup();
    await evaluateRaw(0, 'x');
    const call = ps.calls.find(c => c.method === 'Runtime.evaluate');
    assert.equal(call.params.returnByValue, false);
  });

  it('evaluate throws when Runtime.evaluate returns exceptionDetails', async () => {
    const ps = makePageSessionFake({
      'Runtime.evaluate': () => ({
        result: { type: 'undefined' },
        exceptionDetails: {
          text: 'Uncaught (in promise)',
          exception: { description: 'Error: timeout fired' }
        }
      })
    });
    const { evaluate } = attachEvaluation({ getPageSession: async () => ps });
    await assert.rejects(() => evaluate(0, 'whatever'), /timeout fired/);
  });

  it('evaluateJson throws when Runtime.evaluate returns exceptionDetails', async () => {
    const ps = makePageSessionFake({
      'Runtime.evaluate': () => ({
        result: { type: 'undefined' },
        exceptionDetails: {
          text: 'Uncaught',
          exception: { description: 'ReferenceError: x is not defined' }
        }
      })
    });
    const { evaluateJson } = attachEvaluation({ getPageSession: async () => ps });
    await assert.rejects(() => evaluateJson(0, 'x'), /ReferenceError/);
  });

  it('evaluateRaw throws when Runtime.evaluate returns exceptionDetails', async () => {
    const ps = makePageSessionFake({
      'Runtime.evaluate': () => ({
        result: { type: 'undefined' },
        exceptionDetails: {
          text: 'Uncaught',
          exception: { description: 'TypeError: cannot read property' }
        }
      })
    });
    const { evaluateRaw } = attachEvaluation({ getPageSession: async () => ps });
    await assert.rejects(() => evaluateRaw(0, 'foo.bar'), /TypeError/);
  });
});
