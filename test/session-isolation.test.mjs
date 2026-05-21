import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSession } = require('../skills/browsing/chrome-ws-lib.js');
const { createOverride } = require('../skills/browsing/host-override.js');

// Regression gate for the createSession() / createOverride() factories.
//
// Pre-factory, every consumer that required chrome-ws-lib shared a single
// connection pool, console-message map, profile name, Chrome process
// handle, active CDP port, and host-override config — all module-level
// state. Any future change that reintroduces a module-level mutable will
// break these assertions.
//
// We can't directly probe the connection pool or chromeProcess without
// standing up Chrome, so the assertions poke observable surface area:
// distinct method identity (proves each call captures its own closure),
// per-instance setProfileName / setDefaults isolation (proves the
// underlying state is not shared), and per-instance host/port seeding
// (proves the host-override is per-session, not module-singleton).

describe('chrome-ws-lib createSession() isolation', () => {

  it('returns distinct instances with distinct method identity', () => {
    const a = createSession();
    const b = createSession();
    assert.notStrictEqual(a, b);
    assert.notStrictEqual(a.getProfileName, b.getProfileName);
    assert.notStrictEqual(a.setProfileName, b.setProfileName);
  });

  it('setProfileName on one session does not leak into the other', () => {
    const a = createSession();
    const b = createSession();
    assert.equal(a.getProfileName(), 'superpowers-chrome');
    assert.equal(b.getProfileName(), 'superpowers-chrome');
    a.setProfileName('alpha-profile');
    assert.equal(a.getProfileName(), 'alpha-profile');
    assert.equal(b.getProfileName(), 'superpowers-chrome');
    b.setProfileName('beta-profile');
    assert.equal(a.getProfileName(), 'alpha-profile');
    assert.equal(b.getProfileName(), 'beta-profile');
  });

  it('explicit host/port seeds the host-override per session', () => {
    const a = createSession({ host: '127.0.0.1', port: 11111 });
    const b = createSession({ host: '127.0.0.1', port: 22222 });
    assert.equal(a.getActivePort(), 11111);
    assert.equal(b.getActivePort(), 22222);
  });

  it('each session has an independent dialogs instance', () => {
    const a = createSession();
    const b = createSession();
    assert.notStrictEqual(a.dialogs, b.dialogs);
    assert.notStrictEqual(a.dialogs.getOpen, b.dialogs.getOpen);
  });
});

describe('host-override createOverride() isolation', () => {

  it('returns independent instances', () => {
    const a = createOverride();
    const b = createOverride();
    assert.notStrictEqual(a, b);
    assert.notStrictEqual(a.setDefaults, b.setDefaults);
    assert.notStrictEqual(a.getHost, b.getHost);
    assert.notStrictEqual(a.rewriteWsUrl, b.rewriteWsUrl);
  });

  it('setDefaults on one instance does not bleed into another', () => {
    const a = createOverride();
    const b = createOverride();
    a.setDefaults('alpha-host', 9301);
    b.setDefaults('beta-host', 9302);
    assert.equal(a.getHost(), 'alpha-host');
    assert.equal(a.getPort(), 9301);
    assert.equal(a.getBase(), 'http://alpha-host:9301');
    assert.equal(a.isOverrideEnabled(), true);
    assert.equal(b.getHost(), 'beta-host');
    assert.equal(b.getPort(), 9302);
    assert.equal(b.getBase(), 'http://beta-host:9302');
    a.setDefaults('alpha-host-2', 9311);
    assert.equal(a.getHost(), 'alpha-host-2');
    assert.equal(b.getHost(), 'beta-host');
  });

  it('rewriteWsUrl uses each instance\'s own host/port', () => {
    const a = createOverride({ host: 'a.example', port: 4001 });
    const b = createOverride({ host: 'b.example', port: 4002 });
    const sourceUrl = 'ws://127.0.0.1:9222/devtools/browser/abc';
    assert.equal(a.rewriteWsUrl(sourceUrl), 'ws://a.example:4001/devtools/browser/abc');
    assert.equal(b.rewriteWsUrl(sourceUrl), 'ws://b.example:4002/devtools/browser/abc');
    a.setDefaults('a2.example', 4011);
    assert.equal(a.rewriteWsUrl(sourceUrl), 'ws://a2.example:4011/devtools/browser/abc');
    assert.equal(b.rewriteWsUrl(sourceUrl), 'ws://b.example:4002/devtools/browser/abc');
  });

  it('rewriteWsUrl returns input unchanged when override is disabled', () => {
    const a = createOverride();
    if (!a.isOverrideEnabled()) {
      const sourceUrl = 'ws://127.0.0.1:9222/devtools/browser/abc';
      assert.equal(a.rewriteWsUrl(sourceUrl), sourceUrl);
    }
  });
});
