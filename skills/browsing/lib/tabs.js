const { chromeHttpAt } = require('./chrome-launcher-helpers');

/**
 * Tab management plus the two transport helpers it depends on:
 *
 *   - `chromeHttp` — the per-session HTTP client, bound to
 *     `state.activePort` and the session's host-override.
 *   - `resolveWsUrl` — accept a tab index, a numeric string, or a `ws://`
 *     URL and return a usable WebSocket URL. Auto-creates a tab if none
 *     exist (mirrors the auto-start-Chrome behaviour).
 *   - `getTabs` / `newTab` / `closeTab` — list, open, close. List/open
 *     rewrite the returned `webSocketDebuggerUrl` through the session's
 *     host-override so the URL can actually be connected to from the
 *     calling process even when the host-override remaps host/port.
 *
 * All three helpers feed every other attach* in the library, so this
 * module is the foundation the rest sits on.
 *
 * `attachTabs({ state })` returns the bound API. The session state bag
 * carries the host-override (for `getHost` and `rewriteWsUrl`) and the
 * mutable `activePort`, which is everything the transport helpers need.
 */
function attachTabs({ state }) {
  const CHROME_DEBUG_HOST = state.hostOverride.getHost();
  const { rewriteWsUrl } = state;

  // HTTP request to Chrome's DevTools endpoint on the session's active port.
  async function chromeHttp(httpPath, method = 'GET') {
    return chromeHttpAt(CHROME_DEBUG_HOST, state.activePort, httpPath, method);
  }

  async function resolveWsUrl(wsUrlOrIndex) {
    if (typeof wsUrlOrIndex === 'string' && wsUrlOrIndex.startsWith('ws://')) {
      return rewriteWsUrl(wsUrlOrIndex, CHROME_DEBUG_HOST, state.activePort);
    }

    const index = typeof wsUrlOrIndex === 'number' ? wsUrlOrIndex : parseInt(wsUrlOrIndex);
    if (!isNaN(index)) {
      const tabs = await chromeHttp('/json');
      if (!Array.isArray(tabs)) {
        throw new Error('Chrome DevTools returned an invalid response — is Chrome running?');
      }
      const pageTabs = tabs.filter(t => t.type === 'page');

      // Auto-create tab if none exist (matches the auto-start-Chrome behaviour
      // — callers shouldn't have to special-case "fresh Chrome with no tabs").
      if (pageTabs.length === 0) {
        const newTabInfo = await newTab();
        return newTabInfo.webSocketDebuggerUrl;
      }

      if (index < 0 || index >= pageTabs.length) {
        throw new Error(`Tab index ${index} out of range (0-${pageTabs.length - 1})`);
      }
      return pageTabs[index].webSocketDebuggerUrl;
    }

    throw new Error(`Invalid tab specifier: ${wsUrlOrIndex}`);
  }

  async function getTabs() {
    const tabs = await chromeHttp('/json');
    if (!Array.isArray(tabs)) {
      return [];
    }
    return tabs
      .filter(tab => tab.type === 'page')
      .map(tab => ({
        ...tab,
        webSocketDebuggerUrl: rewriteWsUrl(tab.webSocketDebuggerUrl, CHROME_DEBUG_HOST, state.activePort)
      }));
  }

  async function newTab(url = 'about:blank') {
    const encoded = encodeURIComponent(url);
    const tab = await chromeHttp(`/json/new?${encoded}`, 'PUT');
    if (tab && typeof tab === 'object') {
      tab.webSocketDebuggerUrl = rewriteWsUrl(tab.webSocketDebuggerUrl, CHROME_DEBUG_HOST, state.activePort);
    }
    return tab;
  }

  async function closeTab(tabIndexOrWsUrl) {
    const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
    const tabs = await chromeHttp('/json');
    if (!Array.isArray(tabs)) return;
    const tab = tabs.find(t => t.webSocketDebuggerUrl === wsUrl);
    if (tab) {
      await chromeHttp(`/json/close/${tab.id}`, 'GET');
    }
  }

  return { chromeHttp, resolveWsUrl, getTabs, newTab, closeTab };
}

module.exports = { attachTabs };
