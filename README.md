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
cd ~/.claude/plugins/cache/superpowers-chrome/skills/browsing
./chrome-ws start                        # Launch Chrome
./chrome-ws new "https://example.com"   # Create tab
./chrome-ws navigate 0 "https://google.com"
./chrome-ws fill 0 "textarea[name=q]" "test"
./chrome-ws click 0 "button[name=btnK]"
```

## Commands

- **Setup**: `start` (auto-detects platform)
- **Tab management**: `tabs`, `new`, `close`
- **Navigation**: `navigate`, `wait-for`, `wait-text`
- **Interaction**: `click`, `fill`, `select`
- **Extraction**: `eval`, `extract`, `attr`, `html`
- **Export**: `screenshot`, `markdown`
- **Raw protocol**: `raw` (full CDP access)

## MCP Server Mode

Ultra-lightweight MCP server with a single `use_browser` tool. Perfect for minimal context usage with automatic page captures.

### Installation Options

**Option 1: NPX (Recommended)**
```json
{
  "mcpServers": {
    "chrome": {
      "command": "npx",
      "args": [
        "github:obra/superpowers/superpowers-chrome/mcp"
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
        "github:obra/superpowers/superpowers-chrome/mcp",
        "--headless"
      ]
    }
  }
}
```

**Option 2: Local Path**
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

**Option 3: Direct NPX Command**
```bash
npx github:obra/superpowers/superpowers-chrome/mcp
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
