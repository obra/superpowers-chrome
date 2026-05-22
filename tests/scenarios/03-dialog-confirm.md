# Scenario 03 — JS confirm() dialog

**Goal:** Verify the dialog subsystem works on the bridge: a page fires `confirm()`, the agent sees the dialog, the agent dismisses it via the `dialog::*` selector grammar.

## Setup

Navigate to this fixture (you can use a data: URL):

```
data:text/html,<title>Dialog test</title><button id="ask" onclick="window.__answer = confirm('Proceed?')">Ask</button><div id="result"></div><script>setInterval(() => {if (window.__answer !== undefined) document.getElementById('result').textContent = 'answer=' + window.__answer;}, 100);</script>
```

## Steps

1. `{"action": "navigate", "payload": "<data URL from Setup>"}`.
2. `{"action": "click", "selector": "#ask"}` — fires `confirm()`. The
   click may report a CDP timeout because the dialog blocks the main
   thread; that is expected here and is NOT a failure.
3. `{"action": "extract", "selector": "#result", "payload": "text"}`.
   The response MUST refuse with a dialog error: the response text
   must contain all of these substrings:
   - `Page is behind a dialog`
   - `dialog::accept`
   - `dialog::dismiss`
   - the literal prompt text `Proceed?`
4. `{"action": "click", "selector": "dialog::accept"}`. Must return
   without error. (Do NOT click `#ask` again — `dialog::*` is the
   special selector for handling dialogs.)
5. Wait 500ms for the page's polling interval to update `#result`.
6. `{"action": "extract", "selector": "#result", "payload": "text"}`.
   PASS if the result contains the exact substring `answer=true`.

## Pass criteria

- Step 3's response contains all four required substrings listed above
- Step 4's `dialog::accept` returns a success result, not an error
- Step 6 result contains `answer=true`

## Failure signals

- Step 2 hangs the entire session — dialog NOT being observed, CDP wedged (this would be the bug we're trying to prevent)
- Step 3 succeeds (no refusal) — dialog isn't being detected, or the dialog gate isn't working
- Step 4 fails with "no dialog open" — sessionId-keyed dialog state isn't being populated
- Step 6 returns `"answer=undefined"` or empty — accept didn't actually accept

Report each step's outcome and any error messages verbatim.
