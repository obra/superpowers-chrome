# Isolated worlds give you a script sandbox that shares the DOM but not the JS heap

A frame in a Chromium renderer has one "main world" execution context (the page's normal JavaScript environment) and zero or more isolated worlds. Isolated worlds share the same DOM tree — `document.querySelector` works the same — but have *separate* global objects, separate prototype chains, separate variable bindings. The page can't see your variables; you can't see the page's. Extensions use this to inject content scripts without colliding with site code; CDP automation uses it for the same reason.

You create one via `Page.createIsolatedWorld({frameId, worldName, grantUniveralAccess?})`, which returns an `executionContextId`. You then pass that id (or its `uniqueContextId` equivalent from `Runtime.executionContextCreated`) to `Runtime.evaluate({contextId, ...})` and your code runs in the sandbox.

The motivation for caring even when you're not writing an extension: the page can redefine globals. A site that does `window.fetch = sketchyFetch` or `Element.prototype.click = noop` breaks any automation script that uses those names in the main world. Running in an isolated world means you get the pristine prototypes, immune to site monkey-patching. Puppeteer's "utility world" pattern uses this — its internal helpers run in an isolated world so they're robust against hostile pages.

The events you need to track context lifecycle: `Runtime.executionContextCreated` (one per world per frame), `Runtime.executionContextDestroyed`, `Runtime.executionContextsCleared` (on navigation). If you cache a `contextId` across a navigation, you will eval into a dead context and Chrome will reject with "Cannot find context with specified id." Resubscribe on navigation or, better, look up the current contextId at call time.

## For superpowers-chrome
The library currently evals exclusively in the main world (no `contextId` passed). For driving cooperative pages this is fine and simpler. An advanced consumer needing to defend against hostile pages, build a stable injection layer that doesn't conflict with site libraries, or implement Puppeteer-style utility helpers should add isolated-world support: call `Page.createIsolatedWorld` once per frame on attach, cache the contextId keyed by frameId, refresh on `Runtime.executionContextsCleared`, pass it to `Runtime.evaluate`.

See also: [runtime-evaluate-three-modes](runtime-evaluate-three-modes.md), [target-domain-target-types](target-domain-target-types.md), [navigation-listener-ordering-race](navigation-listener-ordering-race.md)

Sources:
- CDP Page domain (createIsolatedWorld): https://chromedevtools.github.io/devtools-protocol/tot/Page/
- CDP Runtime domain (executionContext events): https://chromedevtools.github.io/devtools-protocol/tot/Runtime/
- Puppeteer utility world pattern (in `IsolatedWorld.ts`): https://github.com/puppeteer/puppeteer/tree/main/packages/puppeteer-core/src/cdp
