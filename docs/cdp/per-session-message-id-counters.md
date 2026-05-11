# Each CDP session has its own message-id counter; collapsing id space silently breaks correlation

When you multiplex many sessions on one WebSocket via flatten mode, you have to decide whether `id` numbers are scoped per WS or per session. The protocol's rule, stated in the Lushnikov getting-started doc: *"clients must provide unique 'id' for commands inside the session, but different sessions might use the same ids."* Each session counts independently; `{id:1, sessionId:"A"}` and `{id:1, sessionId:"B"}` are two unrelated commands.

The failure mode if you collapse id space across sessions: a response arriving for one session's command can resolve another session's pending request, because the dispatcher (or worse, the lookup) keyed on `id` alone. The bug is invisible until two sessions happen to have an in-flight request with the same id at the same time — at which point one promise resolves with the wrong result and the other hangs forever. Tests pass; production breaks at concurrency.

There is also a subtler version of the same bug at the root/page boundary: the root browser session has its own pending-request map (for sessionless commands like `Target.attachToTarget`), and page sessions have theirs (for sessionId-tagged commands). The router needs to see *both* `id` and `sessionId` before deciding which map to look in — `data.id !== undefined && data.sessionId === undefined` for root, `id !== undefined && sessionId` for a page session.

## For superpowers-chrome
The library handles this correctly today: `lib/page-session.js` declares `let messageIdCounter = 1` per session, `lib/browser-session.js` has its own counter for root commands, and `lib/cdp-router.js` reads the `sessionId` field before doing any id lookup. An extension that adds a new transport feature (request batching, response replay) must preserve this invariant — the per-session counter is local-to-the-handle, not local-to-the-transport.

See also: [flatten-mode-and-sessionid-envelope](flatten-mode-and-sessionid-envelope.md), [one-ws-many-sessions-architecture](one-ws-many-sessions-architecture.md)

Sources:
- Lushnikov, "Getting Started With CDP": https://github.com/aslushnikov/getting-started-with-cdp
- `superpowers-chrome/skills/browsing/lib/page-session.js` (per-session `messageIdCounter`)
- `superpowers-chrome/skills/browsing/lib/cdp-router.js` (router's sessionId-aware dispatch)
