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
 * either applies, and a false positive on an ELEMENT-scoped read only
 * refuses that one read (see credential-guard.js's refuseIfTextLeaksSecret).
 *
 * PRI-3360 round 2 (jc review of #65): a false positive on a WHOLE-PAGE
 * read is worse than the design assumed — `eval` has no narrower form to
 * fall back to, and jc found density alone flagging ordinary pages
 * (GitHub PR/repo/REST-docs pages, the HN front page) hard enough that
 * `eval` was refused outright on all of them. Two fixes, both required:
 *   1. Measure VISIBLE text only (visibleTextFromFnSrc below), not
 *      body.textContent — textContent includes inline <script>/<style>
 *      content (GitHub's embedded JSON easily supplies 6+ distinct mixed
 *      tokens) and glues adjacent-but-unrelated DOM nodes together with
 *      no separator (HN's "145 comments" + "2.Cloudflare..." became the
 *      single token "comments2" with zero whitespace between them in the
 *      served HTML — a block-level separator fixes this the same way
 *      innerText's line breaks would, without needing real layout).
 *   2. A WHOLE-PAGE refusal based on density ALONE (no URL match, no
 *      marker) now also requires a backup/recovery-style keyword within
 *      KEYWORD_PROXIMITY_CHARS of the code cluster — see
 *      codeListNearBackupKeyword below. Grow BOTH the token thresholds
 *      and the keyword list as real misses get reported, the same
 *      discipline PRI-3319's round-4 URL-pattern tuning used — keep this
 *      module self-contained so that tuning stays in one place with its
 *      own fixture corpus (test/lib/code-list-detector.test.mjs),
 *      including jc's negative fixtures (real, trimmed, saved HTML).
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
// within one clustered window, before this fires. This already implements
// "tokens that look like codes, repeated N or more times, in a uniform
// format" — the near-uniform-length filter below plus this count. jc's
// false positives (GitHub/HN) were caused by what counted as a qualifying
// TOKEN in the first place (script JSON, glued adjacent words) reaching
// this threshold at all, not by the threshold being too low for genuine
// code-shaped input — see visibleTextFnSrc below, which fixes that
// upstream rather than raising MIN_DISTINCT (which would just as easily
// suppress a genuine short code list).
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
 * findCodeCluster(text): the core clustering scan. Returns
 * { startIndex, endIndex } (character offsets into `text`, spanning the
 * first qualifying window found) when `text` contains a dense run of
 * >= MIN_DISTINCT distinct, near-uniform-length code-shaped tokens within
 * CLUSTER_WINDOW_CHARS of each other; returns null otherwise.
 *
 * Internal building block for codeListDetected (density alone) and
 * codeListNearBackupKeyword (density + a nearby keyword cue) below — kept
 * as one scan so both stay consistent with each other by construction.
 */
function findCodeCluster(text) {
  if (typeof text !== 'string' || !text) return null;

  const all = [...text.matchAll(/[A-Za-z0-9]+/g)]
    .map((m) => ({ token: m[0], index: m.index }))
    .filter((m) => isCodeShapedToken(m.token));

  if (all.length < MIN_DISTINCT) return null;

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
  if (uniform.length < MIN_DISTINCT) return null;

  // Reject a simple arithmetic run of sequential numbers (see
  // isArithmeticSequence doc above) when every candidate token is
  // pure-numeric.
  const numericValues = uniform.filter((m) => /^\d+$/.test(m.token)).map((m) => Number(m.token));
  if (numericValues.length === uniform.length && isArithmeticSequence(numericValues)) {
    return null;
  }

  // Sliding window over the original text offsets, looking for
  // >= MIN_DISTINCT distinct qualifying tokens within CLUSTER_WINDOW_CHARS
  // of each other.
  let left = 0;
  for (let right = 0; right < uniform.length; right++) {
    while (uniform[right].index - uniform[left].index > CLUSTER_WINDOW_CHARS) left++;
    const distinct = new Set();
    for (let i = left; i <= right; i++) distinct.add(uniform[i].token);
    if (distinct.size >= MIN_DISTINCT) {
      return { startIndex: uniform[left].index, endIndex: uniform[right].index + uniform[right].token.length };
    }
  }
  return null;
}

/**
 * codeListDetected(text): true when `text` contains a dense, clustered
 * run of >= MIN_DISTINCT distinct, similarly-sized code-shaped tokens.
 * Density alone, no keyword requirement — used by credential-guard.js's
 * refuseIfTextLeaksSecret for an ELEMENT-SCOPED read, where the caller
 * already chose a specific, narrow selector (so a false positive only
 * costs that one read, not every whole-page `eval` on the site — see
 * codeListNearBackupKeyword below for the whole-page-specific tightening).
 *
 * Pure content heuristic — no DOM, no URL, no page session. Safe to call
 * on any plain string, including text read in-process purely to decide a
 * refusal (never returned to a caller).
 */
function codeListDetected(text) {
  return findCodeCluster(text) !== null;
}

// How close a backup/recovery-style keyword cue must be to the code
// cluster (characters, on EITHER side) before codeListNearBackupKeyword
// fires. Chosen to comfortably cover a heading or lead-in sentence next
// to a code list ("Save these backup codes" right before/after a `<ul>`
// of codes) without being so wide it picks up an unrelated keyword
// elsewhere on a long page.
const KEYWORD_PROXIMITY_CHARS = 300;

// Deliberately NOT exhaustive -- grow this list as real misses get
// reported, same as DEFAULT_SENSITIVE_URL_PATTERNS. Covers the phrasing
// in the ticket's own examples plus close synonyms seen on real
// authenticator/account-security pages.
const BACKUP_CODE_KEYWORD_PATTERNS = [
  /backup[\s-]?codes?/i,
  /recovery[\s-]?codes?/i,
  /save\s+(?:these|your)\s+codes?/i,
  /one[\s-]?time[\s-]?codes?/i,
  /single[\s-]?use[\s-]?codes?/i,
  /verification[\s-]?codes?/i,
  /security[\s-]?codes?/i,
  /authentication[\s-]?codes?/i,
  // "2FA"/"two-factor"/"two-step", loosely followed by the word "codes"
  // within a short span -- covers "Enable 2FA and save these 10 codes"
  // without requiring the exact phrases above.
  /(?:2fa|two[\s-]?factor|two[\s-]?step)\b[\s\S]{0,60}?codes?/i,
];

function nearbyKeyword(text, startIndex, endIndex) {
  const windowStart = Math.max(0, startIndex - KEYWORD_PROXIMITY_CHARS);
  const windowEnd = Math.min(text.length, endIndex + KEYWORD_PROXIMITY_CHARS);
  const windowText = text.slice(windowStart, windowEnd);
  return BACKUP_CODE_KEYWORD_PATTERNS.some((re) => re.test(windowText));
}

/**
 * codeListNearBackupKeyword(text): true when `text` contains a code
 * cluster (same scan as codeListDetected) AND a backup/recovery-style
 * keyword appears within KEYWORD_PROXIMITY_CHARS of that cluster.
 *
 * Used by sensitive-url.js's pageTextReadRefused for the OFF-URL-LIST,
 * NO-MARKER case: a WHOLE-PAGE read (eval has no narrower form at all)
 * only refuses on density when there's also a concrete cue that the page
 * is actually showing backup/recovery codes, not just text that happens
 * to cluster densely (a GitHub PR page's inline JSON, HN's glued
 * rank-number-plus-comment-count). A page already flagged by
 * urlLooksSensitive or a live marker does not need this -- see
 * pageTextReadRefused, which only reaches this function after both of
 * those have already come back negative.
 */
function codeListNearBackupKeyword(text) {
  if (typeof text !== 'string' || !text) return false;
  const cluster = findCodeCluster(text);
  if (!cluster) return false;
  return nearbyKeyword(text, cluster.startIndex, cluster.endIndex);
}

// visibleTextFnSrc: a JS function SOURCE STRING (not a Node function --
// see secret-marker.js's ANCESTOR_MARKED_FN_SRC/INERT_CLONE_FN_SRC for the
// same pattern), embedded into a live-page CDP expression
// (sensitive-url.js's pageTextReadRefused) via Runtime.evaluate, and
// `window.eval`'d against a real DOM (jsdom, or a real browser) in
// code-list-detector.test.mjs's fixture tests -- one source of truth for
// what counts as "visible" on both sides, so a test fixture's measured
// result always matches what ships.
//
// Skips <script>/<style>/<template>/<noscript> content entirely (none of
// it is rendered), and skips any element hidden via the `hidden`
// attribute or an inline display:none/visibility:hidden style (a
// best-effort visibility check using only inline signals, not full CSS
// layout -- see the note below on why not .innerText).
//
// Inserts a text separator at the boundary of each BLOCK-level element
// (BLOCK_TAGS), matching how a browser's innerText reports a line break
// between block boxes -- WITHOUT one at INLINE element boundaries (a/span/
// b/etc.), so a secret deliberately split across adjacent inline spans
// still reads back as one glued token, the same way `rendered-text.js`'s
// innerText usage elsewhere in this codebase relies on. Dropping this
// separator entirely was the root cause of jc's HN false positive: the
// served markup glues each story's rank number directly onto the next
// story's title with no whitespace in the HTML at all ("...145
// comments2.Cloudflare acquires Deno...") -- a flat textContent (or a
// visible-text walk with no separator) reads that as a single token
// ("comments2"), and enough of those glued boundaries cluster into
// something that LOOKS like 6+ distinct, similarly-sized code-shaped
// tokens even though no two of them were ever adjacent in the user's eye.
//
// Why not .innerText directly: .innerText needs full CSS layout (the
// stylesheet cascade, not just inline style=) to know what's actually
// rendered, which jsdom (used for this file's unit tests) does not
// implement at all -- document.body.innerText is `undefined` under
// jsdom, confirmed empirically. This walker is a best-effort, inline-
// style-only visibility check instead, so it behaves identically under
// jsdom and in a real browser: a class-based CSS rule in an external or
// <style> stylesheet that hides an element is invisible to this walker
// the same way it would be to a textContent-based approach, which is a
// known, accepted gap (this detector is a heuristic throughout, not a
// full-layout reimplementation).
const visibleTextFnSrc = `
  const __senVisibleText = (root) => {
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);
    const BLOCK_TAGS = new Set([
      'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'BR', 'CAPTION', 'DD',
      'DETAILS', 'DIALOG', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE',
      'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HGROUP', 'HR',
      'HTML', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY',
      'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL'
    ]);
    let out = '';
    const walk = (node) => {
      if (node.nodeType === 3) { out += node.nodeValue; return; }
      if (node.nodeType !== 1) return;
      if (SKIP_TAGS.has(node.tagName)) return;
      if (node.hidden) return;
      const style = node.style;
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return;
      const isBlock = BLOCK_TAGS.has(node.tagName);
      if (isBlock) out += '\\n';
      const children = node.childNodes;
      for (let i = 0; i < children.length; i++) walk(children[i]);
      if (isBlock) out += '\\n';
    };
    if (root) walk(root);
    return out;
  };
`;

module.exports = {
  codeListDetected,
  codeListNearBackupKeyword,
  findCodeCluster,
  visibleTextFnSrc,
  BACKUP_CODE_KEYWORD_PATTERNS,
  KEYWORD_PROXIMITY_CHARS,
  MIN_DISTINCT,
  MIN_LEN,
  MAX_LEN,
  MIN_NUMERIC_LEN,
  CLUSTER_WINDOW_CHARS,
};
