# Scenario 06 — Failure modes

**Goal:** Verify that pathological inputs and conditions fail cleanly rather than wedging the session.

## Steps

1. **Navigate to a non-existent URL**: `http://localhost:0/never`. Expect a timeout or connection-refused error, not a hang. Note what error you get.

2. **Click a selector that doesn't exist**: navigate to `data:text/html,<h1>x</h1>` then try `click('#does-not-exist')`. Per commit `a9e7075` this must NOT silently succeed — should throw with a clear "element not found" message.

3. **Evaluate code that throws**: try `evaluate('throw new Error("intentional")')`. Should throw, not silently return undefined (this was the BUG-1 fix per commit `fb0dca8` / `4ffd74d`).

4. **Evaluate code that returns a Promise rejection**: `evaluate('Promise.reject(new Error("rejected"))')`. Should also throw.

5. **Permission prompt mid-load**: navigate to a data URL that requests notification permission synchronously: `data:text/html,<script>Notification.requestPermission()</script>`. The agent should observe a permission dialog (kind: 'permission'). Try dismissing it with `dialog::dismiss`.

6. **Multiple sequential operations**: after scenarios 1-5, can you still navigate to `https://example.com` and extract the h1? If yes, the session survived all the pathological inputs.

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
