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
var BrowserAction;
(function (BrowserAction) {
    BrowserAction["NAVIGATE"] = "navigate";
    BrowserAction["CLICK"] = "click";
    BrowserAction["TYPE"] = "type";
    BrowserAction["EXTRACT"] = "extract";
    BrowserAction["SCREENSHOT"] = "screenshot";
    BrowserAction["EVAL"] = "eval";
    BrowserAction["SELECT"] = "select";
    BrowserAction["ATTR"] = "attr";
    BrowserAction["AWAIT_ELEMENT"] = "await_element";
    BrowserAction["AWAIT_TEXT"] = "await_text";
    BrowserAction["NEW_TAB"] = "new_tab";
    BrowserAction["CLOSE_TAB"] = "close_tab";
    BrowserAction["LIST_TABS"] = "list_tabs";
})(BrowserAction || (BrowserAction = {}));
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
/**
 * Execute chrome-ws command and return output
 */
async function executeChromeWs(args) {
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
            }
            else {
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
async function ensureChromeRunning() {
    if (chromeStarted) {
        return;
    }
    try {
        // Try to list tabs - if this works, Chrome is running
        await executeChromeWs(['tabs']);
        chromeStarted = true;
    }
    catch (error) {
        // Chrome not running, start it
        try {
            await executeChromeWs(['start']);
            // Wait a bit for Chrome to fully start
            await new Promise(resolve => setTimeout(resolve, 1000));
            chromeStarted = true;
        }
        catch (startError) {
            throw new Error(`Failed to auto-start Chrome: ${startError instanceof Error ? startError.message : String(startError)}`);
        }
    }
}
/**
 * Build chrome-ws command arguments based on action and parameters
 */
function buildChromeWsArgs(params) {
    const args = [];
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
            }
            else {
                args.push('extract', tabIndex, format);
            }
            break;
        case BrowserAction.SCREENSHOT:
            if (!params.payload || typeof params.payload !== 'string') {
                throw new Error("screenshot requires payload with filename");
            }
            if (params.selector) {
                args.push('screenshot', tabIndex, params.payload, params.selector);
            }
            else {
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
server.registerTool("use_browser", {
    title: "Use Browser",
    description: `Control Chrome browser via DevTools Protocol with a single unified interface.

This tool provides browser automation through multiple actions. Chrome auto-starts on first use.
All operations default to tab 0. Append \\n to text in 'type' action to submit forms.

Actions:
  - navigate: Navigate to URL (payload=url)
  - click: Click element (selector required)
  - type: Type text into input (selector + payload=text, append \\n to submit)
  - extract: Extract page content (payload=format: 'markdown'|'text'|'html', optional selector)
  - screenshot: Take screenshot (payload=filename, optional selector for element screenshot)
  - eval: Execute JavaScript (payload=code)
  - select: Select dropdown option (selector + payload=value or array of values)
  - attr: Get element attribute (selector + payload=attribute name)
  - await_element: Wait for element to appear (selector required, uses timeout)
  - await_text: Wait for text to appear (payload=text, uses timeout)
  - new_tab: Create new tab
  - close_tab: Close tab at tab_index
  - list_tabs: List all open tabs

Args:
  - action (string): Action to perform (see enum above)
  - tab_index (number): Tab index to operate on (default: 0)
  - selector (string|null): CSS selector for element operations (default: null)
  - payload (string|array|null): Action-specific data (default: null)
  - timeout (number): Timeout in ms for await operations (default: 5000, max: 60000)

Returns:
  Text output from chrome-ws command, which varies by action:
  - navigate: Success message with final URL
  - click: Confirmation message
  - type: Confirmation message
  - extract: Page content in requested format
  - screenshot: Path to saved screenshot file
  - eval: JavaScript evaluation result (stringified)
  - select: Confirmation message
  - attr: Attribute value
  - await_element: Success message when element appears
  - await_text: Success message when text appears
  - new_tab: New tab info
  - close_tab: Confirmation message
  - list_tabs: JSON array of tab objects with index, id, title, url, type

Examples:
  - Navigate: {action: "navigate", payload: "https://example.com"}
  - Click button: {action: "click", selector: "button.submit"}
  - Fill and submit form: {action: "type", selector: "#email", payload: "user@example.com\\n"}
  - Extract as markdown: {action: "extract", payload: "markdown"}
  - Screenshot: {action: "screenshot", payload: "/tmp/page.png"}
  - Wait for element: {action: "await_element", selector: ".loaded", timeout: 10000}
  - Get attribute: {action: "attr", selector: "a.link", payload: "href"}

Error Handling:
  - Auto-starts Chrome if not running (first call only)
  - Returns clear error messages for invalid parameters
  - Timeout errors for await operations that exceed timeout parameter
  - Element not found errors for invalid selectors`,
    inputSchema: UseBrowserSchema,
    annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
    }
}, async (args) => {
    try {
        // Parse and validate input with Zod
        const params = UseBrowserSchema.parse(args);
        // Ensure Chrome is running
        await ensureChromeRunning();
        // Build command arguments
        const chromeArgs = buildChromeWsArgs(params);
        // Execute chrome-ws
        const result = await executeChromeWs(chromeArgs);
        return {
            content: [{
                    type: "text",
                    text: result.trim()
                }]
        };
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
            content: [{
                    type: "text",
                    text: `Error: ${errorMessage}`
                }]
        };
    }
});
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
//# sourceMappingURL=index.js.map