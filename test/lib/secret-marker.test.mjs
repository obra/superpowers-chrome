// Real-DOM (jsdom) proof for the page-context scripts in secret-marker.js.
// capture-credential-guard.test.mjs and extraction.test.mjs stub
// Runtime.evaluate to return a canned value, so they prove the Node-side
// wiring but never actually execute HAS_SECRET_MARKER_SCRIPT,
// ANCESTOR_MARKED_FN_SRC or INERT_CLONE_FN_SRC against a real DOM. These
// tests do, the same way test/lib/select-option.test.mjs and
// test/element-selector.test.mjs use jsdom for page-side script coverage
// without booting a real browser.
//
// obra#52 review findings covered here:
//   1. ancestor marker (via ANCESTOR_MARKED_FN_SRC)
//   3. same-origin iframes (via HAS_SECRET_MARKER_SCRIPT)
//   regression. clone-into-live-document firing img handlers (via
//      INERT_CLONE_FN_SRC) — proven by ownerDocument identity, since
//      jsdom (like real Chrome, per the review) does not fetch image
//      resources at all by default, so an onerror/onload event is not
//      observable here regardless of which document a clone lands in.
//      The mechanism this asserts — importing into a document that never
//      has a browsing context, so it can never become "fully active" —
//      is exactly what suppresses the image-load algorithm per the HTML
//      Standard; jc's original report (extra GET requests in real
//      headless Chrome) is the end-to-end proof of the consequence.
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const {
  HAS_SECRET_MARKER_SCRIPT,
  ANCESTOR_MARKED_FN_SRC,
  INERT_CLONE_FN_SRC,
  SECRET_SEEN_SENTINEL_SCRIPT,
  refreshSecretLatch,
  isSecretLatched,
  secretLatchedAt,
  originOf,
  resetSecretLatchForNavigation,
} = require('../../skills/browsing/lib/secret-marker.js');

// Minimal page-session stub: routes Runtime.evaluate at a real jsdom
// window, the same pattern test/lib/set-attribute.test.mjs uses for
// Runtime.callFunctionOn. sessionId is fixed per stub so state.secretLatch
// (keyed by sessionId) behaves like one real tab across calls.
function psFor(window, sessionId = 'S1') {
  return {
    sessionId,
    send: async (method, params) => {
      if (method === 'Runtime.evaluate') {
        const value = window.eval(params.expression);
        return { result: { value } };
      }
      return {};
    },
  };
}

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

  // obra#52 review finding 3: a marker inside a same-origin iframe (e.g.
  // 2FA setup rendered in an embedded frame) was invisible to the
  // top-document-only scan, so eval/extract/attr on the TOP document
  // never refused even though `frames[0].document...` could still read
  // the seed straight out of the child frame.
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
});

describe('ANCESTOR_MARKED_FN_SRC (real DOM)', () => {
  // obra#52 review finding 1: marking a WRAPPER around the value element
  // is the normal pattern (e.g. a backup-codes <ul data-sen-secret>), but
  // extractText/getAttribute/getSanitizedHtml previously checked only the
  // resolved element and its descendants — an ancestor marker leaked in
  // full.
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
  // The regression jc reported: el.cloneNode(true) in the live document
  // still ran the <img> image-load algorithm for the clone, producing
  // extra network requests, because that algorithm is gated on the
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
    // Documents the exact regression: this is what the pre-fix code did.
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

// obra#52 review round 2, finding 1: a post-hoc "is a marker present right
// now" recheck can be defeated by removeAttribute'ing the marker as the
// last step before the recheck runs. The sentinel is a one-way, page-side
// sticky flag fed by a MutationObserver watching mutation RECORDS (not the
// live DOM), so it survives exactly that.
describe('SECRET_SEEN_SENTINEL_SCRIPT (real DOM)', () => {
  it('is false on install when no marker is present', () => {
    const dom = new JSDOM('<div id="a"></div>', { runScripts: 'dangerously' });
    const { window } = dom;
    const result = window.eval(SECRET_SEEN_SENTINEL_SCRIPT);
    assert.equal(result, false);
    assert.equal(window.eval('window.__senSecretSeen'), false);
  });

  it('is true on install when a marker already exists (page loaded already marked)', () => {
    const dom = new JSDOM('<code id="s" data-sen-secret>seed</code>', { runScripts: 'dangerously' });
    const { window } = dom;
    const result = window.eval(SECRET_SEEN_SENTINEL_SCRIPT);
    assert.equal(result, true);
  });

  it('is idempotent: installing twice does not reset an already-true flag', () => {
    const dom = new JSDOM('<code id="s" data-sen-secret>seed</code>', { runScripts: 'dangerously' });
    const { window } = dom;
    window.eval(SECRET_SEEN_SENTINEL_SCRIPT);
    window.document.getElementById('s').removeAttribute('data-sen-secret');
    const result = window.eval(SECRET_SEEN_SENTINEL_SCRIPT);
    assert.equal(result, true);
  });

  it('exfiltration route: setAttribute then removeAttribute in the same synchronous turn still latches (removeAttribute must not clear it)', async () => {
    const dom = new JSDOM('<div id="a"></div>', { runScripts: 'dangerously' });
    const { window } = dom;
    window.eval(SECRET_SEEN_SENTINEL_SCRIPT);
    assert.equal(window.eval('window.__senSecretSeen'), false);

    window.eval(`
      document.getElementById('a').setAttribute('data-sen-secret', 'x');
      document.getElementById('a').removeAttribute('data-sen-secret');
    `);
    // Live DOM shows no marker at all right now...
    assert.equal(window.document.getElementById('a').hasAttribute('data-sen-secret'), false);
    // ...but the MutationObserver callback (a microtask) has already run by
    // the time a Node process could send another CDP command, so the
    // sentinel is latched regardless of the live DOM's current state.
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(window.eval('window.__senSecretSeen'), true);
  });

  it('a childList removal of a marked subtree still latches', async () => {
    const dom = new JSDOM('<div id="root"><code id="s" data-sen-secret>seed</code></div>', { runScripts: 'dangerously' });
    const { window } = dom;
    window.eval(SECRET_SEEN_SENTINEL_SCRIPT);
    // Start from a state where the sentinel's initial scan already saw it;
    // reset the in-page flag to prove the OBSERVER (not just the initial
    // scan) also catches a removal.
    window.eval("window.__senSecretSeen = false;");
    window.eval("document.getElementById('s').remove();");
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(window.eval('window.__senSecretSeen'), true);
  });
});

describe('refreshSecretLatch / isSecretLatched (per-tab latch)', () => {
  it('latches on a live marker and stays latched after the state object is reused for a later call', async () => {
    const dom = new JSDOM('<code id="s" data-sen-secret>seed</code>', { runScripts: 'dangerously' });
    const ps = psFor(dom.window);
    const state = { secretLatch: new Map() };

    assert.equal(isSecretLatched(state, ps.sessionId), false);
    const latched = await refreshSecretLatch(state, ps);
    assert.equal(latched, true);
    assert.equal(isSecretLatched(state, ps.sessionId), true);
    assert.equal(typeof secretLatchedAt(state, ps.sessionId), 'number');
  });

  it('exfiltration route: stays latched via the sentinel after removeAttribute clears the live marker', async () => {
    const dom = new JSDOM('<code id="s" data-sen-secret>seed</code>', { runScripts: 'dangerously' });
    const ps = psFor(dom.window);
    const state = { secretLatch: new Map() };

    // First check while marked: latches.
    assert.equal(await refreshSecretLatch(state, ps), true);

    // Page removes the marker.
    dom.window.document.getElementById('s').removeAttribute('data-sen-secret');
    await Promise.resolve();
    await Promise.resolve();

    // Live marker is gone, but the latch (backed by the sticky sentinel) stays true.
    assert.equal(dom.window.document.getElementById('s').hasAttribute('data-sen-secret'), false);
    assert.equal(await refreshSecretLatch(state, ps), true);
    assert.equal(isSecretLatched(state, ps.sessionId), true);
  });

  it('never latches a tab that has genuinely never shown a marker', async () => {
    const dom = new JSDOM('<div id="a">nothing here</div>', { runScripts: 'dangerously' });
    const ps = psFor(dom.window);
    const state = { secretLatch: new Map() };

    assert.equal(await refreshSecretLatch(state, ps), false);
    assert.equal(isSecretLatched(state, ps.sessionId), false);
  });

  it('a failed live check fails closed: callers must treat a thrown error as "suppress", not "clean"', async () => {
    const state = { secretLatch: new Map() };
    const brokenPs = { sessionId: 'S2', send: async () => { throw new Error('CDP boom'); } };
    await assert.rejects(() => refreshSecretLatch(state, brokenPs), /CDP boom/);
  });
});

describe('originOf / resetSecretLatchForNavigation (latch reset rule)', () => {
  it('http(s) URLs resolve to their origin', () => {
    assert.equal(originOf('https://example.test/a/b?x=1'), 'https://example.test');
    assert.equal(originOf('https://example.test:8443/a'), 'https://example.test:8443');
  });

  it('opaque schemes (data:, blob:, about:, javascript:) resolve to null — never equal to anything, including themselves', () => {
    for (const url of ['data:text/html,<h1>hi</h1>', 'blob:https://example.test/uuid', 'about:blank', 'javascript:void(0)']) {
      assert.equal(originOf(url), null, url);
    }
  });

  it('same-origin navigation keeps an existing latch', () => {
    const state = { secretLatch: new Map([['S1', { seen: true, origin: 'https://example.test', latchedAt: 123 }]]) };
    resetSecretLatchForNavigation(state, 'S1', 'https://example.test/other-page');
    assert.equal(isSecretLatched(state, 'S1'), true);
  });

  it('cross-origin navigation resets the latch', () => {
    const state = { secretLatch: new Map([['S1', { seen: true, origin: 'https://example.test', latchedAt: 123 }]]) };
    resetSecretLatchForNavigation(state, 'S1', 'https://attacker.test/');
    assert.equal(isSecretLatched(state, 'S1'), false);
  });

  it('navigating to an opaque URL (data:) always resets, even from a previously-latched opaque page', () => {
    const state = { secretLatch: new Map([['S1', { seen: true, origin: null, latchedAt: 123 }]]) };
    resetSecretLatchForNavigation(state, 'S1', 'data:text/html,<h1>next</h1>');
    assert.equal(isSecretLatched(state, 'S1'), false);
  });

  it('a not-yet-latched same-origin navigation stays unlatched (nothing to keep)', () => {
    const state = { secretLatch: new Map([['S1', { seen: false, origin: 'https://example.test', latchedAt: null }]]) };
    resetSecretLatchForNavigation(state, 'S1', 'https://example.test/other-page');
    assert.equal(isSecretLatched(state, 'S1'), false);
  });
});
