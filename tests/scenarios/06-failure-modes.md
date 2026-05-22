# Scenario 06 — Failure modes

**Goal:** Verify that pathological inputs and conditions fail cleanly rather than wedging the session.

## Steps

For each step, capture the response and report PASS/FAIL against the
per-step criterion.

1. **Navigate to an unreachable URL**:
   `{"action": "navigate", "payload": "http://localhost:0/never", "timeout": 15000}`.
   The call MUST throw (the MCP returns an error response). The error
   message must contain `Navigate failed` and a Chromium net-error
   token (one of `ERR_UNSAFE_PORT`, `ERR_CONNECTION_REFUSED`,
   `ERR_INVALID_URL`, `ERR_NAME_NOT_RESOLVED`). PASS on any of those.

2. **Click a selector that doesn't exist**: first
   `{"action": "navigate", "payload": "data:text/html,<h1>x</h1>"}`,
   then `{"action": "click", "selector": "#does-not-exist", "timeout": 5000}`.
   The click MUST throw an error whose message contains
   `Element not found` (or equivalent: `not found`, `does not exist`).
   Silent success is a failure for this step.

3. **Eval that throws**:
   `{"action": "eval", "payload": "throw new Error('intentional')"}`.
   MUST throw; error response must contain the string `intentional`.

4. **Eval that returns a Promise rejection**:
   `{"action": "eval", "payload": "Promise.reject(new Error('rejected'))"}`.
   MUST throw; error response must contain the string `rejected`.

5. **Permission prompt**:
   `{"action": "navigate", "payload": "data:text/html,<script>Notification.requestPermission()</script>", "timeout": 15000}`.
   Modern Chrome may suppress permission prompts on `data:` URLs. The
   step PASSES on either of:
   (a) the navigate response surfaces a permission dialog and a
       follow-up `{"action": "click", "selector": "dialog::dismiss"}`
       returns without error, OR
   (b) the navigate response reports success with no dialog (Chrome
       suppressed it). Record which branch occurred.

6. **Session still alive**:
   `{"action": "navigate", "payload": "https://example.com"}` then
   `{"action": "extract", "selector": "h1", "payload": "text"}`.
   MUST succeed and contain `Example Domain`.

## Pass criteria

- Each pathological input produces a clear error (or expected dialog), not a hang and not silent success
- Session is still usable after all of them

## Failure signals

- Any step hangs >30s — bridge or Chrome wedged
- Step 2 silently succeeds — the `a9e7075` regression has returned
- Step 3/4 returns undefined instead of throwing — `throwIfExceptionDetails` migration broke
- Step 5: permission shim doesn't catch the prompt — autoAttach timing or shim install is broken
- Step 6 hangs — earlier failure cascade

Report each step's outcome. If anything hangs, kill the worker and note the last successful step.
