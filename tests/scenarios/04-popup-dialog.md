# Scenario 04 — Popup with synchronous dialog (HEADLINE WIN)

**Goal:** Validate the Phase F autoAttach + onPageSession + runIfWaitingForDebugger flow with a real agent driving. A page opens a popup; the popup fires `confirm()` synchronously in its first script. The dialog must be caught.

This is the scenario the unit/integration test `test/popup-dialog-integration.test.mjs` proves. This scenario verifies an **agent** can actually USE that capability.

## Setup

Create two fixture HTML files in `/tmp` and serve them via Python's HTTP
server rooted at `/tmp`. The popup's `window.open` URL must be relative
(no leading slash, no `/tmp/` prefix) because the server's URL root is
`/tmp` on the filesystem — `'popup.html'` resolves to the file you write
below; `'/tmp/popup.html'` does NOT.

Write `/tmp/popup-opener.html` with exactly this content:
```html
<!doctype html>
<title>Opener</title>
<button id="open" onclick="window.open('popup.html')">Open popup</button>
```

Write `/tmp/popup.html` with exactly this content:
```html
<!doctype html>
<title>Popup</title>
<script>
  // Fires synchronously on load. Without autoAttach + shim install,
  // this dialog would fire before our bridge could subscribe.
  window.__userChoice = confirm('Are you sure?');
</script>
```

Start the HTTP server (kill any prior server on this port first):
```bash
pkill -f "http.server 8765" 2>/dev/null; sleep 1
cd /tmp && python3 -m http.server 8765 > /tmp/popup-server.log 2>&1 &
sleep 1
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8765/popup-opener.html
# Must print 200. If anything else, fix the server before continuing.
```

## Steps

1. Navigate the main tab to `http://localhost:8765/popup-opener.html`.
2. Click `#open` — this calls `window.open()` to spawn the popup. The
   click action itself may report a CDP timeout because the popup's
   synchronous `confirm()` wedges Chrome's main thread; that's expected
   here and is NOT a failure.
3. Wait ~2 seconds, then `list_tabs`. There must be at least 2 tabs;
   one of them should be the popup (title "Popup") and one the opener
   (title "Opener"). Record their indices.
4. `switch_tab` to the popup tab. Match on `payload: "Popup"` (title
   substring) so the routing is unambiguous — do NOT rely on the
   implicit active tab.
5. Run `eval` with `payload: "document.title"` on the popup tab. The
   bridge MUST refuse with a dialog error: response text contains
   "Page is behind a dialog" AND mentions `dialog::accept` /
   `dialog::dismiss` AND quotes the `Are you sure?` prompt.
6. `click` with `selector: "dialog::accept"` on the popup tab. Must
   succeed without error.
7. `eval` with `payload: "window.__userChoice"` on the popup tab. Must
   return literal boolean `true`.

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
