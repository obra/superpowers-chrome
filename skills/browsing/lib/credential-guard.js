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

const CREDENTIAL_SUPPRESSED_NOTICE =
  '⚠️ Page shows credential-shaped content; auto-capture and DOM output suppressed. ' +
  'Use the credential broker to capture values; use eval only for value-blind queries.';

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

module.exports = {
  MARKER_ATTR,
  containsCredentialShaped,
  redactCredentialShaped,
  credentialCaptureAllowed,
  CREDENTIAL_SUPPRESSED_NOTICE,
  secretMarkerRefusal,
  REDACTION,
};
