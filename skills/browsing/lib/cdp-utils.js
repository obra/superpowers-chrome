/**
 * Shared utilities for CDP responses.
 *
 * `throwIfExceptionDetails(result)` inspects a `Runtime.evaluate` reply and
 * throws if the page-side JS threw or a Promise rejected. Without this,
 * callers silently see `undefined` instead of the actual error — which has
 * caused real bugs (waitForElement timeouts swallowed, evaluate returning {}
 * for thrown errors). Use after every `sendCdpCommand(...,'Runtime.evaluate',...)`.
 */
function throwIfExceptionDetails(result) {
  if (!result || !result.exceptionDetails) return;
  const desc = result.exceptionDetails.exception?.description
    || result.exceptionDetails.text
    || 'unknown evaluation error';
  throw new Error(`evaluate failed: ${desc}`);
}

module.exports = { throwIfExceptionDetails };
