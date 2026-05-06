# Post-C5 Follow-up Design

**Date:** 2026-05-05
**Status:** Approved

## Context

The C5 file split (16 lib extractions over one session) reduced
`chrome-ws-lib.js` from 3,159 lines to 258. During the work we
shipped four near-bugs — caught by tests in three cases, by accident
in the fourth. That session also surfaced a list of latent issues that
predate the refactor but became more visible once the code was
properly partitioned.

This document specifies the follow-up work as ten coordinated
changes. Each is small enough to ship as one or two commits. The set
is sized so that, taken together, it lands the codebase in a state
where the *next* refactor of similar scope is meaningfully safer.

The work splits into three groups:

- **Test infrastructure** — three test tiers with explicit per-tier
  YAGNI ceilings.
- **Code health** — dead code purge, magic-constant renames, require
  placement, lint enforcement.
- **Bug fixes** — process-handler accumulation, set-based diff,
  message-id asymmetry.

YAGNI applies throughout. We are not chasing perfection — we are
removing the specific debris that this session forced us to manually
find.

---

## 1. Test architecture

**Covers:** items 1, 10, 11, 12, 14 from the issue list.

Three tiers, each scoped to its purpose:

### Tier A — per-`lib/*.js` unit tests with mocked CDP

Workhorse layer. Every `lib/*.js` file gets a sibling
`test/lib/<name>.test.mjs`. Each test instantiates the `attachX({...})`
factory with a hand-rolled spy for `sendCdpCommand` and a stub for
`resolveWsUrl`, then asserts the spy was called with the expected CDP
method + params for each public action.

Catches: forgotten dep threading, broken CDP method names, wrong
parameter shapes, regressed argument orders. The class of bugs we
caught manually this session.

Scope:

- One test file per `lib/*.js` that exports `attachX`. Files that are
  pure helpers (`element-selector.js`, `key-definitions.js`,
  `html-diff.js`, `chrome-launcher-helpers.js`) get unit tests
  exercising the helpers directly.
- 5–15 assertions per file. No need for exhaustive coverage; cover
  the public surface and the obvious branches.
- No real CDP. No real Chrome. No jsdom.

### Tier B — jsdom-backed integration tests

Targeted layer for the files where the page-side eval string is the
load-bearing logic.

Scope:

- `lib/select-option.js` — value-then-label match, multi-select
  array, replace semantics, error on multi-on-non-multiple, error on
  unmatched value.
- `lib/element-selector.js` — already exists at
  `test/element-selector.test.mjs`; keep as-is.
- `lib/page-scripts/markdown.js` and `lib/page-scripts/dom-summary.js`
  — once those files exist (see section 3), test them by loading the
  string and evaluating against jsdom.

No other lib files get a tier-B test. The remaining page-side eval
strings are short enough that tier-A coverage is sufficient.

### Tier C — real-Chrome smoke test

One file: `test/smoke.test.mjs`. Spins up a real headless Chrome via
`startChrome`, exercises the public API end-to-end against `data:`
URLs, asserts the visible behaviour.

Scope:

- One golden-path scenario: navigate → click → type → select →
  screenshot → close.
- ~10 assertions total.
- Skips (not fails) if Chrome isn't available — `xfail` semantics so
  contributors without Chrome can still run `npm test`. Detection:
  `which google-chrome || which chromium || which "Google Chrome"` etc.
- Cleans up its session dir on exit.

This test is the one thing that catches "the bundle/lib actually
work end-to-end against a real browser." It's slow (~5–10s) but
single-file and gated.

### Test runner

Continue using Node's built-in `node:test`. No new framework.

---

## 2. Bundle drift detection and prevention

**Covers:** items 2, 13.

`mcp/dist/index.js` is the shipped bundle but at runtime requires
`chrome-ws-lib.js` from disk via a relative path. Same-commit drift
(lib edited without rebuild) and cross-commit drift (bundle from
commit N calls methods removed in commit N+1) both ship silently
today.

Three coordinated fixes:

### A. Drift-detection test

`test/bundle-drift.test.mjs`. Imports both:

```js
const distSession = require('../mcp/dist/index.js'); // no, see below
const srcSession = require('../skills/browsing/chrome-ws-lib.js').createSession();
```

Caveat: `mcp/dist/index.js` is an ESM bundle that runs as the MCP
server entry point — requiring it executes the server. The test
needs to either (a) extract the require path and load the lib through
the same indirection the bundle uses, or (b) parse the bundle's
expected method calls and compare against `Object.keys(srcSession)`.
Implementation picks (a) if practical, falls back to (b).

The assertion: every method called via `chromeLib.X(...)` in the
TypeScript source exists on the session object returned by
`createSession()`. Catches "lib renamed a method, bundle still
references the old name."

### B. Bundle-actually-loads test

`test/bundle-loads.test.mjs`. Uses `child_process.spawn('node',
['mcp/dist/index.js'])`, sends a stdio MCP `initialize` request,
asserts a valid response within 5 seconds. Then kills the process.

Catches: "the bundle is broken at startup" — bad require paths,
missing deps, syntax errors.

### C. Pre-build-commit guard

`scripts/check-bundle-fresh.sh`:

```bash
#!/bin/bash
npm run build > /dev/null
if ! git diff --quiet mcp/dist/; then
  echo "Bundle is stale. Run 'npm run build' before committing."
  exit 1
fi
```

Wired into `npm test` so it runs on every test invocation, and ideally
into a CI step. (No git pre-commit hook — those are user-machine
state and we don't ship them.)

The marketplace-cache stale-version problem is **out of scope.** That's
"users have an old version installed" and the only fix is reinstall.

---

## 3. Page-script extraction

**Covers:** item 3.

The two big page-side eval strings — `generateMarkdown` (~100 lines)
and `generateDomSummary` (~30 lines) — get extracted to standalone
`.js` files. Smaller eval strings stay inline.

### Layout

```
skills/browsing/lib/page-scripts/
  markdown.js
  dom-summary.js
```

Each file is the page-side script as a regular JavaScript IIFE,
exporting a string via `module.exports`. At `attachCapture` setup
time, the file is read once via `fs.readFileSync` and the string is
embedded in the CDP `Runtime.evaluate` call.

### Why files (not strings) at the source level

- ESLint / Biome can lint the page-side code.
- Tests can load the script and eval against jsdom directly.
- Editor syntax highlighting works.

### Tests

In tier B (see section 1):

- `test/lib/page-scripts/markdown.test.mjs` — load the script, eval
  against a jsdom DOM, assert markdown output for a few representative
  pages (with title, with images, with tables).
- `test/lib/page-scripts/dom-summary.test.mjs` — same pattern, assert
  the summary for pages with various interactive-element densities.

### What stays inline

`getPageSize` (5 lines), `humanType` per-key snippets, the focus
save/restore in `captureActionWithDiff`, mouse-coordinate lookups in
`mouse.js`. None of these is large enough to earn its own file.

### npm package

Add `skills/browsing/lib/page-scripts/` to the `files` array in
`package.json`.

---

## 4. Legacy alias purge

**Covers:** item 4.

Five suspect names: `cdpClick`, `insertText`, `keyboardType`,
`spaNavigate`, `hrefNavigate`.

The two known consumers of the lib are:

1. The MCP server (`mcp/src/index.ts`).
2. The CLI (`skills/browsing/chrome-ws`).

### Spec

1. Grep both consumers for any reference to the five aliases.
2. For any reference found: update the consumer to use the canonical
   name (`click`, `fill`, etc.).
3. Delete all five aliases from the lib:
   - `cdpClick = click` and the `cdpClick: click` entry in the
     `createSession` return.
   - `insertText = fill` and the `insertText: fill` entry in the
     return.
   - `keyboardType` from `lib/keyboard-input.js`'s exports and from
     the `chrome-ws-lib.js` destructure.
   - `spaNavigate` from `lib/navigation.js`'s exports and from the
     `chrome-ws-lib.js` destructure.
   - `hrefNavigate` same.
4. Update CHANGELOG.

### Trade-off

Anyone outside our two known consumers using these aliases breaks.
Accepted: this is a 1.x library, the canonical names are documented,
and the aliases are stylistic. Fastest path to a clean public
surface.

---

## 5. Named magic constants

**Covers:** item 5.

Per-module top-of-file `const` declarations. No central constants file,
no tunable options. Each value lives next to the code that uses it.

### Renames

| File | Constant | Value |
|---|---|---|
| `lib/console-logging.js` | `RUNTIME_ENABLE_REQUEST_ID` | `999999` |
| `lib/console-logging.js` | `ENABLE_TIMEOUT_MS` | `5000` |
| `lib/cdp-connection.js` | `DEFAULT_CDP_TIMEOUT_MS` | `30000` |
| `lib/mouse.js` | `DRAG_SETTLE_MS` | `50` |
| `lib/screenshot.js` | `MAX_IMAGE_DIMENSION_PX` | `1800` |
| `lib/viewport.js` | `MOBILE_USER_AGENT` | the Pixel-7 string |
| `lib/navigation.js` | `NAVIGATE_TIMEOUT_MS` | `30000` |
| `lib/navigation.js` | `CONSOLE_LINGER_MS` | `1000` |

Inline numeric literals in CDP-call shapes (`clickCount: 1`,
`modifiers: 8`, etc.) stay as literals — those are CDP protocol
values, not tunables.

---

## 6. Process exit handler registration

**Covers:** item 6.

Replace per-session `process.on('exit'/SIGINT/SIGTERM')` registration
with a module-level registry.

### Spec

In `lib/capture.js` at module scope:

```js
const activeCleanups = new Set();
let processHandlersRegistered = false;

function ensureProcessHandlersRegistered() {
  if (processHandlersRegistered) return;
  processHandlersRegistered = true;
  const runAll = () => { for (const fn of activeCleanups) fn(); };
  process.on('exit', runAll);
  process.on('SIGINT', () => { runAll(); process.exit(0); });
  process.on('SIGTERM', () => { runAll(); process.exit(0); });
}
```

`initializeSession` calls `ensureProcessHandlersRegistered()` and adds
its bound `cleanupSession` to `activeCleanups`. `cleanupSession`
removes itself from the set after running.

### What this fixes

- Multiple `ChromeSession` instances no longer register N×3 process
  handlers.
- A session that cleans up and re-initializes doesn't accumulate
  duplicate handlers.

### What this preserves

- Single-session behaviour identical: handlers fire on exit, session
  dir is cleaned.
- No new API surface.

---

## 7. Real line-diff for `generateHtmlDiff`

**Covers:** item 7.

Replace the set-based logic in `lib/html-diff.js` with a hand-rolled
Myers diff. No npm dependency.

### Spec

- Implement Myers' O((N+M)D) algorithm in ~50 LoC at the top of
  `lib/html-diff.js`.
- The public `generateHtmlDiff(beforeHtml, afterHtml)` signature
  stays the same.
- Output format stays the same: REMOVED / ADDED sections, capped at
  50 lines per side with "and N more" footer.
- Caps and trimming logic carry over.

### Tests (tier A)

- Identical input → "(no changes detected)".
- Pure addition → ADDED only.
- Pure removal → REMOVED only.
- Reorder of identical lines → now correctly shows REMOVED + ADDED
  (the bug fix case).
- 200-line diff → caps at 50 each with footer.

---

## 8. Drop `state.messageIdCounter`

**Covers:** item 8.

`sendCdpCommandSingle` opens a fresh WebSocket, sends one request,
waits for the response, closes. Message ids in CDP are scoped per
connection. The session-wide counter is overkill.

### Spec

1. Remove `messageIdCounter: 1` from `lib/session-state.js`'s
   `createState` return.
2. In `lib/cdp-connection.js`'s `sendCdpCommandSingle`, replace
   `const id = state.messageIdCounter++;` with `const id = 1;`.

### Risk

Zero. Per-connection ids are CDP's actual contract; the asymmetry
was historical.

---

## 9. require() at module top

**Covers:** item 9.

Pure mechanical sweep: every `require()` currently inside a function
body moves to the top of its file. Will be enforced by Biome (see
section 10) once that's added.

### Affected files

`lib/chrome-process.js` (`require('child_process')`,
`require('fs')`, `require('os')`),
`lib/screenshot.js` (already at top — verify), and any other lib file
with inline requires found by grep.

---

## 10. Add Biome

**Covers:** the Q10 bonus.

### Config

`biome.json` at repo root. Minimal rule set:

- `noUnusedVariables: error`
- `noUnusedImports: error`
- `noUnusedFunctionParameters: warn` (warn because some are
  semantically meaningful)
- `useConst: error`
- `noVar: error`
- One indentation style — 2 spaces (matches existing).

No formatting auto-fixes in CI; just lint.

### Wiring

- Add `@biomejs/biome` to `devDependencies`.
- New `npm run lint` script: `biome lint .`.
- `npm test` runs lint as a pre-step.
- Lint failures fail the build.

### Scope of fixes

Run Biome against the current codebase, fix every reported issue.
Expected hits: the dead reads we know about, possibly a few more we
don't. The fixes happen in this PR; future PRs are then linted clean.

---

## Out of scope

The following were considered and explicitly deferred:

- **Marketplace-cache stale versions.** That's a user-machine
  reinstall problem, not a code problem.
- **Tunable timeouts via `createSession({timeouts:{...}})` options.**
  Nobody's asked. Add when someone does.
- **TypeScript types for the lib.** Big change with its own design
  decisions. Separate effort.
- **Proper diff library (e.g., `diff` npm package).** Hand-rolled
  Myers gives us correctness without the dep.
- **Class conversion of the lib.** Already pushed back on; closures
  with state-passing are working fine.
- **Replacing `node:test` with another test runner.** Existing
  pattern works; no need.

## Order of work

The implementation plan (next step) will sequence these so that
dependencies land in order. Sketch:

1. Biome (10) — lint baseline, surfaces dead code that informs (4).
2. Magic constants (5), require sweep (9) — touched-by-Biome cleanup.
3. Legacy alias purge (4) — clean public surface before testing.
4. Page-script extraction (3) — lands the structure tests need.
5. Bug fixes: messageIdCounter (8), exit handlers (6), Myers diff (7).
6. Test infrastructure: tier A, tier B, tier C.
7. Bundle drift detection (2).

Each item is one commit (or two — fix + test). Tests added at every
step; the test infrastructure work just consolidates and expands.
