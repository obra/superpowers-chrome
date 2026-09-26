// set_attr: name allowlist (data-sen-nonce, and, as of PRI-3256,
// data-sen-secret) and the page-side refusal logic. Real-DOM (jsdom) for
// the page-side function, the same pattern as test/lib/select-option.test.mjs.
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const {
  attachSetAttribute,
  isAllowedAttributeName,
  ALLOWED_ATTRIBUTE_NAME,
  ALLOWED_ATTRIBUTE_NAMES,
  NONCE_ATTRIBUTE_NAME,
  MARKER_ATTR,
} = require('../../skills/browsing/lib/set-attribute.js');

describe('isAllowedAttributeName', () => {
  it('allows data-sen-nonce', () => {
    assert.equal(isAllowedAttributeName('data-sen-nonce'), true);
  });

  // PRI-3256: set_attr is now also the write path for marking a secret
  // element, since #52's guard never engages unless something writes
  // data-sen-secret in the first place.
  it('allows data-sen-secret', () => {
    assert.equal(isAllowedAttributeName('data-sen-secret'), true);
  });

  it('rejects anything else, including other data-*/aria-* names', () => {
    for (const name of ['value', 'src', 'href', 'style', 'onclick', 'data-action', 'aria-controls', 'data-sen-nonceX']) {
      assert.equal(isAllowedAttributeName(name), false, name);
    }
  });

  it('back-compat: ALLOWED_ATTRIBUTE_NAME is still the nonce name specifically', () => {
    assert.equal(ALLOWED_ATTRIBUTE_NAME, 'data-sen-nonce');
    assert.equal(ALLOWED_ATTRIBUTE_NAME, NONCE_ATTRIBUTE_NAME);
  });

  it('ALLOWED_ATTRIBUTE_NAMES contains exactly the two names', () => {
    assert.deepEqual([...ALLOWED_ATTRIBUTE_NAMES].sort(), ['data-sen-nonce', 'data-sen-secret'].sort());
    assert.equal(MARKER_ATTR, 'data-sen-secret');
  });
});

// Real-DOM setup for setAttribute() itself: routes Runtime.evaluate /
// Runtime.callFunctionOn against a live jsdom document instead of a
// stubbed reply, so the page-side FUNCTION_DECLARATION's actual logic
// (including the new "don't refuse a (re-)marking write" branch) runs.
function setupJsdom(html) {
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  const { window } = dom;
  const ps = {
    sessionId: 'S1',
    send: async (method, params) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: undefined, objectId: 'doc-obj' } };
      }
      if (method === 'Runtime.callFunctionOn') {
        // eslint-disable-next-line no-new-func
        const fn = window.eval(`(${params.functionDeclaration})`);
        const args = params.arguments.map((a) => a.value);
        const value = fn.apply(window.document, args);
        return { result: { value } };
      }
      return {};
    },
  };
  const getPageSession = async () => ps;
  return { ...attachSetAttribute({ getPageSession }), window };
}

describe('setAttribute (real DOM)', () => {
  it('writes data-sen-nonce onto an unmarked element', async () => {
    const { setAttribute, window } = setupJsdom('<input id="box0">');
    await setAttribute(0, '#box0', 'data-sen-nonce', 'opaque-nonce');
    assert.equal(window.document.getElementById('box0').getAttribute('data-sen-nonce'), 'opaque-nonce');
  });

  it('refuses to write data-sen-nonce onto an element already marked data-sen-secret', async () => {
    const { setAttribute } = setupJsdom('<input id="secret" data-sen-secret>');
    await assert.rejects(
      () => setAttribute(0, '#secret', 'data-sen-nonce', 'x'),
      /set_attr refused.*marked/
    );
  });

  // PRI-3256: marking is the whole point of allowing this name, so writing
  // data-sen-secret must work even on an element that is ALREADY marked
  // (idempotent re-marking is not a bypass -- it's a no-op) and must not
  // require the caller to check first.
  it('marks an unmarked element with data-sen-secret', async () => {
    const { setAttribute, window } = setupJsdom('<code id="seed">JBSWY3DP</code>');
    await setAttribute(0, '#seed', 'data-sen-secret', '');
    assert.equal(window.document.getElementById('seed').hasAttribute('data-sen-secret'), true);
  });

  it('re-marking an already-marked element with data-sen-secret is a no-op, not a refusal', async () => {
    const { setAttribute, window } = setupJsdom('<code id="seed" data-sen-secret>JBSWY3DP</code>');
    await setAttribute(0, '#seed', 'data-sen-secret', '');
    assert.equal(window.document.getElementById('seed').hasAttribute('data-sen-secret'), true);
  });

  it('marking never removes or replaces any other attribute on the element', async () => {
    const { setAttribute, window } = setupJsdom('<code id="seed" title="keep-me">JBSWY3DP</code>');
    await setAttribute(0, '#seed', 'data-sen-secret', '');
    const el = window.document.getElementById('seed');
    assert.equal(el.getAttribute('title'), 'keep-me');
    assert.equal(el.hasAttribute('data-sen-secret'), true);
  });

  it('refuses when no element matches the selector, for either allowed name', async () => {
    const { setAttribute } = setupJsdom('<div></div>');
    await assert.rejects(() => setAttribute(0, '#missing', 'data-sen-secret', ''), /no element matched/);
    await assert.rejects(() => setAttribute(0, '#missing', 'data-sen-nonce', 'x'), /no element matched/);
  });

  it('rejects a disallowed attribute name before ever touching the page', async () => {
    const { setAttribute } = setupJsdom('<input id="box0">');
    await assert.rejects(() => setAttribute(0, '#box0', 'value', 'evil'), /not allowed/);
  });
});
