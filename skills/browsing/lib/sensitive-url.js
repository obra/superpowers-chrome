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
 * DOM looks like: a known-sensitive URL PATH is suppressed outright, the
 * same way a credential-shaped page is -- no html/md body capture, no
 * screenshot -- regardless of whether the page happens to name anything
 * in a way the other detector would catch. Belt and suspenders: either
 * signal alone suppresses; neither depends on the other.
 *
 * Case-insensitive substring match against the URL's pathname (plus
 * query string, so e.g. a single `/settings?tab=security-keys` page
 * still matches) -- same philosophy as credential-guard.js and
 * html-with-scrub.js: a missed match is a leak, an extra match only
 * suppresses a capture that would otherwise have been harmless. Never
 * touches the live page -- this only ever decides what gets written to
 * disk.
 */

const DEFAULT_SENSITIVE_URL_PATTERNS = [
  /\/2fa/i,
  /\/two[-_]?factor/i,
  /\/mfa/i,
  /\/totp/i,
  /\/security\/keys/i,
  /\/recovery[-_]?codes?/i,
  /\/backup[-_]?codes?/i,
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
function urlLooksSensitive(url) {
  if (typeof url !== 'string' || !url) return false;
  let target = url;
  try {
    const parsed = new URL(url);
    target = parsed.pathname + parsed.search;
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
