# Scenario 07 — CLI smoke

**Goal:** Verify the `chrome-ws` CLI works at all. The CLI uses the same lib code as the MCP, so functionality should mirror it; but the CLI entrypoint, arg parsing, and exit codes are a separate surface.

## Setup

The CLI binary is exposed by the plugin at `skills/browsing/chrome-ws.cjs` (or similar — check `package.json` "bin"). You can invoke it directly via `node skills/browsing/chrome-ws.cjs` or whatever the plugin documents.

Look at `skills/browsing/COMMANDLINE-USAGE.md` for the documented commands.

## Steps

1. **Print help**: invoke the CLI with `--help`. Should list subcommands without crashing.
2. **Print version**: invoke with `--version`. Should output `2.2.0`.
3. **Start Chrome**: `chrome-ws start` (or whatever the start command is). Should launch Chrome on a port.
4. **Navigate**: `chrome-ws navigate https://example.com`. Should succeed.
5. **Extract**: `chrome-ws extract text h1`. Should output `"Example Domain"`.
6. **Fill**: navigate to a data URL with an input, `chrome-ws fill #i "hello"`. Verify via `chrome-ws eval` that the input value is set.
7. **Eval**: `chrome-ws eval "2 + 2"`. Should output `4`.
8. **Stop Chrome**: `chrome-ws stop` (or `kill`). Chrome process should exit.

## Pass criteria

- Each command exits with status 0 on success
- Output is parseable (text or JSON depending on the command's documented shape)
- No "is not a function" / module errors
- Bridge bootstraps cleanly via the CLI just like via the MCP

## Failure signals

- CLI crashes on startup → bundling or entry-point issue
- Bridge not initialized → CLI session setup is different from MCP and skipped ensureBridge
- Different errors between CLI and MCP for the same operation → divergent code paths

Report the matrix of 8 commands × pass / fail / unsupported.
