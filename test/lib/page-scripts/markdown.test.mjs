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

  // Round 3 (jc finding 1): a pattern-matched element INLINE inside an
  // emitted block leaked its secret into .md in clear, because the block
  // was rendered via el.textContent (which flattens descendant text)
  // instead of walking the subtree and redacting the matched descendant
  // in place. Reproduced by jc at c19a436c with a <p> wrapping a <code>;
  // this covers all four block types jc named, plus h3 for a fifth.
  describe('round 3: a pattern-matched element inline inside an emitted block (jc finding 1)', () => {
    const FAKE_SEED = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

    it('<p>Your setup key: <code id="totp-secret">SEED</code></p>', () => {
      const md = evalScript(`<html><body><p>Your setup key: <code id="totp-secret">${FAKE_SEED}</code></p></body></html>`);
      assert.doesNotMatch(md, new RegExp(FAKE_SEED), `seed leaked via <p>: ${md}`);
    });

    it('<li>Setup key: <span id="totp-secret">SEED</span></li>', () => {
      const md = evalScript(`<html><body><ul><li>Setup key: <span id="totp-secret">${FAKE_SEED}</span></li></ul></body></html>`);
      assert.doesNotMatch(md, new RegExp(FAKE_SEED), `seed leaked via <li>: ${md}`);
    });

    it('<table><tr><td>Setup key: <code id="totp-secret">SEED</code></td></tr></table>', () => {
      const md = evalScript(`<html><body><table><tr><td>Setup key: <code id="totp-secret">${FAKE_SEED}</code></td></tr></table></body></html>`);
      assert.doesNotMatch(md, new RegExp(FAKE_SEED), `seed leaked via <td>: ${md}`);
    });

    it('<pre>Setup key: <span id="totp-secret">SEED</span></pre>', () => {
      const md = evalScript(`<html><body><pre>Setup key: <span id="totp-secret">${FAKE_SEED}</span></pre></body></html>`);
      assert.doesNotMatch(md, new RegExp(FAKE_SEED), `seed leaked via <pre>: ${md}`);
    });

    it('<h3>Setup key: <code id="totp-secret">SEED</code></h3>', () => {
      const md = evalScript(`<html><body><h3>Setup key: <code id="totp-secret">${FAKE_SEED}</code></h3></body></html>`);
      assert.doesNotMatch(md, new RegExp(FAKE_SEED), `seed leaked via <h3>: ${md}`);
    });

    it('<blockquote>Setup key: <code id="totp-secret">SEED</code></blockquote>', () => {
      const md = evalScript(`<html><body><blockquote>Setup key: <code id="totp-secret">${FAKE_SEED}</code></blockquote></body></html>`);
      assert.doesNotMatch(md, new RegExp(FAKE_SEED), `seed leaked via <blockquote>: ${md}`);
    });
  });

  // Round 3 (jc finding 4): container blanking must be limited to STRONG
  // (exact-compound) matches, or a small enough subtree -- a WEAK/broad
  // match (bare "token"/"secret") on a big, ordinary container must not
  // wipe the page. These are jc's own two examples.
  describe('round 3: weak/broad container matches do not wipe ordinary page content (jc finding 4)', () => {
    it('a design-system wrapper class ("sn-token-provider") does not blank its ordinary content', () => {
      const md = evalScript(
        '<html><body><div class="Shell sn-token-provider">' +
        '<h2>Get started</h2><p>Normal docs text here</p>' +
        '</div></body></html>'
      );
      assert.match(md, /Get started/, `heading wrongly redacted: ${md}`);
      assert.match(md, /Normal docs text here/, `paragraph wrongly redacted: ${md}`);
    });

    it('a docs section id ("module-secrets") does not blank its ordinary content', () => {
      const md = evalScript(
        '<html><body><section id="module-secrets">' +
        '<h2>Module: secrets</h2><p>This module manages credentials.</p>' +
        '</section></body></html>'
      );
      assert.match(md, /Module: secrets/, `heading wrongly redacted: ${md}`);
      assert.match(md, /This module manages credentials\./, `paragraph wrongly redacted: ${md}`);
    });

    it('a weak/broad container still redacts a descendant that independently matches', () => {
      // The container itself (sn-token-provider) is weak and must not be
      // wiped wholesale, but a nested element with its OWN strong/compound
      // match is still found and redacted on its own merits.
      const FAKE_SEED2 = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
      const md = evalScript(
        '<html><body><div class="sn-token-provider">' +
        '<h2>Get started</h2>' +
        `<code id="totp-secret">${FAKE_SEED2}</code>` +
        '</div></body></html>'
      );
      assert.match(md, /Get started/, `heading wrongly redacted: ${md}`);
      assert.doesNotMatch(md, new RegExp(FAKE_SEED2), `seed leaked: ${md}`);
    });
  });

  // Round 4 (jc finding 5): an otpauth:// URI is redacted unconditionally,
  // wherever it appears in the final markdown -- including inside a
  // rendered [text](href) link, where it was "partly pre-existing"
  // leakage per jc: href was never scrubbed by any prior mechanism.
  describe('otpauth:// URIs are redacted unconditionally in markdown too', () => {
    const OTP_URI = 'otpauth://totp/Example:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example';

    it('in an <a href> rendered as a markdown link', () => {
      const md = evalScript(`<html><body><a href="${OTP_URI}">Add to authenticator</a></body></html>`);
      assert.doesNotMatch(md, /otpauth:\/\//i, `otpauth URI leaked: ${md}`);
      assert.match(md, /Add to authenticator/, "the link's own label must still survive");
    });

    it('in plain visible text', () => {
      const md = evalScript(`<html><body><p>Provisioning URI: ${OTP_URI}</p></body></html>`);
      assert.doesNotMatch(md, /otpauth:\/\//i, `otpauth URI leaked: ${md}`);
    });

    it("in a QR image's alt text", () => {
      const dom = new JSDOM(`<img src="qr.png" alt="${OTP_URI}">`, { runScripts: 'dangerously' });
      const proto = dom.window.HTMLImageElement.prototype;
      proto.getBoundingClientRect = function () { return { width: 200, height: 200 }; };
      const md = dom.window.eval(markdownScript);
      assert.doesNotMatch(md, /otpauth:\/\//i, `otpauth URI leaked: ${md}`);
    });
  });

  // Round 4 (jc finding 1): jc's own four examples, reproduced verbatim,
  // for the .md artifact (see html-with-scrub.test.mjs for the IDENTICAL
  // fixtures run through the .html artifact -- same decision, both ways).
  describe('shared leaf-or-strong-container gate: identical decisions as html-with-scrub.js (jc finding 1)', () => {
    it('a weak-matched <li> WITH children is kept, not wholesale-blanked', () => {
      const md = evalScript('<html><body><ul><li class="mfa-tip"><strong>Tip:</strong> Turn on MFA</li></ul></body></html>');
      assert.match(md, /Turn on MFA/, `kept text wrongly redacted: ${md}`);
    });

    it('an MkDocs-style weak-matched <h2> WITH children (a headerlink <a>) is kept', () => {
      const md = evalScript('<html><body><h2 id="managing-secrets">Managing secrets<a class="headerlink">#</a></h2></body></html>');
      assert.match(md, /Managing secrets/, `kept heading text wrongly redacted: ${md}`);
    });

    it('<p class="otp-secret">Key: <strong>SEED</strong></p> is now blanked (otp-secret added to STRONG_COMPOUND_PAIRS)', () => {
      const md = evalScript('<html><body><p class="otp-secret">Key: <strong>JBSWY3DPEHPK3PXP</strong></p></body></html>');
      assert.doesNotMatch(md, /JBSWY3DPEHPK3PXP/, `seed leaked: ${md}`);
    });

    it('<div id="mfa-secret"><span>SEED</span></div> is now blanked (mfa-secret added to STRONG_COMPOUND_PAIRS)', () => {
      const md = evalScript('<html><body><div id="mfa-secret"><span>SEED12345</span></div></body></html>');
      assert.doesNotMatch(md, /SEED12345/, `seed leaked: ${md}`);
    });
  });

  // Round 4 (jc finding 2): a real Prism.js snippet and a
  // prism-react-renderer (Docusaurus) snippet must keep their code in
  // clear; a genuine secret still redacts even inside a <pre>/<code>.
  describe('Prism / prism-react-renderer code samples are not wiped (jc finding 2)', () => {
    it('a real Prism-highlighted JS snippet survives in clear', () => {
      const md = evalScript(
        '<html><body><pre class="language-javascript"><code class="language-javascript">' +
        '<span class="token keyword">const</span> x <span class="token operator">=</span> ' +
        '<span class="token function">fetch</span><span class="token punctuation">(</span>' +
        '<span class="token string">\'/api\'</span><span class="token punctuation">)</span>' +
        '<span class="token punctuation">;</span>' +
        '</code></pre></body></html>'
      );
      assert.match(md, /const/, `Prism code wrongly redacted: ${md}`);
      assert.match(md, /fetch/, `Prism code wrongly redacted: ${md}`);
      assert.doesNotMatch(md, /\[REDACTED\]/, `Prism code wrongly redacted: ${md}`);
    });

    it('a prism-react-renderer (Docusaurus) snippet, using token-line wrappers, survives in clear', () => {
      const md = evalScript(
        '<html><body><pre class="prism-code"><code>' +
        '<div class="token-line"><span class="token keyword">const</span> <span class="token plain">x</span></div>' +
        '<div class="token-line"><span class="token plain">fetch</span><span class="token punctuation">();</span></div>' +
        '</code></pre></body></html>'
      );
      assert.match(md, /const/, `prism-react-renderer code wrongly redacted: ${md}`);
      assert.doesNotMatch(md, /\[REDACTED\]/, `prism-react-renderer code wrongly redacted: ${md}`);
    });

    it('a secret in <code class="token-value"> still redacts -- only the exact token-line wrapper is exempt', () => {
      const md = evalScript('<html><body><code class="token-value">a1b2c3d4e5f6SEKRIT</code></body></html>');
      assert.doesNotMatch(md, /a1b2c3d4e5f6SEKRIT/, `secret leaked: ${md}`);
    });

    it('a secret in <code class="token-secret"> still redacts -- only the exact token-line wrapper is exempt', () => {
      const md = evalScript('<html><body><code class="token-secret">a1b2c3d4e5f6SEKRIT</code></body></html>');
      assert.doesNotMatch(md, /a1b2c3d4e5f6SEKRIT/, `secret leaked: ${md}`);
    });

    it('a secret in <pre class="token-display"> still redacts -- only the exact token-line wrapper is exempt', () => {
      const md = evalScript('<html><body><pre class="token-display">a1b2c3d4e5f6SEKRIT</pre></body></html>');
      assert.doesNotMatch(md, /a1b2c3d4e5f6SEKRIT/, `secret leaked: ${md}`);
    });

    it('a genuine secret still redacts even inside a <pre>/<code> block (positive control)', () => {
      const md = evalScript('<html><body><pre><code class="api-token">ghp_abcdefghijklmnop</code></pre></body></html>');
      assert.doesNotMatch(md, /ghp_abcdefghijklmnop/, `genuine secret leaked: ${md}`);
    });
  });

  // Round 4 (jc minor #3): a strong-named container OVER the cap used to
  // leak its own unnamed children entirely.
  describe('a strong container OVER the size cap still blanks its short code-like children (jc minor #3)', () => {
    it('a recovery-codes list with ~2200 chars of guidance text: prose kept, codes blanked', () => {
      const guidance = 'Store these recovery codes somewhere safe. '.repeat(50); // ~2250 chars
      const md = evalScript(
        '<html><body><div class="recovery-codes">' +
        `<p>${guidance}</p>` +
        '<ul><li>abcde-12345</li><li>fghij-67890</li></ul>' +
        '</div></body></html>'
      );
      assert.doesNotMatch(md, /abcde-12345/, `recovery code leaked: ${md}`);
      assert.doesNotMatch(md, /fghij-67890/, `recovery code leaked: ${md}`);
      assert.match(md, /Store these recovery codes/, `guidance prose wrongly wiped: ${md}`);
    });
  });
});
