// Page-side script: the text a screenshot of the page would show, for the
// credential guard (lib/credential-guard.js). Loaded as a string and
// embedded in CDP Runtime.evaluate by lib/capture.js.
//
// outerHTML and the markdown extractor both miss rendered text:
//   - document.body.innerText joins inline runs, so a token split across
//     <span>s reads as one string;
//   - open shadow roots are not serialized by outerHTML, so each one's
//     textContent is collected, recursing into nested roots;
//   - live input/textarea values (set by script) are not in outerHTML,
//     which only carries the value attribute.
// Closed shadow roots and cross-origin iframes are out of reach.
module.exports = `
  (() => {
    const parts = [document.body ? document.body.innerText : ''];
    const visit = (root) => {
      for (const field of root.querySelectorAll('input, textarea')) parts.push(field.value);
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) {
          parts.push(el.shadowRoot.textContent);
          visit(el.shadowRoot);
        }
      }
    };
    visit(document);
    return parts.join('\\n');
  })()
`;
