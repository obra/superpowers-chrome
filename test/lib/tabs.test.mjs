import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { attachTabs } = require('../../skills/browsing/lib/tabs.js');

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
