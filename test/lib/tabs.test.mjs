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
