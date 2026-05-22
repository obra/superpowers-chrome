# Scenario 01 — Smoke

**Goal:** Verify the plugin loads and the bridge can drive Chrome through a basic interaction.

## Steps

1. Use the `use_browser` MCP tool to navigate to `https://example.com`.
   `{"action": "navigate", "payload": "https://example.com"}`.
2. Extract the `<h1>` text:
   `{"action": "extract", "selector": "h1", "payload": "text"}`.
3. Take a screenshot saved to `/tmp/eval-smoke-screenshot.png`:
   `{"action": "screenshot", "payload": "/tmp/eval-smoke-screenshot.png"}`.

## Pass criteria

- Step 1 returns without error
- Step 2 result contains the exact string `Example Domain`
- Step 3 returns successfully; `/tmp/eval-smoke-screenshot.png` exists and
  is larger than 1000 bytes

## Failure signals to flag

- "Bridge not initialized" — bridge bootstrapping is broken
- Timeout on navigate — Chrome isn't responding via the new transport
- Empty extract result — the migrated extraction.js is broken
- Screenshot returns no path or zero-byte file — migrated screenshot.js is broken

Report each step's exact outcome (success / failure + what specifically).
