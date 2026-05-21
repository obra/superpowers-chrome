import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';

function makePageSessionFake(sessionId = 'fake-session-id') {
  const calls = [];
  const ps = {
    sessionId,
    send: async (method, params) => {
      calls.push({ method, params });
      return { result: { value: 'fake' } };
    },
  };
  ps.calls = calls;
  return ps;
}

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
    const calls = { getPageSession: 0, getHtml: 0, screenshot: 0 };
    const ps = makePageSessionFake();
    const getPageSession = async (_x) => { calls.getPageSession++; return ps; };
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
      state
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

describe('*WithCapture middleware', () => {
  it('clickWithCapture refuses when dialog open and selector is normal', async () => {
    const dialogState = { kind: 'alert', payload: { message: 'm', url: '', defaultPrompt: '', hasBrowserHandler: false }, staged: {} };
    const dialogs = {
      getOpen: () => dialogState,
      withDialogAwarenessForSession: async (action, _ps, args, fn) => {
        if (action === 'click' && !args.selector?.startsWith('dialog::')) {
          return { refused: true, error: 'Page is behind a dialog.', dialog: dialogState, artifacts: { markdown: '# Dialog: alert', html: '', consoleSnapshot: '' } };
        }
        return fn();
      },
    };
    const ps = makePageSessionFake();
    const { clickWithCapture } = attachCapture({
      state: { sessionDir: '/tmp/x-' + Date.now() },
      getPageSession: async () => ps,
      getHtml: async () => '<html></html>',
      screenshot: async () => Buffer.from(''),
      actions: { click: async () => { throw new Error('should not run'); } },
      dialogs,
    });
    const out = await clickWithCapture(0, 'button');
    assert.equal(out.refused, true);
    assert.match(out.artifacts.markdown, /# Dialog: alert/);
  });
});

describe('capturePageArtifacts with open dialog', () => {
  it('returns synthetic markdown when a dialog is open', async () => {
    const dialogState = { kind: 'alert', payload: { message: 'hi', url: 'http://x', defaultPrompt: '', hasBrowserHandler: false }, staged: {} };
    const dialogs = { getOpen: () => dialogState };
    const ps = makePageSessionFake();
    const { capturePageArtifacts } = attachCapture({
      state: { sessionDir: '/tmp/test-' + Date.now() },
      getPageSession: async () => ps,
      getHtml: async () => '<html></html>',
      screenshot: async () => Buffer.from(''),
      actions: {},
      dialogs,
    });
    const out = await capturePageArtifacts(0, 'click');
    assert.match(out.markdown, /# Dialog: alert/);
    assert.equal(out.png, undefined, 'no PNG should be produced for dialogs');
    // No CDP DOM-summary call should have happened.
    assert.ok(!ps.calls.some(c => c.method === 'Runtime.evaluate'));
  });
});
