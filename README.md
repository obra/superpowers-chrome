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

**Linux/WSL2 tip:** For headed mode (visible browser), the MCP server needs the `DISPLAY` environment variable. If `show_browser` doesn't work, configure `"env": {"DISPLAY": ":0"}` in your MCP server config. See [mcp/README.md](mcp/README.md#linuxwsl2-headed-mode) for details. Running as root or inside a container is detected automatically and disables Chrome's sandbox; on a headless box add `CHROME_EXTRA_ARGS="--headless=new --disable-gpu"`.

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

Pages showing credential-shaped content are not captured; see [Credential-shaped pages](#credential-shaped-pages).

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

### Credential-shaped pages

When a page shows credential-shaped content, auto-capture writes **no files** for that action and the response carries only metadata (URL, size, element counts, layout) plus a `⚠️ Page shows credential-shaped content; auto-capture and DOM output suppressed.` line. No markdown, headings, title, or DOM diff is returned. This covers Slack tokens (`xox[abposr]-`, `xoxe.`/`xoxe-`, `xapp-`), GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`), 1Password service-account tokens (`ops_eyJ…`) and Secret Keys (`A3-…`), `otpauth://` URIs carrying a `secret=`, and any page containing an element with the `data-sen-secret` attribute (for secrets with no distinctive shape, like backup codes; see below for what marking does not cover). The check covers the HTML, the rendered markdown, the DOM summary, the page's rendered text (`innerText`, which joins a token split across inline spans), open shadow roots, and live `input`/`textarea` values. It runs after the screenshot, and any match deletes every artifact already written for that action, so a token revealed while the capture runs doesn't survive in the PNG. It can't see inside closed shadow roots or cross-origin iframes.

In addition, every `use_browser` result and error has credential-shaped substrings replaced with `[REDACTED credential-shaped]`, and `screenshot` refuses on such a page.

### The `data-sen-secret` marker: an accident guard, not a boundary

Mark an element with the `data-sen-secret` attribute (via `set_attr`) when it holds a secret with no distinctive shape — a bare base32 TOTP seed, a backup code — that the credential-shape check above can't recognize. **When to mark:** as soon as the action that revealed the secret returns, before any other action on that page, then capture the value with the credential broker. Marking only affects actions after it: the capture files the revealing action already wrote (typically its `NNN-navigate.html`/`.md` or `NNN-click.html`/`.md`) still hold the value, and marking does not delete them. Once marked:

- `eval` refuses outright, page-wide, if ANY element on the page currently carries `data-sen-secret` — checked against the live DOM immediately before the expression runs. This is a **point check at the moment of the call**: it does not remember that the page was ever marked, and it does not re-check after the expression finishes. `extract` and `attr` refuse when the resolved element **or any ancestor of it** (through shadow-root hosts) is marked; where a read doesn't require touching the marked value at all (`extract`'s HTML/markdown forms), they instead read off a clone imported into a fresh, inert document with marked descendants stripped, rather than refusing the whole page over one marked corner of it. Screenshot and auto-capture use the same live scan, extended to open shadow roots and same-origin `iframe`/`frame`/`object`/`embed`, and write nothing to disk for a marked page from then on.
- **This is not a security boundary.** `eval` runs arbitrary JavaScript in the exact same JS realm as the marked element — it can read the value directly, `fetch()` it to another origin, stash it in `window.name` or storage for another tab, or erase the marker with `removeAttribute` as its own last step, and no in-page check can close any of that. Same-origin `fetch`, another browser tab, and page JavaScript that moves the value out from under the marked element can all still reach it regardless of marking. **Don't mark an element and then run `eval` on that page expecting the secret to stay contained** — after marking, use the credential broker for the value and `set_attr` for writes.
- Native dialog (`alert`/`confirm`/`prompt`/`beforeunload`) text keeps only the credential-**shape** redaction and file suppression described above; a marked-but-shapeless value in dialog text is not specially caught, for the same reason `eval` isn't a boundary.
- Not covered either: capture files written before the mark (see "When to mark" above), and markup inside an `<iframe srcdoc="…">` attribute. `extract`'s HTML form and `attr srcdoc` return that attribute text verbatim, so a marked element written into `srcdoc` comes back with it, even though the live scan sees the loaded frame and `eval` refuses.

`set_attr` is a separate, write-only action exempt from all of the above: it takes no caller JavaScript (values travel as CDP call arguments, never as code text), and can write exactly two attribute names — `data-sen-nonce` (a broker nonce, deliberately not any other `data-*`/`aria-*` name, since page JS and frameworks routinely wire arbitrary ones to behavior) and `data-sen-secret` itself, the write path for the marker. Writing `data-sen-nonce` resolves to the single first-VISIBLE match, the same way `extract`/`click`/`type` resolve a selector, and refuses if that element is already marked. Writing `data-sen-secret` instead marks **every** element the selector matches, hidden duplicates included, and can never remove or weaken an existing mark — re-marking an already-marked element is a no-op, not a refusal. `set_attr`'s different outcomes (`ok` / `no element matched` / `refused: target element is marked`) are themselves a limited prefix oracle over what's on the page for a caller who can vary the selector and watch which one comes back; this is a known, accepted limitation, not something the guard closes.

Set `SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE=1` to restore the old, unguarded behavior when debugging your own browser.

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
