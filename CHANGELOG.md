# Changelog

All notable changes to the superpowers-chrome MCP project.

## [3.0.2] - 2026-05-31 - IPv6-disabled loopback no longer blocks Chrome launch

### Fixed
- `skills/browsing/lib/chrome-launcher-helpers.js`: `isPortFree()` probed both `127.0.0.1` and `::1` and treated *any* `::1` bind failure as "port occupied". In a container with IPv6 loopback disabled (`net.ipv6.conf.lo.disable_ipv6=1`), every `::1` bind returns `EADDRNOTAVAIL`, so every port in 9222–12111 looked occupied and `findAvailablePort()` threw "No available port" — Chrome never launched. Now distinguishes a genuine in-use signal (`EADDRINUSE`) from an unavailable loopback/address-family (`EADDRNOTAVAIL`/`EAFNOSUPPORT`): the dual-stack check stays a race-guard for hosts where Chrome may bind `::1` only, but a missing IPv6 loopback no longer vetoes the port. Decision extracted into a pure `portFreeFromProbes(v4, v6)` and unit-tested with both error codes; `isPortFreeOn` now resolves `{free, code}`.

### Tests
- `test/lib/chrome-process.test.mjs`: the two `getBrowserMode` "no listener → running:false" tests inherited the shared default `activePort` 9222, which the real-Chrome smoke suite binds — so they flaked under `node --test`'s parallel file execution (intermittent `running:true`). They now probe port 1 (privileged/unbound, deterministic), matching the sibling test. `npm test` is stable across parallel runs.

## [3.0.1] - 2026-05-22 - Lint fix

3.0.0 shipped with five unused-variable lint errors that `npm test`
gates on. Functional code was unaffected (428/428 tests passed when
run directly), but the canonical test command failed.

### Fixed
- `skills/browsing/lib/navigation.js`: removed the unused `dialogResolver` let-binding from the dialog-race promise (the closure used the inner `resolve` directly).
- `test/lib/chrome-process.test.mjs`: dropped unused `path`, `state`, and `fs` requires from the profile-lock integration tests.
- `test/lib/profile-lock.test.mjs`: removed unused `before` and `after` imports from `node:test` (only `beforeEach`/`afterEach` are used).

## [3.0.0] - 2026-05-22 - Schema reshape, dialog mid-navigate, multi-MCP isolation

This release is the union of 2.2.0's flatten-mode CDP bridge with the
schema/UX/correctness work that came out of running the 14-scenario
agent-driven eval corpus against it. Anyone upgrading from 2.1.0 should
read the **Changed** section — the MCP tool's parameter shape is
different, though tab_index is Postel-accepted to keep older agent
prompts working.

### Added

- **Auto-disambiguation of the default Chrome profile across parallel MCPs.** Until now every MCP server on the host defaulted to `superpowers-chrome` on port 9222, so a second MCP silently reconnected to the first's Chrome and the two agents fought over `activeTab` with no error surfaced. The bridge now claims a per-process lock file at `~/.cache/superpowers/browser-profiles/<profile>.mcp.lock`; on conflict with a live PID it falls through to `<base>-2`, `-3`, ... The first MCP keeps the simple default; later ones silently get their own Chrome. Stale locks (dead PIDs) are reclaimed automatically. See `skills/browsing/lib/profile-lock.js`.
- **`CHROME_WS_PROFILE` env var** for opting out of auto-disambiguation. Set to a profile name (alphanumeric/hyphen/underscore) and the bridge treats the profile as explicit — it acquires the named lock and, on conflict, *shares* the Chrome (the original reconnect-on-restart behavior) instead of picking an alternate. Same opt-out applies when `set_profile` is called at runtime.
- **`switch_tab` action** + sticky `activeTab` state. Match by integer index, URL substring, or title substring. `new_tab` updates `activeTab` to the newly-opened tab; `close_tab` closes the active tab. Tab routing is no longer baked into every action's parameters — the user picks once, subsequent actions follow.
- **Chrome lifecycle actions:** `kill_chrome` and `restart_chrome`. The MCP exposes them so agents can recover from a wedged or stale Chrome without restarting the MCP server itself.
- **Console logging actions:** `enable_console_logging`, `get_console_messages` (with optional `payload.since` epoch-ms filter), `clear_console_messages`. State is keyed by the page session's `sessionId`, not by tab index — log buffers survive `close_tab`/`new_tab`.
- **Auto-restart banner.** When `ensureChromeRunning` had to spawn a fresh Chrome (because the prior one died or was killed externally), the first action's response prepends `[Chrome auto-restarted; URL reset to about:blank. Re-navigate to continue.]` so the model knows its previous URL/tab state is gone.
- **`navigate` surfaces mid-load dialogs.** A basic-auth challenge, permission prompt, or other dialog that fires *during* a `Page.navigate` used to wedge the navigate for the full 30 s timeout; the response was a generic CDP timeout with no mention of the staged dialog. `navigate` now races the load wait against dialog detection and throws `DialogRefusedError` as soon as `state.dialogs[sid]` is populated — the response text includes the `dialog::*` grammar so the agent knows what to do next.
- **`browser_mode` reports the real PID for adopted Chrome.** When the bridge reconnected to a Chrome it didn't spawn (via meta.json or orphan adoption), it used to return `{pid: null, running: false}` even though the CDP was working. It now resolves the PID via meta.json or a port scan and verifies with `isPortAlive` before reporting `running: true`.
- **CLI `chrome-ws stop`** — the `stop` subcommand was advertised in `--help` but had no dispatch. Implemented now: calls `session.killChrome()` and prints `Chrome stopped` on success.
- **CLI clearer error on unknown commands.** Used to print the `raw`-specific usage banner for any unknown command (so `chrome-ws stp` would suggest the `raw` syntax). Now prints `Unknown command: <name>` and points at `--help`.
- **14-scenario agent-driven test corpus** at `tests/scenarios/*.md`. Each is a self-contained prompt a worker can execute end-to-end against the bridge. The corpus is now deterministic across fresh worker sessions — most early flakiness was test-author judgment leaking into the spec (fallback URLs, "use the right tab", "click the right thing"); the rewrite removes that ambiguity. See `tests/scenarios/README.md`.

### Changed

- **`use_browser` MCP schema collapsed to 4 parameters:** `action`, `selector`, `payload`, `timeout`. `selector` is now a top-level CSS/XPath string. `payload` is `string | object | undefined` — strings work for the common case (`navigate=URL`, `type=text`, `eval=JS`, `keyboard_press=key`, `switch_tab=match-string`), objects for the structured cases (`set_viewport={width,height,mobile?}`, `drag_drop={target}`, `extract={format}`, `screenshot={path,fullpage?}`, etc.). `tab_index` is **Postel-accepted** as a legacy alias for an implicit `switch_tab` — older agent prompts continue to work; the schema description steers new callers to `switch_tab`. Pre-3.0 callers that hardcoded `selector` inside `payload` keep working too (the parsers accept the bare-string form per action).
- **Postel acceptance** for several actions: `attr` accepts a bare string payload (the attribute name); `drag_drop` accepts a bare `{x,y}` payload or a target-selector string; `extract` accepts a bare string payload as the format (`"text"`, `"html"`, `"markdown"`); `keyboard_press` accepts shifted-letter keys. Tests in `test/mcp-postel-fixes.test.mjs`.
- **`navigate` throws on net errors.** A CDP `Page.navigate` that returns `errorText` (DNS failure, refused connection, unsafe port) used to silently report success. It now throws `Navigate failed: <netError> (<url>)`.
- **JS dialog accept/dismiss clears state.dialogs eagerly.** The router used to rely solely on Chrome firing `Page.javascriptDialogClosed` for cleanup. That event sometimes arrived late, was routed to a session without `Page.enable`, or simply didn't fire on transient dialog states — `state.dialogs[sid]` then stayed populated and the next action got "Page is behind a dialog" forever. The router now signals `clearDialog: true` for JS-kind accept/dismiss and the caller deletes the entry immediately; Chrome's event becomes a redundant best-effort sweep.
- **Mouse click skips its Element.click() fallback when a dialog is open.** The catch block used to assume any press/release timeout was a coordinate problem and fall through to `_el.click()` via `Runtime.evaluate`. When the original click had opened a dialog, that fallback queued a second click event behind the dialog — and dismissing the dialog later spawned a *second* confirm. Now the catch checks `dialogs.getOpen(ps.sessionId)` and, if a dialog is up, propagates the original timeout instead. The fallback still runs for genuine coordinate failures (hidden element, zero bbox).
- **`mouse_move` uses a humanised Bezier path** with variable speed and per-step jitter. Same `lastMousePos` tracking so chained `mouse_move` calls start from the cursor's actual position rather than (0, 0).
- **`screenshot` resolves relative paths** against the current working directory; bare filenames are saved into the auto-capture session directory as before.
- **`new_tab` navigates to its payload URL** rather than opening blank-then-navigating, so the new-tab response includes the loaded page's URL and the `activeTab` pointer is correct on return.
- **Single console-message writer.** `navigation.js` used to write to `state.consoleMessages` *and* `console-logging.js` did too — they raced on `Runtime.consoleAPICalled` timestamps and produced duplicate entries that the dedup-by-last-entry path couldn't catch (1 ms timestamp drift). `navigation.js` no longer touches that buffer; `console-logging.js` is the single writer.
- **`get_console_messages` filters by `payload.since`** (epoch ms) — entries with timestamps before the cutoff are dropped. Use to fetch only the entries from the latest navigation.

### Fixed

- **Plugin version bump to 3.0.0 across `package.json`, `mcp/package.json`, and `.claude-plugin/plugin.json`** — these had drifted between 2.0.0 / 2.1.0 / 2.2.0 in the bridge worktree, which caused Claude Code's plugin loader to pick non-deterministically between the bridge plugin and any cached marketplace copy of the same name. Stable single-version disambiguation now.
- **Adopted-orphan Chrome accumulation.** When the bridge connects to a leftover Chrome from a prior MCP session and that Chrome then dies, the bridge used to leave the meta.json untouched and accumulate zombie meta entries. Adoption now writes a fresh meta and the killChrome path clears it.
- **`chrome-ws close` accepts numeric tab indices.** Previously the CLI's `close` subcommand only matched ws-URLs; passing `0`/`1`/`2` failed. Now resolves a numeric arg to the corresponding tab index, matching every other `chrome-ws` subcommand.
- **`keyboard_press` accepts any printable key.** The dispatch table used to whitelist a small set of special keys (Tab, Enter, F1-F12, etc.) and reject everything else. Now any single-character key is dispatched as a regular keydown/keyup, with the existing `modifiers: {shift, ctrl, alt, meta}` option preserved.
- **Dialog::* click skips post-action capture.** The auto-capture wrapper used to issue a `Runtime.evaluate` for the after-action capture *during* the page's resume from the dialog, which raced against the navigation/redirect that often follows accept/dismiss and timed out. Dialog selectors now return early from capture.
- **`pageSession` pinned at action start.** `clickWithCapture` (and its peers) used to resolve `getPageSession(0)` separately for the action and for the post-action capture. When the action opened a popup, Chrome inserted the popup at index 0 between resolution and capture, so the capture ran against the wrong tab. The action now resolves `pageSession` once and threads the same instance through.
- **Focus restoration uses `el.focus({preventScroll: true})`.** A capture-wrapper that restored focus after an action used to scroll the page to the focused element, polluting screenshots/diffs with unintended `scroll: 0` events.

### Documentation

- **`docs/cdp/` reference cards** for the CDP semantics this bridge depends on: flatten-mode, per-session id counters, target lifecycle, autoAttach popup timing, navigation listener race, headless variants. Index at `docs/cdp/INDEX.md`.
- **Implementation plans** under `docs/superpowers/plans/`: `2026-05-21-flatten-mode-bridge.md` (the original bridge plan), `2026-05-22-mcp-schema-reshape.md` (the parameter collapse).

---

## [2.2.0] - 2026-05-21 - Flatten-mode CDP bridge + popup support

### Added
- **Flatten-mode CDP bridge.** The per-page WebSocket pool is replaced with a single browser-WS using CDP flatten mode + sessionId routing. Four new modules under `skills/browsing/lib/`: `browser-session.js` (the one root WS, lazy connect, sendRaw escape hatch), `cdp-router.js` (sessionId-aware dispatcher), `page-session.js` (per-page flatten-mode session with independent id-counter), `browser-bridge.js` (targets tracking, BrowserContext, autoAttach).
- **Popup support via `Target.setAutoAttach`** with `waitForDebuggerOnStart:true`. Every new target (popups, OAuth windows, child frames) is paused at attach; the dialog shim (`Page.addScriptToEvaluateOnNewDocument` + `Runtime.addBinding`) is installed; then `Runtime.runIfWaitingForDebugger` resumes. Popups with synchronously-fired confirm/alert/permission dialogs are now reliable. Integration test at `test/popup-dialog-integration.test.mjs`.
- **`BrowserContext` API** via `bridge.createBrowserContext({proxyServer?})` — incognito-style isolation with atomic dispose.
- **6 curated CDP reference cards** under `docs/cdp/` (flatten-mode, per-session-id-counters, target-lifecycle, autoattach-popup-timing, navigation-listener-race, headless-variants) for maintainers.
- **`state.ensureBridge()`** — lazy bridge attach in chrome-ws-lib; safe to call repeatedly, retries on failure.

### Changed
- **All 12 action libs migrated** to the `getPageSession` resolver shape: mouse, keyboard-input, evaluation, screenshot, navigation, extraction, file-upload, select-option, viewport, cookies, capture, console-logging. Internal change only — user-facing API (`session.click(tab, selector)` etc.) is unchanged.
- **Dialog subsystem rewritten** on top of the bridge: state keyed by `sessionId`, event handlers attached via `pageSession.onEvent`. The pool-keyed `dialogs.attachToConnection` path is retired. Dialog selector grammar (`dialog::accept` etc.) and `DialogRefusedError` semantics are unchanged.
- **Navigation lib simplified.** The second-WebSocket listener pattern (used for streaming console + waiting for `Page.loadEventFired`) is gone — `pageSession.onEvent` + `pageSession.waitForEvent` cover both needs on the one bridge socket.
- **Console-logging lib simplified.** Same idea — no more separate WebSocket; uses `pageSession.onEvent`.
- **`killChrome` calls `closeBridge` first** with a 500ms timeout fallback, so SIGTERM isn't blocked by a hung close.

### Removed
- **`skills/browsing/lib/cdp-connection.js`** — the per-page connection pool. ~190 lines deleted.
- **`state.connectionPool`** field — no longer needed.
- The silent single-use-WS fallback in the old `sendCdpCommand` — now a hard fail at the bridge layer; callers decide.

### Architecture notes for maintainers
- See `docs/cdp/INDEX.md` for the 6 reference cards documenting the CDP semantics we depend on.
- See `docs/superpowers/plans/2026-05-21-flatten-mode-bridge.md` for the full implementation plan including the E9 timing finding and the Phase F resolution.
- Inspired by external PR #34 (mhat) — architecture was sound; we rewrote on current main to integrate with the dialog subsystem cleanly and added the autoAttach/popup wiring that wasn't in the original.

---

## [2.1.0] - 2026-05-14 - Dialog handling

### Added
- **Dialog handling.** JS dialogs (`alert` / `confirm` / `prompt` / `beforeunload`), WebUSB / Bluetooth / Serial / HID device choosers, permission prompts (camera / microphone / notifications / geolocation / clipboard — via a `document_start` JS-API shim), and HTTP basic-auth challenges no longer wedge the CDP connection. Each dialog is surfaced as a synthetic "page" that the agent interacts with using the existing `click` and `type` actions against a small `dialog::*` selector grammar: `dialog::accept`, `dialog::dismiss`, `dialog::prompt`, `dialog::device[id="..."]`, `dialog::username`, `dialog::password`. While a dialog is open, page-targeted actions (`extract`, `screenshot`, `eval`, `click <real-selector>`, etc.) return a clear refusal that includes the dialog content and handling instructions; browser-targeted actions (`list_tabs`, `new_tab`, `close_tab`, etc.) pass through unaffected. See `docs/superpowers/specs/2026-05-13-dialog-handling-design.md` for the full design.

### Changed
- The pooled CDP connection now enables `Runtime` (in addition to `Page` / `DeviceAccess` / `Fetch`) so that `Runtime.addBinding` can plumb the permission-shim binding into page main worlds. Required for Chrome 148+.
- Page-targeted actions that encounter an open dialog throw a typed `DialogRefusedError` from the session-boundary wrapper; the MCP top-level handler catches and formats it as a synthetic-dialog tool response. Internal architecture: every page-targeted session method (29 of them, enumerated in one Set) is gated at the `chrome-ws-lib` session boundary by a single wrapper, instead of relying on per-action middleware.

---

## [2.0.0] - 2026-05-06 - Per-session factory, three-tier test suite, and correctness fixes

Major release. Breaking changes for any external consumer of the lib's pre-factory module-level state or the legacy method aliases. The MCP server and CLI bundled with this plugin are unaffected — they use the canonical names.

### Added
- **`createSession({ host, port })`** factory in `chrome-ws-lib.js` — returns a fresh state-bag with a private connection pool, console-message map, profile name, Chrome process handle, active CDP port, and host-override. Two sessions in one process don't share state. Unblocks any caller that wants to drive multiple Chromes concurrently from one Node process.
- **`createOverride({ host, port })`** factory in `host-override.js` — per-instance host/port/override-enabled state with `getHost`, `getPort`, `getBase`, `isOverrideEnabled`, `rewriteWsUrl`, `setDefaults`. Underpins per-session host-override in `createSession()`.
- **Three-tier test suite** (140 tests, up from 23): per-lib unit tests with mocked `sendCdpCommand`/`resolveWsUrl`, jsdom-backed integration tests for `select-option` and the page-side scripts, and a real-Chrome smoke suite gated on Chrome being installed.
- **Bundle drift detection** in `npm test`: a regex-scrape of `chromeLib.X(` calls in the bundle vs. the lib's actual exports, a subprocess test that the bundle responds to MCP `initialize`, and a pre-build-commit guard that fails CI if `mcp/dist/` would change after a fresh build.
- **Biome lint** with a minimal correctness/style ruleset, wired into `npm test`.
- **`findPidOnPort(port)`** cross-platform helper (lsof on macOS/Linux, netstat on Windows).
- **`test/session-isolation.test.mjs`** — regression gate covering per-session state isolation.

### Fixed
- **`evaluate()` now throws on JavaScript errors.** Previously, `evaluate`/`evaluateJson`/`evaluateRaw` returned `undefined` when the page-side JS threw or a Promise rejected — the `result.exceptionDetails` on the CDP response was never inspected. **This is a behavior change for callers**: code that relied on getting `undefined` for a failed evaluation will now see thrown errors. The MCP `eval` action and CLI `eval` command surface the error to the caller.
- **`waitForElement()` and `waitForText()` actually honor their timeout.** Both built their own `Runtime.evaluate` payload with a `setTimeout(reject)` for the timeout case but bypassed the `exceptionDetails` check, so the rejection was silently swallowed and the wait resolved as if the element/text was found. Now route through `evaluate()` so the timeout properly rejects. The MCP `await_element` and `await_text` actions inherit the fix.
- **`navigate()` no longer hangs 30 seconds on fast-loading pages.** `Page.enable` was being sent on the pooled connection, but Chrome scopes Page events per-connection — the listener WebSocket never received `Page.loadEventFired`. Now sends `Page.enable` on the listener connection itself. `Page.navigate` failures and enable-ack errors propagate to the caller (previously swallowed).
- **`startChrome()` polls Chrome's debug port instead of sleeping a fixed 2 seconds.** On slower machines Chrome can take longer than 2s to open the port; every subsequent CDP call would fail with `ECONNREFUSED`. Now polls every 200ms up to a 15-second deadline.
- **`killChrome()` works for sessions that reconnected to a Chrome they didn't launch.** Previously it early-returned when `state.chromeProcess` was null, leaving `showBrowser`/`hideBrowser` unable to free the port. Now falls back to `findPidOnPort(state.activePort)` and SIGTERMs the holder.
- **`generateHtmlDiff()` detects reordered identical lines.** Previous set-based logic returned "no changes" for any HTML where the line set was unchanged. Replaced with a hand-rolled Myers line diff.
- **Process exit handlers no longer leak per-session.** Previously every `initializeSession()` registered three new `process.on(...)` handlers; N sessions meant 3N handlers. Now registered once at module scope, iterating a Set of active session-cleanup callbacks.
- **CLI `chrome-ws eval` awaits Promises.** Previously called `Runtime.evaluate` without `awaitPromise:true`, so async expressions returned `{}` instead of resolved values.
- **CLI `chrome-ws select` supports labels and multi-select.** Previously did `el.value = X` directly with no support for visible-label match or JSON-array multi-select.
- **CLI `chrome-ws fill` errors on missing element.** Previously silent success with exit 0 when the selector didn't match.
- **CLI `chrome-ws wait-for [timeout-ms]` honors the timeout argument.** Previously ignored, falling through to the 30s CDP cap.
- **CLI `chrome-ws wait-text [timeout-ms]` honors the timeout argument.** Previously consumed the timeout into the search-text via `args.join(' ')`.
- **CLI `chrome-ws --port=N` actually targets that Chrome.** Previously the CLI's session was constructed without `--port`, so all delegating commands hit the env-default port.
- **CLI commands exit cleanly.** Previously hung indefinitely after success because pooled WebSocket connections kept Node alive; now `closeAllConnections()` runs on the success path.

### Changed
- **Consumer migration**: `mcp/src/index.ts` and `skills/browsing/chrome-ws` now construct sessions explicitly — `require('./chrome-ws-lib').createSession()` and `require('./host-override').createOverride()`.
- **CLI buggy commands delegate to the lib.** `eval`, `select`, `fill`, `wait-for`, `wait-text` now call `session.<method>` instead of constructing their own `Runtime.evaluate` payload. The CLI now inherits the lib's correctness fixes.
- **Page-side scripts extracted** from `lib/capture.js` into `lib/page-scripts/markdown.js` and `lib/page-scripts/dom-summary.js`. Same behavior; the scripts can now be linted and tested directly against jsdom.
- **CLI is now linted by Biome.** The CLI was previously excluded from the lint includes because it has no file extension; now in scope.

### Removed
- **Legacy module-level exports from `host-override.js`**: `CHROME_DEBUG_HOST`, `CHROME_DEBUG_PORT`, `CHROME_DEBUG_BASE`, `WS_OVERRIDE_ENABLED`, and top-level `rewriteWsUrl`. Use `createOverride()` instead.
- **Legacy method aliases on the session object**: `cdpClick` (use `click`), `insertText` (use `fill`). Internal-only `keyboardType`, `spaNavigate`, `hrefNavigate` also removed. External consumers should migrate to the canonical names.
- **`state.messageIdCounter`** from session state. CDP message ids are scoped per-connection; `id = 1` works for the single-use connection.
- **`skills/browsing/test-host-override.js`** smoke test (covered by `test/session-isolation.test.mjs`).

---

## [1.12.0] - 2026-04-14 - Merge human_type into type

### Changed
- **`type` now uses realistic keystroke timing**: `type` calls `humanType()` internally, typing with natural inter-key delays (~80-160ms/char) and per-keystroke keyDown/keyUp events in headed mode
- **Removed `human_type` action**: No longer a separate action. Use `type` for all text input

### Removed
- `human_type` action — `type` now does the same thing

---

## [1.11.0] - 2026-04-13 - Visibility-aware element selection, async eval, crash fix

### Fixed
- **Element selection prefers visible elements over hidden ones**: `getElementSelector()` now uses `querySelectorAll()` to find all matches and picks the first with a non-zero bounding rect. Previously, `querySelector()` returned the first DOM match regardless of visibility, causing CDP clicks on responsive pages to hit hidden mobile-layout elements at coordinates (0,0) instead of the visible desktop element. Falls back to first DOM match with a `console.warn` when all matches have zero dimensions
- **`evaluate()` now awaits async expressions**: Added `awaitPromise: true` to the `Runtime.evaluate` CDP call. Previously, async expressions (fetch, async IIFEs) returned the Promise object as `undefined` or `[object Object]` instead of the resolved value. `evaluateJson()` already had this — now `evaluate()` does too
- **`tabs.filter is not a function` crash**: `resolveWsUrl()` and `closeTab()` now check `Array.isArray()` before calling `.filter()`/`.find()` on `chromeHttp('/json')` results. When Chrome returns a non-array response (empty object, error), this previously crashed. `getTabs()` already had this guard (#27)

### Added
- **Test suite**: First project-level tests using Node.js built-in test runner (`node:test`) with jsdom for DOM simulation. Covers element visibility selection, async evaluate behavior, and array guards on CDP responses

---

## [1.10.0] - 2026-04-10 - Custom Chrome launch flags via `CHROME_EXTRA_ARGS`

### Added
- **`CHROME_EXTRA_ARGS` env var**: whitespace-separated Chrome launch flags that are appended to the hardcoded flag list in `startChrome()`. Unblocks containerized/headless setups that need to inject flags like `--use-gl=angle --use-angle=swiftshader-webgl --enable-unsafe-swiftshader` for software WebGL (SwiftShader) when no GPU is present. Opt-in: unset = no behavior change (#32)
- **`buildChromeArgs()`** exported from `chrome-ws-lib` — pure function that assembles the Chrome launch flag list, enabling unit tests and external reuse

---

## [1.9.0] - 2026-04-09 - CDP Mouse Actions, Human-Like Typing, and File Upload

### Added
- **`hover`**: Move mouse over element via CDP `mouseMoved`. Triggers CSS `:hover`, `mouseenter`/`mouseover` events, tooltips, dropdown menus
- **`drag_drop`**: Native drag-and-drop via CDP mouse event sequence (`mousePressed` → interpolated `mouseMoved` steps → `mouseReleased`). Fixes the browser restriction where synthetic `DragEvent` objects have neutered `DataTransfer`. Supports selector-to-selector and selector-to-coordinate targets
- **`mouse_move`**: Raw coordinate mouse movement with optional smooth interpolation. Useful for pre-click mouse patterns (bot detection) and captcha puzzles
- **`scroll`**: Mouse wheel scrolling via CDP `mouseWheel`. Accepts direction strings (`up`/`down`/`left`/`right`) or JSON `{"deltaX":N,"deltaY":N}`. Simulates real wheel input vs `scrollTo()` which bot detectors flag
- **`double_click`**: Double-click with `clickCount:2`, fires `dblclick` event
- **`right_click`**: Right-click with `button:'right'`, fires `contextmenu` event
- **`human_type`**: Character-by-character text entry with realistic inter-key timing (~80-160ms per character). In headed mode, fires full `keyDown`/`keyUp` event chain per character with Shift handling for uppercase and symbols. In headless mode, uses `insertText` per character (headless Chrome intercepts `rawKeyDown` as browser shortcuts). **Recommended as the default text entry method** — `type` is now for speed-over-realism cases
- **`file_upload`**: Set files on `input[type=file]` elements via `DOM.setFileInputFiles`. The only way to programmatically upload files (JavaScript security restrictions prevent it)

### Changed
- Tool description now recommends `human_type` over `type` for text entry
- Help text lists `human_type` as PREFERRED in main interaction section
- Essential patterns (login flow) updated to use `human_type` + `keyboard_press Enter`
- Browsing skill (SKILL.md) fully updated with all new actions, examples, and patterns

---

## [1.8.0] - 2026-02-25 - Viewport Emulation, Full-Page Screenshots, and HiDPI Fix

### Added
- **Viewport emulation** (`set_viewport`): device emulation with custom width/height/deviceScaleFactor and mobile mode (touch events + mobile UA string). Useful for responsive design testing and mobile screenshots
- **`clear_viewport`**: reset device emulation to browser default
- **`get_viewport`**: query current CSS viewport dimensions and devicePixelRatio
- **`clear_cookies`**: clear all browser cookies via CDP `Network.clearBrowserCookies`, without switching profiles
- **Full-page screenshots** (`fullpage: true`): capture entire scrollable page content beyond the visible viewport using `captureBeyondViewport` and `Page.getLayoutMetrics`. Available in MCP (`{"action": "screenshot", "payload": "full.png", "fullpage": true}`), CLI (`chrome-ws screenshot 0 full.png --fullpage`), and lib
- **`chrome-ws pid`** command: prints Chrome PID for X11 window management (e.g. `xdotool search --pid`)
- **`chrome-ws info`** command: prints JSON with pid, port, mode, profile, profileDir, and running status; reads meta.json so it works across processes
- **`getChromePid()`** exported from chrome-ws-lib
- **`browser_mode` action** now includes `pid` field

### Fixed
- **HiDPI screenshot sizing on Linux**: Viewport screenshots (no selector) now pass an explicit clip using `window.innerWidth`/`window.innerHeight` with `scale: 1` instead of relying on Chrome's internal DPI-scaled dimensions. All screenshots also pass `fromSurface: true`. Fixes oversized screenshots on Linux displays with system DPI scaling (e.g. 1.5x/Xft.dpi:144)

### Security
- **profileName path traversal**: `setProfileName()` now validates the profile name against `[a-zA-Z0-9_-]+` before writing meta.json, preventing path traversal via user-supplied profile names

---

## [1.7.0] - 2026-02-08 - Dynamic Port Allocation and Multi-Instance Support

### Added
- **Dynamic CDP port allocation**: Chrome no longer hardcodes port 9222. `startChrome()` finds an available port in range 9222-12111, enabling multiple parallel Chrome instances without conflicts
- **Per-profile meta.json**: Port assignment, PID, and headless mode are persisted at `~/.cache/superpowers/browser-profiles/{name}.meta.json`. This enables:
  - Reconnection to Chrome instances that survive MCP restarts
  - Collision detection when port is already in use
  - Other sessions discovering which port a profile's Chrome is on
- **`--port=N` flag**: Both MCP server and CLI accept explicit port override
  - MCP: `node mcp/dist/index.js --port=9444`
  - CLI: `./chrome-ws start --port=9555`
- **`isPortAlive()` / `findAvailablePort()` utilities**: Exported from chrome-ws-lib for advanced use
- **`browser_mode` action**: Now returns `port` field alongside headless/headed status

### Changed
- **`startChrome()` signature**: New optional third parameter `port` for explicit port selection
- **Port priority**: explicit `--port` param > `CHROME_WS_PORT` env var > dynamic allocation
- **`showBrowser`/`hideBrowser`**: Now preserve the active port across Chrome restarts
- **`killChrome()`**: Clears meta.json so other sessions know the port is free

### Technical
- Added `chromeHttpAt(host, port, path, method)` for probing ports before setting `activePort`
- Module-level `activePort` variable replaces static `CHROME_DEBUG_PORT` in `chromeHttp()`
- `rewriteWsUrl` calls pass `activePort` for correct WebSocket URL rewriting
- Stale meta.json detected via PID liveness check (`process.kill(pid, 0)`) and Chrome `/json/version` probe

---

## [1.6.4] - 2026-01-31 - Clarify Auto-Capture in Tool Description and Skill

### Changed
- **MCP tool description**: Rewritten to clearly describe what each auto-captured file contains (viewport screenshot, structured markdown, full DOM, console messages) and guide Claude to prefer reading them over using extract or screenshot actions
- **MCP help text**: Aligned auto-capture section with new tool description language
- **Browsing skill**: Added Auto-Capture section explaining the capture system; updated screenshot action to indicate viewport screenshots are already auto-captured

---

## [1.6.3] - 2026-01-28 - Bug Fixes and Auto-Downscale Screenshots

### Fixed
- **Enter key form submission**: Added `text: '\r'` to Enter keyDown events, enabling native form submission via `\n` in type payloads
- **XPath text() selector on mixed content**: XPath selectors like `//a[text()='Settings']` now fallback to `normalize-space()` for elements with mixed content (e.g., `<a><svg/>Settings</a>`)
- **README Quick Start path**: Updated plugin installation path to include marketplace/version structure

### Added
- **Auto-downscale screenshots**: Screenshots exceeding 1800px are automatically downscaled using native tools (sips on macOS, ImageMagick on Linux) to prevent Claude API "2000px limit" errors in many-image mode
- **Eval patterns in skill docs**: Added documented patterns for viewport resize, cookie clearing, and scrolling via `eval` action
- **Test harness**: Added `test-harness.js` for automated React input testing (50+ iterations)

### Changed
- **Tab and Space keys**: Added `text` property to Tab (`\t`) and Space (` `) key definitions for consistency

---

## [1.6.2] - 2025-12-21 - Focus Preservation and Tab Navigation

### Fixed
- **Tab/Enter not working in type payloads**: Fixed `\t` and `\n` escape sequences in MCP payloads
  - MCP payloads contain literal backslash-t/n strings, not actual tab/newline characters
  - Added preprocessing to convert `\t` → tab and `\n` → newline before parsing
  - Now `type(selector, "field1\tfield2\n")` correctly tabs between fields and submits
- **Focus lost during screenshots**: Screenshots were stealing focus, breaking Tab navigation
  - Added `saveFocus()` and `restoreFocus()` helpers to `captureActionWithDiff()`
  - Saves focused element (by id, name, or DOM path) before screenshot
  - Restores focus after screenshot so subsequent actions work correctly
- **Type with selector losing focus**: Changed `fill()` to use `el.focus()` instead of `click()`
  - Click triggers `capturePageArtifacts()` which takes a screenshot, losing focus
  - Using JS focus avoids the capture side effect

### Technical
- `fill()` now preprocesses value with `.replace(/\\t/g, '\t').replace(/\\n/g, '\n')`
- `captureActionWithDiff()` wraps before-screenshot with focus save/restore
- Focus identification uses id > name > DOM path fallback strategy

---

## [1.6.1] - 2025-12-15 - Auto-Detect Headless Mode in Containers

### Fixed
- **Chrome crashes in containers**: MCP server now auto-detects display availability
  - Linux: Checks `DISPLAY` or `WAYLAND_DISPLAY` environment variables
  - macOS: Checks `TERM_PROGRAM` or `DISPLAY`
  - Windows: Assumes display available (headless servers rare)
  - Falls back to headless mode when no display detected
- **Command-line overrides**: Added `--headed` flag to complement existing `--headless`
  - `--headless`: Force headless mode
  - `--headed`: Force headed mode (will fail if no display)
  - No flag: Auto-detect based on environment
- **Improved logging**: Startup message now shows mode and why it was chosen
  - Example: `(headless mode, auto-detected no display)`

### Technical
- Added `hasDisplay()` function for cross-platform display detection
- Previously Chrome defaulted to headed mode unless `--headless` was passed, causing crashes in containers/CI

---

## [1.6.0] - 2025-12-05 - XDG Cache, Browser Agent, and Profile Management

### Added
- **Persistent Chrome profiles with "superpowers-chrome" default**: Browser data now persists across sessions
  - Default profile: `superpowers-chrome`
  - Profile storage: `~/.cache/superpowers/browser-profiles/{profile-name}/`
  - Persists cookies, localStorage, extensions, auth sessions
  - Profile management actions: `set_profile`, `get_profile`
  - Optional profile parameter to `startChrome(headless, profileName)`
  - Agent-specific profiles enable isolated browser states
- **Headless mode by default**: Chrome now starts in headless mode for better performance and less desktop clutter
  - Screenshots work perfectly in headless mode
  - Faster startup and lower resource usage
  - No browser windows cluttering the desktop
- **Browser mode toggle**: New actions to control headless/headed mode
  - `show_browser`: Switch to headed mode (visible browser window)
  - `hide_browser`: Switch to headless mode (invisible browser)
  - `browser_mode`: Check current mode status and active profile
  - ⚠️ **WARNING**: Toggling modes restarts Chrome and reloads pages via GET (loses POST state)
- **XDG cache directory**: Session files now stored in platform-appropriate cache locations
  - macOS: `~/Library/Caches/superpowers/browser/YYYY-MM-DD/session-{timestamp}/`
  - Linux: `~/.cache/superpowers/browser/YYYY-MM-DD/session-{timestamp}/`
  - Windows: `%LOCALAPPDATA%/superpowers/browser/YYYY-MM-DD/session-{timestamp}/`
  - Respects `XDG_CACHE_HOME` environment variable on Linux
  - Date-based organization for easier cleanup
- **browser-user agent**: New read-only agent for browser automation tasks
  - Pre-loaded with browsing skill
  - Restricted to read-only tools (Read, Grep, Glob, Skill, use_browser)
  - Cannot modify files or execute shell commands
  - Has access to browser cache directory for viewing captured pages

### Changed
- Chrome now defaults to headless mode instead of headed mode
- Chrome profiles now persist in XDG cache directory instead of temp directory
- Session directory structure uses XDG cache conventions
- Browser process management improved with proper PID tracking and graceful shutdown
- `browser_mode` action now returns profile information

### Fixed
- **set_profile action**: Fixed bug where `ensureChromeRunning()` prevented profile changes by exempting profile/info actions from auto-start

### Technical
- Added `chromeProcess`, `chromeHeadless`, `chromeUserDataDir`, `chromeProfileName` state tracking
- Implemented `killChrome()`, `showBrowser()`, `hideBrowser()`, `getBrowserMode()` functions
- Implemented `getChromeProfileDir()`, `getProfileName()`, `setProfileName()` for profile management
- `startChrome()` now accepts optional `profileName` parameter
- Export `getXdgCacheHome()` and `getChromeProfileDir()` for external use
- MCP server updated with five new actions: browser mode control + profile management
- Help text updated with browser mode and profile management documentation
- Comprehensive test suites:
  - `test-headless-toggle.cjs` - Validates headless mode switching
  - `test-profiles.cjs` - Validates profile isolation and persistence

---

## [1.5.4] - 2025-11-30 - Screenshot Returns Absolute Path

### Fixed
- **Screenshot path confusion**: `screenshot` action now returns absolute path instead of relative filename
  - Before: `Screenshot saved to solar_optimum.png` (Claude can't find it)
  - After: `Screenshot saved to /Users/jesse/project/solar_optimum.png` (Claude reads it directly)

---

## [1.5.3] - 2025-11-30 - Image Visibility and Single-Directory Auth

### Fixed
- **Image content visibility**: Markdown extraction now includes images with alt text and dimensions
  - Adds prominent notice: "📷 This page contains N significant image(s). Check screenshot.png for visual content."
  - Lists each image with description and size info
  - Handles `<figure>` elements with captions
- **Directory auth spam**: All capture files now go in single session directory
  - Changed from subdirectories (`001-navigate-timestamp/page.md`) to flat structure (`001-navigate.md`)
  - Only one directory permission prompt per session instead of per-page
  - Files use prefixes: `001-navigate.html`, `001-navigate.md`, `001-navigate.png`, `001-navigate-console.txt`

### Changed
- `createCaptureDir()` renamed to `createCapturePrefix()` - returns prefix string instead of creating subdirectory
- Response format updated to show flat file structure with prefixes
- Help text updated to reflect new file naming convention

---

## [1.5.2] - 2025-11-22 - Critical Fix: Restore Auto-Capture Functionality

### Fixed
- **CRITICAL**: Restored all auto-capture and session management functionality that was accidentally removed
  - `initializeSession()`, `cleanupSession()`, `createCaptureDir()` - Session lifecycle management
  - `clickWithCapture()`, `fillWithCapture()`, `selectOptionWithCapture()`, `evaluateWithCapture()` - Auto-capture DOM actions
  - `enableConsoleLogging()`, `getConsoleMessages()`, `clearConsoleMessages()` - Console logging utilities
  - `generateDomSummary()`, `getPageSize()`, `generateMarkdown()`, `capturePageArtifacts()` - Capture utilities
  - Session-based directory structure and time-ordered capture subdirectories
  - 4-file capture format (page.html, page.md, screenshot.png, console-log.txt)
  - Smart DOM summary system
- **MCP server**: Now starts correctly without `initializeSession is not a function` error
- **Build system**: Rebuilt bundle with all restored functionality

### Changed
- **Windows compatibility**: Maintained host-override improvements from v1.5.0-1.5.1
  - `CHROME_DEBUG_HOST`, `CHROME_DEBUG_PORT`, `rewriteWsUrl()` integration preserved
  - Enhanced `getTabs()` and `newTab()` with WebSocket URL rewriting
  - Improved error handling for array responses

### Technical Details
The v1.5.0-1.5.1 Windows support work accidentally removed ~466 lines of auto-capture code from `chrome-ws-lib.js` that was added in v1.4.0. This release restores all v1.4.0 functionality while preserving the Windows host-override improvements.

---

## [1.5.1] - 2025-11-20 - Build System Fix and Release Documentation

### Fixed
- **Build system**: Fixed outdated `mcp/dist/index.js` bundle causing `initializeSession is not a function` error
- **Version sync**: Aligned all package.json versions to 1.5.1

### Added
- **CLAUDE.md**: Comprehensive release engineering documentation
  - Complete build system architecture
  - Step-by-step release process
  - Version management guidelines
  - Marketplace distribution workflow
  - Troubleshooting guide
  - Development workflow best practices

### Changed
- **Build verification**: Added clean build process to ensure fresh bundled output
- **Documentation**: Improved clarity on build dependencies and bundling process

---

## [1.4.2] - 2025-11-02 - Auto-Capture Documentation and Response Clarity

### Changed
- **MCP tool description**: Added clear auto-capture messaging in tool description
  - "DOM actions save page content to disk automatically - no extract needed"
  - "AUTO-SAVE: Each DOM action saves page.html, page.md, screenshot.png to temp directory"
  - Updated workflow examples to show auto-saved files instead of manual extract

- **Response format improvements**: Made file availability crystal clear
  - "Current URL:" shows exact page location
  - "Output dir:" clearly indicates capture directory
  - "Full webpage content: page.html, page.md" explicitly states complete page capture
  - "Screenshot: screenshot.png" and "JS console: console-log.txt" clearly labeled

- **Enhanced action functions**: All capture-enabled actions now include current URL in response

### Benefits
- **Eliminates confusion**: Claude clearly understands files are automatically available
- **Reduces redundant calls**: Prevents unnecessary extract actions after navigation
- **Improves UX**: Clear file categorization and location information
- **Better workflows**: Updated examples show proper auto-capture usage patterns

---

## [1.4.1] - 2025-11-02 - NPX Installation and GitHub Issues Resolution

### Added
- **NPX GitHub installation**: Direct installation via `npx github:obra/superpowers-chrome`
- **Headless mode support**: `--headless` CLI flag for server environments
- **Root package.json**: Enables proper NPX distribution from GitHub repository

### Fixed
- **GitHub Issue #1**: Installation problems resolved with NPX alternative
- **GitHub Issue #4**: Added progressive disclosure test automation guidance to skill
- **GitHub PR #5**: Merged bash shebang portability improvements

### Changed
- **Documentation clarity**: Enhanced auto-capture guidance in help action
- **Skill enhancements**: Added collapsible test automation section with troubleshooting

---

## [1.4.0] - 2025-11-02 - Session-Based Auto-Capture Enhancement

### Added

#### Session Management System
- **Session-based directory structure**: `/tmp/chrome-session-{timestamp}/`
  - Time-ordered capture subdirectories: `001-navigate-{timestamp}/`, `002-click-{timestamp}/`, etc.
  - Automatic cleanup on MCP exit (SIGINT, SIGTERM, normal exit)
  - Session initialization on first MCP use with `initializeSession()`
  - Global session tracking with `sessionDir` and `captureCounter` variables

#### Auto-Capture for DOM Actions
- **Navigate action enhancement**: Added `autoCapture` parameter (enabled by default in MCP)
- **New capture-enabled action functions**:
  - `clickWithCapture(tabIndex, selector)` - Click + immediate page capture
  - `fillWithCapture(tabIndex, selector, value)` - Type + post-type state capture
  - `selectOptionWithCapture(tabIndex, selector, value)` - Select + result capture
  - `evaluateWithCapture(tabIndex, expression)` - JavaScript eval + state capture

#### Standardized Capture Resources
- **4-file capture format per action**:
  - `page.html` - Full rendered DOM using `document.documentElement.outerHTML`
  - `page.md` - Structured markdown extraction from page elements
  - `screenshot.png` - Visual page state (renamed from `page.png`)
  - `console-log.txt` - Console message placeholder file

#### Smart DOM Summary System
- **Token-efficient DOM analysis** (replaces verbose hierarchical approach)
- **Interactive element counting**: Buttons, inputs, links with readable formatting
- **Structural analysis**: Navigation, main content areas, forms detection
- **Heading extraction**: First 3 H1 elements with truncation indicators
- **Bounded output**: <25 tokens regardless of page complexity

#### Console Logging Infrastructure
- **Console message storage**: Per-tab message tracking with `consoleMessages` Map
- **Runtime domain integration**: Console API event capture during navigation
- **Utility functions**: `enableConsoleLogging()`, `getConsoleMessages()`, `clearConsoleMessages()`
- **Placeholder implementation**: Framework ready for full console capture

#### Self-Contained Documentation
- **Help action**: New `{"action": "help"}` returns complete MCP documentation
- **Skill independence**: MCP functions on systems without Claude Code skills
- **Embedded guidance**: All actions, parameters, examples, and troubleshooting included
- **Auto-capture explanation**: Documents the new capture system within the MCP

#### NPX GitHub Installation
- **Root package.json**: Enables `npx github:obra/superpowers-chrome` installation
- **Prepare script**: Automatically builds MCP during NPX installation
- **File distribution**: Proper files array for NPX packaging
- **Binary configuration**: Correct bin path for direct execution

#### Headless Mode Support
- **CLI flag support**: `--headless` flag for NPX MCP server
- **Enhanced startChrome()**: Accepts headless parameter for server environments
- **Auto-detection**: Headless mode logged in server startup message
- **CI/CD ready**: Perfect for automated testing and server deployments

### Changed

#### MCP Response Format Overhaul
- **Navigate responses**: Enhanced object return vs simple string
  ```
  → https://example.com (capture #001)
  Size: 1200×765
  Snapshot: /tmp/chrome-session-123/001-navigate-456/
  Resources: page.html, page.md, screenshot.png, console-log.txt
  DOM:
    Example Domain
    Interactive: 0 buttons, 0 inputs, 1 links
    Headings: "Example Domain"
    Layout: body
  ```

- **DOM action responses**: All now return detailed capture information
  - Click: `"Clicked: selector"` → Rich capture response
  - Type: `"Typed into: selector"` → Rich capture response with typed value
  - Select: `"Selected: value"` → Rich capture response with selection details
  - Eval: `"[result]"` → Rich capture response with expression and result

#### Internal Function Modifications
- **navigate() function**: Added `autoCapture` parameter and enhanced return object
- **Action routing in MCP**: All DOM actions now use `*WithCapture` variants
- **Response formatting**: New `formatActionResponse()` function for consistent output
- **File naming**: Standardized resource names across all captures

#### DOM Summary Algorithm
- **Replaced hierarchical DOM tree** with smart statistical summary
- **Element counting approach**: `document.querySelectorAll()` for precise counts
- **Layout detection**: Semantic element identification (nav, main, forms)
- **Text formatting improvements**: Quoted headings, readable spacing, truncation indicators

#### Documentation and User Experience
- **Auto-capture clarity**: Updated help to emphasize files are automatically saved
- **Extract usage guidance**: Clarified when extract is needed vs when files are already available
- **Progressive disclosure**: Added collapsible test automation section to skill
- **Troubleshooting**: Enhanced with JSON.stringify patterns and chrome-ws reference guidance

### Technical Implementation Details

#### File Structure Changes
```
skills/browsing/chrome-ws-lib.js:
  + Session management functions (initializeSession, cleanupSession, createCaptureDir)
  + Console logging utilities (enableConsoleLogging, getConsoleMessages, clearConsoleMessages)
  + Enhanced DOM functions (generateDomSummary, getPageSize, generateMarkdown, capturePageArtifacts)
  + Capture-enabled action wrappers (clickWithCapture, fillWithCapture, selectOptionWithCapture, evaluateWithCapture)
  * Modified navigate() function with autoCapture parameter

mcp/src/index.ts:
  + formatActionResponse() function for consistent response formatting
  + Enhanced navigate action with rich response handling
  * Modified click, type, select, eval actions to use capture variants
  + Session initialization in main() function
```

#### Process Lifecycle Integration
- **Cleanup handlers**: Registered for `exit`, `SIGINT`, `SIGTERM` events
- **Session persistence**: Directory maintained throughout MCP lifetime
- **Capture sequencing**: Incremental numbering for temporal ordering
- **Error recovery**: Auto-capture failures don't prevent action success

#### Browser Integration Enhancements
- **Dual domain enablement**: Page + Runtime domains for navigation with auto-capture
- **Message handling**: Enhanced WebSocket message processing for console events
- **Timing coordination**: 1-second delay after page load for console message capture
- **Parallel processing**: Simultaneous HTML, markdown, screenshot, and DOM summary generation

### Backward Compatibility
- **Original functions preserved**: `click()`, `fill()`, `selectOption()`, `evaluate()` unchanged
- **MCP tool interface**: No changes to external tool parameters or descriptions
- **Graceful degradation**: Auto-capture failures return basic success responses
- **Module exports**: All existing exports maintained, new functions added

### Performance Optimizations
- **Token efficiency**: 95% reduction in DOM summary token usage
- **Parallel capture**: Simultaneous file generation for faster response times
- **Memory management**: Session cleanup prevents directory accumulation
- **Bounded operations**: DOM summary algorithm has fixed computational complexity

### Benefits for Claude
- **Rich context**: Comprehensive page state after every DOM-changing action
- **Visual debugging**: Screenshots show immediate action results
- **Structured analysis**: Markdown format enables content analysis
- **Temporal tracking**: Numbered captures show interaction progression
- **Token preservation**: Smart DOM summary prevents large page token explosion
- **Organized workflow**: Session-based storage for complex automation sequences

---

## [1.3.0] - 2025-11-01

### Added
- XPath selector support alongside CSS selectors
- Improved tool clarity with examples
- Auto-tab creation when none exist

### Changed
- Enhanced payload parameter documentation with action-specific details
- Improved error handling for out-of-range tab indices

### Fixed
- Tab index validation and error messages