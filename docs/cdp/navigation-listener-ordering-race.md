# Register the load-event listener before issuing Page.navigate, or fast pages will fire it before you're listening

The naive shape for "navigate and wait for load" — `await send("Page.navigate", {...}); await waitForEvent("Page.loadEventFired")` — has a race. For fast-loading URLs (especially `data:` URLs, cached pages, or local files), `loadEventFired` can arrive between the resolution of `Page.navigate` and the start of your event subscription. You then wait forever for an event Chrome already sent.

The fix is to register the listener *synchronously, before* sending the navigation. The shape becomes: enable the Page domain (idempotent), set up the waitForEvent promise (which adds the listener immediately), *then* send `Page.navigate`, then await both. Chrome's event delivery is ordered relative to the message that triggered it, so as long as the listener is attached before the trigger message goes on the wire, the event won't be lost.

This pattern generalizes: any CDP flow of the form "do X, then wait for the event X causes" needs the listener attached first. Examples: `Target.attachToTarget` then wait for `Runtime.executionContextCreated`; `Page.captureScreenshot` with `fromSurface` then wait for the frame; `Network.emulateNetworkConditions` then wait for the next request to confirm timing. The race is invisible on slow operations and bites instantly on fast ones, which is why it survives most test suites until it doesn't.

A second, related trap: `Page.loadEventFired` is the `window.onload` equivalent, not "the page is ready." It fires when subresources have loaded, not when the SPA has hydrated, the React tree has mounted, or the user-visible content has settled. For SPAs you usually want either `Page.frameStoppedLoading`, `Page.domContentEventFired`, or an explicit `Runtime.evaluate` that polls for an app-specific readiness marker.

## For superpowers-chrome
The library's `lib/navigation.js` does this correctly: `const loadP = ps.waitForEvent('Page.loadEventFired', ...)` is set up before `await ps.send('Page.navigate', ...)`. The comment in the code even names the failure mode it prevents ("fast loading pages (data: URLs) can't fire loadEventFired before we're listening"). Any new "do-then-wait" helper a consumer adds should preserve this ordering; the library has a small set of helper events it observes (loadEventFired, executionContextCreated, frameNavigated) and getting any of them wrong reintroduces the class.

See also: [runtime-evaluate-three-modes](runtime-evaluate-three-modes.md), [page-loadeventfired-is-not-ready](page-loadeventfired-is-not-ready.md), [target-autoattach-vs-discovertargets](target-autoattach-vs-discovertargets.md)

Sources:
- CDP Page domain: https://chromedevtools.github.io/devtools-protocol/tot/Page/
- `superpowers-chrome/skills/browsing/lib/navigation.js` (the in-tree implementation of the pattern)
- gauntlet commit 183cd60 (navigate rejects on Page.navigate error, listener WS error/close, and timeout — closely related defensive coverage)
