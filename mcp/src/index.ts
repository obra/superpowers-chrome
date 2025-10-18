#!/usr/bin/env node
/**
 * Ultra-lightweight MCP Server for Chrome DevTools Protocol.
 *
 * Provides a single `use_browser` tool with multiple actions for browser control.
 * Auto-starts Chrome when needed. Uses chrome-ws-lib for direct CDP access.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

// Get the directory and import chrome-ws-lib
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);
const chromeLib = require(join(__dirname, "../../skills/browsing/chrome-ws-lib.js"));

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

// Zod schema for use_browser tool parameters
const UseBrowserParams = {
  action: z.nativeEnum(BrowserAction)
    .describe("Browser action to perform. Navigate goes to URL, click/type interact with elements (CSS selectors only, NOT XPath), extract gets page content, eval runs JavaScript, await_element/await_text wait for content."),
  tab_index: z.number()
    .int()
    .min(0)
    .default(0)
    .describe("Tab index to operate on (default: 0). WARNING: Indices shift when tabs close - tab 2 becomes tab 1 after closing tab 1."),
  selector: z.string()
    .optional()
    .describe("CSS selector for element operations. Required for: click, type, select, attr, await_element. Use 'input[name=\"email\"]' NOT '//input[@name=\"email\"]'."),
  payload: z.string()
    .optional()
    .describe("Action-specific data: URL string for navigate, text for type (append \\n to submit form), 'markdown'|'text'|'html' for extract, filepath for screenshot, JavaScript code for eval, option value for select, attribute name for attr, text to find for await_text."),
  timeout: z.number()
    .int()
    .min(0)
    .max(60000)
    .default(5000)
    .describe("Timeout in milliseconds for await_element and await_text actions only (default: 5000, max: 60000). Other actions have no timeout.")
};

type UseBrowserInput = z.infer<ReturnType<typeof z.object<typeof UseBrowserParams>>>;

/**
 * Ensure Chrome is running, auto-start if needed
 */
async function ensureChromeRunning(): Promise<void> {
  if (chromeStarted) {
    return;
  }

  try {
    // Try to list tabs - if this works, Chrome is running
    await chromeLib.getTabs();
    chromeStarted = true;
  } catch (error) {
    // Chrome not running, start it
    try {
      await chromeLib.startChrome();
      chromeStarted = true;
    } catch (startError) {
      throw new Error(`Failed to auto-start Chrome: ${startError instanceof Error ? startError.message : String(startError)}`);
    }
  }
}

/**
 * Execute browser action using chrome-ws library
 */
async function executeBrowserAction(params: UseBrowserInput): Promise<string> {
  const tabIndex = params.tab_index;

  switch (params.action) {
    case BrowserAction.NAVIGATE:
      if (!params.payload || typeof params.payload !== 'string') {
        throw new Error("navigate requires payload with URL");
      }
      await chromeLib.navigate(tabIndex, params.payload);
      return `Navigated to ${params.payload}`;

    case BrowserAction.CLICK:
      if (!params.selector) {
        throw new Error("click requires selector");
      }
      await chromeLib.click(tabIndex, params.selector);
      return `Clicked: ${params.selector}`;

    case BrowserAction.TYPE:
      if (!params.selector) {
        throw new Error("type requires selector");
      }
      if (!params.payload || typeof params.payload !== 'string') {
        throw new Error("type requires payload with text");
      }
      await chromeLib.fill(tabIndex, params.selector, params.payload);
      return `Typed into: ${params.selector}`;

    case BrowserAction.EXTRACT:
      const format = params.payload || 'text';
      if (typeof format !== 'string') {
        throw new Error("extract payload must be a string format");
      }

      if (params.selector) {
        // Extract specific element
        if (format === 'text') {
          return await chromeLib.extractText(tabIndex, params.selector);
        } else if (format === 'html') {
          return await chromeLib.getHtml(tabIndex, params.selector);
        } else {
          throw new Error("selector-based extraction only supports 'text' or 'html' format");
        }
      } else {
        // Extract whole page
        if (format === 'text') {
          return await chromeLib.evaluate(tabIndex, 'document.body.innerText');
        } else if (format === 'html') {
          return await chromeLib.getHtml(tabIndex);
        } else if (format === 'markdown') {
          // Generate markdown-like output
          return await chromeLib.evaluate(tabIndex, `
            Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, p, a, li, pre, code'))
              .map(el => {
                const tag = el.tagName.toLowerCase();
                const text = el.textContent.trim();
                if (tag.startsWith('h')) return '#'.repeat(parseInt(tag[1])) + ' ' + text;
                if (tag === 'a') return '[' + text + '](' + el.href + ')';
                if (tag === 'li') return '- ' + text;
                if (tag === 'pre' || tag === 'code') return '\\\`\\\`\\\`\\n' + text + '\\n\\\`\\\`\\\`';
                return text;
              })
              .filter(x => x)
              .join('\\n\\n')
          `.replace(/\s+/g, ' ').trim());
        } else {
          throw new Error("extract format must be 'text', 'html', or 'markdown'");
        }
      }

    case BrowserAction.SCREENSHOT:
      if (!params.payload || typeof params.payload !== 'string') {
        throw new Error("screenshot requires payload with filename");
      }
      const filepath = await chromeLib.screenshot(tabIndex, params.payload, params.selector || undefined);
      return `Screenshot saved to ${filepath}`;

    case BrowserAction.EVAL:
      if (!params.payload || typeof params.payload !== 'string') {
        throw new Error("eval requires payload with JavaScript code");
      }
      const result = await chromeLib.evaluate(tabIndex, params.payload);
      return String(result);

    case BrowserAction.SELECT:
      if (!params.selector) {
        throw new Error("select requires selector");
      }
      if (!params.payload || typeof params.payload !== 'string') {
        throw new Error("select requires payload with option value");
      }
      await chromeLib.selectOption(tabIndex, params.selector, params.payload);
      return `Selected: ${params.payload}`;

    case BrowserAction.ATTR:
      if (!params.selector) {
        throw new Error("attr requires selector");
      }
      if (!params.payload || typeof params.payload !== 'string') {
        throw new Error("attr requires payload with attribute name");
      }
      const attrValue = await chromeLib.getAttribute(tabIndex, params.selector, params.payload);
      return String(attrValue);

    case BrowserAction.AWAIT_ELEMENT:
      if (!params.selector) {
        throw new Error("await_element requires selector");
      }
      await chromeLib.waitForElement(tabIndex, params.selector, params.timeout);
      return `Element found: ${params.selector}`;

    case BrowserAction.AWAIT_TEXT:
      if (!params.payload || typeof params.payload !== 'string') {
        throw new Error("await_text requires payload with text to wait for");
      }
      await chromeLib.waitForText(tabIndex, params.payload, params.timeout);
      return `Text found: ${params.payload}`;

    case BrowserAction.NEW_TAB:
      const newTab = await chromeLib.newTab();
      return `New tab created: ${newTab.id}`;

    case BrowserAction.CLOSE_TAB:
      await chromeLib.closeTab(tabIndex);
      return `Closed tab ${tabIndex}`;

    case BrowserAction.LIST_TABS:
      const tabs = await chromeLib.getTabs();
      return JSON.stringify(tabs.map((tab: any, idx: number) => ({
        index: idx,
        id: tab.id,
        title: tab.title,
        url: tab.url,
        type: tab.type
      })), null, 2);

    default:
      throw new Error(`Unknown action: ${params.action}`);
  }
}

// Create MCP server instance
const server = new McpServer({
  name: "chrome-mcp-server",
  version: "1.0.0"
});

// Register the use_browser tool
server.tool(
  "use_browser",
  `Control persistent Chrome browser. State persists between calls - tabs, navigation, page content all remain.

CRITICAL: CSS selectors only (NOT XPath). Append \\n to text in 'type' to submit forms. Chrome auto-starts on first call. Tab indices shift when tabs close.

ACTIONS:
navigate: Go to URL, waits for load. {action:"navigate", payload:"https://example.com"}
click: Click element. {action:"click", selector:"button.submit"}
type: Type into input. {action:"type", selector:"#email", payload:"user@example.com\\n"}
extract: Get page content. {action:"extract", payload:"markdown|text|html"}
screenshot: Capture page/element. {action:"screenshot", payload:"/tmp/page.png"}
eval: Run JavaScript. {action:"eval", payload:"document.title"}
select: Choose dropdown. {action:"select", selector:"select", payload:"US"}
attr: Get attribute. {action:"attr", selector:"a", payload:"href"}
await_element: Wait for element. {action:"await_element", selector:".loaded", timeout:10000}
await_text: Wait for text. {action:"await_text", payload:"Success!", timeout:10000}
list_tabs/new_tab/close_tab: Manage tabs

WORKFLOWS: Scrape: navigate→await_element→extract | Form: navigate→type→type(\\n)→await_text→extract`,
  UseBrowserParams,
  {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true
  },
  async (args) => {
    try {
      // Parse and validate input with Zod
      const params = z.object(UseBrowserParams).parse(args) as UseBrowserInput;

      // Ensure Chrome is running
      await ensureChromeRunning();

      // Execute browser action
      const result = await executeBrowserAction(params);

      return {
        content: [{
          type: "text" as const,
          text: result
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
