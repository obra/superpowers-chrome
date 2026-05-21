# Each CDP session has its own message-id counter; collapsing id space silently breaks correlation

When you multiplex multiple sessions on one WebSocket via flatten mode, you have to
decide whether `id` numbers are scoped per WebSocket connection or per session.
The protocol's rule (from the Lushnikov getting-started doc): clients must provide
unique `id` values within a session, but different sessions may reuse the same ids.
`{id: 1, sessionId: "A"}` and `{id: 1, sessionId: "B"}` are unrelated commands.

## What breaks if you share id space across sessions

The failure mode is invisible until it isn't. If two sessions both have an
in-flight request with the same `id` at the same time, and the router dispatches
on `id` alone, one response resolves the wrong promise and the other hangs until
it times out. Tests pass for months. Production breaks under concurrency.

There is also a subtler version at the root/page boundary. The browser-session
has its own pending-request map (for root commands like `Target.attachToTarget`
that carry no `sessionId`), and page sessions each have theirs. The router must
check both `id` and `sessionId` to decide which map to look in:

- `data.id !== undefined && data.sessionId === undefined` → root session
- `data.id !== undefined && data.sessionId` → the page session with that sessionId

Getting this wrong is easy if the dispatch logic is written in the wrong order or
uses the wrong primary key.

## For superpowers-chrome

`lib/page-session.js` handles this correctly. Inside `buildPageSessionFromAttached`,
a closure-local `let messageIdCounter = 1` starts at line 28 — one counter per
call, scoped to the handle, never shared. The browser-session in
`lib/browser-session.js` has its own counter for root-session commands.
`lib/cdp-router.js` reads `sessionId` before doing any id lookup.

Any extension that adds batching, replay, or a second transport channel must
preserve this invariant: the counter is local to the handle, not to the transport.
Moving `messageIdCounter` to module scope or to a shared singleton breaks the
guarantee even if session dispatch elsewhere is correct.

## Sources

- Lushnikov, "Getting Started With CDP":
  https://github.com/aslushnikov/getting-started-with-cdp
- `skills/browsing/lib/page-session.js` — per-session `messageIdCounter` at line 28
- `skills/browsing/lib/cdp-router.js` — sessionId-first dispatch
