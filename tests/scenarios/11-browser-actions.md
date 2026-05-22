# Scenario 11 — Browser-target actions

**Goal:** Exercise `browser_mode`, `set_profile`, `get_profile`,
`set_viewport`, `get_viewport`, `back`, `forward`. These are all
reachable via the `use_browser` MCP tool — this scenario locks in
that the dispatch is wired and the underlying state changes.

`show_browser` and `hide_browser` are intentionally NOT exercised in
this scenario because they restart Chrome with a different headless
mode and would mid-run-invalidate other state. Test them by hand if
needed.

## Steps

For each step issue the listed `use_browser` call and check the
per-step criterion.

### Profile

1. `{"action": "get_profile"}`. Record the returned profile name as
   `P0` (whatever it is). PASS if a profile name comes back.
2. `{"action": "set_profile", "payload": "test-bridge-profile"}`.
   PASS if it returns without error.
3. `{"action": "get_profile"}`. PASS if the response contains
   `test-bridge-profile`.
4. `{"action": "set_profile", "payload": "<P0 from step 1>"}` to
   restore. PASS if it returns without error.

### Browser mode

5. `{"action": "browser_mode"}`. Response is JSON with fields
   including `mode` (`headless` or `headed`), `running`, `pid`,
   `port`, `profile`, `profileDir`. PASS if the response parses as
   JSON containing all six keys.

### Viewport

6. `{"action": "set_viewport", "payload": {"width": 800, "height": 600}}`.
   PASS if it returns without error.
7. `{"action": "get_viewport"}`. PASS if the response reports
   `width: 800` and `height: 600`.
8. `{"action": "clear_viewport"}`. PASS if it returns without error.

### Back / forward

9. `{"action": "navigate", "payload": "data:text/html,<h1>first</h1>"}`.
10. `{"action": "navigate", "payload": "data:text/html,<h1>second</h1>"}`.
11. `{"action": "back"}`. Sleep 200ms.
12. `{"action": "extract", "selector": "h1", "payload": "text"}`.
    PASS if result contains `first`.
13. `{"action": "forward"}`. Sleep 200ms.
14. `{"action": "extract", "selector": "h1", "payload": "text"}`.
    PASS if result contains `second`.

## Pass criteria

- Steps 1–14 each satisfy their per-step criterion above

## Failure signals

- set_profile / get_profile don't round-trip → profile state is not
  persisted between calls
- browser_mode response missing keys → getBrowserMode contract changed
- get_viewport doesn't reflect set_viewport → viewport plumbing broken
- back/forward extract returns the wrong h1 → history navigation broken
