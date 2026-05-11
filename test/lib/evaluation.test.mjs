import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { makePageSessionSpy, makeGetPageSession } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachEvaluation } = require('../../skills/browsing/lib/evaluation.js');

describe('evaluation', () => {
  function setup(handlers = {}) {
    const ps = makePageSessionSpy(handlers);
    return { ...attachEvaluation({ getPageSession: makeGetPageSession(ps) }), ps };
  }

  it('evaluate passes returnByValue and awaitPromise', async () => {
    const { evaluate, ps } = setup({
      'Runtime.evaluate': () => ({ result: { value: 42 } }),
    });
    const result = await evaluate(0, '21+21');
    assert.equal(result, 42);
    assert.equal(ps.calls[0].params.returnByValue, true);
    assert.equal(ps.calls[0].params.awaitPromise, true);
    assert.equal(ps.calls[0].params.expression, '21+21');
  });

  it('evaluateJson wraps the expression in a serialiser IIFE', async () => {
    const { evaluateJson, ps } = setup({
      'Runtime.evaluate': () => ({ result: { value: { foo: 'bar' } } }),
    });
    await evaluateJson(0, 'document.body');
    const expr = ps.calls[0].params.expression;
    assert.match(expr, /document\.body/);
    assert.match(expr, /__type: 'Element'/);
  });

  it('evaluateRaw returns full result.result, not just value', async () => {
    const { evaluateRaw } = setup({
      'Runtime.evaluate': () => ({ result: { value: 7, type: 'number' } }),
    });
    const result = await evaluateRaw(0, '7');
    assert.deepEqual(result, { value: 7, type: 'number' });
  });

  it('evaluateRaw passes returnByValue: false', async () => {
    const { evaluateRaw, ps } = setup();
    await evaluateRaw(0, 'x');
    assert.equal(ps.calls[0].params.returnByValue, false);
  });

  it('evaluate throws when Runtime.evaluate returns exceptionDetails', async () => {
    const ps = makePageSessionSpy({
      'Runtime.evaluate': () => ({
        result: { type: 'undefined' },
        exceptionDetails: {
          text: 'Uncaught (in promise)',
          exception: { description: 'Error: timeout fired' },
        },
      }),
    });
    const { evaluate } = attachEvaluation({ getPageSession: makeGetPageSession(ps) });
    await assert.rejects(() => evaluate(0, 'whatever'), /timeout fired/);
  });

  it('evaluateJson throws when Runtime.evaluate returns exceptionDetails', async () => {
    const ps = makePageSessionSpy({
      'Runtime.evaluate': () => ({
        result: { type: 'undefined' },
        exceptionDetails: {
          text: 'Uncaught',
          exception: { description: 'ReferenceError: x is not defined' },
        },
      }),
    });
    const { evaluateJson } = attachEvaluation({ getPageSession: makeGetPageSession(ps) });
    await assert.rejects(() => evaluateJson(0, 'x'), /ReferenceError/);
  });

  it('evaluateRaw throws when Runtime.evaluate returns exceptionDetails', async () => {
    const ps = makePageSessionSpy({
      'Runtime.evaluate': () => ({
        result: { type: 'undefined' },
        exceptionDetails: {
          text: 'Uncaught',
          exception: { description: 'TypeError: cannot read property' },
        },
      }),
    });
    const { evaluateRaw } = attachEvaluation({ getPageSession: makeGetPageSession(ps) });
    await assert.rejects(() => evaluateRaw(0, 'foo.bar'), /TypeError/);
  });
});
