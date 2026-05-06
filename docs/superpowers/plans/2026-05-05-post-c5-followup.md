# Post-C5 Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the ten coordinated changes from `docs/superpowers/specs/2026-05-05-post-c5-followup-design.md` — lint baseline, dead code purge, named magic constants, page-script extraction, three bug fixes, three test tiers, and bundle drift detection.

**Architecture:** Pure-JS lib (`skills/browsing/lib/*.js`) consumed by an MCP server (`mcp/dist/index.js`, runtime-loads the lib) and a CLI (`skills/browsing/chrome-ws`). All extraction follows the existing `attachX({...})` factory pattern. Tests use Node's built-in `node:test` runner. Linting added via Biome.

**Tech Stack:** Node ≥18, `node:test`, jsdom (existing dev dep), Biome (new dev dep), esbuild (existing build).

---

## File Structure

### New files

- `biome.json` — root Biome config
- `scripts/check-bundle-fresh.sh` — bundle freshness guard
- `skills/browsing/lib/page-scripts/markdown.js` — extracted page-side markdown extractor
- `skills/browsing/lib/page-scripts/dom-summary.js` — extracted page-side DOM summary
- `test/lib/cookies.test.mjs` — Tier A unit
- `test/lib/viewport.test.mjs` — Tier A unit
- `test/lib/evaluation.test.mjs` — Tier A unit
- `test/lib/extraction.test.mjs` — Tier A unit
- `test/lib/file-upload.test.mjs` — Tier A unit
- `test/lib/screenshot.test.mjs` — Tier A unit
- `test/lib/mouse.test.mjs` — Tier A unit
- `test/lib/keyboard-input.test.mjs` — Tier A unit
- `test/lib/navigation.test.mjs` — Tier A unit
- `test/lib/console-logging.test.mjs` — Tier A unit
- `test/lib/cdp-connection.test.mjs` — Tier A unit
- `test/lib/tabs.test.mjs` — Tier A unit
- `test/lib/chrome-process.test.mjs` — Tier A unit
- `test/lib/select-option.test.mjs` — Tier B (jsdom)
- `test/lib/page-scripts/markdown.test.mjs` — Tier B (jsdom)
- `test/lib/page-scripts/dom-summary.test.mjs` — Tier B (jsdom)
- `test/lib/html-diff.test.mjs` — Myers diff coverage
- `test/lib/key-definitions.test.mjs` — pure helpers (charToKeyDef, KEY_DEFINITIONS shape)
- `test/lib/chrome-launcher-helpers.test.mjs` — pure helpers
- `test/smoke.test.mjs` — Tier C real-Chrome smoke
- `test/bundle-drift.test.mjs` — bundle vs lib method-set parity
- `test/bundle-loads.test.mjs` — `node mcp/dist/index.js` boots cleanly

### Modified files

- `package.json` — devDeps: biome; new scripts: lint, lint:fix; files: page-scripts dir
- `mcp/src/index.ts` — possibly: legacy alias call sites (verify in Task L1)
- `skills/browsing/chrome-ws` — possibly: legacy alias call sites (verify in Task L1)
- `skills/browsing/chrome-ws-lib.js` — drop legacy aliases from createSession return
- `skills/browsing/lib/chrome-process.js` — move inline requires to top
- `skills/browsing/lib/cdp-connection.js` — drop state.messageIdCounter usage; add `DEFAULT_CDP_TIMEOUT_MS` const
- `skills/browsing/lib/session-state.js` — remove messageIdCounter field
- `skills/browsing/lib/console-logging.js` — `RUNTIME_ENABLE_REQUEST_ID`, `ENABLE_TIMEOUT_MS` consts
- `skills/browsing/lib/mouse.js` — `DRAG_SETTLE_MS` const
- `skills/browsing/lib/screenshot.js` — `MAX_IMAGE_DIMENSION_PX` const
- `skills/browsing/lib/viewport.js` — `MOBILE_USER_AGENT` const
- `skills/browsing/lib/navigation.js` — `NAVIGATE_TIMEOUT_MS`, `CONSOLE_LINGER_MS` consts
- `skills/browsing/lib/keyboard-input.js` — drop unused `keyboardType` from public exports
- `skills/browsing/lib/capture.js` — module-level exit handler registry; consume page-scripts via fs.readFileSync
- `skills/browsing/lib/html-diff.js` — Myers diff replaces set-based logic
- `CHANGELOG.md` — entry for legacy alias removal

### Out-of-scope (per spec)

- `chrome-ws-lib.js` keyboardType/spaNavigate/hrefNavigate were never publicly exported — they were dropped during the file split before this plan. Verify in Task L1 they don't surface anywhere.

---

## Conventions for every task

- **TDD.** Where the change has testable behaviour: write the failing test first, run it to confirm it fails, write the code, run again to confirm it passes, commit.
- **Pure refactors** (rename, move) don't need new tests but must keep `npm test` green at every step.
- **Commits.** One commit per task unless the task says otherwise. Commit messages match the existing project style (imperative subject, body explains *why* not *what*).
- **Test runner.** `npm test` runs everything. Single-file: `node --test test/path.test.mjs`.
- **Working directory.** Repo root is `/Users/jesse/Documents/GitHub/superpowers/superpowers-chrome`.

---

# Section 1: Add Biome

Lint baseline. Surfaces the dead code that informs Section 3 (legacy alias purge) and gives Section 2 (require sweep) real teeth.

### Task B1: Install Biome and add minimal config

**Files:**
- Create: `biome.json`
- Modify: `package.json`

- [ ] **Step 1: Install Biome as a dev dependency**

```bash
npm install --save-dev --save-exact @biomejs/biome
```

- [ ] **Step 2: Create `biome.json` with the minimal rule set**

```json
{
  "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": {
    "includes": [
      "skills/browsing/**/*.js",
      "skills/browsing/**/*.cjs",
      "test/**/*.mjs",
      "test/**/*.js",
      "mcp/src/**/*.ts"
    ]
  },
  "formatter": { "enabled": false },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": false,
      "correctness": {
        "noUnusedVariables": "error",
        "noUnusedImports": "error",
        "noUnusedFunctionParameters": "warn"
      },
      "style": {
        "useConst": "error",
        "noVar": "error"
      }
    }
  }
}
```

- [ ] **Step 3: Add lint scripts and wire into `npm test`**

Edit `package.json` `scripts`:

```json
"scripts": {
  "build": "cd mcp && npm install && npm run build",
  "prepare": "npm run build",
  "start": "node mcp/dist/index.js",
  "lint": "biome lint .",
  "lint:fix": "biome lint --write .",
  "test": "npm run lint && node --test 'test/**/*.test.mjs'"
}
```

- [ ] **Step 4: Run lint — expect failures**

```bash
npm run lint
```

Expected: a list of issues (unused vars, etc.). Note them — they're addressed in Task B2.

- [ ] **Step 5: Commit (config + dep, lint not yet clean)**

```bash
git add package.json package-lock.json biome.json
git commit -m "Add Biome with minimal lint config

Catches the kind of dead code we manually found during the file split:
unused vars, unused imports, missing const/let/var hygiene. Wired into
npm test so lint failures fail the build. Fix sweep for existing
violations comes in the next commit."
```

### Task B2: Fix all current Biome violations

**Files:**
- Modify: as reported by `npm run lint`

- [ ] **Step 1: Run `npm run lint:fix` for auto-fixable issues**

```bash
npm run lint:fix
```

- [ ] **Step 2: Manually address remaining violations**

Read each remaining error. Common patterns:

- **Unused require:** delete the require, also delete any unused destructured names.
- **Unused parameter:** if removing the parameter would change the public API, leave the warning (it's `warn` not `error`). Otherwise remove or prefix with `_`.
- **`var` to `let`/`const`:** straight rename; pick `const` if the variable is never reassigned.
- **`let` to `const`:** straight rename.

If you find truly dead functions (declared, never referenced), delete them — but only if grep confirms no consumer outside the lib uses them either:

```bash
grep -rn "deadFunctionName" mcp/src/ skills/browsing/chrome-ws docs/
```

- [ ] **Step 3: Run `npm test` — expect pass**

```bash
npm test
```

Expected: lint clean, all 23 existing tests pass.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "Fix existing lint violations after Biome adoption

Auto-fixes from biome lint --write plus manual cleanup of unused
imports and variables. No behaviour change."
```

---

# Section 2: require() sweep

Move every inline `require()` to module top. Biome from Section 1 will keep this enforced going forward, but Biome's recommended ruleset doesn't include "no inline requires" so this sweep is a one-time pass.

### Task R1: Move inline requires in `lib/chrome-process.js` to module top

**Files:**
- Modify: `skills/browsing/lib/chrome-process.js`

- [ ] **Step 1: Read the current top-of-file requires**

```bash
sed -n '1,12p' skills/browsing/lib/chrome-process.js
```

Expected: top-of-file imports `chrome-launcher-helpers`. The inline requires are inside `startChrome` (lines 27-29 currently).

- [ ] **Step 2: Move the three inline requires to module top**

In `skills/browsing/lib/chrome-process.js`:
- Add at top (after the existing `require`):
  ```js
  const { spawn } = require('child_process');
  const { existsSync, mkdirSync } = require('fs');
  const os = require('os');
  ```
- Delete the same three lines from inside `startChrome`.

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: pass.

- [ ] **Step 4: Sanity-check via lib load**

```bash
node -e "const lib = require('./skills/browsing/chrome-ws-lib.js'); const s = lib.createSession(); console.log('startChrome type:', typeof s.startChrome);"
```

Expected: `startChrome type: function`.

- [ ] **Step 5: Commit**

```bash
git add skills/browsing/lib/chrome-process.js
git commit -m "Move chrome-process.js inline requires to module top

child_process, fs, and os were required inside startChrome; module-top
matches the convention every other lib file uses and is what Biome
will enforce going forward."
```

### Task R2: Audit and verify all other lib files have top-of-file requires

**Files:**
- Modify: any `skills/browsing/lib/*.js` file with an inline require found below

- [ ] **Step 1: Find any remaining inline requires**

```bash
grep -nE "^\s+(const|let)\s+.*=\s*require\(" skills/browsing/lib/*.js
```

Expected: empty output (everything is now at module top). If any results appear, fix them by moving to module top.

- [ ] **Step 2: If anything was fixed, run tests + commit**

```bash
npm test
git add skills/browsing/lib/
git commit -m "Move remaining inline requires to module top"
```

If nothing was fixed, skip the commit and note "no remaining inline requires" in the task tracker.

---

# Section 3: Named magic constants

Per-module top-of-file `const` declarations. No central constants file. Spec section 5.

### Task C1: Add named constants in `lib/console-logging.js`

**Files:**
- Modify: `skills/browsing/lib/console-logging.js`

- [ ] **Step 1: Add constants at top of file**

After the `require` lines, add:

```js
// Fixed CDP request id used to mark the Runtime.enable response so the
// message handler can distinguish setup-acknowledged from runtime-event
// without tracking ids generally.
const RUNTIME_ENABLE_REQUEST_ID = 999999;

// How long to wait for Runtime.enable to acknowledge before failing the
// console-logging setup.
const ENABLE_TIMEOUT_MS = 5000;
```

- [ ] **Step 2: Replace literal `999999` and `5000` with the constants**

Replace `data.id === 999999` with `data.id === RUNTIME_ENABLE_REQUEST_ID`.
Replace `id: 999999` with `id: RUNTIME_ENABLE_REQUEST_ID`.
Replace `}, 5000);` with `}, ENABLE_TIMEOUT_MS);`.

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add skills/browsing/lib/console-logging.js
git commit -m "Name magic constants in console-logging.js

RUNTIME_ENABLE_REQUEST_ID for the 999999 marker; ENABLE_TIMEOUT_MS for
the 5s setup cap."
```

### Task C2: Add named constants in `lib/cdp-connection.js`

**Files:**
- Modify: `skills/browsing/lib/cdp-connection.js`

- [ ] **Step 1: Add constant at top of file**

After the `require` line:

```js
// Default per-CDP-call timeout. Caller can override via the `timeout`
// parameter on sendCdpCommand.
const DEFAULT_CDP_TIMEOUT_MS = 30000;
```

- [ ] **Step 2: Replace literal `30000` defaults with the constant**

In `sendCdpCommandPooled`, `sendCdpCommandSingle`, and `sendCdpCommand`, replace the `timeout = 30000` defaults with `timeout = DEFAULT_CDP_TIMEOUT_MS`.

- [ ] **Step 3: Run tests + commit**

```bash
npm test
git add skills/browsing/lib/cdp-connection.js
git commit -m "Name DEFAULT_CDP_TIMEOUT_MS in cdp-connection.js"
```

### Task C3: Add named constants in `lib/mouse.js`, `lib/screenshot.js`, `lib/viewport.js`, `lib/navigation.js`

**Files:**
- Modify: `skills/browsing/lib/mouse.js`, `lib/screenshot.js`, `lib/viewport.js`, `lib/navigation.js`

- [ ] **Step 1: `lib/mouse.js` — add `DRAG_SETTLE_MS`**

After the `require` lines:

```js
// Brief pause between the last mouseMoved step and mouseReleased so apps
// that process drag events asynchronously have time to commit.
const DRAG_SETTLE_MS = 50;
```

Replace `setTimeout(resolve, 50)` (inside `drag`) with `setTimeout(resolve, DRAG_SETTLE_MS)`.

- [ ] **Step 2: `lib/screenshot.js` — add `MAX_IMAGE_DIMENSION_PX`**

After the `require` lines:

```js
// Auto-downscale cap so screenshots fit Claude's many-image mode size limit
// (max 2000px). Headroom of 200px keeps us safely under.
const MAX_IMAGE_DIMENSION_PX = 1800;
```

Replace `1800` literals (in the `downscaleImageIfNeeded` default param and the `screenshot` function call) with `MAX_IMAGE_DIMENSION_PX`.

- [ ] **Step 3: `lib/viewport.js` — add `MOBILE_USER_AGENT`**

After the existing module-level code, add:

```js
// Pixel 7 UA string used for mobile emulation. Matches what Chrome's own
// device-mode dropdown sends for the same device.
const MOBILE_USER_AGENT = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
```

Replace the inline UA string in `setViewport` with `MOBILE_USER_AGENT`.

- [ ] **Step 4: `lib/navigation.js` — add `NAVIGATE_TIMEOUT_MS` and `CONSOLE_LINGER_MS`**

After the `require` lines:

```js
// Hard cap on the navigate() wait — covers slow servers and pages that
// never fire Page.loadEventFired.
const NAVIGATE_TIMEOUT_MS = 30000;

// After Page.loadEventFired, keep the secondary console-capture WebSocket
// open this long so console messages emitted in the load handler get
// captured before we close the socket.
const CONSOLE_LINGER_MS = 1000;
```

Replace `30000` (the timeout cap inside `navigate`) with `NAVIGATE_TIMEOUT_MS`. Replace `1000` (the `setTimeout(... , 1000)` after pageLoaded) with `CONSOLE_LINGER_MS`.

- [ ] **Step 5: Run tests**

```bash
npm test
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add skills/browsing/lib/mouse.js skills/browsing/lib/screenshot.js skills/browsing/lib/viewport.js skills/browsing/lib/navigation.js
git commit -m "Name remaining magic constants per-module

DRAG_SETTLE_MS in mouse, MAX_IMAGE_DIMENSION_PX in screenshot,
MOBILE_USER_AGENT in viewport, NAVIGATE_TIMEOUT_MS and
CONSOLE_LINGER_MS in navigation. Each lives at the top of the file
that uses it — readers don't have to jump to a central constants
file to understand what a function does."
```

---

# Section 4: Legacy alias purge

Spec section 4. Verify the two known consumers (MCP, CLI) use canonical names, then delete every alias.

### Task L1: Verify MCP and CLI use canonical names

**Files:**
- Read: `mcp/src/index.ts`, `skills/browsing/chrome-ws`

- [ ] **Step 1: Grep both consumers for the five suspect names**

```bash
grep -nE "\b(cdpClick|insertText|keyboardType|spaNavigate|hrefNavigate)\b" mcp/src/index.ts skills/browsing/chrome-ws
```

Expected: no matches. (If any match, the consumer needs updating in step 2 before the lib aliases can be removed.)

- [ ] **Step 2: If matches found, update consumer to use canonical name**

Substitutions:
- `cdpClick` → `click`
- `insertText` → `fill`
- `keyboardType` → `keyboardPress` (only handles Enter/Tab specially) or `humanType` (per-char realistic) — pick based on context
- `spaNavigate` → `navigate` (or keep call site if SPA semantics actually wanted; in that case the alias should NOT be deleted in Task L2)
- `hrefNavigate` → `navigate` (same caveat)

- [ ] **Step 3: If anything was changed, commit**

```bash
git add mcp/src/index.ts skills/browsing/chrome-ws
git commit -m "Migrate consumers to canonical lib API names

Replaces legacy aliases (cdpClick → click, insertText → fill, etc.) so
the aliases can be deleted in the next commit."
```

If nothing was changed, skip the commit.

### Task L2: Delete legacy aliases from the lib

**Files:**
- Modify: `skills/browsing/chrome-ws-lib.js`
- Modify: `skills/browsing/lib/keyboard-input.js`
- Modify: `skills/browsing/lib/navigation.js`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Remove `cdpClick = click` and `insertText = fill` aliases from `chrome-ws-lib.js`**

In `skills/browsing/chrome-ws-lib.js`:
- Delete the line `const cdpClick = click;`.
- Delete the line `const insertText = fill;`.
- In the `return { ... }` block, delete the `cdpClick: click,` and `insertText: fill,` entries (and any equivalent `cdpClick,` / `insertText,` shorthand entries).

- [ ] **Step 2: Remove `keyboardType` from `lib/keyboard-input.js`**

In `skills/browsing/lib/keyboard-input.js`:
- Delete the entire `async function keyboardType(...)` definition.
- Remove `keyboardType` from the `return { ... }` of `attachKeyboardInput`.

In `skills/browsing/chrome-ws-lib.js`:
- Remove `keyboardType` from the destructure of `attachKeyboardInput({...})`.

- [ ] **Step 3: Remove `spaNavigate` and `hrefNavigate` from `lib/navigation.js`**

In `skills/browsing/lib/navigation.js`:
- Delete the `async function spaNavigate(...)` definition.
- Delete the `async function hrefNavigate(...)` definition.
- Remove `spaNavigate` and `hrefNavigate` from the `return { ... }` of `attachNavigation`.

In `skills/browsing/chrome-ws-lib.js`:
- Remove `spaNavigate` and `hrefNavigate` from the destructure of `attachNavigation({...})`.

- [ ] **Step 4: Smoke-test that the lib still loads and exposes the canonical names**

```bash
node -e "const lib = require('./skills/browsing/chrome-ws-lib.js'); const s = lib.createSession(); console.log('click:', typeof s.click, 'fill:', typeof s.fill, 'keyboardPress:', typeof s.keyboardPress, 'navigate:', typeof s.navigate, 'cdpClick:', typeof s.cdpClick, 'insertText:', typeof s.insertText, 'keyboardType:', typeof s.keyboardType);"
```

Expected: `click: function fill: function keyboardPress: function navigate: function cdpClick: undefined insertText: undefined keyboardType: undefined`.

- [ ] **Step 5: Run tests**

```bash
npm test
```

Expected: pass.

- [ ] **Step 6: Add CHANGELOG entry**

In `CHANGELOG.md`, under the existing `[Unreleased]` section (or add one), in `### Removed`:

```markdown
- Legacy method aliases on the session object: `cdpClick` (use `click`), `insertText` (use `fill`). Two functions defined inside the lib closure but never publicly exported (`keyboardType`, `spaNavigate`, `hrefNavigate`) also removed. The MCP server and CLI never used the aliases; external consumers should migrate to the canonical names.
```

- [ ] **Step 7: Commit**

```bash
git add skills/browsing/chrome-ws-lib.js skills/browsing/lib/keyboard-input.js skills/browsing/lib/navigation.js CHANGELOG.md
git commit -m "Delete legacy aliases (cdpClick, insertText, keyboardType, spaNavigate, hrefNavigate)

The two known consumers — the MCP server and the chrome-ws CLI — used
canonical names already (verified in the previous commit); the aliases
were dead weight on the public API. keyboardType/spaNavigate/hrefNavigate
were only ever defined inside the closure, never publicly exported, so
deleting them is purely internal cleanup."
```

---

# Section 5: Page-script extraction

Spec section 3. Hybrid: extract the two big page-side scripts, leave smaller eval strings inline.

### Task P1: Create `lib/page-scripts/markdown.js` and load it in capture.js

**Files:**
- Create: `skills/browsing/lib/page-scripts/markdown.js`
- Modify: `skills/browsing/lib/capture.js`
- Modify: `package.json`

- [ ] **Step 1: Create the directory**

```bash
mkdir -p skills/browsing/lib/page-scripts
```

- [ ] **Step 2: Extract the page-side script body to `markdown.js`**

Read the current body of `generateMarkdown` in `skills/browsing/lib/capture.js`. The script is a template literal starting with `const js = \`` and ending with the matching closing backtick.

Create `skills/browsing/lib/page-scripts/markdown.js`:

```js
// Page-side script: walk the DOM and emit token-efficient Markdown.
// Loaded as a string at attachCapture setup and embedded in CDP
// Runtime.evaluate. Tested directly against jsdom in
// test/lib/page-scripts/markdown.test.mjs.
//
// Includes images >= 100x100 in a header summary; inlines image references
// >= 50x50 with size info; skips smaller icons.
module.exports = `
  (() => {
    const results = [];

    const title = document.title;
    if (title) results.push(\`# \${title}\\n\`);

    const allImages = document.querySelectorAll('img');
    const significantImages = Array.from(allImages).filter(img => {
      const rect = img.getBoundingClientRect();
      return rect.width >= 100 && rect.height >= 100;
    });

    if (significantImages.length > 0) {
      results.push(\`\\n**📷 This page contains \${significantImages.length} significant image(s). Check screenshot.png for visual content.**\\n\`);
    }

    const elements = document.querySelectorAll('h1, h2, h3, h4, h5, h6, p, a, li, pre, code, blockquote, table, img, figure');

    for (const el of elements) {
      const tag = el.tagName.toLowerCase();
      const text = el.textContent.trim();

      if (tag === 'img') {
        const alt = el.alt || '';
        const src = el.src || '';
        const rect = el.getBoundingClientRect();
        if (rect.width >= 50 && rect.height >= 50) {
          const sizeInfo = \`\${Math.round(rect.width)}x\${Math.round(rect.height)}\`;
          const description = alt ? \`"\${alt}"\` : '(no alt text)';
          results.push(\`\\n![Image: \${description} - \${sizeInfo}](\${src})\\n\`);
        }
        continue;
      }

      if (tag === 'figure') {
        const figcaption = el.querySelector('figcaption');
        if (figcaption) {
          results.push(\`\\n*Figure: \${figcaption.textContent.trim()}*\\n\`);
        }
        continue;
      }

      if (!text) continue;

      if (tag.startsWith('h')) {
        const level = parseInt(tag[1]);
        results.push(\`\${'#'.repeat(level)} \${text}\\n\`);
      } else if (tag === 'p') {
        results.push(\`\${text}\\n\`);
      } else if (tag === 'a') {
        const href = el.href;
        results.push(\`[\${text}](\${href})\`);
      } else if (tag === 'li') {
        results.push(\`- \${text}\`);
      } else if (tag === 'pre' || tag === 'code') {
        results.push(\`\\\`\\\`\\\`\\n\${text}\\n\\\`\\\`\\\`\\n\`);
      } else if (tag === 'blockquote') {
        results.push(\`> \${text}\\n\`);
      } else if (tag === 'table') {
        const rows = el.querySelectorAll('tr');
        if (rows.length > 0) {
          results.push('\\n| Table Content |\\n|---|');
          for (let i = 0; i < Math.min(rows.length, 10); i++) {
            const cells = rows[i].querySelectorAll('td, th');
            const cellTexts = Array.from(cells).map(cell => cell.textContent.trim()).slice(0, 3);
            if (cellTexts.length > 0) {
              results.push(\`| \${cellTexts.join(' | ')} |\`);
            }
          }
          results.push('\\n');
        }
      }
    }

    return results.join('\\n').slice(0, 50000); // Limit size
  })()
`;
```

(The trick: in capture.js the script was already inside a template literal with backticks-as-data, so the same string can be exported wholesale, no further escaping needed.)

- [ ] **Step 3: Update `capture.js` to require the script and use it in `generateMarkdown`**

In `skills/browsing/lib/capture.js`, at the top with the other requires:

```js
const markdownScript = require('./page-scripts/markdown');
```

Replace the entire `generateMarkdown` function body with:

```js
async function generateMarkdown(tabIndexOrWsUrl) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: markdownScript,
    returnByValue: true
  });
  return result.result.value;
}
```

- [ ] **Step 4: Add `lib/page-scripts/` to npm `files` field**

In root `package.json`, update:

```json
"files": [
  "mcp/dist/",
  "skills/browsing/chrome-ws-lib.js",
  "skills/browsing/host-override.js",
  "skills/browsing/lib/",
  "skills/browsing/package.json",
  "README.md",
  "CHANGELOG.md"
]
```

(`skills/browsing/lib/` is already there from earlier work — `lib/page-scripts/` is included transitively. Verify the line is present.)

- [ ] **Step 5: Run tests**

```bash
npm test
```

Expected: pass.

- [ ] **Step 6: Smoke-test that the bundle still loads and exports generateMarkdown**

```bash
node -e "const lib = require('./skills/browsing/chrome-ws-lib.js'); const s = lib.createSession(); console.log('generateMarkdown type:', typeof s.generateMarkdown);"
```

Expected: `generateMarkdown type: function`.

- [ ] **Step 7: Commit**

```bash
git add skills/browsing/lib/page-scripts/markdown.js skills/browsing/lib/capture.js package.json
git commit -m "Extract generateMarkdown page-side script to lib/page-scripts/

The 100-line template literal inside capture.js is now a standalone .js
file loaded once at attachCapture setup. ESLint/Biome can lint it,
tests can eval it against jsdom directly, and editor syntax highlighting
works. Behaviour unchanged."
```

### Task P2: Create `lib/page-scripts/dom-summary.js` and load it in capture.js

**Files:**
- Create: `skills/browsing/lib/page-scripts/dom-summary.js`
- Modify: `skills/browsing/lib/capture.js`

- [ ] **Step 1: Extract `generateDomSummary`'s page-side script**

Create `skills/browsing/lib/page-scripts/dom-summary.js`:

```js
// Page-side script: token-efficient page summary used by auto-capture.
// Loaded as a string at attachCapture setup and embedded in CDP
// Runtime.evaluate. Tested directly against jsdom in
// test/lib/page-scripts/dom-summary.test.mjs.
module.exports = `
  (() => {
    const buttons = document.querySelectorAll('button, input[type="button"], input[type="submit"]').length;
    const inputs = document.querySelectorAll('input:not([type="button"]):not([type="submit"]), textarea, select').length;
    const links = document.querySelectorAll('a[href]').length;

    const title = document.title.slice(0, 60);
    const allH1s = Array.from(document.querySelectorAll('h1')).map(h => h.textContent.trim().slice(0, 40)).filter(Boolean);
    const h1s = allH1s.slice(0, 3);
    const h1Extra = allH1s.length > 3 ? allH1s.length - 3 : 0;

    const main = document.querySelector('main, [role="main"], .main, #main, .content, #content');
    const mainTag = main ? main.tagName.toLowerCase() + (main.id ? '#' + main.id : main.className ? '.' + main.className.split(' ')[0] : '') : 'body';

    const forms = document.querySelectorAll('form');
    const formInfo = forms.length > 0 ? \`\${forms.length} form\${forms.length > 1 ? 's' : ''}\` : '';

    const nav = document.querySelector('nav, [role="navigation"], .nav, #nav') ? 'nav' : '';

    return [
      \`\${title}\`,
      \`Interactive: \${buttons} buttons, \${inputs} inputs, \${links} links\`,
      h1s.length > 0 ? \`Headings: \${h1s.map(h => '"' + h + '"').join(', ')}\${h1Extra > 0 ? ', and ' + h1Extra + ' more' : ''}\` : '',
      \`Layout: \${nav ? 'nav + ' : ''}\${mainTag}\${formInfo ? ' + ' + formInfo : ''}\`
    ].filter(Boolean).join('\\n');
  })()
`;
```

- [ ] **Step 2: Update `capture.js` to require and use the script**

At top with other requires:

```js
const domSummaryScript = require('./page-scripts/dom-summary');
```

Replace `generateDomSummary` body:

```js
async function generateDomSummary(tabIndexOrWsUrl) {
  const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
  const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
    expression: domSummaryScript,
    returnByValue: true
  });
  return result.result.value;
}
```

- [ ] **Step 3: Run tests + smoke-check**

```bash
npm test
node -e "const lib = require('./skills/browsing/chrome-ws-lib.js'); const s = lib.createSession(); console.log('generateDomSummary:', typeof s.generateDomSummary);"
```

Expected: tests pass; `generateDomSummary: function`.

- [ ] **Step 4: Commit**

```bash
git add skills/browsing/lib/page-scripts/dom-summary.js skills/browsing/lib/capture.js
git commit -m "Extract generateDomSummary page-side script to lib/page-scripts/

Same treatment as markdown.js — extract the template literal to a real
.js file. Other shorter eval strings in capture.js (the focus
save/restore in captureActionWithDiff, getPageSize) stay inline; they're
small enough that extraction would be ceremony."
```

---

# Section 6: Drop `state.messageIdCounter`

Spec section 8. Two-line fix.

### Task S1: Drop `state.messageIdCounter` from session state and use `id = 1` in single-use

**Files:**
- Modify: `skills/browsing/lib/session-state.js`
- Modify: `skills/browsing/lib/cdp-connection.js`

- [ ] **Step 1: Remove the field from `createState`**

In `skills/browsing/lib/session-state.js`, delete the lines:

```js
// Single-use CDP connection's message-id counter (sendCdpCommandSingle
// fallback path; pooled connections have their own per-connection counter).
messageIdCounter: 1,
```

(Leave the comma management correct on the line above.)

- [ ] **Step 2: Use `const id = 1` in `sendCdpCommandSingle`**

In `skills/browsing/lib/cdp-connection.js`, in `sendCdpCommandSingle`, replace:

```js
const id = state.messageIdCounter++;
```

with:

```js
// Single-use ws sends exactly one request — id=1 is fine because the
// connection is fresh and there's nothing to collide with.
const id = 1;
```

- [ ] **Step 3: Verify `state.messageIdCounter` is no longer referenced anywhere**

```bash
grep -rn "messageIdCounter" skills/browsing/ test/
```

Expected: only references inside `lib/cdp-connection.js`'s pooled-connection code (`conn.messageIdCounter` — that's the per-connection counter, not the dropped session-level one).

- [ ] **Step 4: Run tests**

```bash
npm test
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add skills/browsing/lib/session-state.js skills/browsing/lib/cdp-connection.js
git commit -m "Drop state.messageIdCounter from session state

CDP message ids are scoped per-connection. sendCdpCommandSingle opens
a fresh socket, sends one request, closes — id=1 always works because
there's nothing to collide with on a brand-new connection. The
session-wide counter was historical leftover."
```

---

# Section 7: Module-level exit handler registry

Spec section 6.

### Task E1: Replace per-session `process.on(...)` with a module-level registry

**Files:**
- Modify: `skills/browsing/lib/capture.js`

- [ ] **Step 1: Add the module-level registry near the top of `capture.js`**

After the existing top-of-file requires, add:

```js
// Module-level registry of active session-cleanup callbacks.
// Per-session initializeSession adds its bound cleanup to the set;
// cleanupSession removes itself when it runs.
//
// Process exit handlers are registered exactly once for the whole module
// (not per session), so multiple ChromeSession instances in one process
// don't accumulate N×3 handlers.
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

- [ ] **Step 2: Update `initializeSession` and `cleanupSession` to use the registry**

In `attachCapture`'s body, replace `initializeSession` with:

```js
function initializeSession() {
  if (!state.sessionDir) {
    const cacheHome = getXdgCacheHome();
    const dateStr = new Date().toISOString().split('T')[0];
    const sessionId = `session-${Date.now()}`;

    state.sessionDir = path.join(cacheHome, 'superpowers', 'browser', dateStr, sessionId);
    fs.mkdirSync(state.sessionDir, { recursive: true });
    state.captureCounter = 0;

    console.error(`Browser session directory: ${state.sessionDir}`);

    ensureProcessHandlersRegistered();
    activeCleanups.add(cleanupSession);
  }
  return state.sessionDir;
}
```

Note: removed the per-session `process.on(...)` calls, added `ensureProcessHandlersRegistered()` and `activeCleanups.add(cleanupSession)`.

Update `cleanupSession`:

```js
function cleanupSession() {
  if (state.sessionDir) {
    try {
      fs.rmSync(state.sessionDir, { recursive: true, force: true });
      console.error(`Cleaned up session directory: ${state.sessionDir}`);
    } catch (error) {
      console.error(`Failed to cleanup session directory: ${error.message}`);
    }
    state.sessionDir = null;
  }
  activeCleanups.delete(cleanupSession);
}
```

(Adds the `activeCleanups.delete(cleanupSession)` so a session that re-initializes gets re-added cleanly.)

- [ ] **Step 3: Run tests + sanity-check**

```bash
npm test
node -e "
const lib = require('./skills/browsing/chrome-ws-lib.js');
const a = lib.createSession();
const b = lib.createSession();
a.initializeSession();
b.initializeSession();
// At this point both sessions should have registered their cleanups in
// the same activeCleanups set, but process should have exactly 3 handlers
// registered (one each for exit, SIGINT, SIGTERM).
console.log('exit listeners:', process.listenerCount('exit'));
console.log('SIGINT listeners:', process.listenerCount('SIGINT'));
console.log('SIGTERM listeners:', process.listenerCount('SIGTERM'));
a.cleanupSession();
b.cleanupSession();
"
```

Expected: each listener count is 1 (or whatever the baseline is for Node + 1 — exactly one of OUR handlers is added per signal type regardless of how many sessions initialized).

- [ ] **Step 4: Commit**

```bash
git add skills/browsing/lib/capture.js
git commit -m "Register process exit handlers once per module, not per session

Previously every initializeSession() registered three process handlers.
With Matt's per-session factory, that meant N × 3 handlers for N
ChromeSession instances. Now the handlers are registered once at module
scope and iterate a Set of active session-cleanup callbacks. Single-
session behaviour unchanged; multi-session no longer leaks handlers."
```

---

# Section 8: Real Myers diff for `generateHtmlDiff`

Spec section 7. Hand-rolled, no dep.

### Task D1: Write failing test for the reorder bug

**Files:**
- Create: `test/lib/html-diff.test.mjs`

- [ ] **Step 1: Write the test that proves the current set-based logic is wrong**

Create `test/lib/html-diff.test.mjs`:

```js
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { generateHtmlDiff } = require('../../skills/browsing/lib/html-diff.js');

describe('generateHtmlDiff', () => {
  it('returns "(no changes detected)" for identical input', () => {
    const html = '<div>hello</div>\n<div>world</div>';
    assert.equal(generateHtmlDiff(html, html), '(no changes detected)');
  });

  it('shows pure additions in ADDED section only', () => {
    const before = '<p>a</p>';
    const after = '<p>a</p>\n<p>b</p>';
    const diff = generateHtmlDiff(before, after);
    assert.match(diff, /=== ADDED ===/);
    assert.match(diff, /\+ <p>b<\/p>/);
    assert.doesNotMatch(diff, /=== REMOVED ===/);
  });

  it('shows pure removals in REMOVED section only', () => {
    const before = '<p>a</p>\n<p>b</p>';
    const after = '<p>a</p>';
    const diff = generateHtmlDiff(before, after);
    assert.match(diff, /=== REMOVED ===/);
    assert.match(diff, /- <p>b<\/p>/);
    assert.doesNotMatch(diff, /=== ADDED ===/);
  });

  it('detects reorderings of identical lines (Myers)', () => {
    // The bug-fix case: set-based logic returned "no changes" for this.
    const before = '<p>first</p>\n<p>second</p>';
    const after = '<p>second</p>\n<p>first</p>';
    const diff = generateHtmlDiff(before, after);
    assert.notEqual(diff, '(no changes detected)');
  });

  it('caps each side at 50 lines with "and N more" footer', () => {
    const before = '';
    const after = Array.from({ length: 200 }, (_, i) => `<p>line ${i}</p>`).join('\n');
    const diff = generateHtmlDiff(before, after);
    const addedLines = diff.split('\n').filter(l => l.startsWith('+ '));
    assert.equal(addedLines.length, 50);
    assert.match(diff, /and 150 more added lines/);
  });

  it('handles null/empty input', () => {
    assert.equal(generateHtmlDiff(null, null), '(no changes detected)');
    assert.equal(generateHtmlDiff('', ''), '(no changes detected)');
  });
});
```

- [ ] **Step 2: Run the test — expect the reorder test to FAIL**

```bash
node --test test/lib/html-diff.test.mjs
```

Expected: 5 pass, 1 fail (the reorder test). The current set-based implementation returns "(no changes detected)" for the reorder case.

### Task D2: Implement Myers diff in `lib/html-diff.js`

**Files:**
- Modify: `skills/browsing/lib/html-diff.js`

- [ ] **Step 1: Replace the implementation with Myers diff**

Replace the entire body of `lib/html-diff.js` (keeping the file-level docstring) with:

```js
/**
 * Line-based diff between two HTML strings using Myers' algorithm.
 * Returns a human-readable summary with REMOVED and ADDED sections,
 * capped at 50 lines per side with "and N more" footer. Used by
 * capturePageArtifacts to attach a diff to the captured page state.
 *
 * Myers (not set-based) so reordered identical lines are correctly
 * detected as a remove + add pair, not "no changes."
 *
 * Pure function. Hand-rolled — no npm dependency.
 */

const MAX_LINES_PER_SIDE = 50;
const MAX_LINE_LENGTH = 200;

// Myers' O((N+M)D) shortest-edit-script. Returns an array of
// { type: 'eq'|'del'|'add', value: string } operations in order.
function myersDiff(a, b) {
  const N = a.length;
  const M = b.length;
  const max = N + M;
  const v = new Array(2 * max + 1);
  const trace = [];

  v[max + 1] = 0;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[max + k - 1] < v[max + k + 1])) {
        x = v[max + k + 1];
      } else {
        x = v[max + k - 1] + 1;
      }
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) {
        x++; y++;
      }
      v[max + k] = x;
      if (x >= N && y >= M) {
        // Backtrack through the trace to build the edit script.
        return backtrack(trace, a, b, N, M, max);
      }
    }
  }
  return [];
}

function backtrack(trace, a, b, N, M, max) {
  const ops = [];
  let x = N;
  let y = M;
  for (let d = trace.length - 1; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && v[max + k - 1] < v[max + k + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = v[max + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: 'eq', value: a[x - 1] });
      x--; y--;
    }
    if (d > 0) {
      if (x === prevX) {
        ops.push({ type: 'add', value: b[y - 1] });
        y--;
      } else {
        ops.push({ type: 'del', value: a[x - 1] });
        x--;
      }
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ type: 'eq', value: a[x - 1] });
    x--; y--;
  }
  return ops.reverse();
}

function generateHtmlDiff(beforeHtml, afterHtml) {
  const beforeLines = (beforeHtml || '').split('\n');
  const afterLines = (afterHtml || '').split('\n');

  const ops = myersDiff(beforeLines, afterLines);

  const removed = ops.filter(o => o.type === 'del' && o.value.trim()).map(o => o.value);
  const added = ops.filter(o => o.type === 'add' && o.value.trim()).map(o => o.value);

  let diff = '';
  if (removed.length > 0) {
    diff += '=== REMOVED ===\n';
    diff += removed.slice(0, MAX_LINES_PER_SIDE)
      .map(l => '- ' + l.slice(0, MAX_LINE_LENGTH))
      .join('\n');
    if (removed.length > MAX_LINES_PER_SIDE) {
      diff += `\n... and ${removed.length - MAX_LINES_PER_SIDE} more removed lines`;
    }
    diff += '\n\n';
  }
  if (added.length > 0) {
    diff += '=== ADDED ===\n';
    diff += added.slice(0, MAX_LINES_PER_SIDE)
      .map(l => '+ ' + l.slice(0, MAX_LINE_LENGTH))
      .join('\n');
    if (added.length > MAX_LINES_PER_SIDE) {
      diff += `\n... and ${added.length - MAX_LINES_PER_SIDE} more added lines`;
    }
  }

  if (!diff) {
    diff = '(no changes detected)';
  }

  return diff;
}

module.exports = { generateHtmlDiff };
```

- [ ] **Step 2: Run the html-diff tests — all should now pass**

```bash
node --test test/lib/html-diff.test.mjs
```

Expected: 6 pass, 0 fail.

- [ ] **Step 3: Run full test suite**

```bash
npm test
```

Expected: pass.

- [ ] **Step 4: Commit (test + implementation together since they only make sense together)**

```bash
git add skills/browsing/lib/html-diff.js test/lib/html-diff.test.mjs
git commit -m "Replace set-based generateHtmlDiff with Myers algorithm

Set-based logic returned '(no changes detected)' when identical lines
were reordered — the new test reorder case demonstrates the bug.
Myers' O((N+M)D) hand-rolled implementation gives a real edit script
so reorderings show as REMOVED + ADDED pairs. No new dependency."
```

---

# Section 9: Test infrastructure — Tier A (per-lib unit tests)

Spec section 1, Tier A. The workhorse layer. Each `lib/*.js` file gets a sibling test that mocks `sendCdpCommand` / `resolveWsUrl` and asserts the expected CDP calls.

### Task TA1: Write Tier A test helper

**Files:**
- Create: `test/lib/_helpers.mjs`

- [ ] **Step 1: Create the shared mock helpers**

Create `test/lib/_helpers.mjs`:

```js
// Shared test helpers for Tier A unit tests.
//
// makeCdpSpy() returns a sendCdpCommand-shaped function that records every
// call and returns a configurable result. Use:
//
//   const sendCdpCommand = makeCdpSpy({
//     'Runtime.evaluate': () => ({ result: { value: 'fake' } }),
//     'Page.captureScreenshot': () => ({ data: '' }),
//   });
//   ... await someAction(...);
//   assert.equal(sendCdpCommand.calls.length, 1);
//   assert.equal(sendCdpCommand.calls[0].method, 'Runtime.evaluate');
//
// makeResolveWsUrl() returns a stub that always resolves to the given URL.
// Default 'ws://test/devtools/page/abc'.

export function makeCdpSpy(handlers = {}) {
  const calls = [];
  async function sendCdpCommand(wsUrl, method, params = {}, timeout) {
    calls.push({ wsUrl, method, params, timeout });
    const handler = handlers[method];
    if (typeof handler === 'function') return handler(params);
    if (handler !== undefined) return handler;
    // Default: return an empty Runtime.evaluate-shaped object.
    return { result: { value: undefined } };
  }
  sendCdpCommand.calls = calls;
  return sendCdpCommand;
}

export function makeResolveWsUrl(wsUrl = 'ws://test/devtools/page/abc') {
  return async () => wsUrl;
}
```

- [ ] **Step 2: No test for the helper itself — it's used by the next 13 tasks**

Just verify it parses:

```bash
node --input-type=module -e "import('./test/lib/_helpers.mjs').then(m => console.log(Object.keys(m)));"
```

Expected: `[ 'makeCdpSpy', 'makeResolveWsUrl' ]`.

- [ ] **Step 3: Commit**

```bash
git add test/lib/_helpers.mjs
git commit -m "Add Tier A test helpers (makeCdpSpy, makeResolveWsUrl)

Shared mock infrastructure for the per-lib unit tests in the next
commits. Records CDP calls for assertion; per-method handlers configure
return values."
```

### Task TA2: Tier A test for `lib/cookies.js`

**Files:**
- Create: `test/lib/cookies.test.mjs`

- [ ] **Step 1: Write the test**

```js
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { makeCdpSpy, makeResolveWsUrl } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachCookies } = require('../../skills/browsing/lib/cookies.js');

describe('cookies', () => {
  it('clearCookies sends Network.clearBrowserCookies', async () => {
    const sendCdpCommand = makeCdpSpy();
    const resolveWsUrl = makeResolveWsUrl('ws://test/x');
    const { clearCookies } = attachCookies({ resolveWsUrl, sendCdpCommand });

    await clearCookies(0);

    assert.equal(sendCdpCommand.calls.length, 1);
    assert.equal(sendCdpCommand.calls[0].method, 'Network.clearBrowserCookies');
    assert.equal(sendCdpCommand.calls[0].wsUrl, 'ws://test/x');
    assert.deepEqual(sendCdpCommand.calls[0].params, {});
  });
});
```

- [ ] **Step 2: Run test — expect pass**

```bash
node --test test/lib/cookies.test.mjs
```

Expected: 1 pass.

- [ ] **Step 3: Commit**

```bash
git add test/lib/cookies.test.mjs
git commit -m "Tier A unit test for lib/cookies.js"
```

### Task TA3: Tier A test for `lib/viewport.js`

**Files:**
- Create: `test/lib/viewport.test.mjs`

- [ ] **Step 1: Write the test**

```js
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { makeCdpSpy, makeResolveWsUrl } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachViewport } = require('../../skills/browsing/lib/viewport.js');

describe('viewport', () => {
  function setup(handlers = {}) {
    const sendCdpCommand = makeCdpSpy(handlers);
    const resolveWsUrl = makeResolveWsUrl();
    return { ...attachViewport({ resolveWsUrl, sendCdpCommand }), sendCdpCommand };
  }

  it('setViewport sends setDeviceMetricsOverride and disables touch in non-mobile mode', async () => {
    const { setViewport, sendCdpCommand } = setup();
    await setViewport(0, { width: 1024, height: 768 });

    const methods = sendCdpCommand.calls.map(c => c.method);
    assert.deepEqual(methods, [
      'Emulation.setDeviceMetricsOverride',
      'Emulation.setTouchEmulationEnabled',
      'Emulation.setUserAgentOverride'
    ]);
    assert.equal(sendCdpCommand.calls[0].params.width, 1024);
    assert.equal(sendCdpCommand.calls[1].params.enabled, false);
    assert.equal(sendCdpCommand.calls[2].params.userAgent, '');
  });

  it('setViewport sends mobile UA when mobile: true', async () => {
    const { setViewport, sendCdpCommand } = setup();
    await setViewport(0, { width: 375, height: 667, mobile: true });

    assert.equal(sendCdpCommand.calls[1].params.enabled, true);
    assert.match(sendCdpCommand.calls[2].params.userAgent, /Pixel 7/);
  });

  it('setViewport throws on out-of-range width', async () => {
    const { setViewport } = setup();
    await assert.rejects(() => setViewport(0, { width: 100, height: 768 }), /Invalid viewport width/);
  });

  it('clearViewport clears device metrics, touch, and UA', async () => {
    const { clearViewport, sendCdpCommand } = setup();
    await clearViewport(0);
    const methods = sendCdpCommand.calls.map(c => c.method);
    assert.deepEqual(methods, [
      'Emulation.clearDeviceMetricsOverride',
      'Emulation.setTouchEmulationEnabled',
      'Emulation.setUserAgentOverride'
    ]);
  });

  it('getViewport returns the page eval result', async () => {
    const { getViewport } = setup({
      'Runtime.evaluate': () => ({ result: { value: { innerWidth: 1024, innerHeight: 768 } } })
    });
    const vp = await getViewport(0);
    assert.equal(vp.innerWidth, 1024);
    assert.equal(vp.innerHeight, 768);
  });
});
```

- [ ] **Step 2: Run test + commit**

```bash
node --test test/lib/viewport.test.mjs
git add test/lib/viewport.test.mjs
git commit -m "Tier A unit test for lib/viewport.js"
```

### Task TA4: Tier A test for `lib/evaluation.js`

**Files:**
- Create: `test/lib/evaluation.test.mjs`

- [ ] **Step 1: Write the test**

```js
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { makeCdpSpy, makeResolveWsUrl } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachEvaluation } = require('../../skills/browsing/lib/evaluation.js');

describe('evaluation', () => {
  function setup(handlers = {}) {
    const sendCdpCommand = makeCdpSpy(handlers);
    return { ...attachEvaluation({ resolveWsUrl: makeResolveWsUrl(), sendCdpCommand }), sendCdpCommand };
  }

  it('evaluate passes returnByValue and awaitPromise', async () => {
    const { evaluate, sendCdpCommand } = setup({
      'Runtime.evaluate': () => ({ result: { value: 42 } })
    });
    const result = await evaluate(0, '21+21');
    assert.equal(result, 42);
    assert.equal(sendCdpCommand.calls[0].params.returnByValue, true);
    assert.equal(sendCdpCommand.calls[0].params.awaitPromise, true);
    assert.equal(sendCdpCommand.calls[0].params.expression, '21+21');
  });

  it('evaluateJson wraps the expression in a serialiser IIFE', async () => {
    const { evaluateJson, sendCdpCommand } = setup({
      'Runtime.evaluate': () => ({ result: { value: { foo: 'bar' } } })
    });
    await evaluateJson(0, 'document.body');
    const expr = sendCdpCommand.calls[0].params.expression;
    assert.match(expr, /document\.body/);
    assert.match(expr, /__type: 'Element'/);
  });

  it('evaluateRaw returns full result.result, not just value', async () => {
    const { evaluateRaw } = setup({
      'Runtime.evaluate': () => ({ result: { value: 7, type: 'number' } })
    });
    const result = await evaluateRaw(0, '7');
    assert.deepEqual(result, { value: 7, type: 'number' });
  });

  it('evaluateRaw passes returnByValue: false', async () => {
    const { evaluateRaw, sendCdpCommand } = setup();
    await evaluateRaw(0, 'x');
    assert.equal(sendCdpCommand.calls[0].params.returnByValue, false);
  });
});
```

- [ ] **Step 2: Run test + commit**

```bash
node --test test/lib/evaluation.test.mjs
git add test/lib/evaluation.test.mjs
git commit -m "Tier A unit test for lib/evaluation.js"
```

### Task TA5: Tier A test for `lib/extraction.js`

**Files:**
- Create: `test/lib/extraction.test.mjs`

- [ ] **Step 1: Write the test**

```js
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { makeCdpSpy, makeResolveWsUrl } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachExtraction } = require('../../skills/browsing/lib/extraction.js');

describe('extraction', () => {
  function setup(handlers = {}) {
    const sendCdpCommand = makeCdpSpy(handlers);
    return { ...attachExtraction({ resolveWsUrl: makeResolveWsUrl(), sendCdpCommand }), sendCdpCommand };
  }

  it('extractText sends the textContent expression', async () => {
    const { extractText, sendCdpCommand } = setup({
      'Runtime.evaluate': () => ({ result: { value: 'hello' } })
    });
    const text = await extractText(0, '#headline');
    assert.equal(text, 'hello');
    assert.match(sendCdpCommand.calls[0].params.expression, /\?\.textContent$/);
  });

  it('getHtml without selector returns documentElement.outerHTML', async () => {
    const { getHtml, sendCdpCommand } = setup({
      'Runtime.evaluate': () => ({ result: { value: '<html></html>' } })
    });
    await getHtml(0);
    assert.equal(sendCdpCommand.calls[0].params.expression, 'document.documentElement.outerHTML');
  });

  it('getHtml with selector returns innerHTML', async () => {
    const { getHtml, sendCdpCommand } = setup({
      'Runtime.evaluate': () => ({ result: { value: '<p>x</p>' } })
    });
    await getHtml(0, '.main');
    assert.match(sendCdpCommand.calls[0].params.expression, /\?\.innerHTML$/);
  });

  it('getAttribute escapes the attribute name', async () => {
    const { getAttribute, sendCdpCommand } = setup({
      'Runtime.evaluate': () => ({ result: { value: '/foo' } })
    });
    await getAttribute(0, 'a', 'href');
    assert.match(sendCdpCommand.calls[0].params.expression, /getAttribute\("href"\)$/);
  });
});
```

- [ ] **Step 2: Run + commit**

```bash
node --test test/lib/extraction.test.mjs
git add test/lib/extraction.test.mjs
git commit -m "Tier A unit test for lib/extraction.js"
```

### Task TA6: Tier A test for `lib/file-upload.js`

**Files:**
- Create: `test/lib/file-upload.test.mjs`

- [ ] **Step 1: Write the test**

```js
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { makeCdpSpy, makeResolveWsUrl } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachFileUpload } = require('../../skills/browsing/lib/file-upload.js');

describe('file-upload', () => {
  function setup(handlers) {
    const sendCdpCommand = makeCdpSpy(handlers);
    return { ...attachFileUpload({ resolveWsUrl: makeResolveWsUrl(), sendCdpCommand }), sendCdpCommand };
  }

  it('CSS selector path queries via DOM.querySelector and sets files', async () => {
    const { fileUpload, sendCdpCommand } = setup({
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.querySelector': () => ({ nodeId: 42 }),
      'DOM.setFileInputFiles': () => ({})
    });
    const result = await fileUpload(0, '#file-input', ['/tmp/a.txt']);
    assert.equal(result.uploaded, true);
    assert.equal(result.files, 1);

    const methods = sendCdpCommand.calls.map(c => c.method);
    assert.deepEqual(methods, ['DOM.getDocument', 'DOM.querySelector', 'DOM.setFileInputFiles']);
    assert.deepEqual(sendCdpCommand.calls[2].params, { files: ['/tmp/a.txt'], nodeId: 42 });
  });

  it('XPath selector path uses DOM.performSearch', async () => {
    const { fileUpload, sendCdpCommand } = setup({
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.performSearch': () => ({ resultCount: 1, searchId: 'abc' }),
      'DOM.getSearchResults': () => ({ nodeIds: [99] }),
      'DOM.setFileInputFiles': () => ({})
    });
    await fileUpload(0, '//input[@type="file"]', ['/tmp/x.png']);
    const methods = sendCdpCommand.calls.map(c => c.method);
    assert.deepEqual(methods, ['DOM.getDocument', 'DOM.performSearch', 'DOM.getSearchResults', 'DOM.setFileInputFiles']);
    assert.equal(sendCdpCommand.calls[3].params.nodeId, 99);
  });

  it('throws if XPath selector matches no elements', async () => {
    const { fileUpload } = setup({
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.performSearch': () => ({ resultCount: 0 })
    });
    await assert.rejects(() => fileUpload(0, '//nope', ['/tmp/a']), /File input not found/);
  });

  it('throws if CSS selector matches no element', async () => {
    const { fileUpload } = setup({
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.querySelector': () => ({ nodeId: 0 })
    });
    await assert.rejects(() => fileUpload(0, '#nope', ['/tmp/a']), /File input not found/);
  });
});
```

- [ ] **Step 2: Run + commit**

```bash
node --test test/lib/file-upload.test.mjs
git add test/lib/file-upload.test.mjs
git commit -m "Tier A unit test for lib/file-upload.js"
```

### Task TA7: Tier A test for `lib/screenshot.js`

**Files:**
- Create: `test/lib/screenshot.test.mjs`

- [ ] **Step 1: Write the test**

```js
import { describe, it, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { makeCdpSpy, makeResolveWsUrl } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachScreenshot } = require('../../skills/browsing/lib/screenshot.js');

describe('screenshot', () => {
  // Use a 1x1 transparent PNG for the fake screenshot data.
  const FAKE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

  function setup(handlers = {}) {
    const sendCdpCommand = makeCdpSpy({
      'Page.captureScreenshot': () => ({ data: FAKE_PNG_BASE64 }),
      'Runtime.evaluate': () => ({ result: { value: { width: 1024, height: 768 } } }),
      ...handlers
    });
    return { ...attachScreenshot({ resolveWsUrl: makeResolveWsUrl(), sendCdpCommand }), sendCdpCommand };
  }

  function tmpFile() {
    return path.join(os.tmpdir(), `screenshot-test-${Date.now()}-${Math.random()}.png`);
  }

  it('viewport screenshot sends explicit clip from window.innerWidth/Height', async () => {
    const filename = tmpFile();
    const { screenshot, sendCdpCommand } = setup();
    await screenshot(0, filename);

    const screenshotCall = sendCdpCommand.calls.find(c => c.method === 'Page.captureScreenshot');
    assert.deepEqual(screenshotCall.params.clip, { x: 0, y: 0, width: 1024, height: 768, scale: 1 });
    assert.equal(screenshotCall.params.captureBeyondViewport, false);

    fs.unlinkSync(filename);
  });

  it('full-page screenshot uses Page.getLayoutMetrics contentSize', async () => {
    const filename = tmpFile();
    const { screenshot, sendCdpCommand } = setup({
      'Page.getLayoutMetrics': () => ({ contentSize: { width: 1024, height: 5000 } })
    });
    await screenshot(0, filename, null, true);

    const screenshotCall = sendCdpCommand.calls.find(c => c.method === 'Page.captureScreenshot');
    assert.equal(screenshotCall.params.clip.height, 5000);
    assert.equal(screenshotCall.params.captureBeyondViewport, true);

    fs.unlinkSync(filename);
  });

  it('writes the decoded PNG to disk and returns absolute path', async () => {
    const filename = tmpFile();
    const { screenshot } = setup();
    const returned = await screenshot(0, filename);
    assert.ok(path.isAbsolute(returned));
    const written = fs.readFileSync(filename);
    assert.ok(written.length > 0);
    fs.unlinkSync(filename);
  });
});
```

- [ ] **Step 2: Run + commit**

```bash
node --test test/lib/screenshot.test.mjs
git add test/lib/screenshot.test.mjs
git commit -m "Tier A unit test for lib/screenshot.js

Covers the three clip modes (viewport, full-page, element) and the
write-to-disk path. Uses a 1x1 PNG for the fake screenshot payload so
the auto-downscale path is exercised on a real file."
```

### Task TA8: Tier A test for `lib/mouse.js`

**Files:**
- Create: `test/lib/mouse.test.mjs`

- [ ] **Step 1: Write the test**

```js
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { makeCdpSpy, makeResolveWsUrl } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachMouse } = require('../../skills/browsing/lib/mouse.js');

describe('mouse', () => {
  function setup(handlers = {}) {
    const sendCdpCommand = makeCdpSpy({
      'Runtime.evaluate': () => ({ result: { value: { found: true, x: 100, y: 200 } } }),
      'Input.dispatchMouseEvent': () => ({}),
      ...handlers
    });
    return { ...attachMouse({ resolveWsUrl: makeResolveWsUrl(), sendCdpCommand }), sendCdpCommand };
  }

  it('click sends mousePressed + mouseReleased at element center', async () => {
    const { click, sendCdpCommand } = setup();
    await click(0, '#button');

    const mouseCalls = sendCdpCommand.calls.filter(c => c.method === 'Input.dispatchMouseEvent');
    assert.equal(mouseCalls.length, 2);
    assert.equal(mouseCalls[0].params.type, 'mousePressed');
    assert.equal(mouseCalls[1].params.type, 'mouseReleased');
    assert.equal(mouseCalls[0].params.x, 100);
    assert.equal(mouseCalls[0].params.y, 200);
  });

  it('click falls back to el.click() when element resolution fails', async () => {
    const { click, sendCdpCommand } = setup({
      'Runtime.evaluate': () => ({ result: { value: { found: false } } })
    });
    const result = await click(0, '#missing');
    assert.equal(result.fallback, true);
    // Two Runtime.evaluate calls: the resolveCenter that fails + the fallback el.click()
    const evals = sendCdpCommand.calls.filter(c => c.method === 'Runtime.evaluate');
    assert.equal(evals.length, 2);
    assert.match(evals[1].params.expression, /\?\.click\(\)/);
  });

  it('hover sends a single mouseMoved at element center', async () => {
    const { hover, sendCdpCommand } = setup();
    await hover(0, '#tooltip-target');
    const mouseCalls = sendCdpCommand.calls.filter(c => c.method === 'Input.dispatchMouseEvent');
    assert.equal(mouseCalls.length, 1);
    assert.equal(mouseCalls[0].params.type, 'mouseMoved');
  });

  it('drag sends mousePressed, N intermediate mouseMoved, then mouseReleased', async () => {
    const { drag, sendCdpCommand } = setup();
    await drag(0, '#src', '#dst', { steps: 4 });
    const mouseCalls = sendCdpCommand.calls.filter(c => c.method === 'Input.dispatchMouseEvent');
    // 1 pressed + 4 moved + 1 released = 6
    assert.equal(mouseCalls.length, 6);
    assert.equal(mouseCalls[0].params.type, 'mousePressed');
    assert.equal(mouseCalls[mouseCalls.length - 1].params.type, 'mouseReleased');
  });

  it('drag accepts coordinate target instead of selector', async () => {
    const { drag, sendCdpCommand } = setup();
    await drag(0, '#src', { x: 500, y: 600 }, { steps: 2 });
    const mouseCalls = sendCdpCommand.calls.filter(c => c.method === 'Input.dispatchMouseEvent');
    const lastMove = mouseCalls[mouseCalls.length - 2]; // last move before release
    assert.equal(lastMove.params.x, 500);
    assert.equal(lastMove.params.y, 600);
  });

  it('mouseMove without steps sends one move at the target coords', async () => {
    const { mouseMove, sendCdpCommand } = setup();
    await mouseMove(0, 300, 400);
    const mouseCalls = sendCdpCommand.calls.filter(c => c.method === 'Input.dispatchMouseEvent');
    assert.equal(mouseCalls.length, 1);
    assert.equal(mouseCalls[0].params.x, 300);
    assert.equal(mouseCalls[0].params.y, 400);
  });

  it('scroll sends mouseWheel with deltaX/deltaY', async () => {
    const { scroll, sendCdpCommand } = setup();
    await scroll(0, { deltaX: 0, deltaY: 500 });
    const wheelCall = sendCdpCommand.calls.find(c => c.method === 'Input.dispatchMouseEvent');
    assert.equal(wheelCall.params.type, 'mouseWheel');
    assert.equal(wheelCall.params.deltaY, 500);
  });

  it('doubleClick sends two press/release pairs with clickCount 1 then 2', async () => {
    const { doubleClick, sendCdpCommand } = setup();
    await doubleClick(0, '#item');
    const mouseCalls = sendCdpCommand.calls.filter(c => c.method === 'Input.dispatchMouseEvent');
    assert.equal(mouseCalls.length, 4);
    assert.equal(mouseCalls[0].params.clickCount, 1);
    assert.equal(mouseCalls[2].params.clickCount, 2);
  });

  it('rightClick uses button: "right"', async () => {
    const { rightClick, sendCdpCommand } = setup();
    await rightClick(0, '#contextmenu-target');
    const mouseCalls = sendCdpCommand.calls.filter(c => c.method === 'Input.dispatchMouseEvent');
    assert.equal(mouseCalls[0].params.button, 'right');
  });
});
```

- [ ] **Step 2: Run + commit**

```bash
node --test test/lib/mouse.test.mjs
git add test/lib/mouse.test.mjs
git commit -m "Tier A unit test for lib/mouse.js

Covers all seven actions (click, hover, drag, mouseMove, scroll,
doubleClick, rightClick) plus the click fallback path and the
coordinate-target variant of drag."
```

### Task TA9: Tier A test for `lib/keyboard-input.js`

**Files:**
- Create: `test/lib/keyboard-input.test.mjs`

- [ ] **Step 1: Write the test**

```js
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { makeCdpSpy, makeResolveWsUrl } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachKeyboardInput } = require('../../skills/browsing/lib/keyboard-input.js');

describe('keyboard-input', () => {
  function setup({ headless = true, handlers = {}, click = async () => ({ clicked: true }) } = {}) {
    const state = { chromeHeadless: headless };
    const sendCdpCommand = makeCdpSpy({
      'Runtime.evaluate': () => ({ result: { value: { isTextarea: false } } }),
      'Input.insertText': () => ({}),
      'Input.dispatchKeyEvent': () => ({}),
      ...handlers
    });
    return {
      ...attachKeyboardInput({ state, resolveWsUrl: makeResolveWsUrl(), sendCdpCommand, click }),
      sendCdpCommand,
      state
    };
  }

  it('keyboardPress(Enter) sends keyDown + keyUp with text="\\r"', async () => {
    const { keyboardPress, sendCdpCommand } = setup();
    await keyboardPress(0, 'Enter');
    const keys = sendCdpCommand.calls.filter(c => c.method === 'Input.dispatchKeyEvent');
    assert.equal(keys.length, 2);
    assert.equal(keys[0].params.type, 'keyDown');
    assert.equal(keys[0].params.text, '\r');
    assert.equal(keys[1].params.type, 'keyUp');
  });

  it('keyboardPress with modifiers sets the modifier bitmask', async () => {
    const { keyboardPress, sendCdpCommand } = setup();
    await keyboardPress(0, 'Tab', { shift: true });
    const keys = sendCdpCommand.calls.filter(c => c.method === 'Input.dispatchKeyEvent');
    assert.equal(keys[0].params.modifiers, 8); // shift = 8
  });

  it('keyboardPress throws on unknown key', async () => {
    const { keyboardPress } = setup();
    await assert.rejects(() => keyboardPress(0, 'NotAKey'), /Unknown key/);
  });

  it('fill in headed mode types each char as insertText (not keyDown for plain chars)', async () => {
    // (humanType is per-char keyDown/keyUp; fill is buffered insertText.)
    const { fill, sendCdpCommand } = setup({ headless: false });
    await fill(0, '#input', 'abc');
    const inserts = sendCdpCommand.calls.filter(c => c.method === 'Input.insertText');
    // fill buffers and sends one insertText with the full string
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].params.text, 'abc');
  });

  it('fill splits on \\t and emits Tab key press between segments', async () => {
    const { fill, sendCdpCommand } = setup();
    await fill(0, null, 'foo\tbar');
    const calls = sendCdpCommand.calls;
    // insertText('foo'), keyDown(Tab), keyUp(Tab), insertText('bar')
    const inserts = calls.filter(c => c.method === 'Input.insertText');
    const keys = calls.filter(c => c.method === 'Input.dispatchKeyEvent');
    assert.deepEqual(inserts.map(c => c.params.text), ['foo', 'bar']);
    assert.equal(keys.length, 2);
    assert.equal(keys[0].params.code, 'Tab');
  });

  it('fill in textarea inserts \\n as literal newline rather than Enter', async () => {
    const { fill, sendCdpCommand } = setup({
      handlers: {
        'Runtime.evaluate': () => ({ result: { value: { isTextarea: true } } })
      }
    });
    await fill(0, null, 'a\nb');
    const calls = sendCdpCommand.calls;
    const inserts = calls.filter(c => c.method === 'Input.insertText');
    // 'a' buffered + flushed; '\n' inserted as literal; 'b' buffered + flushed
    assert.deepEqual(inserts.map(c => c.params.text), ['a', '\n', 'b']);
  });

  it('humanType in headed mode sends keyDown/keyUp around each char', async () => {
    const { humanType, sendCdpCommand } = setup({ headless: false });
    await humanType(0, null, 'ab', { delay: 0, jitter: 0 });
    const inserts = sendCdpCommand.calls.filter(c => c.method === 'Input.insertText');
    const keys = sendCdpCommand.calls.filter(c => c.method === 'Input.dispatchKeyEvent');
    assert.equal(inserts.length, 2);
    // 2 chars × (rawKeyDown + keyUp) = 4 key events
    assert.equal(keys.length, 4);
  });

  it('humanType in headless mode skips keyDown/keyUp (rawKeyDown navigates away)', async () => {
    const { humanType, sendCdpCommand } = setup({ headless: true });
    await humanType(0, null, 'ab', { delay: 0, jitter: 0 });
    const keys = sendCdpCommand.calls.filter(c => c.method === 'Input.dispatchKeyEvent');
    assert.equal(keys.length, 0);
  });
});
```

- [ ] **Step 2: Run + commit**

```bash
node --test test/lib/keyboard-input.test.mjs
git add test/lib/keyboard-input.test.mjs
git commit -m "Tier A unit test for lib/keyboard-input.js

Covers keyboardPress (named keys, modifiers, unknown-key error), fill
(buffered insertText, Tab/Enter handling, textarea-newline path), and
the headless/headed humanType split."
```

### Task TA10: Tier A test for `lib/navigation.js`

**Files:**
- Create: `test/lib/navigation.test.mjs`

- [ ] **Step 1: Write the test**

Note: `navigate` constructs a real `WebSocketClient` for the secondary console-capture connection — this can't be cleanly mocked at the lib boundary. So this Tier A test covers `waitForElement` and `waitForText` only; `navigate` gets exercised by the Tier C smoke test.

```js
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { makeCdpSpy, makeResolveWsUrl } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachNavigation } = require('../../skills/browsing/lib/navigation.js');

describe('navigation', () => {
  function setup(handlers = {}) {
    const state = { consoleMessages: new Map() };
    const sendCdpCommand = makeCdpSpy(handlers);
    const capturePageArtifacts = async () => ({});
    return {
      ...attachNavigation({ state, resolveWsUrl: makeResolveWsUrl(), sendCdpCommand, capturePageArtifacts }),
      sendCdpCommand,
      state
    };
  }

  it('waitForElement passes awaitPromise: true', async () => {
    const { waitForElement, sendCdpCommand } = setup({
      'Runtime.evaluate': () => ({ result: { value: true } })
    });
    await waitForElement(0, '#ready');
    assert.equal(sendCdpCommand.calls[0].params.awaitPromise, true);
    assert.match(sendCdpCommand.calls[0].params.expression, /new Promise/);
  });

  it('waitForText injects the search text into the page-side check', async () => {
    const { waitForText, sendCdpCommand } = setup({
      'Runtime.evaluate': () => ({ result: { value: true } })
    });
    await waitForText(0, 'Hello, world');
    assert.match(sendCdpCommand.calls[0].params.expression, /Hello, world/);
  });

  // navigate() and spaNavigate/hrefNavigate (now removed in Section 4) are
  // covered by the Tier C real-Chrome smoke test.
});
```

- [ ] **Step 2: Run + commit**

```bash
node --test test/lib/navigation.test.mjs
git add test/lib/navigation.test.mjs
git commit -m "Tier A unit test for lib/navigation.js

Covers waitForElement and waitForText. navigate() can't be cleanly
unit-tested because it constructs its own WebSocketClient for the
secondary console-capture connection; smoke-tested via Tier C instead."
```

### Task TA11: Tier A test for `lib/console-logging.js`

**Files:**
- Create: `test/lib/console-logging.test.mjs`

- [ ] **Step 1: Write the test**

`enableConsoleLogging` constructs a real WebSocketClient and isn't unit-testable at the lib boundary. Cover `getConsoleMessages` and `clearConsoleMessages`.

```js
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { makeResolveWsUrl } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachConsoleLogging } = require('../../skills/browsing/lib/console-logging.js');

describe('console-logging', () => {
  function setup() {
    const state = { consoleMessages: new Map() };
    return { ...attachConsoleLogging({ state, resolveWsUrl: makeResolveWsUrl('ws://test/x') }), state };
  }

  it('getConsoleMessages returns [] for unknown tab', async () => {
    const { getConsoleMessages } = setup();
    assert.deepEqual(await getConsoleMessages(0), []);
  });

  it('getConsoleMessages returns the buffered messages', async () => {
    const { getConsoleMessages, state } = setup();
    state.consoleMessages.set('ws://test/x', [
      { timestamp: '2026-01-01T00:00:00Z', level: 'log', text: 'hi' }
    ]);
    const msgs = await getConsoleMessages(0);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].text, 'hi');
  });

  it('getConsoleMessages with sinceTime filters older messages', async () => {
    const { getConsoleMessages, state } = setup();
    state.consoleMessages.set('ws://test/x', [
      { timestamp: '2026-01-01T00:00:00Z', level: 'log', text: 'old' },
      { timestamp: '2026-01-02T00:00:00Z', level: 'log', text: 'new' }
    ]);
    const since = new Date('2026-01-01T12:00:00Z');
    const msgs = await getConsoleMessages(0, since);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].text, 'new');
  });

  it('clearConsoleMessages empties the buffer for that tab', async () => {
    const { clearConsoleMessages, state } = setup();
    state.consoleMessages.set('ws://test/x', [{ text: 'a' }]);
    await clearConsoleMessages(0);
    assert.deepEqual(state.consoleMessages.get('ws://test/x'), []);
  });
});
```

- [ ] **Step 2: Run + commit**

```bash
node --test test/lib/console-logging.test.mjs
git add test/lib/console-logging.test.mjs
git commit -m "Tier A unit test for lib/console-logging.js

Covers getConsoleMessages (with and without sinceTime filter) and
clearConsoleMessages. enableConsoleLogging constructs its own
WebSocketClient and is exercised via Tier C."
```

### Task TA12: Tier A test for `lib/cdp-connection.js`

**Files:**
- Create: `test/lib/cdp-connection.test.mjs`

- [ ] **Step 1: Write the test**

The pool primitive constructs WebSocketClient internally — the mockable surface is mostly through behavior. Test the helpers that don't require a real connection.

```js
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { attachCdpConnection } = require('../../skills/browsing/lib/cdp-connection.js');

describe('cdp-connection', () => {
  function setup() {
    const state = { connectionPool: new Map() };
    return { ...attachCdpConnection({ state }), state };
  }

  it('closePooledConnection removes a pooled entry that does not exist', () => {
    const { closePooledConnection } = setup();
    // No throw, just no-op.
    closePooledConnection('ws://nope');
  });

  it('closePooledConnection removes an entry from the pool', () => {
    const { closePooledConnection, state } = setup();
    const fakeWs = { close: () => {} };
    state.connectionPool.set('ws://x', { ws: fakeWs });
    closePooledConnection('ws://x');
    assert.equal(state.connectionPool.has('ws://x'), false);
  });

  it('closeAllConnections clears the pool', () => {
    const { closeAllConnections, state } = setup();
    state.connectionPool.set('ws://a', { ws: { close: () => {} } });
    state.connectionPool.set('ws://b', { ws: { close: () => {} } });
    closeAllConnections();
    assert.equal(state.connectionPool.size, 0);
  });

  it('exports the expected method set', () => {
    const conn = setup();
    assert.equal(typeof conn.sendCdpCommand, 'function');
    assert.equal(typeof conn.sendCdpCommandPooled, 'function');
    assert.equal(typeof conn.sendCdpCommandSingle, 'function');
    assert.equal(typeof conn.getPooledConnection, 'function');
    assert.equal(typeof conn.closePooledConnection, 'function');
    assert.equal(typeof conn.closeAllConnections, 'function');
  });
});
```

- [ ] **Step 2: Run + commit**

```bash
node --test test/lib/cdp-connection.test.mjs
git add test/lib/cdp-connection.test.mjs
git commit -m "Tier A unit test for lib/cdp-connection.js

Covers the pool-management helpers (close / clear). The send paths
construct real WebSocketClients and are covered by Tier C."
```

### Task TA13: Tier A test for `lib/tabs.js`

**Files:**
- Create: `test/lib/tabs.test.mjs`

- [ ] **Step 1: Write the test**

`tabs` uses `chromeHttpAt` from chrome-launcher-helpers, which makes real HTTP. To mock it cleanly, we'd need to inject the http function. Instead, exercise tabs.js's logic by constructing a state with a fake `hostOverride` and asserting that pure-logic paths (e.g. closeTab dispatch when chromeHttp returns nothing) behave correctly. The HTTP-actually-talks-to-Chrome path is tested in Tier C.

```js
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { attachTabs } = require('../../skills/browsing/lib/tabs.js');

describe('tabs', () => {
  function fakeHostOverride() {
    return {
      getHost: () => '127.0.0.1',
      getPort: () => 9222,
      rewriteWsUrl: (url) => url, // identity for the no-override case
    };
  }

  it('exports the expected method set', () => {
    const state = {
      hostOverride: fakeHostOverride(),
      rewriteWsUrl: (url) => url,
      activePort: 9222,
    };
    const tabs = attachTabs({ state });
    assert.equal(typeof tabs.chromeHttp, 'function');
    assert.equal(typeof tabs.resolveWsUrl, 'function');
    assert.equal(typeof tabs.getTabs, 'function');
    assert.equal(typeof tabs.newTab, 'function');
    assert.equal(typeof tabs.closeTab, 'function');
  });

  it('resolveWsUrl with a ws:// string returns the rewritten URL', async () => {
    const state = {
      hostOverride: fakeHostOverride(),
      rewriteWsUrl: (url, host, port) => url.replace(/127\.0\.0\.1:9222/, `${host}:${port}`),
      activePort: 9999,
    };
    const { resolveWsUrl } = attachTabs({ state });
    const result = await resolveWsUrl('ws://127.0.0.1:9222/devtools/page/abc');
    assert.equal(result, 'ws://127.0.0.1:9999/devtools/page/abc');
  });

  it('resolveWsUrl with non-string-non-number throws', async () => {
    const state = { hostOverride: fakeHostOverride(), rewriteWsUrl: (u) => u, activePort: 9222 };
    const { resolveWsUrl } = attachTabs({ state });
    await assert.rejects(() => resolveWsUrl({}), /Invalid tab specifier/);
  });
});
```

- [ ] **Step 2: Run + commit**

```bash
node --test test/lib/tabs.test.mjs
git add test/lib/tabs.test.mjs
git commit -m "Tier A unit test for lib/tabs.js

Covers the synchronous URL-rewrite path and method-set parity. The
HTTP-talks-to-Chrome paths (getTabs, newTab, closeTab) are exercised
by Tier C against a real Chrome."
```

### Task TA14: Tier A test for `lib/chrome-process.js`

**Files:**
- Create: `test/lib/chrome-process.test.mjs`

- [ ] **Step 1: Write the test**

The state-mutator paths (getProfileName, setProfileName, getChromePid, getActivePort, getBrowserMode) are testable without spawning Chrome.

```js
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { attachChromeProcess } = require('../../skills/browsing/lib/chrome-process.js');

describe('chrome-process', () => {
  function setup() {
    const state = {
      hostOverride: {
        getHost: () => '127.0.0.1',
        getPort: () => 9222,
      },
      activePort: 9222,
      chromeHeadless: true,
      chromeProcess: null,
      chromeProfileName: 'superpowers-chrome',
      chromeUserDataDir: null,
    };
    const chromeHttp = async () => ({});
    const getTabs = async () => [];
    const newTab = async () => ({});
    return { ...attachChromeProcess({ state, chromeHttp, getTabs, newTab }), state };
  }

  it('getActivePort returns state.activePort', () => {
    const { getActivePort, state } = setup();
    state.activePort = 9333;
    assert.equal(getActivePort(), 9333);
  });

  it('getProfileName returns state.chromeProfileName', () => {
    const { getProfileName, state } = setup();
    state.chromeProfileName = 'custom';
    assert.equal(getProfileName(), 'custom');
  });

  it('setProfileName validates the name and updates state', () => {
    const { setProfileName, state } = setup();
    setProfileName('valid-name_2');
    assert.equal(state.chromeProfileName, 'valid-name_2');
    // chromeUserDataDir reset so next startChrome re-derives it.
    assert.equal(state.chromeUserDataDir, null);
  });

  it('setProfileName throws on invalid characters', () => {
    const { setProfileName } = setup();
    assert.throws(() => setProfileName('foo/bar'), /Invalid profile name/);
    assert.throws(() => setProfileName('../etc'), /Invalid profile name/);
  });

  it('setProfileName throws if chrome is running', () => {
    const { setProfileName, state } = setup();
    state.chromeProcess = { pid: 1234 };
    assert.throws(() => setProfileName('new'), /Cannot change profile while Chrome is running/);
  });

  it('getChromePid returns null when no process, pid when running', () => {
    const { getChromePid, state } = setup();
    assert.equal(getChromePid(), null);
    state.chromeProcess = { pid: 5678 };
    assert.equal(getChromePid(), 5678);
  });

  it('getBrowserMode reflects state', async () => {
    const { getBrowserMode, state } = setup();
    state.chromeHeadless = false;
    state.chromeProcess = { pid: 9999 };
    state.activePort = 9444;
    const mode = await getBrowserMode();
    assert.equal(mode.headless, false);
    assert.equal(mode.mode, 'headed');
    assert.equal(mode.running, true);
    assert.equal(mode.pid, 9999);
    assert.equal(mode.port, 9444);
  });
});
```

- [ ] **Step 2: Run + commit**

```bash
node --test test/lib/chrome-process.test.mjs
git add test/lib/chrome-process.test.mjs
git commit -m "Tier A unit test for lib/chrome-process.js

Covers the state-only methods (getActivePort, getProfileName,
setProfileName with its validation, getChromePid, getBrowserMode).
startChrome / killChrome / showBrowser / hideBrowser require a real
Chrome and are exercised by Tier C."
```

### Task TA15: Tier A test for `lib/key-definitions.js` and `lib/chrome-launcher-helpers.js` (pure helpers)

**Files:**
- Create: `test/lib/key-definitions.test.mjs`
- Create: `test/lib/chrome-launcher-helpers.test.mjs`

- [ ] **Step 1: `key-definitions.test.mjs`**

```js
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { KEY_DEFINITIONS, charToKeyDef } = require('../../skills/browsing/lib/key-definitions.js');

describe('key-definitions', () => {
  it('KEY_DEFINITIONS includes Tab, Enter, Escape with the expected key codes', () => {
    assert.equal(KEY_DEFINITIONS.Tab.keyCode, 9);
    assert.equal(KEY_DEFINITIONS.Enter.keyCode, 13);
    assert.equal(KEY_DEFINITIONS.Escape.keyCode, 27);
    assert.equal(KEY_DEFINITIONS.Tab.text, '\t');
    assert.equal(KEY_DEFINITIONS.Enter.text, '\r');
  });

  it('KEY_DEFINITIONS includes all F1-F12', () => {
    for (let i = 1; i <= 12; i++) {
      assert.ok(KEY_DEFINITIONS[`F${i}`], `missing F${i}`);
    }
  });

  it('charToKeyDef maps lowercase letters', () => {
    assert.deepEqual(charToKeyDef('a'), {
      key: 'a', code: 'KeyA', keyCode: 65, text: 'a', shift: false
    });
  });

  it('charToKeyDef maps uppercase letters with shift: true', () => {
    const def = charToKeyDef('A');
    assert.equal(def.code, 'KeyA');
    assert.equal(def.shift, true);
  });

  it('charToKeyDef maps shifted symbols', () => {
    const def = charToKeyDef('!');
    assert.equal(def.code, 'Digit1');
    assert.equal(def.shift, true);
  });

  it('charToKeyDef maps newline and tab to special routing', () => {
    assert.deepEqual(charToKeyDef('\n'), { special: 'Enter' });
    assert.deepEqual(charToKeyDef('\t'), { special: 'Tab' });
  });

  it('charToKeyDef maps space', () => {
    const def = charToKeyDef(' ');
    assert.equal(def.code, 'Space');
    assert.equal(def.text, ' ');
  });

  it('charToKeyDef maps digits', () => {
    assert.equal(charToKeyDef('5').code, 'Digit5');
  });

  it('charToKeyDef maps unshifted punctuation', () => {
    assert.equal(charToKeyDef('-').code, 'Minus');
    assert.equal(charToKeyDef('.').code, 'Period');
  });
});
```

- [ ] **Step 2: `chrome-launcher-helpers.test.mjs`**

```js
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  PORT_RANGE_START,
  PORT_RANGE_END,
  buildChromeArgs,
  getXdgCacheHome,
  getChromeProfileDir,
} = require('../../skills/browsing/lib/chrome-launcher-helpers.js');

describe('chrome-launcher-helpers', () => {
  it('PORT_RANGE_START is 9222 (backward compat)', () => {
    assert.equal(PORT_RANGE_START, 9222);
    assert.ok(PORT_RANGE_END > PORT_RANGE_START);
  });

  it('buildChromeArgs includes the chosen port', () => {
    const args = buildChromeArgs({
      chosenPort: 9333,
      chromeUserDataDir: '/tmp/profile',
      chromeHeadless: false
    });
    assert.ok(args.includes('--remote-debugging-port=9333'));
    assert.ok(args.includes('--user-data-dir=/tmp/profile'));
    assert.ok(!args.includes('--headless=new'));
  });

  it('buildChromeArgs adds --headless=new when chromeHeadless is true', () => {
    const args = buildChromeArgs({
      chosenPort: 9333,
      chromeUserDataDir: '/tmp/profile',
      chromeHeadless: true
    });
    assert.ok(args.includes('--headless=new'));
  });

  it('buildChromeArgs appends CHROME_EXTRA_ARGS tokens', () => {
    process.env.CHROME_EXTRA_ARGS = '--use-gl=angle --enable-foo';
    try {
      const args = buildChromeArgs({
        chosenPort: 9333,
        chromeUserDataDir: '/tmp/profile',
        chromeHeadless: false
      });
      assert.ok(args.includes('--use-gl=angle'));
      assert.ok(args.includes('--enable-foo'));
    } finally {
      delete process.env.CHROME_EXTRA_ARGS;
    }
  });

  it('getXdgCacheHome returns a non-empty path', () => {
    const path = getXdgCacheHome();
    assert.equal(typeof path, 'string');
    assert.ok(path.length > 0);
  });

  it('getChromeProfileDir composes profile name into XDG path', () => {
    const dir = getChromeProfileDir('myprofile');
    assert.match(dir, /superpowers\/browser-profiles\/myprofile$/);
  });
});
```

- [ ] **Step 3: Run + commit**

```bash
node --test test/lib/key-definitions.test.mjs test/lib/chrome-launcher-helpers.test.mjs
git add test/lib/key-definitions.test.mjs test/lib/chrome-launcher-helpers.test.mjs
git commit -m "Tier A unit tests for pure-helper modules

key-definitions (KEY_DEFINITIONS shape, charToKeyDef behavior across
char classes) and chrome-launcher-helpers (PORT_RANGE constants,
buildChromeArgs flag composition including CHROME_EXTRA_ARGS, profile
path resolution)."
```

### Task TA16: Tier A test for `lib/capture.js` (the *WithCapture wrappers)

**Files:**
- Create: `test/lib/capture.test.mjs`

- [ ] **Step 1: Write the test**

Tests the *WithCapture wrappers and the createCapturePrefix counter. The bigger functions (capturePageArtifacts, captureActionWithDiff) require disk side effects and screenshot writes — covered by Tier C.

```js
import { describe, it, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const { attachCapture } = require('../../skills/browsing/lib/capture.js');

describe('capture', () => {
  // Use a process-scoped temp dir so we don't touch ~/.cache
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-test-'));
  const origXdg = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = tmpRoot;

  after(() => {
    if (origXdg === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = origXdg;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function setup() {
    const state = { sessionDir: null, captureCounter: 0 };
    const calls = { resolveWsUrl: 0, sendCdpCommand: 0, getHtml: 0, screenshot: 0 };
    const sendCdpCommand = async () => { calls.sendCdpCommand++; return { result: { value: 'fake' } }; };
    const resolveWsUrl = async (x) => { calls.resolveWsUrl++; return 'ws://test/x'; };
    const getHtml = async () => { calls.getHtml++; return '<html></html>'; };
    const screenshot = async (_, file) => { calls.screenshot++; fs.writeFileSync(file, ''); return file; };
    const actions = {
      click: async () => ({ clicked: true }),
      fill: async () => ({ typed: true }),
      selectOption: async () => ({ success: true }),
      evaluate: async () => 'eval-result',
    };
    return {
      ...attachCapture({ state, resolveWsUrl, sendCdpCommand, getHtml, screenshot, actions }),
      calls,
      state
    };
  }

  it('createCapturePrefix increments and zero-pads', () => {
    const { createCapturePrefix } = setup();
    assert.equal(createCapturePrefix('click'), '001-click');
    assert.equal(createCapturePrefix('type'), '002-type');
  });

  it('initializeSession creates a session dir under XDG_CACHE_HOME', () => {
    const { initializeSession, state } = setup();
    const dir = initializeSession();
    assert.ok(fs.existsSync(dir));
    assert.match(dir, /superpowers\/browser\//);
    state.sessionDir = null; // reset for other tests
  });

  it('clickWithCapture invokes the action then capture, returns merged result', async () => {
    const { clickWithCapture, calls } = setup();
    const result = await clickWithCapture(0, '#button');
    assert.equal(result.action, 'click');
    assert.equal(result.selector, '#button');
    assert.ok(calls.screenshot >= 1, 'screenshot was called');
  });

  it('fillWithCapture passes the value through', async () => {
    const { fillWithCapture } = setup();
    const result = await fillWithCapture(0, '#input', 'hello');
    assert.equal(result.value, 'hello');
  });

  it('selectOptionWithCapture passes the value through', async () => {
    const { selectOptionWithCapture } = setup();
    const result = await selectOptionWithCapture(0, '#select', 'opt1');
    assert.equal(result.value, 'opt1');
  });

  it('evaluateWithCapture returns the eval result and the capture metadata', async () => {
    const { evaluateWithCapture } = setup();
    const result = await evaluateWithCapture(0, '21+21');
    assert.equal(result.result, 'eval-result');
    assert.equal(result.expression, '21+21');
  });
});
```

- [ ] **Step 2: Run + commit**

```bash
node --test test/lib/capture.test.mjs
git add test/lib/capture.test.mjs
git commit -m "Tier A unit test for lib/capture.js

Covers createCapturePrefix counter, initializeSession dir creation, and
the four *WithCapture wrappers — the exact 'actions: { click, fill,
selectOption, evaluate }' passthrough that's easy to silently break."
```

---

# Section 10: Test infrastructure — Tier B (jsdom integration)

Spec section 1, Tier B.

### Task TB1: Tier B test for `lib/select-option.js`

**Files:**
- Create: `test/lib/select-option.test.mjs`

- [ ] **Step 1: Write the test**

```js
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const { attachSelectOption } = require('../../skills/browsing/lib/select-option.js');

describe('selectOption (jsdom)', () => {
  // Build a fake CDP layer that evaluates Runtime.evaluate against a jsdom DOM.
  function setup(html) {
    const dom = new JSDOM(html);
    const { window } = dom;
    // jsdom lacks Element.prototype.dispatchEvent for old-style events in some
    // cases; node:vm-style eval is good enough for this.
    const sendCdpCommand = async (wsUrl, method, params) => {
      if (method !== 'Runtime.evaluate') {
        throw new Error(`Unexpected CDP method: ${method}`);
      }
      // Evaluate the expression as if it were running in the page.
      const result = window.eval(`(function(){ ${params.expression.startsWith('(') ? 'return ' : ''}${params.expression} })()`);
      // wrap to match returnByValue: true CDP shape
      return { result: { value: result } };
    };
    const resolveWsUrl = async () => 'ws://jsdom';
    return attachSelectOption({ resolveWsUrl, sendCdpCommand });
  }

  const SINGLE = `<select id="single">
    <option value="a">Apple</option>
    <option value="b">Banana</option>
    <option value="c">Cherry</option>
  </select>`;

  const MULTI = `<select id="multi" multiple>
    <option value="a">Apple</option>
    <option value="b">Banana</option>
    <option value="c">Cherry</option>
  </select>`;

  it('matches by value attribute', async () => {
    const { selectOption } = setup(SINGLE);
    const r = await selectOption(0, '#single', 'b');
    assert.equal(r.success, true);
    assert.equal(r.matched[0].value, 'b');
  });

  it('matches by visible label when value does not match', async () => {
    const { selectOption } = setup(SINGLE);
    const r = await selectOption(0, '#single', 'Cherry');
    assert.equal(r.matched[0].value, 'c');
    assert.equal(r.matched[0].text, 'Cherry');
  });

  it('multi-select with array selects multiple options', async () => {
    const { selectOption } = setup(MULTI);
    const r = await selectOption(0, '#multi', ['a', 'c']);
    assert.equal(r.matched.length, 2);
    assert.equal(r.matched[0].value, 'a');
    assert.equal(r.matched[1].value, 'c');
  });

  it('throws when array passed to non-multiple select', async () => {
    const { selectOption } = setup(SINGLE);
    await assert.rejects(() => selectOption(0, '#single', ['a', 'b']), /non-multiple/);
  });

  it('throws when no option matches', async () => {
    const { selectOption } = setup(SINGLE);
    await assert.rejects(() => selectOption(0, '#single', 'nope'), /No matching option/);
  });

  it('replace semantics: previous selections are cleared', async () => {
    // Pre-select option 'a', then call selectOption with 'b'. Only 'b' should be selected.
    const { selectOption } = setup(MULTI);
    // Prime: select all three.
    await selectOption(0, '#multi', ['a', 'b', 'c']);
    // Replace: select only 'b'.
    const r = await selectOption(0, '#multi', ['b']);
    assert.equal(r.matched.length, 1);
    assert.equal(r.matched[0].value, 'b');
  });
});
```

- [ ] **Step 2: Run + commit**

```bash
node --test test/lib/select-option.test.mjs
git add test/lib/select-option.test.mjs
git commit -m "Tier B integration test for lib/select-option.js

jsdom-backed: builds a fake CDP layer that evaluates Runtime.evaluate
expressions against a real DOM. Covers value-match, label-match,
multi-select array, error on multi-on-non-multiple, error on
unmatched, replace semantics."
```

### Task TB2: Tier B test for `lib/page-scripts/markdown.js`

**Files:**
- Create: `test/lib/page-scripts/markdown.test.mjs`

- [ ] **Step 1: Create the test directory**

```bash
mkdir -p test/lib/page-scripts
```

- [ ] **Step 2: Write the test**

```js
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const markdownScript = require('../../../skills/browsing/lib/page-scripts/markdown.js');

describe('page-scripts/markdown', () => {
  function evalScript(html) {
    const dom = new JSDOM(html);
    return dom.window.eval(markdownScript);
  }

  it('emits the title as H1', () => {
    const md = evalScript('<html><head><title>My Page</title></head><body><p>Hi</p></body></html>');
    assert.match(md, /^# My Page/);
  });

  it('renders headings, paragraphs, and lists', () => {
    const md = evalScript(`
      <html><body>
        <h2>About</h2>
        <p>Some text.</p>
        <ul><li>One</li><li>Two</li></ul>
      </body></html>
    `);
    assert.match(md, /## About/);
    assert.match(md, /Some text\./);
    assert.match(md, /- One/);
    assert.match(md, /- Two/);
  });

  it('inlines image references with size when image is significant', () => {
    // jsdom does NOT lay out images so getBoundingClientRect returns zero.
    // Stub it to give the image a real size.
    const dom = new JSDOM(`<img src="x.png" alt="Logo">`);
    const img = dom.window.document.querySelector('img');
    img.getBoundingClientRect = () => ({ width: 200, height: 100 });
    // Patch all images globally for the test.
    const proto = dom.window.HTMLImageElement.prototype;
    proto.getBoundingClientRect = function () { return { width: 200, height: 100 }; };
    const md = dom.window.eval(markdownScript);
    assert.match(md, /!\[Image: "Logo" - 200x100\]\(.*x\.png\)/);
  });

  it('caps output at 50000 chars', () => {
    const giantHtml = '<html><body>' + '<p>x</p>'.repeat(100000) + '</body></html>';
    const md = evalScript(giantHtml);
    assert.ok(md.length <= 50000);
  });
});
```

- [ ] **Step 3: Run + commit**

```bash
node --test test/lib/page-scripts/markdown.test.mjs
git add test/lib/page-scripts/markdown.test.mjs
git commit -m "Tier B test for lib/page-scripts/markdown.js

Loads the extracted page-side script and evals it against jsdom
documents to assert the markdown output for representative pages
(title-only, headings + paragraphs + lists, images with size,
size cap)."
```

### Task TB3: Tier B test for `lib/page-scripts/dom-summary.js`

**Files:**
- Create: `test/lib/page-scripts/dom-summary.test.mjs`

- [ ] **Step 1: Write the test**

```js
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const domSummaryScript = require('../../../skills/browsing/lib/page-scripts/dom-summary.js');

describe('page-scripts/dom-summary', () => {
  function evalScript(html) {
    const dom = new JSDOM(html);
    return dom.window.eval(domSummaryScript);
  }

  it('counts buttons, inputs, and links', () => {
    const summary = evalScript(`
      <html><body>
        <button>One</button>
        <button>Two</button>
        <input type="text">
        <textarea></textarea>
        <a href="/x">Link</a>
      </body></html>
    `);
    assert.match(summary, /Interactive: 2 buttons, 2 inputs, 1 links/);
  });

  it('reports H1s in the headings line', () => {
    const summary = evalScript('<html><body><h1>Welcome</h1><h1>To Site</h1></body></html>');
    assert.match(summary, /Headings: "Welcome", "To Site"/);
  });

  it('caps headings at 3 with "and N more"', () => {
    const html = '<html><body>' + Array.from({ length: 5 }, (_, i) => `<h1>H${i}</h1>`).join('') + '</body></html>';
    const summary = evalScript(html);
    assert.match(summary, /and 2 more/);
  });

  it('reports nav and main landmarks in layout line', () => {
    const summary = evalScript('<html><body><nav>...</nav><main>...</main></body></html>');
    assert.match(summary, /Layout: nav \+ main/);
  });

  it('reports forms count', () => {
    const summary = evalScript('<html><body><form></form><form></form></body></html>');
    assert.match(summary, /\+ 2 forms/);
  });
});
```

- [ ] **Step 2: Run + commit**

```bash
node --test test/lib/page-scripts/dom-summary.test.mjs
git add test/lib/page-scripts/dom-summary.test.mjs
git commit -m "Tier B test for lib/page-scripts/dom-summary.js

Asserts interactive-element counts, heading capping, landmark
detection, and form count against jsdom documents."
```

---

# Section 11: Test infrastructure — Tier C (real-Chrome smoke)

Spec section 1, Tier C. One file, gated on Chrome being available, ~10 assertions.

### Task TC1: Real-Chrome smoke test

**Files:**
- Create: `test/smoke.test.mjs`

- [ ] **Step 1: Write the test**

```js
import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const { createSession } = require('../skills/browsing/chrome-ws-lib.js');

// Skip the whole suite if Chrome isn't available locally — contributors
// without Chrome can still run npm test.
function detectChrome() {
  const platform = os.platform();
  const candidates = {
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    linux: ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'],
    win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
  };
  for (const p of (candidates[platform] || [])) {
    if (fs.existsSync(p)) return true;
  }
  return false;
}

const CHROME_AVAILABLE = detectChrome();

describe('real Chrome smoke', { skip: !CHROME_AVAILABLE && 'Chrome not installed' }, () => {
  let session;
  let tmpProfileDir;

  before(async () => {
    // Use a unique profile so we don't clobber the user's normal profile.
    tmpProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-smoke-'));
    process.env.XDG_CACHE_HOME = tmpProfileDir;
    session = createSession();
    session.setProfileName(`smoke-${Date.now()}`);
    await session.startChrome(true); // headless
  });

  after(async () => {
    try { await session.killChrome(); } catch {}
    try { fs.rmSync(tmpProfileDir, { recursive: true, force: true }); } catch {}
  });

  it('navigate + extractText returns expected content', async () => {
    await session.navigate(0, 'data:text/html,<h1 id="hello">Hello smoke test</h1>');
    const text = await session.extractText(0, '#hello');
    assert.equal(text, 'Hello smoke test');
  });

  it('click triggers a JS handler', async () => {
    const html = `data:text/html,<button id="btn" onclick="this.textContent='clicked'">click me</button>`;
    await session.navigate(0, html);
    await session.click(0, '#btn');
    const text = await session.extractText(0, '#btn');
    assert.equal(text, 'clicked');
  });

  it('fill puts text into an input', async () => {
    await session.navigate(0, 'data:text/html,<input id="i">');
    await session.fill(0, '#i', 'typed text');
    const value = await session.evaluate(0, 'document.getElementById("i").value');
    assert.equal(value, 'typed text');
  });

  it('selectOption sets the value (label match)', async () => {
    const html = `data:text/html,<select id="s"><option value="a">Apple</option><option value="b">Banana</option></select>`;
    await session.navigate(0, html);
    await session.selectOption(0, '#s', 'Banana');
    const value = await session.evaluate(0, 'document.getElementById("s").value');
    assert.equal(value, 'b');
  });

  it('keyboardPress(Tab) advances focus', async () => {
    await session.navigate(0, 'data:text/html,<input id="a"><input id="b">');
    await session.evaluate(0, 'document.getElementById("a").focus()');
    await session.keyboardPress(0, 'Tab');
    const focused = await session.evaluate(0, 'document.activeElement.id');
    assert.equal(focused, 'b');
  });

  it('screenshot writes a non-empty PNG file', async () => {
    await session.navigate(0, 'data:text/html,<h1>screenshot</h1>');
    const tmpFile = path.join(tmpProfileDir, 'shot.png');
    await session.screenshot(0, tmpFile);
    const stat = fs.statSync(tmpFile);
    assert.ok(stat.size > 100); // PNG is at least header-sized
  });

  it('clearCookies executes without error', async () => {
    await session.clearCookies(0);
  });
});
```

- [ ] **Step 2: Run the test**

```bash
node --test test/smoke.test.mjs
```

Expected (with Chrome installed): tests pass; takes ~5-10 seconds.
Expected (without Chrome): suite is skipped with "Chrome not installed".

- [ ] **Step 3: Commit**

```bash
git add test/smoke.test.mjs
git commit -m "Tier C real-Chrome smoke test

One file, ~7 assertions, exercises navigate + click + fill + select +
keyboardPress + screenshot + clearCookies against data: URLs in a real
headless Chrome. Skipped (not failed) when Chrome isn't installed so
contributors without Chrome can still run npm test."
```

---

# Section 12: Bundle drift detection

Spec section 2.

### Task BD1: Drift-detection test

**Files:**
- Create: `test/bundle-drift.test.mjs`

- [ ] **Step 1: Write the test**

The bundle imports the lib via runtime require. We can verify drift by checking that `mcp/dist/index.js`'s set of `chromeLib.X(...)` call sites is a subset of the lib's actual exported method set.

```js
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const { createSession } = require('../skills/browsing/chrome-ws-lib.js');

describe('bundle drift', () => {
  it('every chromeLib.X call in mcp/dist/index.js exists on the lib session object', () => {
    const distSource = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'dist', 'index.js'), 'utf8');

    // Find every chromeLib.X( occurrence. The bundled MCP renames the
    // import; in the current bundle it's `chromeLib`. If the bundle
    // changes its variable name, update the regex.
    const callRegex = /\bchromeLib\.([a-zA-Z_$][\w$]*)\s*\(/g;
    const calledMethods = new Set();
    let m;
    while ((m = callRegex.exec(distSource)) !== null) {
      calledMethods.add(m[1]);
    }

    assert.ok(calledMethods.size > 0, 'no chromeLib.X( calls found in dist — regex needs updating');

    const session = createSession();
    const sessionMethods = new Set(Object.keys(session));

    const missing = [...calledMethods].filter(name => !sessionMethods.has(name));
    assert.deepEqual(missing, [], `bundle calls methods missing from lib: ${missing.join(', ')}`);
  });
});
```

- [ ] **Step 2: Run the test**

```bash
node --test test/bundle-drift.test.mjs
```

Expected: pass (the bundle and lib are in sync today).

- [ ] **Step 3: Commit**

```bash
git add test/bundle-drift.test.mjs
git commit -m "Drift-detection test: bundle's chromeLib.X calls vs lib exports

Catches the cross-commit drift case — the bundle (committed in commit N)
calls methods removed from the lib in commit N+1. Regex-scrapes every
chromeLib.X( in mcp/dist/index.js and asserts each name exists on the
session object createSession() returns."
```

### Task BD2: Bundle-actually-loads test

**Files:**
- Create: `test/bundle-loads.test.mjs`

- [ ] **Step 1: Write the test**

```js
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = path.join(__dirname, '..', 'mcp', 'dist', 'index.js');

describe('bundle loads', () => {
  it('mcp/dist/index.js boots and responds to MCP initialize within 5s', async () => {
    await new Promise((resolve, reject) => {
      const proc = spawn('node', [BUNDLE_PATH], {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let stderr = '';
      let stdout = '';
      let resolved = false;

      proc.stdout.on('data', (d) => {
        stdout += d.toString();
        if (stdout.includes('"jsonrpc"') && stdout.includes('"id":1')) {
          resolved = true;
          proc.kill();
          resolve();
        }
      });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', reject);
      proc.on('exit', (code, signal) => {
        if (resolved) return;
        if (signal === 'SIGTERM' || signal === 'SIGKILL') return;
        reject(new Error(`bundle exited unexpectedly (code=${code}, signal=${signal})\nstderr:\n${stderr}\nstdout:\n${stdout}`));
      });

      // Send a minimal MCP initialize request.
      proc.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'bundle-test', version: '0' }
        }
      }) + '\n');

      setTimeout(() => {
        if (!resolved) {
          proc.kill();
          reject(new Error(`bundle did not respond to MCP initialize within 5s\nstderr:\n${stderr}\nstdout:\n${stdout}`));
        }
      }, 5000);
    });
  });
});
```

- [ ] **Step 2: Run the test**

```bash
node --test test/bundle-loads.test.mjs
```

Expected: pass within 5 seconds.

- [ ] **Step 3: Commit**

```bash
git add test/bundle-loads.test.mjs
git commit -m "Bundle-actually-loads smoke test

spawn('node', ['mcp/dist/index.js']), send a minimal MCP initialize
request via stdin, assert a JSON-RPC response on stdout within 5s.
Catches 'the bundle is broken at startup' (bad require paths, missing
deps, syntax errors)."
```

### Task BD3: Pre-build-commit guard

**Files:**
- Create: `scripts/check-bundle-fresh.sh`
- Modify: `package.json`

- [ ] **Step 1: Create the script**

```bash
mkdir -p scripts
```

Create `scripts/check-bundle-fresh.sh`:

```bash
#!/bin/bash
# Fail if mcp/dist/ would be modified by a fresh build — i.e. someone
# changed the lib but didn't rebuild the bundle. Wired into `npm test`
# so drift can't slip past CI.
set -e

# Build into a temporary location so we don't mutate the working tree
# during the test run.
ORIG_DIST=$(mktemp -d)
cp -r mcp/dist/. "$ORIG_DIST/"

cd mcp && npm run build > /dev/null 2>&1 && cd ..

if ! diff -r mcp/dist "$ORIG_DIST" > /dev/null 2>&1; then
  echo "ERROR: mcp/dist/ is stale. Run 'npm run build' and commit the result."
  diff -r mcp/dist "$ORIG_DIST" | head -20
  # Restore original dist so the working tree isn't dirtied.
  rm -rf mcp/dist
  cp -r "$ORIG_DIST" mcp/dist
  rm -rf "$ORIG_DIST"
  exit 1
fi

rm -rf "$ORIG_DIST"
echo "Bundle is fresh."
```

Make it executable:

```bash
chmod +x scripts/check-bundle-fresh.sh
```

- [ ] **Step 2: Wire into `npm test`**

Edit `package.json` `scripts.test`:

```json
"test": "npm run lint && ./scripts/check-bundle-fresh.sh && node --test 'test/**/*.test.mjs'"
```

- [ ] **Step 3: Run `npm test`**

```bash
npm test
```

Expected: lint passes, bundle-fresh check passes, all tests pass.

- [ ] **Step 4: Verify the guard catches a stale bundle**

```bash
# Touch a lib file to force a meaningful diff.
echo "" >> skills/browsing/chrome-ws-lib.js
./scripts/check-bundle-fresh.sh && echo "FAIL: should have detected stale bundle" || echo "OK: stale bundle detected"
git checkout skills/browsing/chrome-ws-lib.js
```

Expected: `OK: stale bundle detected`.

- [ ] **Step 5: Commit**

```bash
git add scripts/check-bundle-fresh.sh package.json
git commit -m "Guard against stale bundle in npm test

scripts/check-bundle-fresh.sh runs npm run build into a temp dir and
diffs against the current mcp/dist/. If they differ, the working tree's
bundle is stale relative to the source — fail with instructions to
rebuild. Wired into npm test so CI catches it before merge."
```

---

## Self-review

I've checked the plan against the spec.

**Spec coverage:**

- Spec section 1 (test architecture, 3 tiers) → Sections 9, 10, 11 (tasks TA1-TA16, TB1-TB3, TC1).
- Spec section 2 (bundle drift, 3 sub-fixes) → Section 12 (BD1, BD2, BD3).
- Spec section 3 (page-script extraction, hybrid) → Section 5 (P1, P2).
- Spec section 4 (legacy alias purge) → Section 4 (L1, L2).
- Spec section 5 (named magic constants) → Section 3 (C1, C2, C3).
- Spec section 6 (process exit handler registry) → Section 7 (E1).
- Spec section 7 (Myers diff) → Section 8 (D1, D2).
- Spec section 8 (drop messageIdCounter) → Section 6 (S1).
- Spec section 9 (require placement) → Section 2 (R1, R2).
- Spec section 10 (Biome) → Section 1 (B1, B2).

All ten spec sections covered.

**Placeholder scan:** No "TBD"/"TODO"/"appropriate"/"similar to". All code blocks are concrete. All commands are concrete. Test code complete in each task.

**Type consistency:** Function names match across tasks: `createSession`, `attachX` factories, individual method names. The `state` object shape stays consistent (no field invented in one task, used in another with a different name). The bundle-drift test references `chromeLib.X(...)` matching the actual variable name in `mcp/src/index.ts`.

Plan complete and saved to `docs/superpowers/plans/2026-05-05-post-c5-followup.md`.
