# Scenario 12 — Iframes and HTTPS

**Goal:** Verify HTTPS pages work (earlier scenarios only used HTTP +
`data:` URLs). Verify same-origin iframe content behavior is
deterministic. Cross-origin iframes have known CDP isolation rules
worth checking explicitly.

## Setup

The iframe `src` attributes must be relative (no leading slash, no
`/tmp/` prefix). The HTTP server roots at `/tmp`; `/tmp/<file>` would
404. The relative form `iframe-child.html` resolves correctly.

Write `/tmp/iframe-parent.html` with exactly this content:
```html
<!doctype html>
<title>Parent</title>
<h1 id="ph">parent page</h1>
<iframe id="same" src="iframe-child.html" width="400" height="200"></iframe>
<iframe id="cross" src="https://example.com" width="400" height="200"></iframe>
<button id="b" onclick="document.getElementById('result').textContent='parent-click'">parent button</button>
<div id="result"></div>
```

Write `/tmp/iframe-child.html` with exactly this content:
```html
<!doctype html>
<title>Child</title>
<h1 id="ch1">child heading</h1>
<button id="cb" onclick="document.getElementById('cr').textContent='child-click'">child button</button>
<div id="cr"></div>
```

Start the server (kill any prior on this port first):
```bash
pkill -f "http.server 8767" 2>/dev/null; sleep 1
cd /tmp && python3 -m http.server 8767 > /tmp/iframe-server.log 2>&1 &
sleep 1
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8767/iframe-parent.html
# Must print 200.
```

## Steps

### HTTPS

1. `{"action": "navigate", "payload": "https://example.com"}`. PASS if
   the call returns without error.
2. `{"action": "extract", "selector": "h1", "payload": "text"}`. PASS
   if result contains `Example Domain`.
3. `{"action": "screenshot", "payload": "/tmp/eval-12-https.png"}`.
   PASS if the file exists and is larger than 1000 bytes.

### Same-origin iframe

4. `{"action": "navigate", "payload": "http://localhost:8767/iframe-parent.html"}`.
5. `{"action": "extract", "selector": "#ph", "payload": "text"}`. PASS
   if result contains `parent page`.
6. `{"action": "click", "selector": "#b"}` then
   `{"action": "extract", "selector": "#result", "payload": "text"}`.
   PASS if result contains `parent-click`.
7. **Same-origin iframe accessibility (documentation step)**:
   `{"action": "eval", "payload": "document.getElementById('same').contentDocument && document.getElementById('same').contentDocument.getElementById('ch1').textContent"}`.
   Same-origin contentDocument access is allowed by the browser, so
   this MUST return `child heading`. PASS if result contains
   `child heading`.

### Cross-origin iframe

8. `{"action": "eval", "payload": "document.getElementById('cross').contentDocument === null"}`.
   Cross-origin contentDocument is opaque to the parent. The browser
   returns `null` (not an exception). PASS if the eval returns the
   boolean `true`. (If your runtime renders it as the string `"true"`
   that's also acceptable — point is, no crash.)

## Pass criteria

- Steps 1–8 each satisfy their per-step criterion above
- Step 8 in particular must NOT crash the session — same-origin and
  cross-origin iframes should both be handled gracefully

## Failure signals

- HTTPS navigation fails → Chrome process startup or cert issue
- Step 7 throws or returns empty → CDP can't access same-origin frame DOM
- Step 8 throws / hangs → cross-origin opacity path is mishandled
