# Flatten mode makes sessionId a message-envelope field, not a connection property

The CDP protocol originally handled child-target sessions by nesting: to send a
command to a page, you wrapped it inside `Target.sendMessageToTarget`, and Chrome
replied with `Target.receivedMessageFromTarget` wrapping the inner reply. Each
layer of attachment added a wrapper. This was annoying enough that the protocol
team introduced "flatten mode."

Passing `flatten: true` to `Target.attachToTarget` (or `Target.setAutoAttach`)
collapses the nesting. The same WebSocket carries top-level messages tagged with
a `sessionId` field alongside the usual root-session traffic. The protocol team's
stated direction: make this the default, deprecate non-flattened mode, and
eventually retire it. Every modern CDP client (Puppeteer, Playwright) defaults
to `flatten: true`.

## The wire shapes

Outbound command to a page session:

```json
{ "id": 7, "sessionId": "<sid>", "method": "Page.navigate", "params": { "url": "..." } }
```

Response from that command:

```json
{ "id": 7, "sessionId": "<sid>", "result": { "frameId": "..." } }
```

A root-session command (no sessionId) and its response:

```json
{ "id": 3, "method": "Target.attachToTarget", "params": { "targetId": "...", "flatten": true } }
{ "id": 3, "result": { "sessionId": "<sid>" } }
```

Events carry `sessionId` when they originate from a page session:

```json
{ "method": "Page.loadEventFired", "sessionId": "<sid>", "params": { "timestamp": 12345 } }
```

Events without `sessionId` are root-level (Target.targetCreated, etc.).

## Why it matters structurally

Flatten mode is what makes one browser-level WebSocket viable as the transport
for an arbitrary number of pages, workers, and out-of-process iframes. Without
it, each attached target demanded a nested envelope on every send and a custom
unwrap on every receive. With it, `sessionId` is just a routing label on otherwise
normal CDP traffic — the router keyed on that field dispatches to the right pending
request or event listener.

## For superpowers-chrome

The library opens exactly one CDP WebSocket per Chrome process (against
`/devtools/browser/<id>`, the browser-level endpoint) and obtains a `sessionId`
for each page via `Target.attachToTarget({targetId, flatten: true})`. All page
action commands ride that envelope through `browser.sendRaw(JSON.stringify({id,
method, params, sessionId}))` in `lib/page-session.js`. The `lib/cdp-router.js`
reads `sessionId` on each incoming message to dispatch to the right session or
root listener.

Any extension that attaches additional targets — OOPIFs, service workers, popup
windows — should attach with `flatten: true`. There is no good argument to opt
into the legacy nested protocol in 2026.

## Sources

- CDP Target domain reference: https://chromedevtools.github.io/devtools-protocol/tot/Target/
- Andrey Lushnikov, "Getting Started With Chrome DevTools Protocol":
  https://github.com/aslushnikov/getting-started-with-cdp
- Puppeteer `Connection.ts` (passes `flatten: true`):
  https://github.com/puppeteer/puppeteer/blob/main/packages/puppeteer-core/src/cdp/Connection.ts
