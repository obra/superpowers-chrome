import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const htmlWithScrubScript = require('../../../skills/browsing/lib/page-scripts/html-with-scrub.js');

describe('page-scripts/html-with-scrub', () => {
  function evalScript(html) {
    // runScripts: 'dangerously' is required for window.eval to have access to
    // document and DOM globals — the standard jsdom approach for page-side scripts.
    const dom = new JSDOM(html, { runScripts: 'dangerously' });
    const value = dom.window.eval(htmlWithScrubScript);
    return { value, dom };
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
});
