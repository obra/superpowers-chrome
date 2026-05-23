# Superpowers Chrome - Claude Code Plugin

Direct browser control via Chrome DevTools Protocol. Two modes available:

1. **Skill Mode** - CLI tool for Claude Code agents (`browsing` skill)
2. **MCP Mode** - Ultra-lightweight MCP server for any MCP client

## Features

- **Zero dependencies** - Built-in WebSocket, no npm install needed
- **Idiotproof API** - Tab index syntax (`0`, `1`, `2`) instead of WebSocket URLs
- **Platform-agnostic** - `chrome-ws start` works on macOS, Linux, Windows
- **17 commands** covering all browser automation needs
- **Complete documentation** with real-world examples

## Installation

```bash
/plugin marketplace add obra/superpowers-marketplace
/plugin install superpowers-chrome@superpowers-marketplace
```

## Quick Start

```bash
# Find your plugin installation path (varies by marketplace and version)
# Common locations:
#   ~/.claude/plugins/cache/superpowers-marketplace/superpowers-chrome/<version>/skills/browsing
#   ~/.claude/plugins/cache/superpowers-chrome/skills/browsing

cd ~/.claude/plugins/cache/superpowers-marketplace/superpowers-chrome/*/skills/browsing
./chrome-ws start                        # Launch Chrome
./chrome-ws new "https://example.com"   # Create tab
./chrome-ws navigate 0 "https://google.com"
./chrome-ws fill 0 "textarea[name=q]" "test"
./chrome-ws click 0 "button[name=btnK]"
```

**Port allocation:** Chrome gets a dynamically allocated port (range 9222-12111) to avoid conflicts. Port assignment is persisted per profile in `~/.cache/superpowers/browser-profiles/{name}.meta.json`. Override with `--port=N` flag or `CHROME_WS_PORT` env var. Multiple profiles can run in parallel on different ports.

**Parallel MCPs on one host** (3.0+): the bridge auto-disambiguates the default profile. The first MCP claims `superpowers-chrome:9222`, the next silently falls through to `superpowers-chrome-2:9223`, then `-3:9224`, etc., each driving its own Chrome with its own profile dir. To intentionally **share** a Chrome between processes (e.g., a `chrome-ws` CLI session + a Claude MCP attaching to it), set a fixed profile via `CHROME_WS_PROFILE=name` (env var) or call `{action: "set_profile", payload: "name"}` at runtime — explicit profiles share rather than disambiguate.

**Windows tip:** The tooling defaults to `127.0.0.1` for DevTools traffic. Override via `CHROME_WS_HOST` / `CHROME_WS_PORT` or `--port=N` if you forward Chrome elsewhere.

**Linux/WSL2 tip:** For headed mode (visible browser), the MCP server needs the `DISPLAY` environment variable. If `show_browser` doesn't work, configure `"env": {"DISPLAY": ":0"}` in your MCP server config. See [mcp/README.md](mcp/README.md#linuxwsl2-headed-mode) for details.

**Custom Chrome flags:** Set `CHROME_EXTRA_ARGS` to a whitespace-separated list of flags that will be appended to the Chrome command line on launch. Useful for headless containers that need software WebGL:

```
CHROME_EXTRA_ARGS="--use-gl=angle --use-angle=swiftshader-webgl --enable-unsafe-swiftshader"
```

## Windows Verification (November 7, 2025)

- `node skills/browsing/chrome-ws start` launched Chrome with remote debugging enabled on a fresh Windows 11 Pro install.
- `node skills/browsing/chrome-ws tabs` and `node skills/browsing/chrome-ws navigate 0 https://example.com` confirmed CLI control with the IPv4 default binding.
- `codex exec -c "mcp_servers.superpowers-chrome.enabled=true" "List Chrome tabs via MCP to verify the Windows override patch."` listed the Example Domain tab through the MCP server, demonstrating that the overrides also work through Codex.

## Commands

- **Setup**: `start` (auto-detects platform)
- **Tab management**: `tabs`, `new`, `close`
- **Navigation**: `navigate`, `wait-for`, `wait-text`
- **Interaction**: `click`, `fill`, `select`
- **Extraction**: `eval`, `extract`, `attr`, `html`
- **Export**: `screenshot`, `markdown`
- **Raw protocol**: `raw` (full CDP access)

## Dialog Handling

Pages that open JavaScript dialogs (`alert`, `confirm`, `prompt`, `beforeunload`), WebUSB/Bluetooth/Serial/HID device choosers, HTTP basic-auth challenges, or permission prompts (camera, microphone, notifications, geolocation, clipboard) no longer wedge the connection. The dialog is surfaced as a synthetic page response and the agent interacts with it using the existing `click` and `type` actions against a small `dialog::*` selector grammar.

### What an agent sees

While a dialog is open, any page-targeted action (`extract`, `screenshot`, `eval`, `attr`, `click <real-selector>`, etc.) returns a clear refusal with the dialog content and instructions:

```
Page is behind a dialog. Handle dialog::accept or dialog::dismiss first.

# Dialog: confirm
Tab origin: https://example.com

> Are you sure you want to leave?

Buttons:
  - dialog::accept   (OK)
  - dialog::dismiss  (Cancel)

To interact:
  click selector="dialog::accept"
  click selector="dialog::dismiss"
```

Browser-targeted actions (`list_tabs`, `new_tab`, `close_tab`, etc.) pass through unaffected.

### Selector grammar

| Selector | Purpose |
|---|---|
| `click dialog::accept` | OK / Grant / Provide credentials, depending on dialog kind |
| `click dialog::dismiss` | Cancel / Deny |
| `type dialog::prompt <value>` | Stage prompt text; commit on `dialog::accept` |
| `click dialog::device[id="…"]` | Pick a device in the chooser (USB, BT, Serial, HID) |
| `type dialog::username <value>` / `type dialog::password <value>` | Basic-auth credentials |

### Worked example

```
# 1. Page on load: alert('Saved!')
extract payload=text
# → refused with synthetic dialog markdown

# 2. Dismiss
click selector="dialog::accept"

# 3. Page is interactive again
extract payload=text
# → returns the page text
```

Permission prompts (`getUserMedia`, `Notification.requestPermission`, geolocation, clipboard) are caught by a `document_start` JS-API shim and surfaced through the same flow.

See `docs/superpowers/specs/2026-05-13-dialog-handling-design.md` for the full design.

## MCP Server Mode

Ultra-lightweight MCP server with a single `use_browser` tool. Perfect for minimal context usage with automatic page captures.

### Installation Options

**Option 1: NPX from GitHub (Recommended)**
```json
{
  "mcpServers": {
    "chrome": {
      "command": "npx",
      "args": [
        "github:obra/superpowers-chrome"
      ]
    }
  }
}
```

**Option 1b: NPX with Headless Mode**
```json
{
  "mcpServers": {
    "chrome": {
      "command": "npx",
      "args": [
        "github:obra/superpowers-chrome",
        "--headless"
      ]
    }
  }
}
```

**Option 2: Git Clone + Local Path (Current)**
```bash
git clone https://github.com/obra/superpowers-chrome.git
cd superpowers-chrome/mcp && npm install && npm run build
```
```json
{
  "mcpServers": {
    "chrome": {
      "command": "node",
      "args": [
        "/path/to/superpowers-chrome/mcp/dist/index.js"
      ]
    }
  }
}
```


### Auto-Capture Features

DOM-changing actions (navigate, click, type, select, eval) automatically capture:
- **Page HTML**: Full rendered DOM state
- **Page Markdown**: Structured content extraction
- **Screenshot**: Visual page state
- **DOM Summary**: Token-efficient page structure
- **Session Organization**: Time-ordered captures in temp directory

Response format:
```
→ https://example.com (capture #001)
Size: 1200×765
Snapshot: /tmp/chrome-session-123/001-navigate-456/
Resources: page.html, page.md, screenshot.png, console-log.txt
DOM:
  Example Domain
  Interactive: 0 buttons, 0 inputs, 1 links
  Layout: body
```

### Usage

```json
{
  "action": "navigate",
  "payload": "https://example.com"
}
```

Get help: `{"action": "help"}` - Returns complete documentation

See [mcp/README.md](mcp/README.md) for complete documentation.

## When to Use

**Use Skill Mode when:**
- Working with Claude Code agents
- Need full CLI control with 17 commands

**Use MCP Mode when:**
- Using Claude Desktop or other MCP clients
- Want minimal context usage (single tool)

**Use Playwright MCP when:**
- Need fresh browser instances
- Complex automation with screenshots/PDFs
- Prefer higher-level abstractions

## Documentation

- [SKILL.md](skills/browsing/SKILL.md) - Complete skill guide
- [EXAMPLES.md](skills/browsing/EXAMPLES.md) - Real-world examples
- [chrome-ws README](skills/browsing/README.md) - Tool documentation

## License

MIT
