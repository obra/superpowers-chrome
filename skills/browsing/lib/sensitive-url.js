/**
 * URL-based sensitive-page suppression.
 *
 * Some pages render an actual secret -- a TOTP seed, a QR code, a list of
 * one-time recovery/backup codes -- directly into the DOM, or onto the
 * screen, from the moment they load. That secret can have no distinctive
 * attribute naming (so page-scripts/html-with-scrub.js's default
 * secret-pattern heuristics miss it) and no token shape
 * credential-guard.js's containsCredentialShaped can recognize (a bare
 * base32 seed is not a Slack/GitHub/1Password token, and a QR code is
 * pixels, not text). Real case: Slack's 2FA setup page
 * (https://*.slack.com/account/settings/2fa_app) shows the TOTP seed from
 * the moment it loads.
 *
 * This module is a second, orthogonal defense, independent of what the
 * DOM looks like: a known-sensitive URL PATH (or hash-routed-SPA
 * fragment) is suppressed outright, the same way a credential-shaped page
 * is -- no html/md body capture, no screenshot -- regardless of whether
 * the page happens to name anything in a way the other detector would
 * catch. Belt and suspenders: either signal alone suppresses; neither
 * depends on the other.
 *
 * Matched against the URL's pathname AND hash (never the query string):
 *   - pathname + hash, because a hash-routed single-page app (no full page
 *     load per route) puts its real "page" entirely after the `#` -- e.g.
 *     the AWS console's MFA route is
 *     `console.aws.amazon.com/iam/home#/security_credentials/mfa`, with an
 *     empty pathname-equivalent and everything that matters in the hash.
 *   - NOT the query string. It was matched here in an earlier version of
 *     this module, on the theory that a single-page-app tab parameter
 *     (`?tab=security-keys`) deserved the same treatment as a path
 *     segment. In practice this over-suppressed: `/login?next=/settings/2fa`
 *     is an ordinary login redirect whose NEXT-page target happens to
 *     mention "2fa" in a query value that was never the current page at
 *     all. A query string can carry nearly arbitrary data (a return URL,
 *     a search term, a referrer) that says nothing about what the CURRENT
 *     page renders, unlike a path segment or hash route.
 *
 * Most default patterns are anchored to path/hash SEGMENT boundaries
 * (`(^|/)word(/|$)`) rather than tested as a raw substring, for the same
 * reason: an unanchored `/mfa` prefix also matched `/docs/mfa-best-practices`,
 * a docs page ABOUT mfa, not an MFA enrollment/challenge page -- the word
 * has to be its own path segment, not merely a prefix of a longer,
 * unrelated slug. `mfa` is the only word anchored this strictly (a full
 * segment anchor), because it is the only one an over-suppression report
 * named outright. `/2fa`, `/totp`, `security[-_]?keys` and
 * `security[-_]?info` get a WORD-BOUNDARY anchor instead (round 4): a
 * negative lookahead/lookbehind against a following/preceding
 * letter/digit (`(?![a-zA-Z0-9])`, `(?<![a-zA-Z0-9])`) -- a real
 * boundary check, not a full segment anchor, so `/2fa_app`/`/2fa/setup`
 * (segment PREFIX + a real separator) still matches but `/2fast`/
 * `/totpal`/`/security-keyset-docs` (letters glued on with no separator
 * at all) no longer do. `/two[-_]?factor` is deliberately left fully
 * UNANCHORED on its suffix side, with no word-boundary check either:
 * real setup routes need it -- GitHub's
 * `/settings/two_factor_authentication/setup/intro`, GitLab's
 * `/-/profile/two_factor_auth` and 1Password's
 * `/settings/two-factor-authentication` all have "two_factor"/"two-factor"
 * immediately followed by more slug, not a "/" or end of string, same as
 * Slack's `/account/settings/2fa_app`. (`two[-_]?factor` WAS segment-
 * anchored for one round, which silently broke all three of those real
 * routes -- the anchoring fix for "mfa" does not generalize to every
 * word without checking real routes first.) `two[-_]?step` and
 * `login[-_]?verification` are also left fully unanchored: they are
 * expected to show up as part of a longer slug (Google's own
 * `/two-step-verification` route), not necessarily as a path segment or
 * word-bounded token of their own.
 *
 * Only matched for a URL whose `pathname` is a real page location
 * (http(s):, file:, and similar) -- never for `data:`, `blob:` or
 * `about:` URLs. A `data:` URL's `pathname` IS the percent-encoded
 * document body (a `<title>` or any other markup), not a path, so a
 * page that merely TALKS ABOUT a sensitive topic in its title/body --
 * unrelated to whether the fixture itself renders a secret -- would
 * otherwise false-match on that text; this is exactly how the real-
 * Chrome `#init_key_code` end-to-end test's OWN fixture title ("Set up
 * two-step verification") previously self-triggered suppression via the
 * unanchored `two[-_]?step` pattern. `blob:`'s pathname is an opaque
 * inner reference and `about:`'s is a fixed handful of browser-internal
 * names; neither is a page location either.
 *
 * Case-insensitive throughout -- same philosophy as credential-guard.js
 * and html-with-scrub.js: a missed match is a leak, an extra match only
 * suppresses a capture that would otherwise have been harmless. Never
 * touches the live page -- this only ever decides what gets written to
 * disk.
 *
 * PRI-3360 addendum: this module now also gates explicit, caller-
 * requested WHOLE-PAGE text reads (eval, a selector-less extract, extract/
 * getSanitizedHtml on an element that resolves to the whole document, and
 * the index.ts markdown branch) via pageTextReadRefused below -- see its
 * own doc comment. The URL-pattern check above (urlLooksSensitive) is one
 * of three signals that gate now consults; the other two (a live
 * data-sen-secret marker, and the code-list density heuristic) live in
 * secret-marker.js and code-list-detector.js respectively and are pulled
 * in here only for that orchestration, not duplicated. Round 2 (jc review
 * of #65): whether a SELECTOR counts as whole-page is now decided by
 * resolving it in the page and checking the resulting ELEMENT
 * (extraction.js's resolveIsWholePage), not by matching the selector
 * STRING against a `body`/`html` literal list -- see extraction.js for
 * why (`:root`, `*`, `html > body`, etc. all resolve to the same scope
 * but don't match that literal list).
 *
 * PRI-3360 round 3 (Reeve), confirmed in round 4: Slack's App-Level
 * Tokens page, GitHub's personal access token pages, Google's App
 * Passwords page, and Linear's personal API keys page JOIN this same
 * sensitive-page set -- urlLooksSensitive below is the ONE function every
 * caller (the read gate below AND capture.js's write-side suppression)
 * ever consults, with no separate "capture-only" category. They live in
 * DEFAULT_SENSITIVE_HOST_PATH_PATTERNS, a SECOND list matched against
 * HOSTNAME + pathname + hash together, not pathname alone, purely
 * because the PATTERN SHAPE needs the extra qualifier, not because the
 * SIGNAL means anything different once matched. Every pattern in
 * DEFAULT_SENSITIVE_URL_PATTERNS above is deliberately domain-agnostic --
 * "backup-codes", "totp", "security-keys" are distinctive enough on
 * their own that matching them on any site is an accepted, documented
 * trade-off (a missed match is a leak; an extra match only suppresses a
 * harmless capture). A path segment like "apps" or "tokens" is NOT
 * distinctive enough to accept that trade domain-agnostically -- "apps"
 * alone matches any app marketplace/directory, "tokens" alone matches
 * any page that manages API tokens without necessarily ever displaying
 * one in cleartext. These are real, specific pages that DO show a
 * secret, but only paired with the host that serves them --
 * urlLooksSensitive checks both lists and returns one combined
 * true/false; nothing downstream of it can tell, or needs to tell, which
 * list actually matched.
 */
const { throwIfExceptionDetails } = require('./cdp-utils');
const { credentialCaptureAllowed } = require('./credential-guard');
const { pageHasSecretMarker } = require('./secret-marker');
const { codeListNearBackupKeyword, visibleTextFnSrc } = require('./code-list-detector');

const DEFAULT_SENSITIVE_URL_PATTERNS = [
  // Anchored on the LEFT by the literal "/" (always true for any path
  // segment start) and on the RIGHT by a negative lookahead against a
  // following letter/digit -- a word-boundary on the open suffix side,
  // not a full segment anchor. This matches a whole segment ("/settings/2fa")
  // or a segment PREFIX followed by a non-alphanumeric separator or end
  // of string ("/2fa_app", "/2fa/setup"), but not a prefix glued directly
  // to more letters with no separator at all ("/2fast"). See module
  // comment for why the suffix stays otherwise open (real routes like
  // Slack's /2fa_app and the accepted /blog/2fa-is-dead-style tradeoff).
  /\/2fa(?![a-zA-Z0-9])/i,
  // Unanchored, like /2fa above -- see module comment for the GitHub/
  // GitLab/1Password real routes this needs the open suffix for.
  /\/two[-_]?factor/i,
  // Google's /two-step-verification route is one hyphen-joined slug, not
  // its own path segment -- deliberately not anchored, like /2fa above.
  /two[-_]?step/i,
  // Segment-anchored, unlike every other word here: an unanchored "mfa"
  // prefix also matched "/docs/mfa-best-practices" -- see module comment.
  /(^|\/)mfa(\/|$)/i,
  // Same word-boundary-on-the-open-suffix-side treatment as /2fa above --
  // "/totpal" must not match "/totp".
  /\/totp(?![a-zA-Z0-9])/i,
  /\/security\/keys(\/|$)/i,
  // No slash requirement -- may appear as a hash anchor or mid-slug -- but
  // word-boundary on BOTH sides (neither side has a "/" to anchor on):
  // "/security-keyset-docs" must not match "security-keys".
  /(?<![a-zA-Z0-9])security[-_]?keys(?![a-zA-Z0-9])/i,
  /(^|\/)recovery[-_]?codes?(\/|$)/i,
  /(^|\/)backup[-_]?codes?(\/|$)/i,
  // AWS/Google-style account-recovery and login-challenge routes.
  /login[-_]?verification/i,
  // Word-boundary on both sides, same reasoning as security-keys above.
  /(?<![a-zA-Z0-9])security[-_]?info(?![a-zA-Z0-9])/i,
];

// Host-qualified patterns: see the module comment above for why these
// are kept separate from the domain-agnostic list -- the path segment
// alone, on any of these, is too ordinary a word to accept matching on
// any site. Matched against `hostname + pathname + hash`, case-
// insensitive like everything else in this file. Each entry documents
// the real page it targets and how its existence was confirmed.
const DEFAULT_SENSITIVE_HOST_PATH_PATTERNS = [
  // Slack's App-Level Tokens are shown on an app's "Basic Information"
  // page: api.slack.com/apps/<app id>/general (confirmed: api.slack.com
  // is Slack's own app-management host, and "general" is the Basic
  // Information tab's own route segment). "apps"/"general" alone are far
  // too generic (any marketplace/dashboard has an "apps" path; "general"
  // is a common settings-tab name) to match domain-agnostically.
  /^api\.slack\.com\/apps\/[^/?#]+\/general(?:[/?#]|$)/i,
  // GitHub personal access tokens: github.com/settings/tokens (classic)
  // and github.com/settings/personal-access-tokens (fine-grained) both
  // show a newly-created token's full value exactly once, directly on
  // this page. Confirmed live: both paths 302 to /login with a
  // return_to preserving the exact path (a real, routed page, not a
  // 404) -- github.com, 2026-10-09. Bare "tokens" is too generic to
  // match on any site (a changelog's "API tokens" blog post, a
  // completely unrelated "/settings/tokens" page elsewhere that never
  // shows a value).
  /^github\.com\/settings\/(?:tokens|personal-access-tokens)(?:[/?#]|$)/i,
  // Google's App Passwords page shows a newly-generated app password's
  // full value exactly once. Confirmed live: myaccount.google.com/
  // apppasswords 302-redirects to a Google sign-in page (a real,
  // routed page) -- 2026-10-09.
  /^myaccount\.google\.com\/apppasswords(?:[/?#]|$)/i,
  // Linear's personal API keys are managed under Settings > Security &
  // access, linear.app/settings/account/security, which shows a newly-
  // created key's full value once. Source: this exact path is linked
  // from Linear's own public developer docs (linear.app/developers/
  // graphql, "Personal API Keys" section) -- lower confidence than the
  // three above (not independently verified against a logged-in
  // session), kept anyway per this module's stated trade-off (a missed
  // match is a leak; an extra match only suppresses a harmless capture).
  /^linear\.app\/settings\/account\/security(?:[/?#]|$)/i,
  // 1Password's own service-account-token creation page almost
  // certainly has an equivalent -- NOT added here because its exact
  // path could not be confirmed (my.1password.com is a client-routed
  // SPA; an unauthenticated 200 on a guessed path doesn't confirm the
  // route exists). Its token VALUE is already covered independently by
  // credential-guard.js's own `ops_`-prefix token-shape pattern, so this
  // is a missing defense-in-depth layer, not a missing defense.
];

// Comma-separated list of EXTRA regex source strings (case-insensitive),
// ADDED to the defaults above -- never a replacement, so a misconfigured
// or empty env var can only widen suppression, never narrow it back to
// nothing. A fragment that fails to compile as a regex is skipped, not
// fatal: one bad entry shouldn't take down every page load.
const ENV_VAR = 'SUPERPOWERS_CHROME_SENSITIVE_URL_PATTERNS';

function extraPatterns() {
  const raw = process.env[ENV_VAR];
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((src) => {
      try {
        return new RegExp(src, 'i');
      } catch (_e) {
        return null;
      }
    })
    .filter(Boolean);
}

// url: whatever the page's live location.href was at capture time (or,
// for a dialog, the dialog payload's url). Not every caller has a
// parseable absolute URL in hand (a bare path, or a malformed string
// some upstream already mangled); fall back to matching the raw string
// rather than throwing, so a bad input only risks a missed suppression,
// never an exception that would itself abort the capture.
//
// Callers are responsible for the SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE
// gate (see capture.js) -- this function always evaluates the pattern
// match on its own, so it stays usable from contexts (tests, other
// tooling) that want the raw match regardless of that env var.
// Schemes whose `pathname` is not a real page location -- see module
// comment for why each one is excluded rather than matched.
const NEVER_SENSITIVE_SCHEMES = new Set(['data:', 'blob:', 'about:']);

function urlLooksSensitive(url) {
  if (typeof url !== 'string' || !url) return false;
  let target = url;
  let hostAndPath = null;
  try {
    const parsed = new URL(url);
    if (NEVER_SENSITIVE_SCHEMES.has(parsed.protocol)) return false;
    // pathname + hash, deliberately NOT parsed.search -- see module
    // comment for why the query string is excluded.
    target = parsed.pathname + (parsed.hash || '');
    // hostname + pathname + hash, for DEFAULT_SENSITIVE_HOST_PATH_PATTERNS
    // below -- same query-string exclusion, same reasoning.
    hostAndPath = parsed.hostname + parsed.pathname + (parsed.hash || '');
  } catch (_e) {
    // Not a parseable absolute URL -- match against the raw string. No
    // hostAndPath in this case: without a parseable URL there is no
    // reliable hostname to qualify a host-path pattern against, and
    // matching the host-path patterns' host prefix against an arbitrary
    // raw string risks a false positive the pathname-only patterns don't
    // have (e.g. a raw string that happens to start with "github.com").
  }
  const patterns = DEFAULT_SENSITIVE_URL_PATTERNS.concat(extraPatterns());
  if (patterns.some((re) => re.test(target))) return true;
  if (hostAndPath && DEFAULT_SENSITIVE_HOST_PATH_PATTERNS.some((re) => re.test(hostAndPath))) return true;
  return false;
}

const URL_SUPPRESSED_NOTICE =
  '⚠️ Page URL matches a known-sensitive pattern (2FA/MFA/TOTP setup, recovery or backup codes, security keys); ' +
  'auto-capture and screenshot suppressed for this page, regardless of its content. ' +
  'Use the credential broker to capture any value you need from it. ' +
  `Set ${ENV_VAR} to extend the pattern list (comma-separated regexes, ADDED to the defaults, never a replacement); ` +
  'SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE=1 disables this.';

// PRI-3360: wholePageReadRefusal/pageTextReadRefused below gate explicit,
// caller-requested WHOLE-PAGE text reads -- eval, extract/extractPageText
// with no selector (or a selector that RESOLVES to the whole document --
// see extraction.js's resolveIsWholePage), the index.ts markdown branch,
// and getSanitizedHtml on the same. Unlike URL_SUPPRESSED_NOTICE's
// auto-capture/screenshot gate above, these are reads the caller
// explicitly asked for -- but the real incident behind this ticket
// happened through exactly this path: eval/extract reading backup codes
// off a 2FA settings page straight into the worker's own transcript,
// before the value was ever captured through the credential broker.
function wholePageReadRefusal(action, reason) {
  return (
    `${action} refused: this page is flagged sensitive (${reason}). ` +
    'Whole-page reads (eval, a selector-less extract, or extract/getSanitizedHtml on a selector that resolves to ' +
    'the whole document) are always refused on a sensitive page, regardless of what they would have returned. ' +
    'Use a narrower, ELEMENT-SCOPED read instead -- extract or attr with a selector for ONE specific element, ' +
    'such as a particular button, status message, or error-banner selector -- not the whole page. ' +
    'Use the credential broker to capture any value you actually need from this page. ' +
    "This refusal cannot be lifted by the agent at runtime: SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE is read " +
    "once from the MCP server process's own environment at startup (set by whoever launched the server, e.g. the " +
    'MCP host\'s own config) -- no tool call, page script, or eval expression run through this server can set or ' +
    'see it.'
  );
}

/**
 * pageTextReadRefused(ps, action): the whole-page gate itself. `ps` is a
 * resolved page session (an object with an async `.send(method, params)`
 * method -- the same shape getPageSession(...) returns in capture.js and
 * extraction.js). `action` is a short label ('eval' | 'extract' | 'attr')
 * used only in the refusal message.
 *
 * Returns a refusal message (string) when the page is flagged sensitive by
 * ANY of three independent signals, checked in order and short-circuited
 * on the first match:
 *   1. A known-sensitive URL pattern (urlLooksSensitive) -- refuses
 *      regardless of content, same as before.
 *   2. A live data-sen-secret marker -- refuses regardless of content,
 *      same as before.
 *   3. Code-list density ALONE (off the URL list, no marker) is not
 *      sufficient by itself (PRI-3360 round 2, jc review of #65: density
 *      alone flagged ordinary pages -- GitHub PR/repo/REST-docs pages,
 *      the HN front page -- and a selector-less extract has no narrower
 *      form to fall back to when that happens). This branch also
 *      requires a backup/recovery-style keyword within code-list-
 *      detector.js's KEYWORD_PROXIMITY_CHARS of the code cluster
 *      (codeListNearBackupKeyword) -- a concrete cue that the page is
 *      actually showing backup/recovery codes, not just text that
 *      happens to cluster densely.
 *
 * PRI-3360 round 3 (Reeve) briefly added a fourth signal here --
 * containsCredentialShaped on the page's own visible text, unconditional
 * -- to catch a lone credential-shaped token with nothing else to flag
 * the page. Round 4 (jc, round 4 review) removed it again: it
 * false-positived on Slack's own token-TYPES documentation page (an
 * UNLISTED page that legitimately shows example token strings to explain
 * their format), the same class of problem round 2 found with code-list
 * density. Catching a lone token is now EVAL's job specifically, done
 * AFTER running (see capture.js's evaluateWithCapture and credential-
 * guard.js's stringLooksLikeSecret/valueLeaksSecret), gated on the page's
 * URL already being on the sensitive-URL list -- not a blanket whole-page
 * pre-check that would block this pre-check function's only two OTHER
 * callers (extractPageText/getSanitizedHtml's whole-page form) from ever
 * reading an unlisted page with an example token on it, the exact page
 * class this round's own test fixture (the Slack token-types docs page)
 * is built to prove stays readable. Output-level redaction
 * (response-format.ts's redactCredentialShaped) still masks any token
 * shape that reaches the final response text regardless, on every page,
 * listed or not -- that layer was never removed and still does its job
 * for a page this function doesn't refuse.
 *
 * Returns null when none apply (the caller's whole-page read may
 * proceed). Deliberately a nullable-string return, not a throw, so
 * callers can decide whether to throw immediately or fold the message
 * into a larger response.
 *
 * Reads page text via code-list-detector.js's visibleTextFnSrc (VISIBLE
 * text only -- skips <script>/<style>/<template>/<noscript> content and
 * hidden elements, with a block-level separator so adjacent-but-unrelated
 * DOM nodes don't glue into one token) rather than raw
 * `document.body.textContent`, purely to run the content heuristic
 * IN-PROCESS -- that text is never returned to the caller, only scanned;
 * see credential-guard.js's refuseIfTextLeaksSecret for the longer
 * version of "reading in-process isn't the leak, returning text to the
 * agent is." See code-list-detector.js's own doc comment for why this
 * walker, not `.innerText`, even though the live page (unlike a detached
 * clone elsewhere in this codebase) does have layout available.
 */
async function pageTextReadRefused(ps, action) {
  // Deliberately checked first, same as every other existing guard in
  // this codebase (screenshotUnlessCredentialShaped, mustSuppress, the
  // marker checks) -- and that is fine under PRI-3360's "no agent-
  // settable override" requirement because this env var already was
  // operator-only before this change: it is read exactly once, from
  // process.env, inside the already-running MCP server process. Nothing
  // reachable from an MCP tool call can change it mid-session --
  // confirmed by reading the dispatch table in mcp/src/index.ts (no
  // action writes process.env, and there is no "set env"/"configure"
  // action at all) and by eval's own execution model: the `expression`
  // argument runs in the BROWSER PAGE's JS realm over
  // Runtime.evaluate, which has no Node `process` global to touch in the
  // first place (see test/lib/sensitive-url.test.mjs's "agent cannot set
  // the override" case, which proves this empirically against a real
  // Chrome page). The only way to change this value is to restart the
  // MCP server process with a different environment -- an operator
  // action, not an agent one.
  if (credentialCaptureAllowed()) return null;

  const urlResult = await ps.send('Runtime.evaluate', {
    expression: 'location.href',
    returnByValue: true,
  });
  throwIfExceptionDetails(urlResult);
  if (urlLooksSensitive(urlResult.result.value)) {
    return wholePageReadRefusal(
      action,
      'the URL matches a known-sensitive pattern (2FA/MFA/TOTP setup, recovery or backup codes, security keys)'
    );
  }

  if (await pageHasSecretMarker(ps)) {
    return wholePageReadRefusal(action, 'an element on the page is marked data-sen-secret');
  }

  const textResult = await ps.send('Runtime.evaluate', {
    expression: `(() => { ${visibleTextFnSrc} return document.body ? __senVisibleText(document.body) : ''; })()`,
    returnByValue: true,
  });
  throwIfExceptionDetails(textResult);
  if (codeListNearBackupKeyword(textResult.result.value)) {
    return wholePageReadRefusal(
      action,
      'the page text looks like a dense list of secret-shaped codes near a backup/recovery cue'
    );
  }

  return null;
}

module.exports = {
  DEFAULT_SENSITIVE_URL_PATTERNS,
  DEFAULT_SENSITIVE_HOST_PATH_PATTERNS,
  ENV_VAR,
  urlLooksSensitive,
  URL_SUPPRESSED_NOTICE,
  wholePageReadRefusal,
  pageTextReadRefused,
};
