/**
 * set_attr: a write-only, name/value-restricted attribute setter.
 *
 * Why this exists: the eval fail-closed guard in capture.js's
 * evaluateWithCapture refuses EVERY eval call once a page has any
 * data-sen-secret element, because eval can read anything - there is no
 * way to tell a value-blind expression from one that would leak the
 * secret. That is correct for eval, but it would also block a legitimate
 * write: an agent entering a split-digit one-time code needs
 * to stamp a broker nonce onto an *unmarked* sibling digit-input element
 * right after capturing and marking the TOTP seed displayed on that same
 * now-marked page. set_attr is scoped narrowly enough -
 * no caller JavaScript, restricted target element, a two-name
 * allowlist - that it doesn't need the secret-marker/eval guard. Its only
 * output is ok / "no element matched" / "refused: target element is
 * marked", which acts as a limited prefix oracle over page content for a
 * caller who varies the selector; that is known and accepted.
 *
 * set_attr is also the write path for the data-sen-secret marker itself:
 * callers need some way to WRITE the marker, or the marker guard never
 * engages because nothing ever marks the seed. set_attr is the only write
 * surface an agent has on a marked-or-about-to-be-marked page, so it may
 * set exactly `data-sen-secret` (see MARKER_ATTR) as well as
 * `data-sen-nonce`. This is deliberately the smallest surface that covers
 * marking:
 *   - Marking only ever TIGHTENS what eval/extract/attr will refuse; it
 *     can never loosen anything, so it needs none of the read-side
 *     guard's care.
 *   - set_attr returns no page content (see below), so letting it write
 *     one more boolean-ish attribute name adds no new read capability
 *     beyond the prefix oracle above.
 *   - It reuses the name-allowlist and "target already marked" mechanics
 *     instead of adding a second action (such as a dedicated mark-secret
 *     action) with its own surface.
 *   - The "target already marked" refusal below is skipped specifically
 *     for name === MARKER_ATTR: marking an already-marked element is a
 *     no-op, not a bypass, and refusing it would just make the caller
 *     retry-with-a-different-approach for no security benefit.
 *
 * Element resolution:
 *   - data-sen-nonce writes exactly ONE element, resolved the same way
 *     extract/click/type resolve a selector (lib/element-selector.js's
 *     getElementSelector: prefer the first VISIBLE match, fall back to
 *     the first DOM match with a console.warn if every match is hidden).
 *     There is exactly one legitimate write target for a nonce, so this
 *     picks the same one a human looking at the page would call "the"
 *     field.
 *   - data-sen-secret instead marks EVERY element the selector matches,
 *     hidden duplicates included (getElementSelectorAll). Marking only
 *     the single resolved match would leave a hidden duplicate, or a
 *     hidden form input carrying the same value, fully readable by
 *     extract/attr even after the marker check ran. Marking is the whole
 *     guard's opt-in signal, not a value write - there is no
 *     "wrong element" failure mode to worry about the way there is for a
 *     real write, so the safe default is "mark anything this selector
 *     could mean," not "guess the one visible element and leave the rest."
 *     This can never remove or weaken an existing mark: an already-marked
 *     element among the matches is simply marked again (a no-op), never
 *     skipped or unmarked, and marking never touches any element the
 *     selector didn't match.
 *
 * NO caller-supplied JavaScript, unlike eval: name/value travel to the
 * page as CDP Runtime.callFunctionOn `arguments` (CallArgument values),
 * never as text concatenated into a JS expression string. A value like
 * `"); fetch('https://evil'` cannot become code, because it is never
 * textually inserted into the function source - it only ever arrives as
 * a runtime string handed to setAttribute(). The selector IS spliced into
 * the generated source, via getElementSelector/getElementSelectorAll's
 * JSON.stringify - the same pattern extraction.js/mouse.js/keyboard-input.js
 * already use for every other action's selector, safe because
 * JSON.stringify produces a proper JS string literal, never raw
 * concatenation of untrusted text.
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
const { getElementSelector, getElementSelectorAll } = require('./element-selector');

// The nonce name (stamping a credential-broker nonce during a split-digit
// one-time-code entry flow, while the TOTP seed captured earlier is still
// marked on the page) plus MARKER_ATTR itself - not a data-*/aria-* prefix
// allowlist. Page JS and frameworks routinely read arbitrary data-*/aria-*
// attributes and wire them to behavior (data-action, data-href,
// aria-controls, and many more a hostile page could invent), so "any
// data-*/aria-* name" is NOT guaranteed inert the way it first looked -
// widening this to a third name is a deliberate, separate change, not a
// regex tweak. Single constant, so it stays easy to find and to audit if
// that widening is ever proposed.
const NONCE_ATTRIBUTE_NAME = 'data-sen-nonce';
const ALLOWED_ATTRIBUTE_NAMES = new Set([NONCE_ATTRIBUTE_NAME, MARKER_ATTR]);
// Back-compat alias: existing callers/imports expect a single "the nonce
// name" constant.
const ALLOWED_ATTRIBUTE_NAME = NONCE_ATTRIBUTE_NAME;

function isAllowedAttributeName(name) {
  return typeof name === 'string' && ALLOWED_ATTRIBUTE_NAMES.has(name.toLowerCase());
}

// Page-side function body, built fresh per call because the selector
// resolution has to be spliced in as source (see getElementSelector /
// getElementSelectorAll and the module doc above). name/value are NEVER
// spliced in - they arrive as Runtime.callFunctionOn `arguments` at call
// time. MARKER_ATTR IS spliced in (via JSON.stringify, from a fixed
// Node-side constant, never from any call's arguments), so the page-side
// and Node-side notions of "the marker attribute" can never drift apart.
function buildFunctionDeclaration(selector) {
  const oneExpr = getElementSelector(selector);
  const allExpr = getElementSelectorAll(selector);
  return `function (name, value) {
    var MARKER = ${JSON.stringify(MARKER_ATTR)};
    if (name === MARKER) {
      // Mark every match, hidden duplicates included (module doc above) -
      // never just the one element a human would call "the" match.
      var all = ${allExpr};
      if (!all || all.length === 0) return { ok: false, error: 'no element matched' };
      for (var i = 0; i < all.length; i++) {
        all[i].setAttribute(MARKER, value);
      }
      return { ok: true };
    }
    var el = ${oneExpr};
    if (!el) return { ok: false, error: 'no element matched' };
    if (el.hasAttribute(MARKER)) {
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
    // HTML attribute names are case-insensitive, and the allowlist check
    // above ignores case, so normalize once here: the page-side function
    // compares against MARKER exactly, and an upper-case spelling must take
    // the mark-every-match path, not the single-element write path.
    const attributeName = name.toLowerCase();

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
      arguments: [{ value: attributeName }, { value: String(value) }],
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
