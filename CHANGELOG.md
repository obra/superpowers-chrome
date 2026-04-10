# Changelog

All notable changes to the superpowers-chrome MCP project.

## [1.10.0] - 2026-04-10 - Custom Chrome launch flags via `CHROME_EXTRA_ARGS`

### Added
- **`CHROME_EXTRA_ARGS` env var**: whitespace-separated Chrome launch flags that are appended to the hardcoded flag list in `startChrome()`. Unblocks containerized/headless setups that need to inject flags like `--use-gl=angle --use-angle=swiftshader-webgl --enable-unsafe-swiftshader` for software WebGL (SwiftShader) when no GPU is present. Opt-in: unset = no behavior change (#32)
- **`buildChromeArgs()`** exported from `chrome-ws-lib` — pure function that assembles the Chrome launch flag list, enabling unit tests and external reuse

---

## [1.9.0] - 2026-04-09 - CDP Mouse Actions, Human-Like Typing, and File Upload

### Added
- **`hover`**: Move mouse over element via CDP `mouseMoved`. Triggers CSS `:hover`, `mouseenter`/`mouseover` events, tooltips, dropdown menus
- **`drag_drop`**: Native drag-and-drop via CDP mouse event sequence (`mousePressed` → interpolated `mouseMoved` steps → `mouseReleased`). Fixes the browser restriction where synthetic `DragEvent` objects have neutered `DataTransfer`. Supports selector-to-selector and selector-to-coordinate targets
- **`mouse_move`**: Raw coordinate mouse movement with optional smooth interpolation. Useful for pre-click mouse patterns (bot detection) and captcha puzzles
- **`scroll`**: Mouse wheel scrolling via CDP `mouseWheel`. Accepts direction strings (`up`/`down`/`left`/`right`) or JSON `{"deltaX":N,"deltaY":N}`. Simulates real wheel input vs `scrollTo()` which bot detectors flag
- **`double_click`**: Double-click with `clickCount:2`, fires `dblclick` event
- **`right_click`**: Right-click with `button:'right'`, fires `contextmenu` event
- **`human_type`**: Character-by-character text entry with realistic inter-key timing (~80-160ms per character). In headed mode, fires full `keyDown`/`keyUp` event chain per character with Shift handling for uppercase and symbols. In headless mode, uses `insertText` per character (headless Chrome intercepts `rawKeyDown` as browser shortcuts). **Recommended as the default text entry method** — `type` is now for speed-over-realism cases
- **`file_upload`**: Set files on `input[type=file]` elements via `DOM.setFileInputFiles`. The only way to programmatically upload files (JavaScript security restrictions prevent it)

### Changed
- Tool description now recommends `human_type` over `type` for text entry
- Help text lists `human_type` as PREFERRED in main interaction section
- Essential patterns (login flow) updated to use `human_type` + `keyboard_press Enter`
- Browsing skill (SKILL.md) fully updated with all new actions, examples, and patterns

---

## [1.8.0] - 2026-02-25 - Viewport Emulation, Full-Page Screenshots, and HiDPI Fix

### Added
- **Viewport emulation** (`set_viewport`): device emulation with custom width/height/deviceScaleFactor and mobile mode (touch events + mobile UA string). Useful for responsive design testing and mobile screenshots
- **`clear_viewport`**: reset device emulation to browser default
- **`get_viewport`**: query current CSS viewport dimensions and devicePixelRatio
- **`clear_cookies`**: clear all browser cookies via CDP `Network.clearBrowserCookies`, without switching profiles
- **Full-page screenshots** (`fullpage: true`): capture entire scrollable page content beyond the visible viewport using `captureBeyondViewport` and `Page.getLayoutMetrics`. Available in MCP (`{"action": "screenshot", "payload": "full.png", "fullpage": true}`), CLI (`chrome-ws screenshot 0 full.png --fullpage`), and lib
- **`chrome-ws pid`** command: prints Chrome PID for X11 window management (e.g. `xdotool search --pid`)
- **`chrome-ws info`** command: prints JSON with pid, port, mode, profile, profileDir, and running status; reads meta.json so it works across processes
- **`getChromePid()`** exported from chrome-ws-lib
- **`browser_mode` action** now includes `pid` field

### Fixed
- **HiDPI screenshot sizing on Linux**: Viewport screenshots (no selector) now pass an explicit clip using `window.innerWidth`/`window.innerHeight` with `scale: 1` instead of relying on Chrome's internal DPI-scaled dimensions. All screenshots also pass `fromSurface: true`. Fixes oversized screenshots on Linux displays with system DPI scaling (e.g. 1.5x/Xft.dpi:144)

### Security
- **profileName path traversal**: `setProfileName()` now validates the profile name against `[a-zA-Z0-9_-]+` before writing meta.json, preventing path traversal via user-supplied profile names

---

## [1.7.0] - 2026-02-08 - Dynamic Port Allocation and Multi-Instance Support

### Added
- **Dynamic CDP port allocation**: Chrome no longer hardcodes port 9222. `startChrome()` finds an available port in range 9222-12111, enabling multiple parallel Chrome instances without conflicts
- **Per-profile meta.json**: Port assignment, PID, and headless mode are persisted at `~/.cache/superpowers/browser-profiles/{name}.meta.json`. This enables:
  - Reconnection to Chrome instances that survive MCP restarts
  - Collision detection when port is already in use
  - Other sessions discovering which port a profile's Chrome is on
- **`--port=N` flag**: Both MCP server and CLI accept explicit port override
  - MCP: `node mcp/dist/index.js --port=9444`
  - CLI: `./chrome-ws start --port=9555`
- **`isPortAlive()` / `findAvailablePort()` utilities**: Exported from chrome-ws-lib for advanced use
- **`browser_mode` action**: Now returns `port` field alongside headless/headed status

### Changed
- **`startChrome()` signature**: New optional third parameter `port` for explicit port selection
- **Port priority**: explicit `--port` param > `CHROME_WS_PORT` env var > dynamic allocation
- **`showBrowser`/`hideBrowser`**: Now preserve the active port across Chrome restarts
- **`killChrome()`**: Clears meta.json so other sessions know the port is free

### Technical
- Added `chromeHttpAt(host, port, path, method)` for probing ports before setting `activePort`
- Module-level `activePort` variable replaces static `CHROME_DEBUG_PORT` in `chromeHttp()`
- `rewriteWsUrl` calls pass `activePort` for correct WebSocket URL rewriting
- Stale meta.json detected via PID liveness check (`process.kill(pid, 0)`) and Chrome `/json/version` probe

---

## [1.6.4] - 2026-01-31 - Clarify Auto-Capture in Tool Description and Skill

### Changed
- **MCP tool description**: Rewritten to clearly describe what each auto-captured file contains (viewport screenshot, structured markdown, full DOM, console messages) and guide Claude to prefer reading them over using extract or screenshot actions
- **MCP help text**: Aligned auto-capture section with new tool description language
- **Browsing skill**: Added Auto-Capture section explaining the capture system; updated screenshot action to indicate viewport screenshots are already auto-captured

---

## [1.6.3] - 2026-01-28 - Bug Fixes and Auto-Downscale Screenshots

### Fixed
- **Enter key form submission**: Added `text: '\r'` to Enter keyDown events, enabling native form submission via `\n` in type payloads
- **XPath text() selector on mixed content**: XPath selectors like `//a[text()='Settings']` now fallback to `normalize-space()` for elements with mixed content (e.g., `<a><svg/>Settings</a>`)
- **README Quick Start path**: Updated plugin installation path to include marketplace/version structure

### Added
- **Auto-downscale screenshots**: Screenshots exceeding 1800px are automatically downscaled using native tools (sips on macOS, ImageMagick on Linux) to prevent Claude API "2000px limit" errors in many-image mode
- **Eval patterns in skill docs**: Added documented patterns for viewport resize, cookie clearing, and scrolling via `eval` action
- **Test harness**: Added `test-harness.js` for automated React input testing (50+ iterations)

### Changed
- **Tab and Space keys**: Added `text` property to Tab (`\t`) and Space (` `) key definitions for consistency

---

## [1.6.2] - 2025-12-21 - Focus Preservation and Tab Navigation

### Fixed
- **Tab/Enter not working in type payloads**: Fixed `\t` and `\n` escape sequences in MCP payloads
  - MCP payloads contain literal backslash-t/n strings, not actual tab/newline characters
  - Added preprocessing to convert `\t` → tab and `\n` → newline before parsing
  - Now `type(selector, "field1\tfield2\n")` correctly tabs between fields and submits
- **Focus lost during screenshots**: Screenshots were stealing focus, breaking Tab navigation
  - Added `saveFocus()` and `restoreFocus()` helpers to `captureActionWithDiff()`
  - Saves focused element (by id, name, or DOM path) before screenshot
  - Restores focus after screenshot so subsequent actions work correctly
- **Type with selector losing focus**: Changed `fill()` to use `el.focus()` instead of `click()`
  - Click triggers `capturePageArtifacts()` which takes a screenshot, losing focus
  - Using JS focus avoids the capture side effect

### Technical
- `fill()` now preprocesses value with `.replace(/\\t/g, '\t').replace(/\\n/g, '\n')`
- `captureActionWithDiff()` wraps before-screenshot with focus save/restore
- Focus identification uses id > name > DOM path fallback strategy

---

## [1.6.1] - 2025-12-15 - Auto-Detect Headless Mode in Containers

### Fixed
- **Chrome crashes in containers**: MCP server now auto-detects display availability
  - Linux: Checks `DISPLAY` or `WAYLAND_DISPLAY` environment variables
  - macOS: Checks `TERM_PROGRAM` or `DISPLAY`
  - Windows: Assumes display available (headless servers rare)
  - Falls back to headless mode when no display detected
- **Command-line overrides**: Added `--headed` flag to complement existing `--headless`
  - `--headless`: Force headless mode
  - `--headed`: Force headed mode (will fail if no display)
  - No flag: Auto-detect based on environment
- **Improved logging**: Startup message now shows mode and why it was chosen
  - Example: `(headless mode, auto-detected no display)`

### Technical
- Added `hasDisplay()` function for cross-platform display detection
- Previously Chrome defaulted to headed mode unless `--headless` was passed, causing crashes in containers/CI

---

## [1.6.0] - 2025-12-05 - XDG Cache, Browser Agent, and Profile Management

### Added
- **Persistent Chrome profiles with "superpowers-chrome" default**: Browser data now persists across sessions
  - Default profile: `superpowers-chrome`
  - Profile storage: `~/.cache/superpowers/browser-profiles/{profile-name}/`
  - Persists cookies, localStorage, extensions, auth sessions
  - Profile management actions: `set_profile`, `get_profile`
  - Optional profile parameter to `startChrome(headless, profileName)`
  - Agent-specific profiles enable isolated browser states
- **Headless mode by default**: Chrome now starts in headless mode for better performance and less desktop clutter
  - Screenshots work perfectly in headless mode
  - Faster startup and lower resource usage
  - No browser windows cluttering the desktop
- **Browser mode toggle**: New actions to control headless/headed mode
  - `show_browser`: Switch to headed mode (visible browser window)
  - `hide_browser`: Switch to headless mode (invisible browser)
  - `browser_mode`: Check current mode status and active profile
  - ⚠️ **WARNING**: Toggling modes restarts Chrome and reloads pages via GET (loses POST state)
- **XDG cache directory**: Session files now stored in platform-appropriate cache locations
  - macOS: `~/Library/Caches/superpowers/browser/YYYY-MM-DD/session-{timestamp}/`
  - Linux: `~/.cache/superpowers/browser/YYYY-MM-DD/session-{timestamp}/`
  - Windows: `%LOCALAPPDATA%/superpowers/browser/YYYY-MM-DD/session-{timestamp}/`
  - Respects `XDG_CACHE_HOME` environment variable on Linux
  - Date-based organization for easier cleanup
- **browser-user agent**: New read-only agent for browser automation tasks
  - Pre-loaded with browsing skill
  - Restricted to read-only tools (Read, Grep, Glob, Skill, use_browser)
  - Cannot modify files or execute shell commands
  - Has access to browser cache directory for viewing captured pages

### Changed
- Chrome now defaults to headless mode instead of headed mode
- Chrome profiles now persist in XDG cache directory instead of temp directory
- Session directory structure uses XDG cache conventions
- Browser process management improved with proper PID tracking and graceful shutdown
- `browser_mode` action now returns profile information

### Fixed
- **set_profile action**: Fixed bug where `ensureChromeRunning()` prevented profile changes by exempting profile/info actions from auto-start

### Technical
- Added `chromeProcess`, `chromeHeadless`, `chromeUserDataDir`, `chromeProfileName` state tracking
- Implemented `killChrome()`, `showBrowser()`, `hideBrowser()`, `getBrowserMode()` functions
- Implemented `getChromeProfileDir()`, `getProfileName()`, `setProfileName()` for profile management
- `startChrome()` now accepts optional `profileName` parameter
- Export `getXdgCacheHome()` and `getChromeProfileDir()` for external use
- MCP server updated with five new actions: browser mode control + profile management
- Help text updated with browser mode and profile management documentation
- Comprehensive test suites:
  - `test-headless-toggle.cjs` - Validates headless mode switching
  - `test-profiles.cjs` - Validates profile isolation and persistence

---

## [1.5.4] - 2025-11-30 - Screenshot Returns Absolute Path

### Fixed
- **Screenshot path confusion**: `screenshot` action now returns absolute path instead of relative filename
  - Before: `Screenshot saved to solar_optimum.png` (Claude can't find it)
  - After: `Screenshot saved to /Users/jesse/project/solar_optimum.png` (Claude reads it directly)

---

## [1.5.3] - 2025-11-30 - Image Visibility and Single-Directory Auth

### Fixed
- **Image content visibility**: Markdown extraction now includes images with alt text and dimensions
  - Adds prominent notice: "📷 This page contains N significant image(s). Check screenshot.png for visual content."
  - Lists each image with description and size info
  - Handles `<figure>` elements with captions
- **Directory auth spam**: All capture files now go in single session directory
  - Changed from subdirectories (`001-navigate-timestamp/page.md`) to flat structure (`001-navigate.md`)
  - Only one directory permission prompt per session instead of per-page
  - Files use prefixes: `001-navigate.html`, `001-navigate.md`, `001-navigate.png`, `001-navigate-console.txt`

### Changed
- `createCaptureDir()` renamed to `createCapturePrefix()` - returns prefix string instead of creating subdirectory
- Response format updated to show flat file structure with prefixes
- Help text updated to reflect new file naming convention

---

## [1.5.2] - 2025-11-22 - Critical Fix: Restore Auto-Capture Functionality

### Fixed
- **CRITICAL**: Restored all auto-capture and session management functionality that was accidentally removed
  - `initializeSession()`, `cleanupSession()`, `createCaptureDir()` - Session lifecycle management
  - `clickWithCapture()`, `fillWithCapture()`, `selectOptionWithCapture()`, `evaluateWithCapture()` - Auto-capture DOM actions
  - `enableConsoleLogging()`, `getConsoleMessages()`, `clearConsoleMessages()` - Console logging utilities
  - `generateDomSummary()`, `getPageSize()`, `generateMarkdown()`, `capturePageArtifacts()` - Capture utilities
  - Session-based directory structure and time-ordered capture subdirectories
  - 4-file capture format (page.html, page.md, screenshot.png, console-log.txt)
  - Smart DOM summary system
- **MCP server**: Now starts correctly without `initializeSession is not a function` error
- **Build system**: Rebuilt bundle with all restored functionality

### Changed
- **Windows compatibility**: Maintained host-override improvements from v1.5.0-1.5.1
  - `CHROME_DEBUG_HOST`, `CHROME_DEBUG_PORT`, `rewriteWsUrl()` integration preserved
  - Enhanced `getTabs()` and `newTab()` with WebSocket URL rewriting
  - Improved error handling for array responses

### Technical Details
The v1.5.0-1.5.1 Windows support work accidentally removed ~466 lines of auto-capture code from `chrome-ws-lib.js` that was added in v1.4.0. This release restores all v1.4.0 functionality while preserving the Windows host-override improvements.

---

## [1.5.1] - 2025-11-20 - Build System Fix and Release Documentation

### Fixed
- **Build system**: Fixed outdated `mcp/dist/index.js` bundle causing `initializeSession is not a function` error
- **Version sync**: Aligned all package.json versions to 1.5.1

### Added
- **CLAUDE.md**: Comprehensive release engineering documentation
  - Complete build system architecture
  - Step-by-step release process
  - Version management guidelines
  - Marketplace distribution workflow
  - Troubleshooting guide
  - Development workflow best practices

### Changed
- **Build verification**: Added clean build process to ensure fresh bundled output
- **Documentation**: Improved clarity on build dependencies and bundling process

---

## [1.4.2] - 2025-11-02 - Auto-Capture Documentation and Response Clarity

### Changed
- **MCP tool description**: Added clear auto-capture messaging in tool description
  - "DOM actions save page content to disk automatically - no extract needed"
  - "AUTO-SAVE: Each DOM action saves page.html, page.md, screenshot.png to temp directory"
  - Updated workflow examples to show auto-saved files instead of manual extract

- **Response format improvements**: Made file availability crystal clear
  - "Current URL:" shows exact page location
  - "Output dir:" clearly indicates capture directory
  - "Full webpage content: page.html, page.md" explicitly states complete page capture
  - "Screenshot: screenshot.png" and "JS console: console-log.txt" clearly labeled

- **Enhanced action functions**: All capture-enabled actions now include current URL in response

### Benefits
- **Eliminates confusion**: Claude clearly understands files are automatically available
- **Reduces redundant calls**: Prevents unnecessary extract actions after navigation
- **Improves UX**: Clear file categorization and location information
- **Better workflows**: Updated examples show proper auto-capture usage patterns

---

## [1.4.1] - 2025-11-02 - NPX Installation and GitHub Issues Resolution

### Added
- **NPX GitHub installation**: Direct installation via `npx github:obra/superpowers-chrome`
- **Headless mode support**: `--headless` CLI flag for server environments
- **Root package.json**: Enables proper NPX distribution from GitHub repository

### Fixed
- **GitHub Issue #1**: Installation problems resolved with NPX alternative
- **GitHub Issue #4**: Added progressive disclosure test automation guidance to skill
- **GitHub PR #5**: Merged bash shebang portability improvements

### Changed
- **Documentation clarity**: Enhanced auto-capture guidance in help action
- **Skill enhancements**: Added collapsible test automation section with troubleshooting

---

## [1.4.0] - 2025-11-02 - Session-Based Auto-Capture Enhancement

### Added

#### Session Management System
- **Session-based directory structure**: `/tmp/chrome-session-{timestamp}/`
  - Time-ordered capture subdirectories: `001-navigate-{timestamp}/`, `002-click-{timestamp}/`, etc.
  - Automatic cleanup on MCP exit (SIGINT, SIGTERM, normal exit)
  - Session initialization on first MCP use with `initializeSession()`
  - Global session tracking with `sessionDir` and `captureCounter` variables

#### Auto-Capture for DOM Actions
- **Navigate action enhancement**: Added `autoCapture` parameter (enabled by default in MCP)
- **New capture-enabled action functions**:
  - `clickWithCapture(tabIndex, selector)` - Click + immediate page capture
  - `fillWithCapture(tabIndex, selector, value)` - Type + post-type state capture
  - `selectOptionWithCapture(tabIndex, selector, value)` - Select + result capture
  - `evaluateWithCapture(tabIndex, expression)` - JavaScript eval + state capture

#### Standardized Capture Resources
- **4-file capture format per action**:
  - `page.html` - Full rendered DOM using `document.documentElement.outerHTML`
  - `page.md` - Structured markdown extraction from page elements
  - `screenshot.png` - Visual page state (renamed from `page.png`)
  - `console-log.txt` - Console message placeholder file

#### Smart DOM Summary System
- **Token-efficient DOM analysis** (replaces verbose hierarchical approach)
- **Interactive element counting**: Buttons, inputs, links with readable formatting
- **Structural analysis**: Navigation, main content areas, forms detection
- **Heading extraction**: First 3 H1 elements with truncation indicators
- **Bounded output**: <25 tokens regardless of page complexity

#### Console Logging Infrastructure
- **Console message storage**: Per-tab message tracking with `consoleMessages` Map
- **Runtime domain integration**: Console API event capture during navigation
- **Utility functions**: `enableConsoleLogging()`, `getConsoleMessages()`, `clearConsoleMessages()`
- **Placeholder implementation**: Framework ready for full console capture

#### Self-Contained Documentation
- **Help action**: New `{"action": "help"}` returns complete MCP documentation
- **Skill independence**: MCP functions on systems without Claude Code skills
- **Embedded guidance**: All actions, parameters, examples, and troubleshooting included
- **Auto-capture explanation**: Documents the new capture system within the MCP

#### NPX GitHub Installation
- **Root package.json**: Enables `npx github:obra/superpowers-chrome` installation
- **Prepare script**: Automatically builds MCP during NPX installation
- **File distribution**: Proper files array for NPX packaging
- **Binary configuration**: Correct bin path for direct execution

#### Headless Mode Support
- **CLI flag support**: `--headless` flag for NPX MCP server
- **Enhanced startChrome()**: Accepts headless parameter for server environments
- **Auto-detection**: Headless mode logged in server startup message
- **CI/CD ready**: Perfect for automated testing and server deployments

### Changed

#### MCP Response Format Overhaul
- **Navigate responses**: Enhanced object return vs simple string
  ```
  → https://example.com (capture #001)
  Size: 1200×765
  Snapshot: /tmp/chrome-session-123/001-navigate-456/
  Resources: page.html, page.md, screenshot.png, console-log.txt
  DOM:
    Example Domain
    Interactive: 0 buttons, 0 inputs, 1 links
    Headings: "Example Domain"
    Layout: body
  ```

- **DOM action responses**: All now return detailed capture information
  - Click: `"Clicked: selector"` → Rich capture response
  - Type: `"Typed into: selector"` → Rich capture response with typed value
  - Select: `"Selected: value"` → Rich capture response with selection details
  - Eval: `"[result]"` → Rich capture response with expression and result

#### Internal Function Modifications
- **navigate() function**: Added `autoCapture` parameter and enhanced return object
- **Action routing in MCP**: All DOM actions now use `*WithCapture` variants
- **Response formatting**: New `formatActionResponse()` function for consistent output
- **File naming**: Standardized resource names across all captures

#### DOM Summary Algorithm
- **Replaced hierarchical DOM tree** with smart statistical summary
- **Element counting approach**: `document.querySelectorAll()` for precise counts
- **Layout detection**: Semantic element identification (nav, main, forms)
- **Text formatting improvements**: Quoted headings, readable spacing, truncation indicators

#### Documentation and User Experience
- **Auto-capture clarity**: Updated help to emphasize files are automatically saved
- **Extract usage guidance**: Clarified when extract is needed vs when files are already available
- **Progressive disclosure**: Added collapsible test automation section to skill
- **Troubleshooting**: Enhanced with JSON.stringify patterns and chrome-ws reference guidance

### Technical Implementation Details

#### File Structure Changes
```
skills/browsing/chrome-ws-lib.js:
  + Session management functions (initializeSession, cleanupSession, createCaptureDir)
  + Console logging utilities (enableConsoleLogging, getConsoleMessages, clearConsoleMessages)
  + Enhanced DOM functions (generateDomSummary, getPageSize, generateMarkdown, capturePageArtifacts)
  + Capture-enabled action wrappers (clickWithCapture, fillWithCapture, selectOptionWithCapture, evaluateWithCapture)
  * Modified navigate() function with autoCapture parameter

mcp/src/index.ts:
  + formatActionResponse() function for consistent response formatting
  + Enhanced navigate action with rich response handling
  * Modified click, type, select, eval actions to use capture variants
  + Session initialization in main() function
```

#### Process Lifecycle Integration
- **Cleanup handlers**: Registered for `exit`, `SIGINT`, `SIGTERM` events
- **Session persistence**: Directory maintained throughout MCP lifetime
- **Capture sequencing**: Incremental numbering for temporal ordering
- **Error recovery**: Auto-capture failures don't prevent action success

#### Browser Integration Enhancements
- **Dual domain enablement**: Page + Runtime domains for navigation with auto-capture
- **Message handling**: Enhanced WebSocket message processing for console events
- **Timing coordination**: 1-second delay after page load for console message capture
- **Parallel processing**: Simultaneous HTML, markdown, screenshot, and DOM summary generation

### Backward Compatibility
- **Original functions preserved**: `click()`, `fill()`, `selectOption()`, `evaluate()` unchanged
- **MCP tool interface**: No changes to external tool parameters or descriptions
- **Graceful degradation**: Auto-capture failures return basic success responses
- **Module exports**: All existing exports maintained, new functions added

### Performance Optimizations
- **Token efficiency**: 95% reduction in DOM summary token usage
- **Parallel capture**: Simultaneous file generation for faster response times
- **Memory management**: Session cleanup prevents directory accumulation
- **Bounded operations**: DOM summary algorithm has fixed computational complexity

### Benefits for Claude
- **Rich context**: Comprehensive page state after every DOM-changing action
- **Visual debugging**: Screenshots show immediate action results
- **Structured analysis**: Markdown format enables content analysis
- **Temporal tracking**: Numbered captures show interaction progression
- **Token preservation**: Smart DOM summary prevents large page token explosion
- **Organized workflow**: Session-based storage for complex automation sequences

---

## [1.3.0] - 2025-11-01

### Added
- XPath selector support alongside CSS selectors
- Improved tool clarity with examples
- Auto-tab creation when none exist

### Changed
- Enhanced payload parameter documentation with action-specific details
- Improved error handling for out-of-range tab indices

### Fixed
- Tab index validation and error messages