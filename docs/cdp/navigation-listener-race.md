# Register the load-event listener before issuing Page.navigate, or fast pages will lose the event

The naive shape for "navigate and wait for load":

```js
await ps.send('Page.navigate', { url });
const evt = await ps.waitForEvent('Page.loadEventFired');
```

This has a race. For fast-loading URLs — `data:` URIs, cached pages, local files —
`Page.loadEventFired` can arrive between the resolution of `Page.navigate` and
the moment `waitForEvent` registers its listener. The event is gone. You then wait
forever (or until timeout) for an event Chrome already sent.

## The fix: listener first, then send

Register the listener synchronously before putting the navigation command on the
wire:

```js
const loadP = ps.waitForEvent('Page.loadEventFired', { timeoutMs: 30000 });
await ps.send('Page.navigate', { url });
await loadP;
```

Chrome's event delivery is ordered relative to the CDP message that triggers it.
As long as the listener is attached before `Page.navigate` goes on the wire, the
event will not arrive before the listener exists.

## The pattern generalizes

Any CDP flow of the form "do X, then wait for the event X causes" needs the
listener attached first. Examples:

- `Target.attachToTarget` → wait for `Runtime.executionContextCreated`
- `Page.captureScreenshot` with `fromSurface` → wait for the frame event
- `Network.emulateNetworkConditions` → wait for the next request to confirm timing

The race is invisible on slow operations and bites immediately on fast ones, which
is why it survives most test suites until it meets a fast CI machine or a cached
response.

## Page.loadEventFired is not "ready"

A related but separate trap: `Page.loadEventFired` is the `window.onload`
equivalent. It fires when all synchronous subresources have loaded. It does not
mean the page is ready to interact with. For SPAs, React/Vue/Angular apps, or any
page that renders asynchronously, `loadEventFired` can precede the point where
DOM queries return meaningful results. Use `Page.domContentEventFired` for earlier
notification, `Page.frameStoppedLoading` for later, or an explicit
`Runtime.evaluate` polling for an app-specific readiness signal.

## For superpowers-chrome

`lib/navigation.js` does this correctly. The `waitForEvent` call is set up before
`ps.send('Page.navigate', ...)` is awaited. Any new "do-then-wait" helper that a
future maintainer adds should preserve this ordering. The library's current set of
event waits (loadEventFired, executionContextCreated, frameNavigated) all follow
the pattern; adding a new one in the wrong order reintroduces the class silently.

## Sources

- CDP Page domain: https://chromedevtools.github.io/devtools-protocol/tot/Page/
- `skills/browsing/lib/navigation.js` — the in-tree implementation
