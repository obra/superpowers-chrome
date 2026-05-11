const { getElementSelector } = require('./element-selector');
const { throwIfExceptionDetails } = require('./cdp-utils');

/**
 * Single-element extraction primitives — text content, HTML, attributes.
 *
 * Each is a thin wrapper around `Runtime.evaluate` that uses optional
 * chaining to return `null`/`undefined` when the selector misses, so the
 * caller doesn't have to distinguish "element not found" from "element
 * found but empty." The page-content / DOM-summary / markdown extractors
 * (the heavyweight ones used by auto-capture) live in `lib/capture.js`.
 *
 * Helpers accept `tabIndexOrPageSession` and route through
 * `pageSession.send`.
 */
function attachExtraction({ getPageSession }) {
  async function extractText(tabIndexOrPageSession, selector) {
    const ps = await getPageSession(tabIndexOrPageSession);
    const js = `${getElementSelector(selector)}?.textContent`;
    const result = await ps.send('Runtime.evaluate', {
      expression: js,
      returnByValue: true,
    });
    throwIfExceptionDetails(result);
    return result.result.value;
  }

  async function getHtml(tabIndexOrPageSession, selector = null) {
    const ps = await getPageSession(tabIndexOrPageSession);
    const js = selector
      ? `${getElementSelector(selector)}?.innerHTML`
      : 'document.documentElement.outerHTML';
    const result = await ps.send('Runtime.evaluate', {
      expression: js,
      returnByValue: true,
    });
    throwIfExceptionDetails(result);
    return result.result.value;
  }

  async function getAttribute(tabIndexOrPageSession, selector, attrName) {
    const ps = await getPageSession(tabIndexOrPageSession);
    const js = `${getElementSelector(selector)}?.getAttribute(${JSON.stringify(attrName)})`;
    const result = await ps.send('Runtime.evaluate', {
      expression: js,
      returnByValue: true,
    });
    throwIfExceptionDetails(result);
    return result.result.value;
  }

  return { extractText, getHtml, getAttribute };
}

module.exports = { attachExtraction };
