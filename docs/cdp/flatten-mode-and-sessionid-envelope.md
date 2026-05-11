# Flatten mode makes sessionId a message-envelope field, not a connection property

In CDP's legacy ("non-flat") session protocol, attaching to a child target produced a *nested* session: you sent `Target.sendMessageToTarget` containing a serialized inner message, and Chrome replied with `Target.receivedMessageFromTarget` containing a serialized inner reply. Each layer of attachment added a wrapper. Flatten mode — turned on by passing `flatten: true` to `Target.attachToTarget` (and `Target.setAutoAttach`) — collapses that. The same WebSocket carries top-level messages tagged with a `sessionId` field alongside the usual `id` / `method` / `params`. The official docs say: *"We plan to make this the default, deprecate non-flattened mode, and eventually retire it."* Puppeteer, Playwright, and every modern CDP client default to `flatten: true`.

The practical shape: one outbound message looks like `{"id":7,"sessionId":"<sid>","method":"Page.navigate","params":{...}}`. A reply or event with `sessionId` set belongs to that page session; one without `sessionId` is a root (browser-level) message. The router on your side keys on `sessionId` to dispatch.

The reason this matters more than it sounds: flatten mode is what makes a *single* browser-level WebSocket viable as the transport for an arbitrary number of pages, workers, and out-of-process iframes. Without it, every page attachment doubled the wire envelope and demanded a custom unwrap on every message. With it, sessionId becomes a routing label on otherwise normal CDP traffic.

## For superpowers-chrome
The library opens exactly one CDP WebSocket per Chrome process (against `/devtools/browser/<id>`) and obtains a `sessionId` for each page via `Target.attachToTarget({targetId, flatten: true})`. Page action commands ride that envelope. An advanced consumer wanting to attach to additional targets (OOPIFs, service workers, popup windows) should attach with `flatten: true` for the same reason — there is no good argument to opt into the legacy nested protocol in 2026.

See also: [one-ws-many-sessions-architecture](one-ws-many-sessions-architecture.md), [per-session-message-id-counters](per-session-message-id-counters.md), [target-autoattach-vs-discovertargets](target-autoattach-vs-discovertargets.md), [puppeteer-as-cdp-reference-implementation](puppeteer-as-cdp-reference-implementation.md)

Sources:
- Chrome DevTools Protocol — Target domain: https://chromedevtools.github.io/devtools-protocol/tot/Target/
- Andrey Lushnikov, "Getting Started With Chrome DevTools Protocol": https://github.com/aslushnikov/getting-started-with-cdp
- Puppeteer `Connection.ts` (uses `flatten: true`): https://github.com/puppeteer/puppeteer/blob/main/packages/puppeteer-core/src/cdp/Connection.ts
