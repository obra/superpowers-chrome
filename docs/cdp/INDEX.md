# CDP Reference (for maintainers)

Internal reference for working on the CDP transport layer in superpowers-chrome.
Not user-facing documentation — this is the "why we did it this way" record for
the next person modifying `skills/browsing/lib/{browser-session,cdp-router,page-session,browser-bridge}.js`.

## Cards

- [flatten-mode.md](./flatten-mode.md) — flatten mode + the sessionId envelope. The core protocol shape the bridge depends on.
- [per-session-id-counters.md](./per-session-id-counters.md) — why each session has its own message-id counter; what silently breaks if they collide.
- [target-lifecycle.md](./target-lifecycle.md) — setDiscoverTargets vs setAutoAttach, attached/detached events, BrowserContext lifecycle.
- [autoattach-popup-timing.md](./autoattach-popup-timing.md) — waitForDebuggerOnStart + runIfWaitingForDebugger. The pattern that makes popup dialogs reliable.
- [navigation-listener-race.md](./navigation-listener-race.md) — the Page.loadEventFired listener-ordering race and how the library handles it.
- [headless-variants.md](./headless-variants.md) — `--headless=new` vs `headless-shell`, what each can and can't do.
