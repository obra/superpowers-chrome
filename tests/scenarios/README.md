# Agent-driven test scenarios

Each scenario is a self-contained prompt you can hand to a Claude Code worker. The worker drives the superpowers-chrome plugin's `use_browser` MCP tool. Each scenario produces an observable trace that we read back to verify behavior.

The point isn't to verify the unit tests (those run in CI). The point is to verify the **agent experience** — can an agent with no internal knowledge use the plugin to do realistic browser work?

## Running

Use claude-session-driver with `--plugin-dir` pointing at this worktree:

```bash
csd launch test-worker /tmp -- --plugin-dir /path/to/superpowers-chrome.bridge
/tmp/claude-workers/bin/test-worker converse "Read tests/scenarios/<scenario>.md and execute it. Report each step's outcome." 600
```

Then read the worker's events to inspect what tool calls it made:

```bash
/tmp/claude-workers/bin/test-worker read-events --type pre_tool_use
```

## Scenarios

| File | What it exercises | Headline |
|---|---|---|
| `01-smoke.md` | Bridge init + navigate + extract | Does it start? |
| `02-action-libs.md` | All 12 migrated action libs | Did anything break? |
| `03-dialog-confirm.md` | JS `confirm()` dialog handling | Dialog system still works |
| `04-popup-dialog.md` | Popup + synchronous-fire dialog | **The Phase F headline win** |
| `05-popup-form-fill.md` | Open popup, fill form, submit, close | OAuth-shape flow |
| `06-failure-modes.md` | Chrome death, timeout, permission | Pathological cases |
