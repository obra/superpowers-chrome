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
import {
  parsePayload,
  resolveStrictStructuredPayload,
  tryParseJsonObject,
  tryParseCoords,
  truncateForError,
  describeUnusableScrollPayload,
  resolveConsoleSince,
} from "./payload.js";
import {
  formatDialogRefusal,
  formatCaptureFiles,
  formatActionResponse,
  formatCaptureResponse,
  formatEvalDescription,
  redactUnlessAllowed,
} from "./response-format.js";

// Re-exported for tests (mcp/src/payload.ts and mcp/src/response-format.ts
// have no side effects and are also importable directly from
// mcp/dist/payload.js / mcp/dist/response-format.js — this re-export just
// makes the helpers reachable from the bundled entry point too, without
// requiring tests to boot a browser or an MCP server).
export { parsePayload, resolveStrictStructuredPayload, tryParseJsonObject, tryParseCoords, describeUnusableScrollPayload, resolveConsoleSince, tryParseIntegerValue, PAYLOAD_SPECS } from "./payload.js";
export { formatDialogRefusal, formatCaptureFiles, formatActionResponse, formatCaptureResponse, formatEvalDescription, redactUnlessAllowed } from "./response-format.js";

// Get the directory and import chrome-ws-lib
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);
const chromeLib = require(join(__dirname, "../../skills/browsing/chrome-ws-lib.js")).createSession();
const credentialGuard = require(join(__dirname, "../../skills/browsing/lib/credential-guard.js"));
const secretMarker = require(join(__dirname, "../../skills/browsing/lib/secret-marker.js"));
const sensitiveUrl = require(join(__dirname, "../../skills/browsing/lib/sensitive-url.js"));
const capturePause = require(join(__dirname, "../../skills/browsing/lib/capture-pause.js"));
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
  TYPE = "type",                // Uses CDP humanType; selector=target (optional), payload=literal text to type (never JSON-parsed)
  EXTRACT = "extract",          // selector=CSS/XPath (optional), payload=format keyword string or {format?,selector?} (also accepted as a JSON-encoded string)
  SCREENSHOT = "screenshot",    // selector=CSS/XPath element (optional), payload=path string or {path,fullpage?,selector?} (also accepted as a JSON-encoded string)
  EVAL = "eval",                // payload=JS source string, taken literally (never JSON-parsed, even if it looks like JSON e.g. "[1,2]")
  SELECT = "select",            // selector=CSS/XPath, payload=literal option value/text, or {selector,value} (value never JSON-parsed as a whole; a JSON array string is still accepted for multi-select)
  ATTR = "attr",                // selector=CSS/XPath, payload=bare attribute name string, or {selector,attr} (also accepted as a JSON-encoded string)
  SET_ATTR = "set_attr",        // selector=CSS/XPath, payload={name,value} - write-only, name must be exactly 'data-sen-nonce' or 'data-sen-secret' (see lib/set-attribute.js); no bare-string form (needs both name and value)
  AWAIT_ELEMENT = "await_element", // selector=CSS/XPath to wait for; payload={selector?,timeout?} also accepted as a JSON-encoded string
  AWAIT_TEXT = "await_text",    // payload=literal text to wait for (never JSON-parsed); timeout= top-level ms
  NEW_TAB = "new_tab",          // payload=URL string (optional; also accepted as a JSON-encoded {url} string)
  CLOSE_TAB = "close_tab",      // closes activeTab
  LIST_TABS = "list_tabs",
  // Tab management
  SWITCH_TAB = "switch_tab",    // payload=tab index, URL substring, or title substring
  SHOW_BROWSER = "show_browser",
  HIDE_BROWSER = "hide_browser",
  BROWSER_MODE = "browser_mode",
  SET_PROFILE = "set_profile",  // payload=profile name string (also accepted as a JSON-encoded {name} string)
  GET_PROFILE = "get_profile",
  HELP = "help",
  // Mouse actions (CDP-level, bypasses synthetic event restrictions)
  HOVER = "hover",              // payload=selector string
  DRAG_DROP = "drag_drop",      // payload=target selector string, {x,y} target coords, or {source,target} (source/target form also accepted as a JSON-encoded string)
  MOUSE_MOVE = "mouse_move",    // payload={x,y,steps?,fromX?,fromY?} — object or an equivalent JSON string; no bare-string form (there's no single string that means "x and y")
  SCROLL = "scroll",            // payload=direction string (up/down/left/right) or {deltaX?,deltaY?,selector?} (also accepted as a JSON-encoded string)
  DOUBLE_CLICK = "double_click", // payload=selector string
  RIGHT_CLICK = "right_click",  // payload=selector string
  // File upload (DOM.setFileInputFiles)
  FILE_UPLOAD = "file_upload",  // payload=single file path string, JSON array-of-paths string, or {selector,files}
  // Special keys (Tab, Enter, Escape, Arrow keys, etc.)
  KEYBOARD_PRESS = "keyboard_press", // payload={key,modifiers?} or key string (also accepted as a JSON-encoded string)
  // Viewport control (mobile testing, responsive design)
  SET_VIEWPORT = "set_viewport", // payload={width,height,deviceScaleFactor?,mobile?} — object or an equivalent JSON string; no bare-string form (there's no single string that means "width and height")
  CLEAR_VIEWPORT = "clear_viewport",
  GET_VIEWPORT = "get_viewport",
  // Cookie management
  CLEAR_COOKIES = "clear_cookies",
  // Console logging capture (Runtime.consoleAPICalled stream)
  ENABLE_CONSOLE_LOGGING = "enable_console_logging",
  GET_CONSOLE_MESSAGES = "get_console_messages", // payload={since?} (epoch ms; also accepted as a bare epoch-ms number/string)
  CLEAR_CONSOLE_MESSAGES = "clear_console_messages",
  // Auto-capture control (see lib/capture-pause.js): pause suspends every
  // automatic capture (DOM/markdown/screenshot/console/dialog artifacts)
  // for the rest of this session until resume_capture; an explicit
  // screenshot also refuses while paused. Neither takes a payload.
  PAUSE_CAPTURE = "pause_capture",
  RESUME_CAPTURE = "resume_capture",
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
      "Extra data for the action. Both a plain object and an equivalent " +
      "JSON-encoded string are accepted for every structured shape below " +
      "(e.g. set_viewport accepts either {width:390,height:844} or " +
      "'{\"width\":390,\"height\":844}'). " +
      "Literal string for code/free-text actions, taken as-is and never " +
      "JSON-parsed even if it happens to look like JSON (eval=JS source, " +
      "type=literal text, await_text=literal text to wait for, " +
      "select=literal option value). " +
      "String or object for simple cases (navigate=URL, set_profile=name, " +
      "new_tab=URL, attr=attribute name or {selector,attr}). " +
      "Structured object (or its JSON-string equivalent) for the rest: " +
      "set_viewport={width,height,mobile?} (no bare-string form), " +
      "keyboard_press=key string or {key,modifiers:{shift?,ctrl?,alt?,meta?}}, " +
      "extract=format string or {format:'text'|'html'|'markdown',selector?}, " +
      "screenshot=path string or {path,fullpage?,selector?}, " +
      "scroll=direction string or {deltaX?,deltaY?,selector?}, " +
      "drag_drop=target selector string, {x,y} target coords, or {source,target}, " +
      "mouse_move={x,y,steps?,fromX?,fromY?} (no bare-string form), " +
      "file_upload=path string, JSON array-of-paths string, or {selector,files:[...]}, " +
      "get_console_messages={since:epochMs} or a bare epoch-ms timestamp, " +
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
      const p = parsePayload(payload, 'navigate');
      const url = p.url;
      if (!url || typeof url !== 'string') {
        throw new Error("navigate requires payload with URL");
      }
      const navResult = await chromeLib.navigate(tabIndex, url, true); // Enable auto-capture

      // Handle enhanced response
      if (typeof navResult === 'object' && navResult.url) {
        // navResult.url is always real (navigate() sets it regardless of
        // pause), but pageSize comes from capturePageArtifacts, which never
        // ran while paused — skip that line rather than print "Size:
        // undefined×undefined".
        const response = navResult.capturePaused
          ? [`Navigated to ${navResult.url}`, `Current URL: ${navResult.url}`, ...formatCaptureFiles(navResult)]
          : [
              `Navigated to ${navResult.url}`,
              `Current URL: ${navResult.url}`,
              `Size: ${navResult.pageSize?.width}×${navResult.pageSize?.height}`,
              ...formatCaptureFiles(navResult)
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
      const p = parsePayload(payload, 'type');
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
        return formatCaptureResponse('Typed', target, null, typeResult.dialog, typeResult.artifacts, typeResult.credentialSuppressed, typeResult.suppressedReason, typeResult.capturePaused);
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
      const p = parsePayload(payload, 'extract');
      const selector = topSelector ?? (typeof p.selector === 'string' ? p.selector : undefined);
      const format = typeof p.format === 'string' ? p.format : 'text';

      if (selector) {
        // Extract specific element
        let extracted: string | null | undefined;
        if (format === 'text') {
          extracted = await chromeLib.extractText(tabIndex, selector);
        } else if (format === 'html') {
          // getSanitizedHtml, not getHtml: getHtml is the raw, unstripped
          // form capture.js's credential guard relies on internally (see
          // lib/extraction.js's module doc) and must not have
          // data-sen-secret content removed from it.
          extracted = await chromeLib.getSanitizedHtml(tabIndex, selector);
        } else {
          throw new Error("selector-based extraction only supports 'text' or 'html' format");
        }
        if (extracted == null) {
          throw new Error(`Element not found: ${selector}`);
        }
        return extracted;
      } else {
        // Extract whole page
        if (format === 'text') {
          // extractPageText, not a raw innerText evaluate: innerText needs
          // page layout, which a detached clone doesn't have, so this
          // refuses outright on a data-sen-secret marker instead of trying
          // to strip it (see lib/capture.js).
          return await chromeLib.extractPageText(tabIndex);
        } else if (format === 'html') {
          return await chromeLib.getSanitizedHtml(tabIndex);
        } else if (format === 'markdown') {
          // Generate markdown-like output. textContent (unlike innerText)
          // doesn't need layout, so unlike the 'text' branch above, this
          // can run against a detached, stripped clone rather than refusing.
          //
          // Two helpers guard the clone (extraction.js's cloneAndStrip uses
          // them the same way): an ancestor check, because a marker on
          // document.body itself (or an ancestor of it) would otherwise
          // leak -- stripping removes only DESCENDANTS, and querySelectorAll
          // never matches the node it is called on; and an inert clone,
          // because the live document.body.cloneNode(true) fires
          // onload/onerror on any cloned <img>, since that clone's
          // ownerDocument is still the live, "fully active" page.
          //
          // The inert clone has its own base URI. `el.href` (the resolved DOM
          // property, not getAttribute) resolves against the ELEMENT'S OWN
          // ownerDocument base URI -- once `root` below is a clone imported
          // into `document.implementation.createHTMLDocument('')`, that
          // document's URL is about:blank, so a relative link like '/foo'
          // would come back unresolved instead of absolute against the real
          // page. The generated script below resolves against the LIVE top
          // document's baseURI explicitly instead (`document` inside that
          // script is still the live page -- only `root` is ever the inert
          // clone -- so this is correct whether or not root got cloned).
          // NOTE: no `//` comments inside that template literal itself --
          // it gets `.replace(/\s+/g, ' ')`'d below before being sent to
          // the page, which collapses newlines WITHOUT stripping line
          // comments, silently commenting out everything after them.
          const credentialCaptureAllowed = credentialGuard.credentialCaptureAllowed();
          const markerSelector = JSON.stringify(`[${credentialGuard.MARKER_ATTR}]`);
          const root = credentialCaptureAllowed
            ? 'document.body'
            : `(() => {
                ${secretMarker.ANCESTOR_MARKED_FN_SRC}
                ${secretMarker.INERT_CLONE_FN_SRC}
                const src = document.body;
                if (!src) return __senInertClone(document.createElement('body'));
                if (__senAncestorMarked(src)) return { __secretMarked: true };
                const clone = __senInertClone(src);
                clone.querySelectorAll(${markerSelector}).forEach(el => el.remove());
                return clone;
              })()`;
          const result = await chromeLib.evaluate(tabIndex, `
            (() => {
              const root = (${root});
              if (root && root.__secretMarked) return { __secretMarked: true };
              return Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6, p, a, li, pre, code'))
                .map(el => {
                  const tag = el.tagName.toLowerCase();
                  const text = el.textContent.trim();
                  if (tag.startsWith('h')) return '#'.repeat(parseInt(tag[1])) + ' ' + text;
                  if (tag === 'a') {
                    /* el.href (the resolved property, not getAttribute) resolves against the CLONE's own about:blank base once root has been cloned into an inert document -- see the TS comment above this template literal for the full explanation. Resolve against the LIVE top document's baseURI explicitly instead. */
                    var raw = el.getAttribute('href');
                    var resolved = raw;
                    if (raw !== null) {
                      try { resolved = new URL(raw, document.baseURI).href; } catch (e) { resolved = raw; }
                    }
                    return '[' + text + '](' + (resolved || '') + ')';
                  }
                  if (tag === 'li') return '- ' + text;
                  if (tag === 'pre' || tag === 'code') return '\\\`\\\`\\\`\\n' + text + '\\n\\\`\\\`\\\`';
                  return text;
                })
                .filter(x => x)
                .join('\\n\\n');
            })()
          `.replace(/\s+/g, ' ').trim());
          if (result && typeof result === 'object' && (result as any).__secretMarked) {
            throw new Error(credentialGuard.secretMarkerRefusal('extract') + ' (whole page)');
          }
          return result;
        } else {
          throw new Error("extract format must be 'text', 'html', or 'markdown'");
        }
      }
    }

    case BrowserAction.SCREENSHOT: {
      const p = parsePayload(payload, 'screenshot');
      const filepath = p.path;
      if (!filepath || typeof filepath !== 'string') {
        throw new Error("screenshot requires payload with filename (string or {path,fullpage?})");
      }
      const fullpage = p.fullpage ?? false;
      const selectorForScreenshot = topSelector ?? (typeof p.selector === 'string' ? p.selector : undefined);
      // Round 4 (jc finding 6): determine WHY a refusal happened before
      // calling screenshotUnlessCredentialShaped, so the error message can
      // say which -- that function returns a bare null for both a
      // sensitive URL and credential-shaped content, and always reporting
      // "page shows credential-shaped content" was simply wrong for the
      // URL case (and never mentioned SENSITIVE_URL_PATTERNS or
      // ALLOW_CREDENTIAL_CAPTURE). This mirrors the same pre-check pattern
      // capture.js's own auto-capture call sites already use.
      const urlSensitive = !credentialGuard.credentialCaptureAllowed() &&
        sensitiveUrl.urlLooksSensitive(await chromeLib.getPageUrl(tabIndex));
      const savedPath = await chromeLib.screenshotUnlessCredentialShaped(tabIndex, filepath, selectorForScreenshot, fullpage);
      if (!savedPath) {
        if (urlSensitive) {
          throw new Error(`screenshot refused: ${sensitiveUrl.URL_SUPPRESSED_NOTICE}`);
        }
        throw new Error(
          "screenshot refused: page shows credential-shaped content. " +
          credentialGuard.CREDENTIAL_ADVICE
        );
      }
      return `Screenshot saved to ${savedPath}`;
    }

    case BrowserAction.SELECT: {
      const p = parsePayload(payload, 'select');
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
      const p = parsePayload(payload, 'eval');
      const expression = p.expression;
      if (!expression || typeof expression !== 'string') {
        throw new Error("eval requires payload with JavaScript code");
      }
      const evalResult = await chromeLib.evaluateWithCapture(tabIndex, expression);
      return formatActionResponse(evalResult, formatEvalDescription(expression, evalResult));
    }

    case BrowserAction.ATTR: {
      // Liberal accept: payload may be a bare string (attribute name), a
      // JSON-encoded string of the object form, or a native object
      // {attr: "name"} (and optionally {selector, attr}). parsePayload's
      // 'structured' handling for 'attr' gives us all three: a plain
      // string that isn't valid JSON falls back to the historical
      // bare-string-is-the-attribute-name behavior via defaultKey='attr'.
      const p = parsePayload(payload, 'attr');
      const selector: string | null = topSelector ?? p.selector ?? null;
      const attr: string = p.attr;
      if (!selector || typeof selector !== 'string') {
        throw new Error("attr requires selector (top-level or payload.selector)");
      }
      if (!attr || typeof attr !== 'string') {
        throw new Error("attr requires payload.attr (attribute name) or payload as bare string");
      }
      const attrValue = await chromeLib.getAttribute(tabIndex, selector, attr);
      return String(attrValue);
    }

    case BrowserAction.SET_ATTR: {
      // Write-only counterpart to ATTR (see lib/set-attribute.js for the
      // full guard rationale). No legitimate
      // bare-string form: unlike attr's bare-string-is-the-attribute-NAME
      // reading form, set_attr needs both a name AND a value, and there is
      // no single string that means both. So this uses the strict
      // resolver, same as set_viewport/mouse_move: a string payload MUST
      // be parseable JSON, and a parse failure is reported honestly
      // instead of being silently wrapped under a throwaway key.
      const shapeHint = '{name, value} (selector top-level or in payload.selector)';
      const resolved = resolveStrictStructuredPayload(payload);
      if (resolved.errorDetail) {
        throw new Error(`set_attr requires payload with name and value: ${shapeHint} (${resolved.errorDetail})`);
      }
      const p = resolved.object!;
      const selector: string | null = topSelector ?? (typeof p.selector === 'string' ? p.selector : null);
      if (!selector || typeof selector !== 'string') {
        throw new Error("set_attr requires selector (top-level or payload.selector)");
      }
      if (typeof p.name !== 'string' || !p.name) {
        throw new Error(`set_attr requires payload.name (attribute name): ${shapeHint}`);
      }
      if (typeof p.value !== 'string') {
        throw new Error(`set_attr requires payload.value (string): ${shapeHint}`);
      }
      // setAttributeWithCapture throws (never returns a leak-prone value) on
      // every refusal path: disallowed attribute name, no element matched,
      // or the target itself is marked data-sen-secret. The value just set
      // is deliberately never echoed back into the response, even though
      // it's a caller-supplied nonce rather than page content.
      const setResult = await chromeLib.setAttributeWithCapture(tabIndex, selector, p.name, p.value);
      return formatActionResponse(setResult, `Set attribute: ${p.name} on ${selector}`);
    }

    case BrowserAction.AWAIT_ELEMENT: {
      const p = parsePayload(payload, 'await_element');
      const selector = topSelector ?? (typeof p.selector === 'string' ? p.selector : null);
      if (!selector || typeof selector !== 'string') {
        throw new Error("await_element requires selector (top-level or payload)");
      }
      const timeout = topTimeout ?? (typeof p.timeout === 'number' ? p.timeout : 5000);
      await chromeLib.waitForElement(tabIndex, selector, timeout);
      return `Element found: ${selector}`;
    }

    case BrowserAction.AWAIT_TEXT: {
      const p = parsePayload(payload, 'await_text');
      const text = p.text;
      if (!text || typeof text !== 'string') {
        throw new Error("await_text requires payload with text to wait for");
      }
      const timeout = topTimeout ?? (typeof p.timeout === 'number' ? p.timeout : 5000);
      await chromeLib.waitForText(tabIndex, text, timeout);
      return `Text found: ${text}`;
    }

    case BrowserAction.NEW_TAB: {
      const p = parsePayload(payload, 'new_tab');
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
      const p = parsePayload(payload, 'set_profile');
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
      return formatCaptureResponse('Hovered', selector, hoverResult.capture, hoverResult.dialog, hoverResult.artifacts, hoverResult.credentialSuppressed, hoverResult.suppressedReason, hoverResult.capturePaused);
    }

    case BrowserAction.DRAG_DROP: {
      // Liberal accept for payload:
      //   1. "selector"             → bare string = target selector; source = top-level selector
      //   2. {x: N, y: N}           → coords-only object = target coords; source = top-level selector
      //   3. {source: "...", target: ...} → full form
      //   4. {target: ...}          → target only; source = top-level selector (legacy form)
      //   3'/4' as a JSON-encoded string, e.g. '{"source":"#a","target":"#b"}'
      //
      // A JSON-shaped string (starts with '{') is decoded up front so forms
      // 3 & 4 below see a real object either way — the same Postel's-law
      // fold-in as scroll. A bare selector string (form 1) is deliberately
      // NOT decoded here: CSS attribute selectors like `[data-foo]` start
      // with '[' and are not valid JSON, and even a selector that started
      // with '{' would fail JSON.parse and fall through unchanged, so
      // there's no real ambiguity — tryParseJsonObject only ever overrides
      // the literal-string interpretation when the string actually is a
      // parseable JSON object.
      const decodedPayload = tryParseJsonObject(payload) ?? payload;

      let source: string;
      let dragTarget: string | { x: number; y: number };

      if (typeof decodedPayload === 'string') {
        // Form 1: bare string = target selector
        source = topSelector ?? '';
        dragTarget = decodedPayload;
      } else if (
        typeof decodedPayload === 'object' && decodedPayload !== null &&
        (decodedPayload as Record<string, any>).x !== undefined &&
        (decodedPayload as Record<string, any>).y !== undefined &&
        (decodedPayload as Record<string, any>).target === undefined &&
        (decodedPayload as Record<string, any>).source === undefined
      ) {
        // Form 2: bare coords object = target coords
        const p = decodedPayload as Record<string, any>;
        source = topSelector ?? '';
        dragTarget = { x: p.x as number, y: p.y as number };
      } else {
        // Forms 3 & 4: object with source/target fields
        const p = decodedPayload as Record<string, any>;
        source = topSelector ?? p.source;
        const targetRaw = p.target;
        if (targetRaw === undefined) {
          throw new Error("drag_drop requires payload.target (target selector or {x,y})");
        }
        // Parse target: coordinates object, a JSON-encoded coordinates
        // string, or a plain selector string.
        if (typeof targetRaw === 'object' && targetRaw.x !== undefined && targetRaw.y !== undefined) {
          dragTarget = { x: targetRaw.x, y: targetRaw.y };
        } else if (typeof targetRaw === 'string') {
          const coords = tryParseCoords(targetRaw);
          dragTarget = coords ?? targetRaw;
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
      return formatCaptureResponse('Dragged', `${source} → ${targetDesc}`, dragResult.capture, dragResult.dialog, dragResult.artifacts, dragResult.credentialSuppressed, dragResult.suppressedReason, dragResult.capturePaused);
    }

    case BrowserAction.MOUSE_MOVE: {
      // mouse_move has no legitimate bare-string form (there's no sensible
      // single string that means "x and y"), so it uses the strict
      // resolver: a string payload MUST be parseable JSON, and a failure
      // to parse is reported honestly instead of being silently wrapped
      // under a throwaway key and then failing the field check below with
      // a misleading "missing" message.
      const shapeHint = '{x,y} or {x,y,steps?,fromX?,fromY?}';
      const resolved = resolveStrictStructuredPayload(payload);
      if (resolved.errorDetail) {
        throw new Error(`mouse_move requires payload with x and y coordinates: ${shapeHint} (${resolved.errorDetail})`);
      }
      const p = resolved.object!;
      if (typeof p.x !== 'number' || typeof p.y !== 'number') {
        throw new Error(`mouse_move requires payload with x and y coordinates: ${shapeHint} (payload parsed but x/y are missing or not numbers: ${truncateForError(JSON.stringify(p))})`);
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

      const scrollAmount = 300;
      const SCROLL_DIRECTIONS: Record<string, { deltaX?: number; deltaY?: number }> = {
        down: { deltaY: scrollAmount },
        up: { deltaY: -scrollAmount },
        right: { deltaX: scrollAmount },
        left: { deltaX: -scrollAmount },
      };

      // A direction keyword (form 1) is checked first: it's a fixed, known
      // vocabulary that never overlaps with JSON syntax. Anything else that
      // is a string is then decoded via the same tryParseJsonObject()
      // primitive drag_drop uses, folding scroll's previously hand-rolled
      // (and untyped — it did `parsed.deltaX || 0` without checking the
      // parsed value was actually a number) JSON.parse fallback into the
      // same mechanism and the same typeof-number validation as the native
      // object payload path below.
      let effectivePayload: string | Record<string, any> | undefined = payload;
      const direction = typeof payload === 'string' ? SCROLL_DIRECTIONS[payload.toLowerCase().trim()] : undefined;
      if (direction) {
        Object.assign(scrollOpts, direction);
      } else if (typeof payload === 'string') {
        const parsedObj = tryParseJsonObject(payload);
        if (!parsedObj) {
          const detail = describeUnusableScrollPayload(payload);
          throw new Error(`scroll payload must be a direction (up/down/left/right) or {deltaX?,deltaY?,selector?} (${detail})`);
        }
        effectivePayload = parsedObj;
      }

      if (!direction) {
        if (typeof effectivePayload === 'object' && effectivePayload !== null) {
          const p = effectivePayload as Record<string, any>;
          if (!topSelector && typeof p.selector === 'string') scrollOpts.selector = p.selector;
          if (typeof p.deltaX === 'number') scrollOpts.deltaX = p.deltaX;
          if (typeof p.deltaY === 'number') scrollOpts.deltaY = p.deltaY;
          if (!('deltaX' in p) && !('deltaY' in p)) {
            throw new Error("scroll object payload requires at least deltaX or deltaY");
          }
        } else {
          throw new Error("scroll requires payload: direction string or {deltaX?,deltaY?,selector?}");
        }
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
      return formatCaptureResponse('Double-clicked', selector, dblClickResult.capture, dblClickResult.dialog, dblClickResult.artifacts, dblClickResult.credentialSuppressed, dblClickResult.suppressedReason, dblClickResult.capturePaused);
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
      return formatCaptureResponse('Right-clicked', selector, rightClickResult.capture, rightClickResult.dialog, rightClickResult.artifacts, rightClickResult.credentialSuppressed, rightClickResult.suppressedReason, rightClickResult.capturePaused);
    }

    case BrowserAction.FILE_UPLOAD: {
      const p = parsePayload(payload, 'file_upload');
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
        uploadResult.artifacts,
        uploadResult.credentialSuppressed,
        uploadResult.suppressedReason,
        uploadResult.capturePaused
      );
    }

    case BrowserAction.KEYBOARD_PRESS: {
      const p = parsePayload(payload, 'keyboard_press');
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
        keyResult.artifacts,
        keyResult.credentialSuppressed,
        keyResult.suppressedReason,
        keyResult.capturePaused
      );
    }

    case BrowserAction.SET_VIEWPORT: {
      // set_viewport has no legitimate bare-string form (there's no
      // sensible single string that means "width and height"), so it uses
      // the strict resolver: a string payload MUST be parseable JSON. This
      // keeps '{"width":390,"height":844}' from falling through
      // parsePayload's literal-wrap fallback, landing in the
      // (p.viewport || {}) branch below with an empty object, and throwing
      // "requires payload with width and height" even though both were
      // supplied, just JSON-encoded.
      const shapeHint = '{width,height,deviceScaleFactor?,mobile?}';
      const resolved = resolveStrictStructuredPayload(payload);
      if (resolved.errorDetail) {
        throw new Error(`set_viewport requires payload with width and height: ${shapeHint} (${resolved.errorDetail})`);
      }
      const vp = resolved.object!;
      if (typeof vp.width !== 'number' || typeof vp.height !== 'number') {
        throw new Error(`set_viewport requires payload with width and height: ${shapeHint} (payload parsed but width/height are missing or not numbers: ${truncateForError(JSON.stringify(vp))})`);
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
      const p = parsePayload(payload, 'get_console_messages');
      // A bare numeric string payload ('1785900000000') is coerced to a
      // number by parsePayload via the spec's numericDefaultKey, so it
      // behaves exactly like {since:1785900000000}. A `since` that was
      // supplied but can't be a timestamp is now an honest error instead of
      // being silently ignored (which returned every message, as if no
      // filter had been requested).
      const resolvedSince = resolveConsoleSince(p.since);
      if (resolvedSince.errorDetail) {
        throw new Error(`get_console_messages payload must be an epoch-ms timestamp or {since:epochMs} (${resolvedSince.errorDetail})`);
      }
      const since = (resolvedSince.ms !== undefined) ? new Date(resolvedSince.ms) : null;
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

    case BrowserAction.PAUSE_CAPTURE: {
      chromeLib.pauseCapture();
      return capturePause.CAPTURE_PAUSED_NOTICE;
    }

    case BrowserAction.RESUME_CAPTURE: {
      chromeLib.resumeCapture();
      return 'Capture resumed: automatic DOM/markdown/screenshot/console/dialog captures are back on.';
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

      const p = parsePayload(payload, 'switch_tab');
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
pause_capture, resume_capture → Stop/restart automatic captures (use around a secret reveal)
kill_chrome, restart_chrome → Chrome lifecycle control (recovery)

## Schema: 4 parameters
{"action": "...", "selector": "CSS or XPath (null/omit if no element target)", "payload": "..." or {...}, "timeout": ms}

selector is a CSS or XPath string for actions that target an element (null/omit otherwise).
payload is a literal string for code/free-text actions (eval, type, await_text, select) — never JSON-parsed.
payload is a string or object for simple actions (navigate, set_profile, keyboard_press, etc.)
payload is an object for structured actions (set_viewport, drag_drop, etc.) — a JSON-encoded string with the same fields works too, except set_viewport/mouse_move/drag_drop's coords form, which has no bare-string equivalent.
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
set_attr: {"action": "set_attr", "selector": "#code-input-0", "payload": {"name": "data-sen-nonce", "value": "opaque-nonce"}} → write-only; name must be exactly "data-sen-nonce" or "data-sen-secret" (nothing else, not even other data-*/aria-* names); works even while a data-sen-secret element is on the page (eval does not). Use name="data-sen-secret" to MARK a secret element (TOTP/2FA seeds and other secrets with no distinctive shape) as soon as the action that revealed it returns, before any other action on that page. Marking only affects later actions: capture files already written (typically that revealing action's NNN-*.html/.md) keep the value and are not deleted.
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
get_console_messages: {"action": "get_console_messages", "payload": "1716000000000"} → same, bare epoch-ms string
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

## Capture Pause
pause_capture: {"action": "pause_capture"} → turn off every automatic capture (DOM/markdown/screenshot/console/dialog artifacts) for the rest of this session
resume_capture: {"action": "resume_capture"} → turn automatic captures back on

Use this around a step that reveals a secret with no recognizable shape and no secret-looking id/name/class — a "show password" toggle, a generated-password dialog, backup/recovery codes, a TOTP seed — where neither the token-shape scan nor the data-sen-secret marker would catch it. pause_capture, do the reveal, read the value through the credential broker, then resume_capture once it's off-screen. Every CAPTURING action's response (click/type/select/eval/set_attr/navigate/hover/drag_drop/double_click/right_click/file_upload/keyboard_press) says capture is paused while this is on, so forgetting to resume is visible rather than silent on those; a non-capturing action (scroll, back/forward, new_tab, extract, attr, await_*, a dialog:: click, ...) just returns its normal result, since it was never gated on capture to begin with. Capture simply stays off for the rest of the session (it does NOT auto-resume on navigation — a same-origin route change can still carry the secret forward). While paused, screenshot refuses outright (an explicit shot could write the exact secret you paused to hide); extract never wrote to disk in the first place, so pausing does not change it. If a native dialog (alert/confirm/prompt/beforeunload) is or becomes open while paused, the response still reports which KIND it is, but never its message or default-prompt text. The action itself (click, type, eval, ...) still runs while paused — only the auto-capture artifacts are skipped.

## Credential-Shaped Pages
If a page shows credential-shaped content (Slack/GitHub/1Password tokens, otpauth:// seeds, or any element with a data-sen-secret attribute), auto-capture for that action writes no files and returns only metadata with a "⚠️ Page shows credential-shaped content" line; screenshot refuses; token-shaped substrings (not the data-sen-secret marker itself, which has no substring to redact) are replaced by [REDACTED credential-shaped] everywhere else. eval refuses outright — with no value-blind exception — while ANY element on the page carries data-sen-secret, checked live at the moment of the call (a point check that does not remember a page was ever marked). extract and attr instead read off an inert clone with data-sen-secret content removed, or refuse if the resolved element OR ANY ANCESTOR of it (through shadow-root hosts) is marked; markup inside an iframe's srcdoc attribute is not stripped (extract html and attr srcdoc return it verbatim). The marker scan covers the top document, open shadow roots and same-origin iframe/frame/object/embed. set_attr is a separate write-only action (see above) that is NOT gated by any of this — it takes no caller JavaScript; its ok/no-match/refused responses act as a limited prefix oracle over page content — except that it refuses to touch an element already marked data-sen-secret unless the write IS the (re-)marking itself. Its attribute name must be exactly "data-sen-nonce" or "data-sen-secret" (no other data-*/aria-* name — arbitrary data-*/aria-* attributes are routinely wired to page behavior, e.g. data-action/aria-controls, so they are not assumed inert): use "data-sen-nonce" to write a broker nonce onto an unmarked sibling element on a page that already has a captured secret, and "data-sen-secret" to mark every matching element (hidden duplicates included) yourself as soon as the action that revealed it returns — capture files written before the mark keep the value and are not deleted. Marking only ever tightens what eval/extract/attr will refuse, never loosens or removes an existing mark. Use a credential broker to capture secret values. THIS IS NOT A SECURITY BOUNDARY: eval runs in the same JS realm as a marked element and can already read/fetch/stash its value or erase the marker itself; don't mark then eval on a page expecting the value to stay contained. SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE=1 disables all of this. (Internally, html-with-scrub.js/markdown.js also blank a marked element's whole text subtree, not just its attributes — defense-in-depth behind the whole-capture suppression above, not a separate partial-capture mode; the suppression above is what actually runs for auto-capture.)

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

  const result = redactUnlessAllowed(await executeBrowserAction(params));
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
Actions on a page showing token-shaped content (Slack/GitHub/1Password tokens, otpauth:// URIs) or any data-sen-secret element write no capture files, token-shaped values are redacted from all output, and eval refuses outright while any data-sen-secret element is on the page — an accident guard against a cooperating agent's own reads, not a security boundary. A secret with no distinctive shape (bare TOTP seed, backup code) is captured like any other text until it is marked: mark it with 'set_attr' name 'data-sen-secret' as soon as the action that revealed it returns, before any other action on that page. Capture files written before the mark keep the value and are not deleted, so don't read them back. 'set_attr' is a write-only setter for exactly 'data-sen-nonce' or 'data-sen-secret' that is exempt from that eval restriction (see 'help' for details) — use it, not eval, to write onto the page while a secret is present.

Schema: 4 parameters — action, selector (CSS/XPath or null), payload (string or object), timeout (ms).
selector targets a DOM element (null/omit for navigation, eval, tab management, etc.).
payload is a string for simple actions (navigate=URL, type=text, eval=JS, keyboard_press=key).
payload is an object for structured actions (set_viewport={width,height}, drag_drop={target}, etc.) — a JSON-encoded string of the same object works too.
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
      if (error && (error as any).refused === true) {
        return {
          content: [{
            type: "text" as const,
            text: redactUnlessAllowed(formatDialogRefusal(error as any)),
          }],
        };
      }
      const errorMessage = redactUnlessAllowed(error instanceof Error ? error.message : String(error));
      return {
        content: [{
          type: "text" as const,
          text: `Error: ${errorMessage}`
        }],
        isError: true
      };
    }
  }
);

/**
 * Exit when the host goes away.
 *
 * Nothing here shuts the server down on its own: the SDK's stdio transport only
 * subscribes to stdin's 'data' and 'error', so an EOF on the pipe never reaches
 * `transport.onclose`, and `main()` has no other exit path. A host that dies
 * without draining us therefore leaves this process running forever.
 *
 * That leak is not merely untidy. Each live MCP holds a profile lock, so the
 * next server finds slot 1 taken and falls through to `<profile>-2`, `-3`, ...,
 * launching a *new* Chrome for each. Leaked servers accumulate leaked browsers.
 * They also keep serving `require()`-cached copies of the launch code, so edits
 * to chrome-process.js silently do not apply to them.
 *
 * Exiting normally releases the profile lock (see chrome-process.js), which lets
 * the next server reclaim slot 1 and reconnect to — or adopt — the same Chrome
 * instead of spawning another one.
 */
function installHostLifecycleWatch(): (reason: string, code?: number) => void {
  let exiting = false;
  const shutdown = (reason: string, code = 0) => {
    if (exiting) return;
    exiting = true;
    // process.exit runs the 'exit' handlers that release the profile lock.
    console.error(`Chrome MCP server exiting: ${reason}`);
    process.exit(code);
  };

  // Primary signal. Covers a clean host shutdown and, because the pipe's write
  // end closes with the process, a host that is SIGKILLed as well.
  process.stdin.on('end', () => shutdown('stdin closed by host'));
  process.stdin.on('close', () => shutdown('stdin closed by host'));

  // Backstop for the case stdin stays open on someone else's behalf — a shell
  // wrapper, or another process inheriting the descriptor. Losing our original
  // parent means we were reparented (to init, or to a subreaper), so the host
  // we were speaking to is gone regardless of what stdin still says.
  // CHROME_WS_PPID_WATCHDOG_MS overrides the interval (0 disables) — the
  // escape hatch for wrappers where the direct parent legitimately exits.
  const rawInterval = Number(process.env.CHROME_WS_PPID_WATCHDOG_MS);
  const intervalMs = Number.isFinite(rawInterval) && rawInterval >= 0 ? rawInterval : 30_000;
  if (intervalMs > 0) {
    const originalPpid = process.ppid;
    const watchdog = setInterval(() => {
      if (process.ppid !== originalPpid) {
        shutdown(`reparented (ppid ${originalPpid} -> ${process.ppid})`);
      }
    }, intervalMs);
    // Do not keep the event loop alive on the watchdog's account.
    watchdog.unref();
  }

  return shutdown;
}

// Main function
async function main() {
  // Initialize session and register cleanup
  chromeLib.initializeSession();

  // Create stdio transport
  const transport = new StdioServerTransport();

  // Leave no path where the host is gone and we keep running.
  const shutdown = installHostLifecycleWatch();

  // Close/error handlers go on the Protocol (server.server), not the
  // transport: Protocol.connect() chains a pre-existing transport.onclose in
  // the current SDK, but older 1.x versions (within our ^1.6.1 range)
  // overwrote it outright. Protocol's own onclose/onerror are public and
  // order-independent. The transport closes itself on a fatal read error
  // (oversized frame blowing the ReadBuffer) with the host still alive —
  // that close is a failure and must not exit 0.
  let transportErrored = false;
  server.server.onerror = (error: Error) => {
    transportErrored = true;
    console.error(`Chrome MCP server transport error: ${error?.message ?? error}`);
  };
  server.server.onclose = () => {
    shutdown(
      transportErrored ? 'transport closed after error' : 'transport closed',
      transportErrored ? 1 : 0
    );
  };

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
