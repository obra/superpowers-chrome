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
 */
const { throwIfExceptionDetails } = require('./cdp-utils');

const HAS_SECRET_MARKER_SCRIPT = `
  (() => {
    const hasMarker = (root) => {
      if (root.querySelector && root.querySelector('[data-sen-secret]')) return true;
      if (!root.querySelectorAll) return false;
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot && hasMarker(el.shadowRoot)) return true;
      }
      return false;
    };
    return hasMarker(document);
  })()
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

module.exports = { HAS_SECRET_MARKER_SCRIPT, pageHasSecretMarker };
