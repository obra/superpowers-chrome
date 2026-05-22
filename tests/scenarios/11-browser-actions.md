# Scenario 11 — Browser-target actions

**Goal:** Exercise `show_browser`, `hide_browser`, `browser_mode`, `set_profile`, `get_profile`, `back`, `setViewport`, `getViewport`. Scenario 02's worker noted that `back`, `setViewport`, `getViewport` aren't reachable via `use_browser` — explicitly verify whether that's MCP gap or skill prose gap.

## Steps

### Profile management
1. `get_profile` — returns current profile name (likely the default).
2. `set_profile("test-bridge-profile")` — sets a profile name.
3. `get_profile` again — should return the new name.

### Browser mode / show / hide
4. `browser_mode` (or `get_browser_mode`) — returns current headless/headed state.
5. If headless: `show_browser` — should switch to headed mode. (May restart Chrome.)
6. `browser_mode` again — should reflect the change.
7. `hide_browser` — switch back. (May restart Chrome.)

### Viewport (verify the worker's gap observation)
8. Try `set_viewport({width:800, height:600})` — does the use_browser tool accept this action name? If yes, verify it works. If no, note the action name doesn't exist.
9. Try `get_viewport` — same question.
10. If `set_viewport`/`get_viewport` aren't reachable via use_browser but ARE implemented in the lib, document the gap.

### Back navigation
11. Navigate to two URLs in sequence:
    - `data:text/html,<h1>first</h1>`
    - `data:text/html,<h1>second</h1>`
12. `back` — go back one history entry (tab is implicit via activeTab).
13. After back, extract h1 → should be `first`.
14. `forward` — go forward one entry. Extract h1 → should be `second`.

## Pass criteria

- Profile get/set round-trips
- show/hide_browser changes the mode
- Each "is it reachable" question gets a definitive yes/no

## Failure signals

- Any of these throws → check the BROWSER_TARGET_ACTIONS set in dialogs.js for the action name
- Profile/mode actions exist but don't actually change state → migration broke the underlying call

Report the matrix. For unreachable actions, explicitly flag them as gaps to address before release.
