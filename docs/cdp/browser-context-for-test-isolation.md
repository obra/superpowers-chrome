# Target.createBrowserContext is the right unit of test isolation; per-test cookie scrubbing is the wrong one

A Chrome BrowserContext is like an incognito profile but scoped to a programmatic lifetime: created via `Target.createBrowserContext`, scoped to receive new pages via `Target.createTarget({browserContextId})`, and disposed atomically via `Target.disposeBrowserContext`. Disposing tears down cookies, localStorage, sessionStorage, IndexedDB, cache storage, service worker registrations, and any pages still open inside the context — in one call, with no race between deletions.

The contrast that justifies preferring it: a hand-rolled "reset state between tests" routine that calls `Network.clearBrowserCookies`, `Storage.clearDataForOrigin`, and friends is always incomplete. It misses storage types added after the routine was written (e.g. service worker registrations from a feature added later), it has ordering problems (clearing cookies after a redirect already fired), and it cannot atomically guarantee that no in-flight network call from the previous test mutates state for the next one. `disposeBrowserContext` makes that impossible by construction — the renderer process is torn down with its storage.

The cost is real: BrowserContexts are not free. Each one is roughly a fresh incognito session — new disk allocations, new HTTP connection pools, new service-worker registration scope. For high-volume parallel testing, the right pattern is "one context per worker, recycle every N tests" not "one context per test." For agent-driven flows where isolation is the *whole point* (a fresh session for each agent run), one context per run is correct and the cost is amortized.

## For superpowers-chrome
The library exposes `createBrowserContext({proxyServer?})` via the bridge, returning `{browserContextId, createPage, dispose}`. An advanced consumer building per-run isolation should create a context at session start, build all pages inside it, and call `dispose` at teardown. The library does not currently force this — pages created via `newTab()` go into Chrome's default context. A consumer that wants strict isolation needs to use the bridge's `createBrowserContext` API directly and skip the convenience `newTab`.

See also: [target-domain-target-types](target-domain-target-types.md), [chrome-process-lifecycle-traps](chrome-process-lifecycle-traps.md)

Sources:
- CDP Target domain (createBrowserContext/disposeBrowserContext): https://chromedevtools.github.io/devtools-protocol/tot/Target/
- `superpowers-chrome/skills/browsing/lib/browser-bridge.js` (createBrowserContext implementation)
- gauntlet commit cda4f03 (BrowserContext-based per-test isolation rationale)
