/**
 * Element selector helpers — pure functions that produce JavaScript source
 * strings to be evaluated in the page via CDP Runtime.evaluate.
 *
 * No closure state, no Chrome session dependency. The returned strings are
 * interpolated into larger CDP `expression` payloads.
 */

// Generate element selection code (supports CSS and XPath).
// Prefers visible elements (non-zero bounding rect) over hidden ones.
// Falls back to first DOM match with a console.warn if all matches are hidden.
// For XPath with text()='...', also tries normalize-space() fallback for mixed content elements.
function getElementSelector(selector) {
  if (selector.startsWith('/') || selector.startsWith('//')) {
    // XPath selector - collect all matches, prefer visible
    const hasTextEquals = /text\(\)\s*=\s*['"]/.test(selector);
    const xpaths = [JSON.stringify(selector)];
    if (hasTextEquals) {
      const fallbackSelector = selector.replace(/text\(\)\s*=\s*(['"])(.*?)\1/g, "normalize-space()=$1$2$1");
      xpaths.push(JSON.stringify(fallbackSelector));
    }
    return `(() => {
      var all = [];
      var seen = new Set();
      [${xpaths.join(', ')}].forEach(function(xpath) {
        var iter = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
        var node;
        while (node = iter.iterateNext()) {
          if (!seen.has(node)) { seen.add(node); all.push(node); }
        }
      });
      if (all.length === 0) return null;
      var visible = all.find(function(el) {
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (visible) return visible;
      console.warn('[superpowers-chrome] All ' + all.length + ' elements matching XPath have zero dimensions; using first match');
      return all[0];
    })()`;
  } else {
    // CSS selector - prefer visible elements
    return `(() => {
      var all = document.querySelectorAll(${JSON.stringify(selector)});
      if (all.length === 0) return null;
      var visible = Array.from(all).find(function(el) {
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (visible) return visible;
      console.warn('[superpowers-chrome] All ' + all.length + ' elements matching ' + ${JSON.stringify(JSON.stringify(selector))} + ' have zero dimensions; using first match');
      return all[0];
    })()`;
  }
}

// Get all matching elements (used by multi-element warnings).
// For XPath with text()='...', also tries normalize-space() fallback for mixed content elements.
function getElementSelectorAll(selector) {
  if (selector.startsWith('/') || selector.startsWith('//')) {
    // XPath - get all matches, with fallback for text()='...' patterns
    const hasTextEquals = /text\(\)\s*=\s*['"]/.test(selector);
    if (hasTextEquals) {
      const fallbackSelector = selector.replace(/text\(\)\s*=\s*(['"])(.*?)\1/g, "normalize-space()=$1$2$1");
      return `(() => {
        const result = [];
        const seen = new Set();
        for (const xpath of [${JSON.stringify(selector)}, ${JSON.stringify(fallbackSelector)}]) {
          const iterator = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
          let node;
          while (node = iterator.iterateNext()) {
            if (!seen.has(node)) { seen.add(node); result.push(node); }
          }
        }
        return result;
      })()`;
    }
    return `(() => {
      const result = [];
      const iterator = document.evaluate(${JSON.stringify(selector)}, document, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
      let node;
      while (node = iterator.iterateNext()) result.push(node);
      return result;
    })()`;
  } else {
    // CSS selector
    return `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))`;
  }
}

module.exports = { getElementSelector, getElementSelectorAll };
