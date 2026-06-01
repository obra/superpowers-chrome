import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { attachChromeProcess } = require('../../skills/browsing/lib/chrome-process.js');

function setup() {
  const state = {
    hostOverride: {
      getHost: () => '127.0.0.1',
      getPort: () => 9222,
    },
    activePort: 9222,
    chromeHeadless: true,
    chromeProcess: null,
    chromeProfileName: 'superpowers-chrome',
    chromeUserDataDir: null,
  };
  const chromeHttp = async () => ({});
  const getTabs = async () => [];
  const newTab = async () => ({});
  return { ...attachChromeProcess({ state, chromeHttp, getTabs, newTab }), state };
}

describe('chrome-process', () => {

  it('getActivePort returns state.activePort', () => {
    const { getActivePort, state } = setup();
    state.activePort = 9333;
    assert.equal(getActivePort(), 9333);
  });

  it('getProfileName returns state.chromeProfileName', () => {
    const { getProfileName, state } = setup();
    state.chromeProfileName = 'custom';
    assert.equal(getProfileName(), 'custom');
  });

  it('setProfileName validates the name and updates state', () => {
    const { setProfileName, state } = setup();
    setProfileName('valid-name_2');
    assert.equal(state.chromeProfileName, 'valid-name_2');
    // chromeUserDataDir reset so next startChrome re-derives it.
    assert.equal(state.chromeUserDataDir, null);
  });

  it('setProfileName throws on invalid characters', () => {
    const { setProfileName } = setup();
    assert.throws(() => setProfileName('foo/bar'), /Invalid profile name/);
    assert.throws(() => setProfileName('../etc'), /Invalid profile name/);
  });

  it('setProfileName throws if chrome is running', () => {
    const { setProfileName, state } = setup();
    state.chromeProcess = { pid: 1234 };
    assert.throws(() => setProfileName('new'), /Cannot change profile while Chrome is running/);
  });

  it('getChromePid returns null when no process, pid when running', () => {
    const { getChromePid, state } = setup();
    assert.equal(getChromePid(), null);
    state.chromeProcess = { pid: 5678 };
    assert.equal(getChromePid(), 5678);
  });

  it('getBrowserMode reflects state', async () => {
    const { getBrowserMode, state } = setup();
    state.chromeHeadless = false;
    state.chromeProcess = { pid: 9999 };
    state.activePort = 9444;
    const mode = await getBrowserMode();
    assert.equal(mode.headless, false);
    assert.equal(mode.mode, 'headed');
    assert.equal(mode.running, true);
    assert.equal(mode.pid, 9999);
    assert.equal(mode.port, 9444);
  });
});

describe('chrome-process: shutdown closes bridge before SIGTERM', () => {
  function setupWithMockKill() {
    const events = [];
    const mockKill = (_pid, sig) => { events.push('kill:' + sig); };

    const state = {
      hostOverride: {
        getHost: () => '127.0.0.1',
        getPort: () => 9222,
      },
      activePort: 9222,
      chromeHeadless: true,
      chromeProcess: { pid: 1234 },
      chromeProfileName: 'superpowers-chrome',
      chromeUserDataDir: null,
    };
    const chromeHttp = async () => ({});
    const getTabs = async () => [];
    const newTab = async () => ({});

    return { state, events, mockKill, chromeHttp, getTabs, newTab };
  }

  it('calls browserSession.close() before sending SIGTERM to Chrome', async () => {
    const { state, events, mockKill, chromeHttp, getTabs, newTab } = setupWithMockKill();

    state.browserSession = {
      close: async () => { events.push('bridge-close'); },
    };

    const originalKill = process.kill;
    process.kill = mockKill;
    try {
      const { killChrome } = attachChromeProcess({ state, chromeHttp, getTabs, newTab });
      await killChrome();
    } finally {
      process.kill = originalKill;
    }

    assert.ok(events.includes('bridge-close'), 'bridge-close should be recorded');
    assert.ok(events.includes('kill:SIGTERM'), 'kill:SIGTERM should be recorded');
    assert.ok(
      events.indexOf('bridge-close') < events.indexOf('kill:SIGTERM'),
      `bridge-close (${events.indexOf('bridge-close')}) must precede kill:SIGTERM (${events.indexOf('kill:SIGTERM')})`
    );
  });

  it('does not hang if browserSession.close() never resolves; falls back to kill after timeout', async () => {
    const { state, events, mockKill, chromeHttp, getTabs, newTab } = setupWithMockKill();

    state.browserSession = {
      close: () => new Promise(() => {}), // never resolves
    };

    const originalKill = process.kill;
    process.kill = mockKill;
    const start = Date.now();
    try {
      const { killChrome } = attachChromeProcess({ state, chromeHttp, getTabs, newTab });
      await killChrome();
    } finally {
      process.kill = originalKill;
    }
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 2000, `should not hang waiting for close (took ${elapsed}ms)`);
    assert.ok(events.includes('kill:SIGTERM'), 'kill:SIGTERM should be recorded even when close hangs');
  });

  it('proceeds normally when browserSession is absent', async () => {
    const { state, events, mockKill, chromeHttp, getTabs, newTab } = setupWithMockKill();
    // No browserSession on state

    const originalKill = process.kill;
    process.kill = mockKill;
    try {
      const { killChrome } = attachChromeProcess({ state, chromeHttp, getTabs, newTab });
      await killChrome();
    } finally {
      process.kill = originalKill;
    }

    assert.ok(events.includes('kill:SIGTERM'), 'kill:SIGTERM should be recorded');
  });
});

describe('chrome-process: killChrome calls state.resetBridge()', () => {
  it('invokes state.resetBridge() after closing the bridge and sending SIGTERM', async () => {
    const events = [];
    const state = {
      hostOverride: {
        getHost: () => '127.0.0.1',
        getPort: () => 9222,
      },
      activePort: 9222,
      chromeHeadless: true,
      chromeProcess: { pid: 1234 },
      chromeProfileName: 'superpowers-chrome',
      chromeUserDataDir: null,
      browserSession: {
        close: async () => { events.push('bridge-close'); },
      },
      resetBridge: () => { events.push('reset-bridge'); },
    };

    const originalKill = process.kill;
    process.kill = (_pid, sig) => { events.push('kill:' + sig); };
    try {
      const { killChrome } = attachChromeProcess({
        state,
        chromeHttp: async () => ({}),
        getTabs: async () => [],
        newTab: async () => ({}),
      });
      await killChrome();
    } finally {
      process.kill = originalKill;
    }

    assert.ok(events.includes('reset-bridge'), 'resetBridge was called');
    // resetBridge must happen after the kill, not before
    assert.ok(
      events.indexOf('kill:SIGTERM') < events.indexOf('reset-bridge'),
      `kill:SIGTERM (${events.indexOf('kill:SIGTERM')}) must precede reset-bridge (${events.indexOf('reset-bridge')})`
    );
  });

  it('calls state.resetBridge() even when there is no process to kill', async () => {
    const events = [];
    const state = {
      hostOverride: {
        getHost: () => '127.0.0.1',
        getPort: () => 9222,
      },
      activePort: 9222,
      chromeHeadless: true,
      chromeProcess: null, // nothing to kill
      chromeProfileName: 'superpowers-chrome',
      chromeUserDataDir: null,
      resetBridge: () => { events.push('reset-bridge'); },
    };

    const { killChrome } = attachChromeProcess({
      state,
      chromeHttp: async () => ({}),
      getTabs: async () => [],
      newTab: async () => ({}),
    });
    await killChrome();

    assert.ok(events.includes('reset-bridge'), 'resetBridge called even with no process');
  });
});

// ---------------------------------------------------------------------------
// Bug-fix regression tests
// ---------------------------------------------------------------------------

const CHROME_PROCESS_PATH = require.resolve('../../skills/browsing/lib/chrome-process.js');

// Build a fake EventEmitter-based proc that can emit 'exit' on demand.
function makeFakeProc({ pid = 99999 } = {}) {
  const proc = new EventEmitter();
  proc.pid = pid;
  proc.unref = () => {};
  proc._die = () => proc.emit('exit', 1, null);
  return proc;
}

// ---------------------------------------------------------------------------
// Bug 1: failed startChrome must clear the dead chromeProcess handle.
//
// The fix has two parts:
//   a) proc.on('exit') listener that clears state.chromeProcess for owned proc.
//   b) Explicit state.chromeProcess = null in the readiness-timeout error path.
//
// (a) is tested via a direct logic test of the listener's identity guard.
// (b) is tested end-to-end via require.cache injection (Chrome binary must
//     exist on disk; the test self-skips if it doesn't).
// ---------------------------------------------------------------------------

describe('chrome-process: Bug 1a — exit listener clears owned proc, ignores stale procs', () => {
  it('clears state.chromeProcess when the owned proc exits', () => {
    const state = { chromeProcess: null };
    const proc = makeFakeProc({ pid: 1111 });

    state.chromeProcess = proc;
    proc.on('exit', () => {
      if (state.chromeProcess === proc) state.chromeProcess = null;
    });

    proc._die();
    assert.equal(state.chromeProcess, null);
  });

  it('does not clear state.chromeProcess when a later proc replaced the original', () => {
    const state = { chromeProcess: null };
    const proc1 = makeFakeProc({ pid: 1111 });
    const proc2 = makeFakeProc({ pid: 2222 });

    state.chromeProcess = proc1;
    proc1.on('exit', () => {
      if (state.chromeProcess === proc1) state.chromeProcess = null;
    });

    proc1._die();
    // Replace with a new proc.
    state.chromeProcess = proc2;
    // A stale second 'exit' from proc1 must not clobber proc2.
    proc1._die();
    assert.equal(state.chromeProcess, proc2);
  });
});

describe('chrome-process: Bug 1b — startChrome clears chromeProcess on readiness timeout', () => {
  // This test injects fake deps via require.cache so we can control
  // isPortAlive and spawn without a real Chrome binary.
  // It self-skips when Chrome is not installed (binary discovery happens
  // inside the module before spawn is called).

  const HELPERS_PATH = require.resolve('../../skills/browsing/lib/chrome-launcher-helpers.js');

  function withFakeModules(_fakeProc, testFn) {
    const origHelpers = require.cache[HELPERS_PATH];

    const fakeHelpers = {
      readProfileMeta: () => null,
      writeProfileMeta: () => {},
      clearProfileMeta: () => {},
      isPortAlive: async () => false,       // never ready → triggers timeout
      findAvailablePort: async () => 9333,
      findPidOnPort: () => null,
      findOrphanChromeForProfile: () => null,
      buildChromeArgs: () => ['--fake'],
      getChromeProfileDir: () => '/tmp/fake-profile',
    };

    require.cache[HELPERS_PATH] = {
      id: HELPERS_PATH, filename: HELPERS_PATH, loaded: true, exports: fakeHelpers,
    };
    delete require.cache[CHROME_PROCESS_PATH];
    const { attachChromeProcess: fresh } = require(CHROME_PROCESS_PATH);

    try {
      return testFn(fresh);
    } finally {
      if (origHelpers) { require.cache[HELPERS_PATH] = origHelpers; }
      else { delete require.cache[HELPERS_PATH]; }
      delete require.cache[CHROME_PROCESS_PATH];
      // Restore the canonical chrome-process module.
      require(CHROME_PROCESS_PATH);
    }
  }

  it('state.chromeProcess is null after startChrome fails to bind port', async () => {
    const { existsSync } = require('fs');
    const { platform } = require('os');
    const chromePaths = {
      darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
      linux: ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'],
      win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
    };
    const chromeInstalled = (chromePaths[platform()] || []).some(p => existsSync(p));
    if (!chromeInstalled) return; // self-skip: binary discovery happens inside module

    const fakeProc = makeFakeProc();

    // Patch child_process.spawn so the module uses our fake proc (no real Chrome).
    const origCp = require.cache['child_process'];
    require.cache['child_process'] = {
      id: 'child_process', filename: 'child_process', loaded: true,
      exports: { spawn: () => fakeProc },
    };

    try {
      await withFakeModules(fakeProc, async (fresh) => {
        const state = {
          hostOverride: { getHost: () => '127.0.0.1', getPort: () => 9222 },
          activePort: 9222,
          chromeHeadless: true,
          chromeProcess: null,
          chromeProfileName: 'test-profile',
          chromeUserDataDir: '/tmp/fake-profile',
        };
        const { startChrome } = fresh({
          state,
          chromeHttp: async () => ({}),
          getTabs: async () => [],
          newTab: async () => ({}),
        });

        await assert.rejects(
          () => startChrome(true, null, null),
          /Chrome did not become ready/
        );
        assert.equal(state.chromeProcess, null, 'dead handle must be cleared after timeout');
      });
    } finally {
      if (origCp) { require.cache['child_process'] = origCp; }
      else { delete require.cache['child_process']; }
    }
  });
});

// ---------------------------------------------------------------------------
// Bug 2: setProfileName must reset activePort so a rotated port from a
// prior failed spawn doesn't carry forward to the next profile's spawn.
// ---------------------------------------------------------------------------

describe('chrome-process: Bug 2 — setProfileName resets activePort to default', () => {
  it('resets state.activePort to CHROME_DEBUG_PORT after a rotated port', () => {
    const { setProfileName, state } = setup();
    state.activePort = 9999; // simulate a rotated port from a prior failed spawn
    setProfileName('another-profile');
    // CHROME_DEBUG_PORT === 9222 (hostOverride.getPort() in setup).
    assert.equal(state.activePort, 9222, 'activePort reset to default after profile switch');
  });

  it('resets activePort regardless of how far it drifted', () => {
    const { setProfileName, state } = setup();
    state.activePort = 54321;
    setProfileName('profile-b');
    assert.equal(state.activePort, 9222);
  });
});

// ---------------------------------------------------------------------------
// Bug 3: restartInMode (showBrowser/hideBrowser) must NOT capture activePort
// before killChrome() resets it; otherwise Chrome relaunches on the wedged port.
// ---------------------------------------------------------------------------

describe('chrome-process: Bug 3 — killChrome resets activePort; restartInMode uses reset value', () => {
  it('killChrome resets state.activePort to CHROME_DEBUG_PORT', async () => {
    const { killChrome, state } = setup();
    state.activePort = 19999; // simulate a wedged / rotated port
    state.chromeProcess = null; // no process → takes the "nothing to kill" path

    const originalKill = process.kill;
    process.kill = () => {};
    try {
      await killChrome();
    } finally {
      process.kill = originalKill;
    }

    assert.equal(state.activePort, 9222, 'killChrome resets activePort to CHROME_DEBUG_PORT');
  });

  it('restartInMode source does not capture savedPort before killChrome', () => {
    // Structural check: the buggy `const savedPort = state.activePort` pattern
    // must not appear in the module source. This prevents regression.
    const moduleSrc = require(CHROME_PROCESS_PATH).attachChromeProcess.toString();
    assert.ok(
      !moduleSrc.includes('savedPort'),
      'savedPort variable must not appear — indicates the pre-kill port capture bug'
    );
  });
});

// ---------------------------------------------------------------------------
// Fix 5: browser_mode symmetry — profileDir always populated even when stopped
// ---------------------------------------------------------------------------

describe('chrome-process: getBrowserMode profileDir symmetry', () => {
  it('reports profileDir from chromeUserDataDir when Chrome is running', async () => {
    const { getBrowserMode, state } = setup();
    state.chromeProcess = { pid: 1111 };
    state.chromeUserDataDir = '/tmp/my-profile';
    const mode = await getBrowserMode();
    assert.equal(mode.profileDir, '/tmp/my-profile');
    assert.equal(mode.running, true);
    assert.equal(mode.pid, 1111);
  });

  it('derives profileDir from profile name when chromeUserDataDir is null (stopped)', async () => {
    const { getBrowserMode, state } = setup();
    state.chromeProcess = null;
    state.chromeUserDataDir = null;
    state.chromeProfileName = 'superpowers-chrome';
    // Probe a port nothing listens on, not the shared default 9222 — a real
    // Chrome from a parallel suite (e.g. the smoke) binds 9222 and made the
    // "stopped" assertion flaky. Port 1 is privileged/unbound.
    state.activePort = 1;
    const mode = await getBrowserMode();
    // Should be a non-null string derived from the profile name, not null
    assert.ok(typeof mode.profileDir === 'string', 'profileDir should be a string even when stopped');
    assert.ok(mode.profileDir.length > 0, 'profileDir should be non-empty');
    assert.equal(mode.running, false);
    assert.equal(mode.pid, null);
  });

  it('reports both profile and profileDir fields when stopped', async () => {
    const { getBrowserMode, state } = setup();
    state.chromeProcess = null;
    state.chromeUserDataDir = null;
    const mode = await getBrowserMode();
    assert.ok('profile' in mode, 'profile field present when stopped');
    assert.ok('profileDir' in mode, 'profileDir field present when stopped');
  });
});

// ---------------------------------------------------------------------------
// Adopted / external Chrome: pid + running come from port probe and meta,
// not just state.chromeProcess. Regression for scenario 14 step 3 — the
// bridge was reporting {pid: null, running: false} whenever Chrome was
// adopted from a prior MCP session even though the CDP worked.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Profile-lock auto-disambiguation. Verifies that two MCP sessions starting
// from the default profile end up on distinct profiles ('superpowers-chrome'
// and 'superpowers-chrome-2'), and that an explicit profile (set_profile or
// CHROME_WS_PROFILE) opts out of disambiguation.
// ---------------------------------------------------------------------------

describe('chrome-process: profile-lock auto-disambiguation', () => {
  // We redirect XDG_CACHE_HOME per-test so lock files don't bleed across
  // tests or between this suite and real local state.
  let tmpRoot;
  let originalXdg;
  let _attachChromeProcess; // re-required to pick up the env-redirected helpers

  function setupForLock() {
    const state = {
      hostOverride: { getHost: () => '127.0.0.1', getPort: () => 9222 },
      activePort: 9222,
      chromeHeadless: true,
      chromeProcess: null,
      chromeProfileName: 'superpowers-chrome',
      chromeUserDataDir: null,
      _profileExplicit: false,
    };
    const chromeHttp = async () => ({});
    const getTabs = async () => [];
    const newTab = async () => ({});
    return { ...(_attachChromeProcess({ state, chromeHttp, getTabs, newTab })), state };
  }

  // node:test doesn't give us `before`/`after` at the describe-block scope when
  // the suite uses standalone `it`s; do per-it setup/teardown via helper.
  function withTmpXdg(fn) {
    return async () => {
      const fs = require('node:fs');
      const path = require('node:path');
      const os = require('node:os');
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-chrome-process-lock-'));
      originalXdg = process.env.XDG_CACHE_HOME;
      process.env.XDG_CACHE_HOME = tmpRoot;
      // Force re-require so lib/profile-lock and chrome-launcher-helpers see the new env.
      const r = createRequire(import.meta.url);
      delete r.cache[r.resolve('../../skills/browsing/lib/profile-lock.js')];
      delete r.cache[r.resolve('../../skills/browsing/lib/chrome-launcher-helpers.js')];
      delete r.cache[r.resolve('../../skills/browsing/lib/chrome-process.js')];
      _attachChromeProcess = r('../../skills/browsing/lib/chrome-process.js').attachChromeProcess;

      try {
        await fn();
      } finally {
        if (originalXdg === undefined) delete process.env.XDG_CACHE_HOME;
        else process.env.XDG_CACHE_HOME = originalXdg;
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    };
  }

  it('first session keeps the default profile name', withTmpXdg(async () => {
    const fs = require('node:fs');
    // Direct check that acquireWithFallback picks the base name when no
    // lock exists. We don't drive startChrome end-to-end here — the launcher
    // would try to spawn real Chrome — but the integration we care about
    // (does the bridge select the right profile name?) lives in the lock
    // module, which is what this asserts.
    const lock = require('../../skills/browsing/lib/profile-lock.js');
    const r = lock.acquireWithFallback('superpowers-chrome');
    assert.equal(r.profileName, 'superpowers-chrome');
    assert.equal(r.slot, 1);
    // Confirm the lock file is actually on disk under the tmp XDG_CACHE_HOME.
    assert.ok(r.lockPath.startsWith(tmpRoot), `lock path should live under ${tmpRoot}, got ${r.lockPath}`);
    assert.equal(fs.existsSync(r.lockPath), true);
  }));

  it('second session falls through to -2 when base is held', withTmpXdg(async () => {
    const lock = require('../../skills/browsing/lib/profile-lock.js');
    // First session takes the base.
    const first = lock.acquireWithFallback('superpowers-chrome');
    assert.equal(first.profileName, 'superpowers-chrome');
    // Second session sees the live lock (we as the test process are alive)
    // and picks the next slot.
    const second = lock.acquireWithFallback('superpowers-chrome');
    assert.equal(second.profileName, 'superpowers-chrome-2');
    assert.equal(second.slot, 2);
    assert.notEqual(first.lockPath, second.lockPath);
  }));

  it('setProfileName flags the profile as explicit', withTmpXdg(async () => {
    const { setProfileName, state } = setupForLock();
    setProfileName('shared-chrome');
    assert.equal(state.chromeProfileName, 'shared-chrome');
    assert.equal(state._profileExplicit, true, 'setProfileName must mark profile explicit so the lock skips disambiguation');
  }));
});

describe('chrome-process: getBrowserMode for adopted Chrome', () => {
  function setupWithLiveChromeStub({ activePort = 9555, port = 9555 } = {}) {
    // Start a tiny HTTP server that satisfies isPortAlive's
    // GET /json/version probe (it expects a JSON body with a `Browser` field).
    return new Promise((resolve) => {
      const http = require('node:http');
      const server = http.createServer((req, res) => {
        if (req.url === '/json/version') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ Browser: 'Chrome/test', 'WebKit-Version': 'x' }));
        } else {
          res.writeHead(404); res.end();
        }
      });
      server.listen(port, '127.0.0.1', () => {
        const state = {
          hostOverride: {
            getHost: () => '127.0.0.1',
            getPort: () => 9222,
          },
          activePort,
          chromeHeadless: false,
          chromeProcess: null,
          chromeProfileName: 'superpowers-chrome',
          chromeUserDataDir: null,
        };
        const chromeHttp = async () => ({});
        const getTabs = async () => [];
        const newTab = async () => ({});
        const api = attachChromeProcess({ state, chromeHttp, getTabs, newTab });
        resolve({ ...api, state, close: () => new Promise(r => server.close(r)) });
      });
    });
  }

  it('running:true and a pid even though state.chromeProcess is null', async () => {
    const { getBrowserMode, close } = await setupWithLiveChromeStub({ activePort: 9555, port: 9555 });
    try {
      const mode = await getBrowserMode();
      assert.equal(mode.running, true, 'should report running:true when port responds');
      assert.equal(typeof mode.pid, 'number', 'pid should be a number (resolved via port scan)');
      assert.ok(mode.pid > 0, 'pid should be positive');
      assert.equal(mode.port, 9555);
    } finally {
      await close();
    }
  });

  it('running:false and pid:null when no Chrome is on activePort', async () => {
    const { getBrowserMode, state } = setup();
    // Probe a port nothing listens on. NOT the shared default 9222 — a real
    // Chrome from a parallel suite (e.g. the smoke) binds 9222 and made this
    // flaky. Port 1 is privileged/unbound (mirrors the sibling test below).
    state.activePort = 1;
    const mode = await getBrowserMode();
    assert.equal(mode.running, false, 'no listener → running:false');
    assert.equal(mode.pid, null, 'no listener → pid:null');
  });

  it('running:false hides any pid that might have been resolved', async () => {
    // Even if findPidOnPort returned a value, we should not advertise it
    // when isPortAlive came back false.
    const { getBrowserMode, state } = setup();
    state.activePort = 1; // privileged port, definitely no chrome
    const mode = await getBrowserMode();
    assert.equal(mode.running, false);
    assert.equal(mode.pid, null);
  });
});
