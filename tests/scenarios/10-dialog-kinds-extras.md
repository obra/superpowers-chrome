# Scenario 10 — Dialog kinds we didn't exercise

**Goal:** Cover `dialog::dismiss` for JS dialogs, `beforeunload` confirms, basic-auth challenges. (Device-chooser requires real hardware — skip.)

## Steps

### Part A: dialog::dismiss

1. `{"action": "navigate", "payload": "data:text/html,<button id=ask onclick=\"window.__a=confirm('Cancel?')\">A</button>"}`.
2. `{"action": "click", "selector": "#ask"}` — triggers confirm. The
   click may report a CDP timeout (dialog blocks the main thread);
   that is expected.
3. `{"action": "click", "selector": "dialog::dismiss"}`. Must return
   without error.
4. `{"action": "eval", "payload": "window.__a"}`. PASS if result is
   exactly `false`.

### Part B: beforeunload

Note: modern Chrome suppresses `beforeunload` confirms on `data:` URLs
without prior user interaction. Part B is allowed to mark itself N/A
when no beforeunload dialog fires; that is not a failure.

1. `{"action": "navigate", "payload": "data:text/html,<title>BeforeUnload</title><script>window.addEventListener('beforeunload', e => { e.preventDefault(); return 'sure?'; })</script><div>loaded</div>"}`.
2. `{"action": "navigate", "payload": "https://example.com"}`.
3. If the navigate response surfaces a `beforeunload` dialog, dismiss
   it with `{"action": "click", "selector": "dialog::dismiss"}` and
   then `{"action": "eval", "payload": "location.href"}` — PASS if
   the URL still references the `data:` document.
4. If no dialog surfaces (the typical modern-Chrome case), confirm we
   landed on example.com via
   `{"action": "extract", "selector": "h1", "payload": "text"}`
   containing `Example Domain`. Record this as **N/A — Chrome
   suppressed beforeunload from a data: URL**, not as failure.

### Part C: Basic-auth challenge

Set up a basic-auth HTTP server.

Write `/tmp/basic_auth_server.py` with exactly this content:
```python
import base64, http.server
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        auth = self.headers.get('Authorization', '')
        if not auth.startswith('Basic '):
            self.send_response(401)
            self.send_header('WWW-Authenticate', 'Basic realm="Test"')
            self.end_headers()
            self.wfile.write(b'denied')
            return
        u, _, _ = base64.b64decode(auth[6:]).decode().partition(':')
        self.send_response(200)
        self.send_header('Content-type', 'text/html')
        self.end_headers()
        self.wfile.write(f'<h1>hi {u}</h1>'.encode())
http.server.HTTPServer(('127.0.0.1', 8766), H).serve_forever()
```

Start it (kill any prior server on 8766 first):
```bash
pkill -f basic_auth_server.py 2>/dev/null; sleep 1
python3 /tmp/basic_auth_server.py > /tmp/basic-auth.log 2>&1 &
sleep 1
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8766/
# Must print 401.
```

1. `{"action": "navigate", "payload": "http://localhost:8766/", "timeout": 15000}`.
   The navigate is expected to be intercepted by the bridge's basic-auth
   dialog; the response should surface a `kind: 'basic-auth'` dialog.
   PASS if the navigate response includes the string `basic-auth` or
   `dialog::username` (the dialog's selector grammar mentions both).
2. `{"action": "type", "selector": "dialog::username", "payload": "alice"}`.
   Must return without error.
3. `{"action": "type", "selector": "dialog::password", "payload": "secret"}`.
   Must return without error.
4. `{"action": "click", "selector": "dialog::accept"}`. Must return
   without error.
5. `{"action": "extract", "selector": "h1", "payload": "text"}`.
   PASS if result contains `hi alice`.

## Pass criteria

- Part A: step 4 returns exactly `false`
- Part B: either a beforeunload dialog appears and dismiss keeps us on
  the data: URL, OR the navigate succeeds with no dialog and Part B is
  marked N/A. Both outcomes are passes.
- Part C: step 1 response mentions `basic-auth` / `dialog::username`,
  steps 2–4 succeed, step 5 extract contains `hi alice`.

## Failure signals

- dialog::dismiss not finding the dialog → state lookup bug
- basic-auth not surfaced as a dialog → Fetch.authRequired handler bug in dialogs.js
- Username/password not staged → dialogs-router.js stage logic broken

Report results per part. If Part B is N/A, note that.
