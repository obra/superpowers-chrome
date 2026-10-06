const { MARKER_ATTR } = require('../credential-guard');
const { INERT_CLONE_FN_SRC } = require('../secret-marker');
const { SECRET_LOOKING_ATTRS, PATTERN_SKIP_TAGS, LOOKS_SECRET_FN_SRC } = require('../secret-pattern');

// Page-side script: loaded as a string and embedded in CDP
// Runtime.evaluate by lib/capture.js.
//
// Returns { raw, scrubbed, secretValues }:
//   - `raw` is the plain document.documentElement.outerHTML. It is fed
//     unchanged into the credential-shape scan (lib/credential-guard.js),
//     so existing shape/marker detection (a token typed into a field, or a
//     data-sen-secret marker) keeps working exactly as before.
//   - `scrubbed` is what actually gets written to disk as HTML. It is
//     built two ways at once (see below): the matched field's own
//     `value` and `data-*`/`aria-*` attributes are stripped in an INERT
//     clone, and separately every live-typed value collected from those
//     fields (plus fields found only by self-mirror, see below) --
//     plus its HTML-entity-escaped forms, see below -- is redacted
//     wherever it appears in the resulting string.
//   - `secretValues` is the plain array of those same live-typed values,
//     so capture.js can apply the same
//     redaction to the markdown artifact, which is generated separately
//     from the live DOM and never passes through this clone/scrub.
//
// Why redact by value, not just by attribute:
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
// Why an inert clone, not `cloneNode(true)` on the live document:
// `el.cloneNode(true)` in the
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
// Detection signals for "this field's value must be redacted":
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
//     [...="one-time-code" i], [...="cc-number" i], [...="cc-csc" i]:
//     substring, not exact-token, match, so a real-world multi-token value
//     like autocomplete="section-2fa one-time-code" still matches, and case
//     folds so New-Password / ONE-TIME-CODE still match. Round 3 (jc
//     review, finding 1) narrowed this from a blanket `[autocomplete*="cc-"
//     i]` to just cc-number/cc-csc: the rest of the cc-* family
//     (cc-exp-month, cc-exp-year, cc-name, cc-type, ...) holds short,
//     common values (a two-digit month, a four-digit year, a name) with no
//     business being substring-redacted across the whole page -- see
//     MIN_SECRET_VALUE_LENGTH below for why that matters.
// `[data-sen-secret]` marked elements are still attribute-scrubbed as
// before, but deliberately excluded from value-collection: a marker
// element's visible text is intentionally left as-is here (existing
// behavior/tests) because a marked page is caught upstream by the
// shape/marker scan on `raw` and its whole capture is suppressed --
// scrubbing its text here would just be dead code for that path.
//
// Minimum length for value-based redaction: splitting/joining a short string across the *entire* serialized
// document risks corrupting unrelated markup that merely happens to
// contain the same bytes -- a one-digit value matches inside tag names
// ("h1"), prices ("$12.00"), and inline styles ("width:100px") anywhere on
// the page, not just inside the sensitive field's own mirror. Below this
// length, a field's own value/data-* attributes are still stripped (an
// exact attribute removal, not a substring scan, so it can't mangle
// anything else), but the value is not redacted wherever it occurs.
// cc-csc fields use a floor of 3 instead, because most card security
// codes are three digits.
//
// Entity-escaped forms: outerHTML
// entity-escapes `&`/`"`/`<`/`>` when serializing an attribute value, and
// `&`/`<`/`>` (not `"`) when serializing text-node content, and U+00A0
// as `&nbsp;` in both -- so the
// literal .value a user typed often never appears verbatim in the
// serialized output, only one of its escaped forms does. Both escaped
// variants of every secret value are redacted alongside the raw one.
//
// Self-mirror detection, finding a sensitive field with no recognized type
// or autocomplete at all: the selectors above all key off the
// FIELD -- a type, an autocomplete token, an explicit marker -- and a page
// that mirrors a typed value without ever tagging the field that way is
// invisible to every one of them. Google's 2-step verification page is a
// concrete case: its one-time-code input has no `type="password"` and no
// `autocomplete` value this module recognizes, but the page's own JS
// copies the typed code verbatim into `data-initial-value` -- the exact
// "as-you-type validation UI" pattern the module comment above already
// expects, just on a field this module couldn't otherwise flag. Rather
// than add more type/autocomplete tokens (there is no bounded list of
// them), a field is also flagged sensitive if its own live `.value`
// PROPERTY exactly matches ANY of its own attributes other than `value`
// itself -- not a fixed name list (`data-*`, `aria-*`), whichever
// attribute the page actually mirrors into. Two exclusions keep ordinary
// controls out: input types nobody types into (submit, button, reset,
// checkbox, radio, hidden, image) are never a source, and attributes that
// name or label a field (type, name, id, aria-label, title, placeholder,
// for, class) are not compared. Once flagged this way, the
// field's value is collected into `secretValues` exactly like any other
// sensitive field, so the substring pass below (which is already
// attribute- and element-agnostic) redacts it wherever it occurs. This is
// restricted to `input`/`textarea` -- elements with a `.value` to compare
// in the first place, not every element on the page -- and only widens
// which fields count as a value SOURCE; it does not change where a found
// value gets redacted.
//
// Default secret-pattern detection, no marking or click required: every
// signal above (type, autocomplete, self-mirror) still needs the field to
// either have a recognized shape or to have already mirrored a typed
// value somewhere -- neither helps a secret that is already sitting in
// the DOM at page load, before any action (and so before any
// data-sen-secret marking, which can only happen AFTER the action that
// reveals a value returns) has run at all. Real case: Slack's 2FA setup
// page (/account/settings/2fa_app) renders the TOTP seed into a hidden
// `#init_key_code` element from the moment the page loads, so the very
// first auto-capture of that page -- before any click, before any
// marking could happen -- would otherwise write the raw seed to disk.
// `looksSecretByPattern` (secret-pattern.js, shared with markdown.js) flags
// an element whose id/name/class/autocomplete/aria-label contains a
// secret-looking WORD -- split on `-`/`_`/camelCase/whitespace into
// segments, not a raw substring test; see that module for why (it also
// fixes two real false positives: "otp" inside "footprint" and "token"
// inside a "token-list" container). A matched value-bearing field
// (input/textarea/select) is unioned into valueSensitiveEls exactly like
// any other sensitive field, and its value is redacted by the ordinary
// document-wide substring pass below, with the ordinary length floor.
//
// A matched LEAF element (no element children -- a hidden span/input
// holding a seed as its value or text) has its own text blanked directly
// in the clone, by element reference, not by adding the text to
// `secretValues` for a page-wide substring replace: that text can be
// short and can coincide with ordinary words elsewhere on the page (a
// Prism-highlighted `class="token keyword"` span's own text is the word
// "class", and replacing every occurrence of "class" page-wide corrupts
// every `class="..."` attribute into `[REDACTED]="..."`). A matched
// CONTAINER (has element children, e.g. `<div id="totp-secret">`) is no
// longer skipped: every one of its own direct text-node children is
// blanked, and the same blanking recurses into every non-skip-tag
// descendant -- so `<div id="totp-secret">Key: <code>SEED</code></div>`
// and `<ul class="recovery-codes"><li>CODE1</li></ul>` are both fully
// redacted, not just a container's own (often nonexistent) direct text.
// Descendant elements also get the same value/data-*/aria-* attribute
// stripping as the container itself, on the assumption that anything
// inside a matched secret container is part of the secret's own
// rendering. Cost of this: a label mixed into the container's own text
// ("Key: " above) is blanked along with the secret next to it --
// accepted, since leaving a secret in clear to preserve a label is the
// wrong tradeoff. Interactive CONTROL tags (button/a/summary/label/
// legend/option, and script/style/noscript) are never recursed into or
// text-blanked even when matched, since a control's own visible text is a
// UI LABEL ("Copy"), not the secret it operates on, even when its id
// references one (`copy-seed-btn`); their own value/data-*/aria-*
// attributes are still stripped.
// Known false-positive class, accepted and documented rather than
// narrowed away: a bare "token" is broad enough to also match an ordinary
// CSRF token field ("csrf-token") -- that only blanks a value/text on the
// disk copy, never removes an element or touches the live page.
module.exports = `
  (() => {
    const raw = document.documentElement.outerHTML;

    // Shortest value that gets substring-redacted across the whole
    // document -- see module comment above.
    const MIN_SECRET_VALUE_LENGTH = 4;
    // Card security codes are 3 digits on most cards (4 on Amex), so they
    // get a floor of 3: a 3-digit CSC mirrored elsewhere must still be
    // redacted, at the cost of also replacing those digits in unrelated
    // markup.
    const CC_CSC_SELECTOR = '[autocomplete*="cc-csc" i]';
    const MIN_CC_CSC_VALUE_LENGTH = 3;

    const PASSWORD_TYPE_SELECTOR = 'input[type="password" i]';
    const AUTOCOMPLETE_SELECTOR = [
      '[autocomplete*="current-password" i]',
      '[autocomplete*="new-password" i]',
      '[autocomplete*="one-time-code" i]',
      '[autocomplete*="cc-number" i]',
      CC_CSC_SELECTOR,
    ].join(', ');
    const MARKER_SELECTOR = '[' + ${JSON.stringify(MARKER_ATTR)} + ']';

    // Default secret-pattern heuristics -- see module comment above for
    // why this exists (Slack's hidden #init_key_code at page load) and
    // secret-pattern.js for the word-boundary matching itself (shared
    // with markdown.js, so both artifacts agree on what counts).
    ${LOOKS_SECRET_FN_SRC}
    const SECRET_LOOKING_ATTRS = ${JSON.stringify(SECRET_LOOKING_ATTRS)};
    // Not text-containers worth blanking even when matched: no
    // human-visible content to leak, and leaving them alone keeps the
    // disk copy's inline script/style readable instead of noisily
    // replaced.
    // Also not text to blank: interactive CONTROL tags. A button/link
    // near a secret is routinely id'd after what it operates on --
    // "copy-seed-btn", "reveal-totp-link" -- but its own visible text is
    // a UI LABEL ("Copy"), never the secret value itself; blanking it
    // wrecks the capture's readability for no security benefit. Their
    // value/data-*/aria-* attributes are still stripped either way.
    const PATTERN_SKIP_TAGS = new Set(${JSON.stringify(PATTERN_SKIP_TAGS)});
    function looksSecretByPattern(el) {
      for (const attr of SECRET_LOOKING_ATTRS) {
        const v = el.getAttribute(attr);
        if (v && __senLooksSecretByPattern(v)) return true;
      }
      return false;
    }

    // Round 3 (jc finding 4): a matched CONTAINER is only safe to blank
    // WHOLESALE (every descendant's text, see blankMatchedSubtree below)
    // when the match is a strong, specific compound naming the secret
    // itself (totp-secret, recovery-codes, ... -- secret-pattern.js's
    // isCompoundSecretMatch), AND the container's text is small. Real
    // regressions this guards against: a design-system wrapper class
    // ("sn-token-provider") or a docs landmark (a <section
    // id="module-secrets">) matches the ordinary (weak) detector via a
    // single broad word ("token"/"secret") -- nowhere near as specific
    // as an actual secret-naming compound -- and wholesale-blanking
    // either wipes real page content the agent needs, not a secret. 2000
    // characters covers a realistic secret-setup widget (a seed/QR
    // caption plus a few short instructions or button labels) with
    // headroom; a real docs section or landmark is realistically tens of
    // KB, comfortably over this cap even before the compound-match
    // requirement. A LEAF match (no element children) is NOT gated by
    // this -- blanking one element's own text has no "wipe unrelated
    // content" blast radius regardless of match strength, so it stays
    // unconditional (see the clone-pass loop below). A CONTAINER that
    // fails this check still has its own attributes stripped, and the
    // clone-pass loop below still finds and blanks any DESCENDANT that
    // independently matches on its own id/class/etc -- only the
    // wholesale "redact everything nested inside" behavior is withheld.
    const CONTAINER_BLANK_TEXT_CAP = 2000;
    function isStrongContainerMatch(el) {
      for (const attr of SECRET_LOOKING_ATTRS) {
        const v = el.getAttribute(attr);
        if (v && __senIsCompoundSecretMatch(v)) {
          return (el.textContent || '').length <= CONTAINER_BLANK_TEXT_CAP;
        }
      }
      return false;
    }

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

    // A field whose type/autocomplete matches none of the above still
    // leaks its typed value if the page's own JS mirrors that value onto
    // one of the field's OWN attributes -- PR55's "as-you-type validation
    // UI" pattern (module comment above), just without a recognized type
    // or autocomplete token to flag the field in the first place. Google's
    // 2-step verification page is a concrete case: its one-time-code field
    // is a plain \`<input>\` with no \`type="password"\` and no
    // \`autocomplete\` value the list above recognizes, but the page's own
    // JS copies the typed code verbatim into \`data-initial-value\`.
    // Detected here by comparing the live \`.value\` PROPERTY against
    // every one of the element's own attributes -- not a fixed name list
    // (\`data-*\`, \`aria-*\`), any attribute a page chooses to mirror into
    // -- and unioning in any element with an exact match. Scoped to
    // \`input\`/\`textarea\` (elements with a \`.value\` to compare in the
    // first place), not every element on the page: this widens which
    // elements get treated as a VALUE SOURCE, not where a found value gets
    // redacted -- the substring pass below already covers any attribute on
    // any element once a value is in \`secretValues\`.
    //
    // Two exclusions keep ordinary controls from being flagged: input types nobody types into (a submit button's value
    // is its label, a radio's value is fixed by the page), and attributes
    // that name or label a field, which a page's value-sync JS does not
    // mirror into, so a match there is a coincidence (\`<input type="submit"
    // name="submit" value="submit">\`, a radio with \`id="male"
    // value="male"\`, Google's search button with an \`aria-label\` equal to
    // its value).
    const NON_TYPED_INPUT_TYPES = new Set(['submit', 'button', 'reset', 'checkbox', 'radio', 'hidden', 'image']);
    const NON_MIRROR_ATTRIBUTES = new Set(['value', 'type', 'name', 'id', 'aria-label', 'title', 'placeholder', 'for', 'class']);
    for (const el of document.querySelectorAll('input, textarea')) {
      if (valueSensitiveEls.has(el) || !el.value) continue;
      if (NON_TYPED_INPUT_TYPES.has(el.type)) continue;
      for (const name of el.getAttributeNames()) {
        if (NON_MIRROR_ATTRIBUTES.has(name)) continue;
        if (el.getAttribute(name) === el.value) {
          valueSensitiveEls.add(el);
          break;
        }
      }
    }

    // Default secret-pattern detection -- see module comment above
    // ("Default secret-pattern detection") and looksSecretByPattern
    // above. A value-bearing match (input/textarea/select) is unioned in
    // exactly like any other sensitive field; leaf (non-form, childless)
    // matches are handled separately below and in the clone pass, since
    // they have no .value PROPERTY for the loop just below to collect.
    const patternMatchedEls = Array.from(document.querySelectorAll('*')).filter(looksSecretByPattern);
    for (const el of patternMatchedEls) {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
        valueSensitiveEls.add(el);
      }
    }

    // Collect the live typed value -- the .value PROPERTY, which is what a
    // user actually typed, not the \`value\` ATTRIBUTE outerHTML normally
    // serializes (they diverge the moment a user edits the field; a
    // mirrored attribute is the page re-syncing them itself). Redacted
    // as literal bytes (and entity-escaped forms, see below) wherever they
    // occur below. Shorter than MIN_SECRET_VALUE_LENGTH is excluded from
    // this collection entirely -- see module comment above (finding 1) --
    // but the field's own value/data-* attributes are still stripped by
    // the exact-attribute-removal pass below regardless of length.
    const secretValues = new Set();
    for (const el of valueSensitiveEls) {
      const minLength = el.matches(CC_CSC_SELECTOR) ? MIN_CC_CSC_VALUE_LENGTH : MIN_SECRET_VALUE_LENGTH;
      if (el.value && el.value.length >= minLength) secretValues.add(el.value);
    }

    // Deliberately NOT collected into secretValues: a pattern-matched
    // leaf's own text. Unlike a typed field's .value (above), this text
    // can be short and can coincide with ordinary words used elsewhere on
    // the page (see module comment above -- the Prism \`class="token
    // keyword"\` case). The leaf's own occurrence, and every matched
    // container's descendant text, is blanked by element reference in the
    // clone pass below instead, which never touches text outside the
    // matched element's own subtree.

    // Inert clone: see module comment above for why this, not cloneNode.
    ${INERT_CLONE_FN_SRC}
    const clone = __senInertClone(document.documentElement);

    for (const el of clone.querySelectorAll(ATTR_SCRUB_SELECTOR)) {
      el.removeAttribute('value');
      for (const name of el.getAttributeNames()) {
        if (name.indexOf('data-') === 0 || name.indexOf('aria-') === 0) el.removeAttribute(name);
      }
    }

    // Strips value/data-*/aria-* from \`node\` (if it is itself an
    // element -- the inert document's root has no such attributes to
    // strip but is still walked for its children) and blanks every
    // direct text-node child, then recurses into every non-skip-tag
    // element child. Used for the whole subtree of a pattern-matched
    // element, so a matched LEAF (no element children -- just text nodes)
    // has that text blanked, and a matched CONTAINER (has element
    // children) has every one of its own text nodes AND every descendant
    // leaf's text blanked too -- see module comment above for why the
    // container case is no longer skipped.
    function blankMatchedSubtree(node) {
      if (node.nodeType === 1 && PATTERN_SKIP_TAGS.has(node.tagName)) return;
      if (node.nodeType === 1) {
        node.removeAttribute('value');
        for (const name of node.getAttributeNames()) {
          if (name.indexOf('data-') === 0 || name.indexOf('aria-') === 0) node.removeAttribute(name);
        }
      }
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3 && child.textContent && child.textContent.trim()) {
          child.textContent = '[REDACTED]';
        }
      }
      for (const child of Array.from(node.children || [])) {
        blankMatchedSubtree(child);
      }
    }

    // Default secret-pattern elements, re-matched directly on the CLONE
    // (same structure as the live document, so the same predicate finds
    // the same nodes -- no live-to-clone node mapping needed). Every
    // matched element's own value/data-*/aria-* attributes are stripped
    // unconditionally, like every other attr-scrub category above, even
    // when it is itself a skip-tag control -- only the recursive TEXT
    // blanking (blankMatchedSubtree) is skipped for those. A matched
    // CONTAINER (has element children) additionally needs
    // isStrongContainerMatch before its whole subtree is blanked -- see
    // that function's comment above (round 3 / jc finding 4). A matched
    // LEAF (no element children) is unconditional, as before: blanking
    // one element's own text has no "wipe unrelated content" blast
    // radius regardless of match strength.
    for (const el of clone.querySelectorAll('*')) {
      if (!looksSecretByPattern(el)) continue;
      el.removeAttribute('value');
      for (const name of el.getAttributeNames()) {
        if (name.indexOf('data-') === 0 || name.indexOf('aria-') === 0) el.removeAttribute(name);
      }
      if (el.childElementCount === 0 || isStrongContainerMatch(el)) {
        blankMatchedSubtree(el);
      }
    }

    // outerHTML's two entity-escaping rules: an attribute value escapes &/"/</> and U+00A0; text-node content
    // escapes &/</> and U+00A0 but not ". Redacting all three forms
    // (literal, attribute-escaped, text-escaped) of each secret value
    // covers both.
    const escapeForAttribute = (s) => s.replace(/&/g, '&amp;').replace(/\\u00a0/g, '&nbsp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const escapeForText = (s) => s.replace(/&/g, '&amp;').replace(/\\u00a0/g, '&nbsp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    let scrubbed = clone.outerHTML;
    for (const v of secretValues) {
      const variants = new Set([v, escapeForAttribute(v), escapeForText(v)]);
      for (const variant of variants) {
        if (!variant) continue;
        scrubbed = scrubbed.split(variant).join('[REDACTED]');
      }
    }

    // secretValues is exposed alongside raw/scrubbed so capture.js can
    // apply the same redaction to the markdown artifact: generateMarkdown walks the live DOM separately
    // and is never run through this clone/scrub, so without this a value
    // echoed into visible text would be redacted from .html but written
    // to .md in clear. Not meaningfully more exposure than raw already
    // carries: a value collected here already reaches raw through
    // whichever mirror put it on the page.
    return { raw, scrubbed, secretValues: Array.from(secretValues) };
  })()
`;
