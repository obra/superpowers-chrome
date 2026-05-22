# Scenario 03 — JS confirm() dialog

**Goal:** Verify the dialog subsystem works on the bridge: a page fires `confirm()`, the agent sees the dialog, the agent dismisses it via the `dialog::*` selector grammar.

## Setup

Navigate to this fixture (you can use a data: URL):

```
data:text/html,<title>Dialog test</title><button id="ask" onclick="window.__answer = confirm('Proceed?')">Ask</button><div id="result"></div><script>setInterval(() => {if (window.__answer !== undefined) document.getElementById('result').textContent = 'answer=' + window.__answer;}, 100);</script>
```

## Steps

1. Navigate to the data URL.
2. Click `#ask`. This will fire `confirm()`. Chrome will block — the page can't continue until the dialog is handled.
3. Attempt to do something page-targeted (like `extractText('#result')`). It should be **refused** with a clear error mentioning "dialog" and "dialog::accept" / "dialog::dismiss". Note exactly what error you get.
4. Handle the dialog: click `dialog::accept` (NOT `#ask` again — `dialog::*` is the special selector for handling dialogs).
5. After dialog handled, the page should resume. Wait a moment.
6. Extract `#result`'s text — should be `"answer=true"`.

## Pass criteria

- Step 3's refusal mentions the dialog and the `dialog::` selector grammar
- Step 4's `dialog::accept` returns a success result, not an error
- Step 6 returns `"answer=true"`

## Failure signals

- Step 2 hangs the entire session — dialog NOT being observed, CDP wedged (this would be the bug we're trying to prevent)
- Step 3 succeeds (no refusal) — dialog isn't being detected, or the dialog gate isn't working
- Step 4 fails with "no dialog open" — sessionId-keyed dialog state isn't being populated
- Step 6 returns `"answer=undefined"` or empty — accept didn't actually accept

Report each step's outcome and any error messages verbatim.
