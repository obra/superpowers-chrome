# Scenario 10 — Dialog kinds we didn't exercise

**Goal:** Cover `dialog::dismiss` for JS dialogs, `beforeunload` confirms, basic-auth challenges. (Device-chooser requires real hardware — skip.)

## Steps

### Part A: dialog::dismiss

1. Navigate to `data:text/html,<button id=ask onclick="window.__a=confirm('Cancel?')">A</button>`
2. Click `#ask` (triggers confirm)
3. Use `dialog::dismiss` — should accept the dismissal
4. Eval `window.__a` → should be `false`

### Part B: beforeunload

1. Navigate to `data:text/html,<title>BeforeUnload</title><script>window.addEventListener('beforeunload', e => { e.preventDefault(); return 'sure?'; })</script><div>loaded</div>`
2. After loading, try to navigate away to `https://example.com`
3. Chrome may fire a beforeunload confirm. The dialog system should observe it as `kind: 'beforeunload'`.
4. Use `dialog::dismiss` to cancel navigation, or `dialog::accept` to allow.
5. Verify we ended up at example.com if accepted, or still on the data URL if dismissed.

Note: modern Chrome may suppress beforeunload from data: URLs without user interaction. If that happens, mark it N/A and try with a real HTTP server fixture.

### Part C: Basic-auth challenge

Set up a tiny HTTP server with HTTP basic auth:

```python
# /tmp/basic_auth_server.py
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
        u, _, p = base64.b64decode(auth[6:]).decode().partition(':')
        self.send_response(200)
        self.send_header('Content-type', 'text/html')
        self.end_headers()
        self.wfile.write(f'<h1>hi {u}</h1>'.encode())
http.server.HTTPServer(('127.0.0.1', 8766), H).serve_forever()
```

Run it: `python3 /tmp/basic_auth_server.py &`

1. Navigate to `http://localhost:8766/`. Chrome will receive 401 + WWW-Authenticate.
2. Bridge should observe an auth challenge as `kind: 'basic-auth'` (via Fetch.requestPaused with authChallenge).
3. `type dialog::username "alice"` — stage username
4. `type dialog::password "secret"` — stage password
5. `click dialog::accept` — submit credentials
6. Page should load with `<h1>hi alice</h1>` — verify via extract

## Pass criteria

- dialog::dismiss works for confirm; returns expected `false`
- beforeunload either fires + handles correctly, OR is N/A on data: URL (note which)
- basic-auth dialog is surfaced; username/password staging works; accept submits

## Failure signals

- dialog::dismiss not finding the dialog → state lookup bug
- basic-auth not surfaced as a dialog → Fetch.requestPaused authChallenge handler bug in dialogs.js
- Username/password not staged → dialogs-router.js stage logic broken

Report results per part. If beforeunload is N/A, note that.
