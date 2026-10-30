/**
 * PRI-3265 (child, PR #70 follow-up): shared "is this tab's title/URL safe
 * to print" check, used by mcp/src/index.ts's list_tabs, switch_tab, and
 * navigate to decide whether to redact a tab that need not be the active
 * one.
 *
 * Split out as its own injected-dependency module (mirrors
 * attachCapture/attachNavigation/attachConsoleLogging's own factory-style
 * exports elsewhere in this directory) specifically so the fail-closed
 * behavior on an error from the live-DOM marker check is unit-testable
 * with a stub, without booting a real Chrome or MCP server the way
 * mcp/src/index.ts itself requires (it connects an MCP stdio transport as
 * an unconditional side effect of being imported).
 */

/**
 * attachTabSensitivity({ credentialCaptureAllowed, urlLooksSensitive, getPageSession, pageHasSecretMarker })
 *
 * - credentialCaptureAllowed(): () => boolean -- credential-guard.js's own
 *   escape hatch (SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE=1); when true,
 *   nothing here is ever treated as sensitive.
 * - urlLooksSensitive(url): sensitive-url.js's known-sensitive-URL check.
 *   Cheap (no CDP round trip) and checked first.
 * - getPageSession(tabIndex): chrome-ws-lib.js's shared page-session
 *   resolver, re-exported from rawSession for this one caller.
 * - pageHasSecretMarker(ps): secret-marker.js's live-DOM data-sen-secret
 *   check -- the exact same helper eval/extract/attr already use.
 */
function attachTabSensitivity({ credentialCaptureAllowed, urlLooksSensitive, getPageSession, pageHasSecretMarker }) {
  // `type` lets a non-'page' target (a service_worker/background_page has
  // no document to query) skip straight to the URL-only check rather than
  // fail a Runtime.evaluate call that was never going to resolve.
  //
  // On any error getting/querying the page session (a tab that closed
  // between the caller's own getTabs() snapshot and here, a CDP hiccup,
  // say) this fails CLOSED: treats the tab as sensitive, same as a live
  // marker finding would. A caller that can't confirm a tab is safe to
  // show must not show it. This was previously fail-OPEN (returned false,
  // printing the real title/url, on any such error) -- Reeve caught this
  // in review of #70 against real Chrome. The tab's index/id are
  // untouched by this either way (list_tabs keeps them unconditionally;
  // switch_tab matches against the tab's REAL title/url, not this check),
  // so a tab this function can't vouch for still stays listed and
  // selectable, just redacted.
  async function tabContentIsSensitive(tabIndex, url, type) {
    if (credentialCaptureAllowed()) return false;
    if (urlLooksSensitive(url)) return true;
    if (type && type !== 'page') return false;
    try {
      const ps = await getPageSession(tabIndex);
      return await pageHasSecretMarker(ps);
    } catch {
      return true;
    }
  }

  return { tabContentIsSensitive };
}

module.exports = { attachTabSensitivity };
