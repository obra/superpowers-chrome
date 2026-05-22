# Scenario 13 — Multi-tab interleaved + service worker

**Goal:** Verify the bridge handles multiple tabs correctly with
interleaved operations (no state leak between tabs). Verify that
pages registering service workers don't break the session — Phase F's
`type === 'page'` gate filters non-page targets from autoAttach, which
this exercises.

## Setup

For Part B, write `/tmp/sw-page.html` with exactly this content:
```html
<!doctype html>
<title>SWPage</title>
<h1 id="h">sw page</h1>
<div id="status">pending</div>
<script>
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(reg => {
      document.getElementById('status').textContent = 'sw-registered';
    }).catch(err => {
      document.getElementById('status').textContent = 'sw-error:' + err.message;
    });
  } else {
    document.getElementById('status').textContent = 'no-sw-support';
  }
</script>
```

Write `/tmp/sw.js` with exactly this content:
```js
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
```

Start the server (reuse the scenario-04 one on 8765 if present):
```bash
pgrep -f "http.server 8765" > /dev/null || (cd /tmp && python3 -m http.server 8765 > /tmp/popup-server.log 2>&1 &)
sleep 1
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8765/sw-page.html
# Must print 200.
```

## Steps

### Part A: Multi-tab interleaved

1. Open three tabs in this order (each call may switch the active tab
   to the newly created one — that's fine, switch_tab below makes
   routing explicit):
   - `{"action": "new_tab", "payload": "data:text/html,<title>alpha</title><h1>alpha</h1><input id=\"i\" value=\"\">"}`.
   - `{"action": "new_tab", "payload": "data:text/html,<title>beta</title><h1>beta</h1><input id=\"i\" value=\"\">"}`.
   - `{"action": "new_tab", "payload": "data:text/html,<title>gamma</title><h1>gamma</h1><input id=\"i\" value=\"\">"}`.

2. `{"action": "list_tabs"}`. PASS if alpha, beta, gamma are all listed.

3. Interleave fills using switch_tab + type. After each fill, eval the
   input value to confirm it stuck on that tab.
   - `{"action": "switch_tab", "payload": "alpha"}`,
     then `{"action": "type", "selector": "#i", "payload": "A"}`.
   - `{"action": "switch_tab", "payload": "beta"}`,
     then `{"action": "type", "selector": "#i", "payload": "B"}`.
   - `{"action": "switch_tab", "payload": "alpha"}`,
     clear via `{"action": "eval", "payload": "document.getElementById('i').value = ''"}`,
     then `{"action": "type", "selector": "#i", "payload": "A-updated"}`.
   - `{"action": "switch_tab", "payload": "gamma"}`,
     then `{"action": "type", "selector": "#i", "payload": "C"}`.

4. Verify each input value:
   - `switch_tab alpha`, eval `document.getElementById('i').value` → must contain `A-updated`.
   - `switch_tab beta`,  eval `document.getElementById('i').value` → must contain `B`.
   - `switch_tab gamma`, eval `document.getElementById('i').value` → must contain `C`.

5. With gamma active, `{"action": "close_tab"}`. Then `list_tabs` — PASS
   if no remaining tab has title `gamma`.

6. `switch_tab alpha`, extract `h1` → must contain `alpha`. Then
   `switch_tab beta`, extract `h1` → must contain `beta`.

### Part B: Service worker

7. `{"action": "new_tab", "payload": "http://localhost:8765/sw-page.html"}`.
8. Sleep 1500ms to let the SW register.
9. `{"action": "extract", "selector": "#status", "payload": "text"}`.
   PASS if result contains `sw-registered`.
10. `{"action": "eval", "payload": "Boolean(navigator.serviceWorker.controller || navigator.serviceWorker.getRegistration())"}`.
    PASS if the eval succeeds (the boolean may be `true` or
    `false`/Promise depending on timing — what matters is no error).
11. `{"action": "list_tabs"}`. PASS if every listed entry has
    `type: "page"`. There must be NO entry with `type: "service_worker"`,
    `type: "worker"`, or similar.
12. `{"action": "screenshot", "payload": "/tmp/eval-13-sw.png"}`.
    PASS if the file exists and is larger than 1000 bytes.

## Pass criteria

- Steps 1–12 each satisfy their per-step criterion above

## Failure signals

- Step 3 fills land on the wrong tab — switch_tab routing or pageSession cache leaks across tabs
- Step 5 close_tab leaves CDP errors — cleanup ordering bug
- Step 9 status does not become `sw-registered` — SW registration failed (unrelated to the bridge, but record it)
- Step 11 surfaces a non-page target — the `type === 'page'` autoAttach gate (F4) is broken; this is the signal the scenario was designed for
- Any step hangs — pageSession routing is broken

Report each part.
