const { getElementSelector } = require('./element-selector');
const { throwIfExceptionDetails } = require('./cdp-utils');
const { MARKER_ATTR, credentialCaptureAllowed, secretMarkerRefusal, refuseIfTextLeaksSecret } = require('./credential-guard');
const { ANCESTOR_MARKED_FN_SRC, INERT_CLONE_FN_SRC } = require('./secret-marker');
const { isWholePageSelector, pageTextReadRefused } = require('./sensitive-url');

/**
 * Single-element extraction primitives — text content, HTML, attributes.
 *
 * Each is a thin wrapper around `Runtime.evaluate` that uses optional
 * chaining to return `null`/`undefined` when the selector misses, so the
 * caller doesn't have to distinguish "element not found" from "element
 * found but empty." The page-content / DOM-summary / markdown extractors
 * (the heavyweight ones used by auto-capture) live in `lib/capture.js`.
 *
 * data-sen-secret handling (see lib/credential-guard.js for the marker):
 * extractText, getSanitizedHtml and getAttribute each read the element off
 * a detached clone (or, for getAttribute, refuse outright) rather than the
 * live element, and strip any [data-sen-secret] descendant from that clone
 * before reading it — never touching the page CDP itself might read a
 * credential off right after. `getHtml` (the whole-page, no-selector form)
 * is deliberately left returning the raw, unstripped page: capture.js's
 * mustSuppress/pageContainsCredentialShaped calls it internally to detect
 * the marker in the first place (by regex-matching the tag in the
 * serialized HTML) and would stop seeing it if this stripped it first.
 * getSanitizedHtml is the caller-facing, marker-safe equivalent extract
 * uses instead.
 *
 * Two guards in cloneAndStrip/getAttribute below:
 *   - Ancestor check: marking a WRAPPER (an ancestor of the value element,
 *     the normal pattern) must refuse too, so checking only the resolved
 *     element and its descendants is not enough. Both walk UP from the
 *     resolved element — through shadow-root hosts too — via
 *     `__senAncestorMarked` (secret-marker.js) before reading anything.
 *   - Inert clone: cloning with the live `el.cloneNode(true)` fires
 *     onload/onerror on any `<img>` in the clone, because the image-load
 *     algorithm keys off the clone's (still-live) ownerDocument being
 *     "fully active," not whether the clone is attached. Both clone via
 *     `__senInertClone` (secret-marker.js), which imports the node
 *     into a fresh `document.implementation.createHTMLDocument('')` — a
 *     document that never has a browsing context, so it is never "fully
 *     active" and never runs that algorithm.
 *
 * PRI-3360 (WHOLE-PAGE vs ELEMENT-SCOPED reads): a `selector` that is
 * missing, or is just `body`/`html` (isWholePageSelector, sensitive-url.js),
 * is treated as a WHOLE-PAGE read: gated unconditionally on sensitive-url.js's
 * pageTextReadRefused (known-sensitive URL OR a live data-sen-secret marker
 * OR the code-list density heuristic) BEFORE anything runs, same as
 * capture.js's evaluateWithCapture/extractPageText. Any OTHER selector is
 * ELEMENT-scoped: the read runs (still subject to the existing marker/
 * ancestor check below), and its RESULT is checked by
 * credential-guard.js's refuseIfTextLeaksSecret (token shape OR code-list
 * density) before being returned — a match refuses the whole read rather
 * than redacting it. Both checks are skipped when
 * credentialCaptureAllowed() is set, the same operator-only escape hatch
 * every other guard in this codebase already honors.
 *
 * `attachExtraction({ getPageSession })` returns the bound methods — no
 * session state needed.
 */
function attachExtraction({ getPageSession }) {
  // Shared shape for "the resolved element itself, or any ancestor of it,
  // carries the marker" (self is covered because __senAncestorMarked
  // checks `start` before walking up) — stripping descendants can't help
  // there, since the whole thing IS (or contains, without being able to
  // remove itself) the marked value. `run` is the JS to evaluate once we
  // have an inert clone with descendant [data-sen-secret] elements already
  // removed; it must reference `clone`.
  function cloneAndStrip(elementExpr, run) {
    return `(() => {
      ${ANCESTOR_MARKED_FN_SRC}
      ${INERT_CLONE_FN_SRC}
      const el = ${elementExpr};
      if (!el) return undefined;
      if (__senAncestorMarked(el)) return { __secretMarked: true };
      const clone = __senInertClone(el);
      if (clone.querySelectorAll) {
        for (const marked of clone.querySelectorAll(${JSON.stringify(`[${MARKER_ATTR}]`)})) marked.remove();
      }
      return (${run});
    })()`;
  }

  function throwIfSecretMarked(value, action, selector) {
    if (value && typeof value === 'object' && value.__secretMarked) {
      throw new Error(`${secretMarkerRefusal(action)} (element matching ${JSON.stringify(selector)})`);
    }
    return value;
  }

  async function extractText(tabIndexOrWsUrl, selector) {
    const ps = await getPageSession(tabIndexOrWsUrl);
    const wholePage = isWholePageSelector(selector);
    if (wholePage) {
      const refusal = await pageTextReadRefused(ps, 'extract');
      if (refusal) throw new Error(refusal);
    }
    const js = credentialCaptureAllowed()
      ? `${getElementSelector(selector)}?.textContent`
      : cloneAndStrip(getElementSelector(selector), 'clone.textContent');
    const result = await ps.send('Runtime.evaluate', {
      expression: js,
      returnByValue: true
    });
    throwIfExceptionDetails(result);
    const value = throwIfSecretMarked(result.result.value, 'extract', selector);
    if (!wholePage && !credentialCaptureAllowed()) {
      return refuseIfTextLeaksSecret(value, 'extract', selector);
    }
    return value;
  }

  // Whole-page-detection form, used internally by capture.js's credential
  // guard — see the module doc above. Always raw; never strips the marker.
  async function getHtml(tabIndexOrWsUrl, selector = null) {
    const ps = await getPageSession(tabIndexOrWsUrl);
    const js = selector
      ? `${getElementSelector(selector)}?.innerHTML`
      : 'document.documentElement.outerHTML';
    const result = await ps.send('Runtime.evaluate', {
      expression: js,
      returnByValue: true
    });
    throwIfExceptionDetails(result);
    return result.result.value;
  }

  // Caller-facing form for the 'extract' action's format='html'. Strips
  // [data-sen-secret] descendants from an inert clone before serializing;
  // refuses if the resolved element (or, with no selector, documentElement
  // itself) — or any ancestor of it — carries the marker. PRI-3360: a
  // `selector` of `body`/`html` is treated the same as no selector at all
  // (isWholePageSelector) — both read document.documentElement, and both
  // are gated by pageTextReadRefused rather than the element-scoped
  // content check below.
  async function getSanitizedHtml(tabIndexOrWsUrl, selector = null) {
    const ps = await getPageSession(tabIndexOrWsUrl);
    const wholePage = isWholePageSelector(selector);
    if (wholePage) {
      const refusal = await pageTextReadRefused(ps, 'extract');
      if (refusal) throw new Error(refusal);
    }
    if (credentialCaptureAllowed()) return getHtml(tabIndexOrWsUrl, wholePage ? null : selector);
    const js = wholePage
      ? cloneAndStrip('document.documentElement', 'clone.outerHTML')
      : cloneAndStrip(getElementSelector(selector), 'clone.innerHTML');
    const result = await ps.send('Runtime.evaluate', {
      expression: js,
      returnByValue: true
    });
    throwIfExceptionDetails(result);
    const value = throwIfSecretMarked(result.result.value, 'extract', wholePage ? '(whole page)' : selector);
    if (!wholePage) {
      return refuseIfTextLeaksSecret(value, 'extract', selector);
    }
    return value;
  }

  async function getAttribute(tabIndexOrWsUrl, selector, attrName) {
    const ps = await getPageSession(tabIndexOrWsUrl);
    const wholePage = isWholePageSelector(selector);
    if (wholePage) {
      const refusal = await pageTextReadRefused(ps, 'attr');
      if (refusal) throw new Error(refusal);
    }
    // No clone-and-strip here: an attribute is a single scalar on the
    // resolved element itself, not text gathered from a subtree, so
    // "strip marked descendants" has nothing to remove. If the resolved
    // element, or any ancestor of it, carries
    // the marker, any of its attributes could be the secret (the value=
    // of a marked input, a title=, the marker attribute's own value if
    // it's non-boolean) — refuse outright rather than guess which
    // attribute names are safe.
    const js = credentialCaptureAllowed()
      ? `${getElementSelector(selector)}?.getAttribute(${JSON.stringify(attrName)})`
      : `(() => {
          ${ANCESTOR_MARKED_FN_SRC}
          const el = ${getElementSelector(selector)};
          if (!el) return undefined;
          if (__senAncestorMarked(el)) return { __secretMarked: true };
          return el.getAttribute(${JSON.stringify(attrName)});
        })()`;
    const result = await ps.send('Runtime.evaluate', {
      expression: js,
      returnByValue: true
    });
    throwIfExceptionDetails(result);
    const value = throwIfSecretMarked(result.result.value, 'attr', selector);
    if (!wholePage && !credentialCaptureAllowed()) {
      return refuseIfTextLeaksSecret(value, 'attr', selector);
    }
    return value;
  }

  return { extractText, getHtml, getSanitizedHtml, getAttribute };
}

module.exports = { attachExtraction };
