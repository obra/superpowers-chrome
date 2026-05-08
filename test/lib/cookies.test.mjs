import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { makePageSessionSpy, makeGetPageSession } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachCookies } = require('../../skills/browsing/lib/cookies.js');

describe('cookies', () => {
  it('clearCookies sends Network.clearBrowserCookies', async () => {
    const ps = makePageSessionSpy();
    const { clearCookies } = attachCookies({ getPageSession: makeGetPageSession(ps) });

    await clearCookies(0);

    assert.equal(ps.calls.length, 1);
    assert.equal(ps.calls[0].method, 'Network.clearBrowserCookies');
    assert.deepEqual(ps.calls[0].params, {});
  });
});
