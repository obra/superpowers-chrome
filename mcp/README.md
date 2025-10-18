# Chrome MCP Server

Ultra-lightweight MCP server for Chrome DevTools Protocol via `chrome-ws`.

## Features

- **Single Tool**: `use_browser` with 13 actions
- **Auto-start**: Chrome launches automatically on first use
- **Zero Config**: No setup required, works out of the box
- **Minimal Context**: Single unified interface reduces token usage
- **Zero Dependencies**: Only MCP SDK and Zod

## Installation

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "chrome": {
      "command": "node",
      "args": [
        "/path/to/using-chrome-directly/mcp/dist/index.js"
      ]
    }
  }
}
```

### Other MCP Clients

The server uses stdio transport and works with any MCP client:

```bash
node /path/to/using-chrome-directly/mcp/dist/index.js
```

## Usage

The `use_browser` tool accepts these parameters:

- `action` (required): Action to perform (see Actions below)
- `tab_index` (optional): Tab index to operate on (default: 0)
- `selector` (optional): CSS selector for element operations
- `payload` (optional): Action-specific data
- `timeout` (optional): Timeout in ms for await operations (default: 5000, max: 60000)

### Actions

| Action | Description | Required Parameters | Payload |
|--------|-------------|---------------------|---------|
| `navigate` | Navigate to URL | - | URL string |
| `click` | Click element | `selector` | - |
| `type` | Type text (append `\n` to submit) | `selector` | Text string |
| `extract` | Extract page content | - | Format: 'markdown' \| 'text' \| 'html' |
| `screenshot` | Take screenshot | - | Filename string |
| `eval` | Execute JavaScript | - | JavaScript code string |
| `select` | Select dropdown option | `selector` | Option value(s) |
| `attr` | Get element attribute | `selector` | Attribute name |
| `await_element` | Wait for element | `selector` | - |
| `await_text` | Wait for text | - | Text to wait for |
| `new_tab` | Create new tab | - | - |
| `close_tab` | Close tab | - | - |
| `list_tabs` | List all tabs | - | - |

### Examples

**Navigate to a page:**
```json
{
  "action": "navigate",
  "payload": "https://example.com"
}
```

**Fill and submit a form:**
```json
{
  "action": "type",
  "selector": "#email",
  "payload": "user@example.com\n"
}
```

**Extract page content as markdown:**
```json
{
  "action": "extract",
  "payload": "markdown"
}
```

**Wait for element to appear:**
```json
{
  "action": "await_element",
  "selector": ".loaded-indicator",
  "timeout": 10000
}
```

**Get link href:**
```json
{
  "action": "attr",
  "selector": "a.download",
  "payload": "href"
}
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch mode (auto-rebuild)
npm run dev
```

## Architecture

```
mcp/
├── src/
│   └── index.ts       # MCP server with use_browser tool
├── dist/
│   └── index.js       # Compiled server
├── package.json
└── tsconfig.json
```

The server spawns the `chrome-ws` executable (located at `../skills/using-chrome-directly/chrome-ws`) to communicate with Chrome via DevTools Protocol.

## License

MIT
