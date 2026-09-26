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
 * Also recurses into same-origin iframes/frames (obra#52 review finding
 * 3): a marker placed inside an `srcdoc` or same-origin `<iframe>` is
 * invisible to a top-document-only scan, but the seed is still reachable
 * from the top frame via `frames[0].document...`. `el.contentDocument` is
 * `null` for a cross-origin frame (the getter itself never throws), so
 * this only ever descends where the top frame could read the child's DOM
 * anyway.
 */
const { throwIfExceptionDetails } = require('./cdp-utils');
const { MARKER_ATTR } = require('./credential-guard');

const HAS_SECRET_MARKER_SCRIPT = `
  (() => {
    const MARKER = ${JSON.stringify(MARKER_ATTR)};
    const hasMarker = (root) => {
      if (root.querySelector && root.querySelector('[' + MARKER + ']')) return true;
      if (!root.querySelectorAll) return false;
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot && hasMarker(el.shadowRoot)) return true;
        if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
          let frameDoc;
          try { frameDoc = el.contentDocument; } catch (_e) { frameDoc = null; }
          if (frameDoc && hasMarker(frameDoc)) return true;
        }
      }
      return false;
    };
    return hasMarker(document);
  })()
`;

// Page-context source for a helper that walks UP from a node — through
// shadow-root hosts, the same way HAS_SECRET_MARKER_SCRIPT walks down them
// — checking the node itself and every ancestor for the marker (obra#52
// review finding 1: marking a wrapper is the normal pattern, but
// extractText/getAttribute/getSanitizedHtml only checked the resolved
// element and its descendants, so a marker on an ancestor leaked). Spliced
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
// document instead of the live one (obra#52 review regression:
// `el.cloneNode(true)` in the live document still runs the image-loading
// algorithm for any cloned `<img>` — that algorithm is gated on the node's
// ownerDocument being "fully active", which a same-document clone still
// is, not on whether the clone is attached. A document created by
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
