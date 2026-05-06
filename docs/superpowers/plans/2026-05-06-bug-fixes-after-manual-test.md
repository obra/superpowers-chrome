# Bug Fixes After Manual Smoke Test — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 7 bugs surfaced by the manual smoke test on 2026-05-06 — two lib bugs that affect the MCP, five CLI bugs that come from the CLI re-implementing logic the lib already provides.

**Architecture:** Lib fixes are surgical — propagate `result.exceptionDetails` from `evaluate()`, route `waitForElement`/`waitForText` through `evaluate()`, and teach `killChrome()` to look up the PID by port when the session didn't launch the Chrome it's about to kill. CLI fixes are structural — wire `createSession()` at the top of `chrome-ws` and delegate buggy commands to the lib's bound methods. Other CLI commands are left in place; this plan does not refactor every command, only the buggy ones, to keep diff size manageable.

**Tech Stack:** Node ≥18, `node:test`, Biome, no new deps.

---

## File Structure

### Modified files

- `skills/browsing/lib/evaluation.js` — `evaluate`, `evaluateJson`, `evaluateRaw` throw `Error` when CDP returns `result.exceptionDetails`.
- `skills/browsing/lib/navigation.js` — `waitForElement`, `waitForText` route through `evaluate` (passed in via the factory's deps) instead of calling `sendCdpCommand` directly.
- `skills/browsing/chrome-ws-lib.js` — pass `evaluate` into `attachNavigation({...})` so it can use it.
- `skills/browsing/lib/chrome-launcher-helpers.js` — add `findPidOnPort(port)` cross-platform helper.
- `skills/browsing/lib/chrome-process.js` — `killChrome()` falls back to port-based PID lookup when `state.chromeProcess` is null but `state.activePort` is alive.
- `skills/browsing/chrome-ws` — wire `createSession()` once at module top; delegate `eval`, `select`, `fill`, `wait-for`, `wait-text` to the bound session methods. Parse the optional timeout argument for `wait-for` and `wait-text`.

### Modified test files

- `test/lib/evaluation.test.mjs` — assert `evaluate` rejects on `exceptionDetails`.
- `test/lib/navigation.test.mjs` — assert `waitForElement`/`waitForText` reject when the page-side promise rejects.
- `test/lib/chrome-launcher-helpers.test.mjs` — `findPidOnPort` returns `null` for an unbound port; returns a number for a bound port.
- `test/smoke.test.mjs` — add real-Chrome cases that exercise the fixes (timeouts surface, mode switch survives a session reconnect, CLI delegations work).

### Out-of-scope

- A full CLI refactor where every command delegates to `createSession()`. Only the five buggy commands are switched. The CLI's inline `WebSocketClient`, `chromeHttp`, and `sendCdpCommand` stay for the rest of the commands. A follow-up plan can tackle full delegation if desired.
- Documenting `result.exceptionDetails` semantics for `evaluateRaw` callers — `evaluateRaw` is for callers who want the raw `RemoteObject`; we throw for them too because a JS exception means the `RemoteObject` value is meaningless.

---

## Conventions for every task

- **TDD.** Write the failing test, run it, then write the code, run again to confirm green, commit.
- **Each bug fix is one commit.** Test + impl together when they only make sense together (matches the post-C5 plan's D1+D2 precedent).
- **`npm test` must pass at every commit.** No half-broken intermediate states.
- **Working directory.** `/Users/jesse/Documents/GitHub/superpowers/superpowers-chrome`.
- **Branch.** Push direct to `main` (matches the previous plan's choice).

---

# Section 1: BUG-6 — `evaluate` propagates `exceptionDetails`

`Runtime.evaluate` returns a response with both `result` (the value) and `exceptionDetails` (set when the JS threw). The lib's `sendCdpCommand` only checks the protocol-level `data.error` — it never inspects `result.exceptionDetails`. So a JS exception (synchronous throw, or `Promise` rejection when `awaitPromise: true`) is silently swallowed and the caller gets `undefined` as if everything succeeded.

This is the root of BUG-6. The fix lives in `lib/evaluation.js`: when `exceptionDetails` is present, throw an `Error` with the original description.

### Task L1: Failing tests for `evaluate` exception propagation

**Files:**
- Modify: `test/lib/evaluation.test.mjs`

- [ ] **Step 1: Add three failing tests at the bottom of the existing `describe('evaluation', ...)` block**

```js
  it('evaluate throws when Runtime.evaluate returns exceptionDetails', async () => {
    const sendCdpCommand = makeCdpSpy({
      'Runtime.evaluate': () => ({
        result: { type: 'undefined' },
        exceptionDetails: {
          text: 'Uncaught (in promise)',
          exception: { description: 'Error: timeout fired' }
        }
      })
    });
    const { evaluate } = attachEvaluation({
      resolveWsUrl: makeResolveWsUrl(),
      sendCdpCommand
    });
    await assert.rejects(() => evaluate(0, 'whatever'), /timeout fired/);
  });

  it('evaluateJson throws when Runtime.evaluate returns exceptionDetails', async () => {
    const sendCdpCommand = makeCdpSpy({
      'Runtime.evaluate': () => ({
        result: { type: 'undefined' },
        exceptionDetails: {
          text: 'Uncaught',
          exception: { description: 'ReferenceError: x is not defined' }
        }
      })
    });
    const { evaluateJson } = attachEvaluation({
      resolveWsUrl: makeResolveWsUrl(),
      sendCdpCommand
    });
    await assert.rejects(() => evaluateJson(0, 'x'), /ReferenceError/);
  });

  it('evaluateRaw throws when Runtime.evaluate returns exceptionDetails', async () => {
    const sendCdpCommand = makeCdpSpy({
      'Runtime.evaluate': () => ({
        result: { type: 'undefined' },
        exceptionDetails: {
          text: 'Uncaught',
          exception: { description: 'TypeError: cannot read property' }
        }
      })
    });
    const { evaluateRaw } = attachEvaluation({
      resolveWsUrl: makeResolveWsUrl(),
      sendCdpCommand
    });
    await assert.rejects(() => evaluateRaw(0, 'foo.bar'), /TypeError/);
  });
```

- [ ] **Step 2: Run the new tests — confirm they fail**

```bash
node --test test/lib/evaluation.test.mjs
```

Expected: 3 new tests fail (the existing tests still pass).

### Task L2: Fix `evaluate`, `evaluateJson`, `evaluateRaw` to throw on `exceptionDetails`

**Files:**
- Modify: `skills/browsing/lib/evaluation.js`

- [ ] **Step 1: Add a helper at the top of `attachEvaluation` (or as a module-level function) and use it in all three functions**

Replace the body of `lib/evaluation.js` (keep the existing module docstring) with:

```js
function attachEvaluation({ resolveWsUrl, sendCdpCommand }) {
  function throwIfExceptionDetails(result) {
    if (!result.exceptionDetails) return;
    const desc = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'unknown evaluation error';
    throw new Error(`evaluate failed: ${desc}`);
  }

  async function evaluate(tabIndexOrWsUrl, expression) {
    const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
    const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    throwIfExceptionDetails(result);
    return result.result.value;
  }

  async function evaluateJson(tabIndexOrWsUrl, expression) {
    const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

    const wrappedExpression = `
      (() => {
        try {
          const result = ${expression};
          if (result === undefined) return { __type: 'undefined' };
          if (result === null) return null;
          if (result instanceof Element) {
            return {
              __type: 'Element',
              tagName: result.tagName,
              id: result.id,
              className: result.className,
              textContent: result.textContent?.slice(0, 100)
            };
          }
          if (typeof result === 'function') {
            return { __type: 'function', name: result.name || 'anonymous' };
          }
          return result;
        } catch (e) {
          return { __type: 'error', message: e.message };
        }
      })()
    `;

    const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
      expression: wrappedExpression,
      returnByValue: true,
      awaitPromise: true
    });
    throwIfExceptionDetails(result);
    return result.result.value;
  }

  async function evaluateRaw(tabIndexOrWsUrl, expression) {
    const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
    const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
      expression,
      returnByValue: false
    });
    throwIfExceptionDetails(result);
    return result.result;
  }

  return { evaluate, evaluateJson, evaluateRaw };
}

module.exports = { attachEvaluation };
```

- [ ] **Step 2: Run the new evaluation tests — confirm pass**

```bash
node --test test/lib/evaluation.test.mjs
```

Expected: all evaluation tests pass.

- [ ] **Step 3: Run full test suite — confirm nothing else broke**

```bash
npm test
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add skills/browsing/lib/evaluation.js test/lib/evaluation.test.mjs
git commit -m "Throw on Runtime.evaluate exceptionDetails

evaluate(), evaluateJson(), and evaluateRaw() previously returned
undefined when the page-side JS threw or a Promise rejected — the
exceptionDetails on the CDP response was never inspected. Now we
inspect it and throw with the original description. Three new
Tier A tests cover the three flavors."
```

---

# Section 2: BUG-6 cont. — `waitForElement` / `waitForText` use `evaluate`

`waitForElement` and `waitForText` build their own `Runtime.evaluate` payload and call `sendCdpCommand` directly — bypassing the fix from Section 1. The cleanest move is to delegate to `evaluate` so the rejection propagation just works.

`evaluate` lives in `lib/evaluation.js`; `waitForElement`/`waitForText` live in `lib/navigation.js`. The factory pattern requires `evaluate` to be passed in via `attachNavigation`'s deps.

### Task L3: Failing tests for wait-rejection propagation

**Files:**
- Modify: `test/lib/navigation.test.mjs`

- [ ] **Step 1: Add two failing tests at the bottom of the existing `describe('navigation', ...)` block**

```js
  it('waitForElement rejects when the page-side timeout fires', async () => {
    // The page-side JS sets a setTimeout that calls reject. CDP returns
    // result.exceptionDetails. We need waitForElement to surface that.
    const sendCdpCommand = makeCdpSpy({
      'Runtime.evaluate': () => ({
        result: { type: 'undefined' },
        exceptionDetails: {
          text: 'Uncaught (in promise)',
          exception: { description: 'Error: Timeout' }
        }
      })
    });
    const evaluate = async (_tab, expression) => {
      const r = await sendCdpCommand('ws://x', 'Runtime.evaluate', { expression, awaitPromise: true });
      if (r.exceptionDetails) {
        throw new Error(`evaluate failed: ${r.exceptionDetails.exception.description}`);
      }
      return r.result.value;
    };
    const { waitForElement } = attachNavigation({
      state: { consoleMessages: new Map() },
      resolveWsUrl: makeResolveWsUrl(),
      sendCdpCommand,
      capturePageArtifacts: async () => ({}),
      evaluate
    });
    await assert.rejects(() => waitForElement(0, '#never', 100), /Timeout/);
  });

  it('waitForText rejects when the page-side timeout fires', async () => {
    const sendCdpCommand = makeCdpSpy({
      'Runtime.evaluate': () => ({
        result: { type: 'undefined' },
        exceptionDetails: {
          text: 'Uncaught (in promise)',
          exception: { description: 'Error: Timeout' }
        }
      })
    });
    const evaluate = async (_tab, expression) => {
      const r = await sendCdpCommand('ws://x', 'Runtime.evaluate', { expression, awaitPromise: true });
      if (r.exceptionDetails) {
        throw new Error(`evaluate failed: ${r.exceptionDetails.exception.description}`);
      }
      return r.result.value;
    };
    const { waitForText } = attachNavigation({
      state: { consoleMessages: new Map() },
      resolveWsUrl: makeResolveWsUrl(),
      sendCdpCommand,
      capturePageArtifacts: async () => ({}),
      evaluate
    });
    await assert.rejects(() => waitForText(0, 'never appears', 100), /Timeout/);
  });
```

(The inline `evaluate` mock in the test does the same `exceptionDetails` check the real `evaluate` does — this isolates `waitForElement`/`waitForText` to "given a working `evaluate`, do they propagate?" rather than re-testing the Section-1 fix.)

- [ ] **Step 2: Run the new tests — confirm they fail**

```bash
node --test test/lib/navigation.test.mjs
```

Expected: 2 new tests fail (the original navigation tests still pass; failure mode is "did not reject" because the current `waitForElement`/`waitForText` call `sendCdpCommand` directly, ignoring `exceptionDetails`).

### Task L4: Route `waitForElement` / `waitForText` through `evaluate`

**Files:**
- Modify: `skills/browsing/lib/navigation.js`
- Modify: `skills/browsing/chrome-ws-lib.js`

- [ ] **Step 1: Update `attachNavigation` to accept `evaluate` and use it in `waitForElement` / `waitForText`**

In `skills/browsing/lib/navigation.js`, change the factory signature and the two functions:

```js
function attachNavigation({ state, resolveWsUrl, sendCdpCommand, capturePageArtifacts, evaluate }) {
```

Replace `waitForElement`:

```js
  async function waitForElement(tabIndexOrWsUrl, selector, timeout = 5000) {
    const js = `
      new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('waitForElement timeout: ' + ${JSON.stringify(selector)})), ${timeout});
        const check = () => {
          if (${getElementSelector(selector)}) {
            clearTimeout(t);
            resolve(true);
          } else {
            setTimeout(check, 100);
          }
        };
        check();
      })
    `;
    await evaluate(tabIndexOrWsUrl, js);
  }
```

Replace `waitForText`:

```js
  async function waitForText(tabIndexOrWsUrl, text, timeout = 5000) {
    const js = `
      new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('waitForText timeout: ' + ${JSON.stringify(text)})), ${timeout});
        const check = () => {
          if (document.body.textContent.includes(${JSON.stringify(text)})) {
            clearTimeout(t);
            resolve(true);
          } else {
            setTimeout(check, 100);
          }
        };
        check();
      })
    `;
    await evaluate(tabIndexOrWsUrl, js);
  }
```

(`resolveWsUrl` and `sendCdpCommand` are no longer needed in these two functions — `evaluate` handles ws-resolution and CDP call. Keep them in the factory signature because `navigate` still uses them.)

- [ ] **Step 2: Wire `evaluate` into `attachNavigation` in `chrome-ws-lib.js`**

In `skills/browsing/chrome-ws-lib.js`, change the line that calls `attachNavigation` to pass `evaluate`:

```js
  const { navigate, waitForElement, waitForText } =
    attachNavigation({ state, resolveWsUrl, sendCdpCommand, capturePageArtifacts, evaluate });
```

The existing destructure `const { evaluate, evaluateJson, evaluateRaw } = attachEvaluation(...)` already provides `evaluate` in scope. Just make sure `attachEvaluation` runs before `attachNavigation` (it already does in the current file order).

- [ ] **Step 3: Run navigation tests — confirm pass**

```bash
node --test test/lib/navigation.test.mjs
```

Expected: all navigation tests pass (the new rejection tests + the existing ones).

- [ ] **Step 4: Run full test suite**

```bash
npm test
```

Expected: pass.

- [ ] **Step 5: Smoke-check against real Chrome**

Run Chrome (any way), then from a Node REPL or a one-liner:

```bash
node -e "
const { createSession } = require('./skills/browsing/chrome-ws-lib');
const s = createSession();
(async () => {
  await s.startChrome(true);
  await s.navigate(0, 'data:text/html,<h1>x</h1>');
  const t0 = Date.now();
  try {
    await s.waitForElement(0, '#never', 500);
    console.log('FAIL: did not throw');
  } catch (e) {
    console.log('OK threw in', Date.now() - t0, 'ms:', e.message);
  }
  await s.killChrome();
})();
"
```

Expected: `OK threw in ~500ms: evaluate failed: Error: waitForElement timeout: #never` (or similar).

- [ ] **Step 6: Commit**

```bash
git add skills/browsing/lib/navigation.js skills/browsing/chrome-ws-lib.js test/lib/navigation.test.mjs
git commit -m "Route waitForElement/waitForText through evaluate

The two waiters built their own Runtime.evaluate payload and called
sendCdpCommand directly, bypassing evaluate()'s exceptionDetails
handling. Now they delegate to evaluate(), so a page-side reject (the
inner setTimeout->reject for the timeout case) surfaces as a thrown
error instead of a silent resolve.

Two new Tier A tests cover the rejection propagation. Real-Chrome
smoke-check confirms waitForElement(0, '#never', 500) now throws in
~500ms instead of resolving in ~30s."
```

---

# Section 3: BUG-7 — `killChrome` falls back to port-based PID lookup

When a session reconnects to a Chrome it didn't itself launch (via meta.json), `state.chromeProcess` is null. `killChrome()` early-returns. Subsequent `showBrowser`/`hideBrowser` then can't free the port for the new launch.

Fix: when `state.chromeProcess` is null but `state.activePort` is set, look up the PID holding the port and SIGTERM it.

### Task L5: Add `findPidOnPort` helper

**Files:**
- Modify: `skills/browsing/lib/chrome-launcher-helpers.js`
- Modify: `test/lib/chrome-launcher-helpers.test.mjs`

- [ ] **Step 1: Write a failing test**

Add to `test/lib/chrome-launcher-helpers.test.mjs` (inside the existing describe block):

```js
  it('findPidOnPort returns null for an unbound port', async () => {
    // Pick a port that's almost certainly not in use.
    const pid = await findPidOnPort(64999);
    assert.equal(pid, null);
  });

  it('findPidOnPort returns a number for the current Node process port', async () => {
    // Bind a TCP server on an OS-assigned port, then look it up.
    const net = await import('node:net');
    const server = net.default.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      const pid = await findPidOnPort(port);
      assert.equal(typeof pid, 'number');
      assert.equal(pid, process.pid);
    } finally {
      server.close();
    }
  });
```

Update the imports at top of the test file to include `findPidOnPort`:

```js
const { findPidOnPort, ...others } = require('../../skills/browsing/lib/chrome-launcher-helpers.js');
```

(Adapt to the actual import shape already in the test file — destructure `findPidOnPort` alongside whatever is already imported.)

- [ ] **Step 2: Run test — confirm it fails**

```bash
node --test test/lib/chrome-launcher-helpers.test.mjs
```

Expected: 2 new tests fail (`findPidOnPort` is not exported yet).

- [ ] **Step 3: Implement `findPidOnPort` in `lib/chrome-launcher-helpers.js`**

Add to the file (near the other port helpers):

```js
// Find the PID of the process holding `port`, or null if none.
// Uses platform-native tools — lsof on macOS/Linux, netstat on Windows.
// Returns null on any failure (parsing, missing tool, no listener).
function findPidOnPort(port) {
  const { execSync } = require('child_process');
  try {
    if (process.platform === 'darwin' || process.platform === 'linux') {
      const out = execSync(`lsof -ti:${port}`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      if (!out) return null;
      // lsof -t can return multiple PIDs (one per fd); take the first.
      const first = out.split('\n')[0];
      const pid = parseInt(first, 10);
      return Number.isFinite(pid) ? pid : null;
    }
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr :${port}`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
      // Last whitespace-separated column on a LISTENING line is the PID.
      const lines = out.split(/\r?\n/).filter(l => /LISTENING/i.test(l));
      if (!lines.length) return null;
      const cols = lines[0].trim().split(/\s+/);
      const pid = parseInt(cols[cols.length - 1], 10);
      return Number.isFinite(pid) ? pid : null;
    }
  } catch (_e) {
    return null;
  }
  return null;
}
```

Add `findPidOnPort` to the module's exports at the bottom of the file:

```js
module.exports = {
  // ...existing exports...
  findPidOnPort,
};
```

(Splice into the existing module.exports object — don't duplicate the block.)

- [ ] **Step 4: Run test — confirm pass**

```bash
node --test test/lib/chrome-launcher-helpers.test.mjs
```

Expected: pass.

- [ ] **Step 5: Run full test suite**

```bash
npm test
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add skills/browsing/lib/chrome-launcher-helpers.js test/lib/chrome-launcher-helpers.test.mjs
git commit -m "Add findPidOnPort cross-platform helper

lsof -ti:PORT on macOS/Linux, netstat | findstr on Windows. Returns
null on any failure (no listener, missing tool, parse error). Used by
the upcoming killChrome fix to clean up Chrome processes the current
session didn't launch."
```

### Task L6: `killChrome` falls back to port lookup

**Files:**
- Modify: `skills/browsing/lib/chrome-process.js`

- [ ] **Step 1: Update `killChrome` to handle the unowned-process case**

In `skills/browsing/lib/chrome-process.js`, replace the existing `killChrome` body with:

```js
  async function killChrome() {
    let pidToKill = null;

    if (state.chromeProcess && state.chromeProcess.pid) {
      pidToKill = state.chromeProcess.pid;
    } else if (state.activePort) {
      // We didn't launch this Chrome (or already dropped the handle), but we
      // know the port. Kill whoever holds it so showBrowser/hideBrowser can
      // restart cleanly in the target mode.
      pidToKill = findPidOnPort(state.activePort);
    }

    if (pidToKill === null) {
      // Nothing to kill. Still clear meta.json so other sessions don't
      // think there's a Chrome here.
      clearProfileMeta(state.chromeProfileName);
      state.chromeProcess = null;
      state.activePort = CHROME_DEBUG_PORT;
      return;
    }

    try {
      // Try graceful shutdown via CDP first.
      try {
        await chromeHttp('/json/close', 'GET');
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (_e) {
        // Ignore — Chrome might already be dead.
      }

      try {
        process.kill(pidToKill, 'SIGTERM');
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (_e) {
        // Process might already be dead.
      }
    } catch (e) {
      console.error(`Error killing Chrome: ${e.message}`);
    }

    clearProfileMeta(state.chromeProfileName);
    state.chromeProcess = null;
    state.activePort = CHROME_DEBUG_PORT;
  }
```

Make sure `findPidOnPort` is imported at the top of the file:

```js
const {
  // ...existing destructured imports...
  findPidOnPort,
} = require('./chrome-launcher-helpers');
```

- [ ] **Step 2: Add a smoke test that exercises the cross-session reconnect path**

Add to `test/smoke.test.mjs` (inside the existing `describe('real Chrome smoke', ...)` block):

```js
  it('hideBrowser kills a Chrome the current session reconnected to', async () => {
    // Save the launched-Chrome PID so we can confirm it gets killed.
    const originalPid = await session.evaluate(0, 'navigator.userAgent.length');
    // (We don't actually need its real PID; what matters is that the new
    // session is operating against state.chromeProcess === null but
    // state.activePort still set. We simulate that by nulling chromeProcess.)

    // Drop the process handle to simulate a cross-process reconnect.
    // This is the "session reconnected via meta.json" code path.
    const { createSession } = require('../skills/browsing/chrome-ws-lib');
    const s2 = createSession();
    s2.setProfileName(session.getProfileName());

    // s2 reconnects: state.activePort gets set, state.chromeProcess stays null.
    // We test that a kill works anyway by going through the helper directly.
    await s2.startChrome(false /* headed — flips mode if currently headless */);

    // s2 should now be in headed mode; the original session's Chrome was killed.
    assert.equal(s2.getBrowserMode().mode, 'headed');

    // Cleanup s2's Chrome and let the outer after() reset state.
    await s2.killChrome();
  });
```

(This test depends on the smoke-test `before` block already having started a Chrome via `session`. It then creates a second session, reuses the same profile, and starts in the opposite mode. If `killChrome` doesn't tear down the original Chrome, the new `startChrome` will fail with the "did not become ready on port X within 15000ms" error.)

- [ ] **Step 3: Run smoke test (Chrome required)**

```bash
node --test test/smoke.test.mjs
```

Expected: pass (or if Chrome isn't installed, suite skipped — but on dev machines it should run).

- [ ] **Step 4: Run full test suite**

```bash
npm test
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add skills/browsing/lib/chrome-process.js test/smoke.test.mjs
git commit -m "killChrome falls back to port-based PID lookup

When state.chromeProcess is null but state.activePort is alive — the
session reconnected to a Chrome it didn't launch — we now look up the
PID holding the port via findPidOnPort and SIGTERM it. Without this,
showBrowser/hideBrowser on a reconnected session left the old Chrome
running and the new launch failed with 'did not become ready on port X'.

Smoke test covers the cross-session reconnect path."
```

---

# Section 4: CLI fixes — delegate buggy commands to `createSession()`

The CLI re-implements logic that exists in the lib. Instead of fixing each bug in the CLI's hand-rolled `Runtime.evaluate` strings, switch the buggy command handlers to call `session.<method>` and let the lib do the work. Other CLI commands (those without bugs) stay unchanged in this plan; a follow-up plan can finish the delegation.

### Task C0: Wire `createSession()` at the top of `chrome-ws`

**Files:**
- Modify: `skills/browsing/chrome-ws`

- [ ] **Step 1: Add the session import near the top of the file**

Find the existing line:

```js
const hostOverride = require('./host-override').createOverride();
```

Immediately after it, add:

```js
const { createSession } = require('./chrome-ws-lib');
const session = createSession();
```

(`createSession()` reads `CHROME_WS_HOST`/`CHROME_WS_PORT` env vars at construction time, matching what the existing `hostOverride` already does. Both call sites end up consistent.)

- [ ] **Step 2: Run any existing CLI test (if present) — confirm nothing broke**

The CLI doesn't have its own tests yet, so just sanity-check by running it:

```bash
./skills/browsing/chrome-ws --help 2>&1 | head -1
```

Expected: prints the existing usage string (or first command help line).

```bash
npm test
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add skills/browsing/chrome-ws
git commit -m "Wire createSession() into chrome-ws CLI

Constructs a single session at module load. The next commits replace
buggy command handlers (eval, select, fill, wait-for, wait-text) with
calls to the bound session methods, so the CLI inherits the lib's
correct behavior. Other commands continue to use the existing inline
WebSocketClient + sendCdpCommand for now."
```

### Task C1: BUG-1 — `eval` delegates to `session.evaluate`

**Files:**
- Modify: `skills/browsing/chrome-ws`

- [ ] **Step 1: Replace the `eval` command handler**

Find the block starting `if (command === 'eval') {`. Replace its body with:

```js
if (command === 'eval') {
  const expression = args.join(' ');
  if (!wsUrlOrIndex || !expression) {
    console.error('Usage: chrome-ws eval <tab-index-or-ws-url> <js-expression>');
    process.exit(1);
  }
  (async () => {
    try {
      const value = await session.evaluate(wsUrlOrIndex, expression);
      console.log(JSON.stringify(value, null, 2));
    } catch (e) {
      console.error('Eval failed:', e.message);
      process.exit(1);
    }
  })();
  return;
}
```

`session.evaluate` already passes `awaitPromise: true` and (after Section 1) throws on `exceptionDetails`. The CLI's previous manual `result.exceptionDetails` check is now redundant — `session.evaluate` throws and the catch block prints the message.

- [ ] **Step 2: Smoke-check against real Chrome**

```bash
./skills/browsing/chrome-ws start
./skills/browsing/chrome-ws navigate 0 "data:text/html,<h1>ok</h1>"
./skills/browsing/chrome-ws eval 0 "Promise.resolve(42)"
```

Expected: prints `42` (not `{}`).

```bash
./skills/browsing/chrome-ws eval 0 "throw new Error('boom')"
```

Expected: exit 1 with `Eval failed: evaluate failed: Error: boom` (or similar).

- [ ] **Step 3: Commit**

```bash
git add skills/browsing/chrome-ws
git commit -m "Fix BUG-1: chrome-ws eval awaits Promises

The CLI's eval handler called Runtime.evaluate without awaitPromise:true,
so 'Promise.resolve(42)' returned {} instead of 42. Delegate to
session.evaluate which has awaitPromise:true and proper exceptionDetails
handling. Surfaced by manual smoke test 2026-05-06."
```

### Task C2: BUG-2 — `select` delegates to `session.selectOption`

**Files:**
- Modify: `skills/browsing/chrome-ws`

- [ ] **Step 1: Replace the `select` command handler**

Find the block starting `if (command === 'select') {`. Replace its body with:

```js
if (command === 'select') {
  const [selector, value] = args;
  if (!wsUrlOrIndex || !selector || value === undefined) {
    console.error('Usage: chrome-ws select <tab-index-or-ws-url> <selector> <value-or-label-or-json-array>');
    process.exit(1);
  }
  (async () => {
    try {
      // Accept JSON array (multi-select) or plain string (value or label).
      let selectValue = value;
      if (typeof value === 'string' && value.trim().startsWith('[')) {
        try {
          const parsed = JSON.parse(value);
          if (Array.isArray(parsed) && parsed.every(v => typeof v === 'string')) {
            selectValue = parsed;
          }
        } catch (_e) { /* not JSON, treat as plain string */ }
      }
      const result = await session.selectOption(wsUrlOrIndex, selector, selectValue);
      console.log(JSON.stringify(result.matched.map(o => o.value)));
    } catch (e) {
      console.error('Select failed:', e.message);
      process.exit(1);
    }
  })();
  return;
}
```

(`session.selectOption` is the canonical name from the lib; it handles value, label, and array — see `lib/select-option.js`.)

- [ ] **Step 2: Smoke-check against real Chrome**

```bash
./skills/browsing/chrome-ws navigate 0 'data:text/html,<select id=s><option value=a>Apple</option><option value=b>Banana</option><option value=c>Cherry</option></select>'
./skills/browsing/chrome-ws select 0 "#s" "Cherry"
./skills/browsing/chrome-ws eval 0 'document.getElementById("s").value'
```

Expected: prints `"c"` (label-match worked).

```bash
./skills/browsing/chrome-ws navigate 0 'data:text/html,<select id=m multiple><option value=a>A</option><option value=b>B</option><option value=c>C</option></select>'
./skills/browsing/chrome-ws select 0 "#m" '["a","c"]'
./skills/browsing/chrome-ws eval 0 'Array.from(document.getElementById("m").selectedOptions).map(o => o.value).join(",")'
```

Expected: prints `"a,c"` (multi-select worked).

- [ ] **Step 3: Commit**

```bash
git add skills/browsing/chrome-ws
git commit -m "Fix BUG-2: chrome-ws select supports labels and multi-select

The CLI did el.value = <input> via Runtime.evaluate, so label text and
JSON arrays didn't work. Delegate to session.selectOption, which handles
value, visible label, and arrays for <select multiple>. Surfaced by
manual smoke test 2026-05-06."
```

### Task C3: BUG-5 — `fill` delegates to `session.fill`

**Files:**
- Modify: `skills/browsing/chrome-ws`

- [ ] **Step 1: Replace the `fill` command handler**

Find the block starting `if (command === 'fill') {`. Replace its body with:

```js
if (command === 'fill') {
  const [selector, value] = args;
  if (!wsUrlOrIndex || !selector || value === undefined) {
    console.error('Usage: chrome-ws fill <tab-index-or-ws-url> <selector> <value>');
    process.exit(1);
  }
  (async () => {
    try {
      await session.fill(wsUrlOrIndex, selector, value);
      console.log(`Filled: ${selector}`);
    } catch (e) {
      console.error('Fill failed:', e.message);
      process.exit(1);
    }
  })();
  return;
}
```

`session.fill` (in `lib/keyboard-input.js`) checks for the element first and throws "Element not found" if it's missing. Exit 1 with a useful error.

- [ ] **Step 2: Smoke-check**

```bash
./skills/browsing/chrome-ws navigate 0 'data:text/html,<input id=i>'
./skills/browsing/chrome-ws fill 0 "#i" "hello"
./skills/browsing/chrome-ws eval 0 'document.getElementById("i").value'
```

Expected: prints `"hello"`.

```bash
./skills/browsing/chrome-ws fill 0 "#nonexistent" "x"; echo "exit=$?"
```

Expected: `Fill failed: Element not found: #nonexistent` and `exit=1` (was: silent success, exit 0).

- [ ] **Step 3: Commit**

```bash
git add skills/browsing/chrome-ws
git commit -m "Fix BUG-5: chrome-ws fill errors on missing element

The CLI's fill did el.value = X via Runtime.evaluate; if el was null this
was a no-op with exit 0. Delegate to session.fill which throws 'Element
not found' so the CLI exits 1 with a useful message. Surfaced by manual
smoke test 2026-05-06."
```

### Task C4: BUG-4 — `wait-for` parses timeout and delegates

**Files:**
- Modify: `skills/browsing/chrome-ws`

- [ ] **Step 1: Replace the `wait-for` command handler**

Find the block starting `if (command === 'wait-for') {`. Replace its body with:

```js
if (command === 'wait-for') {
  const [selector, timeoutArg] = args;
  if (!wsUrlOrIndex || !selector) {
    console.error('Usage: chrome-ws wait-for <tab-index-or-ws-url> <selector> [timeout-ms]');
    process.exit(1);
  }
  const timeout = timeoutArg ? parseInt(timeoutArg, 10) : 5000;
  if (Number.isNaN(timeout) || timeout < 0) {
    console.error(`Invalid timeout: ${timeoutArg}`);
    process.exit(1);
  }
  (async () => {
    try {
      await session.waitForElement(wsUrlOrIndex, selector, timeout);
      console.log(`Element found: ${selector}`);
    } catch (e) {
      console.error('Wait failed:', e.message);
      process.exit(1);
    }
  })();
  return;
}
```

- [ ] **Step 2: Smoke-check**

```bash
./skills/browsing/chrome-ws navigate 0 'data:text/html,<h1>x</h1>'
time ./skills/browsing/chrome-ws wait-for 0 "#never" 1000
```

Expected: exits ~1000ms with `Wait failed: evaluate failed: Error: waitForElement timeout: #never` (was: ~30 seconds with the same error).

- [ ] **Step 3: Commit**

```bash
git add skills/browsing/chrome-ws
git commit -m "Fix BUG-4: chrome-ws wait-for honors the timeout argument

The CLI's wait-for ignored its third arg, falling through to the lib's
default 30s CDP hard timeout. Now parses the optional [timeout-ms] arg
and delegates to session.waitForElement(tab, selector, timeout). Default
remains 5000ms when omitted. Surfaced by manual smoke test 2026-05-06."
```

### Task C5: BUG-3 — `wait-text` parses timeout and delegates

**Files:**
- Modify: `skills/browsing/chrome-ws`

- [ ] **Step 1: Replace the `wait-text` command handler**

Find the block starting `if (command === 'wait-text') {`. Replace its body with:

```js
if (command === 'wait-text') {
  // Last positional arg is treated as timeout if it parses as a non-negative
  // integer; otherwise everything is text. This handles both:
  //   wait-text 0 "the text" 3000
  //   wait-text 0 "text without timeout"
  if (!wsUrlOrIndex || args.length === 0) {
    console.error('Usage: chrome-ws wait-text <tab-index-or-ws-url> <text> [timeout-ms]');
    process.exit(1);
  }
  let textArgs = args;
  let timeout = 5000;
  const last = args[args.length - 1];
  const parsedLast = parseInt(last, 10);
  if (args.length >= 2 && Number.isFinite(parsedLast) && parsedLast >= 0 && String(parsedLast) === last.trim()) {
    timeout = parsedLast;
    textArgs = args.slice(0, -1);
  }
  const text = textArgs.join(' ');
  if (!text) {
    console.error('Usage: chrome-ws wait-text <tab-index-or-ws-url> <text> [timeout-ms]');
    process.exit(1);
  }
  (async () => {
    try {
      await session.waitForText(wsUrlOrIndex, text, timeout);
      console.log(`Text found: ${text}`);
    } catch (e) {
      console.error('Wait failed:', e.message);
      process.exit(1);
    }
  })();
  return;
}
```

The "last arg is the timeout if it parses as integer" heuristic isn't perfect — text that ends in a numeric word would be misinterpreted. We accept this as a known edge case; the typical CLI usage is `wait-text 0 "some text" 3000` and that works. Document it in the commit message.

- [ ] **Step 2: Smoke-check**

```bash
./skills/browsing/chrome-ws navigate 0 'data:text/html,<h1>x</h1>'
time ./skills/browsing/chrome-ws wait-text 0 "TARGET_TEXT" 1000
```

Expected: exits ~1000ms with `Wait failed: evaluate failed: Error: waitForText timeout: TARGET_TEXT` (was: ~30 seconds, looking for the literal text "TARGET_TEXT 1000").

```bash
./skills/browsing/chrome-ws eval 0 'setTimeout(() => document.body.innerHTML += " HELLO ", 200)'
./skills/browsing/chrome-ws wait-text 0 "HELLO" 3000
```

Expected: prints `Text found: HELLO` within ~200ms.

- [ ] **Step 3: Commit**

```bash
git add skills/browsing/chrome-ws
git commit -m "Fix BUG-3: chrome-ws wait-text honors the timeout argument

The CLI's wait-text used args.join(' ') so 'wait-text 0 \"TEXT\" 3000'
waited for literal 'TEXT 3000', hitting the 30s CDP hard cap. Now
detects an integer-valued last arg as a timeout (with a heuristic
documented inline) and delegates to session.waitForText. Default
remains 5000ms. Surfaced by manual smoke test 2026-05-06."
```

---

# Section 5: Verification

### Task V1: Re-run the manual smoke checklist

**Files:**
- (none — verification only)

- [ ] **Step 1: Run full automated test suite**

```bash
npm test
```

Expected: all tests pass, including the new ones.

- [ ] **Step 2: Re-run the seven specific bug scenarios**

For each bug, run the exact reproducer from the original manual test and confirm it now passes:

```bash
# BUG-1: eval awaits Promises
./skills/browsing/chrome-ws start
./skills/browsing/chrome-ws navigate 0 'data:text/html,<h1>x</h1>'
test "$(./skills/browsing/chrome-ws eval 0 'Promise.resolve(42)')" = "42" && echo "BUG-1 OK"

# BUG-2: select by label
./skills/browsing/chrome-ws navigate 0 'data:text/html,<select id=s><option value=a>Apple</option><option value=b>Banana</option></select>'
./skills/browsing/chrome-ws select 0 "#s" "Banana"
test "$(./skills/browsing/chrome-ws eval 0 'document.getElementById(\"s\").value')" = "\"b\"" && echo "BUG-2 OK"

# BUG-3: wait-text honors timeout
START=$(date +%s)
./skills/browsing/chrome-ws wait-text 0 "NEVER_APPEARS" 1000 || true
END=$(date +%s)
test $((END - START)) -lt 5 && echo "BUG-3 OK"

# BUG-4: wait-for honors timeout
START=$(date +%s)
./skills/browsing/chrome-ws wait-for 0 "#never" 1000 || true
END=$(date +%s)
test $((END - START)) -lt 5 && echo "BUG-4 OK"

# BUG-5: fill errors on missing
./skills/browsing/chrome-ws fill 0 "#nonexistent" "x" && echo "BUG-5 FAIL" || echo "BUG-5 OK"

# BUG-6: waitForElement timeout (lib direct)
node -e "
const { createSession } = require('./skills/browsing/chrome-ws-lib');
const s = createSession();
(async () => {
  await s.startChrome(true);
  await s.navigate(0, 'data:text/html,<h1>x</h1>');
  const t0 = Date.now();
  try {
    await s.waitForElement(0, '#never', 500);
    console.log('BUG-6 FAIL');
  } catch (_e) {
    const ms = Date.now() - t0;
    console.log(ms < 2000 ? 'BUG-6 OK' : 'BUG-6 FAIL (slow)');
  }
  await s.killChrome();
})();
"

# BUG-7: covered by smoke test (already in npm test)
echo "BUG-7 covered by test/smoke.test.mjs"

# Cleanup
./skills/browsing/chrome-ws kill 2>/dev/null || true
```

Expected: all "OK" lines printed.

- [ ] **Step 3: No commit — this is a verification task**

If anything fails, file the failure as a new task and don't proceed to release.

---

## Self-review

**Spec coverage:**

- BUG-1 (CLI eval doesn't await) → Task C1.
- BUG-2 (CLI select doesn't support label/multi) → Task C2.
- BUG-3 (CLI wait-text args.join consumes timeout) → Task C5.
- BUG-4 (CLI wait-for ignores timeout) → Task C4.
- BUG-5 (CLI fill silent on missing element) → Task C3.
- BUG-6 (lib waitForElement/waitForText silently swallow timeouts) → Tasks L1, L2 (evaluate fix), L3, L4 (waiters route through evaluate).
- BUG-7 (lib hideBrowser/showBrowser fails when not the launcher) → Tasks L5 (findPidOnPort helper), L6 (killChrome falls back).

All seven bugs covered.

**Placeholder scan:** No "TBD"/"TODO"/"appropriate"/"fill in details". All code blocks are concrete. All commands have expected output.

**Type consistency:** `evaluate(tab, expression)` signature is consistent across L2, L4, C1. `selectOption(tab, selector, value)` matches the lib's existing signature. `findPidOnPort(port)` returns `number | null`, used consistently in L5 and L6. The `attachNavigation` factory now takes `evaluate` as a dep — wired in `chrome-ws-lib.js` at L4 and consumed inside `lib/navigation.js`.

**Order dependencies:** L4 depends on L2 (waitForElement uses evaluate which must throw first). L6 depends on L5 (killChrome uses findPidOnPort). C1-C5 depend on C0 (CLI must have `session` before delegating). C1 depends on L2 (eval delegate relies on evaluate's exceptionDetails fix). C4/C5 depend on L4 (wait-for/wait-text delegates rely on the waiters actually rejecting on timeout). Section 5 depends on all of Sections 1-4.

Plan complete and saved to `docs/superpowers/plans/2026-05-06-bug-fixes-after-manual-test.md`.
