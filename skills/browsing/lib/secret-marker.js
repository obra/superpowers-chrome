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

// --- Per-tab "secret seen" latch (obra#52 review, round 2, finding 1) ---
//
// pageHasSecretMarker above is a point-in-time check: it answers "is a
// marker present RIGHT NOW". That is exactly what a hostile page can defeat
// with a self-erasing marker: mark an element, read/leak its value by a
// channel that isn't the normal return path (throw the value in an Error,
// console.log it, alert() it), then call removeAttribute(data-sen-secret)
// as the LAST synchronous step before any post-hoc recheck runs. The
// recheck sees no marker and waves the result through even though the
// value was already read while it WAS marked.
//
// The fix is a sticky, one-way latch: once a marker has been observed on a
// tab, by ANY mechanism, the tab stays "latched" even after the marker is
// removed. removeAttribute clears the DOM attribute; it must never clear
// the latch. Two independent detectors feed the same latch, because either
// alone can be raced:
//   - A page-side MutationObserver (SECRET_SEEN_SENTINEL_SCRIPT below) that
//     inspects mutation RECORDS, not the live DOM. A record naming the
//     marker attribute means that attribute was touched (added OR removed)
//     regardless of what the DOM looks like by the time anyone reads it.
//     MutationObserver callbacks run as microtasks; a synchronous
//     set+remove pair inside one script turn still produces two separate
//     records the callback sees together, before our Node process ever
//     gets a chance to send another CDP command (which requires a real
//     network round trip, i.e. a later task, not a microtask) - so by the
//     time Node re-checks anything, the sentinel has already latched.
//   - A plain "is a marker present right now" scan (pageHasSecretMarker),
//     which is still useful as a fallback covering pages/paths that ran
//     before the sentinel script was installed (e.g. the very first
//     evaluate on a page, right after navigate, before this module's
//     ensureSecretSeenSentinel call has had a chance to run).
//
// Reset rule (also see navigation.js and CHANGELOG): the latch resets when
// the tab navigates to a NEW ORIGIN, and only then. Same-origin navigation
// (an SPA route change that goes through navigate(), or a plain reload)
// keeps the tab latched — a same-origin page can still reach the secret via
// fetch/XHR/storage even after routing away from the element that showed
// it, so treating a same-origin navigation as a fresh start would reopen
// exactly the hole this closes. A cross-origin navigation gets a fresh
// latch because it is, by the browser's own security model, a different
// page with no access to the old one's state.
const SECRET_SEEN_SENTINEL_SCRIPT = `
  (() => {
    if (window.__senSecretSeenInit) return !!window.__senSecretSeen;
    window.__senSecretSeenInit = true;
    window.__senSecretSeen = false;
    const MARKER = ${JSON.stringify(MARKER_ATTR)};
    const scan = (root) => {
      if (root.querySelector && root.querySelector('[' + MARKER + ']')) return true;
      if (!root.querySelectorAll) return false;
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot && scan(el.shadowRoot)) return true;
        if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
          let frameDoc;
          try { frameDoc = el.contentDocument; } catch (_e) { frameDoc = null; }
          if (frameDoc && scan(frameDoc)) return true;
        }
      }
      return false;
    };
    const nodeCarriesMarker = (n) => {
      if (!n || n.nodeType !== 1) return false;
      if (n.hasAttribute && n.hasAttribute(MARKER)) return true;
      return !!(n.querySelector && n.querySelector('[' + MARKER + ']'));
    };
    if (scan(document)) window.__senSecretSeen = true;
    const observer = new MutationObserver((records) => {
      if (window.__senSecretSeen) return;
      for (const r of records) {
        if (r.type === 'attributes' && r.attributeName === MARKER) {
          window.__senSecretSeen = true;
          return;
        }
        if (r.type === 'childList') {
          for (const n of r.addedNodes) if (nodeCarriesMarker(n)) { window.__senSecretSeen = true; return; }
          for (const n of r.removedNodes) if (nodeCarriesMarker(n)) { window.__senSecretSeen = true; return; }
        }
      }
      // Fallback: catches anything the record-based check can't name
      // directly (e.g. a shadow root attached under an observed node).
      if (scan(document)) window.__senSecretSeen = true;
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [MARKER],
      childList: true,
      subtree: true,
    });
    return !!window.__senSecretSeen;
  })()
`;

// Idempotent: installs the sentinel (including its initial scan) on first
// call for this document; every later call is a cheap read of the flag the
// observer maintains. Safe to call before every guarded action.
async function ensureSecretSeenSentinel(ps) {
  const result = await ps.send('Runtime.evaluate', {
    expression: SECRET_SEEN_SENTINEL_SCRIPT,
    returnByValue: true,
  });
  throwIfExceptionDetails(result);
  return !!result.result.value;
}

// Consults (and updates) state.secretLatch for this tab. Returns true if
// the tab is latched — either it already was, or a marker is observable
// right now (live scan) or was observed at any point since the sentinel was
// installed (sticky, page-side flag; survives removeAttribute). Throws if
// either underlying CDP check fails — callers that gate a disk write on
// this MUST treat a thrown error as "suppress", never as "clean" (obra#52
// review round 2, finding 2: don't persist on an incomplete check).
async function refreshSecretLatch(state, ps) {
  if (!state.secretLatch) state.secretLatch = new Map();
  const sid = ps.sessionId;
  let entry = state.secretLatch.get(sid);
  if (!entry) {
    entry = { seen: false, origin: null, latchedAt: null };
    state.secretLatch.set(sid, entry);
  }
  const [sentinel, live] = await Promise.all([
    ensureSecretSeenSentinel(ps),
    pageHasSecretMarker(ps),
  ]);
  if ((sentinel || live) && !entry.seen) {
    entry.seen = true;
    entry.latchedAt = Date.now();
  }
  return entry.seen;
}

function isSecretLatched(state, sid) {
  const entry = state.secretLatch && state.secretLatch.get(sid);
  return !!(entry && entry.seen);
}

function secretLatchedAt(state, sid) {
  const entry = state.secretLatch && state.secretLatch.get(sid);
  return entry ? entry.latchedAt : null;
}

// Called from navigate(): decides whether the outgoing navigation keeps or
// resets the latch, per the reset rule documented above. `url` is the
// target of the navigation about to happen. Opaque origins (data:, blank,
// about:, or a URL that fails to parse) are never treated as "the same
// origin" as anything, including a previous opaque origin — each opaque
// navigation is a fresh start, matching how the platform itself treats
// opaque origins (never equal, not even to themselves).
function originOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:' || u.protocol === 'javascript:') {
      return null;
    }
    return u.origin;
  } catch (_err) {
    return null;
  }
}

function resetSecretLatchForNavigation(state, sid, url) {
  if (!state.secretLatch) state.secretLatch = new Map();
  const newOrigin = originOf(url);
  const existing = state.secretLatch.get(sid);
  const sameNonOpaqueOrigin =
    existing && existing.seen && existing.origin !== null && newOrigin !== null && existing.origin === newOrigin;
  if (!sameNonOpaqueOrigin) {
    state.secretLatch.set(sid, { seen: false, origin: newOrigin, latchedAt: null });
  } else {
    existing.origin = newOrigin;
  }
}

module.exports = {
  HAS_SECRET_MARKER_SCRIPT,
  ANCESTOR_MARKED_FN_SRC,
  INERT_CLONE_FN_SRC,
  SECRET_SEEN_SENTINEL_SCRIPT,
  pageHasSecretMarker,
  ensureSecretSeenSentinel,
  refreshSecretLatch,
  isSecretLatched,
  secretLatchedAt,
  originOf,
  resetSecretLatchForNavigation,
};
