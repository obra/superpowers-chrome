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

// Set to true when Chrome auto-restarted due to an external kill.
// Consumed (and cleared) by executeBrowserAction on the first action after restart.
let chromeWasRestarted = false;

// Action enum for use_browser tool
enum BrowserAction {
  NAVIGATE = "navigate",
  BACK = "back",                // history.back() — go back one entry
  FORWARD = "forward",          // history.forward() — go forward one entry
  CLICK = "click",              // Uses CDP mouse events (works with React); selector=CSS/XPath
  TYPE = "type",                // Uses CDP humanType; selector=target (optional), payload=text or {text}
  EXTRACT = "extract",          // selector=CSS/XPath (optional), payload={format?}
  SCREENSHOT = "screenshot",    // selector=CSS/XPath element (optional), payload={path,fullpage?}
  EVAL = "eval",                // payload=JS string
  SELECT = "select",            // selector=CSS/XPath, payload={value,index?} object
  ATTR = "attr",                // selector=CSS/XPath, payload={attr} object
  AWAIT_ELEMENT = "await_element", // selector=CSS/XPath to wait for
  AWAIT_TEXT = "await_text",    // payload={text,timeout?} or text string; timeout= top-level ms
  NEW_TAB = "new_tab",          // payload=URL string (optional)
  CLOSE_TAB = "close_tab",      // closes activeTab
  LIST_TABS = "list_tabs",
  // Tab management
  SWITCH_TAB = "switch_tab",    // payload=tab index, URL substring, or title substring
  SHOW_BROWSER = "show_browser",
  HIDE_BROWSER = "hide_browser",
  BROWSER_MODE = "browser_mode",
  SET_PROFILE = "set_profile",  // payload=profile name string
  GET_PROFILE = "get_profile",
  HELP = "help",
  // Mouse actions (CDP-level, bypasses synthetic event restrictions)
  HOVER = "hover",              // payload=selector string
  DRAG_DROP = "drag_drop",      // payload={source,target} where target is selector or {x,y}
  MOUSE_MOVE = "mouse_move",    // payload={x,y,steps?,fromX?,fromY?} object
  SCROLL = "scroll",            // payload={deltaX?,deltaY?,selector?} or direction string
  DOUBLE_CLICK = "double_click", // payload=selector string
  RIGHT_CLICK = "right_click",  // payload=selector string
  // File upload (DOM.setFileInputFiles)
  FILE_UPLOAD = "file_upload",  // payload={selector,files} object
  // Special keys (Tab, Enter, Escape, Arrow keys, etc.)
  KEYBOARD_PRESS = "keyboard_press", // payload={key,modifiers?} or key string
  // Viewport control (mobile testing, responsive design)
  SET_VIEWPORT = "set_viewport", // payload={width,height,deviceScaleFactor?,mobile?} object
  CLEAR_VIEWPORT = "clear_viewport",
  GET_VIEWPORT = "get_viewport",
  // Cookie management
  CLEAR_COOKIES = "clear_cookies",
  // Console logging capture (Runtime.consoleAPICalled stream)
  ENABLE_CONSOLE_LOGGING = "enable_console_logging",
  GET_CONSOLE_MESSAGES = "get_console_messages", // payload={since?} (epoch ms)
  CLEAR_CONSOLE_MESSAGES = "clear_console_messages",
  // Chrome lifecycle control
  KILL_CHROME = "kill_chrome",
  RESTART_CHROME = "restart_chrome",
}

// Reshaped 4-parameter schema for use_browser tool
const UseBrowserParams = {
  action: z.nativeEnum(BrowserAction)
    .describe("Action to perform. action='help' lists all actions with payload shapes."),
  selector: z.string().nullable().optional()
    .describe(
      "CSS or XPath selector — what to act on. Null/omitted for actions that don't target " +
      "an element (navigate, eval, list_tabs, etc.). XPath must start with / or //. " +
      "dialog::accept and dialog::dismiss are special selectors for handling open dialogs."
    ),
  payload: z.union([z.string(), z.record(z.any())]).optional()
    .describe(
      "Extra data for the action. String for simple cases (navigate=URL, type=text, eval=JS, " +
      "keyboard_press=key, set_profile=name, new_tab=URL). " +
      "Object for structured cases (set_viewport={width,height,mobile?}, " +
      "keyboard_press={key,modifiers:{shift?,ctrl?,alt?,meta?}}, " +
      "extract={format:'text'|'html'|'markdown'}, screenshot={path?,fullpage?}, " +
      "scroll={deltaX?,deltaY?} or direction string, " +
      "drag_drop={x,y} or selector string for target, " +
      "mouse_move={x,y,steps?,fromX?,fromY?}, " +
      "file_upload={files:[...]}, get_console_messages={since:epochMs}, " +
      "await_text=text string or {text,timeout?}, " +
      "switch_tab=tab index/url-substring/title-substring). " +
      "See action='help' for per-action payload shapes."
    ),
  timeout: z.number().int().min(0).max(60000).optional()
    .describe("Timeout in ms for await_element / await_text actions."),
  // Postel-accept legacy parameter. Many agents emit `tab_index` from prior
  // schema versions; rather than silently drop it, treat it as an implicit
  // switch_tab — set activeTab to this index for this and subsequent calls.
  // Prefer the `switch_tab` action explicitly; this is here so agents don't
  // get cryptic timeouts when they fall back to the older shape.
  tab_index: z.number().int().min(0).optional()
    .describe(
      "Legacy: behaves like switch_tab. Sets the active tab to this index " +
      "before running the action. Prefer the switch_tab action."
    ),
};

type UseBrowserInput = z.infer<ReturnType<typeof z.object<typeof UseBrowserParams>>>;

/**
 * Helper: coerce payload to an object.
 * If payload is a string, wraps it as { [defaultKey]: payload }.
 * If payload is already an object, returns it directly.
 * If payload is absent, returns {}.
 */
function parsePayload(payload: string | Record<string, any> | undefined, defaultKey: string): Record<string, any> {
  if (payload === undefined || payload === null) return {};
  if (typeof payload === 'string') return { [defaultKey]: payload };
  return payload as Record<string, any>;
}

/**
 * Ensure Chrome is running, auto-start if needed.
 * Always calls startChrome() so that after an external Chrome kill
 * the next action brings it back up automatically. startChrome() handles
 * meta.json discovery and reconnection (fast-path) so this is idempotent.
 *
 * Sets chromeWasRestarted=true when a brand-new Chrome process was spawned
 * (rather than reconnecting to an already-running one). executeBrowserAction
 * prepends the restart banner to the first response after a restart.
 */
async function ensureChromeRunning(): Promise<void> {
  try {
    // startChrome returns true when a new Chrome was spawned, false when it
    // reconnected to an existing instance (or adopted an orphan).
    const spawned = await chromeLib.startChrome(headlessMode, undefined, explicitPort);
    if (spawned === true) {
      chromeWasRestarted = true;
    }
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
 * Format capture response with DOM diff information.
 * When capture is null (action opened a dialog), returns dialog info instead.
 */
function formatCaptureResponse(
  action: string,
  details: string,
  captureOrNull: {
    sessionDir: string;
    files: Record<string, string>;
    diffSummary: string;
    domSummary: string;
    pageSize: { width: number; height: number };
  } | null,
  dialog?: any,
  artifacts?: any
): string {
  if (!captureOrNull) {
    // Action succeeded but opened a dialog — show dialog info
    const dialogDesc = artifacts?.markdown || (dialog ? `Dialog opened: ${dialog.kind}` : 'Dialog opened');
    return `${action}: ${details}\n\nDialog is now open — page is waiting for user input.\n\n${dialogDesc}`;
  }
  const capture = captureOrNull;

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

const RESTART_BANNER = '[Chrome auto-restarted; URL reset to about:blank. Re-navigate to continue.]';

/**
 * Execute browser action using chrome-ws library
 */
async function executeBrowserAction(params: UseBrowserInput): Promise<string> {
  const tabIndex = activeTab;
  // Selector comes from top-level param; payload string fallback for backward compat
  const topSelector = params.selector ?? null;
  const payload = params.payload;
  const topTimeout = params.timeout;

  switch (params.action) {
    case BrowserAction.NAVIGATE: {
      const p = parsePayload(payload, 'url');
      const url = p.url;
      if (!url || typeof url !== 'string') {
        throw new Error("navigate requires payload with URL");
      }
      const navResult = await chromeLib.navigate(tabIndex, url, true); // Enable auto-capture

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
        return `Navigated to ${url}`;
      }
    }

    case BrowserAction.BACK:
      await chromeLib.back(tabIndex);
      return `Went back (history.back())`;

    case BrowserAction.FORWARD:
      await chromeLib.forward(tabIndex);
      return `Went forward (history.forward())`;

    case BrowserAction.CLICK: {
      const selector = topSelector ?? (typeof payload === 'string' ? payload : null);
      if (!selector) {
        throw new Error("click requires selector (top-level) or payload string");
      }
      const clickResult = await chromeLib.clickWithCapture(tabIndex, selector);
      return formatActionResponse(clickResult, `Clicked: ${selector}`);
    }

    case BrowserAction.TYPE: {
      const p = parsePayload(payload, 'text');
      const text = p.text;
      const selector = topSelector ?? p.selector ?? null;
      if (!text || typeof text !== 'string') {
        throw new Error("type requires payload with text (string or {selector?,text})");
      }
      const typeResult = await chromeLib.captureActionWithDiff(
        tabIndex,
        'type',
        () => chromeLib.humanType(tabIndex, selector, text)
      );
      // When a dialog is open, captureActionWithDiff skips AFTER-capture
      if (!typeResult.capture) {
        const target = selector ? `into ${selector}` : 'into current focus';
        return formatCaptureResponse('Typed', target, null, typeResult.dialog, typeResult.artifacts);
      }
      return formatCaptureResponse(
        'Typed',
        selector ? `into ${selector}` : 'into current focus',
        typeResult.capture
      );
    }

    case BrowserAction.EXTRACT: {
      // Postel: a bare string payload is the format selector ('text'|'html'|
      // 'markdown'), not a fallback selector — `selector` is already a
      // top-level parameter and supplying both selector and payload="html"
      // is the documented "extract HTML of this element" form. Earlier
      // versions used parsePayload(payload, 'selector') here, which bound
      // payload="html" to selector="html" and silently degraded to
      // format="text" (scenario 02 step 3 regression).
      const p = parsePayload(payload, 'format');
      const selector = topSelector ?? (typeof p.selector === 'string' ? p.selector : undefined);
      const format = typeof p.format === 'string' ? p.format : 'text';

      if (selector) {
        // Extract specific element
        let extracted: string | null | undefined;
        if (format === 'text') {
          extracted = await chromeLib.extractText(tabIndex, selector);
        } else if (format === 'html') {
          extracted = await chromeLib.getHtml(tabIndex, selector);
        } else {
          throw new Error("selector-based extraction only supports 'text' or 'html' format");
        }
        if (extracted == null) {
          return `Error: Element not found: ${selector}`;
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
    }

    case BrowserAction.SCREENSHOT: {
      const p = parsePayload(payload, 'path');
      const filepath = p.path;
      if (!filepath || typeof filepath !== 'string') {
        throw new Error("screenshot requires payload with filename (string or {path,fullpage?})");
      }
      const fullpage = p.fullpage ?? false;
      const selectorForScreenshot = topSelector ?? (typeof p.selector === 'string' ? p.selector : undefined);
      const savedPath = await chromeLib.screenshot(tabIndex, filepath, selectorForScreenshot, fullpage);
      return `Screenshot saved to ${savedPath}`;
    }

    case BrowserAction.SELECT: {
      const p = parsePayload(payload, 'value');
      const selector = topSelector ?? p.selector;
      if (!selector || typeof selector !== 'string') {
        throw new Error("select requires selector (top-level or payload.selector)");
      }
      const rawValue = p.value;
      if (rawValue === undefined) {
        throw new Error("select requires payload.value");
      }
      let selectValue: string | string[] = rawValue;
      if (typeof rawValue === 'string' && rawValue.trim().startsWith('[')) {
        try {
          const parsed = JSON.parse(rawValue);
          if (Array.isArray(parsed) && parsed.every((v: unknown) => typeof v === 'string')) {
            selectValue = parsed;
          }
        } catch {
          // Not JSON — treat the literal string as a single value
        }
      } else if (Array.isArray(rawValue)) {
        selectValue = rawValue;
      }
      const selectResult = await chromeLib.selectOptionWithCapture(tabIndex, selector, selectValue);
      return formatActionResponse(selectResult, `Selected ${JSON.stringify(selectValue)} in: ${selector}`);
    }

    case BrowserAction.EVAL: {
      const p = parsePayload(payload, 'expression');
      const expression = p.expression;
      if (!expression || typeof expression !== 'string') {
        throw new Error("eval requires payload with JavaScript code");
      }
      const evalResult = await chromeLib.evaluateWithCapture(tabIndex, expression);
      return formatActionResponse(evalResult, `Evaluated: ${expression}\nResult: ${evalResult.result}`);
    }

    case BrowserAction.ATTR: {
      // Liberal accept: payload may be a bare string (attribute name) or
      // an object {attr: "name"} (and optionally {selector, attr}).
      // Selector always comes from top-level param when payload is a bare string.
      let selector: string | null;
      let attr: string;
      if (typeof payload === 'string') {
        // Bare string form: payload = attribute name, selector = top-level param
        selector = topSelector;
        attr = payload;
      } else {
        const p = parsePayload(payload, 'selector');
        selector = topSelector ?? p.selector;
        attr = p.attr;
      }
      if (!selector || typeof selector !== 'string') {
        throw new Error("attr requires selector (top-level or payload.selector)");
      }
      if (!attr || typeof attr !== 'string') {
        throw new Error("attr requires payload.attr (attribute name) or payload as bare string");
      }
      const attrValue = await chromeLib.getAttribute(tabIndex, selector, attr);
      return String(attrValue);
    }

    case BrowserAction.AWAIT_ELEMENT: {
      const p = parsePayload(payload, 'selector');
      const selector = topSelector ?? (typeof p.selector === 'string' ? p.selector : null);
      if (!selector || typeof selector !== 'string') {
        throw new Error("await_element requires selector (top-level or payload)");
      }
      const timeout = topTimeout ?? (typeof p.timeout === 'number' ? p.timeout : 5000);
      await chromeLib.waitForElement(tabIndex, selector, timeout);
      return `Element found: ${selector}`;
    }

    case BrowserAction.AWAIT_TEXT: {
      const p = parsePayload(payload, 'text');
      const text = p.text;
      if (!text || typeof text !== 'string') {
        throw new Error("await_text requires payload with text to wait for");
      }
      const timeout = topTimeout ?? (typeof p.timeout === 'number' ? p.timeout : 5000);
      await chromeLib.waitForText(tabIndex, text, timeout);
      return `Text found: ${text}`;
    }

    case BrowserAction.NEW_TAB: {
      const p = parsePayload(payload, 'url');
      const newTabUrl = (typeof p.url === 'string' && p.url.trim()) ? p.url.trim() : undefined;
      const newTabResult = await chromeLib.newTab(newTabUrl);
      activeTab = 0; // New tab becomes the first tab (Chrome inserts at front)
      const openedAt = newTabUrl ? ` at ${newTabUrl}` : '';
      return `New tab created: ${newTabResult.id}${openedAt}. Active tab is now 0.`;
    }

    case BrowserAction.CLOSE_TAB:
      await chromeLib.closeTab(tabIndex);
      if (activeTab > 0) activeTab = 0; // Reset to first remaining tab
      return `Closed tab ${tabIndex}. Active tab is now ${activeTab}.`;

    case BrowserAction.LIST_TABS: {
      const tabs = await chromeLib.getTabs();
      return JSON.stringify(tabs.map((tab: any, idx: number) => ({
        index: idx,
        id: tab.id,
        title: tab.title,
        url: tab.url,
        type: tab.type
      })), null, 2);
    }

    case BrowserAction.SHOW_BROWSER: {
      const showResult = await chromeLib.showBrowser();
      return showResult;
    }

    case BrowserAction.HIDE_BROWSER: {
      const hideResult = await chromeLib.hideBrowser();
      return hideResult;
    }

    case BrowserAction.BROWSER_MODE: {
      const mode = await chromeLib.getBrowserMode();
      return JSON.stringify(mode, null, 2);
    }

    case BrowserAction.SET_PROFILE: {
      const p = parsePayload(payload, 'name');
      const profileName = p.name;
      if (!profileName || typeof profileName !== 'string') {
        throw new Error("set_profile requires payload with profile name");
      }
      const setProfileResult = chromeLib.setProfileName(profileName);
      return setProfileResult;
    }

    case BrowserAction.GET_PROFILE: {
      const currentProfile = chromeLib.getProfileName();
      const profileDir = chromeLib.getChromeProfileDir(currentProfile);
      return JSON.stringify({
        profile: currentProfile,
        profileDir: profileDir
      }, null, 2);
    }

    case BrowserAction.HOVER: {
      const selector = topSelector ?? (typeof payload === 'string' ? payload : null);
      if (!selector || typeof selector !== 'string') {
        throw new Error("hover requires selector (top-level) or payload string");
      }
      const hoverResult = await chromeLib.captureActionWithDiff(
        tabIndex,
        'hover',
        () => chromeLib.hover(tabIndex, selector)
      );
      return formatCaptureResponse('Hovered', selector, hoverResult.capture, hoverResult.dialog, hoverResult.artifacts);
    }

    case BrowserAction.DRAG_DROP: {
      // Liberal accept for payload:
      //   1. "selector"             → bare string = target selector; source = top-level selector
      //   2. {x: N, y: N}           → coords-only object = target coords; source = top-level selector
      //   3. {source: "...", target: ...} → full form
      //   4. {target: ...}          → target only; source = top-level selector (legacy form)
      let source: string;
      let dragTarget: string | { x: number; y: number };

      if (typeof payload === 'string') {
        // Form 1: bare string = target selector
        source = topSelector ?? '';
        dragTarget = payload;
      } else if (
        typeof payload === 'object' && payload !== null &&
        (payload as Record<string, any>).x !== undefined &&
        (payload as Record<string, any>).y !== undefined &&
        (payload as Record<string, any>).target === undefined &&
        (payload as Record<string, any>).source === undefined
      ) {
        // Form 2: bare coords object = target coords
        const p = payload as Record<string, any>;
        source = topSelector ?? '';
        dragTarget = { x: p.x as number, y: p.y as number };
      } else {
        // Forms 3 & 4: object with source/target fields
        const p = parsePayload(payload, 'source');
        source = topSelector ?? p.source;
        const targetRaw = p.target;
        if (targetRaw === undefined) {
          throw new Error("drag_drop requires payload.target (target selector or {x,y})");
        }
        // Parse target: coordinates object or selector string
        if (typeof targetRaw === 'object' && targetRaw.x !== undefined && targetRaw.y !== undefined) {
          dragTarget = { x: targetRaw.x, y: targetRaw.y };
        } else if (typeof targetRaw === 'string') {
          // Try to parse as JSON coordinates
          try {
            const parsed = JSON.parse(targetRaw);
            if (typeof parsed === 'object' && parsed.x !== undefined && parsed.y !== undefined) {
              dragTarget = { x: parsed.x, y: parsed.y };
            } else {
              dragTarget = targetRaw;
            }
          } catch {
            dragTarget = targetRaw;
          }
        } else {
          throw new Error("drag_drop payload.target must be a selector string or {x,y} coordinates");
        }
      }

      if (!source || typeof source !== 'string') {
        throw new Error("drag_drop requires selector (top-level, used as source) or payload.source");
      }

      const dragResult = await chromeLib.captureActionWithDiff(
        tabIndex,
        'drag',
        () => chromeLib.drag(tabIndex, source, dragTarget)
      );
      const targetDesc = typeof dragTarget === 'object'
        ? `(${dragTarget.x}, ${dragTarget.y})`
        : dragTarget;
      return formatCaptureResponse('Dragged', `${source} → ${targetDesc}`, dragResult.capture, dragResult.dialog, dragResult.artifacts);
    }

    case BrowserAction.MOUSE_MOVE: {
      const p = parsePayload(payload, 'coords');
      if (typeof p.x !== 'number' || typeof p.y !== 'number') {
        throw new Error("mouse_move requires payload with x and y coordinates: {x,y} or {x,y,steps?,fromX?,fromY?}");
      }
      const moveResult = await chromeLib.mouseMove(tabIndex, p.x, p.y, {
        steps: p.steps,
        fromX: p.fromX,
        fromY: p.fromY
      });
      return `Mouse moved to (${moveResult.x}, ${moveResult.y})`;
    }

    case BrowserAction.SCROLL: {
      const scrollOpts: { selector?: string; deltaX?: number; deltaY?: number } = {};

      // Top-level selector wins over payload.selector
      if (topSelector) scrollOpts.selector = topSelector;

      if (typeof payload === 'object' && payload !== null) {
        const p = payload as Record<string, any>;
        if (!topSelector && typeof p.selector === 'string') scrollOpts.selector = p.selector;
        if (typeof p.deltaX === 'number') scrollOpts.deltaX = p.deltaX;
        if (typeof p.deltaY === 'number') scrollOpts.deltaY = p.deltaY;
        if (!('deltaX' in p) && !('deltaY' in p)) {
          throw new Error("scroll object payload requires at least deltaX or deltaY");
        }
      } else if (typeof payload === 'string') {
        // Direction string or JSON
        const scrollAmount = 300;
        const payloadLower = payload.toLowerCase().trim();
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
            const parsed = JSON.parse(payload);
            scrollOpts.deltaX = parsed.deltaX || 0;
            scrollOpts.deltaY = parsed.deltaY || 0;
          } catch {
            throw new Error("scroll payload must be a direction (up/down/left/right) or {deltaX?,deltaY?,selector?}");
          }
        }
      } else {
        throw new Error("scroll requires payload: direction string or {deltaX?,deltaY?,selector?}");
      }

      const scrollResult = await chromeLib.scroll(tabIndex, scrollOpts);
      const dir = scrollOpts.deltaY && scrollOpts.deltaY > 0 ? 'down' :
                  scrollOpts.deltaY && scrollOpts.deltaY < 0 ? 'up' :
                  scrollOpts.deltaX && scrollOpts.deltaX > 0 ? 'right' : 'left';
      return `Scrolled ${dir} (deltaX: ${scrollResult.deltaX}, deltaY: ${scrollResult.deltaY})${scrollOpts.selector ? ` at ${scrollOpts.selector}` : ''}`;
    }

    case BrowserAction.DOUBLE_CLICK: {
      const selector = topSelector ?? (typeof payload === 'string' ? payload : null);
      if (!selector || typeof selector !== 'string') {
        throw new Error("double_click requires selector (top-level) or payload string");
      }
      const dblClickResult = await chromeLib.captureActionWithDiff(
        tabIndex,
        'dblclick',
        () => chromeLib.doubleClick(tabIndex, selector)
      );
      return formatCaptureResponse('Double-clicked', selector, dblClickResult.capture, dblClickResult.dialog, dblClickResult.artifacts);
    }

    case BrowserAction.RIGHT_CLICK: {
      const selector = topSelector ?? (typeof payload === 'string' ? payload : null);
      if (!selector || typeof selector !== 'string') {
        throw new Error("right_click requires selector (top-level) or payload string");
      }
      const rightClickResult = await chromeLib.captureActionWithDiff(
        tabIndex,
        'rightclick',
        () => chromeLib.rightClick(tabIndex, selector)
      );
      return formatCaptureResponse('Right-clicked', selector, rightClickResult.capture, rightClickResult.dialog, rightClickResult.artifacts);
    }

    case BrowserAction.FILE_UPLOAD: {
      const p = parsePayload(payload, 'files');
      const selector = topSelector ?? p.selector;
      if (!selector || typeof selector !== 'string') {
        throw new Error("file_upload requires selector (top-level or payload.selector) for the file input element");
      }
      const filesRaw = p.files;
      if (!filesRaw) {
        throw new Error("file_upload requires payload.files (array of file paths or single path string)");
      }
      let filePaths: string[];
      if (Array.isArray(filesRaw)) {
        filePaths = filesRaw;
      } else if (typeof filesRaw === 'string') {
        filePaths = [filesRaw];
      } else {
        throw new Error("file_upload payload.files must be an array of paths or a single path string");
      }
      const uploadResult = await chromeLib.captureActionWithDiff(
        tabIndex,
        'upload',
        () => chromeLib.fileUpload(tabIndex, selector, filePaths)
      );
      return formatCaptureResponse(
        'Uploaded',
        `${filePaths.length} file(s) to ${selector}`,
        uploadResult.capture,
        uploadResult.dialog,
        uploadResult.artifacts
      );
    }

    case BrowserAction.KEYBOARD_PRESS: {
      const p = parsePayload(payload, 'key');
      const key = p.key;
      if (!key || typeof key !== 'string') {
        throw new Error("keyboard_press requires payload with key name (e.g., Tab, Enter, Escape) — string or {key,modifiers?}");
      }
      const modifiers = typeof p.modifiers === 'object' ? p.modifiers : {};
      const keyResult = await chromeLib.captureActionWithDiff(
        tabIndex,
        'keypress',
        () => chromeLib.keyboardPress(tabIndex, key, modifiers)
      );
      const modStr = Object.entries(modifiers)
        .filter(([_, v]) => v)
        .map(([k]) => k)
        .join('+');
      return formatCaptureResponse(
        'Pressed',
        modStr ? `${modStr}+${key}` : key,
        keyResult.capture,
        keyResult.dialog,
        keyResult.artifacts
      );
    }

    case BrowserAction.SET_VIEWPORT: {
      const p = parsePayload(payload, 'viewport');
      // Accept payload as the viewport object directly, or {width,...} at top level
      const vp = (p.width !== undefined) ? p : (p.viewport || {});
      if (!vp.width || !vp.height) {
        throw new Error("set_viewport requires payload with width and height: {width,height,deviceScaleFactor?,mobile?}");
      }
      const viewportResult = await chromeLib.setViewport(tabIndex, vp);
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
      const p = parsePayload(payload, 'since');
      const since = (typeof p.since === 'number') ? new Date(p.since) : null;
      const messages = await chromeLib.getConsoleMessages(tabIndex, since);
      if (!messages || messages.length === 0) {
        return `No console messages captured. (Call enable_console_logging first if you haven't.)`;
      }
      return messages.map((m: any) => `[${m.timestamp}] ${m.level}: ${m.text}`).join('\n');
    }

    case BrowserAction.CLEAR_CONSOLE_MESSAGES: {
      await chromeLib.clearConsoleMessages(tabIndex);
      return `Console messages cleared`;
    }

    case BrowserAction.KILL_CHROME: {
      await chromeLib.killChrome();
      return `Chrome killed.`;
    }

    case BrowserAction.RESTART_CHROME: {
      await chromeLib.killChrome();
      await chromeLib.startChrome(headlessMode, undefined, explicitPort);
      return `Chrome restarted in ${headlessMode ? 'headless' : 'headed'} mode.`;
    }

    case BrowserAction.SWITCH_TAB: {
      // payload can be: a tab index (number or numeric string),
      // a URL substring, or a title substring.
      const tabs = await chromeLib.getTabs();
      const tabList = tabs.map((tab: any, idx: number) => ({
        index: idx,
        id: tab.id,
        title: tab.title ?? '',
        url: tab.url ?? '',
        type: tab.type
      }));

      const p = parsePayload(payload, 'tab');
      const target = p.tab ?? payload;

      let matchedIndex: number = -1;

      if (typeof target === 'number') {
        // Numeric index
        matchedIndex = target;
      } else if (typeof target === 'string') {
        const asNum = parseInt(target, 10);
        if (!isNaN(asNum) && String(asNum) === target.trim()) {
          // Pure numeric string — treat as index
          matchedIndex = asNum;
        } else {
          // URL or title substring match (first match wins)
          const lowerTarget = target.toLowerCase();
          const found = tabList.find(
            (t: { url: string; title: string }) =>
              t.url.toLowerCase().includes(lowerTarget) ||
              t.title.toLowerCase().includes(lowerTarget)
          );
          if (found !== undefined) matchedIndex = (found as { index: number }).index;
        }
      }

      if (matchedIndex < 0 || matchedIndex >= tabList.length) {
        throw new Error(
          `switch_tab: no tab found matching ${JSON.stringify(target)}. ` +
          `Available tabs: ${tabList.map((t: {index: number; title: string; url: string}) => `[${t.index}] ${t.title} (${t.url})`).join(', ')}`
        );
      }

      activeTab = matchedIndex;
      const newActive = tabList[matchedIndex];
      return `Switched to tab ${matchedIndex}: ${newActive.title} (${newActive.url})`;
    }

    case BrowserAction.HELP:
      return `# Chrome Browser Control

Auto-starting Chrome with automatic page captures for every DOM action.

## Actions Overview
navigate, click, type, keyboard_press, select, eval → Capture page state with before/after DOM diff
hover, drag_drop, mouse_move, scroll, double_click, right_click → CDP-level mouse actions (native DnD)
file_upload → Set files on input[type=file] (DOM.setFileInputFiles)
extract, attr, screenshot → Get content/visuals
await_element, await_text → Wait for page changes
list_tabs, new_tab, close_tab → Tab management
show_browser, hide_browser, browser_mode → Toggle headless/headed mode
set_viewport, clear_viewport, get_viewport → Device emulation (mobile/tablet/desktop)
clear_cookies → Clear all browser cookies
set_profile, get_profile → Manage Chrome profiles
kill_chrome, restart_chrome → Chrome lifecycle control (recovery)

## Schema: 4 parameters
{"action": "...", "selector": "CSS or XPath (null/omit if no element target)", "payload": "..." or {...}, "timeout": ms}

selector is a CSS or XPath string for actions that target an element (null/omit otherwise).
payload is a string for simple actions (navigate, eval, keyboard_press, etc.)
payload is an object for structured actions (set_viewport, drag_drop, etc.)
timeout is milliseconds for await_element / await_text (default 5000).

## Navigation & Interaction (Auto-Capture with DOM Diff)
navigate: {"action": "navigate", "payload": "URL"}
click: {"action": "click", "selector": "CSS_or_XPath_selector"}
type: {"action": "type", "payload": "text"} → types into current focus
type: {"action": "type", "selector": "#input", "payload": "hello"} → types into element
keyboard_press: {"action": "keyboard_press", "payload": "Tab"} → special key
keyboard_press: {"action": "keyboard_press", "payload": {"key": "Tab", "modifiers": {"shift": true}}}
select: {"action": "select", "selector": "select", "payload": {"value": "option-value"}}
select: {"action": "select", "selector": "select[multiple]", "payload": {"value": ["opt1","opt2"]}}
eval: {"action": "eval", "payload": "JavaScript_code"}

## Mouse Actions (CDP-Level)
hover: {"action": "hover", "selector": "selector"} → CSS :hover, tooltips, menus
drag_drop: {"action": "drag_drop", "selector": "#el", "payload": {"target": "#target"}}
drag_drop: {"action": "drag_drop", "selector": "#el", "payload": {"target": {"x": 300, "y": 200}}}
mouse_move: {"action": "mouse_move", "payload": {"x": 100, "y": 200}}
mouse_move: {"action": "mouse_move", "payload": {"x": 100, "y": 200, "steps": 10}}
scroll: {"action": "scroll", "payload": "down"} → also: up, left, right
scroll: {"action": "scroll", "selector": ".container", "payload": {"deltaX": 0, "deltaY": 500}}
double_click: {"action": "double_click", "selector": "selector"}
right_click: {"action": "right_click", "selector": "selector"}

## File Upload
file_upload: {"action": "file_upload", "selector": "#file-input", "payload": {"files": "/path/file.pdf"}}
file_upload: {"action": "file_upload", "selector": "#upload", "payload": {"files": ["/a.pdf", "/b.jpg"]}}

## Content & Export
extract: {"action": "extract", "selector": ".price", "payload": {"format": "text"}}
extract: {"action": "extract", "payload": {"format": "markdown"}} → whole page
attr: {"action": "attr", "selector": "a", "payload": {"attr": "href"}}
screenshot: {"action": "screenshot", "payload": "filename.png"}
screenshot: {"action": "screenshot", "payload": {"path": "file.png", "fullpage": true}}

## Waiting
await_element: {"action": "await_element", "selector": "CSS_or_XPath"}
await_element: {"action": "await_element", "selector": "#el", "timeout": 10000}
await_text: {"action": "await_text", "payload": "text to wait for"}
await_text: {"action": "await_text", "payload": "Success", "timeout": 10000}

## Tab Management
list_tabs: {"action": "list_tabs"}
new_tab: {"action": "new_tab"} or {"action": "new_tab", "payload": "https://example.com"}
close_tab: {"action": "close_tab"} → closes the active tab
switch_tab: {"action": "switch_tab", "payload": 1} → switch to tab by index
switch_tab: {"action": "switch_tab", "payload": "github.com"} → switch by URL substring
switch_tab: {"action": "switch_tab", "payload": "My Page Title"} → switch by title substring

## Browser Mode Control
show_browser: {"action": "show_browser"} → Make browser window visible
hide_browser: {"action": "hide_browser"} → Switch to headless mode
browser_mode: {"action": "browser_mode"} → Check current mode and profile
⚠️ Toggling visibility restarts Chrome and reloads pages via GET. Loses form data and POST state.

## Device Emulation (Viewport Control)
set_viewport: {"action": "set_viewport", "payload": {"width": 375, "height": 812, "deviceScaleFactor": 2, "mobile": true}}
set_viewport: {"action": "set_viewport", "payload": {"width": 1920, "height": 1080}}
clear_viewport: {"action": "clear_viewport"}
get_viewport: {"action": "get_viewport"}

## Cookie Management
clear_cookies: {"action": "clear_cookies"}

## Profile Management
set_profile: {"action": "set_profile", "payload": "profile-name"} → Set Chrome profile (kill Chrome first); marks the profile as explicit (opts out of auto-disambiguation, see below)
get_profile: {"action": "get_profile"} → Get current profile name and directory
Profiles stored in: ~/.cache/superpowers/browser-profiles/{profile-name}/

When two or more MCP servers run on the same host with the default profile, the first claims 'superpowers-chrome' and later ones silently fall through to 'superpowers-chrome-2', '-3', etc. Each MCP drives its own Chrome with its own profile dir — they don't fight over tabs. Use CHROME_WS_PROFILE=name (env var) or set_profile to opt out and intentionally share a Chrome with another process.

## Console Logging
enable_console_logging: {"action": "enable_console_logging"}
get_console_messages: {"action": "get_console_messages"} → all messages
get_console_messages: {"action": "get_console_messages", "payload": {"since": 1716000000000}} → since epoch ms
clear_console_messages: {"action": "clear_console_messages"}

## Chrome Lifecycle (Recovery)
kill_chrome: {"action": "kill_chrome"} → Kill Chrome process
restart_chrome: {"action": "restart_chrome"} → Kill and restart Chrome

After an external Chrome kill (e.g., \`kill -9 <pid>\` from the shell), the next page action auto-restarts Chrome. The response prepends \`[Chrome auto-restarted; URL reset to about:blank. Re-navigate to continue.]\` so the model knows its previous URL/tab state is gone.

## Dialogs (alert/confirm/prompt, beforeunload, basic-auth, permission, device)
A native dialog opening pauses the page; subsequent page-targeted actions on that tab return a refusal whose text contains \`Page is behind a dialog\` and lists \`dialog::*\` selectors to handle it. The same shape applies when a dialog fires during navigate (e.g., HTTP basic-auth) — \`navigate\` throws with the dialog grammar in the message.

Handle dialogs by clicking/typing a \`dialog::*\` selector:
- \`click dialog::accept\` / \`click dialog::dismiss\` → JS alert/confirm/prompt, beforeunload, permission grant/deny
- \`type dialog::prompt\` → stage text for a JS prompt dialog, then click dialog::accept to submit
- \`type dialog::username\` + \`type dialog::password\` + \`click dialog::accept\` → respond to an HTTP basic-auth challenge
- \`click dialog::device[id="<id>"]\` → pick a WebUSB / Bluetooth / Serial / HID device from a chooser

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
Login flow:
{"action": "navigate", "payload": "https://site.com/login"}
{"action": "await_element", "selector": "#email"}
{"action": "type", "selector": "#email", "payload": "user@test.com"}
{"action": "type", "selector": "#password", "payload": "pass123"}
{"action": "keyboard_press", "payload": "Enter"}`;

    default:
      throw new Error(`Unknown action: ${params.action}`);
  }
}

/**
 * Wrapper that executes a browser action and prepends the auto-restart banner
 * to the response if Chrome was restarted before this action.
 */
async function executeBrowserActionWithBanner(params: UseBrowserInput): Promise<string> {
  // Consume the restart flag before dispatching so any error thrown from the
  // action still clears the flag (we've already noted the restart).
  const prependBanner = chromeWasRestarted;
  chromeWasRestarted = false;

  const result = await executeBrowserAction(params);
  if (prependBanner) {
    return `${RESTART_BANNER}\n\n${result}`;
  }
  return result;
}

// Sticky tab state: updated by switch_tab, new_tab, close_tab
let activeTab = 0;

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

Schema: 4 parameters — action, selector (CSS/XPath or null), payload (string or object), timeout (ms).
selector targets a DOM element (null/omit for navigation, eval, tab management, etc.).
payload is a string for simple actions (navigate=URL, type=text, eval=JS, keyboard_press=key).
payload is an object for structured actions (set_viewport={width,height}, drag_drop={target}, etc.).
Tabs are tracked as sticky state; use switch_tab to change the active tab.
Use action='help' for full per-action payload shapes.`,
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

      // Postel: if a legacy `tab_index` is supplied, treat it as an implicit
      // switch_tab. Stickiness matches the explicit switch_tab semantics: the
      // change persists for subsequent calls until another switch occurs.
      if (typeof params.tab_index === 'number') {
        activeTab = params.tab_index;
      }

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

      // Execute browser action (banner prepended if Chrome was auto-restarted)
      const result = await executeBrowserActionWithBanner(params);

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
