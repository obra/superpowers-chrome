# Scenario 01 — Smoke

**Goal:** Verify the plugin loads and the bridge can drive Chrome through a basic interaction.

## Steps

1. Use the browsing skill to navigate to `https://example.com`.
2. Extract the page title text (the `<h1>`).
3. Take a screenshot. Confirm it was saved.

## Pass criteria

- Step 1 returns without error
- Step 2 returns `"Example Domain"` (or similar — that's what example.com's h1 says)
- Step 3 returns a path to a PNG file that exists and is non-empty

## Failure signals to flag

- "Bridge not initialized" — bridge bootstrapping is broken
- Timeout on navigate — Chrome isn't responding via the new transport
- Empty extract result — the migrated extraction.js is broken
- Screenshot returns no path or zero-byte file — migrated screenshot.js is broken

Report each step's exact outcome (success / failure + what specifically).
