/**
 * Code-list density detector.
 *
 * A second, content-level signal alongside sensitive-url.js's URL-pattern
 * check: some pages render a secret with no distinctive URL (an
 * internal tool's recovery-code screen that never matched
 * DEFAULT_SENSITIVE_URL_PATTERNS) and no fixed token shape
 * credential-guard.js's containsCredentialShaped can recognize (backup/
 * recovery codes like `7f3k-9d2m` or bare 6-digit TOTP-style codes like
 * `482910` have no `xoxb-`/`ghp_`-style prefix). What they DO have is
 * density: a short run of several distinct, similarly-sized alphanumeric
 * tokens packed close together — a code LIST, not prose.
 *
 * This is a heuristic, not a format match (PRI-3360 design doc, options
 * (a)/(b)/(c)): it can both miss a real code list (too few codes, codes
 * spread across a long page) and flag something that isn't one (a SKU
 * table, a build/version list). Per the design, that trade is deliberate:
 * a miss here is still caught by the URL-pattern/marker signals when
 * either applies, and a false positive on a WHOLE-PAGE read only forces a
 * narrower, element-scoped read (see sensitive-url.js's
 * pageTextReadRefused) rather than silently leaking. Grow the thresholds
 * below as real misses get reported, the same discipline PRI-3319's
 * round-4 URL-pattern tuning used — keep this module self-contained so
 * that tuning stays in one place with its own fixture corpus
 * (test/lib/code-list-detector.test.mjs).
 */

// A qualifying token is 4-12 chars of only letters/digits, and looks
// code-shaped rather than like an ordinary word or small number:
//   - mixed letters AND digits (e.g. `7f3k`, `9d2m`) at any length in
//     range, or
//   - all digits, but only at length >= 6 (a bare short number — a count,
//     a year, a page number — is not treated as code-shaped; a 6+ digit
//     run, like a backup/TOTP-style code, is).
// A pure-alphabetic token (an ordinary word) never qualifies.
const MIN_LEN = 4;
const MAX_LEN = 12;
const MIN_NUMERIC_LEN = 6;

// At least this many DISTINCT qualifying tokens, of near-uniform length,
// within one clustered window, before this fires.
const MIN_DISTINCT = 6;

// "Clustered in one small container": a sliding window over the ORIGINAL
// text's character offsets. A real code list is short and dense; a
// changelog or SKU table with similarly-shaped entries is spread across a
// much longer document.
const CLUSTER_WINDOW_CHARS = 500;

function isCodeShapedToken(token) {
  if (token.length < MIN_LEN || token.length > MAX_LEN) return false;
  const hasDigit = /\d/.test(token);
  const hasAlpha = /[A-Za-z]/.test(token);
  if (hasDigit && hasAlpha) return true;
  if (hasDigit && !hasAlpha) return token.length >= MIN_NUMERIC_LEN;
  return false;
}

// A simple arithmetic run (1001, 1002, 1003, ...) is a sequence number —
// an invoice/SKU/page list — not a set of independently-generated secret
// codes, even when it clusters tightly and shares a length. Only applied
// when every candidate in the window is pure-numeric; a mixed-alnum code
// set is never filtered this way (real codes don't parse as numbers).
function isArithmeticSequence(numbers) {
  if (numbers.length < 3) return false;
  const sorted = [...numbers].sort((a, b) => a - b);
  const diff = sorted[1] - sorted[0];
  if (diff === 0) return false;
  for (let i = 2; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] !== diff) return false;
  }
  return true;
}

/**
 * codeListDetected(text): true when `text` contains a dense, clustered
 * run of >= MIN_DISTINCT distinct, similarly-sized code-shaped tokens.
 *
 * Pure content heuristic — no DOM, no URL, no page session. Safe to call
 * on any plain string, including text read in-process purely to decide a
 * refusal (never returned to a caller).
 */
function codeListDetected(text) {
  if (typeof text !== 'string' || !text) return false;

  const all = [...text.matchAll(/[A-Za-z0-9]+/g)]
    .map((m) => ({ token: m[0], index: m.index }))
    .filter((m) => isCodeShapedToken(m.token));

  if (all.length < MIN_DISTINCT) return false;

  // Near-uniform length: keep only tokens at the single most common
  // length, +/-1 — a backup-code or TOTP-seed list uses one fixed format,
  // unlike a changelog or SKU table whose entries vary in width.
  const lengthCounts = new Map();
  for (const m of all) {
    lengthCounts.set(m.token.length, (lengthCounts.get(m.token.length) || 0) + 1);
  }
  let modalLength = all[0].token.length;
  let modalCount = 0;
  for (const [len, count] of lengthCounts) {
    if (count > modalCount) {
      modalLength = len;
      modalCount = count;
    }
  }
  const uniform = all.filter((m) => Math.abs(m.token.length - modalLength) <= 1);
  if (uniform.length < MIN_DISTINCT) return false;

  // Reject a simple arithmetic run of sequential numbers (see
  // isArithmeticSequence doc above) when every candidate token is
  // pure-numeric.
  const numericValues = uniform.filter((m) => /^\d+$/.test(m.token)).map((m) => Number(m.token));
  if (numericValues.length === uniform.length && isArithmeticSequence(numericValues)) {
    return false;
  }

  // Sliding window over the original text offsets, looking for
  // >= MIN_DISTINCT distinct qualifying tokens within CLUSTER_WINDOW_CHARS
  // of each other.
  let left = 0;
  for (let right = 0; right < uniform.length; right++) {
    while (uniform[right].index - uniform[left].index > CLUSTER_WINDOW_CHARS) left++;
    const distinct = new Set();
    for (let i = left; i <= right; i++) distinct.add(uniform[i].token);
    if (distinct.size >= MIN_DISTINCT) return true;
  }
  return false;
}

module.exports = {
  codeListDetected,
  MIN_DISTINCT,
  MIN_LEN,
  MAX_LEN,
  MIN_NUMERIC_LEN,
  CLUSTER_WINDOW_CHARS,
};
