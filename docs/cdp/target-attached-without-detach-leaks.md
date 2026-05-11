# Forgetting Target.detachFromTarget leaks sessionIds and event subscriptions in Chrome until process exit

Each `Target.attachToTarget` call returns a sessionId and registers state inside Chrome: domain-enabled flags, event subscriptions, the session object itself. `Target.detachFromTarget({sessionId})` releases that state. If you skip the detach call when you're done with a session — either through optimism ("Chrome will clean up when the page closes") or through error handling that drops the session reference without detaching — you leak. The leak is per-Chrome-process and persists until Chrome exits.

The leak is mostly invisible because individual session state is small. It becomes visible in three situations: (a) long-running browser sessions (an MCP server holding a single Chrome for hours, attaching to popups that come and go); (b) page churn (a flow that opens-and-closes many tabs, each attached); (c) auto-attached children where the parent session's `setAutoAttach` produced child sessions you never explicitly tracked. In all three, you accumulate sessions whose targets are gone but whose subscriptions still match events that, while never reaching any handler, still cost Chrome time to filter.

The right shape is to treat sessions like file descriptors: every attach is paired with a detach in a try/finally or equivalent. For sessions tied to targets that disappear independently (popup closes, OOPIF navigates away), subscribe to `Target.targetDestroyed` for the targetId and detach the session in the handler — Chrome will not error if you detach a session whose target is already gone.

There's also a subtler version: even with detach, *event listeners on your side of the wire* may retain references to closed-over state (page handles, captured DOM nodes, console message buffers keyed by sessionId), so your library's session-cleanup must clear its own data structures too, not just call detach. Memory leaks in CDP libraries are usually about client-side maps that grew, not about Chrome holding state.

## For superpowers-chrome
`lib/page-session.js#detach` calls `Target.detachFromTarget` and then `router.unregisterSession(sessionId)`, which clears the router's per-session state and rejects in-flight requests. `lib/cdp-router.js#unregisterSession` does the same. An advanced consumer attaching to arbitrary targets via `bridge.attachPageSession(targetId)` is responsible for calling `pageSession.detach()` when done. A linting-style sanity check during development: after a flow runs, `bridge.router` should have no sessions for targets that no longer exist.

See also: [target-domain-target-types](target-domain-target-types.md), [target-autoattach-vs-discovertargets](target-autoattach-vs-discovertargets.md), [one-ws-many-sessions-architecture](one-ws-many-sessions-architecture.md)

Sources:
- CDP Target domain (attachToTarget/detachFromTarget): https://chromedevtools.github.io/devtools-protocol/tot/Target/
- `superpowers-chrome/skills/browsing/lib/page-session.js` (detach implementation)
- `superpowers-chrome/skills/browsing/lib/cdp-router.js` (unregisterSession)
