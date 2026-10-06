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

  // secretValues is an array from the jsdom window's realm, which
  // deepStrictEqual won't match against a literal from this one.
  function secretValuesOf(value) {
    return Array.from(value.secretValues);
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

  it('redacts a self-mirrored field with no recognized type or autocomplete, isolated from the default secret-pattern detection', () => {
    // Google's 2-step verification page: a plain <input> with no
    // type="password" and no autocomplete token this module recognizes,
    // but the page's own JS copies the typed code into data-initial-value
    // verbatim. None of the existing selectors (type, autocomplete, the
    // data-sen-secret marker) flag this field, so it must be found by
    // comparing the live .value against the field's own attributes.
    // Google's real field is id="totpPin", which the default
    // secret-pattern detection added below *also* independently catches
    // (it contains "otp"); see the next test for that stronger,
    // attribute-removing outcome. This test uses a pattern-safe id
    // ("verificationCode" contains none of the secret-looking words) to
    // isolate and keep testing the self-mirror-only mechanism's own,
    // weaker guarantee on its own.
    const dom = makeDom('<html><body><input id="verificationCode" data-initial-value=""></body></html>');
    const { document } = dom.window;
    const field = document.getElementById('verificationCode');
    field.value = '123456';
    field.setAttribute('data-initial-value', '123456');

    const value = runScrub(dom);
    assert.match(value.raw, /data-initial-value="123456"/);
    // This field is found only by self-mirror, not by CSS selector (no
    // type/autocomplete to match) and not by the default secret-pattern
    // detection (its id doesn't match), so there is no selector to
    // re-match in the clone and exact-remove the attribute by name the
    // way a password or one-time-code field's data-* gets removed above
    // -- the attribute name survives, but the value-substring pass
    // redacts its content.
    assert.doesNotMatch(value.scrubbed, /123456/);
    assert.match(value.scrubbed, /data-initial-value="\[REDACTED\]"/);

    // The live document must be untouched.
    assert.equal(field.getAttribute('data-initial-value'), '123456');
  });

  it("also catches Google's real totpPin id via the default secret-pattern detection, stripping the attribute by name", () => {
    // Same page as above, but with Google's actual field id. "totpPin"
    // contains "otp", so looksSecretByPattern flags it independently of
    // self-mirror detection -- and because that gives the clone a
    // selector to re-match (unlike the self-mirror-only case above), the
    // attribute is fully removed, not just value-redacted.
    const dom = makeDom('<html><body><input id="totpPin" data-initial-value=""></body></html>');
    const { document } = dom.window;
    const totpPin = document.getElementById('totpPin');
    totpPin.value = '123456';
    totpPin.setAttribute('data-initial-value', '123456');

    const value = runScrub(dom);
    assert.match(value.raw, /data-initial-value="123456"/);
    assert.doesNotMatch(value.scrubbed, /123456/);
    assert.doesNotMatch(value.scrubbed, /data-initial-value/);

    // The live document must be untouched.
    assert.equal(totpPin.getAttribute('data-initial-value'), '123456');
  });

  it('does not self-mirror-flag a field whose value merely matches an unrelated attribute elsewhere', () => {
    // The self-mirror signal only looks at a field's OWN attributes; an
    // unrelated element on the page that happens to share text is not
    // enough to flag the field.
    const dom = makeDom(
      '<html><body><input id="name" value="Ada"><div id="other" data-display-name="Ada Sen"></div></body></html>'
    );
    const { document } = dom.window;
    document.getElementById('name').value = 'Ada Sen';

    const value = runScrub(dom);
    assert.match(value.raw, /data-display-name="Ada Sen"/);
    assert.deepEqual(secretValuesOf(value), []);
    assert.equal(value.scrubbed, value.raw);
  });

  it('does not self-mirror-flag a submit button whose value matches its own type and name', () => {
    // Nobody types into a submit button; its value is a label. Treating it
    // as a secret source would string-replace "submit" across the page.
    const { value } = evalScript(
      '<html><body><form action="/submit"><input type="submit" name="submit" value="submit"></form><p>Press submit</p></body></html>'
    );
    assert.deepEqual(secretValuesOf(value), []);
    assert.equal(value.scrubbed, value.raw);
  });

  it("does not self-mirror-flag Google's search button, whose value matches its aria-label", () => {
    const { value } = evalScript(
      '<html><body><input class="gNO89b" value="Google Search" aria-label="Google Search" name="btnK" role="button" tabindex="0" type="submit"><p>Google Search</p></body></html>'
    );
    assert.deepEqual(secretValuesOf(value), []);
    assert.equal(value.scrubbed, value.raw);
  });

  it('does not self-mirror-flag a radio whose value matches its own id', () => {
    // A radio's value is fixed by the page, not typed; flagging it would
    // rewrite "female" to "fe[REDACTED]" across the capture.
    const { value } = evalScript(
      '<html><body><input type="radio" id="male" name="gender" value="male"><label for="male">male</label>' +
        '<input type="radio" id="female" name="gender" value="female"><a href="/female-only">female</a></body></html>'
    );
    assert.deepEqual(secretValuesOf(value), []);
    assert.equal(value.scrubbed, value.raw);
  });

  it('does not self-mirror-flag an input type nobody types into, even when its value matches a data-* attribute', () => {
    // The identity-attribute exclusion alone doesn't cover this: data-label
    // and data-state are ordinary mirror targets for a typed field.
    const { value } = evalScript(
      '<html><body><input type="button" value="Continue" data-label="Continue">' +
        '<input type="checkbox" value="subscribed" data-state="subscribed">' +
        '<input type="hidden" value="checkout" data-step="checkout"><p>Continue to checkout</p></body></html>'
    );
    assert.deepEqual(secretValuesOf(value), []);
    assert.equal(value.scrubbed, value.raw);
  });

  it('does not self-mirror-flag a text field whose value only matches its own label or identity attributes', () => {
    // type, name, id, aria-label, title, placeholder, for and class name or
    // label a field; a page's value-sync JS does not mirror into them, so a
    // match there is a coincidence, not a mirror.
    const dom = makeDom(
      '<html><body><input id="query" type="text" name="query" class="query" aria-label="Search" title="Search" placeholder="Search"><p>Search query</p></body></html>'
    );
    const field = dom.window.document.getElementById('query');
    field.value = 'Search';
    let value = runScrub(dom);
    assert.deepEqual(secretValuesOf(value), []);
    assert.equal(value.scrubbed, value.raw);

    field.value = 'query';
    value = runScrub(dom);
    assert.deepEqual(secretValuesOf(value), []);
    assert.equal(value.scrubbed, value.raw);
  });

  it('still self-mirror-flags a text field mirrored into a non-identity attribute', () => {
    const dom = makeDom(
      '<html><body><input id="code" type="text" name="code" data-x=""><p>Ok</p></body></html>'
    );
    const field = dom.window.document.getElementById('code');
    field.value = 'hunter22';
    field.setAttribute('data-x', 'hunter22');

    const value = runScrub(dom);
    assert.deepEqual(secretValuesOf(value), ['hunter22']);
    assert.doesNotMatch(value.scrubbed, /hunter22/);
    assert.match(value.scrubbed, /data-x="\[REDACTED\]"/);
  });

  it('strips aria-* attributes, not just data-*, from a matched sensitive field', () => {
    const { value } = evalScript(
      '<html><body><input id="pw" type="password" value="s3cr3t" aria-describedby="s3cr3t"></body></html>'
    );
    assert.match(value.raw, /aria-describedby="s3cr3t"/);
    assert.doesNotMatch(value.scrubbed, /s3cr3t/);
    assert.doesNotMatch(value.scrubbed, /aria-describedby/);
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
    // Mirror each value into an attribute (a hidden sibling, the way a
    // page's own input handler would) so the secret actually appears in
    // `raw` -- setting only the .value property leaves outerHTML
    // unchanged, which would make the assertions below pass even with
    // scrubbing disabled entirely (jc round 2, finding 4).
    const dom = makeDom(
      '<html><body>' +
      '<input id="a" autocomplete="New-Password">' +
      '<input id="a-mirror" type="hidden">' +
      '<input id="b" autocomplete="section-2fa one-time-code">' +
      '<input id="b-mirror" type="hidden">' +
      '</body></html>'
    );
    const { document } = dom.window;
    document.getElementById('a').value = 'Sup3r-Secret-Pw';
    document.getElementById('a-mirror').setAttribute('value', 'Sup3r-Secret-Pw');
    document.getElementById('b').value = '654321';
    document.getElementById('b-mirror').setAttribute('value', '654321');

    const value = runScrub(dom);
    assert.match(value.raw, /Sup3r-Secret-Pw/);
    assert.match(value.raw, /654321/);
    assert.doesNotMatch(value.scrubbed, /Sup3r-Secret-Pw/);
    assert.doesNotMatch(value.scrubbed, /654321/);
  });

  it('redacts a value from a cc-number autocomplete field', () => {
    // Mirror the value into an attribute (a hidden sibling, the way a
    // page's own input handler would) so the secret actually appears in
    // `raw` — setting only the .value property leaves outerHTML
    // unchanged, which would make this assertion pass even with
    // scrubbing disabled entirely.
    const dom = makeDom(
      '<html><body><input id="ccn" autocomplete="cc-number"><input id="mirror" type="hidden"></body></html>'
    );
    const { document } = dom.window;
    document.getElementById('ccn').value = '4242424242424242';
    document.getElementById('mirror').setAttribute('value', '4242424242424242');

    const value = runScrub(dom);
    assert.match(value.raw, /4242424242424242/);
    assert.doesNotMatch(value.scrubbed, /4242424242424242/);
  });

  it('redacts a value from a cc-csc autocomplete field', () => {
    const dom = makeDom(
      '<html><body><input id="csc" autocomplete="cc-csc"><input id="mirror" type="hidden"></body></html>'
    );
    const { document } = dom.window;
    document.getElementById('csc').value = '1234';
    document.getElementById('mirror').setAttribute('value', '1234');

    const value = runScrub(dom);
    assert.match(value.raw, /value="1234"/);
    assert.doesNotMatch(value.scrubbed, /1234/);
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

  // -- Round 3 (jc review) --------------------------------------------

  it('does not redact a cc-exp-year value: the cc-* family beyond cc-number/cc-csc is not value-sensitive', () => {
    // A blanket `[autocomplete*="cc-" i]` match would collect the 4-digit
    // expiry year (it clears the length floor) and redact every copy of
    // those digits on the page, such as a copyright year.
    const dom = makeDom(
      '<html><body><select id="exp" autocomplete="cc-exp-year">' +
      '<option value="2025">2025</option><option value="2026">2026</option></select>' +
      '<p>&copy; 2026 Example Shop</p></body></html>'
    );
    dom.window.document.getElementById('exp').value = '2026';

    const value = runScrub(dom);
    assert.match(value.scrubbed, /<option value="2026">2026<\/option>/);
    assert.match(value.scrubbed, /2026 Example Shop/);
    assert.equal(value.raw, value.scrubbed);
  });

  it("does not substring-redact a value shorter than the minimum length, to avoid mangling unrelated markup (jc round 2, finding 1)", () => {
    // Reproduces jc's checkout-page report: a short sensitive value (here
    // a 1-character password, standing in for a short cc-exp-month/
    // cc-exp-year/split-OTP-digit value) must not be split/joined across
    // the whole serialized document -- that mangles tag names, prices,
    // and styles that merely happen to contain the same short string.
    const dom = makeDom(
      '<html><body><title>Checkout 1</title><input id="pw" type="password">' +
      '<h1>Order 100</h1><p>Total: $12.00</p><div style="width:100px"></div></body></html>'
    );
    dom.window.document.getElementById('pw').value = '1';

    const value = runScrub(dom);
    assert.match(value.scrubbed, /<title>Checkout 1<\/title>/);
    assert.match(value.scrubbed, /<h1>Order 100<\/h1>/);
    assert.match(value.scrubbed, /Total: \$12\.00/);
    assert.match(value.scrubbed, /width:100px/);
  });

  it('still redacts a value at or above the minimum length', () => {
    const dom = makeDom(
      '<html><body><input id="pw" type="password"><input id="mirror" type="hidden"></body></html>'
    );
    const { document } = dom.window;
    document.getElementById('pw').value = 'abcd';
    document.getElementById('mirror').setAttribute('value', 'abcd');

    const value = runScrub(dom);
    assert.match(value.raw, /value="abcd"/);
    assert.doesNotMatch(value.scrubbed, /abcd/);
  });

  it("redacts a password mirrored into an attribute even when & and \" force it into an HTML-entity-escaped form (jc round 2, finding 2)", () => {
    // outerHTML escapes & and " in an attribute value (&amp;/&quot;), so
    // the literal .value the user typed never appears verbatim in the
    // serialized attribute -- only its entity-escaped form does.
    const dom = makeDom(
      '<html><body><input id="pw" type="password"><input id="mirror" type="hidden"></body></html>'
    );
    const { document } = dom.window;
    const secret = 'Sup3r&Secret"Pw';
    document.getElementById('pw').value = secret;
    document.getElementById('mirror').setAttribute('value', secret);

    const value = runScrub(dom);
    // Sanity check on the test fixture itself: confirms the raw HTML
    // really does contain the escaped form, not the literal secret.
    assert.match(value.raw, /Sup3r&amp;Secret&quot;Pw/);
    assert.doesNotMatch(value.scrubbed, /Sup3r/);
    assert.doesNotMatch(value.scrubbed, /Secret/);
  });

  it('redacts a password mirrored into text content, where " stays literal but &, < and > are entity-escaped', () => {
    // outerHTML escapes &, < and > in text-node content but leaves " as is,
    // so neither the literal secret nor its attribute-escaped form appears.
    const dom = makeDom(
      '<html><body><input id="pw" type="password"><span id="mirror"></span></body></html>'
    );
    const { document } = dom.window;
    const secret = 'Sup3r<Secret>"Pw&';
    document.getElementById('pw').value = secret;
    document.getElementById('mirror').textContent = secret;

    const value = runScrub(dom);
    assert.match(value.raw, /Sup3r&lt;Secret&gt;"Pw&amp;/);
    assert.doesNotMatch(value.scrubbed, /Sup3r/);
    assert.doesNotMatch(value.scrubbed, /Secret/);
  });

  it('redacts a password containing a non-breaking space, which outerHTML serializes as &nbsp;', () => {
    const dom = makeDom(
      '<html><body><input id="pw" type="password"><input id="mirror" type="hidden"><span id="echo"></span></body></html>'
    );
    const { document } = dom.window;
    const secret = 'Horse\u00a0Battery9';
    document.getElementById('pw').value = secret;
    document.getElementById('mirror').setAttribute('value', secret);
    document.getElementById('echo').textContent = secret;

    const value = runScrub(dom);
    assert.match(value.raw, /value="Horse&nbsp;Battery9"/);
    assert.match(value.raw, /<span id="echo">Horse&nbsp;Battery9<\/span>/);
    assert.doesNotMatch(value.scrubbed, /Battery9/);
  });

  it('redacts a 3-digit card security code, below the general length floor', () => {
    // Visa/Mastercard/Discover CSCs are three digits; cc-csc gets its own
    // floor of 3 so its mirror is still redacted.
    const dom = makeDom(
      '<html><body><input id="csc" autocomplete="cc-csc"><input id="mirror" type="hidden"></body></html>'
    );
    const { document } = dom.window;
    document.getElementById('csc').value = '737';
    document.getElementById('mirror').setAttribute('value', 'cvv:737');

    const value = runScrub(dom);
    assert.match(value.raw, /value="cvv:737"/);
    assert.doesNotMatch(value.scrubbed, /737/);
  });
});

// Default secret-pattern detection: redact on first sight, no
// data-sen-secret marking and no click required -- the real gap this
// closes is a page that puts a secret in the DOM at load time (Slack's
// hidden #init_key_code on its 2FA setup page), before an agent could
// ever have marked anything.
describe('page-scripts/html-with-scrub: default secret-pattern detection', () => {
  function makeDom(html) {
    return new JSDOM(html, { runScripts: 'dangerously' });
  }
  function runScrub(dom) {
    return dom.window.eval(htmlWithScrubScript);
  }
  function evalScript(html) {
    const dom = makeDom(html);
    return { value: runScrub(dom), dom };
  }

  const FAKE_SEED = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

  it("redacts Slack's real case: a hidden input carrying the seed as its value attribute", () => {
    const { value } = evalScript(
      `<html><body><input type="hidden" id="init_key_code" value="${FAKE_SEED}"></body></html>`
    );
    assert.match(value.raw, new RegExp(FAKE_SEED));
    assert.doesNotMatch(value.scrubbed, new RegExp(FAKE_SEED));
    assert.doesNotMatch(value.scrubbed, /init_key_code.*value=/);
  });

  it("redacts the same seed held as a hidden leaf element's text content, not an input value", () => {
    const dom = makeDom(
      `<html><body><span id="init_key_code" style="display:none">${FAKE_SEED}</span></body></html>`
    );
    const value = runScrub(dom);
    assert.match(value.raw, new RegExp(FAKE_SEED));
    assert.doesNotMatch(value.scrubbed, new RegExp(FAKE_SEED));
    assert.match(value.scrubbed, /<span id="init_key_code"[^>]*>\[REDACTED\]<\/span>/);
  });

  it('redacts a seed mirrored elsewhere on the page too, via the collected secretValues substring pass', () => {
    const dom = makeDom(
      `<html><body><input type="hidden" id="init_key_code" value="${FAKE_SEED}">` +
      `<div id="debugPanel" data-last-seed="${FAKE_SEED}"></div></body></html>`
    );
    const value = runScrub(dom);
    assert.doesNotMatch(value.scrubbed, new RegExp(FAKE_SEED));
    assert.ok(value.secretValues.includes(FAKE_SEED));
  });

  for (const [label, id] of [
    ['secret', 'mySecretValue'], ['totp', 'totpSeed'], ['otp', 'otpCode'],
    ['2fa', 'setup2faKey'], ['mfa', 'mfaSetupCode'], ['key_code', 'init_key_code'],
    ['seed', 'walletSeed'], ['recovery', 'recoveryPhrase'], ['backup_code', 'backup_code_1'],
    ['api_key', 'apiKeyValue'], ['token', 'authToken'],
  ]) {
    it(`matches the "${label}" pattern via element id`, () => {
      const dom = makeDom(`<html><body><span id="${id}">${FAKE_SEED}</span></body></html>`);
      const value = runScrub(dom);
      assert.doesNotMatch(value.scrubbed, new RegExp(FAKE_SEED), `id="${id}" should have matched`);
    });
  }

  it('matches via autocomplete="one-time-code" on a plain, otherwise-unflagged element id/name', () => {
    // Already covered for value-bearing fields by the existing
    // AUTOCOMPLETE_SELECTOR, but confirms it still works for a field this
    // module's pattern list alone would not have flagged (no secret-ish
    // id/name/class).
    const dom = makeDom(
      `<html><body><input id="field7" name="field7" autocomplete="one-time-code" value="654321"></body></html>`
    );
    const value = runScrub(dom);
    assert.doesNotMatch(value.scrubbed, /654321/);
  });

  it('matches via class and aria-label too, not just id/name', () => {
    const domClass = makeDom(`<html><body><span class="totp-seed-display">${FAKE_SEED}</span></body></html>`);
    assert.doesNotMatch(runScrub(domClass).scrubbed, new RegExp(FAKE_SEED));

    const domAria = makeDom(`<html><body><span aria-label="api_key">${FAKE_SEED}</span></body></html>`);
    assert.doesNotMatch(runScrub(domAria).scrubbed, new RegExp(FAKE_SEED));
  });

  it('strips data-* and aria-* attributes from a matched element unconditionally, like other categories', () => {
    const { value } = evalScript(
      `<html><body><div id="totpWrapper" data-seed="${FAKE_SEED}" aria-describedby="hint"></div></body></html>`
    );
    assert.match(value.raw, new RegExp(FAKE_SEED));
    assert.doesNotMatch(value.scrubbed, /data-seed/);
  });

  it('does NOT over-redact an ordinary login form (username field, labels, submit button)', () => {
    // Negative test: nothing in an ordinary login page should trip the
    // new default-pattern detection.
    const dom = makeDom(
      '<html><body><form>' +
      '<label for="user">Username</label><input id="user" name="user" value="ada">' +
      '<label for="pass">Password</label><input id="pass" name="pass" type="password">' +
      '<input type="submit" value="Log in"></form></body></html>'
    );
    const value = runScrub(dom);
    assert.equal(value.scrubbed, value.raw, 'an ordinary login form must be unchanged');
  });

  it('does not blank a button/link label whose id happens to reference a secret it operates on', () => {
    // "copy-seed-btn" matches the "seed" pattern, but its own visible
    // text ("Copy") is a UI label, not the secret -- see PATTERN_SKIP_TAGS
    // in html-with-scrub.js.
    const dom = makeDom(
      '<html><body><button id="copy-seed-btn">Copy</button>' +
      '<a id="reveal-totp-link" href="#">Show code</a></body></html>'
    );
    const value = runScrub(dom);
    assert.equal(value.scrubbed, value.raw, 'button/link labels must survive untouched');
  });

  it("blanks a matching STRONG wrapping container's own text AND every descendant leaf's text, not just a matching leaf descendant", () => {
    // The container's own id ("totp-secret") must itself match a STRONG
    // compound (secret-pattern.js's isCompoundSecretMatch) -- round 3
    // (jc finding 4) restricts wholesale container blanking to strong
    // matches, so a merely-weak id like the original "totp-setup" no
    // longer wholesale-blanks (see the dedicated weak-container test
    // below). "two-factor-setup" (the pre-round-3 version of this test)
    // did not match any pattern word at all, so that version exercised
    // nothing: the childElementCount guard it claimed to cover was never
    // reached, and removing that guard entirely still passed.
    const dom = makeDom(
      '<html><body><div id="totp-secret">' +
      '<p>Scan this QR code with your authenticator app.</p>' +
      `<span id="init_key_code">${FAKE_SEED}</span>` +
      '<button id="doneBtn">Done</button>' +
      '</div></body></html>'
    );
    const value = runScrub(dom);
    assert.doesNotMatch(value.scrubbed, new RegExp(FAKE_SEED), 'the seed itself must never survive');
    // A matched STRONG container's descendant text is blanked too,
    // including an ordinary instruction paragraph that carries no secret
    // of its own -- accepted for a strong/small container: leaving a
    // secret in clear to preserve a label is the wrong tradeoff (see
    // html-with-scrub.js's module comment).
    assert.doesNotMatch(value.scrubbed, /Scan this QR code with your authenticator app\./,
      'descendant instruction text inside a matched STRONG container must also be blanked');
    // A skip-tag CONTROL's own label is the one thing that survives even
    // inside a matched container: its visible text is a UI label ('Done'),
    // never the secret, and recursion does not descend into it.
    assert.match(value.scrubbed, />Done<\/button>/, "a control's own label must still survive");
  });

  // Round 3 (jc finding 4): a WEAK container match (a single broad word,
  // not an exact compound) must NOT wholesale-blank -- only a descendant
  // that itself independently matches is found and blanked.
  it('does NOT wholesale-blank a WEAK wrapping container, but still blanks an independently-matching descendant', () => {
    const dom = makeDom(
      '<html><body><div id="totp-setup">' +
      '<p>Scan this QR code with your authenticator app.</p>' +
      `<span id="init_key_code">${FAKE_SEED}</span>` +
      '<button id="doneBtn">Done</button>' +
      '</div></body></html>'
    );
    const value = runScrub(dom);
    assert.doesNotMatch(value.scrubbed, new RegExp(FAKE_SEED), 'the seed itself must never survive (span matches on its own)');
    assert.match(value.scrubbed, /Scan this QR code with your authenticator app\./,
      'a WEAK container ("totp-setup" -- not an exact compound) must not wholesale-blank its ordinary instruction text');
  });

  it('fully blanks a matched container whose secret is split across element children (jc finding 2: "Key: <code>SEED</code>")', () => {
    const dom = makeDom(
      `<html><body><div id="totp-secret">Key: <code>${FAKE_SEED}</code></div></body></html>`
    );
    const value = runScrub(dom);
    assert.doesNotMatch(value.scrubbed, new RegExp(FAKE_SEED), 'the seed must not leak just because it sits inside a <code> child');
  });

  it('fully blanks a matched container that is a list of secrets (jc finding 2: recovery-codes <ul><li>)', () => {
    const dom = makeDom(
      '<html><body><ul class="recovery-codes">' +
      '<li>11112222</li><li>33334444</li><li>55556666</li>' +
      '</ul></body></html>'
    );
    const value = runScrub(dom);
    for (const code of ['11112222', '33334444', '55556666']) {
      assert.doesNotMatch(value.scrubbed, new RegExp(code), `recovery code ${code} must not leak in clear`);
    }
  });

  it('does not page-wide substring-replace common words or corrupt class= attributes (jc finding 1: Prism token spans)', () => {
    // Prism.js (and similar syntax highlighters) literally use "token" as
    // a CSS class name on every highlighted span -- a real, expected
    // match of the pattern, not a bug. The bug was collecting that span's
    // own short TEXT ("class", "const", "return" -- ordinary keywords) into
    // a page-WIDE substring-replace set, which then corrupted every other
    // occurrence of those same words anywhere else on the page, including
    // inside the literal attribute-name text "class=" itself.
    const dom = makeDom(
      '<html><body>' +
      '<pre><span class="token keyword">const</span> x = 1; ' +
      '<span class="token keyword">class</span> Foo {} ' +
      '<span class="token keyword">return</span> x;</pre>' +
      '<p class="footprint">carbon footprint</p>' +
      '<nav class="navbar">Home</nav>' +
      '</body></html>'
    );
    const value = runScrub(dom);
    // The unrelated paragraph and nav survive completely untouched: their
    // own ids/classes do not match the pattern (word-boundary fix -- see
    // secret-pattern.js), and no OTHER element's matched text leaked into
    // a page-wide replace that could have mangled them.
    assert.match(value.scrubbed, /<p class="footprint">carbon footprint<\/p>/,
      '"footprint" must survive -- it only coincidentally contains "otp"');
    assert.match(value.scrubbed, /<nav class="navbar">Home<\/nav>/,
      'an unrelated class="navbar" element must survive untouched');
    // No literal "[REDACTED]=" anywhere: the bug turned every class=
    // attribute's NAME into [REDACTED]= via a global substring replace of
    // the word "class".
    assert.doesNotMatch(value.scrubbed, /\[REDACTED\]=/,
      'no attribute name may be corrupted by a page-wide substring replace');
    // The Prism spans' OWN text is still blanked -- each span's id/class
    // matches the pattern directly, so ITS OWN occurrence is redacted.
    // That is expected, accepted collateral (documented in the PR), not
    // what this test guards against -- only the GLOBAL, page-wide
    // corruption of unrelated text is a bug.
    assert.doesNotMatch(value.scrubbed, />const</, 'the matched span\'s own text is still (individually) blanked');
  });

  // Round 3 (jc finding 4): jc's own two examples, reproduced verbatim.
  it('a design-system wrapper class ("sn-token-provider") does not wipe ordinary page content', () => {
    const dom = makeDom(
      '<html><body><div class="Shell sn-token-provider">' +
      '<h2>Get started</h2><p>Normal docs text here</p>' +
      '</div></body></html>'
    );
    const value = runScrub(dom);
    assert.match(value.scrubbed, /<h2>Get started<\/h2>/, `heading wrongly redacted: ${value.scrubbed}`);
    assert.match(value.scrubbed, /<p>Normal docs text here<\/p>/, `paragraph wrongly redacted: ${value.scrubbed}`);
  });

  it('a docs landmark section id ("module-secrets") does not wipe ordinary page content', () => {
    const dom = makeDom(
      '<html><body><section id="module-secrets">' +
      '<h2>Module: secrets</h2><p>This module manages credentials.</p>' +
      '</section></body></html>'
    );
    const value = runScrub(dom);
    assert.match(value.scrubbed, /<h2>Module: secrets<\/h2>/, `heading wrongly redacted: ${value.scrubbed}`);
    assert.match(value.scrubbed, /<p>This module manages credentials\.<\/p>/, `paragraph wrongly redacted: ${value.scrubbed}`);
  });
});
