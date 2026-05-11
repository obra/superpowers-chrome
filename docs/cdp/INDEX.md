# CDP zettel for superpowers-chrome

Atomic notes on Chrome DevTools Protocol topics most relevant to a library that drives Chrome over CDP for automation and agent use. Each card makes one claim, in its own words, with sources and links to related cards.

Written 2026-05-11 by Yarrow (Bob). Form follows the `taking-smart-notes` skill; cards live here (per Matt's request) rather than in a `notes/zettel/` slipbox.

## Reading order for a newcomer

If you're new to CDP and want to learn it in order:

1. [flatten-mode-and-sessionid-envelope](flatten-mode-and-sessionid-envelope.md) — the protocol convention everything else builds on
2. [one-ws-many-sessions-architecture](one-ws-many-sessions-architecture.md) — the client architecture that uses it
3. [per-session-message-id-counters](per-session-message-id-counters.md) — the correctness invariant you must preserve
4. [target-domain-target-types](target-domain-target-types.md) — what's out there to attach to
5. [target-autoattach-vs-discovertargets](target-autoattach-vs-discovertargets.md) — how to capture children safely
6. [runtime-evaluate-three-modes](runtime-evaluate-three-modes.md) — the workhorse command and its trap modes
7. [navigation-listener-ordering-race](navigation-listener-ordering-race.md) — the event-ordering invariant
8. [page-loadeventfired-is-not-ready](page-loadeventfired-is-not-ready.md) — what "page loaded" really means

## Index — all cards

### Session protocol & architecture

- **[flatten-mode-and-sessionid-envelope](flatten-mode-and-sessionid-envelope.md)** — Flatten mode makes sessionId a message-envelope field, not a connection property; it's the modern default.
- **[one-ws-many-sessions-architecture](one-ws-many-sessions-architecture.md)** — One browser-level WebSocket multiplexing N flatten-mode sessions is the contemporary transport pattern.
- **[per-session-message-id-counters](per-session-message-id-counters.md)** — Each CDP session has its own id counter; collapsing id space silently breaks correlation.

### Targets & lifecycle

- **[target-domain-target-types](target-domain-target-types.md)** — CDP targets are not just pages: workers, iframes, browser, "tab" are all distinct with their own session shape.
- **[target-autoattach-vs-discovertargets](target-autoattach-vs-discovertargets.md)** — `setAutoAttach` captures children safely; `setDiscoverTargets` is observation only.
- **[browser-context-for-test-isolation](browser-context-for-test-isolation.md)** — `disposeBrowserContext` is atomic; per-test cookie-scrubbing is incomplete by construction.
- **[target-attached-without-detach-leaks](target-attached-without-detach-leaks.md)** — Forgetting `detachFromTarget` leaks sessionIds and subscriptions until process exit.

### Page interaction primitives

- **[runtime-evaluate-three-modes](runtime-evaluate-three-modes.md)** — `Runtime.evaluate`'s three orthogonal modes (returnByValue, awaitPromise, exceptionDetails) and when each matters.
- **[isolated-worlds-and-execution-contexts](isolated-worlds-and-execution-contexts.md)** — Isolated worlds share the DOM but not the JS heap; the defence against hostile-page monkey-patching.
- **[navigation-listener-ordering-race](navigation-listener-ordering-race.md)** — Register the load-event listener before issuing `Page.navigate`, or fast pages will fire it before you're listening.
- **[page-loadeventfired-is-not-ready](page-loadeventfired-is-not-ready.md)** — `Page.loadEventFired` is `window.onload`, not "page is ready to interact with."

### Network instrumentation

- **[network-vs-fetch-domains](network-vs-fetch-domains.md)** — Network observes; Fetch intercepts. `Network.requestIntercepted` is deprecated.

### Process, transport, and modes

- **[chrome-process-lifecycle-traps](chrome-process-lifecycle-traps.md)** — Four lifecycle traps any Chrome-spawning library spends complexity on.
- **[cdp-pipe-vs-websocket-transport](cdp-pipe-vs-websocket-transport.md)** — `--remote-debugging-pipe` is structurally safer than `--remote-debugging-port`; Chrome 136 added a `--user-data-dir` requirement.
- **[headless-new-vs-shell](headless-new-vs-shell.md)** — Chrome 132 removed `--headless=old`; `chrome-headless-shell` is now a separate download.

### Ecosystem context

- **[puppeteer-as-cdp-reference-implementation](puppeteer-as-cdp-reference-implementation.md)** — When the docs are ambiguous, Puppeteer is the canonical implementation to read.
- **[webdriver-bidi-vs-cdp-trajectory](webdriver-bidi-vs-cdp-trajectory.md)** — CDP stays Chrome-specific debugging; BiDi is the cross-browser standard, with non-trivial overlap during the transition.

## Suggested cluster reads

- **"I'm extending the browser-WS bridge"**: flatten-mode + one-ws-many-sessions + per-session-message-id-counters + target-attached-without-detach-leaks + puppeteer-as-cdp-reference-implementation.
- **"I'm adding request interception"**: network-vs-fetch + target-autoattach + navigation-listener-ordering-race.
- **"I'm hardening for hostile pages"**: isolated-worlds + runtime-evaluate-three-modes + browser-context-for-test-isolation.
- **"I'm shipping in a container or sandboxed env"**: headless-new-vs-shell + cdp-pipe-vs-websocket-transport + chrome-process-lifecycle-traps.
- **"I'm thinking about cross-browser someday"**: webdriver-bidi-vs-cdp-trajectory + puppeteer-as-cdp-reference-implementation.
