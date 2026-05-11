# Chrome 132 removed --headless=old; "new headless" is now the only thing in the Chrome binary, chrome-headless-shell is a separate download

Chrome had two headless implementations for years. The original ("old headless") was a separate code path — a lightweight wrapper around Chromium's `//content` module with substantially fewer dependencies (no X11/Wayland/D-Bus required), but with a different surface from real Chrome: missing extensions, missing print preview, divergent network stack behavior in subtle places. The "new headless" introduced in Chrome 112 is the same Chrome binary as the headful build, just running without UI surfaces. Same code path, same features, same behavior.

As of Chrome 132 (early 2025), the old binary is gone from the standard Chrome distribution. Passing `--headless=old` fails; `--headless` and `--headless=new` both run the unified mode. The old implementation lives on as a separately-downloadable binary called `chrome-headless-shell`, distributed via the Chrome for Testing infrastructure (one build per Chrome release, available from Chrome 120 onward).

The trade-off to pick from in 2026: use the regular Chrome binary in `--headless` mode when you need feature parity with what a user sees (real extensions, real print pipeline, real Web APIs); use `chrome-headless-shell` when you need the lightweight, lower-dependency, lower-RAM footprint and accept the reduced feature set. Most automation testing wants the unified mode now. Bots that scrape at scale, run inside minimal containers, or care about startup latency may still prefer the shell.

A CDP-relevant note: both modes speak the same CDP. The protocol commands are identical. Where behavior can differ is in features the shell doesn't ship (e.g., headless-shell can't run extensions, so extension-related Target types won't appear). For most automation libraries, the CDP code path is identical; the user-facing difference is the binary path and the Chrome version compatibility matrix.

## For superpowers-chrome
`chrome-process.js`'s binary search list (`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, `/usr/bin/google-chrome`, etc.) targets the unified Chrome binary, which is correct for 2026. The library passes `--headless=new` (or `--headless` for old-Chrome compatibility — verify in `buildChromeArgs`). An advanced consumer running in a container who wants the smaller surface should be able to point at a `chrome-headless-shell` binary; today this requires setting the binary path via env or args. The library doesn't currently surface that override.

See also: [cdp-pipe-vs-websocket-transport](cdp-pipe-vs-websocket-transport.md), [chrome-process-lifecycle-traps](chrome-process-lifecycle-traps.md)

Sources:
- Chrome blog, "Chrome Headless mode": https://developer.chrome.com/docs/chromium/headless
- Chrome blog, "Removing --headless=old from Chrome": https://developer.chrome.com/blog/removing-headless-old-from-chrome
- Chrome blog, "Download old Headless Chrome as chrome-headless-shell": https://developer.chrome.com/blog/chrome-headless-shell
