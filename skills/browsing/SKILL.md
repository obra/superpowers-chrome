---
name: browsing
description: Use when you need direct browser control - teaches Chrome DevTools Protocol for controlling existing browser sessions, multi-tab management, form automation, and content extraction via use_browser MCP tool
allowed-tools: mcp__chrome__use_browser
---

# Browsing with Chrome Direct

## Overview

Control Chrome via DevTools Protocol using the `use_browser` MCP tool. Single unified interface with auto-starting Chrome.

**Announce:** "I'm using the browsing skill to control Chrome."

## When to Use

**Use this when:**
- Controlling authenticated sessions
- Managing multiple tabs in running browser
- Playwright MCP unavailable or excessive

**Use Playwright MCP when:**
- Need fresh browser instances
- Generating screenshots/PDFs
- Prefer higher-level abstractions

## Auto-Capture

Every DOM action (navigate, click, type, select, eval, keyboard_press, hover, drag_drop, double_click, right_click, file_upload) automatically saves:
- `{prefix}.png` — viewport screenshot
- `{prefix}.md` — page content as structured markdown
- `{prefix}.html` — full rendered DOM
- `{prefix}-console.txt` — browser console messages

Files are saved to the session directory with sequential prefixes (001-navigate, 002-click, etc.). You must check these before using extract or screenshot actions.

**Pause switch (`pause_capture`/`resume_capture`):** the shape/marker/URL defenses below only catch a secret with a recognized shape, an opt-in `data-sen-secret` mark, or a known-sensitive URL. A page that reveals a secret a different way — a "show password"/"reveal" click that renders the plaintext into an ordinary, unremarkable element (no secret-looking id/name/class, no sensitive URL) — slips past all three, and the very next auto-capture writes it to disk. Call `pause_capture` immediately BEFORE any action you expect to reveal a secret this way; every auto-capture (DOM/markdown/screenshot/console/dialog) is skipped — no CDP call is even made — until you call `resume_capture`. The action that triggers the reveal still runs normally; only its capture is skipped. An explicit `screenshot` call also refuses outright while paused. Pause state lives on the session and persists across actions until you resume: forgetting to call `resume_capture` just means no more captures for the rest of the session, never a silent leak. **Caveat:** this is in-memory, process-local state — it does NOT survive the MCP server process restarting (e.g. `restart_chrome` re-adopting a still-running Chrome keeps the SAME process and stays paused, but a full MCP server restart starts a fresh `capturePaused:false`). If the server restarts while a secret is still on-screen from a paused reveal, the next auto-capture after that restart will NOT be paused — the only signal is that the pause notice stops appearing in responses. Use the credential broker to capture the value itself while paused; resume as soon as the secret is off-screen.

**Credential-shaped pages:** when a page shows a token or secret (Slack `xoxb-`/`xapp-`, GitHub `ghp_`/`github_pat_`, 1Password `ops_`/`A3-` keys, `otpauth://` seeds, or any element marked `data-sen-secret`), no files are written for that action and the response says `⚠️ Page shows credential-shaped content; auto-capture and DOM output suppressed.` with only metadata. Token-shaped values in `extract`/`eval` output are replaced by `[REDACTED credential-shaped]`, and `screenshot` refuses. Capture secrets with a credential broker. On a token-shaped page, use `eval` only for value-blind queries (e.g. "is the token field present?"). On a page with any `data-sen-secret` element, `eval` refuses outright, and `extract`/`attr` refuse for the marked element or strip it from HTML/markdown output. The marker scan covers the top document, open shadow roots, and same-origin `iframe`/`frame`/`object`/`embed`; it does not see closed shadow roots or cross-origin frames. Markup inside an `<iframe srcdoc="…">` attribute is not stripped: `extract` html and `attr srcdoc` return it verbatim.

**When to mark a secret:** mark its element with `set_attr` (`data-sen-secret`) as soon as the action that revealed it returns, before any other action on that page, then capture the value with the credential broker. Marking only affects later actions. The capture files the revealing action already wrote (e.g. `003-click.html`/`.md`) still hold the value and are not deleted, so don't read them back. This is an accident guard for a cooperating agent, not a security boundary. `SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE=1` turns all of this off.

Separately (and unconditionally): a plain password or one-time code has no shape the check above recognizes, so a page's own handler mirroring one into an attribute, a hidden input, or visible text would otherwise land in the `.html`/`.md`/`-diff.txt` files. Whatever gets written is scrubbed on an inert clone (`document.implementation.createHTMLDocument` + `importNode`, never `cloneNode` on the live document): `value` and every `data-*`/`aria-*` attribute are stripped from `input[type="password"]` (case-insensitive; remembered on that same element after a "show password" toggle flips it to `type="text"`), any field whose `autocomplete` contains `current-password`, `new-password`, `one-time-code`, `cc-number`, or `cc-csc` (case-insensitive substring), and `data-sen-secret`-marked elements. A field with none of those signals is still caught if its own live `.value` exactly matches one of its OTHER attributes (a self-mirror) -- the case for Google's 2-step verification `totpPin` field, which has no recognized type or autocomplete but copies the typed code into `data-initial-value` itself. Self-mirror detection skips inputs nobody types into (`submit`, `button`, `reset`, `checkbox`, `radio`, `hidden`, `image`) and ignores attributes that name or label a field (`type`, `name`, `id`, `aria-label`, `title`, `placeholder`, `for`, `class`). The live `.value` of every field found any of these ways, plus its HTML-entity-escaped forms (including `&nbsp;`), is also replaced with `[REDACTED]` wherever it occurs in the output -- any attribute, on any element, not just the field's own `value` -- if it is at least 4 characters long (3 for `cc-csc`). Dialog captures are redacted with the values from the most recent page capture; a value typed in the same action that opened the dialog is not. Redaction is a plain string replace, so a secret that also appears as ordinary page text (a password of `password`) replaces that text too; the artifact is degraded but nothing leaks. Self-mirror detection can also flag a non-secret typeable field whose value happens to equal one of its other attributes (a search box synced into `data-query`), with the same effect. The live page is never touched.

**Known gaps (the secret is written to disk in clear):** split one-digit OTP boxes feeding an aggregate hidden input (each digit is below the length floor, so the aggregate leaks); a field cleared on submit whose mirror remains; a "show password" toggle that swaps in a new element instead of changing `type`; a self-mirrored value shorter than the length floor (the field is still found, but its value is too short to substring-redact). Screenshots are pixels, not scrubbed text: a visible (`type="text"`) typed value can appear in a `.png`.

**Default secret-pattern detection (no marking, no click required):** everything above needs a recognized type/autocomplete, or a value already mirrored somewhere -- neither helps a secret already in the DOM at page load, before any action (and so before any marking) has run. Real case: Slack's 2FA setup page puts the TOTP seed in a hidden `#init_key_code` element from load, so the very first navigate's auto-capture would otherwise leak it. Any element whose `id`/`name`/`class`/`autocomplete`/`aria-label` contains `secret`, `totp`, `otp`, `2fa`, `mfa`, `key_code`, `seed`, `recovery`, `backup_code`, `api_key`, or `token` as a WORD (split on `-`/`_`/camelCase/whitespace, not a raw substring -- "otp" no longer matches inside "footprint", "token" no longer matches inside "token-list") is redacted on sight: a value-bearing match (`input`/`textarea`/`select`) joins the same value-collection/redaction pass as above; a leaf match (no element children -- a `<span>`/`<div>`/`<code>` holding the secret as text) has its own text blanked directly by element reference, regardless of length, never via a page-wide substring replace (that used to corrupt unrelated text sharing the same word, e.g. Prism's `class="token keyword"` spans turning every `class=` attribute into `[REDACTED]=`); a wrapping container (has element children) is fully blanked -- every descendant's text is blanked too, not just its own attributes, so a secret split across child elements (`<div id="totp-secret">Key: <code>SEED</code></div>`, a `<ul class="recovery-codes">` list) no longer leaks -- but only when the match is STRONG (an exact compound like `totp-secret`/`recovery-codes`/`api-key`/`private-key`, not a bare single word) and the container's text is 2000 characters or fewer; a WEAK match (bare `token`/`secret`, e.g. a design-system class `sn-token-provider` or a docs `<section id="module-secrets">`) does not wholesale-blank -- that wiped real page content (a "Get started" paragraph) in testing -- though any descendant that independently matches on its own is still found and blanked regardless. A button/link (and anything nested inside one) is never text-blanked even when matched (its own text is a UI label, e.g. `copy-seed-btn`'s "Copy", not the secret) -- but its own attributes ARE still stripped (fixed: an earlier version returned before stripping them, so a copy button's `data-clipboard-text` leaked). `label`/`summary`/`legend`/`option` are no longer exempt either -- their own text is blanked and recursed into, since a `<label>` wrapping a matched leaf is routinely the only place the secret renders at all. An `otpauth://` URI is redacted unconditionally wherever it appears (href/src/data-*/text/alt/title), independent of the word-boundary match. The `.md` artifact gets the same redaction independently (it walks the live DOM directly, not the HTML clone), including a matched element sitting INLINE inside an emitted block (`<p>Key: <code id="totp-secret">SEED</code></p>`) by walking each block's own subtree instead of flattening it via `textContent`. A bare `token` is broad enough to also catch an ordinary CSRF token field -- accepted, since this only touches the disk copy, never the live page.

**URL-based suppression:** independent of markup, a page whose URL matches `/2fa`, `/two_factor` (unanchored -- GitHub/GitLab/1Password's real 2FA routes all need the open suffix, same as Slack's), `/two-step`, `/mfa` (segment-anchored, unlike the others -- an unanchored `/mfa` also matched a docs page merely about mfa), `/totp`, `/security/keys`, `security-keys`, `/recovery-codes`, `/backup-codes`, `login-verification`, or `security-info` has its html/md capture AND its screenshot -- including an explicit `screenshot` action, not just auto-capture -- suppressed outright, same as a credential-shaped page but with its own distinct message (an earlier version always said "page shows credential-shaped content" for an explicit screenshot refusal, even when the real reason was the URL). `/2fa`/`/totp`/`security-keys`/`security-info` require a word-boundary on the open side -- `/2fast`, `/totpal` and `/security-keyset-docs` no longer match just because they start with the same letters. Matched against the URL's pathname and hash (never its query string, which over-suppressed an ordinary `/login?next=/settings/2fa` redirect) -- the hash is included so a hash-routed SPA route (e.g. AWS's `#/security_credentials/mfa`) still matches -- and only for a real page location (http(s):, file:); never for `data:`/`blob:`/`about:` URLs, whose "pathname" is not a path (a `data:` URL's pathname IS its percent-encoded body, so a page merely mentioning a sensitive word in its own title would otherwise false-match on itself). Catches a secret with no recognized shape or attribute naming at all (a bare seed, a QR code) purely by the page it's on. `SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE=1` disables this (for auto-capture and an explicit screenshot alike). `SUPERPOWERS_CHROME_SENSITIVE_URL_PATTERNS` adds extra comma-separated regexes to the defaults (never replaces them).

## The use_browser Tool

Single MCP tool with action-based interface. Chrome auto-starts on first use.

**Parameters:**
- `action` (required): Operation to perform
- `selector` (optional): CSS or XPath selector for element operations
- `payload` (optional): Action-specific data (string or object)
- `timeout` (optional): Timeout in ms for await operations (default: 5000)

**Active tab**: Every action operates on the current `activeTab`. Use `switch_tab` to change it.

## Actions Reference

### Navigation
- **navigate**: Navigate to URL
  - `payload`: URL string
  - Example: `{action: "navigate", payload: "https://example.com"}`

- **await_element**: Wait for element to appear
  - `selector`: CSS selector
  - `timeout`: Max wait time in ms
  - Example: `{action: "await_element", selector: ".loaded", timeout: 10000}`

- **await_text**: Wait for text to appear
  - `payload`: Text to wait for
  - Example: `{action: "await_text", payload: "Welcome"}`

### Interaction
- **click**: Click element
  - `selector`: CSS selector
  - Example: `{action: "click", selector: "button.submit"}`

- **type**: Text input
  - `selector`: Optional — clicks to focus first
  - `payload`: Text to type (`\t`=Tab, `\n`=Enter)
  - Example: `{action: "type", selector: "#email", payload: "user@example.com"}`

- **double_click**: Double-click element (fires dblclick event)
  - `selector`: CSS selector
  - Example: `{action: "double_click", selector: ".item"}`

- **right_click**: Right-click element (fires contextmenu event)
  - `selector`: CSS selector
  - Example: `{action: "right_click", selector: ".row"}`

- **select**: Select dropdown option
  - `selector`: CSS selector
  - `payload`: Option value(s)
  - Example: `{action: "select", selector: "select[name=state]", payload: "CA"}`

- **keyboard_press**: Press special keys (Tab, Enter, Escape, Arrow keys, F1-F12)
  - `payload`: Key name (string) or `{"key": "Tab", "modifiers": {"shift": true, "ctrl": false, "alt": false, "meta": false}}`
  - Example: `{action: "keyboard_press", payload: "Tab"}`
  - Example with modifiers: `{action: "keyboard_press", payload: {"key": "Tab", "modifiers": {"shift": true}}}`

### Mouse Actions (CDP-Level)
These use CDP Input.dispatchMouseEvent, bypassing synthetic event restrictions.

- **hover**: Move mouse over element (CSS :hover, tooltips, menus)
  - `selector`: CSS selector
  - Example: `{action: "hover", selector: ".menu-trigger"}`

- **drag_drop**: Drag element to target (native drag-and-drop via CDP)
  - `selector`: Source element
  - `payload`: Target selector or JSON coordinates `{"x":N,"y":N}`
  - Example: `{action: "drag_drop", selector: ".card", payload: ".column-2"}`

- **mouse_move**: Move mouse to coordinates
  - `payload`: JSON `{"x":N,"y":N}` (optional: `steps`, `fromX`, `fromY` for smooth movement)
  - Example: `{action: "mouse_move", payload: "{\"x\":100,\"y\":200}"}`

- **scroll**: Scroll via mouse wheel events
  - `payload`: Direction (up/down/left/right) or JSON `{"deltaX":N,"deltaY":N}`
  - `selector`: Optional — scroll within element
  - Example: `{action: "scroll", payload: "down"}`

### File Upload
- **file_upload**: Set files on input[type=file] elements (can't be done via JavaScript)
  - `selector`: File input element
  - `payload`: File path or JSON `{"files":["/path/a.pdf","/path/b.jpg"]}`
  - Example: `{action: "file_upload", selector: "#upload", payload: "/tmp/doc.pdf"}`

### Extraction
- **extract**: Get page content
  - `payload`: Format ('markdown'|'text'|'html')
  - `selector`: Optional - limit to element
  - Example: `{action: "extract", payload: "markdown"}`
  - Example: `{action: "extract", payload: "text", selector: "h1"}`

- **attr**: Get element attribute
  - `selector`: CSS selector
  - `payload`: Attribute name
  - Example: `{action: "attr", selector: "a.download", payload: "href"}`

- **set_attr**: Write-only attribute setter, restricted to EXACTLY two attribute names — `data-sen-nonce` and `data-sen-secret` itself (nothing else, not any other `data-*`/`aria-*` name; see `skills/browsing/lib/set-attribute.js`'s `ALLOWED_ATTRIBUTE_NAMES` constant)
  - `selector`: CSS or XPath selector
  - `payload`: `{"name": "data-sen-nonce"|"data-sen-secret", "value": "..."}` (no bare-string form — needs both fields)
  - `data-sen-nonce` resolves to the single first-VISIBLE match, the same way `extract`/`click`/`type` resolve a selector, and refuses if that element already carries `data-sen-secret`. `data-sen-secret` instead marks EVERY element the selector matches, hidden duplicates included, and can never remove or weaken an existing mark (re-marking an already-marked element is a no-op, not a refusal) — this is the write path for the marker itself.
  - Unlike every read action, `set_attr` is NOT blocked by a `data-sen-secret` element existing elsewhere on the page — it takes no caller JavaScript, and its only output is `ok`/`no element matched`/`refused`, which acts as a limited prefix oracle (see below). Use it instead of `eval` to write onto a page that already has a captured secret (e.g. stamping a credential-broker nonce onto an unmarked digit-input box next to a just-captured TOTP seed, or marking the seed's element in the first place).
  - Why so narrow: page JS and frameworks routinely read arbitrary `data-*`/`aria-*` attributes and wire them to behavior (`data-action`, `data-href`, `aria-controls`, and more a hostile page could invent), so a prefix allowlist is not guaranteed inert. Widening past these two names is a deliberate, separate change. Its `ok`/`no element matched`/`refused: target element is marked` responses differ by outcome, which is itself a limited prefix oracle over page content for a caller who varies the selector and watches which result comes back — a known, accepted limitation, not something this guards against.
  - Example: `{action: "set_attr", selector: "#code-input-0", payload: {"name": "data-sen-nonce", "value": "opaque-nonce"}}`

- **eval**: Execute JavaScript
  - `payload`: JavaScript code
  - Example: `{action: "eval", payload: "document.title"}`
  - Refuses outright (no value-blind exception) while any element on the page carries `data-sen-secret`, checked live at the moment of the call — see `set_attr` above for the write-only escape hatch. **This is an accident guard, not a security boundary**: eval runs in the same JS realm as the marked element, so it can already read the value directly, exfiltrate it via `fetch()`/`window.name`/storage, or erase the marker with `removeAttribute` as its own last step — none of which this check can catch, by design. Don't mark an element and then eval on that page expecting the value to stay contained; after marking, use the credential broker for the value and `set_attr` for writes.

### Export
- **screenshot**: Capture screenshot of a specific element
  - `payload`: Filename
  - `selector`: Optional - screenshot specific element
  - Viewport screenshots are auto-captured after every DOM action. Use this only when you need a specific element.
  - Example: `{action: "screenshot", payload: "/tmp/chart.png", selector: ".chart"}`

### Tab Management
- **list_tabs**: List all open tabs
  - Example: `{action: "list_tabs"}`

- **new_tab**: Create new tab
  - Example: `{action: "new_tab"}`

- **close_tab**: Close the active tab
  - Example: `{action: "close_tab"}`

- **switch_tab**: Switch the active tab (sticky — stays until changed)
  - `payload`: Tab index (number), URL substring, or title substring
  - Example: `{action: "switch_tab", payload: 1}` (by index)
  - Example: `{action: "switch_tab", payload: "example.com"}` (by URL substring)
  - Example: `{action: "switch_tab", payload: "GitHub"}` (by title substring)

### Browser Mode Control
- **show_browser**: Make browser window visible (headed mode)
  - Example: `{action: "show_browser"}`
  - ⚠️ **WARNING**: Restarts Chrome, reloads pages via GET, loses POST state

- **hide_browser**: Switch to headless mode (invisible browser)
  - Example: `{action: "hide_browser"}`
  - ⚠️ **WARNING**: Restarts Chrome, reloads pages via GET, loses POST state

- **browser_mode**: Check current browser mode, port, and profile
  - Example: `{action: "browser_mode"}`
  - Returns: `{"headless": true|false, "mode": "headless"|"headed", "running": true|false, "port": 9222, "profile": "name", "profileDir": "/path"}`

### Profile Management
- **set_profile**: Change Chrome profile (must kill Chrome first)
  - Example: `{action: "set_profile", "payload": "browser-user"}`
  - ⚠️ **WARNING**: Chrome must be stopped first
  - **Side effect**: marks the profile as explicit, opting out of auto-disambiguation (see below)

- **get_profile**: Get current profile name and directory
  - Example: `{action: "get_profile"}`
  - Returns: `{"profile": "name", "profileDir": "/path"}`

**Default behavior**: Chrome starts in **headless mode** with **"superpowers-chrome" profile** on a **dynamically allocated port** (range 9222-12111). Override the port with `CHROME_WS_PORT`; override the profile with `CHROME_WS_PROFILE`.

**Auto-disambiguation across parallel MCPs**:
When two MCP servers start on the same host with the default profile, the first claims `superpowers-chrome` (port 9222) and later ones silently fall through to `superpowers-chrome-2` (port 9223), `superpowers-chrome-3`, etc. Each MCP drives its own Chrome with its own profile dir; they don't fight over `activeTab`. The bridge tracks ownership via a lock file at `~/.cache/superpowers/browser-profiles/<profile>.mcp.lock`; stale locks (dead PIDs) are reclaimed automatically.

To opt **out** of disambiguation — e.g., to intentionally share Chrome between a long-lived `chrome-ws` CLI session and your MCP — set the profile name explicitly:
- Env var: `CHROME_WS_PROFILE=my-profile`
- Or: `{action: "set_profile", payload: "my-profile"}` at runtime

An explicit profile name still acquires the lock, but on conflict the bridge **shares** rather than disambiguates — the second process reconnects to the first's Chrome (the original reconnect-on-restart behavior).

### Chrome Lifecycle (Recovery)
- **kill_chrome**: Kill the Chrome process this MCP is driving
  - Example: `{action: "kill_chrome"}`
  - Releases the meta.json; next page action auto-restarts Chrome

- **restart_chrome**: kill_chrome + immediate spawn
  - Example: `{action: "restart_chrome"}`

**Auto-restart banner**: when the bridge has to spawn a fresh Chrome (because the previous one died or was killed externally — e.g., `kill -9 <pid>` from the shell), the first response after the restart prepends:
```
[Chrome auto-restarted; URL reset to about:blank. Re-navigate to continue.]
```
Treat this as a signal that your prior URL / tab state is gone — re-navigate before assuming anything about the current page.

### Console Logging
Capture browser console output for the active tab. Buffer is keyed by the page session's `sessionId`, so it survives `close_tab`/`new_tab` ordering quirks. Levels: `log`, `info`, `warn`, `error`.

- **enable_console_logging**: Start capturing
  - Example: `{action: "enable_console_logging"}`

- **get_console_messages**: Read captured messages
  - All: `{action: "get_console_messages"}`
  - Since timestamp (epoch ms): `{action: "get_console_messages", payload: {since: 1716000000000}}`
  - Returns: array of `{timestamp, level, text}` entries

- **clear_console_messages**: Reset the buffer
  - Example: `{action: "clear_console_messages"}`

### Capture Control
See "Pause switch" under Auto-Capture above for the full rationale.

- **pause_capture**: Suspend every automatic capture (DOM/markdown/screenshot/console/dialog) for the rest of this session
  - Example: `{action: "pause_capture"}`
  - Call this immediately BEFORE an action you expect to reveal a secret with no recognized shape, marker, or sensitive URL (e.g. a "show password" click). The action still runs; only its capture is skipped. An explicit `screenshot` call also refuses while paused.

- **resume_capture**: Restore normal auto-capture
  - Example: `{action: "resume_capture"}`
  - Call this as soon as the secret is off-screen. Pause state persists across actions until you call this.

### Dialog Handling
Native dialogs (JS alert/confirm/prompt, beforeunload, HTTP basic-auth, permission prompts, device choosers) pause the page. While a dialog is open, page-targeted actions (`extract`, `click`, `eval`, etc.) return a refusal whose text contains `Page is behind a dialog` and lists the available `dialog::*` selectors.

When a dialog fires **during** a `navigate` (typical for HTTP basic-auth), `navigate` itself throws with the dialog grammar in the message — you don't have to issue a separate page-targeted call to discover the dialog.

Handle dialogs by clicking/typing a `dialog::*` selector:
- `{action: "click", selector: "dialog::accept"}` — accept JS alert/confirm/prompt, beforeunload, permission grant
- `{action: "click", selector: "dialog::dismiss"}` — dismiss / cancel / deny
- `{action: "type", selector: "dialog::prompt", payload: "text"}` then accept — respond to JS prompt
- `{action: "type", selector: "dialog::username", payload: "alice"}` + `{action: "type", selector: "dialog::password", payload: "secret"}` + `{action: "click", selector: "dialog::accept"}` — HTTP basic-auth
- `{action: "click", selector: "dialog::device[id=\"<deviceId>\"]"}` — pick a WebUSB/Bluetooth/Serial/HID device

**Critical caveats when toggling modes**:
1. **Chrome must restart** - Cannot switch headless/headed mode on running Chrome
2. **Pages reload via GET** - All open tabs are reopened with GET requests
3. **POST state is lost** - Form submissions, POST results, and POST-based navigation will be lost
4. **Session state is lost** - Any client-side state (JavaScript variables, etc.) is cleared
5. **Cookies/auth may persist** - Uses same user data directory, so logged-in sessions may survive

**When to use headed mode**:
- Debugging visual rendering issues
- Demonstrating browser behavior to user
- Testing features that only work with visible browser
- Debugging issues that don't reproduce in headless mode

**When to stay in headless mode** (default):
- All other cases - faster, cleaner, less intrusive
- Screenshots work perfectly in headless mode
- Most automation works identically in both modes

**Profile management**:
Profiles store persistent browser data (cookies, localStorage, extensions, auth sessions).

**Profile locations**:
- macOS: `~/Library/Caches/superpowers/browser-profiles/{name}/`
- Linux: `~/.cache/superpowers/browser-profiles/{name}/`
- Windows: `%LOCALAPPDATA%/superpowers/browser-profiles/{name}/`

**When to use separate profiles**:
- **Default profile ("superpowers-chrome")**: General automation, shared sessions
- **Agent-specific profiles**: Isolate different agents' browser state
  - Example: browser-user agent uses "browser-user" profile
- **Task-specific profiles**: Testing with different user contexts
  - Example: "test-logged-in" vs "test-logged-out"

**Profile data persists across**:
- Chrome restarts
- Mode toggles (headless ↔ headed)
- System reboots (data is in cache directory)

**To use a different profile**:
1. Kill Chrome if running: `await chromeLib.killChrome()`
2. Set profile: `{action: "set_profile", "payload": "my-profile"}`
3. Start Chrome: Next navigate/action will use new profile

## Quick Start Pattern

```
Navigate and extract:
{action: "navigate", payload: "https://example.com"}
{action: "await_element", selector: "h1"}
{action: "extract", payload: "text", selector: "h1"}
```

## Common Patterns

### Fill and Submit Form
```
{action: "navigate", payload: "https://example.com/login"}
{action: "await_element", selector: "input[name=email]"}
{action: "type", selector: "input[name=email]", payload: "user@example.com"}
{action: "type", selector: "input[name=password]", payload: "pass123"}
{action: "keyboard_press", payload: "Enter"}
{action: "await_text", payload: "Welcome"}
```

Uses `keyboard_press` to submit the form.

### Multi-Tab Workflow
```
{action: "list_tabs"}
{action: "switch_tab", payload: 2}
{action: "click", selector: "a.email"}
{action: "await_element", selector: ".content"}
{action: "extract", payload: "text", selector: ".amount"}
```

### Dynamic Content
```
{action: "navigate", payload: "https://example.com"}
{action: "type", selector: "input[name=q]", payload: "query"}
{action: "click", selector: "button.search"}
{action: "await_element", selector: ".results"}
{action: "extract", payload: "text", selector: ".result-title"}
```

### Get Link Attribute
```
{action: "navigate", payload: "https://example.com"}
{action: "await_element", selector: "a.download"}
{action: "attr", selector: "a.download", payload: "href"}
```

### Execute JavaScript
```
{action: "eval", payload: "document.querySelectorAll('a').length"}
{action: "eval", payload: "Array.from(document.querySelectorAll('a')).map(a => a.href)"}
```

### Resize Viewport (Responsive Testing)
Use `eval` to resize the browser window for testing responsive layouts:
```
{action: "eval", payload: "window.resizeTo(375, 812); 'Resized to mobile'"}
{action: "eval", payload: "window.resizeTo(768, 1024); 'Resized to tablet'"}
{action: "eval", payload: "window.resizeTo(1920, 1080); 'Resized to desktop'"}
```

**Note**: This resizes the window, not device emulation. It won't change:
- Device pixel ratio (retina displays)
- Touch events
- User-Agent string

For most responsive testing, window resize is sufficient.

### Clear Cookies
Use `eval` to clear cookies accessible to JavaScript:
```
{action: "eval", payload: "document.cookie.split(';').forEach(c => { document.cookie = c.trim().split('=')[0] + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/'; }); 'Cookies cleared'"}
```

**Note**: This clears cookies accessible to JavaScript. It won't clear:
- httpOnly cookies (server-side only)
- Cookies from other domains

For most logout/reset scenarios, this is sufficient.

### Scroll Page
```
{action: "scroll", payload: "down"}
{action: "scroll", payload: "up"}
{action: "scroll", selector: ".container", payload: "{\"deltaX\":0,\"deltaY\":500}"}
```

Uses real mouse wheel events (vs `eval` + `scrollTo` which bot detectors flag).

## Tips

**Always wait before interaction:**
Don't click or fill immediately after navigate - pages need time to load.

```
// BAD - might fail if page slow
{action: "navigate", payload: "https://example.com"}
{action: "click", selector: "button"}  // May fail!

// GOOD - wait first
{action: "navigate", payload: "https://example.com"}
{action: "await_element", selector: "button"}
{action: "click", selector: "button"}
```

**Use specific selectors:**
Avoid generic selectors that match multiple elements.

```
// BAD - matches first button
{action: "click", selector: "button"}

// GOOD - specific
{action: "click", selector: "button[type=submit]"}
{action: "click", selector: "#login-button"}
```

**Submit forms:**
Use `keyboard_press` with Enter after `type`, or append `\n` to the payload.

```
{action: "type", selector: "#search", payload: "query"}
{action: "keyboard_press", payload: "Enter"}
```

**Check content first:**
Extract page content to verify selectors before building workflow.

```
{action: "extract", payload: "html"}
```

## Troubleshooting

**Element not found:**
- Use `await_element` before interaction
- Verify selector with `extract` action using 'html' format

**Timeout errors:**
- Increase timeout: `{timeout: 30000}` for slow pages
- Wait for specific element instead of text

**Wrong tab active:**
- Use `list_tabs` to see all open tabs
- Use `switch_tab` with a URL or title substring to reliably switch tabs
- Tab indices shift when tabs close — prefer URL/title-based switching

**eval returns `[object Object]`:**
- Use `JSON.stringify()` for complex objects: `{action: "eval", payload: "JSON.stringify({name: 'test'})"}`
- For async functions: `{action: "eval", payload: "JSON.stringify(await yourAsyncFunction())"}`

## Test Automation (Advanced)

<details>
<summary>Click to expand test automation guidance</summary>

When building test automation, you have two approaches:

### Approach 1: use_browser MCP (Simple Tests)
Best for: Single-step tests, direct Claude control during conversation

```json
{"action": "navigate", "payload": "https://app.com"}
{"action": "click", "selector": "#test-button"}
{"action": "eval", "payload": "JSON.stringify({passed: document.querySelector('.success') !== null})"}
```

### Approach 2: chrome-ws CLI (Complex Tests)
Best for: Multi-step test suites, standalone automation scripts

**Key insight**: `chrome-ws` is the reference implementation showing proper Chrome DevTools Protocol usage. When `use_browser` doesn't work as expected, examine how `chrome-ws` handles the same operation.

```bash
# Example: Automated form testing
./chrome-ws navigate 0 "https://app.com/form"
./chrome-ws fill 0 "#email" "test@example.com"
./chrome-ws click 0 "button[type=submit]"
./chrome-ws wait-text 0 "Success"
```

### When use_browser Fails
1. **Check chrome-ws source code** - It shows the correct CDP pattern
2. **Use chrome-ws to verify** - Test the same operation via CLI
3. **Adapt the pattern** - Apply the working CDP approach to use_browser

### Common Test Automation Patterns
- **Form validation**: Fill forms, check error states
- **UI state testing**: Click elements, verify DOM changes
- **Performance testing**: Measure load times, capture metrics
- **Screenshot comparison**: Capture before/after states

</details>

## Advanced Usage

For command-line usage outside Claude Code, see [COMMANDLINE-USAGE.md](COMMANDLINE-USAGE.md).

For detailed examples, see [EXAMPLES.md](EXAMPLES.md).

## Protocol Reference

Full CDP documentation: https://chromedevtools.github.io/devtools-protocol/
