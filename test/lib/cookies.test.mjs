import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makePageSessionFake } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachCookies } = require('../../skills/browsing/lib/cookies.js');

describe('cookies (pageSession-shaped)', () => {
  it('clearCookies resolves the pageSession and sends Network.clearBrowserCookies', async () => {
    const ps = makePageSessionFake();
    const getPageSession = async () => ps;
    const { clearCookies } = attachCookies({ getPageSession });
    await clearCookies(0); // tab index 0
    assert.equal(ps.calls.length, 1);
    assert.equal(ps.calls[0].method, 'Network.clearBrowserCookies');
    assert.deepEqual(ps.calls[0].params, {});
  });

  it('clearCookies forwards the tabIndexOrWsUrl to getPageSession', async () => {
    let receivedTab = null;
    const ps = makePageSessionFake();
    const getPageSession = async (t) => { receivedTab = t; return ps; };
    const { clearCookies } = attachCookies({ getPageSession });
    await clearCookies('ws://localhost:9222/devtools/page/T42');
    assert.equal(receivedTab, 'ws://localhost:9222/devtools/page/T42');
  });
});
