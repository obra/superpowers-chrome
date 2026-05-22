# Scenario 12 — Iframes and HTTPS

**Goal:** Verify HTTPS pages work (we only tested HTTP + data: URLs in earlier scenarios). Verify iframe content is accessible. Cross-origin iframes are a known CDP wrinkle worth checking explicitly.

## Setup

For the iframe test, use a fixture HTTP server:

`/tmp/iframe-parent.html`:
```html
<!doctype html>
<title>Parent</title>
<h1>parent page</h1>
<iframe id="same" src="/tmp/iframe-child.html" width="400" height="200"></iframe>
<iframe id="cross" src="https://example.com" width="400" height="200"></iframe>
<button id="b" onclick="document.getElementById('result').textContent='parent-click'">parent button</button>
<div id="result"></div>
```

`/tmp/iframe-child.html`:
```html
<!doctype html>
<title>Child</title>
<h1 id="ch1">child heading</h1>
<button id="cb" onclick="document.getElementById('cr').textContent='child-click'">child button</button>
<div id="cr"></div>
```

Serve via Python HTTP server on port 8767.

## Steps

### HTTPS
1. Navigate to `https://example.com`. Should load (just like HTTP did).
2. Extract h1 → `"Example Domain"`.
3. Take a screenshot — should be a valid PNG.

### Same-origin iframe
4. Navigate to `http://localhost:8767/iframe-parent.html`.
5. Extract h1 (the parent's) → `"parent page"`.
6. Click `#b` (the parent button). Read `#result` → `"parent-click"`.
7. **Try to extract from the same-origin iframe**: extract `#ch1` text. May or may not work — Chrome may or may not surface iframe content via the same selector. Note behavior.
8. **Try to click into the iframe**: click `#cb` (the child button). Note behavior.

### Cross-origin iframe (example.com inside the parent)
9. Try to interact with the example.com iframe (extract its h1, etc.). Cross-origin frames are typically opaque to top-level selectors. Note behavior — should fail gracefully (return null / empty), not crash.

## Pass criteria

- HTTPS pages load and are interactive
- Iframe behavior is documented: either same-origin iframe is reachable or it's a documented limitation
- Cross-origin iframe doesn't crash the session

## Failure signals

- HTTPS navigation fails → Chrome process startup issue (probably not migration-related)
- Session hangs on iframe page → iframe target attach/Fetch.requestPaused issue
- Cross-origin iframe attempt crashes the session → unhandled error in bridge target tracking

Report each part. Iframe interaction is the most ambiguous case — describe what actually happens.
