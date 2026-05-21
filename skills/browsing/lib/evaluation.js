/**
 * Runtime.evaluate wrappers — three flavors, for three return-value
 * shapes. The differences matter (see JRV-126):
 *
 * - `evaluate`: legacy `returnByValue: true`. Returns `result.result.value`.
 *   Loses type information for complex objects (DOM nodes come back as
 *   `[object Object]`-style descriptions). Awaits Promises.
 *
 * - `evaluateJson`: wraps the expression so the page-side code stringifies
 *   complex returns into a tagged shape (`{__type: 'Element', ...}`,
 *   `{__type: 'undefined'}`, etc.). Use when you want to inspect DOM
 *   nodes or distinguish undefined/null/error in the result.
 *
 * - `evaluateRaw`: `returnByValue: false`. Returns `result.result` (the
 *   full RemoteObject including `objectId`). For callers that need the
 *   raw CDP shape.
 *
 * `attachEvaluation({ getPageSession })` binds them to a session via the
 * pageSession resolver.
 */
const { throwIfExceptionDetails } = require('./cdp-utils');

function attachEvaluation({ getPageSession }) {
  async function evaluate(tabIndexOrWsUrl, expression) {
    const pageSession = await getPageSession(tabIndexOrWsUrl);
    const result = await pageSession.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    throwIfExceptionDetails(result);
    return result.result.value;
  }

  async function evaluateJson(tabIndexOrWsUrl, expression) {
    const pageSession = await getPageSession(tabIndexOrWsUrl);

    const wrappedExpression = `
      (() => {
        try {
          const result = ${expression};
          if (result === undefined) return { __type: 'undefined' };
          if (result === null) return null;
          if (result instanceof Element) {
            return {
              __type: 'Element',
              tagName: result.tagName,
              id: result.id,
              className: result.className,
              textContent: result.textContent?.slice(0, 100)
            };
          }
          if (typeof result === 'function') {
            return { __type: 'function', name: result.name || 'anonymous' };
          }
          return result;
        } catch (e) {
          return { __type: 'error', message: e.message };
        }
      })()
    `;

    const result = await pageSession.send('Runtime.evaluate', {
      expression: wrappedExpression,
      returnByValue: true,
      awaitPromise: true
    });
    throwIfExceptionDetails(result);
    return result.result.value;
  }

  async function evaluateRaw(tabIndexOrWsUrl, expression) {
    const pageSession = await getPageSession(tabIndexOrWsUrl);
    const result = await pageSession.send('Runtime.evaluate', {
      expression,
      returnByValue: false
    });
    throwIfExceptionDetails(result);
    return result.result;
  }

  return { evaluate, evaluateJson, evaluateRaw };
}

module.exports = { attachEvaluation };
