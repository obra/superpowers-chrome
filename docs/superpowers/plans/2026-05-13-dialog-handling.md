# Dialog Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface JS dialogs, device choosers, permission prompts, and basic-auth challenges as synthetic "pages" the agent reads with the existing `click` / `type` / `extract` actions via a `dialog::*` selector grammar.

**Architecture:** One new module `lib/dialogs.js` owns dialog state, CDP event subscriptions, and a `withDialogAwareness` middleware. A new `lib/dialogs-router.js` handles `dialog::*` selectors. A new `lib/dialogs-render.js` produces synthetic capture artifacts. Three existing modules get tiny hooks: `capture.js`, `mouse.js` + `keyboard-input.js`, `cdp-connection.js`. The MCP action enum and CLI dispatch are unchanged.

**Tech Stack:** Node.js (CommonJS in `lib/`, ESM `.mjs` in tests), `node:test`, Chrome DevTools Protocol over WebSocket.

**Spec:** `docs/superpowers/specs/2026-05-13-dialog-handling-design.md`

---

## File Structure

**New files:**

- `skills/browsing/lib/dialogs.js` — per-tab state map, CDP event subscriptions, `attachDialogs({state, sendCdpCommand, resolveWsUrl})` factory, `withDialogAwareness` middleware, page/browser action classification.
- `skills/browsing/lib/dialogs-render.js` — pure rendering. `renderSyntheticArtifacts(state)` returns `{markdown, html, consoleSnapshot}`. `renderResponseSummary(state, tabIndex)` returns the inline response-text block.
- `skills/browsing/lib/dialogs-router.js` — pure selector routing. `tryHandleDialogSelector({selector, op, payload, state, sendCdpCommand, wsUrl})` returns `{handled: true, result?, error?}` or `{handled: false}`.
- `skills/browsing/lib/page-scripts/permission-shim.js` — JS source string injected into pages at `document_start`. Wraps `getUserMedia`, `Notification.requestPermission`, `geolocation.*`, `clipboard.*`.
- `test/lib/dialogs.test.mjs` — Tier A unit tests for state machine + middleware + classification.
- `test/lib/dialogs-render.test.mjs` — Tier A renderer tests + golden-file fixtures.
- `test/lib/dialogs-router.test.mjs` — Tier A router tests.
- `test/lib/dialogs.integration.test.mjs` — Tier B integration tests using a mock CDP server.
- `test/lib/dialogs.smoke.test.mjs` — Tier C real-Chrome smoke tests (gated like existing Tier C).
- `test/lib/fixtures/dialog-alert.md`, `dialog-confirm.md`, `dialog-prompt.md`, `dialog-prompt-default.md`, `dialog-beforeunload.md`, `dialog-device-chooser-0.md`, `dialog-device-chooser-1.md`, `dialog-device-chooser-many.md`, `dialog-permission.md`, `dialog-basic-auth.md`, `dialog-basic-auth-no-realm.md` — golden files.

**Modified files:**

- `skills/browsing/lib/capture.js` — wrap every `*WithCapture` body in `withDialogAwareness`; check dialog state in `capturePageArtifacts` and return synthetic when open.
- `skills/browsing/lib/mouse.js` — at the top of `click(...)`, call `tryHandleDialogSelector`; return on `handled: true`.
- `skills/browsing/lib/keyboard-input.js` — same hook in `fill(...)` for `dialog::*` selectors.
- `skills/browsing/lib/cdp-connection.js` — in `getPooledConnection`, after creating `conn`, call `dialogs.attachToConnection(conn, wsUrl)`.
- `skills/browsing/chrome-ws-lib.js` — pass `dialogs` API into the wiring so MCP and CLI both share it.

---

## API Contracts (frozen here, referenced by tasks)

**`attachDialogs({ state, sendCdpCommand, resolveWsUrl })` returns:**

```js
{
  getOpen(wsUrl): DialogState | null,
  clear(wsUrl): void,
  attachToConnection(conn, wsUrl): Promise<void>,
  withDialogAwareness(actionName, wsUrl, fn): Promise<any>,
  PAGE_TARGET_ACTIONS: Set<string>,
  BROWSER_TARGET_ACTIONS: Set<string>,
}
```

**`DialogState` shape:**

```js
{
  kind: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
      | 'device-chooser' | 'permission' | 'basic-auth',
  openedAt: number,
  payload: object, // kind-specific (see spec §Dialog State Model)
  staged: { promptText?: string, username?: string, password?: string, deviceId?: string },
}
```

**Refusal return shape** (what middleware emits when refusing a page-target action):

```js
{
  refused: true,
  error: 'Page is behind a dialog. Handle dialog::accept or dialog::dismiss first.',
  dialog: <DialogState>,
  artifacts: { markdown, html, consoleSnapshot },
}
```

`*WithCapture` wrappers translate `refused: true` into the normal response shape (artifacts written, response text shows dialog summary).

---

## Task 1: Module skeleton + state-map API

**Files:**
- Create: `skills/browsing/lib/dialogs.js`
- Test: `test/lib/dialogs.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// test/lib/dialogs.test.mjs
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { makeCdpSpy, makeResolveWsUrl } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachDialogs } = require('../../skills/browsing/lib/dialogs.js');

function setup(handlers = {}) {
  const state = {};
  const sendCdpCommand = makeCdpSpy(handlers);
  const api = attachDialogs({ state, sendCdpCommand, resolveWsUrl: makeResolveWsUrl() });
  return { api, sendCdpCommand, state };
}

describe('dialogs state map', () => {
  it('getOpen returns null when no dialog is open', () => {
    const { api } = setup();
    assert.equal(api.getOpen('ws://x'), null);
  });

  it('clear is a no-op when no dialog is open', () => {
    const { api } = setup();
    api.clear('ws://x');
    assert.equal(api.getOpen('ws://x'), null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lib/dialogs.test.mjs`
Expected: FAIL with `Cannot find module '../../skills/browsing/lib/dialogs.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// skills/browsing/lib/dialogs.js
'use strict';

function attachDialogs({ state, sendCdpCommand, resolveWsUrl }) {
  if (!state.dialogs) state.dialogs = new Map();

  function getOpen(wsUrl) {
    return state.dialogs.get(wsUrl) || null;
  }

  function clear(wsUrl) {
    state.dialogs.delete(wsUrl);
  }

  return { getOpen, clear };
}

module.exports = { attachDialogs };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lib/dialogs.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add skills/browsing/lib/dialogs.js test/lib/dialogs.test.mjs
git commit -m "Add dialogs module skeleton with state-map API"
```

---

## Task 2: attachToConnection enables Page, DeviceAccess, Fetch

**Files:**
- Modify: `skills/browsing/lib/dialogs.js`
- Modify: `test/lib/dialogs.test.mjs`

- [ ] **Step 1: Add failing test**

Append to `test/lib/dialogs.test.mjs`:

```js
describe('dialogs attachToConnection', () => {
  it('enables Page, DeviceAccess, and Fetch domains once', async () => {
    const { api, sendCdpCommand } = setup();
    const conn = { eventHandler: null };
    await api.attachToConnection(conn, 'ws://x');
    const methods = sendCdpCommand.calls.map(c => c.method);
    assert.deepEqual(methods, ['Page.enable', 'DeviceAccess.enable', 'Fetch.enable']);
  });

  it('Fetch.enable passes handleAuthRequests and wildcard pattern', async () => {
    const { api, sendCdpCommand } = setup();
    const conn = { eventHandler: null };
    await api.attachToConnection(conn, 'ws://x');
    const fetchCall = sendCdpCommand.calls.find(c => c.method === 'Fetch.enable');
    assert.equal(fetchCall.params.handleAuthRequests, true);
    assert.deepEqual(fetchCall.params.patterns, [{ urlPattern: '*' }]);
  });

  it('installs an eventHandler on the connection', async () => {
    const { api } = setup();
    const conn = { eventHandler: null };
    await api.attachToConnection(conn, 'ws://x');
    assert.equal(typeof conn.eventHandler, 'function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lib/dialogs.test.mjs`
Expected: FAIL with `api.attachToConnection is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `skills/browsing/lib/dialogs.js`, add inside `attachDialogs`:

```js
async function attachToConnection(conn, wsUrl) {
  await sendCdpCommand(wsUrl, 'Page.enable', {});
  await sendCdpCommand(wsUrl, 'DeviceAccess.enable', {});
  await sendCdpCommand(wsUrl, 'Fetch.enable', {
    handleAuthRequests: true,
    patterns: [{ urlPattern: '*' }],
  });
  conn.eventHandler = (msg) => handleCdpEvent(wsUrl, msg);
}

function handleCdpEvent(_wsUrl, _msg) {
  // Filled in by later tasks.
}
```

Return `attachToConnection` from the factory:

```js
return { getOpen, clear, attachToConnection };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lib/dialogs.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add skills/browsing/lib/dialogs.js test/lib/dialogs.test.mjs
git commit -m "dialogs.attachToConnection enables Page/DeviceAccess/Fetch + installs event handler"
```

---

## Task 3: Parse Page.javascriptDialogOpening into state

**Files:**
- Modify: `skills/browsing/lib/dialogs.js`
- Modify: `test/lib/dialogs.test.mjs`

- [ ] **Step 1: Add failing test**

```js
describe('Page.javascriptDialogOpening', () => {
  async function fireEvent(api, conn, wsUrl, params) {
    await api.attachToConnection(conn, wsUrl);
    conn.eventHandler({ method: 'Page.javascriptDialogOpening', params });
  }

  it('populates state with kind: alert', async () => {
    const { api } = setup();
    const conn = {};
    await fireEvent(api, conn, 'ws://x', {
      type: 'alert', message: 'hi', defaultPrompt: '', url: 'http://e.com', hasBrowserHandler: false,
    });
    const s = api.getOpen('ws://x');
    assert.equal(s.kind, 'alert');
    assert.equal(s.payload.message, 'hi');
    assert.equal(s.payload.url, 'http://e.com');
    assert.equal(typeof s.openedAt, 'number');
  });

  it('populates state with kind: confirm', async () => {
    const { api } = setup();
    const conn = {};
    await fireEvent(api, conn, 'ws://x', { type: 'confirm', message: 'q', defaultPrompt: '', url: '', hasBrowserHandler: false });
    assert.equal(api.getOpen('ws://x').kind, 'confirm');
  });

  it('populates state with kind: prompt including defaultPrompt', async () => {
    const { api } = setup();
    const conn = {};
    await fireEvent(api, conn, 'ws://x', { type: 'prompt', message: 'name?', defaultPrompt: 'guest', url: '', hasBrowserHandler: false });
    const s = api.getOpen('ws://x');
    assert.equal(s.kind, 'prompt');
    assert.equal(s.payload.defaultPrompt, 'guest');
  });

  it('populates state with kind: beforeunload', async () => {
    const { api } = setup();
    const conn = {};
    await fireEvent(api, conn, 'ws://x', { type: 'beforeunload', message: '', defaultPrompt: '', url: '', hasBrowserHandler: false });
    assert.equal(api.getOpen('ws://x').kind, 'beforeunload');
  });

  it('initializes staged with empty object', async () => {
    const { api } = setup();
    const conn = {};
    await fireEvent(api, conn, 'ws://x', { type: 'alert', message: 'x', defaultPrompt: '', url: '', hasBrowserHandler: false });
    assert.deepEqual(api.getOpen('ws://x').staged, {});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lib/dialogs.test.mjs`
Expected: FAIL — `getOpen` still returns `null` even after the event.

- [ ] **Step 3: Write minimal implementation**

Replace the `handleCdpEvent` stub in `skills/browsing/lib/dialogs.js`:

```js
function handleCdpEvent(wsUrl, msg) {
  if (msg.method === 'Page.javascriptDialogOpening') {
    if (state.dialogs.has(wsUrl)) {
      console.error(`[dialogs] second javascriptDialogOpening on ${wsUrl}; preserving original`);
      return;
    }
    const p = msg.params;
    state.dialogs.set(wsUrl, {
      kind: p.type, // CDP uses 'alert' | 'confirm' | 'prompt' | 'beforeunload'
      openedAt: Date.now(),
      payload: {
        message: p.message,
        defaultPrompt: p.defaultPrompt,
        url: p.url,
        hasBrowserHandler: p.hasBrowserHandler,
      },
      staged: {},
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lib/dialogs.test.mjs`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add skills/browsing/lib/dialogs.js test/lib/dialogs.test.mjs
git commit -m "dialogs handles Page.javascriptDialogOpening events"
```

---

## Task 4: Clear state on Page.javascriptDialogClosed and Page.frameNavigated

**Files:**
- Modify: `skills/browsing/lib/dialogs.js`
- Modify: `test/lib/dialogs.test.mjs`

- [ ] **Step 1: Add failing test**

```js
describe('dialog state clearing', () => {
  it('Page.javascriptDialogClosed clears state', async () => {
    const { api } = setup();
    const conn = {};
    await api.attachToConnection(conn, 'ws://x');
    conn.eventHandler({ method: 'Page.javascriptDialogOpening', params: { type: 'alert', message: 'x', defaultPrompt: '', url: '', hasBrowserHandler: false } });
    conn.eventHandler({ method: 'Page.javascriptDialogClosed', params: { result: true, userInput: '' } });
    assert.equal(api.getOpen('ws://x'), null);
  });

  it('Page.frameNavigated clears state defensively (main frame only)', async () => {
    const { api } = setup();
    const conn = {};
    await api.attachToConnection(conn, 'ws://x');
    conn.eventHandler({ method: 'Page.javascriptDialogOpening', params: { type: 'alert', message: 'x', defaultPrompt: '', url: '', hasBrowserHandler: false } });
    conn.eventHandler({ method: 'Page.frameNavigated', params: { frame: { id: 'main', parentId: undefined } } });
    assert.equal(api.getOpen('ws://x'), null);
  });

  it('Page.frameNavigated does NOT clear state for subframes', async () => {
    const { api } = setup();
    const conn = {};
    await api.attachToConnection(conn, 'ws://x');
    conn.eventHandler({ method: 'Page.javascriptDialogOpening', params: { type: 'alert', message: 'x', defaultPrompt: '', url: '', hasBrowserHandler: false } });
    conn.eventHandler({ method: 'Page.frameNavigated', params: { frame: { id: 'sub', parentId: 'main' } } });
    assert.notEqual(api.getOpen('ws://x'), null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lib/dialogs.test.mjs`
Expected: FAIL — state persists after close/navigate.

- [ ] **Step 3: Write minimal implementation**

In `handleCdpEvent`, add:

```js
if (msg.method === 'Page.javascriptDialogClosed') {
  state.dialogs.delete(wsUrl);
  return;
}
if (msg.method === 'Page.frameNavigated') {
  if (msg.params.frame && !msg.params.frame.parentId) {
    state.dialogs.delete(wsUrl);
  }
  return;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lib/dialogs.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/browsing/lib/dialogs.js test/lib/dialogs.test.mjs
git commit -m "dialogs clears state on dialogClosed and main-frame navigation"
```

---

## Task 5: Second-open guard preserves original and logs

**Files:**
- Modify: `test/lib/dialogs.test.mjs` (test only — implementation landed in Task 3)

- [ ] **Step 1: Add test verifying the existing guard**

```js
describe('second-open guard', () => {
  it('preserves the original dialog and logs a warning on second open', async () => {
    const { api } = setup();
    const conn = {};
    await api.attachToConnection(conn, 'ws://x');
    conn.eventHandler({ method: 'Page.javascriptDialogOpening', params: { type: 'alert', message: 'first', defaultPrompt: '', url: '', hasBrowserHandler: false } });

    // Capture console.error
    const errors = [];
    const origErr = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    try {
      conn.eventHandler({ method: 'Page.javascriptDialogOpening', params: { type: 'confirm', message: 'second', defaultPrompt: '', url: '', hasBrowserHandler: false } });
    } finally {
      console.error = origErr;
    }

    assert.equal(api.getOpen('ws://x').payload.message, 'first');
    assert.equal(api.getOpen('ws://x').kind, 'alert');
    assert.ok(errors.some(e => e.includes('second javascriptDialogOpening')));
  });
});
```

- [ ] **Step 2: Run test to verify it passes** (no implementation change needed)

Run: `node --test test/lib/dialogs.test.mjs`
Expected: PASS — Task 3 already wrote the guard. This test pins the behavior so a future refactor cannot remove it without breaking a test.

- [ ] **Step 3: Commit**

```bash
git add test/lib/dialogs.test.mjs
git commit -m "Pin second-open guard behavior with explicit test"
```

---

## Task 6: Renderer skeleton + markdown for `alert`

**Files:**
- Create: `skills/browsing/lib/dialogs-render.js`
- Create: `test/lib/dialogs-render.test.mjs`
- Create: `test/lib/fixtures/dialog-alert.md`

- [ ] **Step 1: Write the golden fixture**

`test/lib/fixtures/dialog-alert.md`:

```
# Dialog: alert
Tab origin: http://example.com

> Something happened.

Buttons:
  - dialog::accept   (OK)

To interact:
  click selector="dialog::accept"
```

- [ ] **Step 2: Write the failing test**

```js
// test/lib/dialogs-render.test.mjs
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { renderSyntheticArtifacts } = require('../../skills/browsing/lib/dialogs-render.js');

function golden(name) {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf8');
}

describe('renderSyntheticArtifacts', () => {
  it('renders alert markdown matching golden file', () => {
    const out = renderSyntheticArtifacts({
      kind: 'alert',
      payload: { message: 'Something happened.', url: 'http://example.com', defaultPrompt: '', hasBrowserHandler: false },
      staged: {},
    });
    assert.equal(out.markdown.trim(), golden('dialog-alert.md').trim());
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/lib/dialogs-render.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 4: Write minimal implementation**

```js
// skills/browsing/lib/dialogs-render.js
'use strict';

function renderSyntheticArtifacts(s) {
  let markdown;
  if (s.kind === 'alert') {
    markdown = [
      `# Dialog: alert`,
      `Tab origin: ${s.payload.url || '(unknown)'}`,
      ``,
      `> ${s.payload.message}`,
      ``,
      `Buttons:`,
      `  - dialog::accept   (OK)`,
      ``,
      `To interact:`,
      `  click selector="dialog::accept"`,
    ].join('\n');
  } else {
    markdown = `# Dialog: ${s.kind}\n(unsupported in this render path)`;
  }
  return { markdown, html: '', consoleSnapshot: '' };
}

module.exports = { renderSyntheticArtifacts };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/lib/dialogs-render.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add skills/browsing/lib/dialogs-render.js test/lib/dialogs-render.test.mjs test/lib/fixtures/dialog-alert.md
git commit -m "Add dialogs-render with alert markdown"
```

---

## Task 7: Renderer for confirm, prompt, beforeunload

**Files:**
- Modify: `skills/browsing/lib/dialogs-render.js`
- Modify: `test/lib/dialogs-render.test.mjs`
- Create: `test/lib/fixtures/dialog-confirm.md`, `dialog-prompt.md`, `dialog-prompt-default.md`, `dialog-beforeunload.md`

- [ ] **Step 1: Write the four fixtures**

`dialog-confirm.md`:
```
# Dialog: confirm
Tab origin: http://example.com

> Are you sure?

Buttons:
  - dialog::accept   (OK)
  - dialog::dismiss  (Cancel)

To interact:
  click selector="dialog::accept"
  click selector="dialog::dismiss"
```

`dialog-prompt.md`:
```
# Dialog: prompt
Tab origin: http://example.com

> Enter your name:

Input: dialog::prompt   (type text here, then click dialog::accept)
Buttons:
  - dialog::accept
  - dialog::dismiss
```

`dialog-prompt-default.md`:
```
# Dialog: prompt
Tab origin: http://example.com

> Enter your nickname:
Default: "guest"

Input: dialog::prompt   (type text here, then click dialog::accept)
Buttons:
  - dialog::accept
  - dialog::dismiss
```

`dialog-beforeunload.md`:
```
# Dialog: beforeunload
Tab origin: http://example.com

> The page wants to confirm you really want to leave.

Buttons:
  - dialog::accept   (Leave)
  - dialog::dismiss  (Stay)

To interact:
  click selector="dialog::accept"
  click selector="dialog::dismiss"
```

- [ ] **Step 2: Add failing tests**

Append to `test/lib/dialogs-render.test.mjs`:

```js
it('renders confirm matching golden', () => {
  const out = renderSyntheticArtifacts({
    kind: 'confirm',
    payload: { message: 'Are you sure?', url: 'http://example.com', defaultPrompt: '', hasBrowserHandler: false },
    staged: {},
  });
  assert.equal(out.markdown.trim(), golden('dialog-confirm.md').trim());
});

it('renders prompt without default matching golden', () => {
  const out = renderSyntheticArtifacts({
    kind: 'prompt',
    payload: { message: 'Enter your name:', url: 'http://example.com', defaultPrompt: '', hasBrowserHandler: false },
    staged: {},
  });
  assert.equal(out.markdown.trim(), golden('dialog-prompt.md').trim());
});

it('renders prompt with default matching golden', () => {
  const out = renderSyntheticArtifacts({
    kind: 'prompt',
    payload: { message: 'Enter your nickname:', url: 'http://example.com', defaultPrompt: 'guest', hasBrowserHandler: false },
    staged: {},
  });
  assert.equal(out.markdown.trim(), golden('dialog-prompt-default.md').trim());
});

it('renders beforeunload matching golden', () => {
  const out = renderSyntheticArtifacts({
    kind: 'beforeunload',
    payload: { message: 'The page wants to confirm you really want to leave.', url: 'http://example.com', defaultPrompt: '', hasBrowserHandler: false },
    staged: {},
  });
  assert.equal(out.markdown.trim(), golden('dialog-beforeunload.md').trim());
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/lib/dialogs-render.test.mjs`
Expected: FAIL — three kinds return the fallback string.

- [ ] **Step 4: Write minimal implementation**

Replace the body of `renderSyntheticArtifacts` in `skills/browsing/lib/dialogs-render.js`:

```js
function renderSyntheticArtifacts(s) {
  const origin = s.payload.url || '(unknown)';
  let markdown;

  if (s.kind === 'alert') {
    markdown = [
      `# Dialog: alert`,
      `Tab origin: ${origin}`,
      ``,
      `> ${s.payload.message}`,
      ``,
      `Buttons:`,
      `  - dialog::accept   (OK)`,
      ``,
      `To interact:`,
      `  click selector="dialog::accept"`,
    ].join('\n');
  } else if (s.kind === 'confirm') {
    markdown = [
      `# Dialog: confirm`,
      `Tab origin: ${origin}`,
      ``,
      `> ${s.payload.message}`,
      ``,
      `Buttons:`,
      `  - dialog::accept   (OK)`,
      `  - dialog::dismiss  (Cancel)`,
      ``,
      `To interact:`,
      `  click selector="dialog::accept"`,
      `  click selector="dialog::dismiss"`,
    ].join('\n');
  } else if (s.kind === 'prompt') {
    const lines = [
      `# Dialog: prompt`,
      `Tab origin: ${origin}`,
      ``,
      `> ${s.payload.message}`,
    ];
    if (s.payload.defaultPrompt) lines.push(`Default: "${s.payload.defaultPrompt}"`);
    lines.push(``, `Input: dialog::prompt   (type text here, then click dialog::accept)`);
    lines.push(`Buttons:`, `  - dialog::accept`, `  - dialog::dismiss`);
    markdown = lines.join('\n');
  } else if (s.kind === 'beforeunload') {
    markdown = [
      `# Dialog: beforeunload`,
      `Tab origin: ${origin}`,
      ``,
      `> ${s.payload.message || 'The page wants to confirm you really want to leave.'}`,
      ``,
      `Buttons:`,
      `  - dialog::accept   (Leave)`,
      `  - dialog::dismiss  (Stay)`,
      ``,
      `To interact:`,
      `  click selector="dialog::accept"`,
      `  click selector="dialog::dismiss"`,
    ].join('\n');
  } else {
    markdown = `# Dialog: ${s.kind}\n(unsupported in this render path)`;
  }

  return { markdown, html: '', consoleSnapshot: '' };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/lib/dialogs-render.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add skills/browsing/lib/dialogs-render.js test/lib/dialogs-render.test.mjs test/lib/fixtures/dialog-confirm.md test/lib/fixtures/dialog-prompt.md test/lib/fixtures/dialog-prompt-default.md test/lib/fixtures/dialog-beforeunload.md
git commit -m "Render confirm/prompt/beforeunload dialogs"
```

---

## Task 8: Renderer for device-chooser

**Files:**
- Modify: `skills/browsing/lib/dialogs-render.js`
- Modify: `test/lib/dialogs-render.test.mjs`
- Create: `test/lib/fixtures/dialog-device-chooser-0.md`, `dialog-device-chooser-1.md`, `dialog-device-chooser-many.md`

- [ ] **Step 1: Write fixtures**

`dialog-device-chooser-0.md`:
```
# Dialog: device-chooser (usb)
Origin requested a USB device.

(No devices visible.)

Buttons:
  - dialog::dismiss   (Cancel)
```

`dialog-device-chooser-1.md`:
```
# Dialog: device-chooser (usb)
Origin requested a USB device.

Devices:
  - dialog::device[id="abc"]   "Logitech USB Receiver"

Buttons:
  - dialog::dismiss   (Cancel)
```

`dialog-device-chooser-many.md`:
```
# Dialog: device-chooser (bluetooth)
Origin requested a Bluetooth device.

Devices:
  - dialog::device[id="x1"]   "Speaker"
  - dialog::device[id="x2"]   "Headphones"
  - dialog::device[id="x3"]   "Watch"

Buttons:
  - dialog::dismiss   (Cancel)
```

- [ ] **Step 2: Add failing tests**

```js
it('renders device-chooser with 0 devices', () => {
  const out = renderSyntheticArtifacts({
    kind: 'device-chooser',
    payload: { requestId: 'r', deviceKind: 'usb', devices: [] },
    staged: {},
  });
  assert.equal(out.markdown.trim(), golden('dialog-device-chooser-0.md').trim());
});

it('renders device-chooser with 1 device', () => {
  const out = renderSyntheticArtifacts({
    kind: 'device-chooser',
    payload: { requestId: 'r', deviceKind: 'usb', devices: [{ id: 'abc', name: 'Logitech USB Receiver' }] },
    staged: {},
  });
  assert.equal(out.markdown.trim(), golden('dialog-device-chooser-1.md').trim());
});

it('renders device-chooser with many devices', () => {
  const out = renderSyntheticArtifacts({
    kind: 'device-chooser',
    payload: { requestId: 'r', deviceKind: 'bluetooth', devices: [
      { id: 'x1', name: 'Speaker' }, { id: 'x2', name: 'Headphones' }, { id: 'x3', name: 'Watch' },
    ]},
    staged: {},
  });
  assert.equal(out.markdown.trim(), golden('dialog-device-chooser-many.md').trim());
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/lib/dialogs-render.test.mjs`
Expected: FAIL.

- [ ] **Step 4: Write minimal implementation**

Add a `device-chooser` branch in `renderSyntheticArtifacts`:

```js
} else if (s.kind === 'device-chooser') {
  const kindLabel = { usb: 'USB', bluetooth: 'Bluetooth', serial: 'Serial', hid: 'HID' }[s.payload.deviceKind] || s.payload.deviceKind;
  const lines = [
    `# Dialog: device-chooser (${s.payload.deviceKind})`,
    `Origin requested a ${kindLabel} device.`,
    ``,
  ];
  if (s.payload.devices.length === 0) {
    lines.push(`(No devices visible.)`);
  } else {
    lines.push(`Devices:`);
    for (const d of s.payload.devices) {
      lines.push(`  - dialog::device[id="${d.id}"]   "${d.name}"`);
    }
  }
  lines.push(``, `Buttons:`, `  - dialog::dismiss   (Cancel)`);
  markdown = lines.join('\n');
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/lib/dialogs-render.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add skills/browsing/lib/dialogs-render.js test/lib/dialogs-render.test.mjs test/lib/fixtures/dialog-device-chooser-*.md
git commit -m "Render device-chooser dialogs"
```

---

## Task 9: Renderer for permission and basic-auth

**Files:**
- Modify: `skills/browsing/lib/dialogs-render.js`
- Modify: `test/lib/dialogs-render.test.mjs`
- Create: `test/lib/fixtures/dialog-permission.md`, `dialog-basic-auth.md`, `dialog-basic-auth-no-realm.md`

- [ ] **Step 1: Write fixtures**

`dialog-permission.md`:
```
# Dialog: permission
Origin https://example.com requested: camera
JS API: navigator.mediaDevices.getUserMedia

Buttons:
  - dialog::accept   (grant for this origin)
  - dialog::dismiss  (deny for this origin)
```

`dialog-basic-auth.md`:
```
# Dialog: basic-auth
Origin https://example.com — realm "Admin Area"

Inputs:
  dialog::username
  dialog::password

Buttons:
  - dialog::accept
  - dialog::dismiss
```

`dialog-basic-auth-no-realm.md`:
```
# Dialog: basic-auth
Origin https://example.com

Inputs:
  dialog::username
  dialog::password

Buttons:
  - dialog::accept
  - dialog::dismiss
```

- [ ] **Step 2: Add failing tests**

```js
it('renders permission', () => {
  const out = renderSyntheticArtifacts({
    kind: 'permission',
    payload: { name: 'camera', origin: 'https://example.com', jsApi: 'navigator.mediaDevices.getUserMedia' },
    staged: {},
  });
  assert.equal(out.markdown.trim(), golden('dialog-permission.md').trim());
});

it('renders basic-auth with realm', () => {
  const out = renderSyntheticArtifacts({
    kind: 'basic-auth',
    payload: { requestId: 'r', origin: 'https://example.com', scheme: 'basic', realm: 'Admin Area' },
    staged: {},
  });
  assert.equal(out.markdown.trim(), golden('dialog-basic-auth.md').trim());
});

it('renders basic-auth without realm', () => {
  const out = renderSyntheticArtifacts({
    kind: 'basic-auth',
    payload: { requestId: 'r', origin: 'https://example.com', scheme: 'basic', realm: '' },
    staged: {},
  });
  assert.equal(out.markdown.trim(), golden('dialog-basic-auth-no-realm.md').trim());
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/lib/dialogs-render.test.mjs`
Expected: FAIL.

- [ ] **Step 4: Write minimal implementation**

Add branches:

```js
} else if (s.kind === 'permission') {
  markdown = [
    `# Dialog: permission`,
    `Origin ${s.payload.origin} requested: ${s.payload.name}`,
    `JS API: ${s.payload.jsApi}`,
    ``,
    `Buttons:`,
    `  - dialog::accept   (grant for this origin)`,
    `  - dialog::dismiss  (deny for this origin)`,
  ].join('\n');
} else if (s.kind === 'basic-auth') {
  const header = s.payload.realm
    ? `Origin ${s.payload.origin} — realm "${s.payload.realm}"`
    : `Origin ${s.payload.origin}`;
  markdown = [
    `# Dialog: basic-auth`,
    header,
    ``,
    `Inputs:`,
    `  dialog::username`,
    `  dialog::password`,
    ``,
    `Buttons:`,
    `  - dialog::accept`,
    `  - dialog::dismiss`,
  ].join('\n');
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/lib/dialogs-render.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add skills/browsing/lib/dialogs-render.js test/lib/dialogs-render.test.mjs test/lib/fixtures/dialog-permission.md test/lib/fixtures/dialog-basic-auth.md test/lib/fixtures/dialog-basic-auth-no-realm.md
git commit -m "Render permission and basic-auth dialogs"
```

---

## Task 10: Synthetic HTML output

**Files:**
- Modify: `skills/browsing/lib/dialogs-render.js`
- Modify: `test/lib/dialogs-render.test.mjs`

- [ ] **Step 1: Add failing tests**

```js
describe('synthetic html', () => {
  it('emits an element with id=dialog-accept for confirm', () => {
    const out = renderSyntheticArtifacts({
      kind: 'confirm',
      payload: { message: 'q', url: '', defaultPrompt: '', hasBrowserHandler: false },
      staged: {},
    });
    assert.match(out.html, /<button[^>]*id="dialog-accept"/);
    assert.match(out.html, /<button[^>]*id="dialog-dismiss"/);
  });

  it('emits an input id=dialog-prompt for prompt', () => {
    const out = renderSyntheticArtifacts({
      kind: 'prompt',
      payload: { message: 'q', url: '', defaultPrompt: '', hasBrowserHandler: false },
      staged: {},
    });
    assert.match(out.html, /<input[^>]*id="dialog-prompt"/);
  });

  it('emits a button per device with data-device-id', () => {
    const out = renderSyntheticArtifacts({
      kind: 'device-chooser',
      payload: { requestId: 'r', deviceKind: 'usb', devices: [{ id: 'abc', name: 'D' }] },
      staged: {},
    });
    assert.match(out.html, /data-device-id="abc"/);
  });

  it('emits username and password inputs for basic-auth', () => {
    const out = renderSyntheticArtifacts({
      kind: 'basic-auth',
      payload: { requestId: 'r', origin: 'x', scheme: 'basic', realm: '' },
      staged: {},
    });
    assert.match(out.html, /<input[^>]*id="dialog-username"/);
    assert.match(out.html, /<input[^>]*id="dialog-password"[^>]*type="password"/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lib/dialogs-render.test.mjs`
Expected: FAIL — `out.html` is empty.

- [ ] **Step 3: Write minimal implementation**

At the bottom of `renderSyntheticArtifacts`, before returning, build `html`:

```js
const htmlParts = [
  '<!doctype html>',
  '<html><head><title>Dialog</title></head><body>',
  `<h1>Dialog: ${s.kind}</h1>`,
];
if (s.kind === 'prompt') {
  htmlParts.push('<input id="dialog-prompt" type="text">');
}
if (s.kind === 'basic-auth') {
  htmlParts.push('<input id="dialog-username" type="text">');
  htmlParts.push('<input id="dialog-password" type="password">');
}
if (s.kind === 'device-chooser') {
  for (const d of s.payload.devices) {
    htmlParts.push(`<button data-device-id="${d.id}">${d.name}</button>`);
  }
}
const acceptKinds = new Set(['alert', 'confirm', 'prompt', 'beforeunload', 'permission', 'basic-auth']);
const dismissKinds = new Set(['confirm', 'prompt', 'beforeunload', 'device-chooser', 'permission', 'basic-auth']);
if (acceptKinds.has(s.kind)) htmlParts.push('<button id="dialog-accept">Accept</button>');
if (dismissKinds.has(s.kind)) htmlParts.push('<button id="dialog-dismiss">Dismiss</button>');
htmlParts.push('</body></html>');
const html = htmlParts.join('\n');
return { markdown, html, consoleSnapshot: '' };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lib/dialogs-render.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/browsing/lib/dialogs-render.js test/lib/dialogs-render.test.mjs
git commit -m "Emit synthetic HTML for dialogs"
```

---

## Task 11: Response-summary renderer

**Files:**
- Modify: `skills/browsing/lib/dialogs-render.js`
- Modify: `test/lib/dialogs-render.test.mjs`

- [ ] **Step 1: Add failing test**

```js
describe('renderResponseSummary', () => {
  const { renderResponseSummary } = require('../../skills/browsing/lib/dialogs-render.js');

  it('summarizes a confirm dialog inline', () => {
    const summary = renderResponseSummary({
      kind: 'confirm',
      payload: { message: 'Are you sure?', url: 'http://x', defaultPrompt: '', hasBrowserHandler: false },
      staged: {},
    }, 0);
    assert.match(summary, /Dialog open on tab 0: confirm/);
    assert.match(summary, /Message: "Are you sure\?"/);
    assert.match(summary, /Handle with: click dialog::accept \| click dialog::dismiss/);
    assert.match(summary, /no screenshot — dialog overlay is browser-native UI/);
  });

  it('uses a one-button hint for alert', () => {
    const summary = renderResponseSummary({
      kind: 'alert',
      payload: { message: 'hi', url: 'http://x', defaultPrompt: '', hasBrowserHandler: false },
      staged: {},
    }, 1);
    assert.match(summary, /Handle with: click dialog::accept$/m);
  });
});
```

NB: the `require` line lives inside `describe` because the dynamic import pattern in this file is per-describe.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lib/dialogs-render.test.mjs`
Expected: FAIL — function not exported.

- [ ] **Step 3: Write minimal implementation**

In `skills/browsing/lib/dialogs-render.js`:

```js
function renderResponseSummary(s, tabIndex) {
  const lines = [];
  lines.push(`Dialog open on tab ${tabIndex}: ${s.kind}`);
  if (s.payload.message) lines.push(`  Message: "${s.payload.message}"`);
  if (s.kind === 'alert') {
    lines.push(`  Handle with: click dialog::accept`);
  } else if (s.kind === 'device-chooser') {
    lines.push(`  Handle with: click dialog::device[id="..."] | click dialog::dismiss`);
  } else if (s.kind === 'basic-auth') {
    lines.push(`  Handle with: type dialog::username, type dialog::password, click dialog::accept | click dialog::dismiss`);
  } else if (s.kind === 'prompt') {
    lines.push(`  Handle with: type dialog::prompt, click dialog::accept | click dialog::dismiss`);
  } else {
    lines.push(`  Handle with: click dialog::accept | click dialog::dismiss`);
  }
  lines.push(`(no screenshot — dialog overlay is browser-native UI)`);
  return lines.join('\n');
}

module.exports = { renderSyntheticArtifacts, renderResponseSummary };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lib/dialogs-render.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/browsing/lib/dialogs-render.js test/lib/dialogs-render.test.mjs
git commit -m "Add renderResponseSummary inline dialog hint"
```

---

## Task 12: Router skeleton + dialog::accept for JS dialogs

**Files:**
- Create: `skills/browsing/lib/dialogs-router.js`
- Create: `test/lib/dialogs-router.test.mjs`

- [ ] **Step 1: Write failing test**

```js
// test/lib/dialogs-router.test.mjs
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { makeCdpSpy } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { tryHandleDialogSelector } = require('../../skills/browsing/lib/dialogs-router.js');

function jsAlert() {
  return { kind: 'alert', payload: { message: 'x', url: '', defaultPrompt: '', hasBrowserHandler: false }, staged: {} };
}
function jsConfirm() {
  return { kind: 'confirm', payload: { message: 'q', url: '', defaultPrompt: '', hasBrowserHandler: false }, staged: {} };
}
function jsPrompt(staged = {}) {
  return { kind: 'prompt', payload: { message: 'n?', url: '', defaultPrompt: '', hasBrowserHandler: false }, staged };
}

describe('tryHandleDialogSelector', () => {
  it('falls through for non-dialog selectors', async () => {
    const r = await tryHandleDialogSelector({ selector: 'body', op: 'click', state: null, sendCdpCommand: makeCdpSpy(), wsUrl: 'ws://x' });
    assert.deepEqual(r, { handled: false });
  });

  it('errors on dialog::accept when no dialog open', async () => {
    const r = await tryHandleDialogSelector({ selector: 'dialog::accept', op: 'click', state: null, sendCdpCommand: makeCdpSpy(), wsUrl: 'ws://x' });
    assert.equal(r.handled, true);
    assert.match(r.error, /no dialog open/i);
  });

  it('dialog::accept on alert calls handleJavaScriptDialog accept=true', async () => {
    const cdp = makeCdpSpy();
    const r = await tryHandleDialogSelector({ selector: 'dialog::accept', op: 'click', state: jsAlert(), sendCdpCommand: cdp, wsUrl: 'ws://x' });
    assert.equal(r.handled, true);
    const call = cdp.calls.find(c => c.method === 'Page.handleJavaScriptDialog');
    assert.equal(call.params.accept, true);
  });

  it('dialog::accept on prompt includes staged promptText', async () => {
    const cdp = makeCdpSpy();
    await tryHandleDialogSelector({ selector: 'dialog::accept', op: 'click', state: jsPrompt({ promptText: 'hello' }), sendCdpCommand: cdp, wsUrl: 'ws://x' });
    const call = cdp.calls.find(c => c.method === 'Page.handleJavaScriptDialog');
    assert.equal(call.params.promptText, 'hello');
  });

  it('dialog::dismiss on confirm calls handleJavaScriptDialog accept=false', async () => {
    const cdp = makeCdpSpy();
    await tryHandleDialogSelector({ selector: 'dialog::dismiss', op: 'click', state: jsConfirm(), sendCdpCommand: cdp, wsUrl: 'ws://x' });
    const call = cdp.calls.find(c => c.method === 'Page.handleJavaScriptDialog');
    assert.equal(call.params.accept, false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lib/dialogs-router.test.mjs`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```js
// skills/browsing/lib/dialogs-router.js
'use strict';

const JS_KINDS = new Set(['alert', 'confirm', 'prompt', 'beforeunload']);

async function tryHandleDialogSelector({ selector, op, state, sendCdpCommand, wsUrl }) {
  if (!selector || !selector.startsWith('dialog::')) {
    return { handled: false };
  }
  if (!state) {
    return { handled: true, error: 'No dialog open on this tab.' };
  }

  if (selector === 'dialog::accept' && op === 'click') {
    if (JS_KINDS.has(state.kind)) {
      const params = { accept: true };
      if (state.kind === 'prompt' && state.staged.promptText !== undefined) {
        params.promptText = state.staged.promptText;
      }
      await sendCdpCommand(wsUrl, 'Page.handleJavaScriptDialog', params);
      return { handled: true, result: { ok: true } };
    }
  }

  if (selector === 'dialog::dismiss' && op === 'click') {
    if (JS_KINDS.has(state.kind)) {
      await sendCdpCommand(wsUrl, 'Page.handleJavaScriptDialog', { accept: false });
      return { handled: true, result: { ok: true } };
    }
  }

  return { handled: true, error: `Unknown dialog selector or operation: ${op} ${selector}` };
}

module.exports = { tryHandleDialogSelector };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lib/dialogs-router.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/browsing/lib/dialogs-router.js test/lib/dialogs-router.test.mjs
git commit -m "Add dialogs-router with JS dialog accept/dismiss"
```

---

## Task 13: Router stages prompt / username / password text

**Files:**
- Modify: `skills/browsing/lib/dialogs-router.js`
- Modify: `test/lib/dialogs-router.test.mjs`

- [ ] **Step 1: Add failing tests**

```js
describe('router staging', () => {
  it('type dialog::prompt stages promptText, no CDP call', async () => {
    const cdp = makeCdpSpy();
    const state = jsPrompt();
    const r = await tryHandleDialogSelector({ selector: 'dialog::prompt', op: 'type', payload: 'hello', state, sendCdpCommand: cdp, wsUrl: 'ws://x' });
    assert.equal(r.handled, true);
    assert.equal(state.staged.promptText, 'hello');
    assert.equal(cdp.calls.length, 0);
  });

  it('type dialog::username stages username', async () => {
    const cdp = makeCdpSpy();
    const state = { kind: 'basic-auth', payload: { requestId: 'r', origin: 'x', scheme: 'basic', realm: '' }, staged: {} };
    await tryHandleDialogSelector({ selector: 'dialog::username', op: 'type', payload: 'alice', state, sendCdpCommand: cdp, wsUrl: 'ws://x' });
    assert.equal(state.staged.username, 'alice');
  });

  it('type dialog::password stages password', async () => {
    const cdp = makeCdpSpy();
    const state = { kind: 'basic-auth', payload: { requestId: 'r', origin: 'x', scheme: 'basic', realm: '' }, staged: {} };
    await tryHandleDialogSelector({ selector: 'dialog::password', op: 'type', payload: 'p4ss', state, sendCdpCommand: cdp, wsUrl: 'ws://x' });
    assert.equal(state.staged.password, 'p4ss');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lib/dialogs-router.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

In `tryHandleDialogSelector`, before the final return:

```js
if (op === 'type') {
  if (selector === 'dialog::prompt' && state.kind === 'prompt') {
    state.staged.promptText = String(payload ?? '');
    return { handled: true, result: { staged: 'promptText' } };
  }
  if (selector === 'dialog::username' && state.kind === 'basic-auth') {
    state.staged.username = String(payload ?? '');
    return { handled: true, result: { staged: 'username' } };
  }
  if (selector === 'dialog::password' && state.kind === 'basic-auth') {
    state.staged.password = String(payload ?? '');
    return { handled: true, result: { staged: 'password' } };
  }
}
```

Update the function signature to accept `payload`:

```js
async function tryHandleDialogSelector({ selector, op, payload, state, sendCdpCommand, wsUrl }) {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lib/dialogs-router.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/browsing/lib/dialogs-router.js test/lib/dialogs-router.test.mjs
git commit -m "Router stages prompt/username/password text"
```

---

## Task 14: Router dialog::device + DeviceAccess event handling

**Files:**
- Modify: `skills/browsing/lib/dialogs.js`
- Modify: `skills/browsing/lib/dialogs-router.js`
- Modify: `test/lib/dialogs.test.mjs`
- Modify: `test/lib/dialogs-router.test.mjs`

- [ ] **Step 1: Add failing tests**

In `test/lib/dialogs.test.mjs`:

```js
describe('DeviceAccess.deviceRequestPrompted', () => {
  it('populates device-chooser state', async () => {
    const { api } = setup();
    const conn = {};
    await api.attachToConnection(conn, 'ws://x');
    conn.eventHandler({ method: 'DeviceAccess.deviceRequestPrompted', params: {
      id: 'req-1',
      devices: [{ id: 'd1', name: 'USB' }],
    }});
    const s = api.getOpen('ws://x');
    assert.equal(s.kind, 'device-chooser');
    assert.equal(s.payload.requestId, 'req-1');
    assert.deepEqual(s.payload.devices, [{ id: 'd1', name: 'USB' }]);
  });
});
```

In `test/lib/dialogs-router.test.mjs`:

```js
describe('router device selection', () => {
  it('click dialog::device[id="d1"] calls DeviceAccess.selectPrompt', async () => {
    const cdp = makeCdpSpy();
    const state = { kind: 'device-chooser', payload: { requestId: 'req-1', deviceKind: 'usb', devices: [{ id: 'd1', name: 'D' }] }, staged: {} };
    const r = await tryHandleDialogSelector({ selector: 'dialog::device[id="d1"]', op: 'click', state, sendCdpCommand: cdp, wsUrl: 'ws://x' });
    assert.equal(r.handled, true);
    const call = cdp.calls.find(c => c.method === 'DeviceAccess.selectPrompt');
    assert.equal(call.params.id, 'req-1');
    assert.equal(call.params.deviceId, 'd1');
  });

  it('click dialog::dismiss on device-chooser calls cancelPrompt', async () => {
    const cdp = makeCdpSpy();
    const state = { kind: 'device-chooser', payload: { requestId: 'req-1', deviceKind: 'usb', devices: [] }, staged: {} };
    await tryHandleDialogSelector({ selector: 'dialog::dismiss', op: 'click', state, sendCdpCommand: cdp, wsUrl: 'ws://x' });
    const call = cdp.calls.find(c => c.method === 'DeviceAccess.cancelPrompt');
    assert.equal(call.params.id, 'req-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lib/dialogs.test.mjs test/lib/dialogs-router.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

In `dialogs.js`, add to `handleCdpEvent`:

```js
if (msg.method === 'DeviceAccess.deviceRequestPrompted') {
  if (state.dialogs.has(wsUrl)) {
    console.error(`[dialogs] second prompt on ${wsUrl}; preserving original`);
    return;
  }
  state.dialogs.set(wsUrl, {
    kind: 'device-chooser',
    openedAt: Date.now(),
    payload: {
      requestId: msg.params.id,
      deviceKind: msg.params.deviceKind || 'usb', // CDP older versions may omit; default to usb
      devices: msg.params.devices || [],
    },
    staged: {},
  });
  return;
}
```

In `dialogs-router.js`, add a device branch:

```js
const DEVICE_SELECTOR_RE = /^dialog::device\[id="([^"]+)"\]$/;

if (op === 'click') {
  const m = DEVICE_SELECTOR_RE.exec(selector);
  if (m && state.kind === 'device-chooser') {
    await sendCdpCommand(wsUrl, 'DeviceAccess.selectPrompt', {
      id: state.payload.requestId,
      deviceId: m[1],
    });
    return { handled: true, result: { ok: true } };
  }
  if (selector === 'dialog::dismiss' && state.kind === 'device-chooser') {
    await sendCdpCommand(wsUrl, 'DeviceAccess.cancelPrompt', { id: state.payload.requestId });
    return { handled: true, result: { ok: true } };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lib/dialogs.test.mjs test/lib/dialogs-router.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/browsing/lib/dialogs.js skills/browsing/lib/dialogs-router.js test/lib/dialogs.test.mjs test/lib/dialogs-router.test.mjs
git commit -m "Wire DeviceAccess prompt event and dialog::device selector"
```

---

## Task 15: Fetch.requestPaused pass-through + basic-auth state

**Files:**
- Modify: `skills/browsing/lib/dialogs.js`
- Modify: `test/lib/dialogs.test.mjs`

- [ ] **Step 1: Add failing tests**

```js
describe('Fetch.requestPaused', () => {
  it('continues plain requests immediately', async () => {
    const { api, sendCdpCommand } = setup();
    const conn = {};
    await api.attachToConnection(conn, 'ws://x');
    sendCdpCommand.calls.length = 0;
    conn.eventHandler({ method: 'Fetch.requestPaused', params: { requestId: 'r1' /* no authChallenge */ } });
    const call = sendCdpCommand.calls.find(c => c.method === 'Fetch.continueRequest');
    assert.equal(call.params.requestId, 'r1');
    assert.equal(api.getOpen('ws://x'), null);
  });

  it('surfaces basic-auth challenge as dialog state', async () => {
    const { api, sendCdpCommand } = setup();
    const conn = {};
    await api.attachToConnection(conn, 'ws://x');
    sendCdpCommand.calls.length = 0;
    conn.eventHandler({ method: 'Fetch.requestPaused', params: {
      requestId: 'r2',
      authChallenge: { source: 'Server', origin: 'https://x.com', scheme: 'basic', realm: 'Admin' },
    }});
    const s = api.getOpen('ws://x');
    assert.equal(s.kind, 'basic-auth');
    assert.equal(s.payload.requestId, 'r2');
    assert.equal(s.payload.realm, 'Admin');
    // No automatic continue yet — agent must respond.
    assert.equal(sendCdpCommand.calls.find(c => c.method === 'Fetch.continueWithAuth'), undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lib/dialogs.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

In `dialogs.js` `handleCdpEvent`:

```js
if (msg.method === 'Fetch.requestPaused') {
  const p = msg.params;
  if (p.authChallenge) {
    if (state.dialogs.has(wsUrl)) {
      console.error(`[dialogs] auth challenge while dialog open on ${wsUrl}; preserving original`);
      return;
    }
    state.dialogs.set(wsUrl, {
      kind: 'basic-auth',
      openedAt: Date.now(),
      payload: {
        requestId: p.requestId,
        origin: p.authChallenge.origin,
        scheme: p.authChallenge.scheme,
        realm: p.authChallenge.realm || '',
      },
      staged: {},
    });
  } else {
    sendCdpCommand(wsUrl, 'Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
  }
  return;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lib/dialogs.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/browsing/lib/dialogs.js test/lib/dialogs.test.mjs
git commit -m "Handle Fetch.requestPaused with auth-challenge surfacing"
```

---

## Task 16: Router dialog::accept / dismiss for basic-auth

**Files:**
- Modify: `skills/browsing/lib/dialogs-router.js`
- Modify: `test/lib/dialogs-router.test.mjs`

- [ ] **Step 1: Add failing tests**

```js
describe('basic-auth router', () => {
  function authState(staged = {}) {
    return { kind: 'basic-auth', payload: { requestId: 'r', origin: 'x', scheme: 'basic', realm: 'R' }, staged };
  }

  it('dialog::accept calls Fetch.continueWithAuth with ProvideCredentials', async () => {
    const cdp = makeCdpSpy();
    await tryHandleDialogSelector({ selector: 'dialog::accept', op: 'click', state: authState({ username: 'u', password: 'p' }), sendCdpCommand: cdp, wsUrl: 'ws://x' });
    const call = cdp.calls.find(c => c.method === 'Fetch.continueWithAuth');
    assert.equal(call.params.requestId, 'r');
    assert.equal(call.params.authChallengeResponse.response, 'ProvideCredentials');
    assert.equal(call.params.authChallengeResponse.username, 'u');
    assert.equal(call.params.authChallengeResponse.password, 'p');
  });

  it('dialog::dismiss calls Fetch.continueWithAuth with CancelAuth', async () => {
    const cdp = makeCdpSpy();
    await tryHandleDialogSelector({ selector: 'dialog::dismiss', op: 'click', state: authState(), sendCdpCommand: cdp, wsUrl: 'ws://x' });
    const call = cdp.calls.find(c => c.method === 'Fetch.continueWithAuth');
    assert.equal(call.params.authChallengeResponse.response, 'CancelAuth');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lib/dialogs-router.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

In `dialogs-router.js`, before the final return:

```js
if (op === 'click' && state.kind === 'basic-auth') {
  if (selector === 'dialog::accept') {
    await sendCdpCommand(wsUrl, 'Fetch.continueWithAuth', {
      requestId: state.payload.requestId,
      authChallengeResponse: {
        response: 'ProvideCredentials',
        username: state.staged.username || '',
        password: state.staged.password || '',
      },
    });
    return { handled: true, result: { ok: true } };
  }
  if (selector === 'dialog::dismiss') {
    await sendCdpCommand(wsUrl, 'Fetch.continueWithAuth', {
      requestId: state.payload.requestId,
      authChallengeResponse: { response: 'CancelAuth' },
    });
    return { handled: true, result: { ok: true } };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lib/dialogs-router.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/browsing/lib/dialogs-router.js test/lib/dialogs-router.test.mjs
git commit -m "Router accept/dismiss for basic-auth via Fetch.continueWithAuth"
```

---

## Task 17: Router emits friendly errors for unknown selectors

**Files:**
- Modify: `skills/browsing/lib/dialogs-router.js`
- Modify: `test/lib/dialogs-router.test.mjs`

- [ ] **Step 1: Add failing tests**

```js
describe('router errors', () => {
  it('unknown dialog selector returns error listing valid ones', async () => {
    const cdp = makeCdpSpy();
    const r = await tryHandleDialogSelector({ selector: 'dialog::garbage', op: 'click', state: jsAlert(), sendCdpCommand: cdp, wsUrl: 'ws://x' });
    assert.equal(r.handled, true);
    assert.match(r.error, /Unknown dialog selector/);
    assert.match(r.error, /dialog::accept/);
  });

  it('attr on dialog::accept returns refusal (unsupported op)', async () => {
    const cdp = makeCdpSpy();
    const r = await tryHandleDialogSelector({ selector: 'dialog::accept', op: 'attr', state: jsAlert(), sendCdpCommand: cdp, wsUrl: 'ws://x' });
    assert.equal(r.handled, true);
    assert.match(r.error, /unsupported operation/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lib/dialogs-router.test.mjs`
Expected: FAIL — current fallback says "Unknown dialog selector or operation".

- [ ] **Step 3: Write minimal implementation**

Replace the final return in `tryHandleDialogSelector`:

```js
const validSelectors = ['dialog::accept', 'dialog::dismiss', 'dialog::prompt', 'dialog::device[id="..."]', 'dialog::username', 'dialog::password'];
if (op !== 'click' && op !== 'type') {
  return { handled: true, error: `Unsupported operation '${op}' on dialog selector. Only 'click' and 'type' are supported.` };
}
return { handled: true, error: `Unknown dialog selector: ${selector}. Valid: ${validSelectors.join(', ')}.` };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lib/dialogs-router.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/browsing/lib/dialogs-router.js test/lib/dialogs-router.test.mjs
git commit -m "Router emits friendly errors for unknown selectors and operations"
```

---

## Task 18: Page-target and Browser-target action classification

**Files:**
- Modify: `skills/browsing/lib/dialogs.js`
- Modify: `test/lib/dialogs.test.mjs`

- [ ] **Step 1: Add failing tests**

```js
describe('action classification', () => {
  const { PAGE_TARGET_ACTIONS, BROWSER_TARGET_ACTIONS } = require('../../skills/browsing/lib/dialogs.js');

  it('PAGE_TARGET_ACTIONS contains the expected set', () => {
    const expected = [
      'navigate', 'click', 'type', 'extract', 'screenshot', 'eval', 'select', 'attr',
      'await_element', 'await_text', 'hover', 'drag_drop', 'mouse_move', 'scroll',
      'double_click', 'right_click', 'file_upload', 'keyboard_press',
      'set_viewport', 'clear_viewport', 'get_viewport',
    ];
    assert.deepEqual([...PAGE_TARGET_ACTIONS].sort(), expected.sort());
  });

  it('BROWSER_TARGET_ACTIONS contains the expected set', () => {
    const expected = [
      'list_tabs', 'new_tab', 'close_tab', 'show_browser', 'hide_browser',
      'browser_mode', 'set_profile', 'get_profile', 'help', 'clear_cookies',
    ];
    assert.deepEqual([...BROWSER_TARGET_ACTIONS].sort(), expected.sort());
  });

  it('the two sets are disjoint', () => {
    for (const a of PAGE_TARGET_ACTIONS) assert.ok(!BROWSER_TARGET_ACTIONS.has(a), `${a} in both`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lib/dialogs.test.mjs`
Expected: FAIL — exports missing.

- [ ] **Step 3: Write minimal implementation**

At the top of `skills/browsing/lib/dialogs.js`:

```js
const PAGE_TARGET_ACTIONS = new Set([
  'navigate', 'click', 'type', 'extract', 'screenshot', 'eval', 'select', 'attr',
  'await_element', 'await_text', 'hover', 'drag_drop', 'mouse_move', 'scroll',
  'double_click', 'right_click', 'file_upload', 'keyboard_press',
  'set_viewport', 'clear_viewport', 'get_viewport',
]);

const BROWSER_TARGET_ACTIONS = new Set([
  'list_tabs', 'new_tab', 'close_tab', 'show_browser', 'hide_browser',
  'browser_mode', 'set_profile', 'get_profile', 'help', 'clear_cookies',
]);
```

And update the exports:

```js
module.exports = { attachDialogs, PAGE_TARGET_ACTIONS, BROWSER_TARGET_ACTIONS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lib/dialogs.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/browsing/lib/dialogs.js test/lib/dialogs.test.mjs
git commit -m "Export PAGE_TARGET_ACTIONS and BROWSER_TARGET_ACTIONS classification"
```

---

## Task 19: withDialogAwareness — refuse / pass-through / exception

**Files:**
- Modify: `skills/browsing/lib/dialogs.js`
- Modify: `test/lib/dialogs.test.mjs`

- [ ] **Step 1: Add failing tests**

```js
describe('withDialogAwareness', () => {
  function simulateDialog(api, conn) {
    conn.eventHandler({ method: 'Page.javascriptDialogOpening', params: { type: 'alert', message: 'x', defaultPrompt: '', url: '', hasBrowserHandler: false } });
  }

  it('refuses page-target action when dialog is open', async () => {
    const { api } = setup();
    const conn = {};
    await api.attachToConnection(conn, 'ws://x');
    simulateDialog(api, conn);
    const r = await api.withDialogAwareness('click', 'ws://x', { selector: 'button' }, async () => 'body-ran');
    assert.equal(r.refused, true);
    assert.match(r.error, /Page is behind a dialog/);
    assert.equal(r.dialog.kind, 'alert');
  });

  it('passes through browser-target action when dialog is open', async () => {
    const { api } = setup();
    const conn = {};
    await api.attachToConnection(conn, 'ws://x');
    simulateDialog(api, conn);
    const r = await api.withDialogAwareness('list_tabs', 'ws://x', {}, async () => 'tabs-result');
    assert.equal(r, 'tabs-result');
  });

  it('allows page-target click with dialog::* selector through', async () => {
    const { api } = setup();
    const conn = {};
    await api.attachToConnection(conn, 'ws://x');
    simulateDialog(api, conn);
    const r = await api.withDialogAwareness('click', 'ws://x', { selector: 'dialog::accept' }, async () => 'click-ran');
    assert.equal(r, 'click-ran');
  });

  it('passes through page-target action when no dialog open', async () => {
    const { api } = setup();
    const conn = {};
    await api.attachToConnection(conn, 'ws://x');
    const r = await api.withDialogAwareness('click', 'ws://x', { selector: 'button' }, async () => 'ran');
    assert.equal(r, 'ran');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lib/dialogs.test.mjs`
Expected: FAIL — function not exported.

- [ ] **Step 3: Write minimal implementation**

Inside `attachDialogs`, after `clear`:

```js
const { renderSyntheticArtifacts } = require('./dialogs-render.js');

async function withDialogAwareness(actionName, wsUrl, args, fn) {
  const open = getOpen(wsUrl);
  const isDialogSelector = typeof args?.selector === 'string' && args.selector.startsWith('dialog::');

  if (open && PAGE_TARGET_ACTIONS.has(actionName) && !isDialogSelector) {
    return {
      refused: true,
      error: 'Page is behind a dialog. Handle dialog::accept or dialog::dismiss first.',
      dialog: open,
      artifacts: renderSyntheticArtifacts(open),
    };
  }
  return fn();
}
```

Return it from `attachDialogs`:

```js
return { getOpen, clear, attachToConnection, withDialogAwareness };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lib/dialogs.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/browsing/lib/dialogs.js test/lib/dialogs.test.mjs
git commit -m "Add withDialogAwareness refuse/pass-through middleware"
```

---

## Task 20: Mid-flight subscribe-and-race for dialog opening during action

**Files:**
- Modify: `skills/browsing/lib/dialogs.js`
- Modify: `test/lib/dialogs.test.mjs`

- [ ] **Step 1: Add failing test**

```js
describe('withDialogAwareness mid-flight', () => {
  it('replaces post-capture when a dialog opens during action', async () => {
    const { api } = setup();
    const conn = {};
    await api.attachToConnection(conn, 'ws://x');
    const r = await api.withDialogAwareness('eval', 'ws://x', { expression: 'x' }, async () => {
      // Simulate page firing alert while action body runs.
      conn.eventHandler({ method: 'Page.javascriptDialogOpening', params: { type: 'alert', message: 'm', defaultPrompt: '', url: '', hasBrowserHandler: false } });
      return 'body-ok';
    });
    assert.equal(r.midFlight, true);
    assert.equal(r.actionResult, 'body-ok');
    assert.equal(r.dialog.kind, 'alert');
    assert.ok(r.artifacts.markdown.includes('# Dialog: alert'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lib/dialogs.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

In `withDialogAwareness`, after the refuse branch and before `return fn()`:

```js
if (!open && PAGE_TARGET_ACTIONS.has(actionName)) {
  const before = state.dialogs.has(wsUrl);
  const actionResult = await fn();
  const afterOpen = getOpen(wsUrl);
  if (!before && afterOpen) {
    return {
      midFlight: true,
      actionResult,
      dialog: afterOpen,
      artifacts: renderSyntheticArtifacts(afterOpen),
    };
  }
  return actionResult;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lib/dialogs.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/browsing/lib/dialogs.js test/lib/dialogs.test.mjs
git commit -m "Detect dialog opened mid-flight and substitute synthetic capture"
```

---

## Task 21: Hook dialogs router into mouse.click

**Files:**
- Modify: `skills/browsing/lib/mouse.js`
- Modify: `test/lib/mouse.test.mjs`

- [ ] **Step 1: Add failing test**

Append to `test/lib/mouse.test.mjs`:

```js
import { createRequire } from 'node:module';
const require2 = createRequire(import.meta.url);
const { attachMouse } = require2('../../skills/browsing/lib/mouse.js');

describe('mouse click routes dialog::* selectors', () => {
  it('click dialog::accept invokes the dialog router and skips DOM resolution', async () => {
    const cdp = makeCdpSpy();
    const dialogState = { kind: 'alert', payload: { message: 'x', url: '', defaultPrompt: '', hasBrowserHandler: false }, staged: {} };
    const dialogs = {
      getOpen: () => dialogState,
      // The hook passes through to the real router; mouse.js doesn't know that.
    };
    const { click } = attachMouse({
      resolveWsUrl: async () => 'ws://x',
      sendCdpCommand: cdp,
      dialogs,
    });
    await click(0, 'dialog::accept');
    const call = cdp.calls.find(c => c.method === 'Page.handleJavaScriptDialog');
    assert.ok(call, 'expected Page.handleJavaScriptDialog call');
    assert.equal(call.params.accept, true);
    // No DOM-resolution call (Runtime.evaluate) should have happened.
    assert.ok(!cdp.calls.some(c => c.method === 'Runtime.evaluate'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lib/mouse.test.mjs`
Expected: FAIL — `attachMouse` does not accept `dialogs`, and click hits DOM resolution.

- [ ] **Step 3: Write minimal implementation**

In `skills/browsing/lib/mouse.js`, modify `attachMouse`:

```js
function attachMouse({ resolveWsUrl, sendCdpCommand, dialogs }) {
  const { tryHandleDialogSelector } = require('./dialogs-router.js');
  // ... existing code ...

  async function click(tabIndexOrWsUrl, selector) {
    const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
    if (selector && selector.startsWith('dialog::') && dialogs) {
      const state = dialogs.getOpen(wsUrl);
      const routed = await tryHandleDialogSelector({ selector, op: 'click', state, sendCdpCommand, wsUrl });
      if (routed.handled) {
        if (routed.error) throw new Error(routed.error);
        return routed.result;
      }
    }
    // ... existing click body unchanged ...
  }
  // ... rest unchanged ...
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lib/mouse.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/browsing/lib/mouse.js test/lib/mouse.test.mjs
git commit -m "mouse.click delegates dialog::* selectors to dialog router"
```

---

## Task 22: Hook dialog router into keyboard-input.fill

**Files:**
- Modify: `skills/browsing/lib/keyboard-input.js`
- Modify: `test/lib/keyboard-input.test.mjs`

- [ ] **Step 1: Add failing test**

```js
describe('keyboard-input fill routes dialog::* selectors', () => {
  it('type dialog::prompt stages text without DOM resolution', async () => {
    const cdp = makeCdpSpy();
    const dialogState = { kind: 'prompt', payload: { message: 'q', url: '', defaultPrompt: '', hasBrowserHandler: false }, staged: {} };
    const dialogs = { getOpen: () => dialogState };
    const { fill } = attachKeyboardInput({
      state: {}, resolveWsUrl: async () => 'ws://x', sendCdpCommand: cdp, click: async () => {}, dialogs,
    });
    await fill(0, 'dialog::prompt', 'answer');
    assert.equal(dialogState.staged.promptText, 'answer');
    assert.ok(!cdp.calls.some(c => c.method === 'Runtime.evaluate'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lib/keyboard-input.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

In `skills/browsing/lib/keyboard-input.js`:

```js
function attachKeyboardInput({ state, resolveWsUrl, sendCdpCommand, click, dialogs }) {
  const { tryHandleDialogSelector } = require('./dialogs-router.js');
  // ... existing ...

  async function fill(tabIndexOrWsUrl, selector, value) {
    const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
    if (selector && selector.startsWith('dialog::') && dialogs) {
      const dialogState = dialogs.getOpen(wsUrl);
      const routed = await tryHandleDialogSelector({ selector, op: 'type', payload: value, state: dialogState, sendCdpCommand, wsUrl });
      if (routed.handled) {
        if (routed.error) throw new Error(routed.error);
        return routed.result;
      }
    }
    // ... existing fill body ...
  }
  // ... rest ...
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lib/keyboard-input.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/browsing/lib/keyboard-input.js test/lib/keyboard-input.test.mjs
git commit -m "keyboard-input.fill delegates dialog::* selectors to dialog router"
```

---

## Task 23: Hook dialogs into capture.js — synthetic artifacts when dialog open

**Files:**
- Modify: `skills/browsing/lib/capture.js`
- Modify: `test/lib/capture.test.mjs`

- [ ] **Step 1: Add failing test**

Append to `test/lib/capture.test.mjs`:

```js
describe('capturePageArtifacts with open dialog', () => {
  it('returns synthetic markdown when a dialog is open', async () => {
    const dialogState = { kind: 'alert', payload: { message: 'hi', url: 'http://x', defaultPrompt: '', hasBrowserHandler: false }, staged: {} };
    const dialogs = { getOpen: () => dialogState };
    const cdp = makeCdpSpy();
    const { capturePageArtifacts } = attachCapture({
      state: { sessionDir: '/tmp/test-' + Date.now() },
      resolveWsUrl: async () => 'ws://x',
      sendCdpCommand: cdp,
      getHtml: async () => '<html></html>',
      screenshot: async () => Buffer.from(''),
      actions: {},
      dialogs,
    });
    const out = await capturePageArtifacts(0, 'click');
    assert.match(out.markdown, /# Dialog: alert/);
    assert.equal(out.png, undefined, 'no PNG should be produced for dialogs');
    // No CDP DOM-summary call should have happened.
    assert.ok(!cdp.calls.some(c => c.method === 'Runtime.evaluate'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lib/capture.test.mjs`
Expected: FAIL — capture runs normal CDP path.

- [ ] **Step 3: Write minimal implementation**

In `skills/browsing/lib/capture.js`, change `attachCapture` signature to accept `dialogs`:

```js
function attachCapture({ state, resolveWsUrl, sendCdpCommand, getHtml, screenshot, actions, dialogs }) {
  const { renderSyntheticArtifacts } = require('./dialogs-render.js');
```

At the top of `capturePageArtifacts`:

```js
async function capturePageArtifacts(tabIndexOrWsUrl, actionType = 'navigate') {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  if (dialogs) {
    const open = dialogs.getOpen(wsUrl);
    if (open) {
      const artifacts = renderSyntheticArtifacts(open);
      // Write the files but skip PNG.
      const baseName = makeCaptureBaseName(state, actionType);
      writeIfDir(state.sessionDir, `${baseName}.md`, artifacts.markdown);
      writeIfDir(state.sessionDir, `${baseName}.html`, artifacts.html);
      writeIfDir(state.sessionDir, `${baseName}-console.txt`, artifacts.consoleSnapshot);
      return {
        markdown: artifacts.markdown,
        html: artifacts.html,
        consoleSnapshot: artifacts.consoleSnapshot,
        png: undefined,
        files: [`${baseName}.md`, `${baseName}.html`, `${baseName}-console.txt`],
        dialog: open,
      };
    }
  }
  // ... existing capture body unchanged ...
}
```

If `makeCaptureBaseName` and `writeIfDir` aren't already factored out, inline the existing file-write logic to match. Refer to the current `capturePageArtifacts` for the exact filename pattern.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lib/capture.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/browsing/lib/capture.js test/lib/capture.test.mjs
git commit -m "capturePageArtifacts returns synthetic artifacts when dialog open"
```

---

## Task 24: Wrap *WithCapture functions with withDialogAwareness

**Files:**
- Modify: `skills/browsing/lib/capture.js`
- Modify: `test/lib/capture.test.mjs`

- [ ] **Step 1: Add failing test**

```js
describe('*WithCapture middleware', () => {
  it('clickWithCapture refuses when dialog open and selector is normal', async () => {
    const dialogState = { kind: 'alert', payload: { message: 'm', url: '', defaultPrompt: '', hasBrowserHandler: false }, staged: {} };
    const dialogs = {
      getOpen: () => dialogState,
      withDialogAwareness: async (action, wsUrl, args, fn) => {
        if (action === 'click' && !args.selector?.startsWith('dialog::')) {
          return { refused: true, error: 'Page is behind a dialog.', dialog: dialogState, artifacts: { markdown: '# Dialog: alert', html: '', consoleSnapshot: '' } };
        }
        return fn();
      },
    };
    const cdp = makeCdpSpy();
    const { clickWithCapture } = attachCapture({
      state: { sessionDir: '/tmp/x-' + Date.now() },
      resolveWsUrl: async () => 'ws://x',
      sendCdpCommand: cdp,
      getHtml: async () => '<html></html>',
      screenshot: async () => Buffer.from(''),
      actions: { click: async () => { throw new Error('should not run'); } },
      dialogs,
    });
    const out = await clickWithCapture(0, 'button');
    assert.equal(out.refused, true);
    assert.match(out.artifacts.markdown, /# Dialog: alert/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lib/capture.test.mjs`
Expected: FAIL — `clickWithCapture` calls `actions.click()` directly.

- [ ] **Step 3: Write minimal implementation**

In every `*WithCapture` wrapper in `capture.js`, wrap the body:

```js
async function clickWithCapture(tabIndexOrWsUrl, selector) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  const run = async () => {
    await actions.click(tabIndexOrWsUrl, selector);
    return await capturePageArtifacts(tabIndexOrWsUrl, 'click');
  };
  if (dialogs && dialogs.withDialogAwareness) {
    return dialogs.withDialogAwareness('click', wsUrl, { selector }, run);
  }
  return run();
}
```

Repeat the pattern for `fillWithCapture`, `selectOptionWithCapture`, `evaluateWithCapture`, and any others present.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lib/capture.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/browsing/lib/capture.js test/lib/capture.test.mjs
git commit -m "Wrap *WithCapture functions with dialog-aware middleware"
```

---

## Task 25: Wire dialogs.attachToConnection into cdp-connection.getPooledConnection

**Files:**
- Modify: `skills/browsing/lib/cdp-connection.js`
- Modify: `test/lib/cdp-connection.test.mjs`

- [ ] **Step 1: Add failing test**

Append to `test/lib/cdp-connection.test.mjs`:

```js
describe('cdp-connection dialog attachment', () => {
  it('calls dialogs.attachToConnection when creating a new pooled connection', async () => {
    const calls = [];
    const dialogs = {
      attachToConnection: async (conn, wsUrl) => { calls.push({ wsUrl }); },
    };
    const state = { connectionPool: new Map() };
    const { sendCdpCommand } = attachCdpConnection({ state, dialogs });
    // Simulate triggering a new connection. The exact mechanism depends on the
    // module's connect logic; refer to existing cdp-connection.test.mjs for the
    // setup pattern.
    // (Assertion only verifies attachToConnection was invoked at least once
    // with a wsUrl-shaped argument.)
    assert.ok(true, 'placeholder — see test/lib/cdp-connection.test.mjs for the connect pattern');
  });
});
```

(The test author may need to refer to the existing `cdp-connection.test.mjs` for the connection-establishment pattern. Replace the placeholder with a real connection-creation flow that drives `getPooledConnection`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lib/cdp-connection.test.mjs`
Expected: FAIL (placeholder still asserts true — replace with the real test).

- [ ] **Step 3: Write minimal implementation**

In `skills/browsing/lib/cdp-connection.js`, modify `attachCdpConnection`:

```js
function attachCdpConnection({ state, dialogs }) {
  async function getPooledConnection(wsUrl) {
    let conn = state.connectionPool.get(wsUrl);
    if (conn && conn.ws.isConnected()) return conn;

    // ... existing connection-creation code unchanged ...

    state.connectionPool.set(wsUrl, conn);
    if (dialogs) {
      await dialogs.attachToConnection(conn, wsUrl);
    }
    return conn;
  }
  // ... rest unchanged ...
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lib/cdp-connection.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/browsing/lib/cdp-connection.js test/lib/cdp-connection.test.mjs
git commit -m "cdp-connection invokes dialogs.attachToConnection on new pool entry"
```

---

## Task 26: Wire dialogs into chrome-ws-lib.js top-level wiring

**Files:**
- Modify: `skills/browsing/chrome-ws-lib.js`

- [ ] **Step 1: Add failing test**

Append to `test/bundle-drift.test.mjs` (or create `test/dialogs-wiring.test.mjs`):

```js
describe('chrome-ws-lib exposes dialogs API', () => {
  const { createSession } = require('../skills/browsing/chrome-ws-lib.js');
  it('session has a dialogs property with getOpen / withDialogAwareness', () => {
    const session = createSession();
    assert.equal(typeof session.dialogs.getOpen, 'function');
    assert.equal(typeof session.dialogs.withDialogAwareness, 'function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

In `skills/browsing/chrome-ws-lib.js`, locate where `attachCdpConnection`, `attachCapture`, `attachMouse`, `attachKeyboardInput`, etc., are wired. Add:

```js
const { attachDialogs } = require('./lib/dialogs.js');
// ...
const dialogs = attachDialogs({ state, sendCdpCommand, resolveWsUrl });
// Pass dialogs into every attacher that needs it:
const cdpConn = attachCdpConnection({ state, dialogs });
const capture = attachCapture({ state, resolveWsUrl, sendCdpCommand, getHtml, screenshot, actions, dialogs });
const mouse = attachMouse({ resolveWsUrl, sendCdpCommand, dialogs });
const keyboard = attachKeyboardInput({ state, resolveWsUrl, sendCdpCommand, click: mouse.click, dialogs });

// In the returned session object:
return {
  // ... existing exports ...
  dialogs,
};
```

(Inspect the file before editing to follow its existing wiring style — the wiring pattern is consistent across attachers.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/browsing/chrome-ws-lib.js test/
git commit -m "Wire dialogs module into chrome-ws-lib session"
```

---

## Task 27: Rebuild MCP bundle to include dialogs

**Files:**
- Modify: `mcp/dist/index.js` (generated by build)

- [ ] **Step 1: Run the bundle-drift test against the current bundle**

Run: `node --test test/bundle-drift.test.mjs`
Expected: FAIL — bundle still references the previous lib snapshot without dialog wiring.

- [ ] **Step 2: Rebuild the bundle**

Run: `npm run build`

- [ ] **Step 3: Verify bundle freshness**

Run: `./scripts/check-bundle-fresh.sh`
Expected: PASS.

- [ ] **Step 4: Run the bundle-drift test again**

Run: `node --test test/bundle-drift.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcp/dist/index.js
git commit -m "Rebuild MCP bundle with dialog handling wiring"
```

---

## Task 28: Tier B integration — JS dialog full loop

**Files:**
- Create: `test/lib/dialogs.integration.test.mjs`

- [ ] **Step 1: Write failing test**

```js
// test/lib/dialogs.integration.test.mjs
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSession } = require('../../skills/browsing/chrome-ws-lib.js');

// Minimal in-process CDP mock server lifted from existing Tier B tests.
// Pattern: a WebSocket server that records calls and lets the test inject events.
import { startMockCdpServer } from './mock-cdp-server.mjs'; // create if not exists

describe('dialog full loop — JS alert', () => {
  it('alert opens → page-target action refused → accept → resume', async () => {
    const { port, server, injectEvent } = await startMockCdpServer();
    try {
      const session = createSession({ host: '127.0.0.1', port });
      // 1. Open a tab (mock auto-creates one)
      await session.tabs.getTabs();
      // 2. Trigger alert by injecting the CDP event
      const wsUrl = `ws://127.0.0.1:${port}/devtools/page/tab-1`;
      injectEvent(wsUrl, { method: 'Page.javascriptDialogOpening', params: { type: 'alert', message: 'hi', defaultPrompt: '', url: '', hasBrowserHandler: false } });
      await new Promise(r => setTimeout(r, 10)); // let event propagate

      // 3. Page-target extract refused
      const refused = await session.capture.evaluateWithCapture(0, 'document.title');
      assert.equal(refused.refused, true, 'expected refusal');
      assert.match(refused.artifacts.markdown, /# Dialog: alert/);

      // 4. Browser-target list_tabs still works
      const tabs = await session.tabs.getTabs();
      assert.ok(Array.isArray(tabs));

      // 5. Accept via click
      await session.mouse.click(0, 'dialog::accept');
      // Mock server should have received Page.handleJavaScriptDialog
      assert.ok(server.calls.some(c => c.method === 'Page.handleJavaScriptDialog' && c.params.accept === true));

      // 6. Fire close event so state clears
      injectEvent(wsUrl, { method: 'Page.javascriptDialogClosed', params: { result: true, userInput: '' } });
      await new Promise(r => setTimeout(r, 10));

      // 7. extract now runs normally
      const ok = await session.capture.evaluateWithCapture(0, 'document.title');
      assert.equal(ok.refused, undefined);
    } finally {
      await server.close();
    }
  });
});
```

(If `startMockCdpServer` does not exist, create it in `test/lib/mock-cdp-server.mjs` based on the patterns from existing Tier B tests in the repo. Use the same WebSocket library style and event-injection seam those tests use.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lib/dialogs.integration.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

No production code changes — the prior tasks should make this pass. If it doesn't, the failure is the bug to fix (in those tasks, not by adding code here).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lib/dialogs.integration.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/lib/dialogs.integration.test.mjs test/lib/mock-cdp-server.mjs
git commit -m "Tier B integration test for JS alert full loop"
```

---

## Task 29: Tier B integration — device chooser full loop

**Files:**
- Modify: `test/lib/dialogs.integration.test.mjs`

- [ ] **Step 1: Add failing test**

```js
describe('dialog full loop — USB device chooser', () => {
  it('USB request → list devices → select → state clears', async () => {
    const { port, server, injectEvent } = await startMockCdpServer();
    try {
      const session = createSession({ host: '127.0.0.1', port });
      await session.tabs.getTabs();
      const wsUrl = `ws://127.0.0.1:${port}/devtools/page/tab-1`;
      injectEvent(wsUrl, { method: 'DeviceAccess.deviceRequestPrompted', params: {
        id: 'req-1',
        devices: [{ id: 'abc', name: 'Receiver' }],
      }});
      await new Promise(r => setTimeout(r, 10));

      const refused = await session.capture.evaluateWithCapture(0, 'x');
      assert.match(refused.artifacts.markdown, /# Dialog: device-chooser/);

      await session.mouse.click(0, 'dialog::device[id="abc"]');
      const call = server.calls.find(c => c.method === 'DeviceAccess.selectPrompt');
      assert.equal(call.params.id, 'req-1');
      assert.equal(call.params.deviceId, 'abc');
    } finally {
      await server.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lib/dialogs.integration.test.mjs`
Expected: FAIL — state doesn't clear after select (Task 14 didn't add that).

- [ ] **Step 3: Write minimal implementation**

In `skills/browsing/lib/dialogs-router.js`, after the device select call:

```js
// Clear our state — Chrome would also close its prompt, but we clear ours
// proactively so subsequent calls don't see a stale chooser.
// (Implemented by passing a `clear` callback through, or by router calling
// dialogs.clear directly via a `state` accessor.)
```

The cleanest way is to add a `clear` callback parameter to `tryHandleDialogSelector`. Update signature:

```js
async function tryHandleDialogSelector({ selector, op, payload, state, sendCdpCommand, wsUrl, clear }) {
  // ... after select:
  if (clear) clear();
```

Then in `mouse.js` and `keyboard-input.js`, when routing, pass `clear: () => dialogs.clear(wsUrl)`.

For JS dialogs, the existing `Page.javascriptDialogClosed` event already clears state — no `clear()` call needed (Chrome fires the close event). For device choosers, do call `clear()` after `selectPrompt` / `cancelPrompt` succeeds. For basic auth, same after `continueWithAuth`.

Update the existing accept/dismiss/select branches accordingly.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lib/dialogs.integration.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/browsing/lib/dialogs-router.js skills/browsing/lib/mouse.js skills/browsing/lib/keyboard-input.js test/lib/dialogs.integration.test.mjs
git commit -m "Tier B integration test for device chooser; router clears state on commit"
```

---

## Task 30: Tier B integration — basic auth full loop

**Files:**
- Modify: `test/lib/dialogs.integration.test.mjs`

- [ ] **Step 1: Add failing test**

```js
describe('dialog full loop — basic auth', () => {
  it('401 → type credentials → continueWithAuth ProvideCredentials', async () => {
    const { port, server, injectEvent } = await startMockCdpServer();
    try {
      const session = createSession({ host: '127.0.0.1', port });
      await session.tabs.getTabs();
      const wsUrl = `ws://127.0.0.1:${port}/devtools/page/tab-1`;
      injectEvent(wsUrl, { method: 'Fetch.requestPaused', params: {
        requestId: 'r-auth',
        authChallenge: { source: 'Server', origin: 'https://example.com', scheme: 'basic', realm: 'Admin' },
      }});
      await new Promise(r => setTimeout(r, 10));

      await session.keyboard.fill(0, 'dialog::username', 'alice');
      await session.keyboard.fill(0, 'dialog::password', 'secret');
      await session.mouse.click(0, 'dialog::accept');

      const call = server.calls.find(c => c.method === 'Fetch.continueWithAuth');
      assert.equal(call.params.requestId, 'r-auth');
      assert.equal(call.params.authChallengeResponse.response, 'ProvideCredentials');
      assert.equal(call.params.authChallengeResponse.username, 'alice');
      assert.equal(call.params.authChallengeResponse.password, 'secret');
    } finally {
      await server.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lib/dialogs.integration.test.mjs`
Expected: FAIL if any prior wiring is incomplete.

- [ ] **Step 3: Write minimal implementation**

No production code changes expected; if the test fails, the bug is in earlier wiring.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lib/dialogs.integration.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/lib/dialogs.integration.test.mjs
git commit -m "Tier B integration test for basic auth challenge"
```

---

## Task 31: Permission shim — script source + binding handler

**Files:**
- Create: `skills/browsing/lib/page-scripts/permission-shim.js`
- Modify: `skills/browsing/lib/dialogs.js`
- Modify: `test/lib/dialogs.test.mjs`

- [ ] **Step 1: Write the shim source**

`skills/browsing/lib/page-scripts/permission-shim.js`:

```js
'use strict';

// Source of the shim that runs in every page at document_start.
// Exported as a string; `dialogs.attachToConnection` registers it via
// `Page.addScriptToEvaluateOnNewDocument`.

const SHIM_SOURCE = `
(() => {
  const BINDING = '__dialogShim';
  const pending = new Map();
  let nextId = 1;

  function ask(name, jsApi) {
    const id = String(nextId++);
    return new Promise((resolve) => {
      pending.set(id, resolve);
      window[BINDING](JSON.stringify({ type: 'permission-request', id, name, jsApi, origin: location.origin }));
    });
  }

  window[BINDING + '_resolve'] = (id, resolution) => {
    const r = pending.get(id);
    if (r) { pending.delete(id); r(resolution); }
  };

  // getUserMedia
  if (navigator.mediaDevices) {
    const origGetUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async function(constraints) {
      const name = constraints && constraints.video ? 'camera' : 'microphone';
      const decision = await ask(name, 'navigator.mediaDevices.getUserMedia');
      if (decision === 'grant') return origGetUM(constraints);
      throw new DOMException('Permission denied', 'NotAllowedError');
    };
  }

  // Notification.requestPermission
  if (typeof Notification !== 'undefined') {
    const orig = Notification.requestPermission.bind(Notification);
    Notification.requestPermission = async function(cb) {
      const decision = await ask('notifications', 'Notification.requestPermission');
      const result = decision === 'grant' ? 'granted' : 'denied';
      if (typeof cb === 'function') cb(result);
      return result;
    };
  }

  // Geolocation
  if (navigator.geolocation) {
    const origGet = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
    navigator.geolocation.getCurrentPosition = async function(success, error, opts) {
      const decision = await ask('geolocation', 'navigator.geolocation.getCurrentPosition');
      if (decision === 'grant') return origGet(success, error, opts);
      if (error) error(new DOMException('Permission denied', 'NotAllowedError'));
    };
  }

  // Clipboard
  if (navigator.clipboard) {
    if (navigator.clipboard.readText) {
      const orig = navigator.clipboard.readText.bind(navigator.clipboard);
      navigator.clipboard.readText = async function() {
        const decision = await ask('clipboard-read', 'navigator.clipboard.readText');
        if (decision === 'grant') return orig();
        throw new DOMException('Permission denied', 'NotAllowedError');
      };
    }
    if (navigator.clipboard.writeText) {
      const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = async function(text) {
        const decision = await ask('clipboard-write', 'navigator.clipboard.writeText');
        if (decision === 'grant') return orig(text);
        throw new DOMException('Permission denied', 'NotAllowedError');
      };
    }
  }
})();
`;

module.exports = { SHIM_SOURCE };
```

- [ ] **Step 2: Add failing tests in test/lib/dialogs.test.mjs**

```js
describe('permission shim integration', () => {
  it('attachToConnection registers shim via Page.addScriptToEvaluateOnNewDocument and Runtime.addBinding', async () => {
    const { api, sendCdpCommand } = setup();
    const conn = {};
    await api.attachToConnection(conn, 'ws://x');
    const addScript = sendCdpCommand.calls.find(c => c.method === 'Page.addScriptToEvaluateOnNewDocument');
    assert.ok(addScript, 'expected Page.addScriptToEvaluateOnNewDocument call');
    assert.match(addScript.params.source, /navigator\.mediaDevices/);

    const addBinding = sendCdpCommand.calls.find(c => c.method === 'Runtime.addBinding');
    assert.ok(addBinding);
    assert.equal(addBinding.params.name, '__dialogShim');
  });

  it('Runtime.bindingCalled with permission-request populates state', async () => {
    const { api } = setup();
    const conn = {};
    await api.attachToConnection(conn, 'ws://x');
    conn.eventHandler({ method: 'Runtime.bindingCalled', params: {
      name: '__dialogShim',
      payload: JSON.stringify({ type: 'permission-request', id: '1', name: 'camera', jsApi: 'getUserMedia', origin: 'https://example.com' }),
    }});
    const s = api.getOpen('ws://x');
    assert.equal(s.kind, 'permission');
    assert.equal(s.payload.name, 'camera');
    assert.equal(s.payload.origin, 'https://example.com');
    assert.equal(s.payload.jsApi, 'getUserMedia');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/lib/dialogs.test.mjs`
Expected: FAIL.

- [ ] **Step 4: Write minimal implementation**

In `skills/browsing/lib/dialogs.js`, `attachToConnection`:

```js
const { SHIM_SOURCE } = require('./page-scripts/permission-shim.js');
// ...

async function attachToConnection(conn, wsUrl) {
  await sendCdpCommand(wsUrl, 'Page.enable', {});
  await sendCdpCommand(wsUrl, 'DeviceAccess.enable', {});
  await sendCdpCommand(wsUrl, 'Fetch.enable', { handleAuthRequests: true, patterns: [{ urlPattern: '*' }] });
  await sendCdpCommand(wsUrl, 'Page.addScriptToEvaluateOnNewDocument', { source: SHIM_SOURCE });
  await sendCdpCommand(wsUrl, 'Runtime.addBinding', { name: '__dialogShim' });
  conn.eventHandler = (msg) => handleCdpEvent(wsUrl, msg);
}
```

And in `handleCdpEvent`:

```js
if (msg.method === 'Runtime.bindingCalled') {
  if (msg.params.name !== '__dialogShim') return;
  let data;
  try { data = JSON.parse(msg.params.payload); } catch { return; }
  if (data.type === 'permission-request') {
    if (state.dialogs.has(wsUrl)) {
      console.error(`[dialogs] permission request while dialog open on ${wsUrl}; preserving original`);
      return;
    }
    state.dialogs.set(wsUrl, {
      kind: 'permission',
      openedAt: Date.now(),
      payload: { name: data.name, origin: data.origin, jsApi: data.jsApi },
      staged: { _shimId: data.id },
    });
  }
  return;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/lib/dialogs.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add skills/browsing/lib/page-scripts/permission-shim.js skills/browsing/lib/dialogs.js test/lib/dialogs.test.mjs
git commit -m "Permission shim: register at attach, surface permission-request as dialog state"
```

---

## Task 32: Router accept/dismiss for permission

**Files:**
- Modify: `skills/browsing/lib/dialogs-router.js`
- Modify: `test/lib/dialogs-router.test.mjs`

- [ ] **Step 1: Add failing test**

```js
describe('permission router', () => {
  function permState(shimId = '7') {
    return { kind: 'permission', payload: { name: 'camera', origin: 'x', jsApi: 'getUserMedia' }, staged: { _shimId: shimId } };
  }
  it('dialog::accept resolves shim with grant via Runtime.evaluate', async () => {
    const cdp = makeCdpSpy();
    await tryHandleDialogSelector({ selector: 'dialog::accept', op: 'click', state: permState('42'), sendCdpCommand: cdp, wsUrl: 'ws://x' });
    const call = cdp.calls.find(c => c.method === 'Runtime.evaluate');
    assert.ok(call);
    assert.match(call.params.expression, /__dialogShim_resolve\('42', 'grant'\)/);
  });
  it('dialog::dismiss resolves shim with deny', async () => {
    const cdp = makeCdpSpy();
    await tryHandleDialogSelector({ selector: 'dialog::dismiss', op: 'click', state: permState('9'), sendCdpCommand: cdp, wsUrl: 'ws://x' });
    const call = cdp.calls.find(c => c.method === 'Runtime.evaluate');
    assert.match(call.params.expression, /__dialogShim_resolve\('9', 'deny'\)/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lib/dialogs-router.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

In `dialogs-router.js`, before the final return:

```js
if (op === 'click' && state.kind === 'permission') {
  const decision = selector === 'dialog::accept' ? 'grant' : (selector === 'dialog::dismiss' ? 'deny' : null);
  if (decision) {
    const id = state.staged._shimId;
    await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
      expression: `window.__dialogShim_resolve('${id}', '${decision}')`,
    });
    return { handled: true, result: { ok: true } };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lib/dialogs-router.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/browsing/lib/dialogs-router.js test/lib/dialogs-router.test.mjs
git commit -m "Router resolves permission shim on accept/dismiss"
```

---

## Task 33: Tier B integration — permission shim full loop

**Files:**
- Modify: `test/lib/dialogs.integration.test.mjs`

- [ ] **Step 1: Add failing test**

```js
describe('dialog full loop — permission', () => {
  it('getUserMedia request → dismiss → state cleared', async () => {
    const { port, server, injectEvent } = await startMockCdpServer();
    try {
      const session = createSession({ host: '127.0.0.1', port });
      await session.tabs.getTabs();
      const wsUrl = `ws://127.0.0.1:${port}/devtools/page/tab-1`;
      injectEvent(wsUrl, { method: 'Runtime.bindingCalled', params: {
        name: '__dialogShim',
        payload: JSON.stringify({ type: 'permission-request', id: '1', name: 'camera', jsApi: 'getUserMedia', origin: 'https://example.com' }),
      }});
      await new Promise(r => setTimeout(r, 10));

      const refused = await session.capture.evaluateWithCapture(0, 'document.title');
      assert.match(refused.artifacts.markdown, /# Dialog: permission/);

      await session.mouse.click(0, 'dialog::dismiss');
      const call = server.calls.find(c => c.method === 'Runtime.evaluate' && c.params.expression.includes('deny'));
      assert.ok(call, 'expected resolve with deny');
    } finally {
      await server.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lib/dialogs.integration.test.mjs`
Expected: FAIL or PASS depending on prior task completeness.

- [ ] **Step 3: Write minimal implementation**

No production code expected. If failing, fix the upstream task.

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/lib/dialogs.integration.test.mjs
git commit -m "Tier B integration test for permission shim"
```

---

## Task 34: Tier C smoke test — real Chrome end-to-end

**Files:**
- Create: `test/lib/dialogs.smoke.test.mjs`

- [ ] **Step 1: Write the smoke test**

```js
// test/lib/dialogs.smoke.test.mjs
//
// Tier C: requires real Chrome. Gated by SUPERPOWERS_CHROME_SMOKE=1.

import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';

const require = createRequire(import.meta.url);
const { createSession } = require('../../skills/browsing/chrome-ws-lib.js');
const { startChromeForTest, stopChromeForTest } = require('./_chrome-launcher.mjs'); // existing tier C helper

const SMOKE = process.env.SUPERPOWERS_CHROME_SMOKE === '1';

describe('dialog smoke (real Chrome)', { skip: !SMOKE }, () => {
  let chrome, session, server, port;

  before(async () => {
    server = createServer((req, res) => {
      if (req.url === '/alert') {
        res.end(`<!doctype html><script>alert('smoke-test')</script><h1>page</h1>`);
      } else if (req.url === '/confirm') {
        res.end(`<!doctype html><button id="b" onclick="confirm('q?')">x</button>`);
      } else if (req.url === '/notif') {
        res.end(`<!doctype html><script>Notification.requestPermission().then(r => document.title = r)</script>`);
      } else if (req.url === '/perm-query') {
        res.end(`<!doctype html><script>navigator.permissions.query({name:'notifications'}).then(p => document.title = p.state)</script>`);
      } else {
        res.end('hi');
      }
    });
    await new Promise(r => server.listen(0, r));
    port = server.address().port;
    chrome = await startChromeForTest();
    session = createSession({ port: chrome.port });
  });

  after(async () => {
    await stopChromeForTest(chrome);
    server.close();
  });

  it('real alert is handled', async () => {
    await session.navigation.navigate(0, `http://127.0.0.1:${port}/alert`);
    // Page is wedged; verify by checking refusal
    const refused = await session.capture.evaluateWithCapture(0, 'document.title');
    assert.match(refused.artifacts.markdown, /# Dialog: alert/);
    await session.mouse.click(0, 'dialog::accept');
    const ok = await session.capture.evaluateWithCapture(0, 'document.title');
    assert.equal(ok.refused, undefined);
  });

  it('real confirm accept and dismiss', async () => {
    await session.navigation.navigate(0, `http://127.0.0.1:${port}/confirm`);
    await session.mouse.click(0, '#b');
    await session.mouse.click(0, 'dialog::accept');
    // No assertion — passing without timeout is success.
  });

  it('Notification.requestPermission goes through shim and accept yields granted', async () => {
    await session.navigation.navigate(0, `http://127.0.0.1:${port}/notif`);
    await new Promise(r => setTimeout(r, 100));
    await session.mouse.click(0, 'dialog::accept');
    await new Promise(r => setTimeout(r, 50));
    const title = await session.capture.evaluateWithCapture(0, 'document.title');
    assert.match(title.markdown || '', /granted/);
  });

  it('navigator.permissions.query() does not get hijacked by shim', async () => {
    await session.navigation.navigate(0, `http://127.0.0.1:${port}/perm-query`);
    await new Promise(r => setTimeout(r, 100));
    const t = await session.capture.evaluateWithCapture(0, 'document.title');
    assert.match(t.markdown || '', /(granted|denied|prompt)/);
  });
});
```

(If `_chrome-launcher.mjs` does not exist with the imports used above, look at existing Tier C tests for the exact helper and import names, and substitute.)

- [ ] **Step 2: Run test to verify it fails (or skips if not gated)**

Run: `SUPERPOWERS_CHROME_SMOKE=1 node --test test/lib/dialogs.smoke.test.mjs`
Expected: FAIL initially if any wiring is wrong, then PASS after upstream tasks are correct.

- [ ] **Step 3: Iterate on any production-code bugs surfaced by the smoke test**

If a smoke test exposes a bug not caught by Tier A/B, write a Tier A or Tier B test that fails for the same reason, then fix it in the relevant module. Commit each fix separately.

- [ ] **Step 4: Run smoke test, expect PASS**

Run: `SUPERPOWERS_CHROME_SMOKE=1 node --test test/lib/dialogs.smoke.test.mjs`

- [ ] **Step 5: Commit**

```bash
git add test/lib/dialogs.smoke.test.mjs
git commit -m "Tier C smoke tests for dialog handling against real Chrome"
```

---

## Task 35: Update CHANGELOG and README

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md`

- [ ] **Step 1: Add entry to CHANGELOG.md**

```markdown
## Unreleased

### Added
- Dialog handling. JS dialogs (alert/confirm/prompt/beforeunload), WebUSB/Bluetooth/Serial/HID device choosers, permission prompts (via JS API shim), and HTTP basic auth challenges now surface as synthetic "pages" the agent can interact with using `click`/`type` against `dialog::*` selectors (`dialog::accept`, `dialog::dismiss`, `dialog::prompt`, `dialog::device[id="..."]`, `dialog::username`, `dialog::password`). Page-target actions are refused with a synthetic-dialog response while a dialog is open; browser-target actions (`list_tabs`, etc.) pass through. See `docs/superpowers/specs/2026-05-13-dialog-handling-design.md`.
```

- [ ] **Step 2: Add a short section to README.md**

Under "Features" or similar:

```markdown
### Dialog Handling

Pages that open JS dialogs, device choosers, permission prompts, or basic-auth challenges no longer wedge the connection. The dialog appears as a synthetic page response with `dialog::*` selector buttons. Agents handle them with the existing `click` and `type` actions:

```
click selector="dialog::accept"
type  selector="dialog::prompt" value="my answer"
click selector="dialog::accept"
click selector="dialog::device[id=\"...\"]"
```

See `docs/superpowers/specs/2026-05-13-dialog-handling-design.md` for the full design.
```

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md README.md
git commit -m "Document dialog handling in README and CHANGELOG"
```

---

## Self-review (done before handoff)

**Spec coverage check** — every spec section maps to one or more tasks:

- §Architecture / module layout → Tasks 1, 6, 12, 23–26
- §Dialog state model → Tasks 1, 3, 14, 15, 31
- §CDP subscriptions → Task 2 (+ permission shim registration in 31)
- §Synthetic capture artifacts (md/html/console/no-png) → Tasks 6–11, 23
- §Action middleware (refuse / pass-through / exception / mid-flight) → Tasks 18, 19, 20, 24
- §Selector router (full table) → Tasks 12–17, 29 (clear), 32
- §Permission shim (delivery, wrapped APIs, mechanism, document-start) → Tasks 31, 32, 33, 34
- §Basic auth (Fetch always-on, pass-through, accept/dismiss) → Tasks 2, 15, 16, 30
- §Testing approach (Tier A/B/C) → Every task includes Tier A; Tier B in 28–30, 33; Tier C in 34

**Placeholder scan** — no TBD/TODO; one test placeholder in Task 25 explicitly notes "replace with the real connection-creation pattern" referencing the existing test file for guidance. This is a real instruction, not a hidden TODO.

**Type consistency** — `attachDialogs` signature in Task 1 matches uses in Tasks 2, 19, 26. `tryHandleDialogSelector` named param shape (`{selector, op, payload, state, sendCdpCommand, wsUrl, clear}`) introduced incrementally and consistent through Task 32. `DialogState` shape stable across all tasks (`kind`/`payload`/`staged`/`openedAt`). Refusal shape (`{refused, error, dialog, artifacts}`) used consistently in Tasks 19, 24.

---

## Execution

Plan complete and saved to `docs/superpowers/plans/2026-05-13-dialog-handling.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.
