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
// "reveal-totp-link"). SCRIPT/STYLE/NOSCRIPT are never human-visible text
// worth blanking either. Shared so html-with-scrub.js's clone pass and
// markdown.js's generator agree on what to skip.
const PATTERN_SKIP_TAGS = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'BUTTON', 'A', 'SUMMARY', 'LABEL', 'LEGEND', 'OPTION'];

// Function SOURCE (a string), not a live function, so the identical code
// can be spliced into more than one page-side CDP Runtime.evaluate string
// (html-with-scrub.js, markdown.js) without hand-duplicating it and
// risking the two copies drifting apart. See the module comment above for
// the word-boundary rationale.
const LOOKS_SECRET_FN_SRC = `
  function __senLooksSecretByPattern(value) {
    if (!value) return false;
    // Letter-to-digit boundary first ("setup2faKey" -> "setup 2fa Key"),
    // so a digit-led word like "2fa" splits off its ALPHABETIC prefix but
    // stays joined to the letters immediately after it -- only the
    // lowercase/digit-to-UPPERCASE camelCase boundary (next) would leave
    // "setup2fa" fused into one token, never equal to the bare word "2fa".
    var spaced = String(value).replace(/([a-zA-Z])([0-9])/g, '$1 $2').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    var tokens = spaced.split(/[^a-zA-Z0-9]+/).filter(Boolean).map(function (s) { return s.toLowerCase(); });

    function singular(w) {
      return (w.length > 2 && w.charAt(w.length - 1) === 's') ? w.slice(0, -1) : w;
    }

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
      var ts = singular(t);
      var standaloneHit = STANDALONE.indexOf(t) !== -1 ? t : (STANDALONE.indexOf(ts) !== -1 ? ts : null);
      if (standaloneHit) {
        if (standaloneHit === 'token') {
          var prev = i > 0 ? tokens[i - 1] : null;
          var next = i + 1 < tokens.length ? tokens[i + 1] : null;
          var prevIsCollection = !!prev && (COLLECTION.indexOf(prev) !== -1 || COLLECTION.indexOf(singular(prev)) !== -1);
          var nextIsCollection = !!next && (COLLECTION.indexOf(next) !== -1 || COLLECTION.indexOf(singular(next)) !== -1);
          if (prevIsCollection || nextIsCollection) continue;
        }
        return true;
      }
      if (i + 1 < tokens.length) {
        var a = t, b = tokens[i + 1];
        var as = singular(a), bs = singular(b);
        if (PAIRS.indexOf(a + b) !== -1 || PAIRS.indexOf(as + b) !== -1 ||
            PAIRS.indexOf(a + bs) !== -1 || PAIRS.indexOf(as + bs) !== -1) {
          return true;
        }
      }
    }
    return false;
  }
`;

// Node-side copy of the exact same function, for direct unit testing
// without going through jsdom or a CDP round-trip. Built from
// LOOKS_SECRET_FN_SRC itself (via `Function(...)`) rather than a
// hand-duplicated copy, so the tested code and the code actually spliced
// into the page scripts can never diverge.
const looksSecretByPattern = new Function(`${LOOKS_SECRET_FN_SRC}\nreturn __senLooksSecretByPattern;`)();

module.exports = {
  SECRET_LOOKING_ATTRS,
  PATTERN_SKIP_TAGS,
  LOOKS_SECRET_FN_SRC,
  looksSecretByPattern,
};
