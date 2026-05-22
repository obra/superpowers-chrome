# Scenario 04 — Popup with synchronous dialog (HEADLINE WIN)

**Goal:** Validate the Phase F autoAttach + onPageSession + runIfWaitingForDebugger flow with a real agent driving. A page opens a popup; the popup fires `confirm()` synchronously in its first script. The dialog must be caught.

This is the scenario the unit/integration test `test/popup-dialog-integration.test.mjs` proves. This scenario verifies an **agent** can actually USE that capability.

## Setup

Create two fixture HTML files in /tmp (one-shot):

`/tmp/popup-opener.html`:
```html
<!doctype html>
<title>Opener</title>
<button id="open" onclick="window.open('/tmp/popup.html')">Open popup</button>
```

`/tmp/popup.html`:
```html
<!doctype html>
<title>Popup</title>
<script>
  // Fires synchronously on load. Without autoAttach + shim install,
  // this dialog would fire before our bridge could subscribe.
  window.__userChoice = confirm('Are you sure?');
</script>
```

You can serve them via a tiny Python HTTP server:
```bash
cd /tmp && python3 -m http.server 8765 &
```

Or use a `file://` URL if window.open works with file:// (it may not — try HTTP first).

## Steps

1. Navigate the main tab to `http://localhost:8765/popup-opener.html`.
2. Click `#open` — this calls `window.open()` to spawn the popup.
3. Wait a couple seconds for the popup to load and its inline script to fire `confirm()`.
4. List tabs — there should now be at least 2 (opener + popup).
5. Check whether the popup's `confirm()` dialog was caught. Approach: try to do any page action on the popup tab and see if it's refused with the dialog error.
6. Handle the dialog on the popup tab using `dialog::accept`.
7. Confirm the popup's `window.__userChoice` is `true` by evaluating it in the popup tab.

## Pass criteria

- Step 4: popup tab exists in the list
- Step 5: page action is refused with a dialog error mentioning "confirm" / "Are you sure" / "dialog::"
- Step 6: dialog accept works
- Step 7: evaluates to `true`

## Failure signals — IMPORTANT

If step 5 does NOT show the dialog as detected:
- The popup's synchronous dialog fired BEFORE our autoAttach handler installed the shim
- This is the exact failure mode Phase F was designed to prevent
- This is HIGH SIGNIFICANCE — flag it loudly

Report step-by-step. If step 5 fails, note exactly what error you got from the page action (or if it just hung / returned empty / etc).
