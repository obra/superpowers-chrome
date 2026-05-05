import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const { createSession } = require('../skills/browsing/chrome-ws-lib.js');
const { getElementSelector } = createSession();

// Helper: create a JSDOM document with specified elements, evaluate the
// generated selector expression, and return the picked element.
function selectInDOM(html, selector) {
  const dom = new JSDOM(html);
  const { window } = dom;
  const expr = getElementSelector(selector);
  // The expression references `document`, `Array`, `console` — provide them
  const fn = new Function('document', 'Array', 'console', `return (${expr})`);
  const warnings = [];
  const mockConsole = { warn: (...args) => warnings.push(args.join(' ')) };
  const el = fn(window.document, Array, mockConsole);
  return { el, warnings };
}

// Helper: make a jsdom element report a non-zero bounding rect (jsdom defaults to all zeros)
function makeVisible(el, rect = { x: 10, y: 10, width: 200, height: 40, top: 10, left: 10, right: 210, bottom: 50 }) {
  el.getBoundingClientRect = () => rect;
}

describe('getElementSelector — CSS selectors', () => {

  it('returns the visible element when first match is hidden', () => {
    const dom = new JSDOM(`
      <div style="display:none"><textarea id="hidden"></textarea></div>
      <div><textarea id="visible"></textarea></div>
    `);
    const { document } = dom.window;
    // jsdom getBoundingClientRect returns zeros by default — override the visible one
    makeVisible(document.getElementById('visible'));

    const expr = getElementSelector('textarea');
    const fn = new Function('document', 'Array', 'console', `return (${expr})`);
    const el = fn(document, Array, { warn() {} });

    assert.equal(el.id, 'visible');
  });

  it('returns the first visible element when multiple are visible', () => {
    const dom = new JSDOM(`
      <textarea id="a"></textarea>
      <textarea id="b"></textarea>
    `);
    const { document } = dom.window;
    makeVisible(document.getElementById('a'));
    makeVisible(document.getElementById('b'));

    const expr = getElementSelector('textarea');
    const fn = new Function('document', 'Array', 'console', `return (${expr})`);
    const el = fn(document, Array, { warn() {} });

    assert.equal(el.id, 'a');
  });

  it('falls back to first match with warning when all elements are hidden', () => {
    const dom = new JSDOM(`
      <textarea id="hidden1"></textarea>
      <textarea id="hidden2"></textarea>
    `);
    const { document } = dom.window;
    // Both have zero-size rects (jsdom default)

    const expr = getElementSelector('textarea');
    const fn = new Function('document', 'Array', 'console', `return (${expr})`);
    const warnings = [];
    const el = fn(document, Array, { warn: (...args) => warnings.push(args.join(' ')) });

    assert.equal(el.id, 'hidden1');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /zero/i);
  });

  it('returns null when no elements match', () => {
    const { el } = selectInDOM('<div>no textareas here</div>', 'textarea');
    assert.equal(el, null);
  });

  it('works with complex CSS selectors', () => {
    const dom = new JSDOM(`
      <input type="text" id="hidden" />
      <input type="text" id="visible" />
    `);
    const { document } = dom.window;
    makeVisible(document.getElementById('visible'));

    const expr = getElementSelector('input[type="text"]');
    const fn = new Function('document', 'Array', 'console', `return (${expr})`);
    const el = fn(document, Array, { warn() {} });

    assert.equal(el.id, 'visible');
  });

  it('skips elements with zero width but nonzero height', () => {
    const dom = new JSDOM(`
      <textarea id="collapsed"></textarea>
      <textarea id="ok"></textarea>
    `);
    const { document } = dom.window;
    // collapsed: has height but no width (still not truly visible)
    document.getElementById('collapsed').getBoundingClientRect = () => ({
      x: 0, y: 0, width: 0, height: 40, top: 0, left: 0, right: 0, bottom: 40
    });
    makeVisible(document.getElementById('ok'));

    const expr = getElementSelector('textarea');
    const fn = new Function('document', 'Array', 'console', `return (${expr})`);
    const el = fn(document, Array, { warn() {} });

    assert.equal(el.id, 'ok');
  });
});

describe('getElementSelector — XPath selectors', () => {

  it('returns the visible element for XPath selectors', () => {
    const dom = new JSDOM(`
      <div style="display:none"><button id="hidden">Click</button></div>
      <div><button id="visible">Click</button></div>
    `);
    const { document } = dom.window;
    makeVisible(document.getElementById('visible'));

    const expr = getElementSelector('//button');
    const fn = new Function('document', 'Array', 'XPathResult', 'console', `return (${expr})`);
    const el = fn(document, Array, dom.window.XPathResult, { warn() {} });

    assert.equal(el.id, 'visible');
  });

  it('falls back with warning when all XPath matches are hidden', () => {
    const dom = new JSDOM(`
      <button id="h1">A</button>
      <button id="h2">B</button>
    `);
    const { document } = dom.window;

    const expr = getElementSelector('//button');
    const fn = new Function('document', 'Array', 'XPathResult', 'console', `return (${expr})`);
    const warnings = [];
    const el = fn(document, Array, dom.window.XPathResult, { warn: (...args) => warnings.push(args.join(' ')) });

    assert.equal(el.id, 'h1');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /zero/i);
  });

  it('returns null for XPath with no matches', () => {
    const dom = new JSDOM('<div>nothing</div>');
    const { document } = dom.window;

    const expr = getElementSelector('//textarea');
    const fn = new Function('document', 'Array', 'XPathResult', 'console', `return (${expr})`);
    const el = fn(document, Array, dom.window.XPathResult, { warn() {} });

    assert.equal(el, null);
  });

  it('handles XPath text() selectors with visibility filtering', () => {
    const dom = new JSDOM(`
      <a id="hidden">Settings</a>
      <a id="visible">Settings</a>
    `);
    const { document } = dom.window;
    makeVisible(document.getElementById('visible'));

    const expr = getElementSelector("//a[text()='Settings']");
    const fn = new Function('document', 'Array', 'XPathResult', 'console', `return (${expr})`);
    const el = fn(document, Array, dom.window.XPathResult, { warn() {} });

    assert.equal(el.id, 'visible');
  });
});
