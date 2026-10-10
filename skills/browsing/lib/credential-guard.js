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
 * Two signals:
 *   - Token shapes with realistic minimum lengths, so prose that merely
 *     names a prefix ("bot tokens start with xoxb-") does not trip it.
 *   - An explicit opt-in marker: any element carrying the
 *     `data-sen-secret` attribute. Use it for secrets with no distinctive
 *     shape (TOTP seeds shown as bare base32, backup codes).
 *
 * SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE=1 turns the guard off, for
 * someone debugging their own browser. The default is the safe behavior.
 */

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

const { codeListDetected } = require('./code-list-detector');

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

// PRI-3360: the element-scoped counterpart to secretMarkerRefusal above.
// extract/attr with a real element selector (not the whole page -- see
// extraction.js's resolveIsWholePage/sensitive-url.js's pageTextReadRefused
// for that case) are allowed to run, but the resolved text is checked HERE, inside
// the tool, before anything is returned to the caller. A match (either a
// token shape or the code-list density heuristic) refuses the whole read
// outright rather than redacting it -- redacting would mean the caller
// already received a result built from a secret the tool read; refusing
// means it never leaves this function.
//
// This function does not itself re-check credentialCaptureAllowed() --
// same as throwIfSecretMarked's marker check in extraction.js, its only
// callers (extraction.js's extractText/getSanitizedHtml/getAttribute) only
// reach this call at all on the guarded (non-override) code path; the
// override's branch in each of those functions reads the raw, unchecked
// value directly and never calls this. That keeps PRI-3360's new check
// subject to the exact same operator-only escape hatch as every other
// guard in this codebase, which is the correct scope for it: the escape
// hatch was confirmed (see sensitive-url.js's pageTextReadRefused doc) to
// be unreachable from anything an agent controls at runtime, so there is
// no "worker wave this through for itself" risk in also letting it cover
// this check.
function elementReadRefusal(action, selector) {
  return (
    `${action} refused: the content read from ${JSON.stringify(selector)} looks credential- or code-shaped. ` +
    'Target a different, narrower element instead -- e.g. a button, status message, or error-banner selector ' +
    'that does not contain the secret itself. Use the credential broker to capture the value you actually need.'
  );
}

// Throws elementReadRefusal(action, selector) when `text` is credential-
// shaped (containsCredentialShaped) or looks like a dense list of secret
// codes (codeListDetected); otherwise returns `text` unchanged. Call this
// on the RESULT of an element-scoped extract/attr read, before returning
// it to the caller. A non-string value (null/undefined -- selector didn't
// resolve) passes through untouched; there is nothing to scan.
function refuseIfTextLeaksSecret(text, action, selector) {
  if (typeof text !== 'string' || text === '') return text;
  if (containsCredentialShaped(text) || codeListDetected(text)) {
    throw new Error(elementReadRefusal(action, selector));
  }
  return text;
}

module.exports = {
  MARKER_ATTR,
  containsCredentialShaped,
  redactCredentialShaped,
  credentialCaptureAllowed,
  CREDENTIAL_ADVICE,
  CREDENTIAL_SUPPRESSED_NOTICE,
  secretMarkerRefusal,
  elementReadRefusal,
  refuseIfTextLeaksSecret,
  REDACTION,
};
