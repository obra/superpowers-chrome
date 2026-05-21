import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makePageSessionFake } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachViewport } = require('../../skills/browsing/lib/viewport.js');

describe('viewport (pageSession-shaped)', () => {
  function setup(handlers = {}) {
    const ps = makePageSessionFake(handlers);
    const getPageSession = async () => ps;
    return { ...attachViewport({ getPageSession }), ps };
  }

  it('setViewport sends setDeviceMetricsOverride and disables touch in non-mobile mode', async () => {
    const { setViewport, ps } = setup();
    await setViewport(0, { width: 1024, height: 768 });

    const methods = ps.calls.map(c => c.method);
    assert.deepEqual(methods, [
      'Emulation.setDeviceMetricsOverride',
      'Emulation.setTouchEmulationEnabled',
      'Emulation.setUserAgentOverride',
    ]);
    assert.equal(ps.calls[0].params.width, 1024);
    assert.equal(ps.calls[0].params.height, 768);
    assert.equal(ps.calls[1].params.enabled, false);
    assert.equal(ps.calls[2].params.userAgent, '');
  });

  it('setViewport sends mobile UA and enables touch when mobile: true', async () => {
    const { setViewport, ps } = setup();
    await setViewport(0, { width: 375, height: 667, mobile: true });

    assert.equal(ps.calls[1].params.enabled, true);
    assert.match(ps.calls[2].params.userAgent, /Pixel 7/);
  });

  it('setViewport applies defaults for missing width, height, deviceScaleFactor', async () => {
    const { setViewport, ps } = setup();
    await setViewport(0, {});

    const dm = ps.calls[0].params;
    assert.equal(dm.width, 1200);
    assert.equal(dm.height, 800);
    assert.equal(dm.deviceScaleFactor, 1);
    assert.equal(dm.mobile, false);
  });

  it('setViewport throws on out-of-range width', async () => {
    const { setViewport } = setup();
    await assert.rejects(() => setViewport(0, { width: 100, height: 768 }), /Invalid viewport width/);
  });

  it('setViewport throws on width above maximum', async () => {
    const { setViewport } = setup();
    await assert.rejects(() => setViewport(0, { width: 9999, height: 768 }), /Invalid viewport width/);
  });

  it('setViewport throws on out-of-range height', async () => {
    const { setViewport } = setup();
    await assert.rejects(() => setViewport(0, { width: 1024, height: 100 }), /Invalid viewport height/);
  });

  it('setViewport throws on out-of-range deviceScaleFactor', async () => {
    const { setViewport } = setup();
    await assert.rejects(
      () => setViewport(0, { width: 1024, height: 768, deviceScaleFactor: 10 }),
      /Invalid deviceScaleFactor/
    );
  });

  it('setViewport throws when params is missing', async () => {
    const { setViewport } = setup();
    await assert.rejects(() => setViewport(0), /setViewport requires a params object/);
  });

  it('setViewport throws when params is not an object', async () => {
    const { setViewport } = setup();
    await assert.rejects(() => setViewport(0, 'bad'), /setViewport requires a params object/);
  });

  it('setViewport returns viewportParams with touch field', async () => {
    const { setViewport } = setup();
    const result = await setViewport(0, { width: 1024, height: 768, mobile: false });
    assert.equal(result.width, 1024);
    assert.equal(result.height, 768);
    assert.equal(result.touch, false);
  });

  it('setViewport forwards tabIndexOrWsUrl to getPageSession', async () => {
    let receivedTab = null;
    const ps = makePageSessionFake();
    const getPageSession = async (t) => { receivedTab = t; return ps; };
    const { setViewport } = attachViewport({ getPageSession });
    await setViewport('ws://localhost:9222/devtools/page/T99', { width: 1024, height: 768 });
    assert.equal(receivedTab, 'ws://localhost:9222/devtools/page/T99');
  });

  it('clearViewport clears device metrics, touch, and UA', async () => {
    const { clearViewport, ps } = setup();
    await clearViewport(0);

    const methods = ps.calls.map(c => c.method);
    assert.deepEqual(methods, [
      'Emulation.clearDeviceMetricsOverride',
      'Emulation.setTouchEmulationEnabled',
      'Emulation.setUserAgentOverride',
    ]);
    assert.equal(ps.calls[1].params.enabled, false);
    assert.equal(ps.calls[2].params.userAgent, '');
  });

  it('clearViewport forwards tabIndexOrWsUrl to getPageSession', async () => {
    let receivedTab = null;
    const ps = makePageSessionFake();
    const getPageSession = async (t) => { receivedTab = t; return ps; };
    const { clearViewport } = attachViewport({ getPageSession });
    await clearViewport('ws://localhost:9222/devtools/page/T77');
    assert.equal(receivedTab, 'ws://localhost:9222/devtools/page/T77');
  });

  it('getViewport issues Runtime.evaluate and returns result value', async () => {
    const { getViewport, ps } = setup({
      'Runtime.evaluate': () => ({ result: { value: { innerWidth: 1024, innerHeight: 768 } } }),
    });
    const vp = await getViewport(0);
    assert.equal(vp.innerWidth, 1024);
    assert.equal(vp.innerHeight, 768);
    assert.equal(ps.calls[0].method, 'Runtime.evaluate');
    assert.equal(ps.calls[0].params.returnByValue, true);
  });

  it('getViewport throws when exceptionDetails is present', async () => {
    const { getViewport } = setup({
      'Runtime.evaluate': () => ({ exceptionDetails: { text: 'SyntaxError' } }),
    });
    await assert.rejects(() => getViewport(0), /getViewport failed/);
  });

  it('getViewport returns empty object when result.value is absent', async () => {
    const { getViewport } = setup({
      'Runtime.evaluate': () => ({ result: {} }),
    });
    const vp = await getViewport(0);
    assert.deepEqual(vp, {});
  });
});
