import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const markdownScript = require('../../../skills/browsing/lib/page-scripts/markdown.js');

describe('page-scripts/markdown', () => {
  function evalScript(html) {
    // runScripts: 'dangerously' is required for window.eval to have access to
    // document and DOM globals — the standard jsdom approach for page-side scripts.
    const dom = new JSDOM(html, { runScripts: 'dangerously' });
    return dom.window.eval(markdownScript);
  }

  it('emits the title as H1', () => {
    const md = evalScript('<html><head><title>My Page</title></head><body><p>Hi</p></body></html>');
    assert.match(md, /^# My Page/);
  });

  it('renders headings, paragraphs, and lists', () => {
    const md = evalScript(`
      <html><body>
        <h2>About</h2>
        <p>Some text.</p>
        <ul><li>One</li><li>Two</li></ul>
      </body></html>
    `);
    assert.match(md, /## About/);
    assert.match(md, /Some text\./);
    assert.match(md, /- One/);
    assert.match(md, /- Two/);
  });

  it('inlines image references with size when image is significant', () => {
    // jsdom does NOT lay out images so getBoundingClientRect returns zero.
    // Stub it to give the image a real size.
    const dom = new JSDOM('<img src="x.png" alt="Logo">', { runScripts: 'dangerously' });
    // Patch all images globally for the test.
    const proto = dom.window.HTMLImageElement.prototype;
    proto.getBoundingClientRect = function () { return { width: 200, height: 100 }; };
    const md = dom.window.eval(markdownScript);
    assert.match(md, /!\[Image: "Logo" - 200x100\]\(.*x\.png\)/);
  });

  it('caps output at 50000 chars', () => {
    const giantHtml = '<html><body>' + '<p>x</p>'.repeat(100000) + '</body></html>';
    const md = evalScript(giantHtml);
    assert.ok(md.length <= 50000);
  });
});
