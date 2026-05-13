# Dialog Handling Design

**Date:** 2026-05-13
**Status:** Draft

## Context

The MCP and CLI surfaces in this plugin (`use_browser` action + `chrome-ws`)
wedge whenever a page opens a JavaScript dialog (`alert`, `confirm`,
`prompt`, `beforeunload`), a WebUSB / Bluetooth / Serial / HID device
chooser, a permission prompt (camera, microphone, notifications,
clipboard, geolocation), or an HTTP basic auth challenge. The page-target
CDP connection stops responding until a human dismisses the dialog in
Chrome. Empirically confirmed: a `data:` URL that schedules
`alert('test')` causes the next `extract` call to return
`CDP command timeout`.

The codebase today has zero dialog handling logic. The system prompt
shipped with the tools tells agents not to trigger dialogs, which works
as a workaround but cuts off legitimate use cases: WebUSB selection,
basic-auth-protected pages, sites that meaningfully use `confirm()` for
destructive actions, and any page that warns on unload.

This document specifies a single integrated dialog handling subsystem
that surfaces dialogs as synthetic "pages" the agent can read and
interact with using the existing `click` / `type` / `extract` actions.

## Goals

1. Detect every dialog class CDP exposes an event for: JS dialogs, device
   choosers, basic auth challenges.
2. Detect permission prompts via a `document_start` JS API shim, since
   CDP has no native event for them.
3. Surface every detected dialog as synthetic capture artifacts
   (`*.md`, `*.html`, `*-console.txt`) that the agent reads exactly like
   a page response.
4. Provide a synthetic selector grammar (`dialog::accept`,
   `dialog::dismiss`, `dialog::prompt`, `dialog::device[id="…"]`,
   `dialog::username`, `dialog::password`) that the existing
   `click` / `type` actions route to the correct CDP commands.
5. Block page-target actions while a dialog is open, with a clear
   refusal that includes the synthetic dialog content and instructions
   for handling it.
6. Add zero new top-level action enum entries on either the MCP tool
   or the CLI.

## Non-Goals

- Detecting permission prompts via CDP events. None exist; we are
  shimming the JS API instead. Verified against the live DevTools
  Protocol documentation 2026-05-13.
- Capturing a pixel-accurate screenshot of native browser dialog UI.
  CDP cannot do it; OS-level capture is out of scope. Dialog captures
  omit the `.png` file deliberately.
- Anti-detection countermeasures for the permission shim. A determined
  site can `toString` the wrapped function and notice it is not native
  code. Out of scope for v1.

## Architecture

One new module, three existing files modified, zero changes to
individual action handlers.

### New: `skills/browsing/lib/dialogs.js`

Owns all dialog state and routing:

- **Per-tab state map**, keyed by tab `wsUrl` to match the existing
  `state.connectionPool` map in `cdp-connection.js`. A tab has at most
  one dialog open at a time (Chrome serializes them).
- **CDP event subscriptions**, attached to the existing per-connection
  `conn.eventHandler` hook in `cdp-connection.js` — the same seam
  `console-logging.js` already uses.
- **`withDialogAwareness(actionName, wsUrl, fn)`** — middleware wrapping
  every `*WithCapture` body in `capture.js`.
- **`tryHandleDialogSelector(selector, op, payload)`** — selector
  router called from `element-selector.js`. Returns `{ handled: true,
  result }` or `{ handled: false }` for fall-through.
- **`renderSyntheticArtifacts(state)`** — produces `{ markdown, html,
  consoleSnapshot }` for the synthetic capture (no PNG).
- **`attachToConnection(conn, wsUrl)`** — called once per new pooled
  connection. Subscribes to the events listed below.
- **`getOpen(wsUrl)`** / **`clear(wsUrl)`** — used by capture code to
  branch on dialog state.

### Modified: `skills/browsing/lib/capture.js`

- `capturePageArtifacts` checks `dialogs.getOpen(wsUrl)` before doing
  real CDP work. If a dialog is open, return synthetic artifacts.
  Otherwise unchanged.
- Each `*WithCapture` wrapper wraps its action body in
  `withDialogAwareness`.

### Modified: `skills/browsing/lib/element-selector.js`

- At the top of the resolver: if the selector starts with `dialog::`,
  delegate to `dialogs.tryHandleDialogSelector` and skip normal DOM
  resolution.

### Modified: `skills/browsing/lib/cdp-connection.js`

- When `getPooledConnection` creates a new `conn`, call
  `dialogs.attachToConnection(conn, wsUrl)` so subscriptions go up
  immediately.

### New: `skills/browsing/lib/page-scripts/permission-shim.js`

Self-contained script registered via
`Page.addScriptToEvaluateOnNewDocument`. Wraps permission-gated JS
APIs. Talks back to the MCP process via `Runtime.addBinding`.

### No changes

- `mcp/src/index.ts` — action enum unchanged.
- `skills/browsing/chrome-ws` — CLI dispatcher unchanged.
- Individual action handlers (`navigation.js`, `extraction.js`,
  `mouse.js`, etc.) — they remain ignorant of dialog state. All
  control flow happens in the wrappers, the selector resolver, and
  the capture function.

## Dialog State Model

```js
{
  kind: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
      | 'device-chooser' | 'permission' | 'basic-auth',
  openedAt: <ms>,
  payload: <kind-specific, below>,
  staged: { promptText?, username?, password?, deviceId? }
}
```

### Kind-specific payloads

| Kind | Payload | Source |
|---|---|---|
| `alert` / `confirm` / `prompt` / `beforeunload` | `{ message, defaultPrompt, url, hasBrowserHandler }` | `Page.javascriptDialogOpening` |
| `device-chooser` | `{ requestId, deviceKind: 'usb'\|'bluetooth'\|'serial'\|'hid', devices: [{ id, name }] }` | `DeviceAccess.deviceRequestPrompted` |
| `permission` | `{ name, origin, jsApi }` | shim binding message |
| `basic-auth` | `{ requestId, origin, scheme, realm }` | `Fetch.requestPaused` with `authChallenge` |

### Lifecycle

- **Set** on opening event (or shim binding).
- **Cleared** on `Page.javascriptDialogClosed`, ack of `selectPrompt` /
  `cancelPrompt`, ack of `continueWithAuth`, shim resolution event, or
  defensively on `Page.frameNavigated` / tab close. Chrome would clear
  the underlying state automatically; we clear ours to avoid stale
  entries.
- **Second-open guard.** If a second open event fires while the state
  slot is set, the original is preserved and a warning is logged. This
  case should not happen in practice; surfacing it as a logged anomaly
  is preferable to silently replacing state.

## CDP Subscriptions

Attached once per new pooled connection in
`dialogs.attachToConnection`:

```
Page.enable                                       // idempotent; navigation.js
                                                  // also calls this on first
                                                  // navigate
DeviceAccess.enable
Fetch.enable {
  handleAuthRequests: true,
  patterns: [{ urlPattern: '*' }]
}
```

### Fetch always-on trade-off

`Fetch.enable` with `urlPattern: '*'` pauses every network request until
we either `Fetch.continueRequest` (no auth challenge — the common case)
or `Fetch.continueWithAuth` (auth challenge — surface as dialog). Cost:
modest per-request overhead and disabled HTTP cache for paused
requests, per CDP docs.

Pass-through is wired by responding to every `Fetch.requestPaused`
event without `authChallenge` with an immediate `Fetch.continueRequest`.

An alternative is to enable Fetch lazily only after we see a 401
response via `Network.responseReceived`, then disable again. Simpler
state model wins for v1; revisit if profiling shows the overhead is
noticeable.

## Synthetic Capture Artifacts

When `capturePageArtifacts` detects a pending dialog, it writes
`NNN-<action>.md`, `.html`, `-console.txt` with synthetic content. It
deliberately does not write `.png`.

### Markdown shape

For `confirm`:

```
# Dialog: confirm
Tab: 0  |  Origin: https://example.com
Real page (behind dialog): "Checkout — Acme Store"

> Are you sure you want to leave? Your cart will be cleared.

Buttons:
  - dialog::accept   (OK)
  - dialog::dismiss  (Cancel)

To interact:
  click selector="dialog::accept"
  click selector="dialog::dismiss"
```

For `prompt`:

```
# Dialog: prompt
> Enter your nickname:
Default: "guest"

Input: dialog::prompt   (type text here, then click dialog::accept)
Buttons:
  - dialog::accept
  - dialog::dismiss
```

For `device-chooser`:

```
# Dialog: device-chooser (usb)
Origin requested a USB device.

Devices:
  - dialog::device[id="abc123"]   "Logitech USB Receiver"
  - dialog::device[id="def456"]   "External SSD"

Buttons:
  - dialog::dismiss   (Cancel)
```

For `permission`:

```
# Dialog: permission
Origin https://example.com requested: camera
JS API: navigator.mediaDevices.getUserMedia

Buttons:
  - dialog::accept   (grant for this origin)
  - dialog::dismiss  (deny for this origin)
```

For `basic-auth`:

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

### HTML shape

A minimal valid HTML document mirroring the markdown structure, with
elements bearing `id="dialog-accept"`, `id="dialog-dismiss"`,
`data-device-id="…"` etc. Lets DOM-aware tooling treat the synthetic
artifact as a page. Real page DOM is not included.

### Console snapshot

The last N console messages from the real tab, captured up to the
moment the dialog opened. Buffered in the existing
`console-logging.js` state.

### Response text

The action returns a response shaped like normal capture output, with
the synthetic dialog summary inline so the agent does not have to open
the file:

```
Dialog open on tab 0: confirm
  Message: "Are you sure you want to leave?"
  Handle with: click dialog::accept | click dialog::dismiss
Real page: data:text/html,... (not interactive until dialog handled)
Session dir: /Users/.../session-XXX
Files: 003-click.html, 003-click.md, 003-click-console.txt
  (no screenshot — dialog overlay is browser-native UI)
```

The "real page" line carries the URL only — no DOM summary, since the
agent should not be reasoning about elements they cannot touch.

## Action Middleware

`withDialogAwareness(actionName, wsUrl, fn)` is wrapped around every
`*WithCapture` body in `capture.js`. Three behaviors:

### Page-target action with dialog already open → refuse

The action body is not invoked. Returns synthetic artifacts plus a
clear error:

```
error: Page is behind a dialog. Handle dialog::accept or dialog::dismiss first.
```

The page-target action set is:

```
navigate, click, type, extract, screenshot, eval, select, attr,
await_element, await_text, hover, drag_drop, mouse_move, scroll,
double_click, right_click, file_upload, keyboard_press,
set_viewport, clear_viewport, get_viewport
```

**Exception**: if the action is `click` or `type` and the selector
starts with `dialog::`, the action body runs normally. The selector
router takes over. Other selector-based actions (`attr`, `await_element`,
`hover`, `double_click`, `right_click`, `drag_drop`) against `dialog::*`
are still refused — the synthetic dialog supports only `click` and
`type` operations, intentionally. Refusal message lists the supported
operations.

### Browser-target action with dialog open → pass through

```
list_tabs, new_tab, close_tab, show_browser, hide_browser, browser_mode,
set_profile, get_profile, help, clear_cookies
```

Middleware is a no-op. These hit browser-level CDP and are unaffected
by a wedged page target.

### Page-target action with no dialog → run, watch for one opening

Subscribe-and-race pattern. Before invoking the action body, install a
one-shot dialog-opened listener for this tab. Run the action body. If
the listener fires while the body is in flight, abort the post-capture
phase (`Runtime.evaluate` for DOM summary would hang) and substitute
synthetic capture. The action's CDP call itself may have already
succeeded (`Input.dispatchMouseEvent` returns before the resulting
`onclick`-triggered `alert()` resolves). Response text indicates the
sequence: "Action completed; dialog opened in response."

### Action classification snapshot test

A Tier A test asserts the page-target and browser-target arrays match
the spec exactly. Adding a new action requires explicit categorization
or the test fails.

## Selector Router

`tryHandleDialogSelector(selector, op, payload)` is called from
`element-selector.js` before normal DOM resolution.

| Selector | Op | CDP call |
|---|---|---|
| `dialog::accept` | `click` | **JS dialog**: `Page.handleJavaScriptDialog({ accept: true, promptText: state.staged.promptText })`. **Device**: `DeviceAccess.selectPrompt({ id: requestId, deviceId: state.staged.deviceId })`. **Permission**: shim binding response `{ resolution: 'grant' }`. **Basic auth**: `Fetch.continueWithAuth({ requestId, authChallengeResponse: { response: 'ProvideCredentials', username, password } })`. |
| `dialog::dismiss` | `click` | **JS dialog**: `Page.handleJavaScriptDialog({ accept: false })`. **Device**: `DeviceAccess.cancelPrompt({ id })`. **Permission**: shim binding response `{ resolution: 'deny' }`. **Basic auth**: `Fetch.continueWithAuth({ ..., response: 'CancelAuth' })`. |
| `dialog::prompt` | `type` | Stash payload in `state.staged.promptText`. No CDP call until accept. |
| `dialog::device[id="..."]` | `click` | Stash `deviceId` then immediately invoke the `dialog::accept` path. Matches how the native chooser commits a choice. |
| `dialog::username` / `dialog::password` | `type` | Stash in `state.staged.username` / `state.staged.password`. No CDP call until accept. |
| Anything else under `dialog::` | * | Return `{ handled: true, error: 'Unknown dialog selector. Valid: …' }`. |
| Any `dialog::*` with no dialog open | * | Return `{ handled: true, error: 'No dialog open on this tab.' }`. |
| Non-`dialog::` selector | * | Return `{ handled: false }`. Falls through to normal resolution. |

After a successful router call, `capturePageArtifacts` runs as usual.
If the dialog is now closed (handle succeeded), real-page capture
runs. If still open (e.g., wrong `deviceId` — Chrome keeps the prompt
showing), synthetic capture runs again with updated state.

### Selector grammar

The `::` separator is deliberately a CSS pseudo-element separator,
which makes `dialog::*` clearly outside the namespace any real page
element could occupy.

## Permission Shim

### Delivery

Registered once per tab via
`Page.addScriptToEvaluateOnNewDocument`, called in
`dialogs.attachToConnection`. Runs at `document_start` on every frame
of every navigation; CDP guarantees this ordering, so the shim is
installed before author scripts on each document.

### Wrapped APIs (v1)

| JS API | Permission name reported |
|---|---|
| `navigator.mediaDevices.getUserMedia(c)` | `camera` if `c.video`, `microphone` if `c.audio` |
| `Notification.requestPermission()` | `notifications` |
| `navigator.geolocation.getCurrentPosition` / `watchPosition` | `geolocation` |
| `navigator.clipboard.read()` / `readText()` | `clipboard-read` |
| `navigator.clipboard.write()` / `writeText()` | `clipboard-write` |
| `navigator.permissions.query({ name })` | not a prompt — passes through to real API |

### Mechanism

Each wrapped API returns a `Promise` that:

1. Calls `window.__dialogShim('permission-request', { name, origin })`,
   a binding set up via `Runtime.addBinding`. The call lands as a
   `Runtime.bindingCalled` event on our connection.
2. Awaits a paired resolver, which our side defines via
   `Runtime.evaluate` once the agent clicks `dialog::accept` or
   `dialog::dismiss`.
3. On grant: shim calls the real underlying API and returns / rejects
   normally.
4. On deny: shim rejects with `NotAllowedError` (matches Chrome's
   native deny semantics, so author code's error handling works).

### Origin granularity

The shim does not remember decisions across calls. Every prompt
surfaces every time. If this proves noisy, a "remember for this
origin" lever can be added later. v1 stays simple.

### Document-start ordering

CDP guarantees `addScriptToEvaluateOnNewDocument` runs before any
author script on each new document, so the shim always installs before
pages can capture references to the native APIs. A Tier C smoke test
covers the normal load path to confirm the ordering holds.

## Basic Auth

`Fetch.enable` with `handleAuthRequests: true` is attached on every
pooled connection.

Flow:

1. `Fetch.requestPaused` fires for every request.
   - **No `authChallenge`**: immediately `Fetch.continueRequest({ requestId })`. Pass-through.
   - **With `authChallenge`**: surface as basic-auth dialog. Stash `requestId` in state.
2. Agent sees synthetic dialog with `dialog::username` /
   `dialog::password` inputs.
3. Agent types into both, clicks `dialog::accept`.
4. `Fetch.continueWithAuth({ requestId, authChallengeResponse: { response: 'ProvideCredentials', username, password } })`.
5. State cleared. Subsequent requests to the same origin pass through
   normally — Chrome caches the credential header.
6. `dialog::dismiss` → `continueWithAuth({ ..., response: 'CancelAuth' })`
   → request fails with 401, page handles normally.

## Testing Approach

Full red/green TDD. Each behavior below ships as: failing test first,
smallest implementation that turns it green, refactor. The
`superpowers:test-driven-development` skill is invoked at the start of
implementation and enforces the loop.

The repo uses three test tiers (matching existing convention):

### Tier A — pure units, CDP spied

`test/lib/dialogs.test.mjs`, against `makeCdpSpy()` from `_helpers.mjs`.

**State machine**
- `attachToConnection` calls `Page.enable`, `DeviceAccess.enable`, `Fetch.enable` once on attach.
- Each opening event populates state with the correct `kind` and payload shape.
- Closed / cancel / continue events clear state.
- Second opening event while state slot set: original preserved, warning logged.
- Frame navigation / tab close: state cleared defensively.

**Synthetic capture renderer**
- One test per `kind`. Golden-file fixtures in `test/lib/fixtures/dialog-*.md`.
- Edge cases: `device-chooser` with 0 / 1 / many devices; `basic-auth` with / without realm; `prompt` with / without `defaultPrompt`.
- Response-text shape tested separately from the file artifacts.

**Selector router**
- Every entry in the routing table has a corresponding test.
- `dialog::garbage` → error response listing valid selectors.
- `dialog::*` with no dialog open → error response.
- Non-`dialog::` selector → returns `{ handled: false }`.

**Middleware**
- Page-target + dialog open → action body not invoked, synthetic + error returned.
- Page-target + dialog open + `dialog::*` selector → action body runs normally.
- Browser-target + dialog open → action body runs normally.
- Page-target + no dialog → action body runs normally.
- Action that opens a dialog mid-flight: body completes, post-capture replaced with synthetic, response indicates the sequence.

**Action classification**
- Snapshot test asserts page-target / browser-target arrays match spec.

### Tier B — integration with mocked Chrome

`test/lib/dialogs.integration.test.mjs`, using the existing in-process
CDP mock server pattern.

- Full loop for each JS dialog kind (open → refuse stale action → handle → real capture resumes).
- Device chooser: open → browser-target actions still work → select device → state clears.
- Basic auth: 401 → dialog → credentials → `continueWithAuth` → request resumes.
- Permission shim: `getUserMedia` call → binding fires → state set → dismiss → promise rejects with `NotAllowedError`.
- Fetch pass-through: every `requestPaused` without `authChallenge` gets a `continueRequest`.

### Tier C — real Chrome smoke

`test/lib/dialogs.smoke.test.mjs`, gated like existing Tier C.

- Real `alert()` on page load → MCP returns synthetic → `dialog::accept` actually dismisses → subsequent `extract` succeeds.
- Real `confirm()` triggered by button click — accept and dismiss paths.
- `navigator.permissions.query()` for `notifications` — confirms shim does not break non-prompt queries.
- `Notification.requestPermission()` — shim fires, dialog surfaces, accept resolves to `'granted'`.
- WebUSB and basic auth: documented as manual release smoke checklist (need devices / specific server config).

### Coverage rule

A behavior is not implemented until at least one Tier A test plus one
Tier B or Tier C test covers it. Pure rendering / state-machine units
need only Tier A.

## Open Questions

None at design time. Items deliberately deferred:

- Permission grant memory across calls (v2).
- Lazy Fetch enable based on `Network.responseReceived` 401 (revisit
  if profiling shows overhead).
- Anti-detection countermeasures for the shim (out of scope).
- File picker dialog unification with the existing `file_upload`
  action (the `Page.fileChooserOpened` event exists but is gated on
  `Page.setInterceptFileChooserDialog` — out of scope until someone
  needs it).
