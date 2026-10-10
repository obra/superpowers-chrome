# Superpowers Chrome - Claude Code Plugin

Direct browser control via Chrome DevTools Protocol. Two modes available:

1. **Skill Mode** - CLI tool for Claude Code agents (`browsing` skill)
2. **MCP Mode** - Ultra-lightweight MCP server for any MCP client

## Features

- **Zero dependencies** - Built-in WebSocket, no npm install needed
- **Idiotproof API** - Tab index syntax (`0`, `1`, `2`) instead of WebSocket URLs
- **Platform-agnostic** - `chrome-ws start` works on macOS, Linux, Windows
- **17 commands** covering all browser automation needs
- **Complete documentation** with real-world examples

## Installation

```bash
/plugin marketplace add obra/superpowers-marketplace
/plugin install superpowers-chrome@superpowers-marketplace
```

## Quick Start

```bash
# Find your plugin installation path (varies by marketplace and version)
# Common locations:
#   ~/.claude/plugins/cache/superpowers-marketplace/superpowers-chrome/<version>/skills/browsing
#   ~/.claude/plugins/cache/superpowers-chrome/skills/browsing

cd ~/.claude/plugins/cache/superpowers-marketplace/superpowers-chrome/*/skills/browsing
./chrome-ws start                        # Launch Chrome
./chrome-ws new "https://example.com"   # Create tab
./chrome-ws navigate 0 "https://google.com"
./chrome-ws fill 0 "textarea[name=q]" "test"
./chrome-ws click 0 "button[name=btnK]"
```

**Port allocation:** Chrome gets a dynamically allocated port (range 9222-12111) to avoid conflicts. Port assignment is persisted per profile in `~/.cache/superpowers/browser-profiles/{name}.meta.json`. Override with `--port=N` flag or `CHROME_WS_PORT` env var. Multiple profiles can run in parallel on different ports.

**Parallel MCPs on one host** (3.0+): the bridge auto-disambiguates the default profile. The first MCP claims `superpowers-chrome:9222`, the next silently falls through to `superpowers-chrome-2:9223`, then `-3:9224`, etc., each driving its own Chrome with its own profile dir. To intentionally **share** a Chrome between processes (e.g., a `chrome-ws` CLI session + a Claude MCP attaching to it), set a fixed profile via `CHROME_WS_PROFILE=name` (env var) or call `{action: "set_profile", payload: "name"}` at runtime — explicit profiles share rather than disambiguate.

**Windows tip:** The tooling defaults to `127.0.0.1` for DevTools traffic. Override via `CHROME_WS_HOST` / `CHROME_WS_PORT` or `--port=N` if you forward Chrome elsewhere.

**Linux/WSL2 tip:** For headed mode (visible browser), the MCP server needs the `DISPLAY` environment variable. If `show_browser` doesn't work, configure `"env": {"DISPLAY": ":0"}` in your MCP server config. See [mcp/README.md](mcp/README.md#linuxwsl2-headed-mode) for details. Running as root or inside a container is detected automatically and disables Chrome's sandbox; on a headless box add `CHROME_EXTRA_ARGS="--headless=new --disable-gpu"`.

**Custom Chrome flags:** Set `CHROME_EXTRA_ARGS` to a whitespace-separated list of flags that will be appended to the Chrome command line on launch. Useful for headless containers that need software WebGL:

```
CHROME_EXTRA_ARGS="--use-gl=angle --use-angle=swiftshader-webgl --enable-unsafe-swiftshader"
```

## Windows Verification (November 7, 2025)

- `node skills/browsing/chrome-ws start` launched Chrome with remote debugging enabled on a fresh Windows 11 Pro install.
- `node skills/browsing/chrome-ws tabs` and `node skills/browsing/chrome-ws navigate 0 https://example.com` confirmed CLI control with the IPv4 default binding.
- `codex exec -c "mcp_servers.superpowers-chrome.enabled=true" "List Chrome tabs via MCP to verify the Windows override patch."` listed the Example Domain tab through the MCP server, demonstrating that the overrides also work through Codex.

## Commands

- **Setup**: `start` (auto-detects platform)
- **Tab management**: `tabs`, `new`, `close`
- **Navigation**: `navigate`, `wait-for`, `wait-text`
- **Interaction**: `click`, `fill`, `select`
- **Extraction**: `eval`, `extract`, `attr`, `html`
- **Export**: `screenshot`, `markdown`
- **Raw protocol**: `raw` (full CDP access)

## Dialog Handling

Pages that open JavaScript dialogs (`alert`, `confirm`, `prompt`, `beforeunload`), WebUSB/Bluetooth/Serial/HID device choosers, HTTP basic-auth challenges, or permission prompts (camera, microphone, notifications, geolocation, clipboard) no longer wedge the connection. The dialog is surfaced as a synthetic page response and the agent interacts with it using the existing `click` and `type` actions against a small `dialog::*` selector grammar.

### What an agent sees

While a dialog is open, any page-targeted action (`extract`, `screenshot`, `eval`, `attr`, `click <real-selector>`, etc.) returns a clear refusal with the dialog content and instructions:

```
Page is behind a dialog. Handle dialog::accept or dialog::dismiss first.

# Dialog: confirm
Tab origin: https://example.com

> Are you sure you want to leave?

Buttons:
  - dialog::accept   (OK)
  - dialog::dismiss  (Cancel)

To interact:
  click selector="dialog::accept"
  click selector="dialog::dismiss"
```

Browser-targeted actions (`list_tabs`, `new_tab`, `close_tab`, etc.) pass through unaffected.

### Selector grammar

| Selector | Purpose |
|---|---|
| `click dialog::accept` | OK / Grant / Provide credentials, depending on dialog kind |
| `click dialog::dismiss` | Cancel / Deny |
| `type dialog::prompt <value>` | Stage prompt text; commit on `dialog::accept` |
| `click dialog::device[id="…"]` | Pick a device in the chooser (USB, BT, Serial, HID) |
| `type dialog::username <value>` / `type dialog::password <value>` | Basic-auth credentials |

### Worked example

```
# 1. Page on load: alert('Saved!')
extract payload=text
# → refused with synthetic dialog markdown

# 2. Dismiss
click selector="dialog::accept"

# 3. Page is interactive again
extract payload=text
# → returns the page text
```

Permission prompts (`getUserMedia`, `Notification.requestPermission`, geolocation, clipboard) are caught by a `document_start` JS-API shim and surfaced through the same flow.

See `docs/superpowers/specs/2026-05-13-dialog-handling-design.md` for the full design.

## MCP Server Mode

Ultra-lightweight MCP server with a single `use_browser` tool. Perfect for minimal context usage with automatic page captures.

### Installation Options

**Option 1: NPX from GitHub (Recommended)**
```json
{
  "mcpServers": {
    "chrome": {
      "command": "npx",
      "args": [
        "github:obra/superpowers-chrome"
      ]
    }
  }
}
```

**Option 1b: NPX with Headless Mode**
```json
{
  "mcpServers": {
    "chrome": {
      "command": "npx",
      "args": [
        "github:obra/superpowers-chrome",
        "--headless"
      ]
    }
  }
}
```

**Option 2: Git Clone + Local Path (Current)**
```bash
git clone https://github.com/obra/superpowers-chrome.git
cd superpowers-chrome/mcp && npm install && npm run build
```
```json
{
  "mcpServers": {
    "chrome": {
      "command": "node",
      "args": [
        "/path/to/superpowers-chrome/mcp/dist/index.js"
      ]
    }
  }
}
```


### Auto-Capture Features

DOM-changing actions (navigate, click, type, select, eval) automatically capture:
- **Page HTML**: Full rendered DOM state
- **Page Markdown**: Structured content extraction
- **Screenshot**: Visual page state
- **DOM Summary**: Token-efficient page structure
- **Session Organization**: Time-ordered captures in temp directory

Pages showing credential-shaped content are not captured; see [Credential-shaped pages](#credential-shaped-pages).

Response format:
```
→ https://example.com (capture #001)
Size: 1200×765
Snapshot: /tmp/chrome-session-123/001-navigate-456/
Resources: page.html, page.md, screenshot.png, console-log.txt
DOM:
  Example Domain
  Interactive: 0 buttons, 0 inputs, 1 links
  Layout: body
```

### Credential-shaped pages

When a page shows credential-shaped content, auto-capture writes **no files** for that action and the response carries only metadata (URL, size, element counts, layout) plus a `⚠️ Page shows credential-shaped content; auto-capture and DOM output suppressed.` line. No markdown, headings, title, or DOM diff is returned. This covers Slack tokens (`xox[abposr]-`, `xoxe.`/`xoxe-`, `xapp-`), GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`), 1Password service-account tokens (`ops_eyJ…`) and Secret Keys (`A3-…`), `otpauth://` URIs carrying a `secret=`, and any page containing an element with the `data-sen-secret` attribute (for secrets with no distinctive shape, like backup codes; see below for what marking does not cover). The check covers the HTML, the rendered markdown, the DOM summary, the page's rendered text (`innerText`, which joins a token split across inline spans), open shadow roots, and live `input`/`textarea` values. It runs after the screenshot, and any match deletes every artifact already written for that action, so a token revealed while the capture runs doesn't survive in the PNG. It can't see inside closed shadow roots or cross-origin iframes.

In addition, every `use_browser` result and error has credential-shaped substrings replaced with `[REDACTED credential-shaped]`, and `screenshot` refuses on such a page.

### The `data-sen-secret` marker: an accident guard, not a boundary

Mark an element with the `data-sen-secret` attribute (via `set_attr`) when it holds a secret with no distinctive shape — a bare base32 TOTP seed, a backup code — that the credential-shape check above can't recognize. **When to mark:** as soon as the action that revealed the secret returns, before any other action on that page, then capture the value with the credential broker. Marking only affects actions after it: the capture files the revealing action already wrote (typically its `NNN-navigate.html`/`.md` or `NNN-click.html`/`.md`) still hold the value, and marking does not delete them. Once marked:

- `eval` refuses outright, page-wide, if ANY element on the page currently carries `data-sen-secret` — checked against the live DOM immediately before the expression runs. This is a **point check at the moment of the call**: it does not remember that the page was ever marked, and it does not re-check after the expression finishes. `extract` and `attr` with a selector naming a specific ELEMENT refuse when the resolved element **or any ancestor of it** (through shadow-root hosts) is marked; where that element-scoped read doesn't require touching the marked value at all (`extract`'s HTML form on a selector), it instead reads off a clone imported into a fresh, inert document with marked descendants stripped, rather than refusing over one marked corner of the element it was asked for. A WHOLE-PAGE read — no selector, or a selector that RESOLVES to the whole document (see "Explicit reads on a sensitive page" below for exactly which selectors that covers), on `extract`'s text/HTML/markdown forms — refuses outright instead of stripping, the moment ANY element anywhere on the page carries the marker (see "Explicit reads on a sensitive page" below): stripping only removes DESCENDANTS of the clone's root, so a marker on `document.body` itself (or a page-level container above wherever the clone-and-strip read starts) would otherwise still leak. Screenshot and auto-capture use the same live scan, extended to open shadow roots and same-origin `iframe`/`frame`/`object`/`embed`, and write nothing to disk for a marked page from then on.
- **This is not a security boundary.** `eval` runs arbitrary JavaScript in the exact same JS realm as the marked element — it can read the value directly, `fetch()` it to another origin, stash it in `window.name` or storage for another tab, or erase the marker with `removeAttribute` as its own last step, and no in-page check can close any of that. Same-origin `fetch`, another browser tab, and page JavaScript that moves the value out from under the marked element can all still reach it regardless of marking. **Don't mark an element and then run `eval` on that page expecting the secret to stay contained** — after marking, use the credential broker for the value and `set_attr` for writes.
- Native dialog (`alert`/`confirm`/`prompt`/`beforeunload`) text keeps only the credential-**shape** redaction and file suppression described above; a marked-but-shapeless value in dialog text is not specially caught, for the same reason `eval` isn't a boundary.
- Not covered either: capture files written before the mark (see "When to mark" above), and markup inside an `<iframe srcdoc="…">` attribute. `extract`'s HTML form and `attr srcdoc` return that attribute text verbatim, so a marked element written into `srcdoc` comes back with it, even though the live scan sees the loaded frame and `eval` refuses.

`set_attr` is a separate, write-only action exempt from all of the above: it takes no caller JavaScript (values travel as CDP call arguments, never as code text), and can write exactly two attribute names — `data-sen-nonce` (a broker nonce, deliberately not any other `data-*`/`aria-*` name, since page JS and frameworks routinely wire arbitrary ones to behavior) and `data-sen-secret` itself, the write path for the marker. Writing `data-sen-nonce` resolves to the single first-VISIBLE match, the same way `extract`/`click`/`type` resolve a selector, and refuses if that element is already marked. Writing `data-sen-secret` instead marks **every** element the selector matches, hidden duplicates included, and can never remove or weaken an existing mark — re-marking an already-marked element is a no-op, not a refusal. `set_attr`'s different outcomes (`ok` / `no element matched` / `refused: target element is marked`) are themselves a limited prefix oracle over what's on the page for a caller who can vary the selector and watch which one comes back; this is a known, accepted limitation, not something the guard closes.

Set `SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE=1` to restore the old, unguarded behavior when debugging your own browser.

Separately, whatever auto-capture *does* write to disk (`.html`, `.md`, and `-diff.txt`) is redacted by both attribute and value. A plain password or 6-digit code has no shape the credential-shape check above recognizes, so it wouldn't otherwise be caught when a page's own JavaScript mirrors it into an attribute, a hidden input, or visible text.

- **Which fields count:** `input[type="password"]` (case-insensitive, and remembered on that same element after a "show password" toggle switches its type to `text`), any field whose `autocomplete` contains `current-password`, `new-password`, `one-time-code`, `cc-number`, or `cc-csc` (case-insensitive substring match, so `autocomplete="section-2fa one-time-code"` still matches), any `data-sen-secret`-marked element, and any `input`/`textarea` whose live `.value` exactly matches one of its own OTHER attributes (a self-mirror, found by comparing values, not by a fixed attribute-name list — this is how a field with no recognized type or autocomplete, like Google's 2-step verification `totpPin` field mirroring the typed code into `data-initial-value`, still gets caught). Self-mirror detection skips inputs nobody types into (`submit`, `button`, `reset`, `checkbox`, `radio`, `hidden`, `image`) and does not compare against attributes that name or label a field (`type`, `name`, `id`, `aria-label`, `title`, `placeholder`, `for`, `class`), so a submit button whose value matches its `name` or `aria-label`, or a radio whose value matches its `id`, is not treated as a secret. The rest of the `cc-*` family (`cc-exp-month`, `cc-exp-year`, `cc-name`, `cc-type`, ...) is not included.
- **Attribute stripping:** an inert clone of the page (`document.implementation.createHTMLDocument` + `importNode`, never `cloneNode` on the live document, so no resource re-fetch and no handler re-fires) has `value` and every `data-*`/`aria-*` attribute removed from fields matched by type/autocomplete/marker. This applies at any value length. A field found only by self-mirror has no selector to re-match on the clone, so its attribute NAME is not stripped this way — only its value, by the redaction pass below (floor applies).
- **Value redaction:** the live `.value` of each of those fields (what was typed, not just the `value` attribute), plus its HTML-entity-escaped forms (an attribute value escapes `& " < >` and U+00A0 as `&nbsp;`; text content escapes `& < >` and U+00A0), is replaced with `[REDACTED]` wherever it appears in the `.html`/`.md`/`-diff.txt` output — any attribute, on any element, not just the field's own `value`. This catches a mirror onto a different element, a different attribute (`title`, `aria-*`, `data-*`), or echoed text. Only values of at least 4 characters are redacted this way, or at least 3 for `cc-csc` (most card security codes are three digits). Dialog captures (`alert`/`confirm`/`prompt` text written to `.md`/`.html`) are redacted with the values from the most recent capture in this MCP session (which may have been on another tab), since a page can't be read while a dialog is open; a value typed in the same action that opened the dialog was never seen by a capture and is not redacted there.
- **Side effect:** value redaction is a plain string replace over the serialized capture, not a structural edit. A secret that also occurs as ordinary page text or markup (a password of `password`, a 4-digit code matching a year) replaces those occurrences too, for example `type="[REDACTED]"`. That degrades the artifact but leaks nothing. The same happens when self-mirror detection flags a non-secret field: a text field, search box, or textarea whose value equals one of its own attributes outside the excluded list above (a page that syncs a search query into `data-query`, or a prefilled field with a matching `data-default` or `aria-description`) has that value replaced across the capture if it is at least 4 characters.
- **Known gaps:** these still write the secret to disk. (1) Split one-digit OTP boxes that a page joins into an aggregate hidden input: each digit is below the length floor, so the aggregate is written in clear. (2) A field cleared on submit whose mirror remains: the field no longer has a value to redact, so the mirror is written in clear. (3) A "show password" toggle that swaps in a new element instead of changing `type`: the new element was never a password input, so its value is not redacted. (4) A self-mirrored value shorter than the length floor: the field is still found (self-mirror detection has no floor of its own), but its value is too short to substring-redact, so the mirror is written in clear. Screenshots (`.png`) are pixels, not scrubbed text, so a *visible* typed value (e.g. a `type="text"` one-time code) can show up in a screenshot.

### Default secret-pattern detection (no marking, no click required)

Everything above depends on a field having a recognized type/autocomplete, or having already mirrored a typed value somewhere — neither helps a secret that is already sitting in the DOM the moment the page loads, before any action has run at all (and so before any `data-sen-secret` marking could happen either: marking can only happen AFTER the action that reveals a value returns). Real case: Slack's 2FA setup page (`/account/settings/2fa_app`) renders the TOTP seed into a hidden `#init_key_code` element from the moment the page loads, so the very first auto-capture of that page — before any click, before any marking could happen — would otherwise write the raw seed to disk.

- **Which elements match:** any element whose `id`, `name`, `class`, `autocomplete`, or `aria-label` contains one of `secret`, `totp`, `otp`, `2fa`, `mfa`, `key_code`, `seed`, `recovery`, `backup_code`, `api_key`, `token` as a WORD — split on `-`, `_`, camelCase and whitespace into segments, not a raw substring match. A raw substring test also matched `otp` inside `footprint` (those three letters just happen to run together) and `token` inside a `token-list`/`tokens-table` id (a page section that lists token NAMES/metadata, not a token VALUE); neither of those match now. A bare CSRF/auth-token field (`csrf-token`, `authToken`) is still an accepted, documented false positive — see `skills/browsing/lib/secret-pattern.js`.
- **Value-bearing matches** (`input`/`textarea`/`select`) are treated exactly like any other sensitive field above: unioned into the same value-collection and redaction pass, same length floor.
- **Leaf matches** (an element with no element children of its own — a `<span>`, `<div>`, `<code>`, ... holding the secret as plain text, the shape of Slack's `#init_key_code`) have their own text content blanked directly in the capture, by element reference, **regardless of length**. This is NOT fed into a document-wide substring replace: an earlier version of this defense collected that text into the same redaction set used for typed field values, which corrupted unrelated page content whenever the matched text happened to be a common word — a Prism.js syntax-highlighted `<span class="token keyword">class</span>` (an expected match: Prism literally uses `token` as a CSS class name) turned every `class="..."` attribute on the page into `[REDACTED]="..."` once its own text ("class") was redacted everywhere. Each matched element's own text is still blanked; nothing else on the page is.
- **Wrapping containers** (an element WITH element children, e.g. `<div id="totp-secret">`) are fully blanked -- every direct text-node child, and of every non-control descendant recursively, replaced with `[REDACTED]` -- only when the match is STRONG: an exact compound secret name (`totp-secret`, `secret-key`, `recovery-codes`, `backup-codes`, `api-key`, `private-key`, `key-code`, ...) and the container's text is 2000 characters or fewer. This covers a secret split across element children -- `<div id="totp-secret">Key: <code>SEED</code></div>` and `<ul class="recovery-codes"><li>CODE</li></ul>` both leak the secret in clear without it, because the container itself has element children and is otherwise skipped. A WEAK match (a single broad word like bare `token`/`secret`, e.g. a design-system class `sn-token-provider` or a docs landmark `<section id="module-secrets">`) does not blank its container wholesale -- doing so wiped real page content in testing (a docs "Get started" paragraph, a module's own description) for no security benefit, since neither example holds an actual secret. A weak container's own attributes are still stripped, and any descendant that independently matches (its own id/class, any strength) is still found and blanked on its own, the same way it would be anywhere else on the page -- only the "redact everything nested inside, regardless of what it is" behavior is withheld. 2000 characters covers a realistic secret-setup widget (a seed/QR caption plus a few short instructions) with headroom; a real docs section or landmark is realistically tens of KB.
- **Button and link elements (and anything nested inside one) are never text-blanked**, even when matched or inside a matched container: a control's own visible text is a UI label ("Copy"), not the secret it operates on, even when its `id` references one (`copy-seed-btn`, `reveal-totp-link`). Its attributes are still stripped, before this exemption is checked -- an earlier version of the code checked the exemption first and skipped attribute-stripping for a skip-tag control entirely, so a copy button's `data-clipboard-text` (holding the same secret) survived. `label`/`summary`/`legend`/`option` are **not** exempt -- an earlier version of this code also skip-blanked those, but a `<label>` wrapping a matched leaf is routinely the *only* place a secret is rendered at all, so their own text is blanked and blankMatchedSubtree recurses into them like any other element.
- **An `otpauth://` URI is redacted unconditionally, wherever it appears** -- an `<a href>`, an `<img src>`, a `data-*` attribute, visible text, or a QR image's `alt`/`title` -- regardless of whether the carrying element also matches the word-boundary detector above. The URI scheme itself is self-describing as a TOTP/HOTP provisioning credential, needing no id/name/class signal. `href` in particular was leaking entirely unscrubbed before this.
- **The Markdown artifact (`.md`) gets the same redaction**, independently: it is generated by walking the live DOM directly (not through the HTML clone above), so it runs its own pass of the identical word-boundary detector and the same strong/small-container rule above. Unlike a simple ancestor check, this redaction also finds a pattern-matched element sitting INLINE inside an emitted block -- `<p>Your setup key: <code id="totp-secret">SEED</code></p>` -- by walking each block's own subtree rather than flattening it via `textContent`; a plain ancestor-only check would emit the paragraph's full flattened text (including the secret) before the nested `<code>` ever got its own, separate turn. Links (`<a>`) are excluded the same way they are above.
- **Known false-positive class, accepted and documented rather than narrowed away:** a bare `token` (as its own word) is broad enough to also match an ordinary CSRF token field. This only blanks a value/text on the disk copy -- it never removes an element or touches the live page.

### URL-based suppression

A second, orthogonal defense, independent of what the page's markup looks like: a page whose URL matches a known-sensitive pattern — `/2fa`, `/two_factor`, `/two-step`, `/mfa`, `/totp`, `/security/keys`, `security-keys`, `/recovery-codes`, `/backup-codes`, `login-verification`, `security-info` — has its html/md body capture **and its screenshot (including an explicit `screenshot` action, not just auto-capture)** suppressed outright, the same way a credential-shaped page is (`credentialSuppressed: true`, with a distinct "Page URL matches a known-sensitive pattern" notice instead of the credential-shape one). This catches a secret with no recognized attribute naming and no token shape at all (a bare seed, a QR code), purely from the page it's on — Slack's 2FA setup page is suppressed this way even if nothing on it happened to match the pattern detection above.

Matched against the URL's **pathname and hash**, never its query string, and only for a URL whose pathname is a real page location (http(s):, file:, and similar) -- never for `data:`, `blob:` or `about:` URLs, whose "pathname" is not a path at all (a `data:` URL's pathname IS its percent-encoded document body, so a page that merely mentions a sensitive word in its own title/markup would otherwise false-match on itself). A hash-routed single-page app (e.g. the AWS console's `#/security_credentials/mfa` MFA route) puts its real "page" entirely after the `#`, with nothing to match in the pathname alone -- the hash is included for exactly that case. The query string is deliberately excluded: matching it over-suppressed an ordinary `/login?next=/settings/2fa` redirect, whose NEXT-page target happens to mention "2fa" in a value that was never the current page at all. `mfa` is anchored to path/hash segment boundaries -- an unanchored `/mfa` also matched `/docs/mfa-best-practices`, a docs page ABOUT mfa, not an MFA page. `/2fa`, `/totp`, `security-keys` and `security-info` are anchored on the open (right-hand) side with a word-boundary check instead of a full segment anchor: they match a whole segment (`/settings/2fa`) or a segment PREFIX followed by a non-alphanumeric separator or end of string (`/2fa_app`, `/2fa/setup`), but not a prefix glued directly to more letters with no separator at all (`/2fast`, `/totpal`, `/security-keyset-docs` no longer match). `/two-factor`/`/two_factor` is left fully unanchored on its suffix side: real setup routes need the open suffix (GitHub's `/settings/two_factor_authentication/setup/intro`, GitLab's `/-/profile/two_factor_auth`, 1Password's `/settings/two-factor-authentication`), and segment-anchoring it the same way `mfa` was anchored silently broke all three of those real routes in an earlier version of this fix.

`SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE=1` disables this suppression (for auto-capture AND an explicit `screenshot` action) the same way it disables the credential-shape guard elsewhere. Configurable via `SUPERPOWERS_CHROME_SENSITIVE_URL_PATTERNS`: a comma-separated list of extra regexes (case-insensitive), **added to** the defaults, never a replacement — a misconfigured or empty value can only widen suppression, never narrow it back to nothing.

A second, smaller list is matched against **hostname + pathname + hash** together, not pathname alone: `api.slack.com/apps/<id>/general` (Slack's App-Level Tokens page), `github.com/settings/tokens` and `github.com/settings/personal-access-tokens` (GitHub's personal access token pages), `myaccount.google.com/apppasswords` (Google's App Passwords page), and `linear.app/settings/account/security` (Linear's personal API keys page). These need the hostname because the path alone — "apps"/"general"/"tokens" — is far too ordinary a word to accept matching on any site the way `/totp` or `backup-codes` are; paired with the host that actually serves them, each is a real page that shows a secret value once.

The live page is never touched by any of this: the fields the browser actually uses, and the page's own image/resource loads, are unaffected.

### Explicit reads on a sensitive page (`eval`/`extract`/`attr`)

Everything above governs what auto-capture and `screenshot` write to disk. It does NOT govern what an explicit `eval`, `extract`, or `attr` call returns to the caller — those are reads the caller asked for, but the real incident this closes is exactly that: a worker's `eval`/`extract` reading backup codes or a session token off a sensitive page straight into its own transcript, before the value was ever captured through the credential broker.

A page counts as **sensitive** here when ANY of three independent signals fires: the URL matches the known-sensitive pattern list above (which now also includes the host-qualified entries — Slack's App-Level Tokens page, GitHub's/Google's/Linear's own token pages — described there), a live `data-sen-secret` marker is present anywhere on the page, or the page's own visible text looks like a dense list of secret-shaped codes (six or more distinct, similarly-sized alphanumeric tokens clustered together, with a nearby backup/recovery-style cue off the URL list — see below) — catches a recovery/backup-code list or bare-digit TOTP codes that have no fixed token shape, even on a page the URL list doesn't cover.

- **Whole-page EXTRACT reads are always refused on a sensitive page, regardless of content.** `extract` with no selector, `extract`/`attr` with a selector that RESOLVES to the whole document, and `extract`'s markdown form all refuse outright before running, the same way `screenshot` already does for a sensitive URL. A selector "resolves to the whole document" when the element it matches is `document.documentElement`, `document.body`, or contains `document.body` — covers `body`, `html`, `:root`, `*` (whose first match is `<html>`), `html > body`, and any other spelling of the same scope, not just the literal strings `body`/`html`. The refusal message points at a narrower, element-scoped read instead — a particular button, status message, or error-banner selector — and at the credential broker for the value itself. `eval` is handled differently — see below.
- **`eval` is the one exception: it RUNS on a sensitive page, then its RETURN VALUE is checked before anything is handed back** (round 4, superseding an earlier version of this gate that refused `eval` outright the same way `extract` does). Numbers, booleans, `null` and `undefined` always pass through unconditionally. Every string in the result — recursively, for an object or array `eval` returns — is checked against four rules, and the WHOLE result is refused if any string matches any rule: (1) an existing credential shape (`xoxb-`/`ghp_`/`xapp-`-style, with a realistic minimum length); (2) a bare, known token PREFIX with no minimum length, so a value truncated down to just its prefix (`el.value.slice(0,8)`) still names itself even though it no longer matches rule 1's full-shape pattern; (3) the code-list density signal — density ALONE is enough on a page already flagged sensitive by its URL, since that page is already known to be the kind that might show one; (4) a bare alphanumeric run of 6+ characters that MIXES letters and digits, after stripping ALL whitespace (catches an unprefixed TOTP/HOTP seed, even one deliberately broken into spaced groups like `JBSW Y3DP EHPK 3PXP`; an all-digit or all-letter run of 6+, however long, is exempt — an ordinary DOM identifier like Slack's own `app_level_tokens_row_<id>` data-qa value is not a secret). A live `data-sen-secret` marker still refuses `eval` BEFORE it runs, same as before — unlike the other three signals, the marker is a live-DOM-only fact that is already gone by the time `eval` produces a plain result to inspect, so there is nothing left for a post-hoc check to find.
- **Element-scoped `extract`/`attr` reads use the SAME four rules as `eval`'s result, with a different split.** Rule 1 (full-shape token) and rule 3 (code-list density -- bare, no keyword needed) apply UNCONDITIONALLY, any URL -- this is #65's own original element-scoped behavior, since a real, caller-chosen selector is already a much narrower, more deliberate target than a whole page. Rules 2 (bare token prefix) and 4 (mixed alnum run) apply ONLY when that element's own page is already on the sensitive-URL list, same as `eval`. Round 6 (jc): rules 2/4 applying everywhere refused ordinary text on every page (a library name containing `sk-`, a version number or date next to a word) -- gating them to the sensitive-URL list, same as `eval` already did, fixed that without weakening the signal where it matters. Rule 4 was ALSO narrowed at the same time: it no longer strips all whitespace before scanning (that's what glued "2026" onto an adjacent word); it now only re-joins a seed deliberately split into display groups (uppercase base32, 4-character groups, 3+ of them) -- a value that's ALREADY one contiguous mixed run in the original text (a commit hash, say) still matches either way.
- **Off the sensitive-URL list, a lone token-shaped value is NOT a whole-page refusal signal** (a brief, later-reverted version of this gate added one): it false-positived on a real, unlisted page that legitimately prints example token strings to explain their format (Slack's own token-types documentation). The existing, separate, unconditional output-level redaction (every `use_browser` response has credential-shaped substrings masked before it reaches the agent, regardless of any of this) still catches a token that reaches the final text this way.
- **No agent-settable override.** `SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE=1` still disables this the same way it disables every other guard above, because it already was operator-only before this existed: it's read once from the MCP server process's own environment at startup. Nothing reachable from a `use_browser` call can set or see it — there is no action that writes to it, and `eval`'s expression runs in the BROWSER PAGE's own JS realm over CDP (a different process from the MCP server), which has no Node `process` global to reach it through in the first place.

### Pause switch for an unrecognized reveal

Everything above only catches a secret with a recognized shape, an opt-in `data-sen-secret` mark, or a known-sensitive URL. A page that reveals a secret some other way — a "show password"/"reveal" click or a password-reset dialog that renders the plaintext into an ordinary element with no secret-looking id/name/class and no sensitive URL (real case: the Google Admin console's reset-password flow renders the generated password into a plain `div`) — slips past all three defenses, and the very next auto-capture writes it to disk.

`pause_capture` suspends every automatic capture — DOM/markdown/screenshot/console-log/synthetic-dialog artifacts — for the rest of the session; `resume_capture` restores it. Call `pause_capture` immediately before the action you expect to reveal the secret: the action itself still runs (nothing about pausing stops it), only the capture that would normally follow it is skipped — no CDP call to read the page is even made. An explicit `screenshot` action also refuses outright while paused, with a message pointing at `resume_capture`, rather than silently taking and discarding the shot. Pause state lives on the session and persists across actions until `resume_capture` is called: forgetting to resume just means no more captures for the rest of the session, never a silent leak. **Caveat:** this is in-memory, process-local state, so it does NOT survive the MCP server process restarting — only `restart_chrome` re-adopting the same still-running Chrome within the same server process. If the server itself restarts while a secret from a paused reveal is still on-screen, the next auto-capture comes back unpaused; the pause notice disappearing from responses is the only signal. Capture the value itself with the credential broker, then call `resume_capture` as soon as the secret is off-screen.

### Usage

```json
{
  "action": "navigate",
  "payload": "https://example.com"
}
```

Get help: `{"action": "help"}` - Returns complete documentation

See [mcp/README.md](mcp/README.md) for complete documentation.

## When to Use

**Use Skill Mode when:**
- Working with Claude Code agents
- Need full CLI control with 17 commands

**Use MCP Mode when:**
- Using Claude Desktop or other MCP clients
- Want minimal context usage (single tool)

**Use Playwright MCP when:**
- Need fresh browser instances
- Complex automation with screenshots/PDFs
- Prefer higher-level abstractions

## Documentation

- [SKILL.md](skills/browsing/SKILL.md) - Complete skill guide
- [EXAMPLES.md](skills/browsing/EXAMPLES.md) - Real-world examples
- [chrome-ws README](skills/browsing/README.md) - Tool documentation

## License

MIT
