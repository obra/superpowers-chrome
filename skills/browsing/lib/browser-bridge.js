// Target.* events + BrowserContext create/dispose, plus the
// cdp-router and page-session attach point — all the browser-WS bridge's
// consumer-facing surface in one module.

const { createCdpRouter } = require('./cdp-router');
const { attachPageSession } = require('./page-session');

/**
 * attachBrowserBridge({browser, host, port, rewriteWsUrl}) — attaches
 * Target.setDiscoverTargets to the browser session, tracks the live target
 * set, and exposes:
 *   - targets.list()                 — synchronous snapshot
 *   - targets.onCreated(handler)     — register listener; returns unsub fn
 *   - targets.onDestroyed(handler)
 *   - targets.waitForNew(predicate, {timeoutMs})
 *   - createBrowserContext({proxyServer?})
 *   - attachPageSession(targetId)    — page session over the browser-WS
 *
 * host/port/rewriteWsUrl are needed by createBrowserContext.createPage to
 * construct per-page WS URLs for callers that still want one (the bridge
 * itself never uses them — page sessions ride the browser-WS).
 */
async function attachBrowserBridge({ browser, host, port, rewriteWsUrl }) {
  const ctxHost = host;
  const ctxPort = port;
  const ctxRewriteWsUrl = rewriteWsUrl;

  // The cdp-router sits between browser-session and bridge consumers.
  // Page-session-tagged messages dispatch to the right session; root-session
  // events (Target.*, etc.) fire root listeners. Command responses without
  // sessionId stay correlated by browser-session.js's pendingRequests
  // (single source of truth for root-session correlation).
  const router = createCdpRouter({ browser });

  const targetMap = new Map();    // targetId -> targetInfo
  const onCreatedFns = new Set();
  const onDestroyedFns = new Set();

  router.getRootListeners().add((msg) => {
    if (msg.method === 'Target.targetCreated') {
      const t = msg.params.targetInfo;
      targetMap.set(t.targetId, t);
      for (const fn of onCreatedFns) {
        try { fn(t); } catch (e) { console.error('targets onCreated handler threw:', e); }
      }
    } else if (msg.method === 'Target.targetInfoChanged') {
      const t = msg.params.targetInfo;
      targetMap.set(t.targetId, t);
    } else if (msg.method === 'Target.targetDestroyed') {
      const t = targetMap.get(msg.params.targetId);
      targetMap.delete(msg.params.targetId);
      if (t) {
        for (const fn of onDestroyedFns) {
          try { fn(t); } catch (e) { console.error('targets onDestroyed handler threw:', e); }
        }
      }
    }
  });

  // Subscribe — replays existing targets as targetCreated events.
  await browser.send('Target.setDiscoverTargets', { discover: true });

  function list() { return Array.from(targetMap.values()); }
  function onCreated(fn) { onCreatedFns.add(fn); return () => onCreatedFns.delete(fn); }
  function onDestroyed(fn) { onDestroyedFns.add(fn); return () => onDestroyedFns.delete(fn); }

  function waitForNew(predicate, { timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      let unsub = null;
      const timeout = setTimeout(() => {
        if (unsub) unsub();
        reject(new Error(`waitForNew: timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      unsub = onCreated((t) => {
        let match;
        try { match = predicate(t); }
        catch (e) {
          clearTimeout(timeout);
          if (unsub) unsub();
          reject(e);
          return;
        }
        if (match) {
          clearTimeout(timeout);
          if (unsub) unsub();
          resolve(t);
        }
      });
    });
  }

  /**
   * createBrowserContext({proxyServer?}) — creates a Chrome BrowserContext.
   * Returns {browserContextId, createPage, dispose}.
   *
   * createPage(url) calls Target.createTarget({url, browserContextId}) and
   * constructs a tab-shape-compatible page handle whose webSocketDebuggerUrl
   * is run through rewriteWsUrl.
   *
   * dispose() is atomic — Chrome tears down cookies/storage/IDB/SW for the
   * context in one call.
   */
  async function createBrowserContext(opts = {}) {
    const params = {};
    if (opts.proxyServer) params.proxyServer = opts.proxyServer;
    const { browserContextId } = await browser.send('Target.createBrowserContext', params);

    let disposed = false;

    async function createPage(url = 'about:blank') {
      if (disposed) throw new Error('BrowserContext disposed');
      const { targetId } = await browser.send('Target.createTarget', {
        url,
        browserContextId,
      });
      // Construct the per-page WS URL — same shape Chrome's /json/list returns.
      const rawWsUrl = `ws://${ctxHost}:${ctxPort}/devtools/page/${targetId}`;
      const webSocketDebuggerUrl = ctxRewriteWsUrl(rawWsUrl, ctxHost, ctxPort);
      return {
        id: targetId,
        targetId,
        webSocketDebuggerUrl,
        type: 'page',
        url,
        browserContextId,
      };
    }

    async function dispose() {
      if (disposed) return;
      disposed = true;
      try {
        await browser.send('Target.disposeBrowserContext', { browserContextId });
      } catch (e) {
        // best-effort: log but don't throw — dispose is meant to be safe.
        console.warn('BrowserContext.dispose() failed:', e && e.message);
      }
    }

    return { browserContextId, createPage, dispose };
  }

  /**
   * Attach a CDP page session to an existing target. Returns a pageSession
   * with `{sessionId, targetId, send, onEvent, waitForEvent, enableDomain, detach}`.
   *
   * The page session rides the browser-WS via `Target.attachToTarget({flatten:true})`.
   * No new WebSocket per page; no per-page WS death race.
   */
  async function attachPage(targetId) {
    return attachPageSession({ browser, router }, targetId);
  }

  return {
    targets: { list, onCreated, onDestroyed, waitForNew },
    createBrowserContext,
    attachPageSession: attachPage,
    // Exposed for tests + advanced callers; not part of the public session API.
    router,
  };
}

module.exports = { attachBrowserBridge };
