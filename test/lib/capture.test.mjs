import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { makePageSessionSpy, makeGetPageSession } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachCapture } = require('../../skills/browsing/lib/capture.js');

describe('capture', () => {
  // Use a process-scoped temp dir so we don't touch ~/.cache
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-test-'));
  const origXdg = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = tmpRoot;

  after(() => {
    if (origXdg === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = origXdg;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function setup() {
    const state = { sessionDir: null, captureCounter: 0 };
    const calls = { send: 0, getHtml: 0, screenshot: 0 };
    const ps = makePageSessionSpy();
    // Wrap ps.send to count for cross-check, but real spy still records into ps.calls.
    const origSend = ps.send.bind(ps);
    ps.send = async (method, params, opts) => { calls.send++; return origSend(method, params, opts); };
    const getPageSession = makeGetPageSession(ps);
    const getHtml = async () => { calls.getHtml++; return '<html></html>'; };
    const screenshot = async (_tab, file) => { calls.screenshot++; fs.writeFileSync(file, ''); return file; };
    const actions = {
      click: async () => ({ clicked: true }),
      fill: async () => ({ typed: true }),
      selectOption: async () => ({ success: true }),
      evaluate: async () => 'eval-result',
    };
    return {
      ...attachCapture({ state, getPageSession, getHtml, screenshot, actions }),
      calls,
      state,
      ps,
    };
  }

  it('createCapturePrefix increments and zero-pads', () => {
    const { createCapturePrefix } = setup();
    assert.equal(createCapturePrefix('click'), '001-click');
    assert.equal(createCapturePrefix('type'), '002-type');
  });

  it('initializeSession creates a session dir under XDG_CACHE_HOME', () => {
    const { initializeSession, state } = setup();
    const dir = initializeSession();
    assert.ok(fs.existsSync(dir));
    assert.match(dir, /superpowers\/browser\//);
    state.sessionDir = null; // reset for other tests
  });

  it('clickWithCapture invokes the action then capture, returns merged result', async () => {
    const { clickWithCapture, calls } = setup();
    const result = await clickWithCapture(0, '#button');
    assert.equal(result.action, 'click');
    assert.equal(result.selector, '#button');
    assert.ok(calls.screenshot >= 1, 'screenshot was called');
  });

  it('fillWithCapture passes the value through', async () => {
    const { fillWithCapture } = setup();
    const result = await fillWithCapture(0, '#input', 'hello');
    assert.equal(result.value, 'hello');
  });

  it('selectOptionWithCapture passes the value through', async () => {
    const { selectOptionWithCapture } = setup();
    const result = await selectOptionWithCapture(0, '#select', 'opt1');
    assert.equal(result.value, 'opt1');
  });

  it('evaluateWithCapture returns the eval result and the capture metadata', async () => {
    const { evaluateWithCapture } = setup();
    const result = await evaluateWithCapture(0, '21+21');
    assert.equal(result.result, 'eval-result');
    assert.equal(result.expression, '21+21');
  });
});
