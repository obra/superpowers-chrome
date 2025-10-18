---
name: using-chrome-directly
description: Use when you need direct browser control without MCP - teaches Chrome DevTools Protocol for controlling existing browser sessions, multi-tab management, form automation, and content extraction via lightweight chrome-ws tool
allowed-tools: mcp__chrome__use_browser
---

# Using Chrome Directly

## Overview

Control Chrome via DevTools Protocol. No MCP, no abstractions - direct WebSocket access.

**Announce:** "I'm using the using-chrome-directly skill to control Chrome."

## When to Use

**Use this when:**
- Controlling authenticated sessions
- Managing multiple tabs in running browser
- Playwright MCP unavailable or excessive

**Use Playwright MCP when:**
- Need fresh browser instances
- Generating screenshots/PDFs
- Prefer higher-level abstractions

## Quick Start

```bash
cd ~/.claude/skills/using-chrome-directly
chmod +x chrome-ws
./chrome-ws start    # Auto-detects platform, launches Chrome
./chrome-ws tabs     # Verify it's running
```

Chrome starts with `--remote-debugging-port=9222` and separate profile in `/tmp/chrome-debug` (or `C:\temp\chrome-debug` on Windows).

## Commands

**Setup:**
```bash
chrome-ws start                 # Launch Chrome (auto-detects platform)
```

**Tab Management:**
```bash
chrome-ws tabs                  # List tabs
chrome-ws new <url>            # Create tab
chrome-ws close <ws-url>       # Close tab
```

**Navigation:**
```bash
chrome-ws navigate <tab> <url>        # Navigate
chrome-ws wait-for <tab> <selector>   # Wait for element
chrome-ws wait-text <tab> <text>      # Wait for text
```

**Interaction:**
```bash
chrome-ws click <tab> <selector>              # Click
chrome-ws fill <tab> <selector> <value>       # Fill input
chrome-ws select <tab> <selector> <value>     # Select dropdown
```

**Extraction:**
```bash
chrome-ws eval <tab> <js>               # Execute JavaScript
chrome-ws extract <tab> <selector>      # Get text content
chrome-ws attr <tab> <selector> <attr>  # Get attribute
chrome-ws html <tab> [selector]         # Get HTML
```

**Export:**
```bash
chrome-ws screenshot <tab> <file.png>   # Capture screenshot
chrome-ws markdown <tab> <file.md>      # Save as markdown
```

**Raw Protocol:**
```bash
chrome-ws raw <ws-url> <json-rpc>       # Direct CDP access
```

`<tab>` accepts either tab index (0, 1, 2) or full WebSocket URL.

## Patterns

**Navigate and extract:**
```bash
chrome-ws navigate 0 "https://example.com"
chrome-ws extract 0 "h1"
```

**Fill and submit form:**
```bash
chrome-ws navigate 0 "https://example.com/login"
chrome-ws fill 0 "input[name=email]" "user@example.com"
chrome-ws fill 0 "input[name=password]" "pass123"
chrome-ws click 0 "button[type=submit]"
chrome-ws wait-text 0 "Welcome"
```

**Multi-tab workflow:**
```bash
chrome-ws tabs              # Find tab indices
chrome-ws click 2 "a.email" # Click in tab 2
chrome-ws wait-for 2 ".content"
chrome-ws extract 2 ".amount"
```

**Dynamic content:**
```bash
chrome-ws navigate 0 "https://example.com"
chrome-ws fill 0 "input[name=q]" "query"
chrome-ws click 0 "button.search"
chrome-ws wait-for 0 ".results"
chrome-ws extract 0 ".result-title"
```

## Troubleshooting

**Connection refused:** Verify Chrome running with `curl http://localhost:9222/json`

**Element not found:** Check page structure with `chrome-ws html 0`

**Timeout:** Use `wait-for` before interaction. Chrome has 30s timeout.

**Tab index out of range:** Run `chrome-ws tabs` to get current indices.

## Protocol Reference

Full CDP documentation: https://chromedevtools.github.io/devtools-protocol/

Common methods via `raw` command:
- `Page.navigate`
- `Runtime.evaluate`
- `Network.enable`
- `Performance.getMetrics`
