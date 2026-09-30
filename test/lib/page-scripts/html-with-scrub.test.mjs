import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const htmlWithScrubScript = require('../../../skills/browsing/lib/page-scripts/html-with-scrub.js');

describe('page-scripts/html-with-scrub', () => {
  function makeDom(html) {
    // runScripts: 'dangerously' is required for window.eval to have access to
    // document and DOM globals — the standard jsdom approach for page-side scripts.
    return new JSDOM(html, { runScripts: 'dangerously' });
  }

  function runScrub(dom) {
    return dom.window.eval(htmlWithScrubScript);
  }

  function evalScript(html) {
    const dom = makeDom(html);
    return { value: runScrub(dom), dom };
  }

  it('strips the value attribute and every data-* attribute from a password input', () => {
    const { value, dom } = evalScript(
      '<html><body><input id="pw" type="password" value="s3cr3t" data-initial-value="s3cr3t"></body></html>'
    );
    assert.match(value.raw, /value="s3cr3t"/);
    assert.match(value.raw, /data-initial-value="s3cr3t"/);
    assert.doesNotMatch(value.scrubbed, /s3cr3t/);
    assert.doesNotMatch(value.scrubbed, /data-initial-value/);

    // The live document must be untouched: the clone is never attached.
    const live = dom.window.document.getElementById('pw');
    assert.equal(live.getAttribute('value'), 's3cr3t');
    assert.equal(live.getAttribute('data-initial-value'), 's3cr3t');
  });

  it('strips a one-time-code input the same way', () => {
    const { value } = evalScript(
      '<html><body><input type="text" autocomplete="one-time-code" value="123456" data-initial-value="123456"></body></html>'
    );
    assert.match(value.raw, /123456/);
    assert.doesNotMatch(value.scrubbed, /123456/);
  });

  it('strips value and data-* from any element carrying data-sen-secret, even a non-input', () => {
    const { value } = evalScript(
      '<html><body><ul data-sen-secret data-backup-codes="1234 5678"><li>1234 5678</li></ul></body></html>'
    );
    assert.match(value.raw, /data-sen-secret/);
    assert.doesNotMatch(value.scrubbed, /data-sen-secret/);
    assert.doesNotMatch(value.scrubbed, /data-backup-codes/);
    // Only the attributes are scrubbed, not descendant text — callers rely
    // on the credential-shape scan (which runs on `raw`) to catch a marked
    // element's visible text; see capture.js's mustSuppress.
    assert.match(value.scrubbed, /1234 5678/);
  });

  it('leaves an ordinary text input untouched', () => {
    const { value } = evalScript('<html><body><input type="text" value="alice"></body></html>');
    assert.match(value.scrubbed, /value="alice"/);
    assert.equal(value.raw, value.scrubbed);
  });

  it('leaves the rest of the page identical between raw and scrubbed', () => {
    const { value } = evalScript(
      '<html><body><h1>Sign in</h1><input type="password" value="x"><p>footer</p></body></html>'
    );
    assert.match(value.scrubbed, /<h1>Sign in<\/h1>/);
    assert.match(value.scrubbed, /<p>footer<\/p>/);
  });

  // -- Round 2 (jc review) --------------------------------------------

  it('builds the scrubbed copy via document.implementation.createHTMLDocument, not a live cloneNode', () => {
    // Regression guard for the obra#52 pattern: cloneNode(true) in the live
    // document still runs the image-loading algorithm for a cloned <img>
    // (it's gated on "fully active", which a same-document clone still is).
    // jsdom never loads images at all, so it can't observe that directly —
    // this instead asserts the code path taken. The real-Chrome test in
    // test/credential-guard-mcp.test.mjs proves image handlers don't refire.
    const dom = makeDom('<html><body><input type="password" value="x"></body></html>');
    const { document } = dom.window;
    let called = false;
    const realCreate = document.implementation.createHTMLDocument.bind(document.implementation);
    document.implementation.createHTMLDocument = function (...args) {
      called = true;
      return realCreate(...args);
    };
    runScrub(dom);
    assert.ok(called, 'expected the scrub to build an inert document via createHTMLDocument');
  });

  it("redacts a password field's live value from a hidden mirror input that carries no special attribute of its own", () => {
    // The mirror input has no type=password, no sensitive autocomplete, and
    // no data-sen-secret marker — nothing a selector-based scrub could ever
    // match. Only redacting by the literal value catches it.
    const dom = makeDom(
      '<html><body><input id="pw" type="password"><input id="mirror" type="hidden"></body></html>'
    );
    const { document } = dom.window;
    document.getElementById('pw').value = 'Sup3r-Secret-Pw';
    document.getElementById('mirror').setAttribute('value', 'Sup3r-Secret-Pw');

    const value = runScrub(dom);
    assert.match(value.raw, /Sup3r-Secret-Pw/);
    assert.doesNotMatch(value.scrubbed, /Sup3r-Secret-Pw/);
  });

  it("keeps redacting a password field's value after a show-password toggle switches its type to text", () => {
    const dom = makeDom('<html><body><input id="pw" type="password"></body></html>');
    const { document } = dom.window;
    const pw = document.getElementById('pw');
    pw.value = 'Sup3r-Secret-Pw';

    // First scrub while still type=password: seeds window.__senWasPasswordInputs.
    runScrub(dom);

    // "Show password" toggle: flips type to text (an ordinary eye-icon
    // handler), then something mirrors the now-visible value into an
    // attribute that isn't `data-*`, so plain attribute-stripping keyed on
    // a "type=password" selector wouldn't touch this element anymore either.
    pw.type = 'text';
    pw.setAttribute('title', 'Sup3r-Secret-Pw');

    const value = runScrub(dom);
    assert.match(value.raw, /Sup3r-Secret-Pw/);
    assert.doesNotMatch(value.scrubbed, /Sup3r-Secret-Pw/);
  });

  it('matches autocomplete case-insensitively and by substring, including a multi-token value', () => {
    const dom = makeDom(
      '<html><body>' +
      '<input id="a" autocomplete="New-Password">' +
      '<input id="b" autocomplete="section-2fa one-time-code">' +
      '</body></html>'
    );
    const { document } = dom.window;
    document.getElementById('a').value = 'Sup3r-Secret-Pw';
    document.getElementById('b').value = '654321';

    const value = runScrub(dom);
    assert.doesNotMatch(value.scrubbed, /Sup3r-Secret-Pw/);
    assert.doesNotMatch(value.scrubbed, /654321/);
  });

  it('redacts a value from any cc-* autocomplete field', () => {
    const dom = makeDom('<html><body><input id="ccn" autocomplete="cc-number"></body></html>');
    dom.window.document.getElementById('ccn').value = '4242424242424242';

    const value = runScrub(dom);
    assert.doesNotMatch(value.scrubbed, /4242424242424242/);
  });

  it('does not touch an ordinary field whose value merely resembles a sensitive one', () => {
    const dom = makeDom(
      '<html><body><input id="search" type="text" autocomplete="off" value="new-password reset guide"></body></html>'
    );
    const value = runScrub(dom);
    // "new-password" here is page text inside an ordinary field's value,
    // not an autocomplete token — the field itself isn't sensitive, so
    // outerHTML's normal (unmirrored) attribute reflection is untouched.
    assert.match(value.scrubbed, /new-password reset guide/);
  });
});
