# Scenario 02 — All migrated action libs

**Goal:** Exercise each migrated action lib at least once to surface any
regressions in the bridge dispatch.

## Setup

The fixture is a single data URL with one of every interactive element
the steps need. Use it verbatim — do not fall back to other URLs.

```
data:text/html,<title>libs</title><h1 id="h">Test</h1><a id="link" href="https://example.com">Link</a><input id="i" value=""><select id="s"><option value="a">A</option><option value="b">B</option></select><input id="file" type="file"><div id="result"></div>
```

This fixture has: an `<h1>`, an `<a id="link">`, an `<input id="i">`,
a `<select id="s">` with two options, an `<input id="file" type="file">`,
and a `<div id="result">`. Every step below targets one of these by id.

## Steps (one per lib)

For each step use `mcp__plugin_superpowers-chrome_chrome__use_browser`
with the listed parameters and report PASS/FAIL with the response.

1. **navigate**: `{"action": "navigate", "payload": "<data url above>"}`.
   PASS if response reports the navigation succeeded.

2. **extract text**: `{"action": "extract", "selector": "#h", "payload": "text"}`.
   PASS if result contains the string `Test`.

3. **extract html**: `{"action": "extract", "selector": null, "payload": "html"}`.
   PASS if result contains `<select id="s">`.

4. **attr**: `{"action": "attr", "selector": "#link", "payload": "href"}`.
   PASS if result is exactly `https://example.com`.

5. **eval**: `{"action": "eval", "payload": "2 + 2"}`.
   PASS if result is `4`.

6. **click**: `{"action": "click", "selector": "#link"}`. PASS if the
   action returns without error. (It may navigate the tab to
   example.com — that is fine; step 7 handles that.)

7. **back**: `{"action": "back"}`. Returns to the data URL.
   Confirm with: `{"action": "extract", "selector": "#h", "payload": "text"}`
   which must again contain `Test`. PASS if both calls succeed.

8. **type**: `{"action": "type", "selector": "#i", "payload": "hello"}`.
   Then `{"action": "eval", "payload": "document.getElementById('i').value"}`.
   PASS if eval returns `hello`.

9. **select**: `{"action": "select", "selector": "#s", "payload": "b"}`.
   Then `{"action": "eval", "payload": "document.getElementById('s').value"}`.
   PASS if eval returns `b`.

10. **set_viewport**: `{"action": "set_viewport", "payload": {"width": 800, "height": 600}}`.
    PASS if it returns without error.

11. **get_viewport**: `{"action": "get_viewport"}`.
    PASS if response reports width 800 and height 600.

12. **screenshot**: `{"action": "screenshot", "payload": "/tmp/eval-02-libs.png"}`.
    PASS if `/tmp/eval-02-libs.png` exists and is larger than 1000 bytes.

13. **clear_cookies**: `{"action": "clear_cookies"}`.
    PASS if it returns without error.

14. **file_upload**: first create `/tmp/eval-02-upload.txt` containing the
    word `hi` via Bash, then call
    `{"action": "file_upload", "selector": "#file", "payload": {"files": ["/tmp/eval-02-upload.txt"]}}`.
    PASS if it returns without error.

15. **auto-capture**: any of steps 1, 6, 8 should auto-capture; pick one
    and confirm its response mentioned a saved capture file (look for
    a `Files:` line or a `Session dir:` line).

## Pass criteria

- All 15 steps PASS by their per-step criterion above
- Any failure is reported with the exact response that failed

## Failure signals

- "is not a function" — migration broke an exported function
- CDP method errors — pageSession.send dispatch is wrong
- Hangs — the Fetch.requestPaused-continueRequest bug from F4 might have come back
- "Page is behind a dialog" when no dialog should be open — dialog state leaking

Report the matrix: 15 libs × pass / fail.
