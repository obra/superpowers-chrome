// Page-side script: walk the DOM and emit token-efficient Markdown.
// Loaded as a string at attachCapture setup and embedded in CDP
// Runtime.evaluate. Tested directly against jsdom in
// test/lib/page-scripts/markdown.test.mjs.
//
// Includes images >= 100x100 in a header summary; inlines image references
// >= 50x50 with size info; skips smaller icons.
module.exports = `
  (() => {
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
      const text = el.textContent.trim();

      if (tag === 'img') {
        const alt = el.alt || '';
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
          results.push(\`\\n*Figure: \${figcaption.textContent.trim()}*\\n\`);
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
            const cellTexts = Array.from(cells).map(cell => cell.textContent.trim()).slice(0, 3);
            if (cellTexts.length > 0) {
              results.push(\`| \${cellTexts.join(' | ')} |\`);
            }
          }
          results.push('\\n');
        }
      }
    }

    return results.join('\\n').slice(0, 50000); // Limit size
  })()
`;
