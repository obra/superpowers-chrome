/**
 * set_attr: a write-only, name/value-restricted attribute setter.
 *
 * Why this exists (obra#50 follow-up): the eval fail-closed guard added in
 * capture.js's evaluateWithCapture refuses EVERY eval call once a page has
 * any data-sen-secret element, because eval can read anything - there is
 * no way to tell a value-blind expression from one that would leak the
 * secret. That is correct for eval, but it collaterally blocked a
 * legitimate write: an agent entering a split-digit one-time code needs
 * to stamp a broker nonce onto an *unmarked* sibling digit-input element
 * right after capturing and marking the TOTP seed displayed on that same
 * now-marked page. set_attr is scoped narrowly enough -
 * no read capability at all, restricted target element, a two-name
 * allowlist - that it doesn't need the secret-marker/eval guard: there is
 * nothing here for it to leak.
 *
 * obra#52 follow-up: nothing upstream had a path to WRITE the
 * data-sen-secret marker itself, so the guard #52 hardens never engages -
 * nothing ever marks the seed in the first place. set_attr is the only
 * write surface an agent has on a marked-or-about-to-be-marked page, so it
 * is now also allowed to set exactly `data-sen-secret` (see MARKER_ATTR),
 * in addition to the pre-existing `data-sen-nonce`. This is deliberately
 * the smallest change that closes that gap:
 *   - Marking only ever TIGHTENS what eval/extract/attr will refuse; it
 *     can never loosen anything, so it needs none of the read-side
 *     guard's care.
 *   - set_attr never reads (see below), so letting it write one more
 *     boolean-ish attribute name adds no new read capability.
 *   - It reuses the existing name-allowlist and "target already marked"
 *     mechanics instead of adding a second action with its own surface
 *     (a dedicated mark-secret action was the alternative considered and
 *     rejected for exactly that reason).
 *   - The "target already marked" refusal below is skipped specifically
 *     for name === MARKER_ATTR: marking an already-marked element is a
 *     no-op, not a bypass, and refusing it would just make the caller
 *     retry-with-a-different-approach for no security benefit.
 *
 * NO caller-supplied JavaScript, unlike eval: name/value travel to the
 * page as CDP Runtime.callFunctionOn `arguments` (CallArgument values),
 * never as text concatenated into a JS expression string. A value like
 * `"); fetch('https://evil'` cannot become code, because it is never
 * textually inserted into the function source - it only ever arrives as a
 * runtime string handed to setAttribute(). The selector IS spliced into
 * the generated source, via getElementSelectorAll's JSON.stringify - the
 * same pattern extraction.js/mouse.js/keyboard-input.js already use for
 * every other action's selector, safe because JSON.stringify produces a
 * proper JS string literal, never raw concatenation of untrusted text.
 *
 * Target-element resolution (obra#52 review round 2, finding 3): earlier
 * versions called plain `document.querySelector(selector)`, which returns
 * the FIRST DOM match regardless of whether it's the element a human (or
 * the agent looking at a screenshot) would call "the" match. A page with a
 * hidden duplicate of the target - offscreen, `display:none`, behind
 * another element - earlier in the DOM than the real, visible one means
 * set_attr would silently write to (or mark) the wrong element while the
 * one actually on screen goes untouched. buildFunctionDeclaration below
 * resolves the SAME way click/type do (getElementSelectorAll + prefer the
 * one visible match), reusing that exact selection logic rather than
 * reimplementing it, and adds one thing click/type don't need: if MORE
 * THAN ONE match is visible, that's genuinely ambiguous (visibility can't
 * disambiguate two elements that are both on screen) and this refuses
 * rather than guessing.
 *
 * Guards, defense in depth:
 *   - Attribute NAME: a two-value allowlist (see ALLOWED_ATTRIBUTE_NAMES
 *     below), checked in Node before any CDP call at all - a disallowed
 *     name refuses without ever touching the page.
 *   - Target ELEMENT: the page-side function refuses if the resolved
 *     element itself already carries data-sen-secret and the write isn't
 *     itself a (re-)marking, so this can never overwrite a secret
 *     element's other attributes. This check is NOT gated behind the
 *     page-wide secret-marker check eval uses: set_attr can run freely on
 *     a page that has a marked element elsewhere, which is the entire
 *     point (see above).
 *   - Response shape: the page-side function returns only
 *     `{ ok: true }` or `{ ok: false, error }`, and the error strings are
 *     fixed literals we wrote (never page content, never the attribute's
 *     prior value, never the value just set).
 */
const { throwIfExceptionDetails } = require('./cdp-utils');
const { MARKER_ATTR } = require('./credential-guard');
const { getElementSelectorAll } = require('./element-selector');

// The pre-existing writable name (stamping a credential-broker nonce
// during a split-digit one-time-code entry flow, while the TOTP seed
// captured earlier is still marked on the page) plus MARKER_ATTR itself -
// added so set_attr has a write path for the marker (nothing upstream did
// before this); NOT a data-*/aria-* prefix allowlist. Page JS and
// frameworks routinely read arbitrary data-*/aria-* attributes and wire
// them to behavior (data-action, data-href, aria-controls, and many more a
// hostile page could invent), so "any data-*/aria-* name" is NOT
// guaranteed inert the way it first looked - widening this to a third name
// is a deliberate, separate change, not a regex tweak. Single constant, so
// it stays easy to find and to audit if that widening is ever proposed.
const NONCE_ATTRIBUTE_NAME = 'data-sen-nonce';
const ALLOWED_ATTRIBUTE_NAMES = new Set([NONCE_ATTRIBUTE_NAME, MARKER_ATTR]);
// Back-compat alias: existing callers/imports expect a single "the nonce
// name" constant.
const ALLOWED_ATTRIBUTE_NAME = NONCE_ATTRIBUTE_NAME;

function isAllowedAttributeName(name) {
  return typeof name === 'string' && ALLOWED_ATTRIBUTE_NAMES.has(name.toLowerCase());
}

// Page-side function body, built fresh per call because the selector
// resolution (all matches, then prefer the visible one) has to be spliced
// in as source — see getElementSelectorAll and the module doc above.
// name/value are NEVER spliced in; they arrive as Runtime.callFunctionOn
// `arguments` at call time. MARKER_ATTR IS spliced in (via JSON.stringify,
// from a fixed Node-side constant, never from any call's arguments), so
// the page-side and Node-side notions of "the marker attribute" can never
// drift apart.
function buildFunctionDeclaration(selector) {
  const allExpr = getElementSelectorAll(selector);
  return `function (name, value) {
  var all = ${allExpr};
  if (!all || all.length === 0) return { ok: false, error: 'no element matched' };
  var visible = all.filter(function (el) {
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  var el;
  if (visible.length > 1) {
    return { ok: false, error: 'refused: selector matches ' + visible.length + ' visible elements (ambiguous)' };
  } else if (visible.length === 1) {
    el = visible[0];
  } else {
    // All matches are hidden (zero-dimension) — same fallback click/type
    // use via getElementSelector: use the first, since there is no visible
    // one to prefer and only one candidate set to choose from.
    el = all[0];
  }
  var MARKER = ${JSON.stringify(MARKER_ATTR)};
  if (name !== MARKER && el.hasAttribute(MARKER)) {
    return { ok: false, error: 'refused: target element is marked ' + MARKER };
  }
  el.setAttribute(name, value);
  return { ok: true };
}`;
}

function attachSetAttribute({ getPageSession }) {
  async function setAttribute(tabIndexOrWsUrl, selector, name, value) {
    if (!isAllowedAttributeName(name)) {
      throw new Error(
        `set_attr refused: attribute name ${JSON.stringify(name)} is not allowed ` +
        `(only ${[...ALLOWED_ATTRIBUTE_NAMES].join(' or ')} are writable)`
      );
    }

    const ps = await getPageSession(tabIndexOrWsUrl);

    // Runtime.callFunctionOn needs an objectId or an executionContextId to
    // run against. `this` inside the function declaration is unused
    // (name/value arrive as arguments, the selector is baked into the
    // source itself), so any live remote object works as the call target;
    // `document` is the simplest one that's always present.
    const docResult = await ps.send('Runtime.evaluate', {
      expression: 'document',
      returnByValue: false,
    });
    throwIfExceptionDetails(docResult);

    const result = await ps.send('Runtime.callFunctionOn', {
      objectId: docResult.result.objectId,
      functionDeclaration: buildFunctionDeclaration(selector),
      arguments: [{ value: name }, { value: String(value) }],
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

module.exports = {
  attachSetAttribute,
  isAllowedAttributeName,
  ALLOWED_ATTRIBUTE_NAME,
  ALLOWED_ATTRIBUTE_NAMES,
  NONCE_ATTRIBUTE_NAME,
  MARKER_ATTR,
};
