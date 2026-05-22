# Scenario 13 — Multiple tabs interleaved + service worker

**Goal:** Verify the bridge handles multiple tabs correctly with interleaved operations (no state leak between tabs). Verify that pages registering service workers don't break the session (Phase F's `type === 'page'` gate filters non-page targets from autoAttach — this exercises that gate).

## Steps

### Part A: Multi-tab interleaved
1. Open 3 tabs via `new_tab`:
   - Tab 0: `data:text/html,<h1>alpha</h1><input id="i">`
   - Tab 1: `data:text/html,<h1>beta</h1><input id="i">`
   - Tab 2: `data:text/html,<h1>gamma</h1><input id="i">`
2. `list_tabs` — should show 3 (plus any default Chrome tab)
3. Interleave fills:
   - `fill(tab_0, '#i', 'A')`
   - `fill(tab_1, '#i', 'B')`
   - `fill(tab_0, '#i', 'A-updated')`  (back to tab 0)
   - `fill(tab_2, '#i', 'C')`
4. Verify each tab's input value via eval:
   - Tab 0 should be `"A-updated"`
   - Tab 1 should be `"B"`
   - Tab 2 should be `"C"`
5. Close tab 1 via `close_tab`. List tabs — should show 2.
6. Verify tab 0 and tab 2 still respond correctly (extract h1 from each).

### Part B: Service worker
1. Open a new tab with a service-worker-registering page. Use this fixture (data URLs can't register SWs, so use a fixture server, OR use one of these known SW-registering sites):
   - `https://www.youtube.com` (registers an SW)
   - Or a local fixture if you can serve one
2. Wait for the page to load and any SW to register.
3. Verify the bridge isn't broken — interact with the page normally (extract title, click something).
4. List tabs — the service worker target should NOT appear as a tab (only page targets should).
5. Take a screenshot to verify everything is working.

## Pass criteria

- Multi-tab fills land on the correct tabs (no cross-tab state)
- close_tab cleans up cleanly; remaining tabs still work
- Service-worker page loads and interacts correctly
- Service worker doesn't appear in list_tabs
- No "Page.enable wasn't found" errors (the F4 fix prevented these for SW targets)

## Failure signals

- Tab cross-contamination (e.g., tab 0's value lands in tab 1) → pageSession cache issue
- close_tab leaves CDP errors → cleanup ordering bug
- SW page crashes / hangs → autoAttach gate broken
- "Page.enable wasn't found" errors → the F4 type-gate is broken

Report each part.
