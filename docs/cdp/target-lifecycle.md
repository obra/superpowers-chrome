# setDiscoverTargets is passive observation; setAutoAttach actively captures children

These two methods look similar in the protocol reference and are easy to conflate.
They are not interchangeable.

## setDiscoverTargets

`Target.setDiscoverTargets({discover: true})` says "tell me about all existing
and future targets; emit `Target.targetCreated`, `Target.targetInfoChanged`, and
`Target.targetDestroyed` events." That is a notification subscription. You learn
a target exists; you can then choose to call `Target.attachToTarget` for it.

Two timing problems with this as a capture mechanism:

1. The target may have already started executing scripts by the time `targetCreated`
   arrives and you respond with `attachToTarget`.
2. For short-lived targets (a redirect popup, a service worker that dies quickly),
   the target may be gone before `attachToTarget` completes.

## setAutoAttach

`Target.setAutoAttach({autoAttach: true, waitForDebuggerOnStart: true, flatten: true})`
says "for every new related target, attach automatically and pause its main script
until I send `Runtime.runIfWaitingForDebugger`." This is the only reliable way to
configure a popup, OOPIF, or service worker before it runs any user code.

With `waitForDebuggerOnStart: false`, you still race the renderer — you get a
session but the page may already be mid-execution. With `waitForDebuggerOnStart:
true`, the target waits indefinitely in a pre-start pause. You install whatever
you need (Network.enable, Fetch.enable, request interception patterns, dialog
shims), then release it via `Runtime.runIfWaitingForDebugger`.

When auto-attach fires, Chrome emits `Target.attachedToTarget` with the already-
allocated `sessionId` and a `waitingForDebugger` boolean. The session is ready
to use immediately — no `Target.attachToTarget` call needed. Attached targets
fire `Target.detachedFromTarget` when the target is destroyed or detached.

## Auto-attach is recursive

When `setAutoAttach` is issued from the browser-level session with `flatten: true`,
it also applies recursively to children of attached targets. OOPIFs get attached
via the page session that owns them. This is how Puppeteer handles out-of-process
iframes.

## BrowserContext lifecycle

`Target.createBrowserContext` creates an isolated profile: separate cookies,
storage, service workers, and cache. `Target.createTarget({url, browserContextId})`
opens a tab inside that context. `Target.disposeBrowserContext({browserContextId})`
tears down the entire context atomically — all tabs, all storage, all service
workers in one CDP call. This is the correct primitive for test isolation.

## For superpowers-chrome

`lib/browser-bridge.js` calls `Target.setDiscoverTargets` unconditionally to
populate the target map and keep it current. It calls `Target.setAutoAttach` only
when `autoAttach: true` is passed to `attachBrowserBridge`. The auto-attach path
handles `Target.attachedToTarget` events, guards against non-paused targets
(which must go through the normal `attachPageSession` path to avoid duplicate
session registrations in the router), and calls `Runtime.runIfWaitingForDebugger`
after the `onPageSession` hook completes.

`createBrowserContext` in `lib/browser-bridge.js` wraps the create/dispose cycle
and exposes a `createPage(url)` helper that opens a tab in the context.

## Sources

- CDP Target domain: https://chromedevtools.github.io/devtools-protocol/tot/Target/
- Puppeteer OOPIF auto-attach commit:
  https://github.com/puppeteer/puppeteer/commit/2cbfdeb0ca388a45cedfae865266230e1291bd29
