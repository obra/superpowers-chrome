'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { getChromeProfileDir } = require('./chrome-launcher-helpers');

/**
 * Per-profile MCP-instance lock.
 *
 * The bridge defaults every MCP server to the `superpowers-chrome` profile,
 * which means two MCP processes running on the same host silently end up
 * driving the same Chrome (the second one reconnects to the first's instance
 * via the meta.json path). Their `activeTab` pointers stomp on each other and
 * the agents fight over tabs without any error surfacing.
 *
 * The fix is to claim a per-process lock file next to the profile dir and,
 * on conflict with a live holder, auto-pick an unused alternate name
 * (`superpowers-chrome-2`, `-3`, etc.). The first MCP keeps the simple
 * default; later MCPs get their own Chrome silently.
 *
 * Layout:
 *   ~/.cache/superpowers/browser-profiles/<profile>/                 — Chrome user-data-dir
 *   ~/.cache/superpowers/browser-profiles/<profile>.meta.json        — port/pid (Chrome process)
 *   ~/.cache/superpowers/browser-profiles/<profile>.mcp.lock         — MCP-instance lock
 *
 * Semantics:
 *   - `acquireWithFallback(base)` is the entry point used by chrome-process.js.
 *     It tries `base`, then `base-2`, `base-3`, ... until it claims one or
 *     runs out of slots. Returns { profileName, lockPath }.
 *   - `acquire(profileName)` is a single-profile try-lock. Returns the
 *     lock path on success, `null` on live-holder conflict, and throws on
 *     unexpected I/O errors.
 *   - `release(lockPath)` removes the lock; safe to call unconditionally.
 *   - A lock whose pid is no longer alive is treated as stale and overwritten
 *     atomically.
 *   - File creation uses `wx` flag for atomicity — two MCPs starting at the
 *     same millisecond can't both win.
 *
 * Lock file shape:
 *   { pid: number, mcpPid: number, startedAt: ISO8601, version: number }
 *   `version` is the on-disk format; bump if the shape ever changes.
 */

const LOCK_FORMAT_VERSION = 1;
const MAX_PROFILE_SLOTS = 100;

function getProfileLockPath(profileName) {
  // Sibling of the profile dir, mirroring the meta.json placement.
  // Uses the same directory the launcher already created for the profile.
  return path.join(path.dirname(getChromeProfileDir(profileName)), `${profileName}.mcp.lock`);
}

function isPidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process. EPERM = process exists but we can't signal it
    // (usually a different user) — still treat as alive so we don't stomp.
    return e && e.code === 'EPERM';
  }
}

function readLockFile(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeLockFile(lockPath, { atomic = true } = {}) {
  const payload = {
    pid: process.pid,
    mcpPid: process.pid,
    startedAt: new Date().toISOString(),
    version: LOCK_FORMAT_VERSION,
  };
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  // `wx` opens for write but fails if the file exists — atomic claim.
  // The non-atomic variant is used only after we've verified the prior
  // holder is dead and unlinked their lock.
  const flag = atomic ? 'wx' : 'w';
  fs.writeFileSync(lockPath, JSON.stringify(payload, null, 2), { flag });
}

function tryAtomicClaim(lockPath) {
  try {
    writeLockFile(lockPath);
    return true;
  } catch (e) {
    if (e && e.code === 'EEXIST') return false;
    throw e;
  }
}

/**
 * Try to acquire the lock for one specific profile.
 *
 * Returns the absolute lock path on success.
 * Returns `null` if another live MCP already holds it.
 */
function acquire(profileName) {
  const lockPath = getProfileLockPath(profileName);

  // First pass: try atomic create. Wins if no lock exists.
  if (tryAtomicClaim(lockPath)) return lockPath;

  // Lock file already exists — inspect it.
  const existing = readLockFile(lockPath);
  if (existing && isPidAlive(existing.pid)) {
    return null; // Another MCP is live on this profile.
  }

  // Stale (dead pid or unreadable). Remove and retake. The unlink → write
  // pair is not atomic; a parallel acquirer could squeeze in between them.
  // Re-test atomically after the rewrite to detect that race.
  try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
  if (tryAtomicClaim(lockPath)) return lockPath;

  // Someone else took it between our unlink and our claim. Re-inspect.
  const racer = readLockFile(lockPath);
  if (racer && isPidAlive(racer.pid)) return null;
  // Their pid is also dead? Weird. Bail rather than loop forever.
  return null;
}

/**
 * Acquire a lock for `baseProfileName`. If another live MCP holds it,
 * fall through to `<base>-2`, `<base>-3`, ... up to MAX_PROFILE_SLOTS.
 *
 * Returns `{ profileName, lockPath, slot }` on success, where `slot` is 1
 * for the base name and N for the (N-1)-suffixed alternate.
 *
 * Throws if no slot is available — practically only happens if 100 MCPs
 * are all live on the same host, which means something is wrong.
 */
function acquireWithFallback(baseProfileName) {
  for (let slot = 1; slot <= MAX_PROFILE_SLOTS; slot++) {
    const candidate = slot === 1 ? baseProfileName : `${baseProfileName}-${slot}`;
    const lockPath = acquire(candidate);
    if (lockPath) {
      return { profileName: candidate, lockPath, slot };
    }
  }
  throw new Error(
    `Could not acquire a profile lock — ${MAX_PROFILE_SLOTS} live MCP instances ` +
    `for base '${baseProfileName}'? Use CHROME_WS_PROFILE to set a unique name.`
  );
}

function release(lockPath) {
  if (!lockPath) return;
  try {
    // Only remove if it's still ours. Two cases where it isn't:
    //  1. Some other process unlinked + recreated it (lock file PID differs)
    //  2. The MCP that holds it has been replaced — same pid would be a coincidence
    // We compare pid before unlinking to avoid removing a successor's lock.
    const existing = readLockFile(lockPath);
    if (existing && existing.pid !== process.pid) return;
    fs.unlinkSync(lockPath);
  } catch {
    // Already gone or unwritable — nothing to do.
  }
}

module.exports = {
  acquire,
  acquireWithFallback,
  release,
  // Exposed for tests:
  getProfileLockPath,
  isPidAlive,
  readLockFile,
  LOCK_FORMAT_VERSION,
};
