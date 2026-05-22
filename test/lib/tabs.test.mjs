import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { attachTabs, createPageSessionResolver } = require('../../skills/browsing/lib/tabs.js');

describe('tabs', () => {
  function fakeHostOverride() {
    return {
      getHost: () => '127.0.0.1',
      getPort: () => 9222,
      rewriteWsUrl: (url) => url, // identity for the no-override case
    };
  }

  it('exports the expected method set', () => {
    const state = {
      hostOverride: fakeHostOverride(),
      rewriteWsUrl: (url) => url,
      activePort: 9222,
    };
    const tabs = attachTabs({ state });
    assert.equal(typeof tabs.chromeHttp, 'function');
    assert.equal(typeof tabs.resolveWsUrl, 'function');
    assert.equal(typeof tabs.getTabs, 'function');
    assert.equal(typeof tabs.newTab, 'function');
    assert.equal(typeof tabs.closeTab, 'function');
  });

  it('resolveWsUrl with a ws:// string returns the rewritten URL', async () => {
    const state = {
      hostOverride: fakeHostOverride(),
      rewriteWsUrl: (url, host, port) => url.replace(/127\.0\.0\.1:9222/, `${host}:${port}`),
      activePort: 9999,
    };
    const { resolveWsUrl } = attachTabs({ state });
    const result = await resolveWsUrl('ws://127.0.0.1:9222/devtools/page/abc');
    assert.equal(result, 'ws://127.0.0.1:9999/devtools/page/abc');
  });

  it('resolveWsUrl with non-string-non-number throws', async () => {
    const state = { hostOverride: fakeHostOverride(), rewriteWsUrl: (u) => u, activePort: 9222 };
    const { resolveWsUrl } = attachTabs({ state });
    await assert.rejects(() => resolveWsUrl({}), /Invalid tab specifier/);
  });
});

describe('createPageSessionResolver', () => {
  it('caches per tab.id and returns the same pageSession on repeated calls', async () => {
    let attached = 0;
    const bridge = {
      attachPageSession: async (targetId) => {
        attached++;
        return { targetId, sessionId: 'S-' + targetId, detach: async () => {} };
      },
    };
    const resolve = createPageSessionResolver({ bridge });
    const ps1 = await resolve({ id: 'T1' });
    const ps2 = await resolve({ id: 'T1' });
    assert.equal(ps1, ps2);
    assert.equal(attached, 1);
  });

  it('release(tabId) detaches the cached session and removes the cache entry', async () => {
    const detachCalls = [];
    const bridge = {
      attachPageSession: async (targetId) => ({
        targetId, sessionId: 'S-' + targetId,
        detach: async () => { detachCalls.push(targetId); },
      }),
    };
    const resolve = createPageSessionResolver({ bridge });
    await resolve({ id: 'T1' });
    await resolve.release('T1');
    assert.deepEqual(detachCalls, ['T1']);
    // After release, the next resolve for T1 attaches fresh
    let attachedAfter = false;
    bridge.attachPageSession = async (targetId) => {
      attachedAfter = true;
      return { targetId, sessionId: 'S2-' + targetId, detach: async () => {} };
    };
    await resolve({ id: 'T1' });
    assert.equal(attachedAfter, true);
  });

  it('release on a tab that was never resolved is a no-op (no throw)', async () => {
    const bridge = { attachPageSession: async () => { throw new Error('should not be called'); } };
    const resolve = createPageSessionResolver({ bridge });
    await assert.doesNotReject(() => resolve.release('T-nonexistent'));
  });

  it('throws if tab has no id', async () => {
    const bridge = { attachPageSession: async () => { throw new Error('should not be called'); } };
    const resolve = createPageSessionResolver({ bridge });
    await assert.rejects(() => resolve({}), /tab\.id/);
    await assert.rejects(() => resolve(null), /tab\.id/);
  });
});

describe('createPageSessionResolver: prime() for autoAttach', () => {
  it('prime(targetId, ps) registers an externally-attached pageSession; subsequent resolve returns it without calling bridge.attachPageSession', async () => {
    let attachCallCount = 0;
    const bridge = {
      attachPageSession: async (targetId) => {
        attachCallCount++;
        return { targetId, sessionId: 'attach-' + targetId, detach: async () => {} };
      },
    };
    const externalPs = { targetId: 'T1', sessionId: 'auto-S1', detach: async () => {} };
    const resolver = createPageSessionResolver({ bridge });

    // Prime with the autoAttach session
    resolver.prime('T1', externalPs);

    // resolve should return the primed session, no attach call
    const ps = await resolver({ id: 'T1' });
    assert.equal(ps, externalPs);
    assert.equal(attachCallCount, 0);
  });

  it('prime() is a no-op if the targetId is already cached', async () => {
    const bridge = {
      attachPageSession: async (targetId) => ({ targetId, sessionId: 'first-' + targetId, detach: async () => {} }),
    };
    const resolver = createPageSessionResolver({ bridge });

    const first = await resolver({ id: 'T1' });
    const externalPs = { targetId: 'T1', sessionId: 'late-prime', detach: async () => {} };
    resolver.prime('T1', externalPs);

    const second = await resolver({ id: 'T1' });
    assert.equal(second, first); // first wins, prime didn't overwrite
  });
});

describe('createPageSessionResolver: releaseAll()', () => {
  it('releaseAll() clears the cache so subsequent resolve calls re-attach', async () => {
    let attachCount = 0;
    const bridge = {
      attachPageSession: async (targetId) => {
        attachCount++;
        return { targetId, sessionId: 'S-' + targetId, detach: async () => {} };
      },
    };
    const resolver = createPageSessionResolver({ bridge });

    // Prime cache with two tabs
    await resolver({ id: 'T1' });
    await resolver({ id: 'T2' });
    assert.equal(attachCount, 2);

    // releaseAll should clear cache without calling detach
    resolver.releaseAll();

    // After releaseAll, re-resolving should cause a new attach
    await resolver({ id: 'T1' });
    assert.equal(attachCount, 3, 'attach was called again after releaseAll');
  });

  it('releaseAll() does not call detach on cached sessions', async () => {
    let detachCount = 0;
    const bridge = {
      attachPageSession: async (targetId) => ({
        targetId,
        sessionId: 'S-' + targetId,
        detach: async () => { detachCount++; },
      }),
    };
    const resolver = createPageSessionResolver({ bridge });
    await resolver({ id: 'T1' });

    resolver.releaseAll();

    assert.equal(detachCount, 0, 'releaseAll does not call detach (WS is dead)');
  });
});

describe('newTab URL support', () => {
  function fakeHostOverride() {
    return {
      getHost: () => '127.0.0.1',
      getPort: () => 9222,
      rewriteWsUrl: (url) => url,
    };
  }

  it('newTab() with no URL creates a tab at about:blank', async () => {
    const requests = [];
    const fakeChromeHttp = async (path, method) => {
      requests.push({ path, method });
      return { id: 'T-blank', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/T-blank' };
    };
    const state = {
      hostOverride: fakeHostOverride(),
      rewriteWsUrl: (url) => url,
      activePort: 9222,
    };
    const { newTab } = attachTabs({ state, _chromeHttp: fakeChromeHttp });
    await newTab();
    assert.equal(requests.length, 1);
    assert.ok(requests[0].path.includes(encodeURIComponent('about:blank')),
      'should include encoded about:blank in path');
  });

  it('newTab(url) passes the URL to /json/new', async () => {
    const requests = [];
    const fakeChromeHttp = async (path, method) => {
      requests.push({ path, method });
      return { id: 'T-url', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/T-url' };
    };
    const state = {
      hostOverride: fakeHostOverride(),
      rewriteWsUrl: (url) => url,
      activePort: 9222,
    };
    const { newTab } = attachTabs({ state, _chromeHttp: fakeChromeHttp });
    const url = 'https://example.com/page';
    await newTab(url);
    assert.equal(requests.length, 1);
    assert.ok(requests[0].path.includes(encodeURIComponent(url)),
      `expected path to contain encoded URL, got: ${requests[0].path}`);
  });
});

describe('closeTab releases page-session before /json/close', () => {
  it('calls resolver.release(tabId) before chromeHttp(/json/close/...)', async () => {
    const events = [];

    // A bridge that produces a detachable pageSession for T1
    const fakeBridge = {
      attachPageSession: async (targetId) => ({
        targetId,
        sessionId: 'S1',
        detach: async () => { events.push('detach'); },
      }),
    };

    const resolver = createPageSessionResolver({ bridge: fakeBridge });
    // Prime the cache so release has something to detach
    await resolver({ id: 'T1' });

    // The tab list returned by /json — webSocketDebuggerUrl must match what
    // closeTab resolves for the ws:// URL we'll pass directly.
    const WS_URL = 'ws://127.0.0.1:9222/devtools/page/T1';
    const fakeChromeHttp = async (path) => {
      if (path === '/json') return [{ id: 'T1', type: 'page', webSocketDebuggerUrl: WS_URL }];
      events.push('http:' + path);
      return {};
    };

    const state = {
      hostOverride: { getHost: () => '127.0.0.1', getPort: () => 9222 },
      rewriteWsUrl: (url) => url,
      activePort: 9222,
      pageSessionResolver: resolver,
    };

    const { closeTab } = attachTabs({ state, _chromeHttp: fakeChromeHttp });
    await closeTab(WS_URL);

    assert.deepEqual(events, ['detach', 'http:/json/close/T1']);
  });

  it('closeTab works without a pageSessionResolver (resolver not yet initialised)', async () => {
    const events = [];
    const WS_URL = 'ws://127.0.0.1:9222/devtools/page/T2';
    const fakeChromeHttp = async (path) => {
      if (path === '/json') return [{ id: 'T2', type: 'page', webSocketDebuggerUrl: WS_URL }];
      events.push('http:' + path);
      return {};
    };

    const state = {
      hostOverride: { getHost: () => '127.0.0.1', getPort: () => 9222 },
      rewriteWsUrl: (url) => url,
      activePort: 9222,
      // pageSessionResolver intentionally absent
    };

    const { closeTab } = attachTabs({ state, _chromeHttp: fakeChromeHttp });
    await assert.doesNotReject(() => closeTab(WS_URL));
    assert.deepEqual(events, ['http:/json/close/T2']);
  });
});
