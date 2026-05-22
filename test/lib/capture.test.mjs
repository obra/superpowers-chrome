import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { makePageSessionFake as makePageSessionFakeWithTargetId } from './_helpers.mjs';

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

describe('captureActionWithDiff with open dialog', () => {
  it('skips BEFORE-capture and runs inner action when a dialog is open', async () => {
    const dialogState = { kind: 'basic-auth', payload: { requestId: 'r1', origin: 'http://x', scheme: 'Basic', realm: '' }, staged: {} };
    const dialogs = { getOpen: (sid) => sid === 'S1' ? dialogState : null };

    let beforeCaptureCalled = false;
    let innerActionCalled = false;

    const ps = { sessionId: 'S1', send: async () => { beforeCaptureCalled = true; return { result: { value: null } }; }, calls: [] };
    const { captureActionWithDiff } = attachCapture({
      state: { sessionDir: '/tmp/cad-test-' + Date.now(), captureCounter: 0 },
      getPageSession: async () => ps,
      getHtml: async () => { beforeCaptureCalled = true; return '<html></html>'; },
      screenshot: async () => { beforeCaptureCalled = true; },
      actions: {},
      dialogs,
    });

    const result = await captureActionWithDiff(0, 'type', async () => {
      innerActionCalled = true;
      return 'inner-result';
    });

    assert.equal(beforeCaptureCalled, false, 'BEFORE-capture should be skipped when dialog is open');
    assert.equal(innerActionCalled, true, 'inner action should still run');
    assert.equal(result.actionResult, 'inner-result');
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

describe('clickWithCapture with dialog::* selector (Bug 2 regression)', () => {
  it('dialog::accept does not call capturePageArtifacts and issues no Runtime.evaluate', async () => {
    // When the user calls click("dialog::accept"), the inner actions.click
    // handles the dialog via tryHandleDialogSelectorForSession.  After that
    // the dialog is gone and the page may be navigating.  The old code called
    // capturePageArtifacts unconditionally, which issued Runtime.evaluate on a
    // mid-navigation page and caused "Page session timeout: Runtime.evaluate".
    //
    // Fix: clickWithCapture detects dialog::* selectors and skips post-action
    // capture entirely.
    let capturePageArtifactsCalled = false;
    const ps = makePageSessionFakeWithTargetId({
      'Page.handleJavaScriptDialog': () => ({}),
    }, { sessionId: 'S-dialog-click', targetId: 'T-dialog-click' });
    const dialogState = { kind: 'confirm', payload: { message: 'ok?', url: '', defaultPrompt: '', hasBrowserHandler: false }, staged: {} };
    const dialogs = {
      getOpen: () => dialogState,
      withDialogAwarenessForSession: async (_action, _ps, _args, fn) => fn(),
    };
    const { clickWithCapture } = attachCapture({
      state: { sessionDir: '/tmp/bug2-' + Date.now() },
      getPageSession: async () => ps,
      getHtml: async () => { capturePageArtifactsCalled = true; return '<html></html>'; },
      screenshot: async () => { capturePageArtifactsCalled = true; },
      actions: {
        // Simulate mouse.click(dialog::accept): handles via dialog router, no Runtime.evaluate.
        click: async (_tab, sel) => {
          if (sel === 'dialog::accept') {
            await ps.send('Page.handleJavaScriptDialog', { accept: true });
            return { ok: true };
          }
          throw new Error('unexpected selector: ' + sel);
        },
      },
      dialogs,
    });

    const result = await clickWithCapture(0, 'dialog::accept');
    assert.equal(result.dialogHandled, true, 'result should flag dialogHandled');
    assert.ok(!capturePageArtifactsCalled, 'capturePageArtifacts must NOT be called after dialog::accept');
    // Only Page.handleJavaScriptDialog should have been sent — no Runtime.evaluate.
    const evalCalls = ps.calls.filter(c => c.method === 'Runtime.evaluate');
    assert.equal(evalCalls.length, 0, 'no Runtime.evaluate for dialog::accept click');
  });
});

describe('captureActionWithDiff session pinning (Bug 3 regression)', () => {
  it('AFTER-capture targets the same pageSession as at action start, not re-resolved index 0', async () => {
    // When a click opens a popup, Chrome may reorder tabs so tab[0] becomes
    // the popup.  captureActionWithDiff must NOT re-resolve "tab 0" after the
    // action — it must capture the original tab (the one that was active).
    //
    // Fix: pinnedTab = { id: ps.targetId } is computed once before the action
    // and passed to all AFTER-capture calls.
    let afterCaptureTabId = null;
    const originalPs = makePageSessionFakeWithTargetId({
      'Runtime.evaluate': (params) => {
        const expr = params && params.expression ? params.expression : '';
        if (expr.includes('window.innerWidth')) {
          return { result: { value: { width: 800, height: 600, documentWidth: 800, documentHeight: 2000 } } };
        }
        // generateMarkdown returns a string; generateDomSummary returns an object.
        // Both are long scripts — return compatible stub values.
        if (expr.length > 200) {
          return { result: { value: '# stub-page' } };
        }
        return { result: { value: null } };
      },
    }, { sessionId: 'S-original', targetId: 'T-original' });

    // getPageSession: first call returns originalPs (pre-action, resolving by index).
    // Subsequent calls (post-action) must receive { id: 'T-original' } (pinned).
    let callCount = 0;
    const getPageSession = async (tabSpec) => {
      callCount++;
      if (callCount === 1) {
        // First call: resolve by index (action start) — return original tab
        return originalPs;
      }
      // Post-action calls should use the pinned { id: ps.targetId } handle.
      afterCaptureTabId = tabSpec && tabSpec.id ? tabSpec.id : null;
      return originalPs; // still return original for the test to complete
    };

    const bug3Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug3-'));
    const { captureActionWithDiff } = attachCapture({
      state: { sessionDir: bug3Dir, captureCounter: 0 },
      getPageSession,
      getHtml: async () => '<html></html>',
      screenshot: async (_tab, file) => { fs.writeFileSync(file, ''); },
      actions: {},
    });

    await captureActionWithDiff(0, 'click', async () => 'action-done', 0);

    assert.equal(afterCaptureTabId, 'T-original',
      'AFTER-capture must use the pinned targetId, not re-resolve by numeric index');
  });
});

describe('captureActionWithDiff restoreFocus uses preventScroll (Bug 4 regression)', () => {
  it('restoreFocus calls el.focus({ preventScroll: true }) so scroll position is preserved', async () => {
    // When BEFORE-capture saves focus and then restores it after the screenshot,
    // the old code called el.focus() without preventScroll:true.  On Chrome,
    // focus() scrolls the element into view, undoing any explicit scroll() the
    // user performed.  The fix: el.focus({ preventScroll: true }).
    const evalExpressions = [];
    const ps = makePageSessionFakeWithTargetId({
      'Runtime.evaluate': (params) => {
        evalExpressions.push(params.expression);
        // saveFocus: return a focused element with an id
        if (params.expression && params.expression.includes('document.activeElement')) {
          return { result: { value: { type: 'id', value: 'my-input' } } };
        }
        return { result: { value: null } };
      },
    }, { sessionId: 'S-scroll', targetId: 'T-scroll' });

    const bug4Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug4-'));
    const { captureActionWithDiff } = attachCapture({
      state: { sessionDir: bug4Dir, captureCounter: 0 },
      getPageSession: async () => ps,
      getHtml: async () => '<html></html>',
      screenshot: async (_tab, file) => { fs.writeFileSync(file, ''); },
      actions: {},
    });

    await captureActionWithDiff(0, 'scroll', async () => 'scroll-done', 0);

    // Find the restoreFocus expression.
    const restoreExpr = evalExpressions.find(e => e && e.includes('el.focus'));
    assert.ok(restoreExpr, 'restoreFocus Runtime.evaluate must have been sent');
    assert.match(restoreExpr, /preventScroll.*true|preventScroll:.*true/,
      'restoreFocus must call el.focus({ preventScroll: true }) to avoid scroll reset');
  });
});
