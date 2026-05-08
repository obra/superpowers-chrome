const { chromeHttpAt } = require('./chrome-launcher-helpers');

/**
 * Tab management plus the two transport helpers it depends on:
 *
 *   - `chromeHttp` — the per-session HTTP client, bound to
 *     `state.activePort` and the session's host-override.
 *   - `resolveWsUrl` — accept a tab index, a numeric string, or a `ws://`
 *     URL and return a usable WebSocket URL. Auto-creates a tab if none
 *     exist (mirrors the auto-start-Chrome behaviour). Kept around for
 *     compatibility with callers that still consume per-page WS URLs
 *     (notably the orchestrator's getPageSession resolver, which uses
 *     it to map ws-URL args back to tabs).
 *   - `getTabs` / `newTab` / `closeTab` — list, open, close.
 *
 * Returned tab handles carry a lazy `getPageSession()` thunk that
 * attaches a page session via `Target.attachToTarget({flatten:true})` on
 * first call. Memoized per `targetId`; `closeTab` detaches the cached
 * session.
 *
 * `attachTabs({ state })` returns the bound API plus a `setPageSessionAttacher`
 * setter the orchestrator wires after the bridge is constructed (avoids a
 * circular dependency at construction time — tabs.js is created first, the
 * bridge wants tab handles, the bridge later supplies the attacher).
 */
function attachTabs({ state }) {
  const CHROME_DEBUG_HOST = state.hostOverride.getHost();
  const { rewriteWsUrl } = state;

  // Per-targetId memoized page-session attaches. Keyed by targetId so
  // two getPageSession() calls on the same tab share the same in-flight
  // Promise (and the resolved session afterwards).
  const pageSessionCache = new Map();
  let pageSessionAttacher = null;

  function setPageSessionAttacher(fn) {
    pageSessionAttacher = fn;
  }

  function attachPageSessionLazy(targetId) {
    if (!pageSessionAttacher) {
      throw new Error('tabs.js: pageSessionAttacher not set — orchestrator wiring missing');
    }
    let cached = pageSessionCache.get(targetId);
    if (!cached) {
      cached = pageSessionAttacher(targetId);
      pageSessionCache.set(targetId, cached);
    }
    return cached;
  }

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
        webSocketDebuggerUrl: rewriteWsUrl(tab.webSocketDebuggerUrl, CHROME_DEBUG_HOST, state.activePort),
        getPageSession: () => attachPageSessionLazy(tab.id),
      }));
  }

  async function newTab(url = 'about:blank') {
    const encoded = encodeURIComponent(url);
    const tab = await chromeHttp(`/json/new?${encoded}`, 'PUT');
    if (tab && typeof tab === 'object') {
      tab.webSocketDebuggerUrl = rewriteWsUrl(tab.webSocketDebuggerUrl, CHROME_DEBUG_HOST, state.activePort);
      tab.getPageSession = () => attachPageSessionLazy(tab.id);
    }
    return tab;
  }

  async function closeTab(tabIndexOrWsUrl) {
    const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
    const tabs = await chromeHttp('/json');
    if (!Array.isArray(tabs)) return;
    const tab = tabs.find((t) => {
      if (!t.webSocketDebuggerUrl) return false;
      // Match against both rewritten and raw URLs — host-override may rewrite
      // the URL we got from `/json/list` so we can connect to remote-Chrome.
      const rewritten = rewriteWsUrl(t.webSocketDebuggerUrl, CHROME_DEBUG_HOST, state.activePort);
      return rewritten === wsUrl || t.webSocketDebuggerUrl === wsUrl;
    });
    if (tab) {
      // Detach any cached page session for this tab so the sessionId-keyed
      // state (router pendingRequests, console-message buffer) cleans up
      // promptly.
      const cached = pageSessionCache.get(tab.id);
      if (cached) {
        try {
          const ps = await cached;
          await ps.detach();
        } catch { /* best-effort */ }
        pageSessionCache.delete(tab.id);
      }
      await chromeHttp(`/json/close/${tab.id}`, 'GET');
    }
  }

  return {
    chromeHttp,
    resolveWsUrl,
    getTabs,
    newTab,
    closeTab,
    attachPageSessionLazy,
    setPageSessionAttacher,
  };
}

module.exports = { attachTabs };
