const { getElementSelectorAll } = require('./element-selector');
const { throwIfExceptionDetails } = require('./cdp-utils');

/**
 * Native HTML `<select>` element control.
 *
 * Each requested value matches an `<option>` by its `value` attribute
 * first, then by trimmed visible label. Arrays of values require a
 * `<select multiple>` — passing more than one to a single-select is an
 * error. Selection replaces (every existing `selected` is cleared
 * before applying the new set), matching Playwright's `selectOption`
 * semantics.
 *
 * Multi-element warning (JRV-129): if the selector matches more than
 * one element on the page, we use the element at `index` (default 0)
 * and emit a warning so the caller knows the selector is ambiguous.
 *
 * `attachSelectOption({ getPageSession })` returns the bound action.
 */
// Page-side function body. Only the selector is spliced into the source
// text (via getElementSelectorAll's JSON.stringify, the same pattern used
// throughout lib/*.js) - caller-supplied `requested` values and `idx` are
// NEVER concatenated into the expression string. They travel as
// Runtime.callFunctionOn `arguments` (CallArgument values) and are bound
// to real function parameters, so untrusted content can't break out of
// the generated source the way raw template interpolation could.
function buildFunctionDeclaration(selector) {
  const allExpr = getElementSelectorAll(selector);
  return `function (requested, idx) {
    const elements = ${allExpr};
    const el = elements[idx];
    if (!el) return { success: false, error: 'Element not found at index ' + idx };
    if (el.tagName !== 'SELECT') return { success: false, error: 'Element is not a SELECT' };
    if (requested.length > 1 && !el.multiple) {
      return { success: false, error: 'Cannot select multiple values on a non-multiple <select>' };
    }
    const options = Array.from(el.options);
    const matched = [];
    const unmatched = [];
    for (const v of requested) {
      const opt = options.find(o => o.value === v) ||
                  options.find(o => o.textContent.trim() === v);
      if (opt) matched.push(opt);
      else unmatched.push(v);
    }
    if (unmatched.length) {
      return { success: false, error: 'No matching option for: ' + JSON.stringify(unmatched) };
    }
    for (const o of options) o.selected = false;
    for (const o of matched) o.selected = true;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      success: true,
      matchCount: elements.length,
      matched: matched.map(o => ({ value: o.value, text: o.textContent.trim() }))
    };
  }`;
}

function attachSelectOption({ getPageSession }) {
  async function selectOption(tabIndexOrWsUrl, selector, value, index = 0) {
    const pageSession = await getPageSession(tabIndexOrWsUrl);
    if (!Number.isInteger(index) || index < 0) {
      throw new TypeError('index must be a non-negative integer');
    }
    const values = Array.isArray(value) ? value : [value];

    const countJs = `${getElementSelectorAll(selector)}.length`;
    const countResult = await pageSession.send('Runtime.evaluate', {
      expression: countJs,
      returnByValue: true
    });
    throwIfExceptionDetails(countResult);
    const matchCount = countResult.result.value || 0;

    let warning = null;
    if (matchCount > 1) {
      warning = `Selector "${selector}" matches ${matchCount} elements. Using element at index ${index}. Use a more specific selector or pass index parameter.`;
      console.error(`WARNING: ${warning}`);
    }

    const docResult = await pageSession.send('Runtime.evaluate', {
      expression: 'document',
      returnByValue: false
    });
    throwIfExceptionDetails(docResult);

    const result = await pageSession.send('Runtime.callFunctionOn', {
      objectId: docResult.result.objectId,
      functionDeclaration: buildFunctionDeclaration(selector),
      arguments: [{ value: values }, { value: index }],
      returnByValue: true
    });
    throwIfExceptionDetails(result);

    const resultValue = result.result.value;
    if (!resultValue.success) {
      throw new Error(resultValue.error);
    }

    return {
      success: true,
      matchCount: resultValue.matchCount,
      matched: resultValue.matched,
      warning,
      selectedIndex: index
    };
  }

  return { selectOption };
}

module.exports = { attachSelectOption };
