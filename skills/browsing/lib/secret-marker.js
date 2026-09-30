/**
 * Live-DOM check for the `data-sen-secret` page marker (see
 * lib/credential-guard.js for the marker's purpose).
 *
 * credential-guard.js's `containsCredentialShaped` spots the marker by
 * regex-matching a *serialized* HTML string for a `<... data-sen-secret`
 * tag. That works for the auto-capture path (which always has outerHTML in
 * hand) but is the wrong tool for actions that hand a caller plain text or
 * an attribute value with no surrounding tag to match against — by the
 * time eval/extract/attr produce their result, the tag (and the attribute
 * on it) is gone. This module queries the *live* DOM instead: "does any
 * element right now carry data-sen-secret", independent of whatever text
 * or attribute a caller is about to read off it.
 *
 * Read-only: querySelector/querySelectorAll never mutate the page, so a
 * credential capture that reads the same element via CDP immediately after
 * sees it unchanged.
 *
 * Recurses into open shadow roots for the same reason
 * page-scripts/rendered-text.js does: outerHTML doesn't serialize them, so
 * the HTML-string check can't see a marker placed inside one, but a live
 * query can.
 *
 * Also recurses into same-origin iframes/frames: a marker placed inside an
 * `srcdoc` or same-origin `<iframe>` is invisible to a top-document-only
 * scan, but the seed is still reachable from the top frame via
 * `frames[0].document...`. `el.contentDocument` is `null` for a
 * cross-origin frame (the getter itself never throws), so this only ever
 * descends where the top frame could read the child's DOM anyway.
 *
 * Also recurses into same-origin `<object>`/`<embed>`: a marker inside a
 * same-origin OBJECT's embedded HTML document, or an OBJECT/EMBED's
 * embedded SVG document, is invisible to a scan that only checks
 * IFRAME/FRAME. `contentDocument` covers an
 * OBJECT embedding an HTML/XML document (EMBED has no such property);
 * `getSVGDocument()` covers either tag embedding SVG. Both getters can
 * throw or return null for a cross-origin or non-document embed, which is
 * exactly the cases this must not descend into anyway.
 *
 * A same-origin EMBED of text/html has neither: Chrome gives EMBED no
 * contentDocument, and getSVGDocument() is null for HTML, yet
 * `frames[i].document` still reads it. So the last fallback looks the
 * element up in its owner window's `frames` by `frameElement` and reads
 * that frame's document. A
 * cross-origin frame throws on `frameElement`/`document`, so this still
 * only descends where the top frame could read the child's DOM anyway.
 * Recursion into deeper frames comes from hasMarker scanning the
 * embedded document's own elements. Not covered: an EMBED of text/html
 * inside a shadow root, whose frame `window.frames` does not list.
 */
const { throwIfExceptionDetails } = require('./cdp-utils');
const { MARKER_ATTR } = require('./credential-guard');

const HAS_SECRET_MARKER_SCRIPT = `
  (() => {
    const MARKER = ${JSON.stringify(MARKER_ATTR)};
    const embeddedDocOf = (el) => {
      try {
        if (el.contentDocument) return el.contentDocument;
      } catch (_e) { /* cross-origin: never reachable from here either */ }
      try {
        if (typeof el.getSVGDocument === 'function') {
          const svgDoc = el.getSVGDocument();
          if (svgDoc) return svgDoc;
        }
      } catch (_e) { /* cross-origin, or not embedding an SVG document */ }
      const win = el.ownerDocument && el.ownerDocument.defaultView;
      if (!win) return null;
      for (let i = 0; i < win.frames.length; i++) {
        try {
          if (win.frames[i].frameElement === el) return win.frames[i].document;
        } catch (_e) { /* cross-origin frame: its document is unreadable from here */ }
      }
      return null;
    };
    const hasMarker = (root) => {
      if (root.querySelector && root.querySelector('[' + MARKER + ']')) return true;
      if (!root.querySelectorAll) return false;
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot && hasMarker(el.shadowRoot)) return true;
        if (el.tagName === 'IFRAME' || el.tagName === 'FRAME' || el.tagName === 'OBJECT' || el.tagName === 'EMBED') {
          const embeddedDoc = embeddedDocOf(el);
          if (embeddedDoc && hasMarker(embeddedDoc)) return true;
        }
      }
      return false;
    };
    return hasMarker(document);
  })()
`;

// Page-context source for a helper that walks UP from a node — through
// shadow-root hosts, the same way HAS_SECRET_MARKER_SCRIPT walks down them
// — checking the node itself and every ancestor for the marker. Marking a
// wrapper is the normal pattern, so extractText/getAttribute/
// getSanitizedHtml must not check only the resolved element and its
// descendants, or a marker on an ancestor would leak. Spliced
// as text into Runtime.evaluate expression strings that run in the page's
// JS realm, not this Node process — see extraction.js and mcp/src/index.ts.
const ANCESTOR_MARKED_FN_SRC = `
  function __senAncestorMarked(start) {
    var MARKER = ${JSON.stringify(MARKER_ATTR)};
    var node = start;
    while (node) {
      if (node.nodeType === 1 && node.hasAttribute && node.hasAttribute(MARKER)) return true;
      if (node.parentElement) {
        node = node.parentElement;
      } else {
        var root = node.getRootNode ? node.getRootNode() : null;
        node = (root && root.host) ? root.host : null;
      }
    }
    return false;
  }
`;

// Page-context source for a helper that clones a node into a fresh, inert
// document instead of the live one. `el.cloneNode(true)` in the live
// document still runs the image-loading algorithm for any cloned `<img>` —
// that algorithm is gated on the node's ownerDocument being "fully
// active", which a same-document clone still is, not on whether the clone
// is attached. A document created by
// `document.implementation.createHTMLDocument` never gets a browsing
// context, so it is never "fully active" and elements imported into it
// never fire onload/onerror. `importNode` deep-copies without detaching
// the original from the live document.
const INERT_CLONE_FN_SRC = `
  function __senInertClone(node) {
    var inertDoc = document.implementation.createHTMLDocument('');
    return inertDoc.importNode(node, true);
  }
`;

// ps: an already-resolved page session (the object returned by
// getPageSession(...), with a .send(method, params) method).
async function pageHasSecretMarker(ps) {
  const result = await ps.send('Runtime.evaluate', {
    expression: HAS_SECRET_MARKER_SCRIPT,
    returnByValue: true,
  });
  throwIfExceptionDetails(result);
  return !!result.result.value;
}

module.exports = {
  HAS_SECRET_MARKER_SCRIPT,
  ANCESTOR_MARKED_FN_SRC,
  INERT_CLONE_FN_SRC,
  pageHasSecretMarker,
};
