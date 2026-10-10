/**
 * Credential-shaped content guard.
 *
 * Auto-capture writes every page it touches to disk (html / md / png /
 * diff) and echoes a DOM summary back into the agent's transcript. When a
 * page renders a bearer token or 2FA material, that copies the secret into
 * both places. This module is the single detector the capture path and
 * the MCP server use to spot such pages (and to redact any match that
 * still reaches returned text).
 *
 * Signals:
 *   - Token shapes with realistic minimum lengths (TOKEN_PATTERNS), so
 *     prose that merely names a prefix ("bot tokens start with xoxb-")
 *     does not trip it.
 *   - Bare token PREFIXES (TOKEN_PREFIXES), no minimum trailing length --
 *     round 4 (PRI-3360, jc + Reeve): catches a value TRUNCATED down to
 *     just its prefix (`el.value.slice(0,8)` of a real token), which the
 *     full-shape patterns above no longer match.
 *   - A bare alphanumeric run with a digit in it (hasLongAlnumRunWithDigit)
 *     -- jc's rule for an unprefixed TOTP/HOTP seed (bare base32).
 *   - An explicit opt-in marker: any element carrying the
 *     `data-sen-secret` attribute. Use it for secrets with no distinctive
 *     shape at all (backup codes with no uniform prefix or run length).
 *
 * SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE=1 turns the guard off, for
 * someone debugging their own browser. The default is the safe behavior.
 */

const { codeListDetected, codeListNearBackupKeyword } = require('./code-list-detector');

// Token-shaped patterns. Each source is used both for detection and for
// redaction, so a detector and a redactor can never disagree. There is
// deliberately no leading word boundary: page text reaches us glued to
// its surroundings (a URL-encoded `%3Exoxb-...` has an `E` right before
// the prefix), and a missed match is a leak while an extra one is only a
// skipped capture.
const TOKEN_PATTERNS = [
  // Slack bot/user/app/refresh/legacy tokens: xoxb-, xoxp-, xoxa-, xoxr-, xoxs-, xoxo-
  'xox[abposr]-[A-Za-z0-9-]{20,}',
  // Slack rotating tokens: xoxe.xoxb-1-... and xoxe-1-...
  'xoxe[.-][A-Za-z0-9.-]{20,}',
  // Slack app-level tokens
  'xapp-[A-Za-z0-9-]{20,}',
  // GitHub classic / OAuth / user-to-server / server-to-server / refresh tokens
  'gh[pousr]_[A-Za-z0-9]{36,}',
  // GitHub fine-grained personal access tokens
  'github_pat_[A-Za-z0-9_]{40,}',
  // 1Password service-account tokens (ops_ + base64 JSON, which always opens `eyJ`)
  'ops_eyJ[A-Za-z0-9+/=_-]{40,}',
  // 1Password Secret Key: A3-XXXXXX-XXXXXX-XXXXX-XXXXX-XXXXX-XXXXX
  'A3-[A-Za-z0-9]{6}-[A-Za-z0-9]{6}(?:-[A-Za-z0-9]{5}){4}',
  // TOTP provisioning URI carrying the seed (QR-code alt text, "can't scan?" links).
  // `;` covers an HTML-escaped `&amp;secret=`.
  'otpauth://[^\\s"\'<>]*[?&;]secret=[A-Za-z0-9=]{16,}',
];

// Round 4 (PRI-3360, jc + Reeve's final design): bare PREFIXES, not full
// shapes -- a value a page or an eval expression TRUNCATES (`el.value.
// slice(0,8)` of a real xoxb- token) no longer matches TOKEN_PATTERNS'
// full regexes (those require 20-40+ trailing chars), but it still names
// itself. Kept as a SEPARATE list from TOKEN_PATTERNS rather than derived
// from it programmatically: several TOKEN_PATTERNS entries bundle more
// than one prefix into a single alternation (`xox[abposr]-`,
// `gh[pousr]_`), so mechanically stripping each pattern down to "whatever
// comes before the first {n,}" would need the same character-class
// expansion logic maintained twice; a short, explicit, hand-kept list next
// to TOKEN_PATTERNS is more obviously correct and just as easy to extend.
// Includes three prefixes with no full-shape entry in TOKEN_PATTERNS at
// all yet (`tskey-` Tailscale, `sk-` OpenAI/Stripe-style, `lin_api_`
// Linear) -- prefix-only detection is this round's answer for those until
// a full shape is worth adding.
const TOKEN_PREFIXES = [
  'xoxb-', 'xoxp-', 'xoxa-', 'xoxr-', 'xoxs-', 'xoxo-', // Slack bot/user/app/refresh/legacy
  'xoxe-', 'xoxe.', // Slack rotating
  'xapp-', // Slack app-level
  'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', // GitHub classic/OAuth/user-to-server/server-to-server/refresh
  'github_pat_', // GitHub fine-grained
  'ops_', // 1Password service-account
  'A3-', // 1Password Secret Key
  'tskey-', // Tailscale
  'sk-', // OpenAI/Stripe-style secret key
  'lin_api_', // Linear API key
];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// \b before each prefix's first character (always a letter in every entry
// above) matches both "starts with" (string-start counts as a boundary)
// and "contains at a word start" (preceded by whitespace or punctuation) --
// but not glued onto a preceding word character ("faxoxb-" does not
// match). Unlike TOKEN_PATTERNS/containsCredentialShaped, which is
// deliberately UNANCHORED (see that const's own comment -- a URL-encoded
// page attribute can glue a real token directly onto surrounding text
// with no separator at all), a bare prefix with no minimum trailing
// length is loose enough on its own that requiring a word start keeps it
// from matching an ordinary word that merely CONTAINS one of these short
// sequences mid-word.
const TOKEN_PREFIX_PATTERN = new RegExp(`\\b(?:${TOKEN_PREFIXES.map(escapeRegExp).join('|')})`, 'i');

function hasKnownTokenPrefix(text) {
  if (typeof text !== 'string' || text === '') return false;
  return TOKEN_PREFIX_PATTERN.test(text);
}

// jc's rule for a bare TOTP/HOTP seed with no prefix at all (base32, e.g.
// `JBSWY3DPEHPK3PXP`) and no otpauth:// URI to match TOKEN_PATTERNS'
// existing entry for one -- the seed is just letters and digits, nothing
// else recognizes it. Whitespace is stripped FIRST (not just collapsed to
// a single space) specifically to catch a seed someone has broken into
// even-width groups for display/typing ("JBSW Y3DP EHPK 3PXP") -- gluing
// the groups back together is exactly what defeats that split. Deliberately
// a SEPARATE, looser rule from the two above: any 6+ alnum run with a
// digit in it, no specific prefix required -- which is loose enough that
// it is only applied where the extra false-positive risk is accepted; see
// stringLooksLikeSecret below and its callers.
const MIN_ALNUM_RUN = 6;

function hasLongAlnumRunWithDigit(text) {
  if (typeof text !== 'string' || text === '') return false;
  const collapsed = text.replace(/\s+/g, '');
  const runs = collapsed.match(/[A-Za-z0-9]{6,}/g);
  if (!runs) return false;
  return runs.some((run) => run.length >= MIN_ALNUM_RUN && /\d/.test(run));
}

// Page marker: an element attribute named exactly data-sen-secret. Single
// source of truth for the literal — secret-marker.js, extraction.js,
// set-attribute.js, capture.js and mcp/src/index.ts all import this rather
// than each spelling the attribute name out themselves.
const MARKER_ATTR = 'data-sen-secret';
const MARKER_PATTERN = new RegExp(`<[^>]*\\s${MARKER_ATTR}(?=[\\s=/>])`, 'i');

const REDACTION = '[REDACTED credential-shaped]';

function tokenRegex(flags) {
  return new RegExp(TOKEN_PATTERNS.join('|'), flags);
}

function containsCredentialShaped(text) {
  if (typeof text !== 'string' || text === '') return false;
  return tokenRegex('i').test(text) || MARKER_PATTERN.test(text);
}

function redactCredentialShaped(text) {
  if (typeof text !== 'string') return text;
  return text.replace(tokenRegex('gi'), REDACTION);
}

function credentialCaptureAllowed() {
  return process.env.SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE === '1';
}

// Suppression can come from a token shape (eval still runs, redacted) or
// from a data-sen-secret marker (eval refuses outright), and callers don't
// know which, so the advice has to be true for both.
const CREDENTIAL_ADVICE =
  'Use the credential broker to capture values. ' +
  'eval refuses while any element is marked data-sen-secret; otherwise use it only for value-blind queries.';

const CREDENTIAL_SUPPRESSED_NOTICE =
  '⚠️ Page shows credential-shaped content; auto-capture and DOM output suppressed. ' +
  CREDENTIAL_ADVICE;

// eval and extract/attr cannot tell whether their result would carry a
// data-sen-secret element's value forward — by the time either produces
// plain text or an attribute string, the marker (a live-DOM-only signal;
// see lib/secret-marker.js) is gone. So both fail closed on the marker's
// mere presence rather than trying to inspect the result after the fact.
// Unlike CREDENTIAL_SUPPRESSED_NOTICE, there is no "value-blind queries are
// fine" carve-out: a marker means the page has no reliable value shape to
// scope a carve-out around.
function secretMarkerRefusal(action) {
  return (
    `${action} refused: page has an element marked data-sen-secret. ` +
    'Use the credential broker to capture its value; ' +
    'SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE=1 disables this.'
  );
}

// PRI-3360: the element-scoped (and, round 4, eval-result) counterpart to
// secretMarkerRefusal above. extract/attr with a real element selector
// (not the whole page -- see extraction.js's resolveIsWholePage/
// sensitive-url.js's pageTextReadRefused for that case), and eval's
// RETURN VALUE on a sensitive URL (round 4 -- see evalResultRefusal
// below for eval's own wording), are allowed to run, but the resulting
// text is checked HERE, inside the tool, before anything is returned to
// the caller. A match refuses the whole read outright rather than
// redacting it -- redacting would mean the caller already received a
// result built from a secret the tool read; refusing means it never
// leaves this function.
//
// This function does not itself re-check credentialCaptureAllowed() --
// same as throwIfSecretMarked's marker check in extraction.js, its only
// callers (extraction.js's extractText/getSanitizedHtml/getAttribute,
// capture.js's evaluateWithCapture) only reach this call at all on the
// guarded (non-override) code path; the override's branch in each of
// those reads the raw, unchecked value directly and never calls this.
// That keeps PRI-3360's checks subject to the exact same operator-only
// escape hatch as every other guard in this codebase, which is the
// correct scope for it: the escape hatch was confirmed (see
// sensitive-url.js's pageTextReadRefused doc) to be unreachable from
// anything an agent controls at runtime, so there is no "worker wave this
// through for itself" risk in also letting it cover this check.
function elementReadRefusal(action, selector) {
  return (
    `${action} refused: the content read from ${JSON.stringify(selector)} looks credential- or code-shaped. ` +
    'Target a different, narrower element instead -- e.g. a button, status message, or error-banner selector ' +
    'that does not contain the secret itself. Use the credential broker to capture the value you actually need.'
  );
}

// PRI-3360 round 4: eval's own wording for the same refusal, used when the
// STRING check below trips on eval's return value (not an element
// selector -- eval has no selector to name, so the message points at the
// expression/page relationship instead).
function evalResultRefusal(expression) {
  return (
    `eval refused: the return value of ${JSON.stringify(expression)} looks credential- or code-shaped on this ` +
    "sensitive page. Target a narrower, value-blind query instead (e.g. check a boolean/length/count), or use " +
    'the credential broker to capture the value you actually need.'
  );
}

/**
 * stringLooksLikeSecret(text, { densityAloneSufficient }): the unified
 * per-string check, PRI-3360 round 4 (jc + Reeve's final design). True
 * when ANY of:
 *   1. containsCredentialShaped(text) -- an existing, full-shape token
 *      pattern.
 *   2. hasKnownTokenPrefix(text) -- a bare, known token PREFIX, even
 *      truncated down to just that (round 4's own addition -- see
 *      TOKEN_PREFIXES above for why this needs to be separate from (1)).
 *   3. The code-list density signal: codeListDetected (density ALONE) when
 *      `densityAloneSufficient` is true, else codeListNearBackupKeyword
 *      (density + a nearby backup/recovery cue). Callers set
 *      `densityAloneSufficient: true` only when they already know the
 *      page's URL is on the sensitive-URL list -- density alone is a
 *      weaker signal off that list (PRI-3360 round 2, jc review of #65:
 *      it false-positived on ordinary pages there), but a page ALREADY
 *      flagged sensitive by its URL doesn't need the extra keyword cue.
 *   4. hasLongAlnumRunWithDigit(text) -- a bare TOTP/HOTP seed with no
 *      prefix and no otpauth:// URI (jc's rule).
 * A non-string value (or empty string) never matches -- nothing to scan.
 */
function stringLooksLikeSecret(text, { densityAloneSufficient = false } = {}) {
  if (typeof text !== 'string' || text === '') return false;
  if (containsCredentialShaped(text)) return true;
  if (hasKnownTokenPrefix(text)) return true;
  if (densityAloneSufficient ? codeListDetected(text) : codeListNearBackupKeyword(text)) return true;
  if (hasLongAlnumRunWithDigit(text)) return true;
  return false;
}

// Round 4: eval can return an object or array (`{ token: "..." }`,
// `[el1.value, el2.value]`), not just a bare string -- a worker handing
// eval `JSON.stringify`-shaped work is common. Walks strings/arrays/plain
// objects recursively, applying stringLooksLikeSecret to every string
// found; short-circuits true on the first match. Non-string/array/object
// values (numbers, booleans, null, undefined) always pass -- these are
// exactly the types PRI-3360 round 4's design keeps allowed through
// unconditionally, since none of them can carry a token-shaped string.
// `maxDepth` guards against a pathologically deep/cyclic structure costing
// unbounded recursion; CDP's own `returnByValue` serialization already
// imposes a depth/size limit of its own, so this is a cheap extra floor,
// not the primary defense.
const MAX_VALUE_DEPTH = 10;

function valueLeaksSecret(value, opts = {}, depth = 0) {
  if (depth > MAX_VALUE_DEPTH) return false;
  if (typeof value === 'string') return stringLooksLikeSecret(value, opts);
  if (Array.isArray(value)) return value.some((v) => valueLeaksSecret(v, opts, depth + 1));
  if (value && typeof value === 'object') {
    return Object.values(value).some((v) => valueLeaksSecret(v, opts, depth + 1));
  }
  return false;
}

// Throws elementReadRefusal(action, selector) when `text` looks like a
// secret per stringLooksLikeSecret (see that function's own doc for the
// four rules); otherwise returns `text` unchanged. Call this on the
// RESULT of an element-scoped extract/attr read, before returning it to
// the caller. A non-string value (null/undefined -- selector didn't
// resolve) passes through untouched; there is nothing to scan.
// `densityAloneSufficient` is the caller's job to compute (extraction.js:
// true when the page's own URL is already on the sensitive-URL list, same
// as eval's rule above) -- this function has no page/URL access of its
// own by design, to keep it a pure string check.
function refuseIfTextLeaksSecret(text, action, selector, opts = {}) {
  if (typeof text !== 'string' || text === '') return text;
  if (stringLooksLikeSecret(text, opts)) {
    throw new Error(elementReadRefusal(action, selector));
  }
  return text;
}

module.exports = {
  MARKER_ATTR,
  containsCredentialShaped,
  hasKnownTokenPrefix,
  hasLongAlnumRunWithDigit,
  stringLooksLikeSecret,
  valueLeaksSecret,
  redactCredentialShaped,
  credentialCaptureAllowed,
  CREDENTIAL_ADVICE,
  CREDENTIAL_SUPPRESSED_NOTICE,
  secretMarkerRefusal,
  elementReadRefusal,
  evalResultRefusal,
  refuseIfTextLeaksSecret,
  REDACTION,
};
