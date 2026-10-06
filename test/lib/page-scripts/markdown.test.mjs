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

  it('returns the full markdown uncapped, so capture.js can redact before it truncates', () => {
    const giantHtml = '<html><body>' + '<p>x</p>'.repeat(100000) + '</body></html>';
    const md = evalScript(giantHtml);
    assert.ok(md.length > 50000);
  });

  // Default secret-pattern redaction: this generator walks the live DOM
  // independently of html-with-scrub.js's clone/scrub, so it needs its
  // own pass of the same word-boundary check (secret-pattern.js) -- see
  // that module and this file's own module comment for why.
  describe('default secret-pattern redaction', () => {
    const FAKE_SEED = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

    it('redacts a matched leaf element\'s text (a <code> holding a seed)', () => {
      const md = evalScript(`<html><body><code id="totp-secret">${FAKE_SEED}</code></body></html>`);
      assert.doesNotMatch(md, new RegExp(FAKE_SEED));
      assert.match(md, /\[REDACTED\]/);
    });

    it('redacts descendant leaves inside a matched wrapping container (jc finding 2, applied to markdown)', () => {
      const md = evalScript(
        '<html><body><div id="totp-secret">' +
        '<p>Key:</p>' +
        `<code>${FAKE_SEED}</code>` +
        '</div></body></html>'
      );
      assert.doesNotMatch(md, new RegExp(FAKE_SEED), 'the seed must not leak into markdown just because it sits in a <code> descendant');
    });

    it('redacts a recovery-codes <ul><li> list in markdown too', () => {
      const md = evalScript(
        '<html><body><ul class="recovery-codes">' +
        '<li>11112222</li><li>33334444</li>' +
        '</ul></body></html>'
      );
      assert.doesNotMatch(md, /11112222/);
      assert.doesNotMatch(md, /33334444/);
    });

    it('redacts a leaf whose text is padded with leading/trailing whitespace (jc finding 6: untrimmed leaf vs already-trimmed .md text)', () => {
      // The pre-fix mechanism collected the leaf's RAW (untrimmed)
      // textContent into secretValues for capture.js to substring-match
      // against the .md text -- but this generator already trims
      // (textContent.trim(), used throughout), so a whitespace-padded
      // leaf's untrimmed secretValues entry could never match the
      // trimmed .md text and the seed leaked into the markdown file in
      // clear. This generator now matches directly, trimmed, with no
      // separate secretValues channel to go stale against.
      const md = evalScript(`<html><body><code id="totp-secret">\n   ${FAKE_SEED}\n  </code></body></html>`);
      assert.doesNotMatch(md, new RegExp(FAKE_SEED));
    });

    it('does not blank a link\'s own label even when it or an ancestor matches (control, not the secret)', () => {
      const md = evalScript(
        '<html><body><div id="totp-setup"><a id="reveal-totp-link" href="/reveal">Show code</a></div></body></html>'
      );
      assert.match(md, /\[Show code\]\(.*\/reveal\)/);
    });

    it('does not redact ordinary unrelated text (word-boundary negative control: "footprint")', () => {
      const md = evalScript('<html><body><p class="footprint">carbon footprint</p></body></html>');
      assert.match(md, /carbon footprint/);
    });
  });
});
