# CDP stays the debugging protocol for Chromium; WebDriver BiDi is the cross-browser standard for automation, with non-trivial overlap during the transition

CDP started as Chrome's internal debugging protocol and accidentally became the de-facto API for browser automation when Puppeteer exposed it. It is Chrome-specific by design — Firefox briefly implemented a subset and stopped; Safari has never. WebDriver BiDi is the W3C-track replacement: a bidirectional, event-driven protocol that aims to give automation tools CDP-level capabilities (network events, console capture, isolated worlds) over a standardized wire that all browsers implement.

Current state (2026): BiDi is implemented in Chromium, Firefox, and is shipping in WebKit. Puppeteer enables BiDi by default when launching Firefox but still uses CDP when launching Chrome — BiDi doesn't yet cover all of CDP's surface (notably some performance tracing, heap profiling, and protocol-only events). Playwright continues to use a CDP-flavored implementation against Chromium; Selenium is actively migrating to BiDi as its default. The Chrome team has stated they will keep CDP for *debugging* indefinitely; they recommend BiDi for *automation* going forward.

The practical implication for a CDP automation library in 2026: building purely on CDP is fine for Chrome-only workloads, especially anything that touches debugging primitives (heap snapshots, performance traces, isolated worlds, fine-grained network instrumentation) where BiDi doesn't have parity yet. If cross-browser support ever becomes a goal, expect a substantial rewrite — BiDi's protocol shape is similar but the message types, capability boundaries, and event taxonomies are different. There is no clean adapter layer; libraries that want both maintain two backends.

The deeper question for any agent-driving library is whether BiDi's *agent-friendly* features (built-in screenshot, accessibility tree access, navigation primitives) make it the right substrate even for Chrome-only work in a few years. The bet is open. Puppeteer hedges by maintaining both; chrome-devtools-mcp commits to Chrome+CDP via Puppeteer; Playwright commits to its own CDP layer with BiDi planned.

## For superpowers-chrome
The library is correctly positioned as a Chrome+CDP tool. Migrating to BiDi would be a rewrite, not a refactor — the WebSocket transport stays, but the message vocabulary changes. The right time to consider it is when (a) cross-browser support becomes a goal, or (b) BiDi reaches feature parity for the library's actual use cases (most of which are page-driving, navigation, and DOM interaction — all areas BiDi covers today). Tracking BiDi's spec without committing is the prudent stance.

See also: [flatten-mode-and-sessionid-envelope](flatten-mode-and-sessionid-envelope.md), [puppeteer-as-cdp-reference-implementation](puppeteer-as-cdp-reference-implementation.md)

Sources:
- Chrome blog, "WebDriver BiDi - The future of cross-browser automation": https://developer.chrome.com/blog/webdriver-bidi
- W3C WebDriver BiDi spec: https://w3c.github.io/webdriver-bidi/
- Puppeteer guide, "Experimental WebDriver BiDi support": https://pptr.dev/webdriver-bidi
- Selenium WebDriver BiDi overview (Medium): https://medium.com/womenintechnology/selenium-webdriver-bidi-kismet-child-of-webdriver-classic-and-chrome-devtools-protocol-7922f07cded5
