# Page.loadEventFired is window.onload, not "the page is ready to interact with"

`Page.loadEventFired` is the CDP event corresponding to the browser's `window.onload`. It fires after the document and all of its synchronously declared subresources (images, stylesheets, scripts) have finished loading. It is *not* a signal that:

- the page is interactive (try `Page.domContentEventFired` for DOMContentLoaded, or `Page.lifecycleEvent` with name `InteractiveTime`);
- an SPA framework has hydrated;
- React/Vue/Svelte/etc has mounted the application;
- network activity has gone quiet (modern pages keep fetching long after onload);
- user-visible content has settled (LCP / Largest Contentful Paint, available via `Performance.metrics` or `PerformanceTimeline`).

For a server-rendered page with mostly-static content, `loadEventFired` is a reasonable "navigation done" signal. For an SPA, it usually fires while the page is still showing a loading spinner. Tests that wait for `loadEventFired` and then immediately interact with the SPA will flake.

The patterns to know:

- **App-specific marker**: poll `Runtime.evaluate` for a known DOM signal — a stable selector, a `window.__appReady` flag the app sets. Most reliable, requires cooperation from the page.
- **`Page.lifecycleEvent`**: a stream of named events (`firstPaint`, `firstContentfulPaint`, `firstMeaningfulPaint`, `largestContentfulPaint`, `networkAlmostIdle`, `networkIdle`, `load`, `DOMContentLoaded`, etc.). Subscribe via `Page.enable` + `Page.setLifecycleEventsEnabled(true)`. `networkIdle` (two seconds of no in-flight requests, IIRC) is the closest thing to "page has settled" without page cooperation.
- **`Network.loadingFinished` counter**: track in-flight requests, wait for the count to hit zero. Brittle (long-polling or websockets keep the count above zero forever).

Puppeteer's `page.goto({waitUntil: 'networkidle0'|'networkidle2'|'domcontentloaded'|'load'})` exposes this trade-off as named modes. Picking one badly is a major source of flake in test suites that started simple and grew.

## For superpowers-chrome
The library's `navigate()` waits on `Page.loadEventFired` and that's it. For most automation against well-behaved pages this is fine; for SPAs, consumers should follow `navigate()` with an explicit `waitForElement` or `waitForText` to land on a stable post-load marker. An advanced extension would be a `navigate({waitUntil})` option mirroring Puppeteer's, with `networkIdle` available via `Page.lifecycleEvent` — but only if the library is willing to take the complexity, since most flake bugs in this area come from libraries' opinionated defaults masking what's actually happening.

See also: [navigation-listener-ordering-race](navigation-listener-ordering-race.md), [runtime-evaluate-three-modes](runtime-evaluate-three-modes.md), [network-vs-fetch-domains](network-vs-fetch-domains.md)

Sources:
- CDP Page domain: https://chromedevtools.github.io/devtools-protocol/tot/Page/
- Puppeteer `page.goto` waitUntil options: https://pptr.dev/api/puppeteer.page.goto
- `superpowers-chrome/skills/browsing/lib/navigation.js` (current loadEventFired wait)
