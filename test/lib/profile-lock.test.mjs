/**
 * Profile lock — per-MCP-instance claim on a profile name, with
 * auto-disambiguation when the default base is held by another live MCP.
 *
 * Tests don't touch the real lock directory; they redirect XDG_CACHE_HOME
 * to a per-test tmpdir so each test starts from a clean lock file state.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const require = createRequire(import.meta.url);

let tmpRoot;
let originalXdg;
let lock;

beforeEach(() => {
  // Redirect XDG_CACHE_HOME so getChromeProfileDir's directory tree lives
  // entirely in a fresh tmpdir. Re-require the module so it picks up the
  // new env value via chrome-launcher-helpers.
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-profile-lock-'));
  originalXdg = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = tmpRoot;

  // Clear require cache so the helpers see the new env var.
  delete require.cache[require.resolve('../../skills/browsing/lib/profile-lock.js')];
  delete require.cache[require.resolve('../../skills/browsing/lib/chrome-launcher-helpers.js')];
  lock = require('../../skills/browsing/lib/profile-lock.js');
});

afterEach(() => {
  if (originalXdg === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdg;
  // Best-effort cleanup
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('profile-lock: acquire on a fresh profile', () => {
  it('returns a lock path and writes the lock file with our pid', () => {
    const lockPath = lock.acquire('superpowers-chrome');
    assert.ok(lockPath, 'acquire should return a path on a fresh profile');
    const onDisk = lock.readLockFile(lockPath);
    assert.equal(onDisk.pid, process.pid);
    assert.equal(typeof onDisk.startedAt, 'string');
    assert.equal(onDisk.version, lock.LOCK_FORMAT_VERSION);
  });

  it('release removes the lock file', () => {
    const lockPath = lock.acquire('superpowers-chrome');
    assert.ok(fs.existsSync(lockPath), 'lock file should exist after acquire');
    lock.release(lockPath);
    assert.equal(fs.existsSync(lockPath), false, 'lock file should be removed after release');
  });
});

describe('profile-lock: live holder blocks re-acquire', () => {
  it('returns null when another live PID holds the lock', () => {
    // Simulate another live MCP: write a lock with our own PID (definitely alive).
    const lockPath = lock.getProfileLockPath('superpowers-chrome');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid, // live
      mcpPid: process.pid,
      startedAt: new Date().toISOString(),
      version: 1,
    }));

    const result = lock.acquire('superpowers-chrome');
    assert.equal(result, null, 'acquire must return null when another live PID holds the lock');
  });
});

describe('profile-lock: stale lock is reclaimable', () => {
  it('succeeds when the holder PID is dead', () => {
    const lockPath = lock.getProfileLockPath('superpowers-chrome');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    // Find a PID that's almost certainly not alive — PID 1 IS alive on most
    // systems (init/launchd), so use a very high value unlikely to be in use.
    // On a system where this happens to be live, the test is harmless: the
    // acquire just returns null instead of the path.
    const deadPid = 999999;
    if (lock.isPidAlive(deadPid)) {
      // Skip with a note — this environment somehow has that PID.
      return;
    }
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: deadPid,
      mcpPid: deadPid,
      startedAt: new Date().toISOString(),
      version: 1,
    }));

    const result = lock.acquire('superpowers-chrome');
    assert.ok(result, 'acquire should reclaim a stale (dead-PID) lock');
    const onDisk = lock.readLockFile(result);
    assert.equal(onDisk.pid, process.pid, 'the reclaimed lock should now record our pid');
  });
});

describe('profile-lock: acquireWithFallback', () => {
  it('returns the base name on slot 1 when uncontended', () => {
    const r = lock.acquireWithFallback('superpowers-chrome');
    assert.equal(r.profileName, 'superpowers-chrome');
    assert.equal(r.slot, 1);
    assert.ok(r.lockPath);
  });

  it('falls through to -2 when the base is held by a live PID', () => {
    // Hold the base lock with a live PID (ours).
    const basePath = lock.getProfileLockPath('superpowers-chrome');
    fs.mkdirSync(path.dirname(basePath), { recursive: true });
    fs.writeFileSync(basePath, JSON.stringify({
      pid: process.pid, mcpPid: process.pid,
      startedAt: new Date().toISOString(), version: 1,
    }));

    const r = lock.acquireWithFallback('superpowers-chrome');
    assert.equal(r.profileName, 'superpowers-chrome-2');
    assert.equal(r.slot, 2);
  });

  it('skips multiple held slots and picks the first free one', () => {
    // Hold base, -2, and -3.
    for (const name of ['superpowers-chrome', 'superpowers-chrome-2', 'superpowers-chrome-3']) {
      const p = lock.getProfileLockPath(name);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify({
        pid: process.pid, mcpPid: process.pid,
        startedAt: new Date().toISOString(), version: 1,
      }));
    }
    const r = lock.acquireWithFallback('superpowers-chrome');
    assert.equal(r.profileName, 'superpowers-chrome-4');
    assert.equal(r.slot, 4);
  });
});

describe('profile-lock: release safety', () => {
  it('release of a foreign-pid lock is a no-op', () => {
    const lockPath = lock.getProfileLockPath('superpowers-chrome');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    // Lock written by a different "process" (we use a deliberately-bogus PID
    // we know isn't us; the release path checks pid match).
    const foreignPid = process.pid + 1;
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: foreignPid, mcpPid: foreignPid,
      startedAt: new Date().toISOString(), version: 1,
    }));

    lock.release(lockPath);
    assert.equal(fs.existsSync(lockPath), true, 'release must not remove a foreign-pid lock');
  });

  it('release on a missing lock does not throw', () => {
    const p = lock.getProfileLockPath('never-existed');
    assert.doesNotThrow(() => lock.release(p));
  });
});
