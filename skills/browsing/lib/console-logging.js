/**
 * Page console-message capture.
 *
 * `enableConsoleLogging` enables Runtime on the page session and registers a
 * page-session event listener for `Runtime.consoleAPICalled`, streaming
 * console output into `state.consoleMessages` keyed by `ps.sessionId`.
 * `getConsoleMessages` reads them out — optionally filtered by timestamp —
 * and `clearConsoleMessages` resets the buffer for a tab.
 *
 * `enableDomain('Runtime')` is idempotent so navigation's auto-capture
 * and `enableConsoleLogging` can coexist on the same page session without
 * stomping on each other.
 *
 * Keying: `state.consoleMessages` is keyed by `ps.sessionId`. The public
 * adapter API (`getConsoleMessages(arg, sinceTimestamp)`,
 * `clearConsoleMessages(arg)`) accepts tabIndex / wsUrl / pageSession —
 * all resolve through `getPageSession` to `ps.sessionId`.
 */
function attachConsoleLogging({ state, getPageSession }) {
  async function enableConsoleLogging(tabIndexOrPageSession) {
    const ps = await getPageSession(tabIndexOrPageSession);

    if (!state.consoleMessages.has(ps.sessionId)) {
      state.consoleMessages.set(ps.sessionId, []);
    }

    await ps.enableDomain('Runtime'); // idempotent

    const unsub = ps.onEvent((data) => {
      if (data.method !== 'Runtime.consoleAPICalled') return;
      const entry = data.params || {};
      const timestamp = new Date().toISOString();
      const level = entry.type || 'log';
      const args = entry.args || [];

      const text = args.map((arg) => {
        if (arg.type === 'string') return arg.value;
        if (arg.type === 'number') return String(arg.value);
        if (arg.type === 'boolean') return String(arg.value);
        if (arg.type === 'object') return arg.description || '[Object]';
        return String(arg.value || arg.description || arg.type);
      }).join(' ');

      const messages = state.consoleMessages.get(ps.sessionId) || [];
      messages.push({ timestamp, level, text });
      state.consoleMessages.set(ps.sessionId, messages);
    });

    // The page session detach handles event-listener cleanup via router
    // unregisterSession; close() here just unsubscribes this specific
    // listener so a caller that wants to stop capturing without detaching
    // the whole page session can do so.
    return {
      close: () => {
        try { unsub(); } catch { /* best-effort */ }
      },
    };
  }

  async function getConsoleMessages(tabIndexOrPageSession, sinceTime = null) {
    const ps = await getPageSession(tabIndexOrPageSession);
    const messages = state.consoleMessages.get(ps.sessionId) || [];

    if (!sinceTime) {
      return messages;
    }
    return messages.filter((msg) => new Date(msg.timestamp) > sinceTime);
  }

  async function clearConsoleMessages(tabIndexOrPageSession) {
    const ps = await getPageSession(tabIndexOrPageSession);
    state.consoleMessages.set(ps.sessionId, []);
  }

  return { enableConsoleLogging, getConsoleMessages, clearConsoleMessages };
}

module.exports = { attachConsoleLogging };
