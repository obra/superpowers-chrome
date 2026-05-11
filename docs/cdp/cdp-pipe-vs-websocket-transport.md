# --remote-debugging-pipe carries CDP over inherited file descriptors; --remote-debugging-port exposes it on the network

CDP is a JSON-RPC protocol; how the bytes move is a transport detail with security and operational consequences. Chrome supports two transports for it.

**`--remote-debugging-port=N`** is the familiar one. Chrome binds a TCP socket on localhost:N (or a configured interface), exposes the HTTP discovery endpoints (`/json/version`, `/json/list`), and accepts WebSocket upgrades for `/devtools/browser/<id>` and `/devtools/page/<targetId>`. Anyone with network access to that port — including, historically, malicious local processes — can drive the browser. This is the transport every "remote debugging in Chrome" article and library defaults to.

**`--remote-debugging-pipe`** does the same JSON-RPC over inherited file descriptors: Chrome reads CDP messages from FD 3, writes responses and events to FD 4. There is no network socket at all. Only the parent process that launched Chrome (with those FDs set up via `spawn`/`posix_spawn` options) can talk to it. The benefits: no port to leak or collide, no localhost-attack surface, works in sandboxed environments (gVisor, Firecracker) that block runtime TCP bind, lower per-message overhead (no TCP/WS framing).

A 2026-relevant change: from Chrome 136, both `--remote-debugging-port` and `--remote-debugging-pipe` are *refused* if you're targeting the default Chrome user-data-dir. You must pass `--user-data-dir=/somewhere/else`. This is a response to cookie-theft malware that was reading from the default profile via the debugging interface; legitimate automation always passed its own profile anyway, so the user impact should be small but the diagnostic "Chrome silently exits when I add `--remote-debugging-port=9222`" gets a new explanation.

For a CDP library: pipe transport is structurally safer, requires a different I/O loop (line-delimited JSON over FDs instead of WebSocket framing), and is what Puppeteer uses by default when it spawns Chrome itself. Most libraries that connect to a separately-launched Chrome are stuck on the port transport because pipe requires inheriting FDs from the launch.

## For superpowers-chrome
The library uses the port transport (WebSocket) and always launches Chrome with its own `--user-data-dir`, so the Chrome 136 change is already handled. Adding pipe-transport support would be a substantial change — the WebSocket plumbing in `lib/websocket-client.js` would need a pipe analogue, and the library would lose the ability to attach to an already-running Chrome (the typical workflow for some consumers). A useful intermediate: document the security-posture difference so consumers running in untrusted environments know to consider pipe-launched alternatives.

See also: [chrome-process-lifecycle-traps](chrome-process-lifecycle-traps.md), [headless-new-vs-shell](headless-new-vs-shell.md)

Sources:
- Chrome blog, "Changes to remote debugging switches to improve security" (Chrome 136 user-data-dir requirement): https://developer.chrome.com/blog/remote-debugging-port
- chromedp issue on pipe transport: https://github.com/chromedp/chromedp/issues/1607
- Puppeteer Launcher defaults (pipe transport for spawned Chrome): https://github.com/puppeteer/puppeteer/tree/main/packages/puppeteer-core/src/node
