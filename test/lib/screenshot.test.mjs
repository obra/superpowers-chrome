import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { makeCdpSpy, makeResolveWsUrl } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachScreenshot } = require('../../skills/browsing/lib/screenshot.js');

describe('screenshot', () => {
  // Use a 1x1 transparent PNG for the fake screenshot data.
  const FAKE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

  function setup(handlers = {}) {
    const sendCdpCommand = makeCdpSpy({
      'Page.captureScreenshot': () => ({ data: FAKE_PNG_BASE64 }),
      'Runtime.evaluate': () => ({ result: { value: { width: 1024, height: 768 } } }),
      ...handlers
    });
    return { ...attachScreenshot({ resolveWsUrl: makeResolveWsUrl(), sendCdpCommand }), sendCdpCommand };
  }

  function tmpFile() {
    return path.join(os.tmpdir(), `screenshot-test-${Date.now()}-${Math.random()}.png`);
  }

  it('viewport screenshot sends explicit clip from window.innerWidth/Height', async () => {
    const filename = tmpFile();
    const { screenshot, sendCdpCommand } = setup();
    await screenshot(0, filename);

    const screenshotCall = sendCdpCommand.calls.find(c => c.method === 'Page.captureScreenshot');
    assert.deepEqual(screenshotCall.params.clip, { x: 0, y: 0, width: 1024, height: 768, scale: 1 });
    assert.equal(screenshotCall.params.captureBeyondViewport, false);

    fs.unlinkSync(filename);
  });

  it('full-page screenshot uses Page.getLayoutMetrics contentSize', async () => {
    const filename = tmpFile();
    const { screenshot, sendCdpCommand } = setup({
      'Page.getLayoutMetrics': () => ({ contentSize: { width: 1024, height: 5000 } })
    });
    await screenshot(0, filename, null, true);

    const screenshotCall = sendCdpCommand.calls.find(c => c.method === 'Page.captureScreenshot');
    assert.equal(screenshotCall.params.clip.height, 5000);
    assert.equal(screenshotCall.params.captureBeyondViewport, true);

    fs.unlinkSync(filename);
  });

  it('writes the decoded PNG to disk and returns absolute path', async () => {
    const filename = tmpFile();
    const { screenshot } = setup();
    const returned = await screenshot(0, filename);
    assert.ok(path.isAbsolute(returned));
    const written = fs.readFileSync(filename);
    assert.ok(written.length > 0);
    fs.unlinkSync(filename);
  });
});
