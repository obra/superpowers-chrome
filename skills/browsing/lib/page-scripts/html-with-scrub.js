const { MARKER_ATTR } = require('../credential-guard');
const { INERT_CLONE_FN_SRC } = require('../secret-marker');

// Page-side script: loaded as a string and embedded in CDP
// Runtime.evaluate by lib/capture.js.
//
// Returns { raw, scrubbed }:
//   - `raw` is the plain document.documentElement.outerHTML. It is fed
//     unchanged into the credential-shape scan (lib/credential-guard.js),
//     so existing shape/marker detection (a token typed into a field, or a
//     data-sen-secret marker) keeps working exactly as before.
//   - `scrubbed` is what actually gets written to disk. It is built two ways
//     at once (round 2, see below): the matched field's own `value` and
//     `data-*` attributes are stripped in an INERT clone, and separately
//     every live-typed value collected from those fields is redacted
//     wherever it appears in the resulting string.
//
// Why redact by value, not just by attribute (round 2 / jc review):
// selector-and-attribute scrubbing only strips the matched element's own
// mirrored copy. It cannot see a mirror onto a DIFFERENT element (a hidden
// input a page's JS keeps in sync with the visible field) or onto a
// different attribute of the SAME element that isn't `data-*` (aria-*,
// title). The only thing all of those mirrors have in common is the
// literal bytes: the value the user typed. So after building the
// attribute-scrubbed string, every live `.value` collected from a
// sensitive field is redacted everywhere it occurs in that string --
// which also covers the hidden-mirror-input and other-attribute cases
// without needing a selector for the mirror itself.
//
// Why an inert clone, not `cloneNode(true)` on the live document (round 2 /
// jc review, obra#52 hit the same regression): `el.cloneNode(true)` in the
// live document still runs the image-loading algorithm for any cloned
// <img> -- that algorithm is gated on the node's ownerDocument being
// "fully active", which a same-document clone still is, regardless of
// whether the clone is ever attached. So every auto-capture (every click,
// eval, fill...) re-fired every <img> load/error handler on the page.
// A document created by `document.implementation.createHTMLDocument`
// never gets a browsing context, so it is never "fully active", and
// `importNode`-ing into it does not re-run that algorithm. No resource
// loads, no handlers, no side effects on the live page. Reuses obra#52's
// `__senInertClone` (secret-marker.js's `INERT_CLONE_FN_SRC`, the same
// helper extraction.js splices in for eval/extract/attr) instead of
// duplicating this pattern a third time.
//
// Detection signals for "this field's value must be redacted" (round 2 /
// jc review, gaps in the original selector):
//   - input[type="password" i]: the ordinary case. Case-insensitive
//     because the `type` content attribute is matched against its keyword
//     ASCII-case-insensitively by the spec anyway, so a page that spells
//     it type="Password" still behaves as a password field.
//   - any input ever seen with type="password", even if a "show password"
//     toggle has since flipped its type to "text": tracked in
//     window.__senWasPasswordInputs, a WeakSet keyed on the element itself,
//     populated on every scrub pass. It lives on `window`, not the DOM, so
//     recording it is not a mutation of the live document -- nothing a
//     page's own MutationObserver could react to.
//   - [autocomplete*="current-password" i], [...="new-password" i],
//     [...="one-time-code" i], [...="cc-" i]: substring, not exact-token,
//     match, so a real-world multi-token value like
//     autocomplete="section-2fa one-time-code" still matches, and case
//     folds so New-Password / ONE-TIME-CODE still match. `cc-` catches
//     the whole cc-* family (cc-number, cc-csc, cc-exp, ...).
// `[data-sen-secret]` marked elements are still attribute-scrubbed as
// before, but deliberately excluded from value-collection: a marker
// element's visible text is intentionally left as-is here (existing
// behavior/tests) because a marked page is caught upstream by the
// shape/marker scan on `raw` and its whole capture is suppressed --
// scrubbing its text here would just be dead code for that path.
module.exports = `
  (() => {
    const raw = document.documentElement.outerHTML;

    const PASSWORD_TYPE_SELECTOR = 'input[type="password" i]';
    const AUTOCOMPLETE_SELECTOR = [
      '[autocomplete*="current-password" i]',
      '[autocomplete*="new-password" i]',
      '[autocomplete*="one-time-code" i]',
      '[autocomplete*="cc-" i]',
    ].join(', ');
    const MARKER_SELECTOR = '[' + ${JSON.stringify(MARKER_ATTR)} + ']';

    // Fields whose value must be redacted wherever it appears on the page,
    // by live signal, not by mirrored attribute. Does NOT include
    // MARKER_SELECTOR -- see module comment above.
    const VALUE_SENSITIVE_SELECTOR = \`\${PASSWORD_TYPE_SELECTOR}, \${AUTOCOMPLETE_SELECTOR}\`;
    // Elements whose OWN value/data-* attributes get stripped in the clone.
    const ATTR_SCRUB_SELECTOR = \`\${VALUE_SENSITIVE_SELECTOR}, \${MARKER_SELECTOR}\`;

    // Persist "this input was once type=password" on the element itself, via
    // a WeakSet on window (not a DOM attribute), so a later "show password"
    // toggle (type switched to text) does not drop the field from the
    // sensitive set on a subsequent capture. WeakSet membership can't be
    // tested by a CSS selector, so matches from it are unioned in below.
    if (!window.__senWasPasswordInputs) window.__senWasPasswordInputs = new WeakSet();
    for (const el of document.querySelectorAll(PASSWORD_TYPE_SELECTOR)) {
      window.__senWasPasswordInputs.add(el);
    }

    const valueSensitiveEls = new Set(document.querySelectorAll(VALUE_SENSITIVE_SELECTOR));
    for (const el of document.querySelectorAll('input')) {
      if (window.__senWasPasswordInputs.has(el)) valueSensitiveEls.add(el);
    }

    // Collect the live typed value -- the .value PROPERTY, which is what a
    // user actually typed, not the \`value\` ATTRIBUTE outerHTML normally
    // serializes (they diverge the moment a user edits the field; a
    // mirrored attribute is the page re-syncing them itself). Redacted
    // as literal bytes wherever they occur below.
    const secretValues = new Set();
    for (const el of valueSensitiveEls) {
      if (el.value) secretValues.add(el.value);
    }

    // Inert clone: see module comment above for why this, not cloneNode.
    ${INERT_CLONE_FN_SRC}
    const clone = __senInertClone(document.documentElement);

    for (const el of clone.querySelectorAll(ATTR_SCRUB_SELECTOR)) {
      el.removeAttribute('value');
      for (const name of el.getAttributeNames()) {
        if (name.indexOf('data-') === 0) el.removeAttribute(name);
      }
    }

    let scrubbed = clone.outerHTML;
    for (const v of secretValues) {
      if (!v) continue;
      scrubbed = scrubbed.split(v).join('[REDACTED]');
    }

    return { raw, scrubbed };
  })()
`;
