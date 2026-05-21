# waitForDebuggerOnStart + runIfWaitingForDebugger is how popup dialog shims get there before the page runs

This is the headline timing card for the dialog subsystem.

## The problem

When a page opens a popup via `window.open()`, the popup is a new CDP target.
Chrome begins executing the popup's scripts immediately after attach. If the popup
contains synchronous-fire code — `confirm(...)` in an inline script, for example —
the dialog fires before any instrumentation can be installed. By the time a
`targetCreated` event arrives and the library attaches + installs its shim, the
dialog is already gone.

The same race applies to OAuth windows, extension popups, and any window whose
first script synchronously calls `alert`, `confirm`, or `prompt`.

## The solution: pause at attach, install shim, resume

`Target.setAutoAttach({autoAttach: true, waitForDebuggerOnStart: true, flatten: true})`
instructs Chrome to pause each newly attached target before its first script runs.
Chrome emits `Target.attachedToTarget` with `waitingForDebugger: true`. The target
sits idle. You have unlimited time to configure it.

The library's sequence in `lib/browser-bridge.js` and `chrome-ws-lib.js`:

1. Chrome emits `Target.attachedToTarget` with `waitingForDebugger: true`.
2. `buildPageSessionFromAttached` constructs a page session from the provided `sessionId`.
3. The `onPageSession` hook fires. For `page`-type targets, this calls
   `dialogs.attachToPageSession(ps)`, which installs:
   - `Page.addScriptToEvaluateOnNewDocument` — injects the dialog shim into every
     new document the page loads.
   - `Runtime.addBinding({name: '__dialogShim'})` — registers the JS-to-CDP
     communication channel the shim uses.
4. After the hook returns, `Runtime.runIfWaitingForDebugger` resumes the target.

The shim is now in place before any user script runs. The popup's first `confirm()`
is intercepted.

## Why only page-type targets

Service workers and background pages don't support the Page CDP domain. Calling
`Page.addScriptToEvaluateOnNewDocument` on a service worker target produces a
`'Page.enable' wasn't found` error. The auto-attach handler in `browser-bridge.js`
gates the `onPageSession` hook on `targetInfo.type === 'page'`.

## The non-paused case

Chrome also emits `Target.attachedToTarget` with `waitingForDebugger: false` for
targets that were already open when `setAutoAttach` was called (existing tabs that
get reported retrospectively). These targets are already running; trying to install
the shim via this path would be a no-op for running pages, and registering the
same `sessionId` twice in the cdp-router would cause duplicate-id protocol errors.
The handler returns early when `waitingForDebugger` is false, leaving existing
tabs to be handled by the normal `attachPageSession` path.

## Test coverage

`test/popup-dialog-integration.test.mjs` verifies the full sequence: a page opens
a popup, the popup fires `confirm()` synchronously in its first inline script, and
the test asserts that the dialog is captured under the popup's `sessionId`. Without
the F1–F3 wiring (autoAttach + onPageSession hook + runIfWaitingForDebugger), this
test fails because the dialog fires before the shim installs.

## Sources

- CDP Target domain — `setAutoAttach`, `attachedToTarget`:
  https://chromedevtools.github.io/devtools-protocol/tot/Target/
- CDP Runtime domain — `runIfWaitingForDebugger`:
  https://chromedevtools.github.io/devtools-protocol/tot/Runtime/
- `skills/browsing/chrome-ws-lib.js` — `state.ensureBridge` / `onPageSession` hook
- `skills/browsing/lib/browser-bridge.js` — `Target.attachedToTarget` handler
- `skills/browsing/lib/dialogs.js` — `attachToPageSession`
- `test/popup-dialog-integration.test.mjs`
