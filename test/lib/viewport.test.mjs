import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { makePageSessionSpy, makeGetPageSession } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachViewport } = require('../../skills/browsing/lib/viewport.js');

describe('viewport', () => {
  function setup(handlers = {}) {
    const ps = makePageSessionSpy(handlers);
    return { ...attachViewport({ getPageSession: makeGetPageSession(ps) }), ps };
  }

  it('setViewport sends setDeviceMetricsOverride and disables touch in non-mobile mode', async () => {
    const { setViewport, ps } = setup();
    await setViewport(0, { width: 1024, height: 768 });

    const methods = ps.calls.map((c) => c.method);
    assert.deepEqual(methods, [
      'Emulation.setDeviceMetricsOverride',
      'Emulation.setTouchEmulationEnabled',
      'Emulation.setUserAgentOverride',
    ]);
    assert.equal(ps.calls[0].params.width, 1024);
    assert.equal(ps.calls[1].params.enabled, false);
    assert.equal(ps.calls[2].params.userAgent, '');
  });

  it('setViewport sends mobile UA when mobile: true', async () => {
    const { setViewport, ps } = setup();
    await setViewport(0, { width: 375, height: 667, mobile: true });

    assert.equal(ps.calls[1].params.enabled, true);
    assert.match(ps.calls[2].params.userAgent, /Pixel 7/);
  });

  it('setViewport throws on out-of-range width', async () => {
    const { setViewport } = setup();
    await assert.rejects(() => setViewport(0, { width: 100, height: 768 }), /Invalid viewport width/);
  });

  it('clearViewport clears device metrics, touch, and UA', async () => {
    const { clearViewport, ps } = setup();
    await clearViewport(0);
    const methods = ps.calls.map((c) => c.method);
    assert.deepEqual(methods, [
      'Emulation.clearDeviceMetricsOverride',
      'Emulation.setTouchEmulationEnabled',
      'Emulation.setUserAgentOverride',
    ]);
  });

  it('getViewport returns the page eval result', async () => {
    const { getViewport } = setup({
      'Runtime.evaluate': () => ({ result: { value: { innerWidth: 1024, innerHeight: 768 } } }),
    });
    const vp = await getViewport(0);
    assert.equal(vp.innerWidth, 1024);
    assert.equal(vp.innerHeight, 768);
  });
});
