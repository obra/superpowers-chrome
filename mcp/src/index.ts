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

// Parse command line arguments for headless mode
const headlessMode = process.argv.includes('--headless');

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
  LIST_TABS = "list_tabs",
  HELP = "help"
}

// Zod schema for use_browser tool parameters
const UseBrowserParams = {
  action: z.nativeEnum(BrowserAction)
    .describe("Action to perform"),
  tab_index: z.number()
    .int()
    .min(0)
    .default(0)
    .describe("Which tab. Indices shift when tabs close."),
  selector: z.string()
    .optional()
    .describe("CSS or XPath selector. XPath must start with / or //."),
  payload: z.string()
    .optional()
    .describe("Action-specific data: navigate=URL | type=text (append \\n to submit) | extract=format (text|html|markdown) | screenshot=filename | eval=JavaScript | select=option value | attr=attribute name | await_text=text to wait for"),
  timeout: z.number()
    .int()
    .min(0)
    .max(60000)
    .default(5000)
    .describe("Timeout in ms. Only for await actions.")
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
      await chromeLib.startChrome(headlessMode);
      chromeStarted = true;
    } catch (startError) {
      throw new Error(`Failed to auto-start Chrome: ${startError instanceof Error ? startError.message : String(startError)}`);
    }
  }
}

/**
 * Format action response with capture information
 */
function formatActionResponse(actionResult: any, actionDescription: string): string {
  const prefix = actionResult.capturePrefix || '???';

  const response = [
    `${actionDescription}`,
    `Current URL: ${actionResult.url || 'unknown'}`,
    `Size: ${actionResult.pageSize?.width}×${actionResult.pageSize?.height}`,
    `Session dir: ${actionResult.sessionDir}`,
    `Files: ${prefix}.html, ${prefix}.md, ${prefix}.png, ${prefix}-console.txt`
  ];

  // Add console messages if any
  if (actionResult.consoleLog && actionResult.consoleLog.length > 0) {
    response.push(`Console: ${actionResult.consoleLog.length} messages`);
    actionResult.consoleLog.slice(0, 3).forEach((msg: any) => {
      response.push(`  ${msg.level}: ${msg.text}`);
    });
    if (actionResult.consoleLog.length > 3) {
      response.push(`  ... +${actionResult.consoleLog.length - 3} more`);
    }
  }

  // Compact DOM summary
  if (actionResult.domSummary) {
    const lines = actionResult.domSummary.split('\n').slice(0, 8);
    response.push('DOM:', ...lines.map((l: string) => `  ${l}`));
    if (actionResult.domSummary.split('\n').length > 8) {
      response.push('  ...');
    }
  }

  return response.join('\n');
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
      const navResult = await chromeLib.navigate(tabIndex, params.payload, true); // Enable auto-capture

      // Handle enhanced response
      if (typeof navResult === 'object' && navResult.url) {
        const prefix = navResult.capturePrefix || '???';
        const response = [
          `Navigated to ${navResult.url}`,
          `Current URL: ${navResult.url}`,
          `Size: ${navResult.pageSize?.width}×${navResult.pageSize?.height}`,
          `Session dir: ${navResult.sessionDir}`,
          `Files: ${prefix}.html, ${prefix}.md, ${prefix}.png, ${prefix}-console.txt`
        ];

        if (navResult.error) {
          response.push(`⚠️ ${navResult.error}`);
        }

        // Add console messages if any
        if (navResult.consoleLog && navResult.consoleLog.length > 0) {
          response.push(`Console: ${navResult.consoleLog.length} messages`);
          navResult.consoleLog.slice(0, 3).forEach((msg: any) => {
            response.push(`  ${msg.level}: ${msg.text}`);
          });
          if (navResult.consoleLog.length > 3) {
            response.push(`  ... +${navResult.consoleLog.length - 3} more`);
          }
        }

        // Compact DOM summary
        if (navResult.domSummary) {
          const lines = navResult.domSummary.split('\n').slice(0, 8);
          response.push('DOM:', ...lines.map((l: string) => `  ${l}`));
          if (navResult.domSummary.split('\n').length > 8) {
            response.push('  ...');
          }
        }

        return response.join('\n');
      } else {
        return `Navigated to ${params.payload}`;
      }

    case BrowserAction.CLICK:
      if (!params.selector) {
        throw new Error("click requires selector");
      }
      const clickResult = await chromeLib.clickWithCapture(tabIndex, params.selector);
      return formatActionResponse(clickResult, `Clicked: ${params.selector}`);

    case BrowserAction.TYPE:
      if (!params.selector) {
        throw new Error("type requires selector");
      }
      if (!params.payload || typeof params.payload !== 'string') {
        throw new Error("type requires payload with text");
      }
      const typeResult = await chromeLib.fillWithCapture(tabIndex, params.selector, params.payload);
      return formatActionResponse(typeResult, `Typed "${params.payload}" into: ${params.selector}`);

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

    case BrowserAction.SELECT:
      if (!params.selector) {
        throw new Error("select requires selector");
      }
      if (!params.payload || typeof params.payload !== 'string') {
        throw new Error("select requires payload with option value");
      }
      const selectResult = await chromeLib.selectOptionWithCapture(tabIndex, params.selector, params.payload);
      return formatActionResponse(selectResult, `Selected "${params.payload}" in: ${params.selector}`);

    case BrowserAction.EVAL:
      if (!params.payload || typeof params.payload !== 'string') {
        throw new Error("eval requires payload with JavaScript code");
      }
      const evalResult = await chromeLib.evaluateWithCapture(tabIndex, params.payload);
      return formatActionResponse(evalResult, `Evaluated: ${params.payload}\nResult: ${evalResult.result}`);

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

    case BrowserAction.HELP:
      return `# Chrome Browser Control

Auto-starting Chrome with automatic page captures for every DOM action.

## Actions Overview
navigate, click, type, select, eval → Capture page state (HTML, markdown, screenshot, DOM summary)
extract, attr, screenshot → Get content/visuals
await_element, await_text → Wait for page changes
list_tabs, new_tab, close_tab → Tab management

## Navigation & Interaction (Auto-Capture Enabled)
navigate: {"action": "navigate", "payload": "URL"} → Files saved to disk automatically
click: {"action": "click", "selector": "CSS_or_XPath"} → Post-click files saved
type: {"action": "type", "selector": "input", "payload": "text\\n"} → Form state saved
select: {"action": "select", "selector": "select", "payload": "option_value"} → Selection saved
eval: {"action": "eval", "payload": "JavaScript_code"} → Result + page state saved

## Content & Export (Manual) - CHECK AUTO-CAPTURED FILES FIRST
extract: {"action": "extract", "payload": "markdown|text|html", "selector": "required"} → ONLY for specific elements/changed content
attr: {"action": "attr", "selector": "element", "payload": "attribute_name"} → Get single attribute
screenshot: {"action": "screenshot", "payload": "filename", "selector": "optional"} → Custom screenshot

## Waiting & Timing
await_element: {"action": "await_element", "selector": "CSS_or_XPath", "timeout": 5000}
await_text: {"action": "await_text", "payload": "text_to_wait_for", "timeout": 5000}

## Tab Management
list_tabs: {"action": "list_tabs"} → Shows all tabs with indices
new_tab: {"action": "new_tab"}
close_tab: {"action": "close_tab", "tab_index": 1}

## Auto-Capture System
DOM actions automatically save content to disk - NO EXTRACT NEEDED:
- {prefix}.html (full rendered DOM) → Use instead of extract with "html"
- {prefix}.md (structured content) → Use instead of extract with "markdown"
- {prefix}.png (visual state) → Use instead of screenshot action
- {prefix}-console.txt (browser messages)
All files go in a single session directory with prefixes: 001-navigate, 002-click, etc.

The files are immediately available after navigate/click/type/select/eval actions.

## Selectors
CSS: "button.submit", "#email", ".form input[name=password]"
XPath: "//button[@type='submit']", "//input[@name='email']"

## Essential Patterns
Login flow (auto-captured - CHECK page.md FIRST):
{"action": "navigate", "payload": "https://site.com/login"} → page.md available, check it first!
{"action": "await_element", "selector": "#email"}
{"action": "type", "selector": "#email", "payload": "user@test.com"} → form state saved
{"action": "type", "selector": "#password", "payload": "pass123\\n"} → success page saved to page.md

Extract specific content ONLY when auto-capture insufficient:
{"action": "navigate", "payload": "https://example.com"} → Full page auto-saved to page.md
// CHECK page.md first! Only extract if you need specific element:
{"action": "extract", "payload": "text", "selector": ".price"} → ONLY if price not in page.md

Multi-tab workflow:
{"action": "list_tabs"}
{"action": "new_tab"}
{"action": "navigate", "tab_index": 1, "payload": "https://example.com"} → Auto-captured

## Troubleshooting
Element not found → Use await_element first, check auto-captured page.html for correct selectors
Timeout errors → Increase timeout parameter or wait for specific elements
Tab errors → Use list_tabs to get current indices

Chrome auto-starts. All DOM actions provide rich context via automatic captures.`;

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
  `Control persistent Chrome browser with automatic page capture. DOM actions (navigate, click, type, select, eval) save page content to disk automatically - CHECK AUTO-CAPTURED FILES FIRST.

🚨 CRITICAL: Navigation auto-captures {prefix}.md, {prefix}.html, {prefix}.png in session dir. Check these BEFORE running extract!

EXTRACT ONLY WHEN: You need specific elements, different format, or content changed since navigation.

Selectors: CSS or XPath (XPath starts with / or //). Append \\n to payload in 'type' to submit forms.

Examples: {action:"navigate", payload:"https://site.com"} → page.md auto-captured | {action:"extract", payload:"text", selector:".price"} → only for specific elements

Workflows: navigate→check_page.md_first | extract→only_if_auto_capture_insufficient`,
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
  // Initialize session and register cleanup
  chromeLib.initializeSession();

  // Create stdio transport
  const transport = new StdioServerTransport();

  // Connect server to transport
  await server.connect(transport);

  console.error(`Chrome MCP server running via stdio${headlessMode ? ' (headless mode)' : ''}`);
}

// Run the server
main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
