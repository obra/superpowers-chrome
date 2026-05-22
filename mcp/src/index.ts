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
const chromeLib = require(join(__dirname, "../../skills/browsing/chrome-ws-lib.js")).createSession();
const SERVER_VERSION = require(join(__dirname, "../package.json")).version;

// Track if Chrome has been started
let chromeStarted = false;

/**
 * Detect if a display is available for headed browser mode.
 * Returns true if we can show a browser window.
 */
function hasDisplay(): boolean {
  const platform = process.platform;

  if (platform === 'darwin') {
    // macOS: Generally has a display if running interactively
    // Check if we're in a GUI session (not SSH without forwarding)
    return process.env.TERM_PROGRAM !== undefined || process.env.DISPLAY !== undefined;
  } else if (platform === 'win32') {
    // Windows: Assume display available (headless Windows servers are rare)
    return true;
  } else {
    // Linux/Unix: Check DISPLAY or WAYLAND_DISPLAY environment variables
    return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  }
}

// Parse command line arguments for headless mode and port
// --headless: Force headless mode
// --headed: Force headed mode (will fail if no display)
// --port=N: Use specific CDP port (overrides dynamic allocation)
// Default: headless if no display available, headed otherwise
const forceHeadless = process.argv.includes('--headless');
const forceHeaded = process.argv.includes('--headed');
const portArg = process.argv.find(a => a.startsWith('--port='));
const explicitPort = portArg ? parseInt(portArg.split('=')[1], 10) : undefined;

let headlessMode: boolean;
if (forceHeadless) {
  headlessMode = true;
} else if (forceHeaded) {
  headlessMode = false;
} else {
  // Auto-detect: headless if no display available
  headlessMode = !hasDisplay();
}

// Action enum for use_browser tool
// Note: click and type now use CDP events by default (React-compatible)
enum BrowserAction {
  NAVIGATE = "navigate",
  BACK = "back",                // history.back() — go back one entry
  FORWARD = "forward",          // history.forward() — go forward one entry
  CLICK = "click",              // Uses CDP mouse events (works with React)
  TYPE = "type",                // Uses CDP humanType (character-by-character with delays)
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
  SHOW_BROWSER = "show_browser",
  HIDE_BROWSER = "hide_browser",
  BROWSER_MODE = "browser_mode",
  SET_PROFILE = "set_profile",
  GET_PROFILE = "get_profile",
  HELP = "help",
  // Mouse actions (CDP-level, bypasses synthetic event restrictions)
  HOVER = "hover",
  DRAG_DROP = "drag_drop",
  MOUSE_MOVE = "mouse_move",
  SCROLL = "scroll",
  DOUBLE_CLICK = "double_click",
  RIGHT_CLICK = "right_click",
  // File upload (DOM.setFileInputFiles)
  FILE_UPLOAD = "file_upload",
  // Special keys (Tab, Enter, Escape, Arrow keys, etc.)
  KEYBOARD_PRESS = "keyboard_press",
  // Viewport control (mobile testing, responsive design)
  SET_VIEWPORT = "set_viewport",
  CLEAR_VIEWPORT = "clear_viewport",
  GET_VIEWPORT = "get_viewport",
  // Cookie management
  CLEAR_COOKIES = "clear_cookies",
  // Console logging capture (Runtime.consoleAPICalled stream)
  ENABLE_CONSOLE_LOGGING = "enable_console_logging",
  GET_CONSOLE_MESSAGES = "get_console_messages",
  CLEAR_CONSOLE_MESSAGES = "clear_console_messages",
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
    .describe("CSS or XPath selector. XPath must start with / or //. Optional for type (types into current focus)."),
  payload: z.string()
    .optional()
    .describe("Action-specific data: navigate=URL | type=text (\\t=Tab, \\n=Enter) | extract=format (text|html|markdown) | screenshot=filename | eval=JavaScript | select=option value or visible label, or JSON array of either for <select multiple> | attr=attribute name | await_text=text to wait for | keyboard_press=key name (Tab, Enter, Space, Escape, Arrow*, F1-F12) | drag_drop=target CSS selector or JSON {\"x\":N,\"y\":N} | mouse_move=JSON {\"x\":N,\"y\":N} or {\"x\":N,\"y\":N,\"steps\":N,\"fromX\":N,\"fromY\":N} | scroll=JSON {\"deltaX\":N,\"deltaY\":N} or direction (up/down/left/right) | file_upload=JSON {\"files\":[\"path1\",\"path2\"]}"),
  timeout: z.number()
    .int()
    .min(0)
    .max(60000)
    .default(5000)
    .describe("Timeout in ms. Only for await actions."),
  // Keyboard modifiers for keyboard_press (Shift+Tab, Ctrl+A, etc.)
  modifiers: z.object({
    alt: z.boolean().optional(),
    ctrl: z.boolean().optional(),
    meta: z.boolean().optional(),
    shift: z.boolean().optional(),
  }).optional().describe("Keyboard modifiers for keyboard_press"),
  // Element index when selector matches multiple elements
  index: z.number().int().min(0).optional().describe("Element index for select action when selector matches multiple elements"),
  // Viewport settings for device emulation (set_viewport action)
  viewport: z.object({
    width: z.number()
      .int()
      .min(320)
      .max(7680)
      .optional()
      .describe("Viewport width in CSS pixels"),
    height: z.number()
      .int()
      .min(200)
      .max(4320)
      .optional()
      .describe("Viewport height in CSS pixels"),
    deviceScaleFactor: z.number()
      .min(0.25)
      .max(5)
      .default(1)
      .describe("DPI multiplier (1=96dpi, 2=192dpi for retina)"),
    mobile: z.boolean()
      .default(false)
      .describe("Enable mobile emulation (touch events + mobile UA string)"),
  })
    .optional()
    .describe("Viewport settings for device emulation (set_viewport action)"),
  // Full-page screenshot flag (screenshot action)
  fullpage: z.boolean()
    .optional()
    .describe("Capture full scrollable page content, not just the visible viewport (screenshot action)")
};

type UseBrowserInput = z.infer<ReturnType<typeof z.object<typeof UseBrowserParams>>>;

/**
 * Ensure Chrome is running, auto-start if needed.
 * startChrome() handles meta.json discovery and reconnection to existing
 * Chrome instances, so we delegate entirely to it rather than probing
 * a potentially wrong port with getTabs() first.
 */
async function ensureChromeRunning(): Promise<void> {
  if (chromeStarted) {
    return;
  }

  try {
    // startChrome checks meta.json for existing Chrome, reconnects if alive,
    // otherwise finds an available port and launches a new instance.
    await chromeLib.startChrome(headlessMode, undefined, explicitPort);
    chromeStarted = true;
  } catch (startError) {
    throw new Error(`Failed to auto-start Chrome: ${startError instanceof Error ? startError.message : String(startError)}`);
  }
}

/**
 * Format a DialogRefusedError into a human-readable tool response string.
 * Uses duck typing (error.refused && error.artifacts) rather than instanceof
 * because class identity can be unreliable across CommonJS require boundaries.
 */
function formatDialogRefusal(error: any): string {
  const lines: string[] = [error.message || 'Page is behind a dialog.'];
  if (error.artifacts?.markdown) {
    lines.push('');
    lines.push(error.artifacts.markdown);
  }
  return lines.join('\n');
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
 * Format capture response with DOM diff information
 */
function formatCaptureResponse(
  action: string,
  details: string,
  capture: {
    sessionDir: string;
    files: Record<string, string>;
    diffSummary: string;
    domSummary: string;
    pageSize: { width: number; height: number };
  }
): string {
  const fileList = Object.entries(capture.files)
    .map(([key, path]) => `  ${key}: ${path}`)
    .join('\n');

  return `${action}: ${details}

📁 Capture saved to: ${capture.sessionDir}
${fileList}

📊 Page: ${capture.pageSize.width}×${capture.pageSize.height}
${capture.domSummary}

📝 DOM Changes:
${capture.diffSummary}`;
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

    case BrowserAction.BACK:
      await chromeLib.back(tabIndex);
      return `Went back (history.back())`;

    case BrowserAction.FORWARD:
      await chromeLib.forward(tabIndex);
      return `Went forward (history.forward())`;

    case BrowserAction.CLICK:
      if (!params.selector) {
        throw new Error("click requires selector");
      }
      const clickResult = await chromeLib.clickWithCapture(tabIndex, params.selector);
      return formatActionResponse(clickResult, `Clicked: ${params.selector}`);

    case BrowserAction.TYPE:
      if (!params.payload || typeof params.payload !== 'string') {
        throw new Error("type requires payload with text");
      }
      // Selector is optional - if omitted, types into current focus
      const typeResult = await chromeLib.captureActionWithDiff(
        tabIndex,
        'type',
        () => chromeLib.humanType(tabIndex, params.selector || null, params.payload)
      );
      // When a dialog is open, captureActionWithDiff skips capture and returns
      // only { actionResult }. The inner dialog router returns a staging result.
      if (!typeResult.capture) {
        const target = params.selector ? `into ${params.selector}` : 'into current focus';
        return `Typed: ${target}\n${JSON.stringify(typeResult.actionResult ?? {})}`;
      }
      return formatCaptureResponse(
        'Typed',
        params.selector ? `into ${params.selector}` : 'into current focus',
        typeResult.capture
      );

    case BrowserAction.EXTRACT:
      const format = params.payload || 'text';
      if (typeof format !== 'string') {
        throw new Error("extract payload must be a string format");
      }

      if (params.selector) {
        // Extract specific element
        let extracted: string | null | undefined;
        if (format === 'text') {
          extracted = await chromeLib.extractText(tabIndex, params.selector);
        } else if (format === 'html') {
          extracted = await chromeLib.getHtml(tabIndex, params.selector);
        } else {
          throw new Error("selector-based extraction only supports 'text' or 'html' format");
        }
        if (extracted == null) {
          return `Element not found: ${params.selector}`;
        }
        return extracted;
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
      const filepath = await chromeLib.screenshot(
        tabIndex,
        params.payload,
        params.selector || undefined,
        params.fullpage ?? false
      );
      return `Screenshot saved to ${filepath}`;

    case BrowserAction.SELECT:
      if (!params.selector) {
        throw new Error("select requires selector");
      }
      if (!params.payload || typeof params.payload !== 'string') {
        throw new Error("select requires payload with option value, label, or JSON array");
      }
      let selectValue: string | string[] = params.payload;
      if (params.payload.trim().startsWith('[')) {
        try {
          const parsed = JSON.parse(params.payload);
          if (Array.isArray(parsed) && parsed.every((v: unknown) => typeof v === 'string')) {
            selectValue = parsed;
          }
        } catch {
          // Not JSON — treat the literal string as a single value
        }
      }
      const selectResult = await chromeLib.selectOptionWithCapture(tabIndex, params.selector, selectValue);
      return formatActionResponse(selectResult, `Selected ${JSON.stringify(selectValue)} in: ${params.selector}`);

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

    case BrowserAction.NEW_TAB: {
      // If a URL payload is provided, pass it to newTab so Chrome opens
      // the tab at that URL directly (via /json/new?<url>).
      const newTabUrl = (params.payload && params.payload.trim()) ? params.payload.trim() : undefined;
      const newTabResult = await chromeLib.newTab(newTabUrl);
      const openedAt = newTabUrl ? ` at ${newTabUrl}` : '';
      return `New tab created: ${newTabResult.id}${openedAt}`;
    }

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

    case BrowserAction.SHOW_BROWSER:
      const showResult = await chromeLib.showBrowser();
      return showResult;

    case BrowserAction.HIDE_BROWSER:
      const hideResult = await chromeLib.hideBrowser();
      return hideResult;

    case BrowserAction.BROWSER_MODE:
      const mode = await chromeLib.getBrowserMode();
      return JSON.stringify(mode, null, 2);

    case BrowserAction.SET_PROFILE:
      if (!params.payload || typeof params.payload !== 'string') {
        throw new Error("set_profile requires payload with profile name");
      }
      const setProfileResult = chromeLib.setProfileName(params.payload);
      return setProfileResult;

    case BrowserAction.GET_PROFILE:
      const currentProfile = chromeLib.getProfileName();
      const profileDir = chromeLib.getChromeProfileDir(currentProfile);
      return JSON.stringify({
        profile: currentProfile,
        profileDir: profileDir
      }, null, 2);

    case BrowserAction.HOVER: {
      if (!params.selector) {
        throw new Error("hover requires selector");
      }
      const hoverResult = await chromeLib.captureActionWithDiff(
        tabIndex,
        'hover',
        () => chromeLib.hover(tabIndex, params.selector)
      );
      return formatCaptureResponse(
        'Hovered',
        params.selector,
        hoverResult.capture
      );
    }

    case BrowserAction.DRAG_DROP: {
      if (!params.selector) {
        throw new Error("drag_drop requires selector (source element)");
      }
      if (!params.payload) {
        throw new Error("drag_drop requires payload (target selector or JSON coordinates {\"x\":N,\"y\":N})");
      }

      // Parse target: JSON coordinates or selector string
      let dragTarget: string | { x: number; y: number } = params.payload;
      try {
        const parsed = JSON.parse(params.payload);
        if (typeof parsed === 'object' && parsed.x !== undefined && parsed.y !== undefined) {
          dragTarget = { x: parsed.x, y: parsed.y };
        }
      } catch {
        // Not JSON — treat as selector string
      }

      const dragResult = await chromeLib.captureActionWithDiff(
        tabIndex,
        'drag',
        () => chromeLib.drag(tabIndex, params.selector, dragTarget)
      );
      const targetDesc = typeof dragTarget === 'object'
        ? `(${dragTarget.x}, ${dragTarget.y})`
        : dragTarget;
      return formatCaptureResponse(
        'Dragged',
        `${params.selector} → ${targetDesc}`,
        dragResult.capture
      );
    }

    case BrowserAction.MOUSE_MOVE: {
      if (!params.payload) {
        throw new Error("mouse_move requires payload with JSON coordinates {\"x\":N,\"y\":N}");
      }
      let moveParams: any;
      try {
        moveParams = JSON.parse(params.payload);
      } catch {
        throw new Error("mouse_move payload must be JSON: {\"x\":N,\"y\":N} (optional: steps, fromX, fromY)");
      }
      if (moveParams.x === undefined || moveParams.y === undefined) {
        throw new Error("mouse_move payload must include x and y coordinates");
      }
      const moveResult = await chromeLib.mouseMove(tabIndex, moveParams.x, moveParams.y, {
        steps: moveParams.steps,
        fromX: moveParams.fromX,
        fromY: moveParams.fromY
      });
      return `Mouse moved to (${moveResult.x}, ${moveResult.y})`;
    }

    case BrowserAction.SCROLL: {
      if (!params.payload) {
        throw new Error("scroll requires payload: direction (up/down/left/right) or JSON {\"deltaX\":N,\"deltaY\":N}");
      }

      const scrollOpts: { selector?: string; deltaX?: number; deltaY?: number } = {};
      if (params.selector) {
        scrollOpts.selector = params.selector;
      }

      // Parse direction strings or JSON
      const scrollAmount = 300;
      const payloadLower = params.payload.toLowerCase().trim();
      if (payloadLower === 'down') {
        scrollOpts.deltaY = scrollAmount;
      } else if (payloadLower === 'up') {
        scrollOpts.deltaY = -scrollAmount;
      } else if (payloadLower === 'right') {
        scrollOpts.deltaX = scrollAmount;
      } else if (payloadLower === 'left') {
        scrollOpts.deltaX = -scrollAmount;
      } else {
        try {
          const parsed = JSON.parse(params.payload);
          scrollOpts.deltaX = parsed.deltaX || 0;
          scrollOpts.deltaY = parsed.deltaY || 0;
        } catch {
          throw new Error("scroll payload must be a direction (up/down/left/right) or JSON {\"deltaX\":N,\"deltaY\":N}");
        }
      }

      const scrollResult = await chromeLib.scroll(tabIndex, scrollOpts);
      const dir = scrollOpts.deltaY && scrollOpts.deltaY > 0 ? 'down' :
                  scrollOpts.deltaY && scrollOpts.deltaY < 0 ? 'up' :
                  scrollOpts.deltaX && scrollOpts.deltaX > 0 ? 'right' : 'left';
      return `Scrolled ${dir} (deltaX: ${scrollResult.deltaX}, deltaY: ${scrollResult.deltaY})${params.selector ? ` at ${params.selector}` : ''}`;
    }

    case BrowserAction.DOUBLE_CLICK: {
      if (!params.selector) {
        throw new Error("double_click requires selector");
      }
      const dblClickResult = await chromeLib.captureActionWithDiff(
        tabIndex,
        'dblclick',
        () => chromeLib.doubleClick(tabIndex, params.selector)
      );
      return formatCaptureResponse(
        'Double-clicked',
        params.selector,
        dblClickResult.capture
      );
    }

    case BrowserAction.RIGHT_CLICK: {
      if (!params.selector) {
        throw new Error("right_click requires selector");
      }
      const rightClickResult = await chromeLib.captureActionWithDiff(
        tabIndex,
        'rightclick',
        () => chromeLib.rightClick(tabIndex, params.selector)
      );
      return formatCaptureResponse(
        'Right-clicked',
        params.selector,
        rightClickResult.capture
      );
    }



    case BrowserAction.FILE_UPLOAD: {
      if (!params.selector) {
        throw new Error("file_upload requires selector for the file input element");
      }
      if (!params.payload) {
        throw new Error("file_upload requires payload with JSON {\"files\":[\"path1\",\"path2\"]}");
      }
      let filePaths: string[];
      try {
        const parsed = JSON.parse(params.payload);
        filePaths = Array.isArray(parsed.files) ? parsed.files : Array.isArray(parsed) ? parsed : [params.payload];
      } catch {
        // Single file path as plain string
        filePaths = [params.payload];
      }
      const uploadResult = await chromeLib.captureActionWithDiff(
        tabIndex,
        'upload',
        () => chromeLib.fileUpload(tabIndex, params.selector, filePaths)
      );
      return formatCaptureResponse(
        'Uploaded',
        `${filePaths.length} file(s) to ${params.selector}`,
        uploadResult.capture
      );
    }

    case BrowserAction.KEYBOARD_PRESS:
      // Press special keys (Tab, Enter, Escape, Arrow keys, etc.)
      if (!params.payload) {
        throw new Error("keyboard_press requires payload with key name (e.g., Tab, Enter, Escape)");
      }
      const keyResult = await chromeLib.captureActionWithDiff(
        tabIndex,
        'keypress',
        () => chromeLib.keyboardPress(tabIndex, params.payload, params.modifiers || {})
      );
      const modStr = Object.entries(params.modifiers || {})
        .filter(([_, v]) => v)
        .map(([k]) => k)
        .join('+');
      return formatCaptureResponse(
        'Pressed',
        modStr ? `${modStr}+${params.payload}` : params.payload,
        keyResult.capture
      );

    case BrowserAction.SET_VIEWPORT: {
      if (!params.viewport) {
        throw new Error("set_viewport requires a viewport object (empty object uses default 1200x800 dimensions)");
      }
      const viewportResult = await chromeLib.setViewport(tabIndex, params.viewport);
      return `Viewport set: ${viewportResult.width}x${viewportResult.height} CSS pixels (scale: ${viewportResult.deviceScaleFactor}, mobile: ${viewportResult.mobile}, touch: ${viewportResult.touch})`;
    }

    case BrowserAction.CLEAR_VIEWPORT: {
      await chromeLib.clearViewport(tabIndex);
      return `Viewport cleared (reset to browser default)`;
    }

    case BrowserAction.GET_VIEWPORT: {
      const vp = await chromeLib.getViewport(tabIndex);
      return `Current viewport: ${vp.innerWidth}x${vp.innerHeight} CSS pixels (devicePixelRatio: ${vp.devicePixelRatio}, orientation: ${vp.orientation})`;
    }

    case BrowserAction.CLEAR_COOKIES: {
      await chromeLib.clearCookies(tabIndex);
      return `Cookies cleared`;
    }

    case BrowserAction.ENABLE_CONSOLE_LOGGING: {
      await chromeLib.enableConsoleLogging(tabIndex);
      return `Console logging enabled. Use get_console_messages to read; clear_console_messages to reset.`;
    }

    case BrowserAction.GET_CONSOLE_MESSAGES: {
      const messages = await chromeLib.getConsoleMessages(tabIndex);
      if (!messages || messages.length === 0) {
        return `No console messages captured. (Call enable_console_logging first if you haven't.)`;
      }
      return messages.map((m: any) => `[${m.timestamp}] ${m.level}: ${m.text}`).join('\n');
    }

    case BrowserAction.CLEAR_CONSOLE_MESSAGES: {
      await chromeLib.clearConsoleMessages(tabIndex);
      return `Console messages cleared`;
    }

    case BrowserAction.HELP:
      return `# Chrome Browser Control

Auto-starting Chrome with automatic page captures for every DOM action.

## Actions Overview
navigate, click, type, keyboard_press, select, eval → Capture page state with before/after DOM diff
hover, drag_drop, mouse_move, scroll, double_click, right_click → CDP-level mouse actions (native DnD)
file_upload → Set files on input[type=file] (DOM.setFileInputFiles)
extract, attr, screenshot, screenshot+fullpage → Get content/visuals
await_element, await_text → Wait for page changes
list_tabs, new_tab, close_tab → Tab management
show_browser, hide_browser, browser_mode → Toggle headless/headed mode
set_viewport, clear_viewport, get_viewport → Device emulation (mobile/tablet/desktop)
clear_cookies → Clear all browser cookies
set_profile, get_profile → Manage Chrome profiles

## Navigation & Interaction (Auto-Capture with DOM Diff)
navigate: {"action": "navigate", "payload": "URL"} → Before/after HTML + diff
click: {"action": "click", "selector": "CSS_or_XPath"} → React-compatible CDP events
type: {"action": "type", "payload": "text", "selector": "optional"} → Text input (\\t=Tab, \\n=Enter)
keyboard_press: {"action": "keyboard_press", "payload": "Tab"} → Special keys
select: {"action": "select", "selector": "select", "payload": "value_or_visible_label"}
select: {"action": "select", "selector": "select[multiple]", "payload": "[\\"opt1\\",\\"opt2\\"]"} → Multi-select
eval: {"action": "eval", "payload": "JavaScript_code"}

## Mouse Actions (CDP-Level — bypasses synthetic event restrictions)
hover: {"action": "hover", "selector": "element"} → CSS :hover, tooltips, menus
drag_drop: {"action": "drag_drop", "selector": "source", "payload": "target_selector"} → Native drag-and-drop
drag_drop: {"action": "drag_drop", "selector": "source", "payload": "{\\"x\\":300,\\"y\\":200}"} → Drag to coordinates
mouse_move: {"action": "mouse_move", "payload": "{\\"x\\":100,\\"y\\":200}"} → Move to coordinates
mouse_move: {"action": "mouse_move", "payload": "{\\"x\\":100,\\"y\\":200,\\"steps\\":10,\\"fromX\\":0,\\"fromY\\":0}"} → Smooth movement
scroll: {"action": "scroll", "payload": "down"} → Scroll down (also: up, left, right)
scroll: {"action": "scroll", "selector": ".container", "payload": "{\\"deltaX\\":0,\\"deltaY\\":500}"} → Scroll within element
double_click: {"action": "double_click", "selector": "element"} → Text selection, open items
right_click: {"action": "right_click", "selector": "element"} → Context menu

## File Upload
file_upload: {"action": "file_upload", "selector": "#file-input", "payload": "/path/to/file.pdf"} → Single file
file_upload: {"action": "file_upload", "selector": "#upload", "payload": "{\\"files\\":[\\"/path/a.pdf\\",\\"/path/b.jpg\\"]}"} → Multiple files

## keyboard_press Examples
{"action": "keyboard_press", "payload": "Tab"} → Move to next field
{"action": "keyboard_press", "payload": "Space"} → Toggle checkbox
{"action": "keyboard_press", "payload": "ArrowDown"} → Navigate dropdown
{"action": "keyboard_press", "payload": "Tab", "modifiers": {"shift": true}} → Shift+Tab

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

## Browser Mode Control
show_browser: {"action": "show_browser"} → Make browser window visible (restarts Chrome, loses POST state)
hide_browser: {"action": "hide_browser"} → Switch to headless mode (restarts Chrome, loses POST state)
browser_mode: {"action": "browser_mode"} → Check current mode (headless/headed) and profile

⚠️  WARNING: Toggling browser visibility restarts Chrome and reloads pages via GET requests.
    This will LOSE form data, POST results, and any client-side state.
    Default: headless mode (faster, less intrusive)

## Device Emulation (Viewport Control)
set_viewport: {
  "action": "set_viewport",
  "tab_index": 0,
  "viewport": {
    "width": 375,
    "height": 812,
    "deviceScaleFactor": 2,
    "mobile": true
  }
} → Mobile device emulation (e.g., iPhone 12: 375x812 CSS pixels, 2x scale, mobile UA + touch)

set_viewport: {
  "action": "set_viewport",
  "viewport": {"width": 1920, "height": 1080}
} → Desktop 1080p

clear_viewport: {"action": "clear_viewport"} → Reset to browser default
get_viewport: {"action": "get_viewport"} → Get current viewport dimensions and devicePixelRatio

Viewport persists across actions. Set once, then navigate/click/screenshot at that viewport.

## Cookie Management
clear_cookies: {"action": "clear_cookies"} → Clear all browser cookies

## Profile Management
set_profile: {"action": "set_profile", "payload": "profile-name"} → Set Chrome profile (must kill Chrome first)
get_profile: {"action": "get_profile"} → Get current profile name and directory

Profiles are stored in: ~/.cache/superpowers/browser-profiles/{profile-name}/
Default profile: "superpowers-chrome"
Profile data persists across sessions (cookies, localStorage, extensions, etc.)

## Auto-Capture System
Every DOM action auto-captures to the session dir:
- {prefix}.png — viewport screenshot
- {prefix}.md — page content as structured markdown
- {prefix}.html — full rendered DOM
- {prefix}-console.txt — browser console messages

Files use sequential prefixes: 001-navigate, 002-click, etc.
Prefer reading these files to using 'extract' or 'screenshot' whenever possible.

## Selectors
CSS: "button.submit", "#email", ".form input[name=password]"
XPath: "//button[@type='submit']", "//input[@name='email']"

## Essential Patterns
Login flow (auto-captured - CHECK page.md FIRST):
{"action": "navigate", "payload": "https://site.com/login"} → page.md available, check it first!
{"action": "await_element", "selector": "#email"}
{"action": "type", "selector": "#email", "payload": "user@test.com"}
{"action": "type", "selector": "#password", "payload": "pass123"}
{"action": "keyboard_press", "payload": "Enter"} → submit form

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
  version: SERVER_VERSION
});

// Register the use_browser tool
server.tool(
  "use_browser",
  `Control persistent Chrome browser with automatic page capture.

Every DOM action (navigate, click, type, select, eval) auto-captures to the session dir:
- {prefix}.png — viewport screenshot
- {prefix}.md — page content as structured markdown
- {prefix}.html — full rendered DOM
- {prefix}-console.txt — browser console messages

Prefer reading these files to using 'extract' or 'screenshot' whenever possible.

Selectors: CSS or XPath (XPath starts with / or //). Append \\n to payload in 'type' to submit forms.

Additional actions: hover, drag_drop, mouse_move, scroll, double_click, right_click, file_upload. Use 'help' for full docs.`,
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

      // Ensure Chrome is running (except for actions that don't need it)
      const actionsNotRequiringChrome = [
        BrowserAction.SET_PROFILE,    // Must have Chrome stopped
        BrowserAction.GET_PROFILE,    // Just returns config
        BrowserAction.BROWSER_MODE,   // Just returns state
        BrowserAction.HELP            // Just returns help text
      ];

      if (!actionsNotRequiringChrome.includes(params.action)) {
        await ensureChromeRunning();
      }

      // Execute browser action
      const result = await executeBrowserAction(params);

      return {
        content: [{
          type: "text" as const,
          text: result
        }]
      };
    } catch (error) {
      // DialogRefusedError: page-target action blocked by open native dialog.
      // Surface as a synthetic tool response rather than a generic error so the
      // model receives the dialog description and knows how to proceed.
      if (error && (error as any).refused === true && (error as any).artifacts) {
        return {
          content: [{
            type: "text" as const,
            text: formatDialogRefusal(error as any),
          }],
        };
      }
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

  const modeReason = forceHeadless ? 'forced via --headless' :
                     forceHeaded ? 'forced via --headed' :
                     headlessMode ? 'auto-detected no display' : 'display available';
  const portInfo = explicitPort ? `, port: ${explicitPort} (via --port)` : '';
  console.error(`Chrome MCP server running via stdio (${headlessMode ? 'headless' : 'headed'} mode, ${modeReason}${portInfo})`);
}

// Run the server
main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
