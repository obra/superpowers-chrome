# Target.setAutoAttach is for capturing child targets safely; setDiscoverTargets is for observation only

These two methods look similar in the protocol reference and are easy to conflate. They are not interchangeable.

`Target.setDiscoverTargets({discover: true})` says "tell me about all targets and emit `Target.targetCreated/Changed/Destroyed` events." That's a *notification* subscription. You learn that a target exists; you can then choose to call `Target.attachToTarget` for it. Two timing problems: (1) the target may have already started executing scripts by the time `targetCreated` reaches you and you respond with `attachToTarget`; (2) for short-lived targets (e.g. a redirect popup), it may already be gone.

`Target.setAutoAttach({autoAttach: true, waitForDebuggerOnStart: true, flatten: true})` says "for every new related target, attach automatically and (if `waitForDebuggerOnStart`) pause the target's main script until I send `Runtime.runIfWaitingForDebugger`." This is the only reliable way to configure a popup/OOPIF/service-worker *before* it runs any user code. Without `waitForDebuggerOnStart`, you race the renderer. With it, you can set up `Network.enable`, `Fetch.enable`, request interception patterns, etc., and only then release the target.

The "auto" in auto-attach is also recursive when paired with `flatten: true`: the parent session's `setAutoAttach` applies to *its* children, so iframes get attached via the page session that owns them, and you get a session tree rooted at the browser. Puppeteer relies on this for OOPIF support — see the 2022 commit that switched Puppeteer to CDP auto-attach for OOPIFs.

## For superpowers-chrome
The library currently uses `setDiscoverTargets` (in `lib/browser-bridge.js`) for top-level target visibility and does not enable auto-attach. That's adequate for the present scope (user-driven page-level navigation, no request interception). An advanced consumer doing request interception on OAuth popups or wanting to mutate service-worker requests *must* add `setAutoAttach` with `waitForDebuggerOnStart`, configure the child session, then `Runtime.runIfWaitingForDebugger`. Adding this without `waitForDebuggerOnStart` will pass tests and silently miss requests in production.

See also: [target-domain-target-types](target-domain-target-types.md), [network-vs-fetch-domains](network-vs-fetch-domains.md), [navigation-listener-ordering-race](navigation-listener-ordering-race.md)

Sources:
- CDP Target domain: https://chromedevtools.github.io/devtools-protocol/tot/Target/
- Puppeteer commit switching to CDP auto-attach for OOPIFs: https://github.com/puppeteer/puppeteer/commit/2cbfdeb0ca388a45cedfae865266230e1291bd29
- chrome-devtools-mcp OOPIF issue (still tracking this surface): https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/703
