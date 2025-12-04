---
name: browsing
description: Use when you need direct browser control - teaches Chrome DevTools Protocol for controlling existing browser sessions, multi-tab management, form automation, and content extraction via use_browser MCP tool
allowed-tools: mcp__chrome__use_browser
---

# Browsing with Chrome Direct

## Overview

Control Chrome via DevTools Protocol using the `use_browser` MCP tool. Single unified interface with auto-starting Chrome.

**Announce:** "I'm using the browsing skill to control Chrome."

## When to Use

**Use this when:**
- Controlling authenticated sessions
- Managing multiple tabs in running browser
- Playwright MCP unavailable or excessive

**Use Playwright MCP when:**
- Need fresh browser instances
- Generating screenshots/PDFs
- Prefer higher-level abstractions

## The use_browser Tool

Single MCP tool with action-based interface. Chrome auto-starts on first use.

**Parameters:**
- `action` (required): Operation to perform
- `tab_index` (optional): Tab to operate on (default: 0)
- `selector` (optional): CSS selector for element operations
- `payload` (optional): Action-specific data
- `timeout` (optional): Timeout in ms for await operations (default: 5000)

## Actions Reference

### Navigation
- **navigate**: Navigate to URL
  - `payload`: URL string
  - Example: `{action: "navigate", payload: "https://example.com"}`

- **await_element**: Wait for element to appear
  - `selector`: CSS selector
  - `timeout`: Max wait time in ms
  - Example: `{action: "await_element", selector: ".loaded", timeout: 10000}`

- **await_text**: Wait for text to appear
  - `payload`: Text to wait for
  - Example: `{action: "await_text", payload: "Welcome"}`

### Interaction
- **click**: Click element
  - `selector`: CSS selector
  - Example: `{action: "click", selector: "button.submit"}`

- **type**: Type text into input (append `\n` to submit)
  - `selector`: CSS selector
  - `payload`: Text to type
  - Example: `{action: "type", selector: "#email", payload: "user@example.com\n"}`

- **select**: Select dropdown option
  - `selector`: CSS selector
  - `payload`: Option value(s)
  - Example: `{action: "select", selector: "select[name=state]", payload: "CA"}`

### Extraction
- **extract**: Get page content
  - `payload`: Format ('markdown'|'text'|'html')
  - `selector`: Optional - limit to element
  - Example: `{action: "extract", payload: "markdown"}`
  - Example: `{action: "extract", payload: "text", selector: "h1"}`

- **attr**: Get element attribute
  - `selector`: CSS selector
  - `payload`: Attribute name
  - Example: `{action: "attr", selector: "a.download", payload: "href"}`

- **eval**: Execute JavaScript
  - `payload`: JavaScript code
  - Example: `{action: "eval", payload: "document.title"}`

### Export
- **screenshot**: Capture screenshot
  - `payload`: Filename
  - `selector`: Optional - screenshot specific element
  - Example: `{action: "screenshot", payload: "/tmp/page.png"}`

### Tab Management
- **list_tabs**: List all open tabs
  - Example: `{action: "list_tabs"}`

- **new_tab**: Create new tab
  - Example: `{action: "new_tab"}`

- **close_tab**: Close tab
  - `tab_index`: Tab to close
  - Example: `{action: "close_tab", tab_index: 2}`

### Browser Mode Control
- **show_browser**: Make browser window visible (headed mode)
  - Example: `{action: "show_browser"}`
  - ⚠️ **WARNING**: Restarts Chrome, reloads pages via GET, loses POST state

- **hide_browser**: Switch to headless mode (invisible browser)
  - Example: `{action: "hide_browser"}`
  - ⚠️ **WARNING**: Restarts Chrome, reloads pages via GET, loses POST state

- **browser_mode**: Check current browser mode and profile
  - Example: `{action: "browser_mode"}`
  - Returns: `{"headless": true|false, "mode": "headless"|"headed", "running": true|false, "profile": "name", "profileDir": "/path"}`

### Profile Management
- **set_profile**: Change Chrome profile (must kill Chrome first)
  - Example: `{action: "set_profile", "payload": "browser-user"}`
  - ⚠️ **WARNING**: Chrome must be stopped first

- **get_profile**: Get current profile name and directory
  - Example: `{action: "get_profile"}`
  - Returns: `{"profile": "name", "profileDir": "/path"}`

**Default behavior**: Chrome starts in **headless mode** with **"superpowers-chrome" profile**.

**Critical caveats when toggling modes**:
1. **Chrome must restart** - Cannot switch headless/headed mode on running Chrome
2. **Pages reload via GET** - All open tabs are reopened with GET requests
3. **POST state is lost** - Form submissions, POST results, and POST-based navigation will be lost
4. **Session state is lost** - Any client-side state (JavaScript variables, etc.) is cleared
5. **Cookies/auth may persist** - Uses same user data directory, so logged-in sessions may survive

**When to use headed mode**:
- Debugging visual rendering issues
- Demonstrating browser behavior to user
- Testing features that only work with visible browser
- Debugging issues that don't reproduce in headless mode

**When to stay in headless mode** (default):
- All other cases - faster, cleaner, less intrusive
- Screenshots work perfectly in headless mode
- Most automation works identically in both modes

**Profile management**:
Profiles store persistent browser data (cookies, localStorage, extensions, auth sessions).

**Profile locations**:
- macOS: `~/Library/Caches/superpowers/browser-profiles/{name}/`
- Linux: `~/.cache/superpowers/browser-profiles/{name}/`
- Windows: `%LOCALAPPDATA%/superpowers/browser-profiles/{name}/`

**When to use separate profiles**:
- **Default profile ("superpowers-chrome")**: General automation, shared sessions
- **Agent-specific profiles**: Isolate different agents' browser state
  - Example: browser-user agent uses "browser-user" profile
- **Task-specific profiles**: Testing with different user contexts
  - Example: "test-logged-in" vs "test-logged-out"

**Profile data persists across**:
- Chrome restarts
- Mode toggles (headless ↔ headed)
- System reboots (data is in cache directory)

**To use a different profile**:
1. Kill Chrome if running: `await chromeLib.killChrome()`
2. Set profile: `{action: "set_profile", "payload": "my-profile"}`
3. Start Chrome: Next navigate/action will use new profile

## Quick Start Pattern

```
Navigate and extract:
{action: "navigate", payload: "https://example.com"}
{action: "await_element", selector: "h1"}
{action: "extract", payload: "text", selector: "h1"}
```

## Common Patterns

### Fill and Submit Form
```
{action: "navigate", payload: "https://example.com/login"}
{action: "await_element", selector: "input[name=email]"}
{action: "type", selector: "input[name=email]", payload: "user@example.com"}
{action: "type", selector: "input[name=password]", payload: "pass123\n"}
{action: "await_text", payload: "Welcome"}
```

The `\n` at the end of the password submits the form.

### Multi-Tab Workflow
```
{action: "list_tabs"}
{action: "click", tab_index: 2, selector: "a.email"}
{action: "await_element", tab_index: 2, selector: ".content"}
{action: "extract", tab_index: 2, payload: "text", selector: ".amount"}
```

### Dynamic Content
```
{action: "navigate", payload: "https://example.com"}
{action: "type", selector: "input[name=q]", payload: "query"}
{action: "click", selector: "button.search"}
{action: "await_element", selector: ".results"}
{action: "extract", payload: "text", selector: ".result-title"}
```

### Get Link Attribute
```
{action: "navigate", payload: "https://example.com"}
{action: "await_element", selector: "a.download"}
{action: "attr", selector: "a.download", payload: "href"}
```

### Execute JavaScript
```
{action: "eval", payload: "document.querySelectorAll('a').length"}
{action: "eval", payload: "Array.from(document.querySelectorAll('a')).map(a => a.href)"}
```

## Tips

**Always wait before interaction:**
Don't click or fill immediately after navigate - pages need time to load.

```
// BAD - might fail if page slow
{action: "navigate", payload: "https://example.com"}
{action: "click", selector: "button"}  // May fail!

// GOOD - wait first
{action: "navigate", payload: "https://example.com"}
{action: "await_element", selector: "button"}
{action: "click", selector: "button"}
```

**Use specific selectors:**
Avoid generic selectors that match multiple elements.

```
// BAD - matches first button
{action: "click", selector: "button"}

// GOOD - specific
{action: "click", selector: "button[type=submit]"}
{action: "click", selector: "#login-button"}
```

**Submit forms with \n:**
Append newline to text to submit forms automatically.

```
{action: "type", selector: "#search", payload: "query\n"}
```

**Check content first:**
Extract page content to verify selectors before building workflow.

```
{action: "extract", payload: "html"}
```

## Troubleshooting

**Element not found:**
- Use `await_element` before interaction
- Verify selector with `extract` action using 'html' format

**Timeout errors:**
- Increase timeout: `{timeout: 30000}` for slow pages
- Wait for specific element instead of text

**Tab index out of range:**
- Use `list_tabs` to get current indices
- Tab indices change when tabs close

**eval returns `[object Object]`:**
- Use `JSON.stringify()` for complex objects: `{action: "eval", payload: "JSON.stringify({name: 'test'})"}`
- For async functions: `{action: "eval", payload: "JSON.stringify(await yourAsyncFunction())"}`

## Test Automation (Advanced)

<details>
<summary>Click to expand test automation guidance</summary>

When building test automation, you have two approaches:

### Approach 1: use_browser MCP (Simple Tests)
Best for: Single-step tests, direct Claude control during conversation

```json
{"action": "navigate", "payload": "https://app.com"}
{"action": "click", "selector": "#test-button"}
{"action": "eval", "payload": "JSON.stringify({passed: document.querySelector('.success') !== null})"}
```

### Approach 2: chrome-ws CLI (Complex Tests)
Best for: Multi-step test suites, standalone automation scripts

**Key insight**: `chrome-ws` is the reference implementation showing proper Chrome DevTools Protocol usage. When `use_browser` doesn't work as expected, examine how `chrome-ws` handles the same operation.

```bash
# Example: Automated form testing
./chrome-ws navigate 0 "https://app.com/form"
./chrome-ws fill 0 "#email" "test@example.com"
./chrome-ws click 0 "button[type=submit]"
./chrome-ws wait-text 0 "Success"
```

### When use_browser Fails
1. **Check chrome-ws source code** - It shows the correct CDP pattern
2. **Use chrome-ws to verify** - Test the same operation via CLI
3. **Adapt the pattern** - Apply the working CDP approach to use_browser

### Common Test Automation Patterns
- **Form validation**: Fill forms, check error states
- **UI state testing**: Click elements, verify DOM changes
- **Performance testing**: Measure load times, capture metrics
- **Screenshot comparison**: Capture before/after states

</details>

## Advanced Usage

For command-line usage outside Claude Code, see [COMMANDLINE-USAGE.md](COMMANDLINE-USAGE.md).

For detailed examples, see [EXAMPLES.md](EXAMPLES.md).

## Protocol Reference

Full CDP documentation: https://chromedevtools.github.io/devtools-protocol/
