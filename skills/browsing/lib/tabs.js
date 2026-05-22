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
function attachTabs({ state, _chromeHttp }) {
  const CHROME_DEBUG_HOST = state.hostOverride.getHost();
  const { rewriteWsUrl } = state;

  // HTTP request to Chrome's DevTools endpoint on the session's active port.
  // _chromeHttp may be injected for testing; state.chromeHttp is also accepted.
  async function chromeHttp(httpPath, method = 'GET') {
    if (_chromeHttp) return _chromeHttp(httpPath, method);
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
      // Release the cached page-session before Chrome tears down the target.
      await state.pageSessionResolver?.release(tab.id);
      await chromeHttp(`/json/close/${tab.id}`, 'GET');
    }
  }

  return { chromeHttp, resolveWsUrl, getTabs, newTab, closeTab };
}

/**
 * createPageSessionResolver({bridge}) — returns a resolver that caches one
 * pageSession per tab.id. The cache is keyed by tab.id (which is the CDP
 * targetId in our model).
 *
 * Usage:
 *   const getPageSession = createPageSessionResolver({ bridge });
 *   const ps = await getPageSession(tab);     // attaches once
 *   await getPageSession(tab);                 // returns the cached session
 *   await getPageSession.release(tab.id);      // detaches + removes cache
 */
function createPageSessionResolver({ bridge }) {
  const cache = new Map();
  async function resolve(tab) {
    if (!tab || !tab.id) throw new Error('createPageSessionResolver: tab.id is required');
    const cached = cache.get(tab.id);
    if (cached) return cached;
    const ps = await bridge.attachPageSession(tab.id);
    cache.set(tab.id, ps);
    return ps;
  }
  resolve.release = async (tabId) => {
    const ps = cache.get(tabId);
    if (!ps) return;
    cache.delete(tabId);
    try { await ps.detach(); } catch { /* best-effort */ }
  };
  // Prime the cache with an already-attached pageSession (from autoAttach).
  // Subsequent resolve(tab) calls for this targetId return the primed session
  // instead of issuing a second Target.attachToTarget. No-op if already cached.
  resolve.prime = (targetId, ps) => {
    if (!cache.has(targetId)) cache.set(targetId, ps);
  };
  // Synchronous cache peek — returns the cached pageSession for a targetId, or
  // null if not yet resolved. Used by wrapWithDialogGate to check dialog state
  // without triggering I/O.
  resolve.peek = (tabId) => cache.get(tabId) || null;
  // Bulk-clear the cache without calling detach. Use when the underlying WebSocket
  // is already dead (e.g. Chrome was killed externally) so detach calls would fail.
  // Callers that want graceful detach should call resolve.release() per-tab first.
  resolve.releaseAll = () => { cache.clear(); };
  return resolve;
}

module.exports = { attachTabs, createPageSessionResolver };
