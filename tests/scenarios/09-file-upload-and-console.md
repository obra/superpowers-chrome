# Scenario 09 — File upload + console logging

**Goal:** Exercise `file_upload`, `enable_console_logging`,
`get_console_messages`, `clear_console_messages` via the MCP.

## Setup

Create the upload fixture (always rewrite so size is known):
```bash
printf 'hello upload\n' > /tmp/upload-test.txt
wc -c /tmp/upload-test.txt   # must print "13 /tmp/upload-test.txt"
```

The page fixture is a data URL with a file input and a script that
emits three console messages on every load (log + warn + error):
```
data:text/html,<title>Upload+console test</title><input id="f" type="file"><div id="info"></div><script>console.log('initial-load');console.warn('a-warning');console.error('an-error');document.getElementById('f').addEventListener('change', (e) => { const f = e.target.files[0]; document.getElementById('info').textContent = f ? f.name + ':' + f.size : 'no-file'; console.log('file-changed:' + (f ? f.name : 'none')); });</script>
```

## Steps

### File upload

1. `{"action": "navigate", "payload": "<data URL above>"}`.
2. `{"action": "file_upload", "selector": "#f", "payload": {"files": ["/tmp/upload-test.txt"]}}`.
   PASS if the call returns without error.
3. `{"action": "extract", "selector": "#info", "payload": "text"}`.
   PASS if the result contains `upload-test.txt:13`.
4. `{"action": "eval", "payload": "document.getElementById('f').files[0].name"}`.
   PASS if the result is exactly `upload-test.txt`.

### Console logging

5. `{"action": "enable_console_logging"}`. PASS if the call returns
   without error.
6. `{"action": "navigate", "payload": "<same data URL>"}`. Re-running
   the page triggers the three console calls again under the
   capture-enabled session.
7. Sleep 500ms, then
   `{"action": "get_console_messages"}`. The response MUST include all
   three of these substrings: `initial-load`, `a-warning`, `an-error`.
   Each entry should also include a level (`log`, `warn`, `error`).
   PASS if every substring is present.
8. Record the current epoch ms as `T`. Sleep 500ms. Issue another
   `{"action": "navigate", "payload": "<same data URL>"}`. Then
   `{"action": "get_console_messages", "payload": {"since": T}}`. The
   response MUST include only entries from the second navigation —
   i.e., the entries with timestamps >= T. PASS if at least one entry
   is returned AND none of the entries predate T.
9. `{"action": "clear_console_messages"}`. Returns without error.
10. `{"action": "get_console_messages"}`. PASS if no `initial-load` /
    `a-warning` / `an-error` substrings remain (the response may say
    "no console messages captured" or list zero entries).

## Pass criteria

- Steps 1–10 each satisfy their per-step criterion above

## Failure signals

- file_upload throws → DOM.setFileInputFiles dispatch broken in the migrated file-upload.js
- Console messages missing → console-logging.js's pageSession.onEvent subscription not capturing
- Levels wrong → arg-format logic broken in the migration
- since-filter not applied → filter logic broken

Report each step's outcome.
