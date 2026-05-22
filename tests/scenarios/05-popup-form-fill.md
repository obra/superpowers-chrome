# Scenario 05 — Popup form fill (OAuth-shape flow)

**Goal:** Drive an OAuth-shaped flow: main page → click sign-in → popup
with a form → fill + submit → popup closes → main page updates.

## Setup

Write `/tmp/oauth-main.html` with exactly this content:
```html
<!doctype html>
<title>OAuthMain</title>
<button id="signin" onclick="window.signinWin = window.open('oauth-popup.html', 'signin')">Sign in</button>
<div id="status">not signed in</div>
<script>
  window.addEventListener('message', (e) => {
    if (e.data && e.data.signedIn) document.getElementById('status').textContent = 'signed in as ' + e.data.user;
  });
</script>
```

Write `/tmp/oauth-popup.html` with exactly this content:
```html
<!doctype html>
<title>OAuthPopup</title>
<form id="f" onsubmit="event.preventDefault(); document.getElementById('msg').textContent='submitting...'; setTimeout(() => { window.opener.postMessage({signedIn:true, user: document.getElementById('u').value}, '*'); window.close(); }, 100);">
  <input id="u" placeholder="username">
  <input id="p" type="password" placeholder="password">
  <button id="submit" type="submit">Sign in</button>
</form>
<div id="msg"></div>
```

The popup URL is `oauth-popup.html` (relative, no leading slash). With
the Python HTTP server rooted at `/tmp`, `/tmp/oauth-popup.html` would
resolve to `/tmp/tmp/oauth-popup.html` → 404. Use the relative form.

Start the server (reuse if scenario 04 already started one on 8765):
```bash
pgrep -f "http.server 8765" > /dev/null || (cd /tmp && python3 -m http.server 8765 > /tmp/popup-server.log 2>&1 &)
sleep 1
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8765/oauth-main.html
# Must print 200.
```

## Steps

1. `{"action": "navigate", "payload": "http://localhost:8765/oauth-main.html"}`.
2. `{"action": "extract", "selector": "#status", "payload": "text"}`.
   PASS if result contains `not signed in`.
3. `{"action": "click", "selector": "#signin"}`. Opens the popup.
4. Sleep 1s, then `{"action": "list_tabs"}`. PASS if the response lists
   at least one tab whose title contains `OAuthPopup`. Record both tabs.
5. `{"action": "switch_tab", "payload": "OAuthPopup"}`. PASS if the
   response confirms the switch.
6. On the popup tab:
   `{"action": "type", "selector": "#u", "payload": "jesse"}`,
   then `{"action": "type", "selector": "#p", "payload": "secret123"}`.
   Both must return without error.
7. On the popup tab: `{"action": "click", "selector": "#submit"}`. The
   form submits and the popup closes itself after ~100ms.
8. Sleep 1s, then `{"action": "list_tabs"}`. PASS if no tab title
   contains `OAuthPopup` (the popup is gone).
9. `{"action": "switch_tab", "payload": "OAuthMain"}` to return to the
   main tab, then
   `{"action": "extract", "selector": "#status", "payload": "text"}`.
   PASS if result contains `signed in as jesse`.

## Pass criteria

- Step 2: `not signed in` present in response
- Step 4: at least one tab title contains `OAuthPopup`
- Step 6: both `type` calls succeed
- Step 7: click succeeds
- Step 8: no remaining tab titled `OAuthPopup`
- Step 9: `signed in as jesse` present in response

## Failure signals

- Step 4 missing the popup tab — autoAttach not surfacing it
- Step 6 fails on the popup — pageSession resolver for popup tab not working
- Step 8 still lists the popup — closeTab cleanup is broken
- Step 9 still says "not signed in" — postMessage didn't survive popup close

Report the trace.
