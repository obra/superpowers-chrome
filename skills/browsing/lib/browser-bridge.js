'use strict';

const { createCdpRouter } = require('./cdp-router');
const { attachPageSession, buildPageSessionFromAttached } = require('./page-session');

/**
 * attachBrowserBridge({browser, host, port, rewriteWsUrl}) — consumer-facing
 * bridge over the browser-session.
 *
 * Exposes:
 *   targets.list()                 — synchronous snapshot of current targets
 *   targets.onCreated(handler)     — register listener; returns unsub fn
 *   targets.onDestroyed(handler)
 *   targets.waitForNew(predicate, {timeoutMs})
 *   createBrowserContext({proxyServer?}) -> {browserContextId, createPage, dispose}
 *   attachPageSession(targetId)    — page session over the browser-WS via flatten mode
 *
 * host/port/rewriteWsUrl are needed by createBrowserContext.createPage to construct
 * per-page WS URLs for callers that still want one (the bridge itself never uses
 * them — page sessions ride the browser-WS).
 */
async function attachBrowserBridge({ browser, host, port, rewriteWsUrl, autoAttach = false, onPageSession = null }) {
  // The cdp-router sits between browser-session and bridge consumers.
  // Page-session-tagged messages dispatch to the right session; root-session
  // events (Target.*, etc.) fire root listeners. Command responses without
  // sessionId stay correlated by browser-session.js's pendingRequests
  // (single source of truth for root-session correlation).
  const router = createCdpRouter({ browser });

  const targetMap = new Map();      // targetId -> targetInfo
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

  // Handle auto-attached targets (popups, child frames, etc.) when autoAttach is on.
  // Chrome emits this with an already-allocated sessionId — no Target.attachToTarget needed.
  //
  // Only act on targets that are paused (waitingForDebugger: true). Existing tabs
  // that Chrome retrospectively reports via attachedToTarget (waitingForDebugger: false)
  // are not paused and will be set up through the normal getPageSession/attachPageSession
  // path. Installing a page session here for those targets would register the same
  // sessionId twice in the cdp-router, causing duplicate-id protocol errors.
  router.getRootListeners().add(async (msg) => {
    if (msg.method !== 'Target.attachedToTarget') return;
    const { sessionId, targetInfo, waitingForDebugger } = msg.params;

    if (!waitingForDebugger) return;

    const ps = buildPageSessionFromAttached({ browser, router, sessionId, targetId: targetInfo.targetId });

    // Only run the onPageSession hook for page-type targets. Non-page targets
    // (service_worker, background_page, etc.) don't support the Page CDP domain
    // and would cause 'Page.enable' wasn't found errors in the hook.
    if (onPageSession && targetInfo.type === 'page') {
      try { await onPageSession(ps); }
      catch (e) { console.error('onPageSession hook threw:', e); }
    }

    // Resume the paused target AFTER the hook so any shims (e.g. dialog) are
    // installed before the page's scripts run.
    try { await ps.send('Runtime.runIfWaitingForDebugger', {}); }
    catch (e) { console.error('Runtime.runIfWaitingForDebugger failed:', e); }
  });

  // Subscribe — replays existing targets as targetCreated events.
  await browser.send('Target.setDiscoverTargets', { discover: true });

  if (autoAttach) {
    await browser.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
  }

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
      const { targetId } = await browser.send('Target.createTarget', { url, browserContextId });
      const rawWsUrl = `ws://${host}:${port}/devtools/page/${targetId}`;
      return {
        id: targetId, targetId,
        webSocketDebuggerUrl: rewriteWsUrl(rawWsUrl, host, port),
        type: 'page', url, browserContextId,
      };
    }

    async function dispose() {
      if (disposed) return;
      disposed = true;
      try { await browser.send('Target.disposeBrowserContext', { browserContextId }); }
      catch (e) { console.warn('BrowserContext.dispose() failed:', e && e.message); }
    }

    return { browserContextId, createPage, dispose };
  }

  async function attachPage(targetId) {
    return attachPageSession({ browser, router }, targetId);
  }

  return {
    targets: { list, onCreated, onDestroyed, waitForNew },
    createBrowserContext,
    attachPageSession: attachPage,
    router,
  };
}

module.exports = { attachBrowserBridge };
