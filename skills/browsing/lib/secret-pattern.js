// Shared "does this identifier look like it names a secret" detector.
//
// Used by both the HTML/attribute scrubbing pass
// (page-scripts/html-with-scrub.js) and the Markdown generator
// (page-scripts/markdown.js), via LOOKS_SECRET_FN_SRC below, so a page
// element is judged secret-looking (or not) by exactly one rule instead of
// two detectors that could silently drift apart.
//
// Matches on WORD/SEGMENT boundaries, never a raw substring test. The
// id/name/class/autocomplete/aria-label value is split on `-`, `_`,
// whitespace and camelCase boundaries into lowercase words, and a word
// only counts if it (or its singular form) equals one of the known
// secret-looking words below, or is immediately adjacent to its pair
// partner for the two-word phrases. A plain substring test (the original
// shape of this detector) also matched:
//   - "otp" inside "footprint" -- those three letters just happen to run
//     together in the middle of an unrelated word, with no separator at
//     all to signal a word boundary;
//   - "token" inside a container id like "token-list" or "tokens-table" --
//     a page section that LISTS token names/metadata, not a page that
//     holds a token VALUE.
// Neither is caught by the length floor elsewhere in html-with-scrub.js;
// that floor is about value LENGTH, not identifier CONTENT.
//
// "token" is the one standalone word broad enough to collide with an
// ordinary, non-secret UI collection this way in practice (a settings page
// literally named "tokens" that lists API-token names/scopes/dates, never
// the token value itself -- GitHub's own PAT settings page is exactly
// this shape). It is narrowed with COLLECTION_WORDS below, immediately
// adjacent on either side. The other standalone words (secret, totp, otp,
// 2fa, mfa, seed, recovery) are specific enough that this repo has not
// seen the same false-positive shape for them, so they are not narrowed
// the same way -- narrowing a word nobody has shown a false positive for
// yet only risks a missed match (a leak), which is worse than an extra
// one (a degraded capture). A bare CSRF/auth-token field ("csrf-token",
// "authToken") is still intentionally matched: that is a known,
// documented false-positive tradeoff, not the bug this fixes.
const SECRET_LOOKING_ATTRS = ['id', 'name', 'class', 'autocomplete', 'aria-label'];

// Tags whose own rendered text is a UI LABEL, not the secret the tag
// operates on, even when the tag's own id/class matches ("copy-seed-btn",
// "reveal-totp-link"): BUTTON and A. SCRIPT/STYLE/NOSCRIPT are never
// human-visible text worth blanking either, and are never a meaningful
// recursion target. Narrowed (round 4 / jc finding 5) from an earlier
// version that also skip-blanked SUMMARY/LABEL/LEGEND/OPTION -- those are
// not controls with their OWN separate operator text the way a button or
// link is (a <label> wrapping a matched <code> is routinely the ONLY
// place the secret is rendered at all), so they are no longer exempt:
// their own text is blanked like any other element, and
// html-with-scrub.js's blankMatchedSubtree now recurses into them.
const PATTERN_SKIP_TAGS = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'BUTTON', 'A'];

// Round 3 (jc): "blank the whole matched container" is only safe when the
// match is SPECIFIC, not merely a broad single word. A real-world wrapper
// like a design-system class ("sn-token-provider"), or a docs
// `<section id="module-secrets">`, matches the ordinary (weak) detector
// above via the bare standalone word "token"/"secret" -- but blanking
// EITHER of those whole sections as "the secret" wipes ordinary page
// content the agent actually needs. `__senIsCompoundSecretMatch` below is
// the stronger, narrower test used ONLY to decide whether a matched
// CONTAINER (an element with element children, not a leaf) is safe to
// blank wholesale: an EXACT two-word compound naming the secret itself,
// not a single generic word. See html-with-scrub.js's module comment for
// how this combines with a size cap, and why container blanking needs
// this gate at all. Leaf blanking (no element children) is unaffected --
// a leaf's own matched text is always blanked regardless of this
// strength check, since its blast radius is just that one element.
const STRONG_COMPOUND_PAIRS = [
  'keycode', 'backupcode', 'apikey', // same pairs the general matcher uses
  'totpsecret', 'secretkey', 'recoverycode', 'privatekey', // container-strength additions
  // Round 4 (jc): without these, html-with-scrub.js left the seed in
  // clear for `<p class="otp-secret">Key: <strong>SEED</strong></p>` and
  // `<div id="mfa-secret"><span>SEED</span></div>` -- both ARE exact,
  // specific secret-naming compounds, just not ones the original list
  // happened to include.
  'otpsecret', 'mfasecret', 'setupkey', 'totpkey', '2fasecret', 'secretcode',
];

// Round 4 (jc finding 2): Prism.js's own generated class name for every
// highlighted span is a bare "token" class alongside a SEPARATE type-word
// class (`class="token keyword"`, `"token operator"`, `"token string"`,
// ...) -- which collides with the standalone "token" secret word above
// and wiped every Prism-highlighted code sample (and, via
// prism-react-renderer/Docusaurus's near-identical output, every
// Markdown-doc-site code sample) from BOTH artifacts. Not exhaustive,
// but covers every type word jc named plus the rest of Prism's own
// language-independent set, which is what a real highlighted snippet in
// nearly any language produces. Used only to EXEMPT a match (never to
// add one), and only ever consulted for the "class" attribute
// specifically (id/name/autocomplete/aria-label are never Prism-
// generated) -- see __senIsPrismTokenSpan below for the full guard
// (gated on being inside a <pre>/<code> block) that keeps this from
// ever exempting a genuine `<code class="api-token">` secret, which is
// one hyphenated class, never a bare "token" class sitting alongside
// another class.
const PRISM_TYPE_WORDS = [
  'keyword', 'punctuation', 'string', 'operator', 'function', 'comment',
  'number', 'boolean', 'builtin', 'important', 'atrule', 'selector',
  'property', 'url', 'regex', 'variable', 'constant', 'tag', 'namespace',
  'symbol', 'char', 'entity', 'class-name', 'attr-name', 'attr-value',
  'parameter', 'deleted', 'inserted', 'bold', 'italic', 'title', 'plain-text',
  // prism-react-renderer (Docusaurus) wraps every non-highlighted text
  // run in its own "token plain" span too, to keep a consistent DOM
  // shape for styling -- not just the highlighted ones.
  'plain',
];

// Function SOURCE (a string), not a live function, so the identical code
// can be spliced into more than one page-side CDP Runtime.evaluate string
// (html-with-scrub.js, markdown.js) without hand-duplicating it and
// risking the two copies drifting apart. See the module comment above for
// the word-boundary rationale.
const LOOKS_SECRET_FN_SRC = `
  function __senTokenize(value) {
    if (!value) return [];
    // Letter-to-digit boundary first ("setup2faKey" -> "setup 2fa Key"),
    // so a digit-led word like "2fa" splits off its ALPHABETIC prefix but
    // stays joined to the letters immediately after it -- only the
    // lowercase/digit-to-UPPERCASE camelCase boundary (next) would leave
    // "setup2fa" fused into one token, never equal to the bare word "2fa".
    var spaced = String(value).replace(/([a-zA-Z])([0-9])/g, '$1 $2').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    return spaced.split(/[^a-zA-Z0-9]+/).filter(Boolean).map(function (s) { return s.toLowerCase(); });
  }

  function __senSingular(w) {
    return (w.length > 2 && w.charAt(w.length - 1) === 's') ? w.slice(0, -1) : w;
  }

  function __senLooksSecretByPattern(value) {
    var tokens = __senTokenize(value);

    // Standalone words that count as secret-looking on their own.
    var STANDALONE = ['secret', 'totp', 'otp', '2fa', 'mfa', 'seed', 'recovery', 'token'];
    // Two-word phrases. The original (pre-word-boundary) pattern allowed an
    // optional separator between these pairs (key[-_]?code, backup[-_]?code,
    // api[-_]?key); tokenizing already splits on that separator (or on the
    // camelCase boundary if there is no separator at all), so the pair is
    // checked as two ADJACENT tokens instead of one regex alternative.
    var PAIRS = ['keycode', 'backupcode', 'apikey'];
    // See the module comment (secret-pattern.js) for why only "token" is
    // narrowed against these, and only when immediately adjacent.
    var COLLECTION = ['list', 'table', 'history', 'log'];

    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      var ts = __senSingular(t);
      var standaloneHit = STANDALONE.indexOf(t) !== -1 ? t : (STANDALONE.indexOf(ts) !== -1 ? ts : null);
      if (standaloneHit) {
        if (standaloneHit === 'token') {
          var prev = i > 0 ? tokens[i - 1] : null;
          var next = i + 1 < tokens.length ? tokens[i + 1] : null;
          var prevIsCollection = !!prev && (COLLECTION.indexOf(prev) !== -1 || COLLECTION.indexOf(__senSingular(prev)) !== -1);
          var nextIsCollection = !!next && (COLLECTION.indexOf(next) !== -1 || COLLECTION.indexOf(__senSingular(next)) !== -1);
          if (prevIsCollection || nextIsCollection) continue;
        }
        return true;
      }
      if (i + 1 < tokens.length) {
        var a = t, b = tokens[i + 1];
        var as = __senSingular(a), bs = __senSingular(b);
        if (PAIRS.indexOf(a + b) !== -1 || PAIRS.indexOf(as + b) !== -1 ||
            PAIRS.indexOf(a + bs) !== -1 || PAIRS.indexOf(as + bs) !== -1) {
          return true;
        }
      }
    }
    return false;
  }

  // See the module comment above (STRONG_COMPOUND_PAIRS) for why this is a
  // separate, narrower test from __senLooksSecretByPattern, used only to
  // decide whether a matched CONTAINER is safe to blank wholesale.
  function __senIsCompoundSecretMatch(value) {
    var tokens = __senTokenize(value);
    var STRONG_PAIRS = ${JSON.stringify(STRONG_COMPOUND_PAIRS)};
    for (var i = 0; i + 1 < tokens.length; i++) {
      var a = tokens[i], b = tokens[i + 1];
      var as = __senSingular(a), bs = __senSingular(b);
      if (STRONG_PAIRS.indexOf(a + b) !== -1 || STRONG_PAIRS.indexOf(as + b) !== -1 ||
          STRONG_PAIRS.indexOf(a + bs) !== -1 || STRONG_PAIRS.indexOf(as + bs) !== -1) {
        return true;
      }
    }
    return false;
  }

  // Round 4 (jc finding 2): see the module comment above (PRISM_TYPE_WORDS)
  // for the false positive this guards against. Checked on the RAW
  // whitespace-split class list, NOT __senTokenize (which would also
  // split a genuine single hyphenated class like "api-token" into
  // separate "api"/"token" tokens and lose the distinction entirely):
  // a Prism-generated span always has "token" as its OWN, SEPARATE
  // space-delimited class, sitting alongside another class -- never
  // fused into one hyphenated class the way a real secret-naming class
  // would be.
  function __senIsPrismTokenSpan(el) {
    if (!el.closest || !el.closest('pre, code')) return false;
    var classes = (el.getAttribute('class') || '').split(/\\s+/).filter(Boolean);
    var PRISM_WORDS = ${JSON.stringify(PRISM_TYPE_WORDS)};
    if (classes.indexOf('token') !== -1) {
      for (var i = 0; i < classes.length; i++) {
        if (classes[i] !== 'token' && PRISM_WORDS.indexOf(classes[i]) !== -1) return true;
      }
    }
    for (var j = 0; j < classes.length; j++) {
      // Only prism-react-renderer's exact 'token-line' wrapper: a 'token-*'
      // wildcard would also exempt <code class="token-value">SECRET</code>.
      if (classes[j] === 'token-line') return true;
    }
    return false;
  }

  // THE shared element-level match check (jc finding 1 AND finding 2,
  // round 4): html-with-scrub.js and markdown.js each used to define
  // their own, near-identical copy of "does this element match on any
  // of its secret-looking attributes" -- one shared function now, so
  // the Prism exemption and any future change to this check apply
  // identically to both artifacts. The Prism exemption is applied ONLY
  // to the 'class' attribute's value (Prism/prism-react-renderer never
  // generate id/name/autocomplete/aria-label) and only SUBTRACTS the
  // Prism-shaped classes before re-checking -- an element that also
  // matches via a different word in 'class', or via a different
  // attribute entirely, still matches normally.
  function __senElementLooksSecretByPattern(el, secretAttrs) {
    for (var i = 0; i < secretAttrs.length; i++) {
      var attr = secretAttrs[i];
      var v = el.getAttribute && el.getAttribute(attr);
      if (!v) continue;
      if (attr === 'class' && __senIsPrismTokenSpan(el)) {
        var kept = v.split(/\\s+/).filter(function (c) {
          return c !== 'token' && c !== 'token-line';
        }).join(' ');
        if (kept && __senLooksSecretByPattern(kept)) return true;
        continue;
      }
      if (__senLooksSecretByPattern(v)) return true;
    }
    return false;
  }

  // Compound match regardless of the size cap -- used both by
  // __senIsStrongContainerMatch (which adds the cap) and, separately, by
  // the over-cap fallback (jc minor #3) that still blanks a strong-named
  // container's own SHORT leaf descendants even when the container
  // itself is too big to blank wholesale.
  function __senIsStrongCompoundMatch(el, secretAttrs) {
    for (var i = 0; i < secretAttrs.length; i++) {
      var v = el.getAttribute && el.getAttribute(secretAttrs[i]);
      if (v && __senIsCompoundSecretMatch(v)) return true;
    }
    return false;
  }

  function __senIsStrongContainerMatch(el, secretAttrs, cap) {
    if (!__senIsStrongCompoundMatch(el, secretAttrs)) return false;
    return (el.textContent || '').length <= cap;
  }

  // THE shared gate (jc finding 1, round 4): matches AND (is a leaf OR
  // is a strong-enough container under the cap). Used identically by
  // html-with-scrub.js's clone-pass loop and markdown.js's
  // __senShouldRedact, so the two artifacts can never again diverge on
  // which matched elements get wholesale-blanked -- this exact
  // divergence (markdown.js blanked ANY matched container regardless of
  // strength; html-with-scrub.js required a strong compound under the
  // cap) is what jc's finding 1 reported.
  function __senShouldBlankWholesale(el, secretAttrs, cap) {
    if (!__senElementLooksSecretByPattern(el, secretAttrs)) return false;
    return el.childElementCount === 0 || __senIsStrongContainerMatch(el, secretAttrs, cap);
  }
`;

// Shared size caps (round 4 / jc minor #3 and finding 1): previously
// hand-duplicated as a literal `2000` in both html-with-scrub.js and
// markdown.js ("same number, kept in sync by hand" per the old comment)
// -- one more thing that could silently drift, now a single source.
//
// CONTAINER_BLANK_TEXT_CAP: see the module comment above
// (STRONG_COMPOUND_PAIRS) and html-with-scrub.js's isStrongContainerMatch
// for the full rationale -- a strong-named container is safe to blank
// wholesale only up to this size.
//
// SHORT_LEAF_BLANK_CAP: a strong-named container OVER
// CONTAINER_BLANK_TEXT_CAP (e.g. a recovery-codes widget with ~2000+
// characters of explanatory prose around the actual code list) used to
// leak its own unnamed children entirely -- the cap withheld wholesale
// blanking, and nothing else picked up the slack. The simplest rule that
// blanks the codes and keeps the prose (jc minor #3): even when the
// container itself is too big to blank wholesale, still blank any LEAF
// descendant (no element children of its own) whose own trimmed text is
// this short or shorter -- a `<li>`/`<code>` holding one short code is
// comfortably under this; a real paragraph of guidance text is not.
const CONTAINER_BLANK_TEXT_CAP = 2000;
const SHORT_LEAF_BLANK_CAP = 64;

// Node-side copies of the exact same functions, for direct unit testing
// without going through jsdom or a CDP round-trip. Built from
// LOOKS_SECRET_FN_SRC itself (via `Function(...)`) rather than a
// hand-duplicated copy, so the tested code and the code actually spliced
// into the page scripts can never diverge.
const looksSecretByPattern = new Function(`${LOOKS_SECRET_FN_SRC}\nreturn __senLooksSecretByPattern;`)();
const isCompoundSecretMatch = new Function(`${LOOKS_SECRET_FN_SRC}\nreturn __senIsCompoundSecretMatch;`)();
// elementLooksSecretByPattern/isStrongContainerMatch/shouldBlankWholesale
// take a real DOM element (jsdom in tests, a live element in the page),
// not a plain string -- the element-level gate functions above all need
// el.getAttribute/.closest/.childElementCount/.textContent.
const elementLooksSecretByPattern = new Function(`${LOOKS_SECRET_FN_SRC}\nreturn __senElementLooksSecretByPattern;`)();
const isStrongContainerMatch = new Function(`${LOOKS_SECRET_FN_SRC}\nreturn __senIsStrongContainerMatch;`)();
const isStrongCompoundMatch = new Function(`${LOOKS_SECRET_FN_SRC}\nreturn __senIsStrongCompoundMatch;`)();
const shouldBlankWholesale = new Function(`${LOOKS_SECRET_FN_SRC}\nreturn __senShouldBlankWholesale;`)();
const isPrismTokenSpan = new Function(`${LOOKS_SECRET_FN_SRC}\nreturn __senIsPrismTokenSpan;`)();

// Round 4 (jc finding 5): an otpauth:// URI is a self-describing TOTP/HOTP
// provisioning credential -- RFC-less but a de facto standard every
// authenticator app and TOTP library recognizes -- so ANY occurrence
// anywhere in a capture (an <a href="otpauth://...">, an <img src="...">,
// a data-* attribute, visible text, or a QR image's alt/title) is
// redacted outright, regardless of whether the element carrying it also
// matches the word-boundary secret-pattern detector above. This is
// unconditional and independent of looksSecretByPattern: an otpauth://
// URI needs no id/name/class signal to be recognized as a credential:
// the URI scheme itself says so. Applied as a single global
// string-replace over the FINAL serialized capture (html-with-scrub.js's
// `scrubbed` string, markdown.js's joined output) rather than scrubbing
// individual attributes before serialization -- outerHTML/the markdown
// join already puts href/src/data-*/alt/title/text content all into one
// string, so one pass catches every carriage at once. Mirrors the shape
// credential-guard.js's TOKEN_SHAPES otpauth entry already uses to
// trigger whole-page suppression; this is the same URI shape applied as
// a targeted scrub instead.
const OTPAUTH_URI_SOURCE = 'otpauth://[^\\s"\'<>]+';
const OTPAUTH_URI_PATTERN = new RegExp(OTPAUTH_URI_SOURCE, 'gi');

module.exports = {
  SECRET_LOOKING_ATTRS,
  PATTERN_SKIP_TAGS,
  STRONG_COMPOUND_PAIRS,
  PRISM_TYPE_WORDS,
  CONTAINER_BLANK_TEXT_CAP,
  SHORT_LEAF_BLANK_CAP,
  OTPAUTH_URI_SOURCE,
  OTPAUTH_URI_PATTERN,
  LOOKS_SECRET_FN_SRC,
  looksSecretByPattern,
  isCompoundSecretMatch,
  elementLooksSecretByPattern,
  isStrongContainerMatch,
  isStrongCompoundMatch,
  shouldBlankWholesale,
  isPrismTokenSpan,
};
