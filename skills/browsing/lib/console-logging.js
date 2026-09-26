/**
 * Page console-message capture.
 *
 * `enableConsoleLogging` subscribes to `Runtime.consoleAPICalled` events on
 * the existing pageSession (bridge) connection and streams console output into
 * `state.consoleMessages` keyed by `sessionId`.
 *
 * `getConsoleMessages` reads the buffer — optionally filtered by timestamp.
 * `clearConsoleMessages` resets the buffer for a tab.
 *
 * `attachConsoleLogging({ state, getPageSession })` returns the bound API.
 *
 * obra#52 review round 2, finding 1: `console.log(secret)` is one of the
 * channels a page can use to get a marked value out without ever putting it
 * in an action's return value. get_console_messages had no credential guard
 * of any kind — not even the shape-based regex the rest of the capture path
 * has, since a marker exists exactly for values (bare TOTP seeds, backup
 * codes) that HAVE no recognizable shape. getConsoleMessages below now
 * checks the tab's secret-seen latch (lib/secret-marker.js) on every read:
 * once a tab has ever shown a marker, the ENTIRE buffer for that tab reads
 * back redacted, not just messages logged after the marker appeared. That
 * is deliberately simpler (and more conservative) than timestamp-slicing
 * the buffer at the moment the latch fired — the latch is only checked when
 * something reads the buffer, not continuously, so "before" and "after"
 * aren't reliably orderable at sub-action granularity, and a tab that has
 * ever shown a secret is exactly the tab this guard exists to stop trusting.
 * The latch itself is one-way (lib/secret-marker.js's sticky sentinel), so
 * this stays redacted even after the marker is removeAttribute'd.
 */
const { credentialCaptureAllowed, CREDENTIAL_SUPPRESSED_NOTICE } = require('./credential-guard');
const { refreshSecretLatch } = require('./secret-marker');

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
    let messages = state.consoleMessages.get(ps.sessionId) || [];

    if (sinceTime) {
      messages = messages.filter(msg => new Date(msg.timestamp) > sinceTime);
    }

    if (credentialCaptureAllowed()) return messages;

    // Refresh the latch against the page's CURRENT state (a marker could
    // have appeared since the last guarded action ran) before deciding
    // whether to redact — never trust only what was true when each message
    // was originally buffered. A failed check fails closed: redact rather
    // than risk serving a message we couldn't vet.
    let latched;
    try {
      latched = await refreshSecretLatch(state, ps);
    } catch (_err) {
      latched = true;
    }
    if (!latched) return messages;

    return messages.map((msg) => ({ ...msg, text: CREDENTIAL_SUPPRESSED_NOTICE }));
  }

  async function clearConsoleMessages(tabIndexOrWsUrl) {
    const ps = await getPageSession(tabIndexOrWsUrl);
    state.consoleMessages.set(ps.sessionId, []);
  }

  return { enableConsoleLogging, getConsoleMessages, clearConsoleMessages };
}

module.exports = { attachConsoleLogging };
