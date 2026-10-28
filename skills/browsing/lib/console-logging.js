/**
 * Page console-message capture.
 *
 * `enableConsoleLogging` subscribes to `Runtime.consoleAPICalled` events on
 * the existing pageSession (bridge) connection and streams console output into
 * `state.consoleMessages` keyed by `sessionId`.
 *
 * `getConsoleMessages` reads the buffer -- optionally filtered by timestamp.
 * PRI-3265: before returning anything, it refuses outright if a live
 * data-sen-secret marker is present anywhere on the page, or the page's
 * URL is on the known-sensitive list -- the same two whole-page signals
 * pageTextReadRefused (sensitive-url.js) already gates eval/extract/attr
 * on, checked here directly rather than through that function because
 * its own wording ("read a narrower, element-scoped selector instead")
 * doesn't apply to a console-message buffer, which has no
 * selector/element form at all. Before this, the console buffer was the
 * one read path with zero marker/URL awareness: a page that
 * console.logs a revealed secret (e.g. a "copy to clipboard" handler
 * logging the value it just copied) leaked it through here untouched by
 * any of the other gates. credentialCaptureAllowed() is checked first,
 * same as every other gate in this codebase and for the same reason (see
 * sensitive-url.js's pageTextReadRefused for the full argument: the env
 * var is read once from the MCP server's own environment at startup,
 * unreachable from anything an agent controls at runtime).
 *
 * clearConsoleMessages resets the buffer for a tab. Not gated: clearing
 * is a destructive write with nothing to read back, the same reasoning
 * that exempts set_attr from the marker check elsewhere in this
 * codebase.
 *
 * attachConsoleLogging({ state, getPageSession }) returns the bound API.
 */
const { throwIfExceptionDetails } = require('./cdp-utils');
const { credentialCaptureAllowed, consoleMessagesRefusal } = require('./credential-guard');
const { pageHasSecretMarker } = require('./secret-marker');
const { urlLooksSensitive } = require('./sensitive-url');

function attachConsoleLogging({ state, getPageSession }) {
  async function enableConsoleLogging(tabIndexOrWsUrl) {
    const ps = await getPageSession(tabIndexOrWsUrl);

    if (!state.consoleMessages.has(ps.sessionId)) {
      state.consoleMessages.set(ps.sessionId, []);
    }

    await ps.enableDomain('Runtime');

    ps.onEvent((msg) => {
      if (msg.method === 'Runtime.consoleAPICalled') {
        const entry = msg.params;
        const timestamp = new Date().toISOString();
        const level = entry.type || 'log';
        const args = entry.args || [];

        const text = args.map(arg => {
          if (arg.type === 'string') return arg.value;
          if (arg.type === 'number') return String(arg.value);
          if (arg.type === 'boolean') return String(arg.value);
          if (arg.type === 'object') return arg.description || '[Object]';
          return String(arg.value || arg.description || arg.type);
        }).join(' ');

        const messages = state.consoleMessages.get(ps.sessionId) || [];
        // Dedup: skip if the last entry has the same level+text at the same
        // timestamp (prevents double-fire when multiple CDP event listeners
        // route the same console call through the same handler).
        const last = messages[messages.length - 1];
        if (!last || last.timestamp !== timestamp || last.level !== level || last.text !== text) {
          messages.push({ timestamp, level, text });
          state.consoleMessages.set(ps.sessionId, messages);
        }
      }
    });
  }

  async function getConsoleMessages(tabIndexOrWsUrl, sinceTime = null) {
    const ps = await getPageSession(tabIndexOrWsUrl);

    // PRI-3265: see this module's own doc comment above for why this is
    // checked directly (pageHasSecretMarker/urlLooksSensitive) instead of
    // through sensitive-url.js's pageTextReadRefused -- same two
    // detectors, same credentialCaptureAllowed() escape hatch, own
    // wording. Order matches pageTextReadRefused's: override check first,
    // then marker (cheapest live-DOM signal), then URL.
    if (!credentialCaptureAllowed()) {
      if (await pageHasSecretMarker(ps)) {
        throw new Error(consoleMessagesRefusal('an element on the page is marked data-sen-secret'));
      }
      const urlResult = await ps.send('Runtime.evaluate', {
        expression: 'location.href',
        returnByValue: true,
      });
      throwIfExceptionDetails(urlResult);
      if (urlLooksSensitive(urlResult.result.value)) {
        throw new Error(consoleMessagesRefusal(
          'the URL matches a known-sensitive pattern (2FA/MFA/TOTP setup, recovery or backup codes, security keys)'
        ));
      }
    }

    const messages = state.consoleMessages.get(ps.sessionId) || [];

    if (!sinceTime) {
      return messages;
    }

    return messages.filter(msg => new Date(msg.timestamp) > sinceTime);
  }

  async function clearConsoleMessages(tabIndexOrWsUrl) {
    const ps = await getPageSession(tabIndexOrWsUrl);
    state.consoleMessages.set(ps.sessionId, []);
  }

  return { enableConsoleLogging, getConsoleMessages, clearConsoleMessages };
}

module.exports = { attachConsoleLogging };
