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
 * unrelated slug. `/2fa` is deliberately left unanchored on its suffix
 * side: Slack's own real setup URL needs it (`/account/settings/2fa_app`
 * has "2fa" immediately followed by "_app", not a "/" or end of string),
 * and nothing has shown the same over-suppression risk for it that "mfa"
 * had. `security[-_]?keys`, `two[-_]?step`, `login[-_]?verification` and
 * `security[-_]?info` are deliberately NOT segment-anchored either: they
 * are expected to show up as a hash anchor (`#security-keys`) or as part
 * of a longer slug (Google's own `/two-step-verification` route), not
 * necessarily as a path segment of their own.
 *
 * Case-insensitive throughout -- same philosophy as credential-guard.js
 * and html-with-scrub.js: a missed match is a leak, an extra match only
 * suppresses a capture that would otherwise have been harmless. Never
 * touches the live page -- this only ever decides what gets written to
 * disk.
 */

const DEFAULT_SENSITIVE_URL_PATTERNS = [
  /\/2fa/i,
  /(^|\/)two[-_]?factor(\/|$)/i,
  // Google's /two-step-verification route is one hyphen-joined slug, not
  // its own path segment -- deliberately not anchored, like /2fa above.
  /two[-_]?step/i,
  // Segment-anchored, unlike every other word here: an unanchored "mfa"
  // prefix also matched "/docs/mfa-best-practices" -- see module comment.
  /(^|\/)mfa(\/|$)/i,
  /\/totp/i,
  /\/security\/keys(\/|$)/i,
  // No slash requirement -- may appear as a hash anchor or mid-slug.
  /security[-_]?keys/i,
  /(^|\/)recovery[-_]?codes?(\/|$)/i,
  /(^|\/)backup[-_]?codes?(\/|$)/i,
  // AWS/Google-style account-recovery and login-challenge routes.
  /login[-_]?verification/i,
  /security[-_]?info/i,
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
function urlLooksSensitive(url) {
  if (typeof url !== 'string' || !url) return false;
  let target = url;
  try {
    const parsed = new URL(url);
    // pathname + hash, deliberately NOT parsed.search -- see module
    // comment for why the query string is excluded.
    target = parsed.pathname + (parsed.hash || '');
  } catch (_e) {
    // Not a parseable absolute URL -- match against the raw string.
  }
  const patterns = DEFAULT_SENSITIVE_URL_PATTERNS.concat(extraPatterns());
  return patterns.some((re) => re.test(target));
}

const URL_SUPPRESSED_NOTICE =
  '⚠️ Page URL matches a known-sensitive pattern (2FA/MFA/TOTP setup, recovery or backup codes, security keys); ' +
  'auto-capture and screenshot suppressed for this page, regardless of its content. ' +
  'Use the credential broker to capture any value you need from it. ' +
  `Set ${ENV_VAR} to extend the pattern list (comma-separated regexes, ADDED to the defaults, never a replacement); ` +
  'SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE=1 disables this.';

module.exports = {
  DEFAULT_SENSITIVE_URL_PATTERNS,
  ENV_VAR,
  urlLooksSensitive,
  URL_SUPPRESSED_NOTICE,
};
