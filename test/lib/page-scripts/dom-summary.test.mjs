import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const domSummaryScript = require('../../../skills/browsing/lib/page-scripts/dom-summary.js');

describe('page-scripts/dom-summary', () => {
  function evalScript(html) {
    // runScripts: 'dangerously' is required for window.eval to have access to
    // document and DOM globals — the standard jsdom approach for page-side scripts.
    const dom = new JSDOM(html, { runScripts: 'dangerously' });
    return dom.window.eval(domSummaryScript);
  }

  it('counts buttons, inputs, and links', () => {
    const summary = evalScript(`
      <html><body>
        <button>One</button>
        <button>Two</button>
        <input type="text">
        <textarea></textarea>
        <a href="/x">Link</a>
      </body></html>
    `);
    assert.match(summary, /Interactive: 2 buttons, 2 inputs, 1 links/);
  });

  it('reports H1s in the headings line', () => {
    const summary = evalScript('<html><body><h1>Welcome</h1><h1>To Site</h1></body></html>');
    assert.match(summary, /Headings: "Welcome", "To Site"/);
  });

  it('caps headings at 3 with "and N more"', () => {
    const html = '<html><body>' + Array.from({ length: 5 }, (_, i) => `<h1>H${i}</h1>`).join('') + '</body></html>';
    const summary = evalScript(html);
    assert.match(summary, /and 2 more/);
  });

  it('reports nav and main landmarks in layout line', () => {
    const summary = evalScript('<html><body><nav>...</nav><main>...</main></body></html>');
    assert.match(summary, /Layout: nav \+ main/);
  });

  it('reports forms count', () => {
    const summary = evalScript('<html><body><form></form><form></form></body></html>');
    assert.match(summary, /\+ 2 forms/);
  });
});
