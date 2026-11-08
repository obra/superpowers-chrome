// PRI-3710: Target.setAutoAttach's `waitForDebuggerOnStart` pause is
// target-scoped, not session-scoped (confirmed against real Chrome).
// browser-bridge.js's auto-attach handler used to call
// `Runtime.runIfWaitingForDebugger` on every newly-attached page target
// unconditionally, right after its own onPageSession hook. Nothing made it
// defer to an independent client (sen-core's credential-injection arm,
// attached to the SAME browser-wide endpoint) that also resumes targets
// after marking them with its own `data-sen-secret` DOM marker. Because the
// pause is target-scoped, THIS module's resume call alone unblocks the
// target globally — including for that other client's popup — regardless
// of whether the other client has finished marking it yet.
//
// The fix is structural, not timing-based: when a host sets
// SUPERPOWERS_CHROME_EXTERNAL_RESUMER=1 (see lib/resume-gate.js), it is
// declaring itself the one and only resumer for every auto-attached
// target, and this module must never call Runtime.runIfWaitingForDebugger
// on one itself — not "wait a bit first", stay out of it entirely, for as
// long as the signal is set. With no such host configured, this module's
// behavior is unchanged from before PRI-3710.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeBrowserSessionFake } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachBrowserBridge } = require('../../skills/browsing/lib/browser-bridge.js');

const ENV_VAR = 'SUPERPOWERS_CHROME_EXTERNAL_RESUMER';

async function setUpAttachedPopup() {
  const browser = makeBrowserSessionFake();
  browser.setResolver('Target.setDiscoverTargets', () => ({}));
  browser.setResolver('Target.setAutoAttach', () => ({}));

  await attachBrowserBridge({
    browser, host: 'localhost', port: 9222, rewriteWsUrl: (u) => u,
    autoAttach: true,
    onPageSession: async () => {},
  });

  browser.sendCalls.length = 0;
  browser.sentRaw.length = 0;

  // Auto-respond to Runtime.runIfWaitingForDebugger over the raw-sendRaw
  // path, same as the existing "resumes via Runtime.runIfWaitingForDebugger"
  // test, so a resume this module DOES issue resolves cleanly.
  const origSendRaw = browser.sendRaw.bind(browser);
  browser.sendRaw = (json) => {
    origSendRaw(json);
    const parsed = JSON.parse(json);
    if (parsed.method === 'Runtime.runIfWaitingForDebugger') {
      setImmediate(() => browser.inject({ sessionId: parsed.sessionId, id: parsed.id, result: {} }));
    }
  };

  browser.inject({
    method: 'Target.attachedToTarget',
    params: {
      sessionId: 'S-popup',
      targetInfo: { targetId: 'T-popup', type: 'page' },
      waitingForDebugger: true,
    },
  });

  return browser;
}

function resumeCalls(browser) {
  return browser.sentRaw.map(JSON.parse).filter((m) => m.method === 'Runtime.runIfWaitingForDebugger');
}

describe('PRI-3710: popup auto-attach resume, external-resumer opt-out', () => {
  let originalValue;

  beforeEach(() => {
    originalValue = process.env[ENV_VAR];
  });

  afterEach(() => {
    if (originalValue === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = originalValue;
  });

  it('with no external resumer configured, resumes the popup itself — same as main', async () => {
    delete process.env[ENV_VAR];
    const browser = await setUpAttachedPopup();

    // Give the bridge's own resume a moment to fire.
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(
      resumeCalls(browser).length,
      1,
      'with no external resumer configured, browser-bridge must resume the ' +
      'popup itself exactly once, matching main\'s unconditional resume',
    );
  });

  it('with an external resumer configured, never resumes the popup itself', async () => {
    process.env[ENV_VAR] = '1';
    const browser = await setUpAttachedPopup();

    // Wait well past any timing window a heuristic gate might have used —
    // this is not "wait longer than the other resumer", it's "never resume
    // at all, structurally, for as long as the signal is set".
    await new Promise((r) => setTimeout(r, 400));

    assert.equal(
      resumeCalls(browser).length,
      0,
      'browser-bridge resumed the popup itself even though an external ' +
      'resumer was configured (SUPERPOWERS_CHROME_EXTERNAL_RESUMER=1) — ' +
      'there must be exactly one resumer (PRI-3710)',
    );
  });
});
