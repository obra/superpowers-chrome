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
 * no read capability at all, restricted target element, exactly one
 * writable attribute name — that it doesn't need the secret-marker/eval
 * guard: there is nothing here for it to leak.
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
 *   - Attribute NAME: a single-value allowlist (see ALLOWED_ATTRIBUTE_NAME
 *     below), checked in Node before any CDP call at all — a disallowed
 *     name refuses without ever touching the page.
 *   - Target ELEMENT: the fixed page-side function refuses if the resolved
 *     element itself carries data-sen-secret, so this can never overwrite
 *     (or — since the marker name itself is disallowed) strip the marker
 *     off a secret element. This check is NOT gated behind the page-wide
 *     secret-marker check eval uses: set_attr can run freely on a page
 *     that has a marked element elsewhere, which is the entire point (see
 *     above).
 *   - Response shape: the page-side function returns only
 *     `{ ok: true }` or `{ ok: false, error }`, and the error strings are
 *     fixed literals we wrote (never page content, never the attribute's
 *     prior value, never the value just set).
 */
const { throwIfExceptionDetails } = require('./cdp-utils');

// Exactly one writable attribute name — the only known legitimate need
// (stamping a credential-broker nonce during a split-digit one-time-code
// entry flow, while the TOTP seed captured earlier is still marked on the
// page) — not a data-*/aria-* prefix allowlist. Page JS and frameworks routinely
// read arbitrary data-*/aria-* attributes and wire them to behavior
// (data-action, data-href, aria-controls, and many more a hostile page
// could invent), so "any data-*/aria-* name" is NOT guaranteed inert the
// way it first looked — widening this is a deliberate, separate change,
// not a regex tweak. Single constant, so it stays easy to find and to
// audit if that widening is ever proposed.
const ALLOWED_ATTRIBUTE_NAME = 'data-sen-nonce';
const MARKER_ATTR = 'data-sen-secret';

function isAllowedAttributeName(name) {
  return typeof name === 'string' && name.toLowerCase() === ALLOWED_ATTRIBUTE_NAME;
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
        `(only ${ALLOWED_ATTRIBUTE_NAME} is writable)`
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

module.exports = { attachSetAttribute, isAllowedAttributeName, ALLOWED_ATTRIBUTE_NAME, MARKER_ATTR };
