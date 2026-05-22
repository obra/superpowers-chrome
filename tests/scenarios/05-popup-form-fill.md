# Scenario 05 — Popup form fill (OAuth-shape flow)

**Goal:** Drive an OAuth-shaped flow: main page → click sign-in → popup with a form → fill + submit → popup closes → main page updates.

## Setup

Create three fixtures in /tmp:

`/tmp/oauth-main.html`:
```html
<!doctype html>
<title>Main</title>
<button id="signin" onclick="window.signinWin = window.open('/tmp/oauth-popup.html', 'signin')">Sign in</button>
<div id="status">not signed in</div>
<script>
  // Poll until popup posts a message
  window.addEventListener('message', (e) => {
    if (e.data && e.data.signedIn) document.getElementById('status').textContent = 'signed in as ' + e.data.user;
  });
</script>
```

`/tmp/oauth-popup.html`:
```html
<!doctype html>
<title>Sign in</title>
<form id="f" onsubmit="event.preventDefault(); document.getElementById('msg').textContent='submitting...'; setTimeout(() => { window.opener.postMessage({signedIn:true, user: document.getElementById('u').value}, '*'); window.close(); }, 100);">
  <input id="u" placeholder="username">
  <input id="p" type="password" placeholder="password">
  <button id="submit" type="submit">Sign in</button>
</form>
<div id="msg"></div>
```

Serve via the same Python HTTP server as scenario 04 (port 8765).

## Steps

1. Navigate to `http://localhost:8765/oauth-main.html`
2. Read `#status` text → should be `"not signed in"`
3. Click `#signin` — opens the popup
4. Wait briefly. List tabs — should have the popup
5. On the popup tab: fill `#u` with `"jesse"`, fill `#p` with `"secret123"`
6. On the popup tab: click `#submit`
7. Popup will close itself after posting message. Wait briefly.
8. List tabs — popup should be gone
9. On the main tab: read `#status` text → should be `"signed in as jesse"`

## Pass criteria

- Popup is discoverable and addressable as a tab
- Fill works on the popup
- Click submits and the popup closes
- Main tab's status updates from the postMessage

## Failure signals

- Popup not found in tab list — autoAttach not surfacing it
- Fill on popup fails — pageSession resolver for popup tab not working
- After popup close, getting CDP errors when accessing it — closeTab cleanup issue
- Main tab status never updates — postMessage cross-window communication broken (probably not our fault but worth noting)

Report the trace.
