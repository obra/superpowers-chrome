# Scenario 14 — Recovery and lifecycle

**Goal:** Verify the bridge handles Chrome process death, session restart, and connection drops without unrecoverable failures.

## Steps

### Part A: Chrome killed externally
1. Start Chrome via `start_chrome` (or get the existing session running).
2. Navigate to `https://example.com`.
3. Get the Chrome PID via `get_chrome_pid` (or check via `ps`).
4. Manually kill Chrome: `kill -9 <PID>` from the shell.
5. Try to do a page action (e.g., extract h1). Should fail with a clear "Chrome not running" / "WS closed" / similar error, NOT a hang and NOT a confusing CDP timeout.
6. Restart Chrome via `start_chrome` (or whatever the restart flow is).
7. Navigate to `https://example.com` again. Should work — the session should re-establish the bridge cleanly.

### Part B: Session restart cycle
1. From a known-good state: navigate, extract, screenshot — all work.
2. `kill_chrome` (graceful shutdown).
3. Try to use the session — should error with "not running" or similar.
4. `start_chrome` again.
5. Verify the session works: navigate + extract + screenshot all pass.

### Part C: Bridge reconnect after WS drop (advanced — may or may not work)
1. Get a known-good session.
2. Externally close the bridge WS without killing Chrome itself (this is hard to do from the agent — you may need to skip this if there's no good way).
3. If you can drop the WS: try a page action. The bridge's connectPromise-retry logic (added in B2) should attempt a fresh connect on the next call. Verify it either reconnects successfully or fails with a clear error.
4. If you can't drop the WS cleanly, mark this part as N/A.

## Pass criteria

- External Chrome kill produces a clear error, not a hang
- After kill, session is reusable after explicit restart
- Multiple start_chrome/kill_chrome cycles work
- Bridge close ordering doesn't deadlock (the G3 closeBridge + 500ms timeout)

## Failure signals

- Hang on any failure path → CDP request never timed out / never errored
- After Chrome restart, bridge is in a bad state → ensureBridge isn't idempotent / cached the old browserSession
- Multiple cycles cause memory or handle leaks (e.g., listing tabs grows over time)

Report each part. If a step isn't testable from the agent (e.g., Part C), mark it N/A and explain.
