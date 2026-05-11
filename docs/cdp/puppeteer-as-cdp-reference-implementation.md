# Puppeteer's Connection/CDPSession code is the canonical reference for modern CDP client design

When a CDP protocol question is ambiguous in the docs — does this event fire before that one, should I enable Runtime before Page, do I need to handle this race — the most reliable answer is "what does Puppeteer do." Puppeteer is maintained by Chrome team members, ships changes in lockstep with Chrome releases, and has a much larger production deployment than any spec author or doc reader can match. Its handling of CDP is, in practice, the reference implementation.

Two specific files reward reading by any library author working at the same level:

- `packages/puppeteer-core/src/cdp/Connection.ts` — the WebSocket connection, sessionId-based dispatch, root vs. per-session callback registries, message-id management. This is the canonical implementation of the "one browser-WS, N flatten-mode sessions" architecture.
- `packages/puppeteer-core/src/cdp/CDPSession.ts` — the per-session handle. Shows exactly which methods are exposed (`send`, `on`, `off`, `connection`, `detach`), how session lifecycle interacts with target lifecycle, and where the abstraction boundary sits.

Beyond those two, the `TargetManager.ts`, `IsolatedWorld.ts`, `FrameManager.ts`, and `LifecycleWatcher.ts` files together show how Puppeteer's high-level surface (`page.goto`, `page.click`, `page.waitForNavigation`) decomposes into CDP commands and event-stream subscriptions. The decomposition is opinionated but it represents lessons absorbed from years of edge cases.

The two patterns from Puppeteer most worth borrowing in any new CDP library: (1) sessions are first-class objects with their own send/event surface, not just sessionId strings passed around; (2) every CDP call is wrapped in code that knows the failure modes of *that specific call* (e.g. `Page.navigate` can return a `frameId` but also fail with `errorText` you have to read from the result), not generic error handling that loses the protocol-specific signal.

## For superpowers-chrome
The library's `lib/browser-session.js` + `lib/page-session.js` shape closely mirrors Puppeteer's `Connection` + `CDPSession`, which is appropriate given they're solving the same problem. When adding new capabilities (auto-attach, isolated worlds, Fetch interception), checking Puppeteer's handling of the same surface is faster and more reliable than re-deriving it from the protocol docs.

See also: [flatten-mode-and-sessionid-envelope](flatten-mode-and-sessionid-envelope.md), [one-ws-many-sessions-architecture](one-ws-many-sessions-architecture.md), [webdriver-bidi-vs-cdp-trajectory](webdriver-bidi-vs-cdp-trajectory.md)

Sources:
- Puppeteer `Connection.ts`: https://github.com/puppeteer/puppeteer/blob/main/packages/puppeteer-core/src/cdp/Connection.ts
- Puppeteer `CDPSession.ts`: https://github.com/puppeteer/puppeteer/blob/main/packages/puppeteer-core/src/cdp/CdpSession.ts
- Puppeteer `cdp/` directory (full implementation): https://github.com/puppeteer/puppeteer/tree/main/packages/puppeteer-core/src/cdp
