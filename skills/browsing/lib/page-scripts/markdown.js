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
// comment for why), so it needs its own pass of the same check -- an
// element whose own id/name/class/autocomplete/aria-label, OR ANY
// ANCESTOR's, matches secret-pattern.js's word-boundary detector has its
// text rendered as [REDACTED] here instead of its real textContent. This
// catches the same containers html-with-scrub.js's clone pass now fully
// blanks (a matched `<div>`/`<ul>` wrapping a `<code>`/`<li>` that holds
// the actual secret), not just an element that matches directly, and
// trims before comparing length/emptiness exactly like the rest of this
// generator already does -- untrimmed text was collected into the old
// html-with-scrub.js secretValues channel this generator used to depend
// on for the SAME redaction, so a leaf with leading/trailing whitespace
// never matched the already-trimmed markdown text; that channel is gone
// now, matching happens directly here instead. \`a\` is excluded (like
// PATTERN_SKIP_TAGS in html-with-scrub.js/secret-pattern.js): a link's
// own visible text is a UI label, not the secret it operates on, even
// when it or an ancestor matches.
const { SECRET_LOOKING_ATTRS, LOOKS_SECRET_FN_SRC } = require('../secret-pattern');

module.exports = `
  (() => {
    ${LOOKS_SECRET_FN_SRC}
    const __senSecretAttrs = ${JSON.stringify(SECRET_LOOKING_ATTRS)};
    function __senMatchesSecretOrAncestor(el) {
      for (let node = el; node; node = node.parentElement) {
        for (const attr of __senSecretAttrs) {
          const v = node.getAttribute && node.getAttribute(attr);
          if (v && __senLooksSecretByPattern(v)) return true;
        }
      }
      return false;
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
      // 'a' is excluded from pattern-based blanking -- see module comment
      // above (its own visible text is a UI label, not the secret).
      const secretHere = tag !== 'a' && __senMatchesSecretOrAncestor(el);
      const text = secretHere ? (el.textContent.trim() ? '[REDACTED]' : '') : el.textContent.trim();

      if (tag === 'img') {
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
          const figSecret = __senMatchesSecretOrAncestor(figcaption);
          const figText = figSecret ? '[REDACTED]' : figcaption.textContent.trim();
          results.push(\`\\n*Figure: \${figText}*\\n\`);
        }
        continue;
      }

      if (!text) continue;

      if (tag.startsWith('h')) {
        const level = parseInt(tag[1]);
        results.push(\`\${'#'.repeat(level)} \${text}\\n\`);
      } else if (tag === 'p') {
        results.push(\`\${text}\\n\`);
      } else if (tag === 'a') {
        const href = el.href;
        results.push(\`[\${text}](\${href})\`);
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
            const cellTexts = Array.from(cells).map(cell => __senMatchesSecretOrAncestor(cell) ? '[REDACTED]' : cell.textContent.trim()).slice(0, 3);
            if (cellTexts.length > 0) {
              results.push(\`| \${cellTexts.join(' | ')} |\`);
            }
          }
          results.push('\\n');
        }
      }
    }

    // Not truncated here: capture.js caps it after redacting secret values.
    return results.join('\\n');
  })()
`;
