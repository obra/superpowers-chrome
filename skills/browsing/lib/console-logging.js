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
 */
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
        messages.push({ timestamp, level, text });
        state.consoleMessages.set(ps.sessionId, messages);
      }
    });
  }

  async function getConsoleMessages(tabIndexOrWsUrl, sinceTime = null) {
    const ps = await getPageSession(tabIndexOrWsUrl);
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
