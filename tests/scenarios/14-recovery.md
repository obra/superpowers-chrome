# Scenario 14 — Recovery and lifecycle

**Goal:** Verify the bridge handles Chrome process death and explicit
restart without unrecoverable failures. The relevant MCP actions are
`browser_mode` (read state, including pid), `kill_chrome` (graceful
shutdown), and `restart_chrome` (kill + restart). There is no
`start_chrome` action — Chrome is auto-started by `ensureChromeRunning`
on the next page-target action after a kill.

## Steps

### Part A: External Chrome kill

1. `{"action": "navigate", "payload": "https://example.com"}` to ensure
   Chrome is running and bridged.
2. `{"action": "extract", "selector": "h1", "payload": "text"}` → must
   contain `Example Domain`.
3. `{"action": "browser_mode"}`. Parse the response JSON and record
   `pid` as `P`. PASS if `pid` is a positive integer.
4. From Bash: `kill -9 <P>; sleep 1`. The Chrome process should die.
   PASS if `kill` exits 0.
5. `{"action": "navigate", "payload": "https://example.com"}`. The
   bridge MUST auto-restart Chrome and the navigate MUST succeed. The
   response is allowed (and expected) to include the auto-restart
   banner — verify the response contains the substring
   `Chrome auto-restarted` OR the navigate succeeds and a follow-up
   extract works.
6. `{"action": "extract", "selector": "h1", "payload": "text"}`. PASS
   if result contains `Example Domain`.

### Part B: Explicit kill + restart cycle

7. `{"action": "navigate", "payload": "data:text/html,<h1>before-cycle</h1>"}`.
8. `{"action": "extract", "selector": "h1", "payload": "text"}` → must
   contain `before-cycle`.
9. `{"action": "kill_chrome"}`. PASS if it returns without error.
10. `{"action": "restart_chrome"}`. PASS if it returns without error.
11. `{"action": "navigate", "payload": "data:text/html,<h1>after-cycle</h1>"}`.
12. `{"action": "extract", "selector": "h1", "payload": "text"}` → must
    contain `after-cycle`.

### Part C: WS-drop reconnect (not testable from agent)

The bridge has a connectPromise-retry path (commit B2) for the case
where the root WebSocket dies but Chrome itself stays up. There is no
agent-reachable way to drop the WS without also killing Chrome.

13. Mark Part C as **N/A — not reachable from agent surface**. No
    further action.

## Pass criteria

- Steps 1–12 each satisfy their per-step criterion above
- Step 13 explicitly marked N/A (this is a pass)

## Failure signals

- Step 5 hangs or returns an error that does not lead to recovery →
  auto-restart path is broken
- Step 9 / 10 throws → kill_chrome / restart_chrome dispatch is wrong
- Step 11 / 12 fails after the cycle → ensureBridge isn't idempotent
  across restarts
- Memory or handle leak over multiple cycles (e.g., process count
  grows) — note as a concern even if the steps pass
