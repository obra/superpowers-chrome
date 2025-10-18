# Using Chrome Directly - Claude Code Plugin

Direct browser control without MCP overhead. Control Chrome via DevTools Protocol using the lightweight `chrome-ws` CLI tool.

## Features

- **Zero dependencies** - Built-in WebSocket, no npm install needed
- **Idiotproof API** - Tab index syntax (`0`, `1`, `2`) instead of WebSocket URLs
- **Platform-agnostic** - `chrome-ws start` works on macOS, Linux, Windows
- **17 commands** covering all browser automation needs
- **Complete documentation** with real-world examples

## Installation

```bash
/plugin marketplace add obra/superpowers-marketplace
/plugin install using-chrome-directly@superpowers-marketplace
```

## Quick Start

```bash
cd ~/.claude/plugins/cache/using-chrome-directly/skills/using-chrome-directly
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

## When to Use

**Use this skill when:**
- Controlling existing authenticated browser sessions
- Managing multiple tabs in running browser
- Playwright MCP unavailable or excessive

**Use Playwright MCP when:**
- Need fresh browser instances
- Complex automation requiring screenshots/PDFs
- Prefer higher-level abstractions

## Documentation

- [SKILL.md](skills/using-chrome-directly/SKILL.md) - Complete skill guide
- [EXAMPLES.md](skills/using-chrome-directly/EXAMPLES.md) - Real-world examples
- [chrome-ws README](skills/using-chrome-directly/README.md) - Tool documentation

## License

MIT
