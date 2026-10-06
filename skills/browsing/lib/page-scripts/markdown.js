// Page-side script: walk the DOM and emit token-efficient Markdown.
// Loaded as a string at attachCapture setup and embedded in CDP
// Runtime.evaluate. Tested directly against jsdom in
// test/lib/page-scripts/markdown.test.mjs.
//
// Includes images >= 100x100 in a header summary; inlines image references
// >= 50x50 with size info; skips smaller icons.
//
// Default secret-pattern redaction: this walks the LIVE DOM independently
// of page-scripts/html-with-scrub.js's clone/scrub (see that module's
// comment for why), so it needs its own pass of the same check. Two
// rules, both round-3 fixes (see html-with-scrub.js's module comment for
// the full rationale shared with the HTML artifact):
//
//   1. An element's text is redacted if IT ITSELF matches
//      secret-pattern.js's word-boundary detector (any strength -- a
//      leaf-level match is always honored, since its blast radius is
//      just that one element), OR if an ANCESTOR matches STRONGLY
//      ENOUGH to cover its whole subtree (an exact compound secret name,
//      e.g. "totp-secret", AND a small enough subtree -- see
//      __senElementIsStrongContainer). A WEAK ancestor match (a bare
//      "token"/"secret" on a big wrapper, e.g. a design-system class or
//      a docs landmark section) does NOT redact everything nested inside
//      it; only descendants that themselves independently match do.
//
//   2. Every block this generator emits (p, li, td, pre, h1-h6,
//      blockquote, and a figure's figcaption) is rendered through
//      __senRedactedText, which walks the subtree and replaces any
//      descendant satisfying rule 1 with [REDACTED] -- NOT via
//      el.textContent, which flattens a secret sitting INLINE inside the
//      block (`<p>Your setup key: <code id="totp-secret">SEED</code></p>`)
//      into clear text before that nested element ever gets its own,
//      separate (and too late) turn in the loop below. `a` is excluded
//      from both rules (like PATTERN_SKIP_TAGS in
//      html-with-scrub.js/secret-pattern.js): a link's own visible text
//      is a UI label, not the secret it operates on, even when it or an
//      ancestor matches.
//
// Trims before comparing length/emptiness exactly like the rest of this
// generator already does -- an earlier version of this redaction
// collected untrimmed leaf text into html-with-scrub.js's secretValues
// channel for this generator to depend on, so a leaf with leading/
// trailing whitespace never matched this already-trimmed text; that
// channel is gone now, matching happens directly here instead.
const {
  SECRET_LOOKING_ATTRS, LOOKS_SECRET_FN_SRC, OTPAUTH_URI_SOURCE,
  CONTAINER_BLANK_TEXT_CAP, SHORT_LEAF_BLANK_CAP,
} = require('../secret-pattern');

module.exports = `
  (() => {
    ${LOOKS_SECRET_FN_SRC}
    const __senSecretAttrs = ${JSON.stringify(SECRET_LOOKING_ATTRS)};
    // Container-blanking size cap, characters -- imported from
    // secret-pattern.js (round 4: previously a hand-duplicated literal
    // "2000" here AND in html-with-scrub.js, which could silently drift;
    // now one shared source -- see secret-pattern.js's module comment).
    const __senContainerCap = ${JSON.stringify(CONTAINER_BLANK_TEXT_CAP)};
    // Round 4 (jc minor #3): see secret-pattern.js's module comment
    // (SHORT_LEAF_BLANK_CAP) and __senShouldRedact's rule 1b below.
    const __senShortLeafCap = ${JSON.stringify(SHORT_LEAF_BLANK_CAP)};

    // Round 4 (jc finding 1): these three used to be defined separately
    // here AND in html-with-scrub.js, and had silently drifted -- this
    // generator wholesale-redacted ANY matched container regardless of
    // strength (ignoring leaf-or-strong-container entirely), the HTML
    // artifact required a strong compound under the cap. Now a single
    // shared implementation (secret-pattern.js's LOOKS_SECRET_FN_SRC),
    // thin wrappers here just supply this script's own
    // __senSecretAttrs/__senContainerCap, so the two artifacts can't
    // diverge on this again.
    function __senElementMatches(el) {
      return __senElementLooksSecretByPattern(el, __senSecretAttrs);
    }

    function __senElementIsStrongContainer(el) {
      return __senIsStrongContainerMatch(el, __senSecretAttrs, __senContainerCap);
    }

    // See module comment, rule 1. Rule 1a (this element itself matches)
    // now uses the SAME leaf-or-strong-container gate html-with-scrub.js
    // uses (jc finding 1) -- a weak-matched element WITH children (an
    // li class=mfa-tip, an MkDocs h2 id=managing-secrets) is no longer
    // wholesale-redacted just because it itself matches; only a leaf, or
    // a strong-enough container, is. Rule 1b (an ancestor matches
    // strongly but is OVER the size cap -- jc minor #3): still redact if
    // THIS element's own text is short enough to be the actual secret (a
    // recovery-codes li), even though the long prose around it,
    // elsewhere in the same over-cap container, is left alone.
    function __senShouldRedact(el) {
      if (__senShouldBlankWholesale(el, __senSecretAttrs, __senContainerCap)) return true;
      for (let node = el.parentElement; node; node = node.parentElement) {
        if (!__senElementMatches(node)) continue;
        if (__senElementIsStrongContainer(node)) return true;
        if (__senIsStrongCompoundMatch(node, __senSecretAttrs) &&
            (el.textContent || '').trim().length <= __senShortLeafCap) return true;
      }
      return false;
    }

    // See module comment, rule 2.
    function __senRedactedText(el) {
      if (__senShouldRedact(el)) return '[REDACTED]';
      let out = '';
      for (const child of el.childNodes) {
        if (child.nodeType === 3) out += child.textContent;
        else if (child.nodeType === 1) out += __senRedactedText(child);
      }
      return out;
    }

    const results = [];

    const title = document.title;
    if (title) results.push(\`# \${title}\\n\`);

    const allImages = document.querySelectorAll('img');
    const significantImages = Array.from(allImages).filter(img => {
      const rect = img.getBoundingClientRect();
      return rect.width >= 100 && rect.height >= 100;
    });

    if (significantImages.length > 0) {
      results.push(\`\\n**📷 This page contains \${significantImages.length} significant image(s). Check screenshot.png for visual content.**\\n\`);
    }

    const elements = document.querySelectorAll('h1, h2, h3, h4, h5, h6, p, a, li, pre, code, blockquote, table, img, figure');

    for (const el of elements) {
      const tag = el.tagName.toLowerCase();

      if (tag === 'img') {
        const secretHere = __senShouldRedact(el);
        const alt = secretHere ? '' : (el.alt || '');
        const src = el.src || '';
        const rect = el.getBoundingClientRect();
        if (rect.width >= 50 && rect.height >= 50) {
          const sizeInfo = \`\${Math.round(rect.width)}x\${Math.round(rect.height)}\`;
          const description = alt ? \`"\${alt}"\` : '(no alt text)';
          results.push(\`\\n![Image: \${description} - \${sizeInfo}](\${src})\\n\`);
        }
        continue;
      }

      if (tag === 'figure') {
        const figcaption = el.querySelector('figcaption');
        if (figcaption) {
          const figText = __senRedactedText(figcaption).trim();
          results.push(\`\\n*Figure: \${figText}*\\n\`);
        }
        continue;
      }

      if (tag === 'a') {
        // Never pattern-redacted -- a link's own visible text is a UI
        // label, not the secret it operates on, even when it or an
        // ancestor matches (see module comment).
        const text = el.textContent.trim();
        if (!text) continue;
        const href = el.href;
        results.push(\`[\${text}](\${href})\`);
        continue;
      }

      const text = __senRedactedText(el).trim();
      if (!text) continue;

      if (tag.startsWith('h')) {
        const level = parseInt(tag[1]);
        results.push(\`\${'#'.repeat(level)} \${text}\\n\`);
      } else if (tag === 'p') {
        results.push(\`\${text}\\n\`);
      } else if (tag === 'li') {
        results.push(\`- \${text}\`);
      } else if (tag === 'pre' || tag === 'code') {
        results.push(\`\\\`\\\`\\\`\\n\${text}\\n\\\`\\\`\\\`\\n\`);
      } else if (tag === 'blockquote') {
        results.push(\`> \${text}\\n\`);
      } else if (tag === 'table') {
        const rows = el.querySelectorAll('tr');
        if (rows.length > 0) {
          results.push('\\n| Table Content |\\n|---|');
          for (let i = 0; i < Math.min(rows.length, 10); i++) {
            const cells = rows[i].querySelectorAll('td, th');
            const cellTexts = Array.from(cells).map(cell => __senRedactedText(cell).trim()).slice(0, 3);
            if (cellTexts.length > 0) {
              results.push(\`| \${cellTexts.join(' | ')} |\`);
            }
          }
          results.push('\\n');
        }
      }
    }

    // Round 4 (jc finding 5): an otpauth:// URI is redacted wherever it
    // appears in the final output -- including inside a rendered
    // [text](href) link -- unconditionally, regardless of whether the
    // carrying element also matched the word-boundary secret-pattern
    // detector above. See secret-pattern.js for the full rationale.
    const joined = results.join('\\n').replace(new RegExp(${JSON.stringify(OTPAUTH_URI_SOURCE)}, 'gi'), '[REDACTED]');

    // Not truncated here: capture.js caps it after redacting secret values.
    return joined;
  })()
`;
