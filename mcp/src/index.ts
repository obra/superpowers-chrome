#!/usr/bin/env node
/**
 * Ultra-lightweight MCP Server for Chrome DevTools Protocol.
 *
 * Provides a single `use_browser` tool with multiple actions for browser control.
 * Auto-starts Chrome when needed. Zero external dependencies beyond MCP SDK.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Get the directory of the chrome-ws executable (relative to this MCP server)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CHROME_WS_PATH = join(__dirname, "../../skills/using-chrome-directly/chrome-ws");

// Track if Chrome has been started
let chromeStarted = false;

// Action enum for use_browser tool
enum BrowserAction {
  NAVIGATE = "navigate",
  CLICK = "click",
  TYPE = "type",
  EXTRACT = "extract",
  SCREENSHOT = "screenshot",
  EVAL = "eval",
  SELECT = "select",
  ATTR = "attr",
  AWAIT_ELEMENT = "await_element",
  AWAIT_TEXT = "await_text",
  NEW_TAB = "new_tab",
  CLOSE_TAB = "close_tab",
  LIST_TABS = "list_tabs"
}

// Zod schema for use_browser input
const UseBrowserSchema = z.object({
  action: z.nativeEnum(BrowserAction)
    .describe("Browser action to perform"),
  tab_index: z.number()
    .int()
    .min(0)
    .default(0)
    .describe("Tab index to operate on (default: 0)"),
  selector: z.string()
    .nullable()
    .default(null)
    .describe("CSS selector for element operations (required for click, type, select, attr, await_element)"),
  payload: z.union([z.string(), z.array(z.string())])
    .nullable()
    .default(null)
    .describe("Action payload: URL for navigate, text for type (append \\n to submit), format for extract, filename for screenshot, code for eval, value(s) for select, attribute name for attr, text for await_text"),
  timeout: z.number()
    .int()
    .min(0)
    .max(60000)
    .default(5000)
    .describe("Timeout in milliseconds for await operations (default: 5000)")
});

type UseBrowserInput = z.infer<typeof UseBrowserSchema>;

/**
 * Execute chrome-ws command and return output
 */
async function executeChromeWs(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(CHROME_WS_PATH, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `chrome-ws exited with code ${code}`));
      } else {
        resolve(stdout);
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Ensure Chrome is running, auto-start if needed
 */
async function ensureChromeRunning(): Promise<void> {
  if (chromeStarted) {
    return;
  }

  try {
    // Try to list tabs - if this works, Chrome is running
    await executeChromeWs(['tabs']);
    chromeStarted = true;
  } catch (error) {
    // Chrome not running, start it
    try {
      await executeChromeWs(['start']);
      // Wait a bit for Chrome to fully start
      await new Promise(resolve => setTimeout(resolve, 1000));
      chromeStarted = true;
    } catch (startError) {
      throw new Error(`Failed to auto-start Chrome: ${startError instanceof Error ? startError.message : String(startError)}`);
    }
  }
}

/**
 * Build chrome-ws command arguments based on action and parameters
 */
function buildChromeWsArgs(params: UseBrowserInput): string[] {
  const args: string[] = [];
  const tabIndex = String(params.tab_index);

  switch (params.action) {
    case BrowserAction.NAVIGATE:
      if (!params.payload || typeof params.payload !== 'string') {
        throw new Error("navigate requires payload with URL");
      }
      args.push('navigate', tabIndex, params.payload);
      break;

    case BrowserAction.CLICK:
      if (!params.selector) {
        throw new Error("click requires selector");
      }
      args.push('click', tabIndex, params.selector);
      break;

    case BrowserAction.TYPE:
      if (!params.selector) {
        throw new Error("type requires selector");
      }
      if (!params.payload || typeof params.payload !== 'string') {
        throw new Error("type requires payload with text");
      }
      args.push('type', tabIndex, params.selector, params.payload);
      break;

    case BrowserAction.EXTRACT:
      const format = params.payload || 'markdown';
      if (typeof format !== 'string') {
        throw new Error("extract payload must be a string format");
      }
      if (params.selector) {
        args.push('extract', tabIndex, format, params.selector);
      } else {
        args.push('extract', tabIndex, format);
      }
      break;

    case BrowserAction.SCREENSHOT:
      if (!params.payload || typeof params.payload !== 'string') {
        throw new Error("screenshot requires payload with filename");
      }
      if (params.selector) {
        args.push('screenshot', tabIndex, params.payload, params.selector);
      } else {
        args.push('screenshot', tabIndex, params.payload);
      }
      break;

    case BrowserAction.EVAL:
      if (!params.payload || typeof params.payload !== 'string') {
        throw new Error("eval requires payload with JavaScript code");
      }
      args.push('eval', tabIndex, params.payload);
      break;

    case BrowserAction.SELECT:
      if (!params.selector) {
        throw new Error("select requires selector");
      }
      if (!params.payload) {
        throw new Error("select requires payload with option value(s)");
      }
      const values = Array.isArray(params.payload) ? params.payload : [params.payload];
      args.push('select', tabIndex, params.selector, ...values);
      break;

    case BrowserAction.ATTR:
      if (!params.selector) {
        throw new Error("attr requires selector");
      }
      if (!params.payload || typeof params.payload !== 'string') {
        throw new Error("attr requires payload with attribute name");
      }
      args.push('attr', tabIndex, params.selector, params.payload);
      break;

    case BrowserAction.AWAIT_ELEMENT:
      if (!params.selector) {
        throw new Error("await_element requires selector");
      }
      args.push('wait-for', tabIndex, 'element', params.selector, String(params.timeout));
      break;

    case BrowserAction.AWAIT_TEXT:
      if (!params.payload || typeof params.payload !== 'string') {
        throw new Error("await_text requires payload with text to wait for");
      }
      args.push('wait-for', tabIndex, 'text', params.payload, String(params.timeout));
      break;

    case BrowserAction.NEW_TAB:
      args.push('new');
      break;

    case BrowserAction.CLOSE_TAB:
      args.push('close', tabIndex);
      break;

    case BrowserAction.LIST_TABS:
      args.push('tabs');
      break;

    default:
      throw new Error(`Unknown action: ${params.action}`);
  }

  return args;
}

// Create MCP server instance
const server = new McpServer({
  name: "chrome-mcp-server",
  version: "1.0.0"
});

// Register the single use_browser tool
server.registerTool(
  "use_browser",
  {
    title: "Use Browser",
    description: `Control persistent Chrome browser. State persists between calls - tabs, navigation, page content all remain.

CRITICAL:
- Selectors are CSS only (NOT XPath). Use "input[name='x']" not "//input[@name='x']"
- Append \\n to text in 'type' to submit forms: {action:"type", selector:"#search", payload:"query\\n"}
- Chrome auto-starts on first call and stays running
- Tab indices shift when tabs close (tab 2 becomes tab 1 after closing tab 1)

ACTIONS:
navigate: Go to URL. Auto-waits for page load. {action:"navigate", payload:"https://example.com"}
click: Click element. {action:"click", selector:"button.submit"}
type: Type into input. Append \\n to submit. {action:"type", selector:"#email", payload:"user@example.com\\n"}
extract: Get page content. {action:"extract", payload:"markdown|text|html"}. Optional selector for element-only extraction
screenshot: Capture page or element. {action:"screenshot", payload:"/tmp/page.png"}. Optional selector
eval: Run JavaScript in page context. {action:"eval", payload:"document.title"}
select: Choose dropdown option(s). {action:"select", selector:"select[name='country']", payload:"US"} or payload:["US","CA"]
attr: Get element attribute. {action:"attr", selector:"a.download", payload:"href"}
await_element: Wait for element in DOM. {action:"await_element", selector:".loaded", timeout:10000}
await_text: Wait for text on page. {action:"await_text", payload:"Success!", timeout:10000}
list_tabs: Show all tabs with indices. {action:"list_tabs"}
new_tab: Open blank tab. {action:"new_tab"}
close_tab: Close tab by index. {action:"close_tab", tab_index:1}

PARAMETERS:
- action (required): Action name from list above
- tab_index (optional): Which tab (default: 0)
- selector (varies): CSS selector for element operations
- payload (varies): URL, text, format, filename, code, or option value(s)
- timeout (optional): ms for await actions (default: 5000, max: 60000)

TYPICAL WORKFLOWS:
Scrape: navigate → await_element → extract
Form: navigate → type → type (with \\n) → await_text → extract
Data: navigate → await_element → eval or attr
Debug: screenshot or extract with payload:"html"`,
    inputSchema: UseBrowserSchema.shape,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    }
  },
  async (args: any) => {
    try {
      // Parse and validate input with Zod
      const params = UseBrowserSchema.parse(args) as UseBrowserInput;

      // Ensure Chrome is running
      await ensureChromeRunning();

      // Build command arguments
      const chromeArgs = buildChromeWsArgs(params);

      // Execute chrome-ws
      const result = await executeChromeWs(chromeArgs);

      return {
        content: [{
          type: "text" as const,
          text: result.trim()
        }]
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{
          type: "text" as const,
          text: `Error: ${errorMessage}`
        }]
      };
    }
  }
);

// Main function
async function main() {
  // Create stdio transport
  const transport = new StdioServerTransport();

  // Connect server to transport
  await server.connect(transport);

  console.error("Chrome MCP server running via stdio");
}

// Run the server
main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
