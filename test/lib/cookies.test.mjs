import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { makeCdpSpy, makeResolveWsUrl } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachCookies } = require('../../skills/browsing/lib/cookies.js');

describe('cookies', () => {
  it('clearCookies sends Network.clearBrowserCookies', async () => {
    const sendCdpCommand = makeCdpSpy();
    const resolveWsUrl = makeResolveWsUrl('ws://test/x');
    const { clearCookies } = attachCookies({ resolveWsUrl, sendCdpCommand });

    await clearCookies(0);

    assert.equal(sendCdpCommand.calls.length, 1);
    assert.equal(sendCdpCommand.calls[0].method, 'Network.clearBrowserCookies');
    assert.equal(sendCdpCommand.calls[0].wsUrl, 'ws://test/x');
    assert.deepEqual(sendCdpCommand.calls[0].params, {});
  });
});
