# One browser-level WebSocket multiplexing N flatten-mode sessions is the modern CDP transport

CDP exposes two WebSocket entry points per Chrome process: `/devtools/browser/<id>` (root/browser-level) and `/devtools/page/<targetId>` (one per page target). Historically, automation libraries opened a fresh per-page WebSocket for each tab they drove. The contemporary practice — Puppeteer's `Connection`, Playwright's CDP client, chrome-devtools-mcp via Puppeteer, and modern hand-rolled clients — opens *only* the browser-level WS, then multiplexes every per-page conversation over it as flatten-mode sessions.

The architecture has three moving pieces: (1) a single WebSocket to the browser endpoint; (2) a session map keyed by `sessionId`, populated when `Target.attachToTarget` returns; (3) a dispatcher that reads each incoming frame and routes by the `sessionId` field — messages without one go to root, with one go to the matching session's pending-request map or event listeners. Page sessions never own a socket; they own an id-counter, a pending-requests map, an event-listener set, and the right to push messages onto the shared WS with their sessionId in the envelope.

The reason to prefer this over per-page sockets is failure-mode reduction. A per-page WebSocket can drop independently of Chrome (renderer crash, navigation, OOPIF process churn), and library code then has to either reconnect-and-resubscribe or surface a transport error. A single browser-WS dies only when Chrome itself dies, at which point every session is already gone. The downside is that you must implement sessionId-aware dispatch correctly; the upside is one transport-lifecycle bug instead of N.

## For superpowers-chrome
The library has already adopted this shape: `lib/browser-session.js` owns the one WS, `lib/cdp-router.js` dispatches by sessionId, `lib/page-session.js` is the per-session handle that ships commands via `sendRaw`. An advanced consumer extending the library should not introduce per-page sockets; new capabilities (OOPIF inspection, service-worker debugging, popups) should reuse the bridge and acquire additional page sessions from it.

See also: [flatten-mode-and-sessionid-envelope](flatten-mode-and-sessionid-envelope.md), [per-session-message-id-counters](per-session-message-id-counters.md), [target-attached-without-detach-leaks](target-attached-without-detach-leaks.md), [puppeteer-as-cdp-reference-implementation](puppeteer-as-cdp-reference-implementation.md)

Sources:
- Lushnikov, "Getting Started With CDP", `sessions.js` example: https://github.com/aslushnikov/getting-started-with-cdp
- Puppeteer `Connection.ts` (single WS, sessionId-based dispatch): https://github.com/puppeteer/puppeteer/blob/main/packages/puppeteer-core/src/cdp/Connection.ts
- `superpowers-chrome/skills/browsing/lib/browser-session.js`, `cdp-router.js`, `page-session.js`
