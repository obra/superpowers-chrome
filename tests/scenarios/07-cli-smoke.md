# Scenario 07 — CLI smoke

**Goal:** Verify the `chrome-ws` CLI works at all. The CLI uses the same
lib code as the MCP, so functionality should mirror it — but the CLI
entrypoint, arg parsing, and exit codes are a separate surface.

## Setup

The CLI under test lives in the branch you are exercising. The eval
harness exposes it as a symlink at a fixed path so this scenario does
not have to discover it. DO NOT use `chrome-ws` from `$PATH` or anything
under `~/.claude/plugins/cache/...` — those are older marketplace builds
and will give misleading results.

The CLI binary for this run is:
```
/tmp/bridge-bin/chrome-ws
```

Before any step, confirm it is the right one:
```bash
/tmp/bridge-bin/chrome-ws --version
```
Must print `2.2.0`. If anything else prints (including the literal usage
banner that ends with `Usage: chrome-ws raw ...`), stop and report —
the harness setup is broken; do not continue.

Throughout this scenario, use that absolute path for every invocation.
Do not abbreviate it, alias it, or rely on PATH.

## Command syntax reference

`chrome-ws` commands take a tab argument first (numeric index `0`, `1`,
... or a full `ws://` URL). The exact shapes used below:
- `start [port]` — launch Chrome
- `stop` — kill Chrome
- `tabs` — list tabs as JSON
- `navigate <tab> <url>` — navigate the tab
- `extract <tab> <selector>` — get an element's text
- `fill <tab> <selector> <text>` — fill an input
- `eval <tab> <js>` — run JS and print the result

## Steps

For each step, capture exit code and stdout. Treat any non-zero exit
code as FAIL for that step (note the exit code in the report).

1. **Help**
   ```bash
   /tmp/bridge-bin/chrome-ws --help
   ```
   Must exit 0. First non-blank line must be `Usage: chrome-ws <command> [args]`.

2. **Version**
   ```bash
   /tmp/bridge-bin/chrome-ws --version
   ```
   Must exit 0 and print exactly `2.2.0`.

3. **Start Chrome**
   ```bash
   /tmp/bridge-bin/chrome-ws start
   ```
   Must exit 0. Subsequent commands need Chrome running.

4. **List tabs**
   ```bash
   /tmp/bridge-bin/chrome-ws tabs
   ```
   Must exit 0. Output is TSV (one line per page tab, columns
   `id<TAB>url<TAB>title`) — not JSON. Pass criterion: at least one
   line, and that line contains both a target id and a URL.
   Record the index of the first tab (call it `T`); use `T` for the
   navigation/extract/eval steps below.

   If you also want the JSON-shaped view of Chrome state, that is the
   `chrome-ws info` command (separate from `tabs`).

5. **Navigate**
   ```bash
   /tmp/bridge-bin/chrome-ws navigate <T> https://example.com
   ```
   Must exit 0.

6. **Extract**
   ```bash
   /tmp/bridge-bin/chrome-ws extract <T> h1
   ```
   Must exit 0. Output must contain `Example Domain`.

7. **Eval**
   ```bash
   /tmp/bridge-bin/chrome-ws eval <T> "2 + 2"
   ```
   Must exit 0. Output must contain `4`.

8. **Stop Chrome**
   ```bash
   /tmp/bridge-bin/chrome-ws stop
   ```
   Must exit 0. After this, `chrome-ws tabs` will fail; that's expected
   and is not part of this step's pass criterion.

## Pass criteria

All 8 steps exit 0 with output matching the per-step expectation above.

## Failure signals

- Step 2 prints anything other than `2.2.0` → wrong binary; harness symlink is stale
- Step 1 prints `Usage: chrome-ws raw ...` instead of the multi-command usage → wrong binary (older marketplace 2.1.0)
- Step 8 prints `Unknown command: stop` → bridge CLI is missing the stop dispatch (regression of the fix that introduced it)
- Any "is not a function" / module errors → bundling or entry-point issue
- Bridge not initialized → CLI session setup diverged from MCP (skipped `ensureBridge`)

Report the matrix of 8 commands × pass / fail / unsupported.
