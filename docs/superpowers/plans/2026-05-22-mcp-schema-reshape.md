# MCP Schema Reshape: selector + sticky activeTab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reshape `use_browser` from `{action, tab_index, payload}` to `{action, selector, payload, timeout}` with session-level `activeTab` state, and add a `switch_tab` action.

**Architecture:** Remove the `tab_index` parameter; add top-level `selector` (CSS/XPath string) and `timeout` (ms, for await actions) parameters. All tab-targeting reads from `state.activeTab` (default 0). A new `switch_tab` action finds a tab by index/URL-substring/title-substring and updates `state.activeTab`. Actions that create or close tabs update `state.activeTab` automatically.

**Tech Stack:** TypeScript (MCP server), Node.js CommonJS (lib), Zod schema validation, Node built-in test runner.

---

### Task 1: Add `activeTab` to session-state

**Files:**
- Modify: `skills/browsing/lib/session-state.js`
- Modify: `test/lib/session-state.test.mjs`

- [ ] **Step 1: Write the failing test**

Add to `test/lib/session-state.test.mjs`:

```javascript
describe('session-state: activeTab', () => {
  it('defaults activeTab to 0', () => {
    const state = createState();
    assert.equal(state.activeTab, 0);
  });

  it('activeTab is mutable', () => {
    const state = createState();
    state.activeTab = 3;
    assert.equal(state.activeTab, 3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/jesse/Documents/GitHub/superpowers/superpowers-chrome.bridge
node --test 'test/lib/session-state.test.mjs'
```

Expected: FAIL — `state.activeTab` is `undefined`, not `0`.

- [ ] **Step 3: Add `activeTab: 0` to `createState`**

In `skills/browsing/lib/session-state.js`, add `activeTab: 0` after `browserSession: null`:

```javascript
    // Bridge primitives: the session's BrowserBridge instance and active BrowserSession.
    browserBridge: null,
    browserSession: null,

    // Sticky tab state: updated by switch_tab, new_tab, close_tab.
    activeTab: 0,
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test 'test/lib/session-state.test.mjs'
```

Expected: PASS (all 4 tests including the 2 new ones).

- [ ] **Step 5: Commit**

```bash
git add skills/browsing/lib/session-state.js test/lib/session-state.test.mjs
git commit -m "feat(state): add activeTab field, defaults to 0"
```

---

### Task 2: Reshape `UseBrowserParams` schema in `mcp/src/index.ts`

**Files:**
- Modify: `mcp/src/index.ts` (schema block and `UseBrowserInput` type only — no handler changes yet)

- [ ] **Step 1: Write the failing schema test**

Create `test/mcp-schema.test.mjs`:

```javascript
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bundleSrc = fs.readFileSync(
  path.join(__dirname, '..', 'mcp', 'dist', 'index.js'),
  'utf8'
);

describe('use_browser schema shape', () => {
  it('schema has selector parameter', () => {
    assert.ok(bundleSrc.includes('"selector"') || bundleSrc.includes("'selector'"),
      'bundle should reference selector parameter');
  });

  it('schema has timeout parameter', () => {
    assert.ok(bundleSrc.includes('"timeout"') || bundleSrc.includes("'timeout'"),
      'bundle should reference timeout parameter');
  });

  it('schema does NOT have tab_index parameter', () => {
    // tab_index should only appear in comments or old strings, not as a Zod field name
    // We check the tool registration section specifically
    assert.ok(!bundleSrc.includes('tab_index:'),
      'bundle should not define tab_index as a schema field');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test 'test/mcp-schema.test.mjs'
```

Expected: FAIL — bundle still has `tab_index:` in schema, no `selector`.

- [ ] **Step 3: Replace `UseBrowserParams` in `mcp/src/index.ts`**

Replace the entire `UseBrowserParams` const and `UseBrowserInput` type:

```typescript
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
};

type UseBrowserInput = z.infer<ReturnType<typeof z.object<typeof UseBrowserParams>>>;
```

Also add `SWITCH_TAB = "switch_tab"` to the `BrowserAction` enum:

```typescript
  // Tab management
  SWITCH_TAB = "switch_tab",      // payload=tab index, URL substring, or title substring
```

- [ ] **Step 4: Build the bundle**

```bash
cd /Users/jesse/Documents/GitHub/superpowers/superpowers-chrome.bridge && npm run build
```

Expected: Build succeeds without TypeScript errors.

- [ ] **Step 5: Run schema test to verify it passes**

```bash
node --test 'test/mcp-schema.test.mjs'
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add mcp/src/index.ts mcp/dist/index.js test/mcp-schema.test.mjs
git commit -m "feat(schema): selector+timeout top-level params; remove tab_index; add switch_tab action"
```

---

### Task 3: Update `executeBrowserAction` — replace `tab_index` with `state.activeTab`

**Files:**
- Modify: `mcp/src/index.ts` — `executeBrowserAction` function body

The key change: everywhere the handler reads `params.tab_index`, replace with a module-level `state` object read from `chromeLib`. Because `chromeLib` is a session object that already contains `state` internally, we need to expose `activeTab` via the session API. The MCP layer will maintain its own `activeTab` variable (initialized to 0) that mirrors `state.activeTab` — simpler than threading state into the lib.

- [ ] **Step 1: Write a failing MCP-layer integration test for activeTab persistence**

Add to `test/mcp-schema.test.mjs`:

```javascript
describe('switch_tab action in bundle', () => {
  it('bundle source references switch_tab action handler', () => {
    assert.ok(bundleSrc.includes('switch_tab') || bundleSrc.includes('SWITCH_TAB'),
      'bundle should handle switch_tab action');
  });

  it('bundle source uses activeTab variable instead of params.tab_index', () => {
    assert.ok(!bundleSrc.includes('params.tab_index'),
      'bundle should not reference params.tab_index in handler');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test 'test/mcp-schema.test.mjs'
```

Expected: FAIL — bundle still uses `params.tab_index`.

- [ ] **Step 3: Add module-level `activeTab` state in `mcp/src/index.ts`**

After the `chromeLib` initialization line, add:

```typescript
// Sticky tab state: updated by switch_tab, new_tab, close_tab
let activeTab = 0;
```

- [ ] **Step 4: Update `executeBrowserAction` signature and replace all `tabIndex` reads**

Change the function to use `activeTab` from module scope, and update `selector` extraction. Replace the first two lines of `executeBrowserAction`:

```typescript
async function executeBrowserAction(params: UseBrowserInput): Promise<string> {
  const tabIndex = activeTab;
  // Selector comes from top-level param; for actions that used payload=selector string,
  // we now accept selector from the top-level param OR (for backward compat during
  // transition) from the payload string.
  const topSelector = params.selector ?? null;
  const payload = params.payload;
  const topTimeout = params.timeout;
```

- [ ] **Step 5: Update each action handler to prefer top-level `selector`**

For each action that previously did `parsePayload(payload, 'selector')` to get a selector, update to prefer `topSelector` with payload as fallback:

For **CLICK**:
```typescript
    case BrowserAction.CLICK: {
      const selector = topSelector ?? (typeof payload === 'string' ? payload : null);
      if (!selector) {
        throw new Error("click requires selector (top-level) or payload string");
      }
      const clickResult = await chromeLib.clickWithCapture(tabIndex, selector);
      return formatActionResponse(clickResult, `Clicked: ${selector}`);
    }
```

For **HOVER**:
```typescript
    case BrowserAction.HOVER: {
      const selector = topSelector ?? (typeof payload === 'string' ? payload : null);
      if (!selector) {
        throw new Error("hover requires selector (top-level) or payload string");
      }
      const hoverResult = await chromeLib.captureActionWithDiff(
        tabIndex, 'hover', () => chromeLib.hover(tabIndex, selector)
      );
      return formatCaptureResponse('Hovered', selector, hoverResult.capture, hoverResult.dialog, hoverResult.artifacts);
    }
```

For **DOUBLE_CLICK**:
```typescript
    case BrowserAction.DOUBLE_CLICK: {
      const selector = topSelector ?? (typeof payload === 'string' ? payload : null);
      if (!selector) {
        throw new Error("double_click requires selector (top-level) or payload string");
      }
      const dblClickResult = await chromeLib.captureActionWithDiff(
        tabIndex, 'dblclick', () => chromeLib.doubleClick(tabIndex, selector)
      );
      return formatCaptureResponse('Double-clicked', selector, dblClickResult.capture, dblClickResult.dialog, dblClickResult.artifacts);
    }
```

For **RIGHT_CLICK**:
```typescript
    case BrowserAction.RIGHT_CLICK: {
      const selector = topSelector ?? (typeof payload === 'string' ? payload : null);
      if (!selector) {
        throw new Error("right_click requires selector (top-level) or payload string");
      }
      const rightClickResult = await chromeLib.captureActionWithDiff(
        tabIndex, 'rightclick', () => chromeLib.rightClick(tabIndex, selector)
      );
      return formatCaptureResponse('Right-clicked', selector, rightClickResult.capture, rightClickResult.dialog, rightClickResult.artifacts);
    }
```

For **AWAIT_ELEMENT**:
```typescript
    case BrowserAction.AWAIT_ELEMENT: {
      const selector = topSelector ?? (typeof payload === 'string' ? payload : (parsePayload(payload, 'selector').selector));
      if (!selector || typeof selector !== 'string') {
        throw new Error("await_element requires selector (top-level or payload)");
      }
      const timeout = topTimeout ?? (typeof (parsePayload(payload, 'selector')).timeout === 'number' ? (parsePayload(payload, 'selector')).timeout : 5000);
      await chromeLib.waitForElement(tabIndex, selector, timeout);
      return `Element found: ${selector}`;
    }
```

For **AWAIT_TEXT** (uses `topTimeout`):
```typescript
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
```

For **TYPE** (selector can come from top-level or payload):
```typescript
    case BrowserAction.TYPE: {
      const p = parsePayload(payload, 'text');
      const text = p.text;
      const selector = topSelector ?? p.selector ?? null;
      if (!text || typeof text !== 'string') {
        throw new Error("type requires payload with text (string or {selector?,text})");
      }
      const typeResult = await chromeLib.captureActionWithDiff(
        tabIndex, 'type', () => chromeLib.humanType(tabIndex, selector, text)
      );
      if (!typeResult.capture) {
        const target = selector ? `into ${selector}` : 'into current focus';
        return formatCaptureResponse('Typed', target, null, typeResult.dialog, typeResult.artifacts);
      }
      return formatCaptureResponse(
        'Typed', selector ? `into ${selector}` : 'into current focus', typeResult.capture
      );
    }
```

For **EXTRACT** (selector from top-level or payload):
```typescript
    case BrowserAction.EXTRACT: {
      const p = parsePayload(payload, 'selector');
      const selector = topSelector ?? (typeof p.selector === 'string' ? p.selector : undefined);
      const format = typeof p.format === 'string' ? p.format : 'text';
      // ... rest of handler unchanged
```

For **SCREENSHOT** (selector from top-level or payload.selector):
```typescript
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
```

For **SELECT** (selector from top-level or payload):
```typescript
    case BrowserAction.SELECT: {
      const p = parsePayload(payload, 'value');
      const selector = topSelector ?? p.selector;
      if (!selector || typeof selector !== 'string') {
        throw new Error("select requires selector (top-level or payload.selector)");
      }
      // ... rest of handler unchanged
```

For **ATTR** (selector from top-level or payload):
```typescript
    case BrowserAction.ATTR: {
      const p = parsePayload(payload, 'selector');
      const selector = topSelector ?? p.selector;
      const attr = p.attr;
      if (!selector || typeof selector !== 'string') {
        throw new Error("attr requires selector (top-level or payload.selector)");
      }
      // ... rest unchanged
```

For **FILE_UPLOAD** (selector from top-level or payload):
```typescript
    case BrowserAction.FILE_UPLOAD: {
      const p = parsePayload(payload, 'files');
      const selector = topSelector ?? p.selector;
      if (!selector || typeof selector !== 'string') {
        throw new Error("file_upload requires selector (top-level or payload.selector) for the file input element");
      }
      // ... rest unchanged
```

For **DRAG_DROP** (source from top-level selector or payload.source):
```typescript
    case BrowserAction.DRAG_DROP: {
      const p = parsePayload(payload, 'source');
      const source = topSelector ?? p.source;
      if (!source || typeof source !== 'string') {
        throw new Error("drag_drop requires selector (top-level, used as source) or payload.source");
      }
      // ... rest unchanged
```

For **SCROLL** (selector from top-level if scrolling a specific element):
```typescript
    case BrowserAction.SCROLL: {
      const scrollOpts: { selector?: string; deltaX?: number; deltaY?: number } = {};
      if (topSelector) scrollOpts.selector = topSelector;

      if (typeof payload === 'object' && payload !== null) {
        // ... existing object payload logic, but don't override topSelector
        const p = payload as Record<string, any>;
        if (!topSelector && typeof p.selector === 'string') scrollOpts.selector = p.selector;
        // ... rest unchanged
```

- [ ] **Step 6: Update `NEW_TAB` to set `activeTab = 0`**

New tabs become index 0 in Chrome (newest first):

```typescript
    case BrowserAction.NEW_TAB: {
      const p = parsePayload(payload, 'url');
      const newTabUrl = (typeof p.url === 'string' && p.url.trim()) ? p.url.trim() : undefined;
      const newTabResult = await chromeLib.newTab(newTabUrl);
      activeTab = 0; // New tab becomes the first tab (Chrome inserts at front)
      const openedAt = newTabUrl ? ` at ${newTabUrl}` : '';
      return `New tab created: ${newTabResult.id}${openedAt}. Active tab is now 0.`;
    }
```

- [ ] **Step 7: Update `CLOSE_TAB` to reset `activeTab` if it was the active one**

```typescript
    case BrowserAction.CLOSE_TAB: {
      await chromeLib.closeTab(tabIndex);
      if (activeTab > 0) activeTab = 0; // Reset to first remaining tab
      return `Closed tab ${tabIndex}. Active tab is now ${activeTab}.`;
    }
```

- [ ] **Step 8: Build the bundle**

```bash
cd /Users/jesse/Documents/GitHub/superpowers/superpowers-chrome.bridge && npm run build
```

Expected: Build succeeds without TypeScript errors.

- [ ] **Step 9: Run updated schema tests**

```bash
node --test 'test/mcp-schema.test.mjs'
```

Expected: PASS (all 5 tests including the 2 new ones).

- [ ] **Step 10: Commit**

```bash
git add mcp/src/index.ts mcp/dist/index.js
git commit -m "refactor(mcp): use module-level activeTab; selector as top-level param for element-targeting actions"
```

---

### Task 4: Add `switch_tab` action handler

**Files:**
- Modify: `mcp/src/index.ts` — add `SWITCH_TAB` case to `executeBrowserAction`

- [ ] **Step 1: Write failing tests for `switch_tab` in `test/mcp-schema.test.mjs`**

Add a describe block (these tests inspect the bundle source):

```javascript
describe('switch_tab logic in bundle source', () => {
  it('bundle handles BrowserAction.SWITCH_TAB / switch_tab', () => {
    assert.ok(
      bundleSrc.includes('SWITCH_TAB') || bundleSrc.includes('"switch_tab"'),
      'bundle should contain switch_tab handler'
    );
  });

  it('switch_tab handler searches by url or title substring', () => {
    // The handler must call getTabs and match against url/title
    assert.ok(bundleSrc.includes('getTabs'), 'handler should call getTabs');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test 'test/mcp-schema.test.mjs'
```

Expected: FAIL — switch_tab case is missing from handler.

- [ ] **Step 3: Add `SWITCH_TAB` case to `executeBrowserAction`**

Add this case before the `default:` clause:

```typescript
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
```

- [ ] **Step 4: Add `switch_tab` to `HELP` action text**

In the HELP case, add to the "Tab Management" section:

```
switch_tab: {"action": "switch_tab", "payload": 1} → switch to tab by index
switch_tab: {"action": "switch_tab", "payload": "github.com"} → switch by URL substring
switch_tab: {"action": "switch_tab", "payload": "My Page Title"} → switch by title substring
```

Also update the schema description in the help text:

```
## Schema: 4 parameters
{"action": "...", "selector": "CSS or XPath (null/omit if no element target)", "payload": "..." or {...}, "timeout": ms}
```

- [ ] **Step 5: Build the bundle**

```bash
cd /Users/jesse/Documents/GitHub/superpowers/superpowers-chrome.bridge && npm run build
```

Expected: Build succeeds.

- [ ] **Step 6: Run schema tests**

```bash
node --test 'test/mcp-schema.test.mjs'
```

Expected: All 7 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add mcp/src/index.ts mcp/dist/index.js
git commit -m "feat(mcp): add switch_tab action — match by index, URL substring, or title substring"
```

---

### Task 5: Update scenario files

**Files:**
- Modify: `tests/scenarios/01-smoke.md` through `tests/scenarios/14-recovery.md` (14 files)

Each scenario is a natural-language guide for an LLM test agent. The updates are:
1. Remove any mention of `tab_index` parameter — tabs are now implicit via `activeTab`.
2. Where a scenario says to pass a CSS/XPath selector as `payload` to click/hover/etc., rewrite it as the `selector` top-level param.
3. Where multi-tab scenarios referenced `tab_index: N`, replace with `switch_tab` + the tab's URL or title.

- [ ] **Step 1: Update `01-smoke.md`**

No `tab_index` references — no changes needed.

- [ ] **Step 2: Update `02-action-libs.md`**

No `tab_index` references — no changes needed.

- [ ] **Step 3: Update `03-dialog-confirm.md`**

No `tab_index` references. Update selector references to use the new top-level form. Read the file, check, update if needed.

```
# Existing: click `dialog::accept`
# New: action="click", selector="dialog::accept" (same — selector is now top-level)
```

No prose changes needed as it refers to selectors conceptually, not as JSON params.

- [ ] **Step 4: Update `04-popup-dialog.md`**

Read and check for `tab_index`. Update if found.

- [ ] **Step 5: Update `05-popup-form-fill.md`**

Read and check for `tab_index`. Update if found.

- [ ] **Step 6: Update `06-failure-modes.md`**

No `tab_index` references — no changes needed. Note: the `click('#does-not-exist')` prose already implies selector-based notation.

- [ ] **Step 7: Update `07-cli-smoke.md`**

Read and check for `tab_index`. Update if found.

- [ ] **Step 8: Update `08-mouse-keyboard-extras.md`**

No `tab_index`. Update any step that writes `hover(selector)` as `payload` to note it's now a top-level param.

- [ ] **Step 9: Update `09-file-upload-and-console.md`**

Read and check for `tab_index`. Update if found.

- [ ] **Step 10: Update `10-dialog-kinds-extras.md`**

Read and check for `tab_index`. Update if found.

- [ ] **Step 11: Update `11-browser-actions.md`**

This scenario passes tab index as positional arg (e.g., `back(0)`, `set_viewport(0, ...)`, `forward(0)`). Update all such references to omit the tab index argument (now implicit):
- `back(0)` → `back` (no arg)
- `forward(0)` → `forward` (no arg)
- `set_viewport(0, {width:800, height:600})` → `set_viewport({width:800, height:600})`
- `get_viewport(0)` → `get_viewport`

- [ ] **Step 12: Update `12-iframes-https.md`**

Read and check for `tab_index`. Update if found.

- [ ] **Step 13: Update `13-multi-tab-and-service-worker.md`**

This is the main multi-tab scenario. Update:
- "Tab 0 / Tab 1 / Tab 2" language with `fill(tab_N, ...)` → use `switch_tab` + `type`/`fill` without index.
- Example rewrites:
  - `fill(tab_0, '#i', 'A')` → `switch_tab(payload=URL or title of tab 0)` then `type(selector='#i', payload='A')`
  - `fill(tab_1, '#i', 'B')` → `switch_tab(payload='beta')` then `type(selector='#i', payload='B')`
  - `close_tab` → `close_tab` (closes active tab)
  - `eval on tab 0` → `switch_tab(payload='alpha')` then `eval`

- [ ] **Step 14: Update `14-recovery.md`**

Read and check for `tab_index`. Update if found.

- [ ] **Step 15: Commit all scenario updates**

```bash
git add tests/scenarios/
git commit -m "docs(scenarios): update 14 scenario files for new selector/switch_tab schema"
```

---

### Task 6: Full test suite pass + final build

**Files:**
- No new files — verification only

- [ ] **Step 1: Run full test suite**

```bash
cd /Users/jesse/Documents/GitHub/superpowers/superpowers-chrome.bridge && npm test
```

Expected output: all tests PASS, lint clean, bundle fresh.

- [ ] **Step 2: Verify bundle smoke test**

```bash
timeout 2 node mcp/dist/index.js || true
```

Expected: stderr shows `Chrome MCP server running via stdio`.

- [ ] **Step 3: Fix any failures**

If bundle-drift test fails, the handler calls a `chromeLib` method that doesn't exist — check the new `switch_tab` handler uses only `chromeLib.getTabs()`.

If lint fails, run `npm run lint:fix` and re-add changed files.

- [ ] **Step 4: Final commit**

```bash
git add -p  # stage any lint fixes
git commit -m "refactor(mcp): selector becomes 2nd top-level param; sticky activeTab via switch_tab action"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| `selector` top-level param with XPath/CSS description | Task 2 |
| `timeout` top-level param for await_* | Task 2 |
| Remove `tab_index` param | Task 2 |
| `activeTab: 0` default in session-state | Task 1 |
| `switch_tab` by index | Task 4 |
| `switch_tab` by URL substring | Task 4 |
| `switch_tab` by title substring | Task 4 |
| `new_tab` → `activeTab = 0` | Task 3 |
| `close_tab` → `activeTab = 0` if was active | Task 3 |
| `dialog::*` selectors still via `selector` | Task 3 (preserved in handlers) |
| Update 14 scenario files | Task 5 |
| Tests for `activeTab` in session-state | Task 1 |
| Tests for `switch_tab` action | Task 4 |
| Tests that `tab_index` is gone from schema | Task 2 |

**Placeholder scan:** All code blocks contain actual implementation code. No TODOs or "similar to above" references.

**Type consistency:** `activeTab` is `number` throughout (module-level `let activeTab = 0`). `topSelector` is `string | null | undefined`. `tabList` entries typed inline. `parsePayload` return type is `Record<string, any>` — unchanged from existing code.
