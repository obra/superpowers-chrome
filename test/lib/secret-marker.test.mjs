// Real-DOM (jsdom) proof for the page-context scripts in secret-marker.js.
// capture-credential-guard.test.mjs and extraction.test.mjs stub
// Runtime.evaluate to return a canned value, so they prove the Node-side
// wiring but never actually execute HAS_SECRET_MARKER_SCRIPT,
// ANCESTOR_MARKED_FN_SRC or INERT_CLONE_FN_SRC against a real DOM. These
// tests do, the same way test/lib/select-option.test.mjs and
// test/element-selector.test.mjs use jsdom for page-side script coverage
// without booting a real browser.
//
// Covered here:
//   - ancestor marker (via ANCESTOR_MARKED_FN_SRC)
//   - same-origin iframes (via HAS_SECRET_MARKER_SCRIPT)
//   - clone-into-live-document firing img handlers (via
//     INERT_CLONE_FN_SRC) — proven by ownerDocument identity, since jsdom
//     does not fetch image resources at all by default, so an
//     onerror/onload event is not observable here regardless of which
//     document a clone lands in. The mechanism this asserts — importing
//     into a document that never has a browsing context, so it can never
//     become "fully active" — is exactly what suppresses the image-load
//     algorithm per the HTML Standard; in real headless Chrome, a
//     live-document clone shows up as extra GET requests for the cloned
//     images.
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const {
  HAS_SECRET_MARKER_SCRIPT,
  ANCESTOR_MARKED_FN_SRC,
  INERT_CLONE_FN_SRC,
} = require('../../skills/browsing/lib/secret-marker.js');

describe('HAS_SECRET_MARKER_SCRIPT (real DOM)', () => {
  it('is false for a page with no marker anywhere, including inside a same-origin iframe', () => {
    const dom = new JSDOM(
      '<div><span id="x">hi</span></div><iframe id="f"></iframe>',
      { runScripts: 'dangerously' }
    );
    dom.window.document.getElementById('f').contentDocument.body.innerHTML = '<p>clean</p>';
    assert.equal(dom.window.eval(HAS_SECRET_MARKER_SCRIPT), false);
  });

  it('is true for a marker in the top document', () => {
    const dom = new JSDOM('<div data-sen-secret>seed</div>', { runScripts: 'dangerously' });
    assert.equal(dom.window.eval(HAS_SECRET_MARKER_SCRIPT), true);
  });

  // A marker inside a same-origin iframe (e.g. 2FA setup rendered in an
  // embedded frame) is invisible to a top-document-only scan, so
  // eval/extract/attr on the TOP document would never refuse even though
  // `frames[0].document...` can still read the seed straight out of the
  // child frame.
  it('is true for a marker that exists ONLY inside a same-origin iframe', () => {
    const dom = new JSDOM(
      '<div><span id="x">hi</span></div><iframe id="f"></iframe>',
      { runScripts: 'dangerously' }
    );
    dom.window.document.getElementById('f').contentDocument.body.innerHTML =
      '<div data-sen-secret>the-seed</div>';
    assert.equal(dom.window.eval(HAS_SECRET_MARKER_SCRIPT), true);
  });

  it('is true for a marker nested inside an iframe nested inside another iframe', () => {
    const dom = new JSDOM(
      '<iframe id="outer"></iframe>',
      { runScripts: 'dangerously' }
    );
    const outerDoc = dom.window.document.getElementById('outer').contentDocument;
    outerDoc.body.innerHTML = '<iframe id="inner"></iframe>';
    outerDoc.getElementById('inner').contentDocument.body.innerHTML =
      '<div data-sen-secret>deep-seed</div>';
    assert.equal(dom.window.eval(HAS_SECRET_MARKER_SCRIPT), true);
  });

  it('still recurses into open shadow roots (pre-existing behavior, not regressed by the iframe fix)', () => {
    const dom = new JSDOM('<div id="host"></div>', { runScripts: 'dangerously' });
    const host = dom.window.document.getElementById('host');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<span data-sen-secret>seed</span>';
    assert.equal(dom.window.eval(HAS_SECRET_MARKER_SCRIPT), true);
  });

  // Same-origin <object>/<embed> must be scanned: the top frame can read
  // their embedded document just like it can an iframe's. jsdom does not
  // implement OBJECT's contentDocument or EMBED's getSVGDocument() at all
  // (both come back undefined out of the box, unlike a real browser), so
  // this stubs the getter directly on the element the same way a real
  // embedded document would answer it, to prove the SCAN LOGIC descends into
  // whatever embeddedDocOf() returns rather than skipping OBJECT/EMBED tags
  // entirely. See the real-Chrome file:// test in
  // credential-guard-mcp.test.mjs for the end-to-end proof against an actual
  // embedded document.
  it('is true for a marker inside a same-origin OBJECT embedding an HTML document (via contentDocument)', () => {
    const dom = new JSDOM('<object id="o" type="text/html"></object>', { runScripts: 'dangerously' });
    const inner = new JSDOM('<div data-sen-secret>the-seed</div>');
    Object.defineProperty(dom.window.document.getElementById('o'), 'contentDocument', {
      value: inner.window.document,
      configurable: true,
    });
    assert.equal(dom.window.eval(HAS_SECRET_MARKER_SCRIPT), true);
  });

  it('is true for a marker inside an EMBED\'s embedded SVG document (via getSVGDocument())', () => {
    const dom = new JSDOM('<embed id="e" type="image/svg+xml">', { runScripts: 'dangerously' });
    const inner = new JSDOM('<svg xmlns="http://www.w3.org/2000/svg"><text data-sen-secret="">the-seed</text></svg>', { contentType: 'image/svg+xml' });
    dom.window.document.getElementById('e').getSVGDocument = () => inner.window.document;
    assert.equal(dom.window.eval(HAS_SECRET_MARKER_SCRIPT), true);
  });

  it('is false for an OBJECT/EMBED whose embedded document has no marker', () => {
    const dom = new JSDOM('<object id="o" type="text/html"></object><embed id="e">', { runScripts: 'dangerously' });
    const innerObj = new JSDOM('<p>clean</p>');
    Object.defineProperty(dom.window.document.getElementById('o'), 'contentDocument', {
      value: innerObj.window.document,
      configurable: true,
    });
    dom.window.document.getElementById('e').getSVGDocument = () => null;
    assert.equal(dom.window.eval(HAS_SECRET_MARKER_SCRIPT), false);
  });
});

describe('ANCESTOR_MARKED_FN_SRC (real DOM)', () => {
  // Marking a WRAPPER around the value element is the normal pattern
  // (e.g. a backup-codes <ul data-sen-secret>), so
  // extractText/getAttribute/getSanitizedHtml must check ancestors too;
  // checking only the resolved element and its descendants would leak an
  // ancestor-marked value in full.
  function evalAncestorMarked(html, id) {
    const dom = new JSDOM(html, { runScripts: 'dangerously' });
    return dom.window.eval(
      `${ANCESTOR_MARKED_FN_SRC}\n__senAncestorMarked(document.getElementById(${JSON.stringify(id)}))`
    );
  }

  it('is true when the element itself carries the marker', () => {
    assert.equal(evalAncestorMarked('<div id="v" data-sen-secret>seed</div>', 'v'), true);
  });

  it('is true when an ANCESTOR (not the element itself) carries the marker', () => {
    assert.equal(
      evalAncestorMarked('<div data-sen-secret><span id="v">seed</span></div>', 'v'),
      true
    );
  });

  it('is true through several levels of ancestry', () => {
    assert.equal(
      evalAncestorMarked(
        '<div data-sen-secret><section><ul><li id="v">seed</li></ul></section></div>',
        'v'
      ),
      true
    );
  });

  it('is false for an unmarked element with no marked ancestor', () => {
    assert.equal(
      evalAncestorMarked('<div><span id="v">not secret</span></div>', 'v'),
      false
    );
  });

  it('walks up through a shadow-root host, the same way it walks a plain ancestor chain', () => {
    const dom = new JSDOM('<div id="host" data-sen-secret></div>', { runScripts: 'dangerously' });
    const host = dom.window.document.getElementById('host');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<span id="v">seed</span>';
    const result = dom.window.eval(
      `${ANCESTOR_MARKED_FN_SRC}\n__senAncestorMarked(document.getElementById('host').shadowRoot.getElementById('v'))`
    );
    assert.equal(result, true);
  });
});

describe('INERT_CLONE_FN_SRC (real DOM)', () => {
  // el.cloneNode(true) in the live document still runs the <img>
  // image-load algorithm for the clone, producing extra network requests,
  // because that algorithm is gated on the
  // clone's ownerDocument being "fully active" — true for any node whose
  // ownerDocument is the live page, clone or not — not on whether the
  // clone is attached to anything. A document.implementation.
  // createHTMLDocument('') document never gets a browsing context, so it
  // is never "fully active." This asserts the mechanism directly: the
  // clone's ownerDocument is no longer the live document at all.
  it('the ownerDocument of an inert clone is NOT the live document', () => {
    const dom = new JSDOM('<div id="root"><img id="i" src="https://example.test/x.png"></div>', {
      runScripts: 'dangerously',
    });
    const { window } = dom;
    const result = window.eval(
      `${INERT_CLONE_FN_SRC}\nvar c = __senInertClone(document.getElementById('root')); c.ownerDocument === document`
    );
    assert.equal(result, false);
  });

  it('a plain cloneNode(true), by contrast, keeps the live document as ownerDocument', () => {
    // The live-document clone the inert clone avoids.
    const dom = new JSDOM('<div id="root"><img id="i"></div>', { runScripts: 'dangerously' });
    const { window } = dom;
    const result = window.eval(
      "document.getElementById('root').cloneNode(true).ownerDocument === document"
    );
    assert.equal(result, true);
  });

  it('the inert clone still carries over descendant content, so stripping/reading still works', () => {
    const dom = new JSDOM('<div id="root"><p>hello</p></div>', { runScripts: 'dangerously' });
    const { window } = dom;
    const result = window.eval(
      `${INERT_CLONE_FN_SRC}\nvar c = __senInertClone(document.getElementById('root')); c.outerHTML`
    );
    assert.equal(result, '<div id="root"><p>hello</p></div>');
  });
});
