# --headless=new vs chrome-headless-shell: two different things since Chrome 132

Chrome had two headless implementations for years. Knowing which is which matters
for debugging feature gaps and container builds.

## Old headless (gone from the main binary)

The original `--headless` / `--headless=old` was a separate code path inside the
Chromium source — a lightweight wrapper around `//content` with fewer platform
dependencies (no X11/Wayland/D-Bus required). Consequence: the old headless
surface differed from real Chrome in measurable ways: no extension support, a
divergent network stack in edge cases, missing print preview, and other feature
gaps. As of Chrome 112, a "new headless" mode was introduced. As of Chrome 132
(early 2025), `--headless=old` is gone from the standard Chrome distribution.

## New headless (the current default)

`--headless` and `--headless=new` now both activate the unified mode: the same
Chrome binary as the headful build, running without UI surfaces. Same code path.
Same features. Same network stack. Same extension support (though extensions
require specific flags to load). Full Page CDP domain, BrowserContext, everything.

For most automation work in 2026, `--headless` on the regular Chrome binary is
the right choice. You get full feature parity with what a real user sees.

## chrome-headless-shell (the old implementation, separately distributed)

The old implementation was not deleted — it lives on as `chrome-headless-shell`,
a separately downloadable binary available from the Chrome for Testing
infrastructure (one build per Chrome release, from Chrome 120 onward). It still
has the lighter dependency footprint: lower RAM, faster startup, no need for
certain system libraries. It still lacks extensions and has the same feature gaps.

When to prefer it: scraping at scale in minimal containers where startup latency
or RAM matters more than feature parity. When not to: anything that touches
extensions, print, WebRTC, or features that were missing from old headless.

## CDP is identical in both

Both modes speak the same CDP wire protocol. Protocol commands are the same. The
only differences are in features the shell doesn't ship — for example,
extension-related Target types won't appear in chrome-headless-shell because
there's no extension support. For the CDP transport layer, the code path is
identical regardless of which binary you're connecting to.

## For superpowers-chrome

`lib/chrome-process.js` looks for the standard Chrome binary (
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` on macOS,
`/usr/bin/google-chrome` on Linux, etc.) and passes `--headless=new`. That is
correct for 2026. A maintainer running in a minimal container who wants the shell
binary must supply the binary path via environment or arguments; the library does
not currently surface a binary-override option.

## Sources

- Chrome blog, "Chrome headless mode":
  https://developer.chrome.com/docs/chromium/headless
- Chrome blog, "Removing --headless=old from Chrome":
  https://developer.chrome.com/blog/removing-headless-old-from-chrome
- Chrome blog, "Download old headless Chrome as chrome-headless-shell":
  https://developer.chrome.com/blog/chrome-headless-shell
