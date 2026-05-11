# CDP targets are not just pages: workers, iframes, browser, and "tab" are all distinct target types with their own session shape

Chrome exposes the world of debuggable things through the Target domain. Every target has a `type` field. The values seen in practice: `page` (a top-level frame), `iframe` (a cross-origin or OOPIF subframe), `worker` (dedicated Web Worker), `service_worker`, `shared_worker`, `browser` (the root target your `/devtools/browser/` connection is implicitly attached to), `webview`, `other` (e.g. extension background pages), and `tab` (a relatively recent addition that groups pages with their prerender/back-forward-cache siblings).

This taxonomy matters because each type has different capabilities exposed via CDP. A `service_worker` target lets you debug a worker's script — but doesn't have a DOM, so `Page.*` commands fail. An `iframe` OOPIF lives in a different renderer process from its parent page, so you can't reach it from the parent's page session; you have to attach to it as its own target. The `tab` type sits *above* `page` and is what Puppeteer prefers for navigation control because it survives back-forward-cache restores that destroy the old page target.

The mistake to avoid: treating `/json/list`'s output as a list of pages and filtering to `type === 'page'` is fine for simple automation but loses real workloads. A page that spawns a popup, embeds an OOPIF, or registers a service worker has 3+ targets that are part of the user-visible behavior. If your library only models pages, you're blind to the other halves.

## For superpowers-chrome
Today the library focuses on `type === 'page'` targets (see the `getPageSession` resolver filter). An advanced consumer who needs to drive OAuth flows (popups), inspect service-worker state, or instrument cross-origin iframes will need to extend the bridge surface to expose attached page sessions for non-page targets. The bridge architecture already supports this — `attachPageSession(targetId)` takes any targetId, not just page ones — but the orchestrator's resolver currently won't return them via the index-based shape.

See also: [target-autoattach-vs-discovertargets](target-autoattach-vs-discovertargets.md), [browser-context-for-test-isolation](browser-context-for-test-isolation.md), [isolated-worlds-and-execution-contexts](isolated-worlds-and-execution-contexts.md)

Sources:
- CDP Target domain: https://chromedevtools.github.io/devtools-protocol/tot/Target/
- Puppeteer's `TargetType` enum and target manager: https://github.com/puppeteer/puppeteer/tree/main/packages/puppeteer-core/src/cdp
