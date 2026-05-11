# Spawning and reconnecting to Chrome from a library is mostly fighting four lifecycle traps

A CDP automation library that owns the Chrome process spends a surprising fraction of its complexity on lifecycle, not on protocol. Four traps recur:

**1. User-data-dir collisions.** Two Chrome processes pointed at the same `--user-data-dir` will fight over the profile lock and one will exit immediately. If your library reuses a profile across runs (to keep cookies/extensions), you must either serialize launches or use one profile per concurrent run. The fix-by-construction is per-session profile directories. The fix-by-coordination is a meta-file written into the profile dir that records the active PID and port, checked on launch.

**2. Port-binding race.** If you ask for a specific `--remote-debugging-port`, two parallel launches will collide. If you ask Chrome to pick (no port flag), Chrome writes the chosen port to `<userDataDir>/DevToolsActivePort` — but you have to poll that file because Chrome creates it asynchronously. The cleaner fix is to find a free port *before* spawn (bind, get the port, close, pass it) and accept the small race window where another process can steal it.

**3. Zombie processes.** Chrome forks itself extensively — one browser process, one renderer per site instance, GPU process, network service, utility processes. If you kill only the parent, children survive on some platforms (macOS especially) until the OS reaps them, often hanging onto the user-data-dir lock. Either kill the process group (`-pid` on Unix), use `Browser.close` via CDP first (graceful shutdown), or both.

**4. Reconnecting to a Chrome that died.** Across restarts of your library/MCP server, the Chrome you launched may still be alive (graceful) or may have crashed (you have a stale port number in your meta file). The typical pattern is: read the meta file, probe the port (HTTP GET to `/json/version`), if it responds reconnect, else clear the meta and launch fresh. Probing must be fast and tolerant; a slow probe blocks library startup, and a strict probe (e.g. requiring a specific version field) breaks across Chrome updates.

## For superpowers-chrome
`lib/chrome-process.js` and `lib/chrome-launcher-helpers.js` handle all four: per-profile meta.json with `{port, pid}`, `findAvailablePort` for dynamic allocation, `isPortAlive` probe with PID matching for reconnection, graceful shutdown via `/json/close` then SIGTERM, port-based PID fallback for `killChrome` when the library doesn't own the process. The shape is right; the parts most worth review periodically are the probe timeouts (currently 15s startup poll) and the killing strategy on Linux/Windows where process-group handling diverges.

See also: [cdp-pipe-vs-websocket-transport](cdp-pipe-vs-websocket-transport.md), [headless-new-vs-shell](headless-new-vs-shell.md), [browser-context-for-test-isolation](browser-context-for-test-isolation.md)

Sources:
- `superpowers-chrome/skills/browsing/lib/chrome-process.js` (the in-tree implementation)
- Chrome's `DevToolsActivePort` file behavior: https://chromium.googlesource.com/chromium/src/+/main/content/browser/devtools/
- Chrome blog on `--user-data-dir` requirement from Chrome 136: https://developer.chrome.com/blog/remote-debugging-port
