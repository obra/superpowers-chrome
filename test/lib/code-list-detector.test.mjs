import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const { codeListDetected, codeListNearBackupKeyword, visibleTextFnSrc } = require('../../skills/browsing/lib/code-list-detector.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'code-list-negatives');

describe('codeListDetected', () => {
  it('detects a mixed-alnum backup-code list (hyphenated pairs, like real recovery codes)', () => {
    const text = [
      'Your backup codes',
      '7f3k-9d2m',
      'a83f-29dk',
      'qq1z-88mn',
      'x0p4-rr3e',
      '8k2j-m9vd',
      'zz91-3bqa',
    ].join('\n');
    assert.equal(codeListDetected(text), true);
  });

  it('detects a bare 6-digit numeric code list (TOTP-style backup codes)', () => {
    const text = 'Recovery codes: 482910, 839201, 710284, 920817, 118402, 553291';
    assert.equal(codeListDetected(text), true);
  });

  it('detects codes even with surrounding prose, as long as they cluster', () => {
    const text =
      'If you lose access to your authenticator app, use one of these one-time ' +
      'backup codes to sign in: 7f3k-9d2m a83f-29dk qq1z-88mn x0p4-rr3e 8k2j-m9vd ' +
      'zz91-3bqa. Each code can only be used once.';
    assert.equal(codeListDetected(text), true);
  });

  it('does not flag a plain button label', () => {
    assert.equal(codeListDetected('Submit'), false);
  });

  it('does not flag ordinary prose', () => {
    const text =
      'The quick brown fox jumps over the lazy dog near the riverbank at dawn ' +
      'every single morning without fail this year, according to the report.';
    assert.equal(codeListDetected(text), false);
  });

  it('does not flag a short count or a year', () => {
    assert.equal(codeListDetected('You have 3 items in your cart. Checkout before 2026.'), false);
  });

  it('does not flag a changelog (versions are too short once split on dots)', () => {
    const text = 'Changelog: v4.2.1, v4.2.0, v4.1.9, v4.1.8, v4.1.7, v4.1.6, v4.1.5';
    assert.equal(codeListDetected(text), false);
  });

  it('does not flag a sequentially-numbered SKU table', () => {
    const text =
      'SKU-1001 widget, SKU-1002 gadget, SKU-1003 gizmo, SKU-1004 doohickey, ' +
      'SKU-1005 thingamajig, SKU-1006 contraption';
    assert.equal(codeListDetected(text), false);
  });

  it('does not flag an inline <code> snippet (too few distinct tokens)', () => {
    const text = 'Run `npm install --save-dev @biomejs/biome` to add the linter.';
    assert.equal(codeListDetected(text), false);
  });

  it('does not flag codes spread far apart across a long document (not clustered)', () => {
    const filler = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod. '.repeat(20);
    const text = `7f3k-9d2m ${filler} a83f-29dk ${filler} qq1z-88mn ${filler} x0p4-rr3e ${filler} 8k2j-m9vd ${filler} zz91-3bqa`;
    assert.equal(codeListDetected(text), false);
  });

  it('treats non-strings and empty strings as not code-listed', () => {
    assert.equal(codeListDetected(''), false);
    assert.equal(codeListDetected(null), false);
    assert.equal(codeListDetected(undefined), false);
    assert.equal(codeListDetected(42), false);
  });

  it('requires at least 6 distinct codes -- 5 similar codes do not trigger it', () => {
    // Each hyphenated pair contributes TWO qualifying tokens (the left
    // and right half), so this uses single bare-numeric codes instead --
    // one qualifying token per code -- to actually exercise the 5-vs-6
    // boundary.
    const text = 'Recovery codes: 482910, 839201, 710284, 920817, 118402';
    assert.equal(codeListDetected(text), false);
  });
});

// PRI-3360 round 2 (jc review of #65): codeListNearBackupKeyword is the
// gate sensitive-url.js's pageTextReadRefused actually uses for the
// off-URL-list, no-marker case -- density ALONE is no longer sufficient
// for a WHOLE-PAGE refusal (eval has no narrower form to fall back to).
// codeListDetected (density alone) is unchanged and still used by
// credential-guard.js's ELEMENT-scoped check, where a false positive only
// costs the one read the caller already scoped.
describe('codeListNearBackupKeyword', () => {
  it('refuses a mixed-alnum code list with "backup codes" nearby', () => {
    const text = 'Save these backup codes:\n7f3k-9d2m\na83f-29dk\nqq1z-88mn\nx0p4-rr3e\n8k2j-m9vd\nzz91-3bqa';
    assert.equal(codeListNearBackupKeyword(text), true);
  });

  it('refuses a numeric code list with "recovery codes" nearby', () => {
    const text = 'Your recovery codes: 482910, 839201, 710284, 920817, 118402, 553291';
    assert.equal(codeListNearBackupKeyword(text), true);
  });

  it('refuses with "one-time codes" nearby', () => {
    const text = 'Here are your one-time codes. 482910, 839201, 710284, 920817, 118402, 553291';
    assert.equal(codeListNearBackupKeyword(text), true);
  });

  it('refuses with a "2FA ... codes" cue within the proximity window', () => {
    const text = 'Enable 2FA and save these 6 codes somewhere safe: 482910, 839201, 710284, 920817, 118402, 553291';
    assert.equal(codeListNearBackupKeyword(text), true);
  });

  // The set also covers "single-use" and "verification code(s)" --
  // GitHub, Google and Slack phrase their own code/token pages this
  // way. Dedicated tests for each, in addition to the "one-time codes"
  // case above.
  it('refuses with "single-use codes" nearby (Slack-style phrasing)', () => {
    const text = 'These are your single-use codes -- each one only works once: 482910, 839201, 710284, 920817, 118402, 553291';
    assert.equal(codeListNearBackupKeyword(text), true);
  });

  it('refuses with "verification codes" nearby (Google-style phrasing)', () => {
    const text = 'Print or save your verification codes in case you lose your phone: 482910, 839201, 710284, 920817, 118402, 553291';
    assert.equal(codeListNearBackupKeyword(text), true);
  });

  it('refuses with singular "verification code" nearby too', () => {
    const text = 'Your verification code list: 482910, 839201, 710284, 920817, 118402, 553291';
    assert.equal(codeListNearBackupKeyword(text), true);
  });

  it('does NOT refuse a code-dense cluster with no nearby keyword at all', () => {
    const text = '7f3k-9d2m a83f-29dk qq1z-88mn x0p4-rr3e 8k2j-m9vd zz91-3bqa';
    assert.equal(codeListNearBackupKeyword(text), false);
  });

  it('does NOT refuse when the keyword is far outside the proximity window', () => {
    const filler = 'Lorem ipsum dolor sit amet consectetur adipiscing elit. '.repeat(30);
    const text = `backup codes ${filler} 7f3k-9d2m a83f-29dk qq1z-88mn x0p4-rr3e 8k2j-m9vd zz91-3bqa`;
    assert.equal(codeListNearBackupKeyword(text), false);
  });

  it('does NOT refuse ordinary prose that merely contains the word "codes" with no cluster', () => {
    const text = 'Our zip codes database covers every region. See the docs for details.';
    assert.equal(codeListNearBackupKeyword(text), false);
  });

  it('treats non-strings and empty strings as not near-keyword either', () => {
    assert.equal(codeListNearBackupKeyword(''), false);
    assert.equal(codeListNearBackupKeyword(null), false);
    assert.equal(codeListNearBackupKeyword(undefined), false);
  });
});

// PRI-3360 round 2 (jc review of #65, finding 1): real pages jc found
// tripping the density heuristic via document.body.textContent --
// `eval`/whole-page `extract` would have been refused outright on every
// one of these, with no narrower form for `eval` to fall back to. Saved,
// trimmed HTML fixtures (see fixtures/code-list-negatives/README.md for
// provenance and how they were trimmed). Each assertion below is run
// TWICE: once simulating the PRE-FIX behavior (plain body.textContent --
// confirms these fixtures actually reproduce the bug, i.e. this is a RED
// test against pre-fix code) and once against the POST-FIX behavior
// (visibleTextFnSrc's visible-text extraction -- must come back clean).
describe('real-page fixtures that must NOT be refused (jc review of #65)', () => {
  const FIXTURES = ['github-pr.html', 'github-repo.html', 'github-rest-docs.html', 'hn-front-page.html'];

  function loadFixture(name) {
    const html = fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
    // runScripts: 'dangerously' only so window.eval(visibleTextFnSrc + ...)
    // works (same requirement test/lib/extraction.test.mjs's setupJsdom
    // has) -- the fixture's own <script> tag (github-rest-docs.html's
    // __NEXT_DATA__, type="application/json") is never actually executed;
    // jsdom only runs <script> elements it recognizes as JS.
    const dom = new JSDOM(html, { runScripts: 'dangerously' });
    return dom.window;
  }

  for (const name of FIXTURES) {
    it(`${name}: reproduces the pre-fix false positive via plain body.textContent (RED)`, () => {
      const window = loadFixture(name);
      const bodyTextContent = window.document.body.textContent;
      assert.equal(
        codeListDetected(bodyTextContent),
        true,
        `expected ${name}'s raw body.textContent to reproduce the pre-fix false positive -- fixture may need updating`
      );
    });

    it(`${name}: is clean after the fix (visible text only, both density-alone and keyword-gated)`, () => {
      const window = loadFixture(name);
      const visibleText = window.eval(`${visibleTextFnSrc}; __senVisibleText(document.body)`);
      assert.equal(codeListDetected(visibleText), false, `${name} must not be flagged by density alone`);
      assert.equal(codeListNearBackupKeyword(visibleText), false, `${name} must not be flagged by the keyword-gated check either`);
    });
  }
});

// Positive control, same shape as the real-page fixtures above but for a
// genuine backup-codes page: must be refused both pre- and post-fix.
describe('a genuine backup-codes page is refused, visible-text-only or not', () => {
  const BACKUP_CODES_PAGE =
    '<!DOCTYPE html><html><body>' +
    '<h1>Save these backup codes</h1>' +
    '<ul><li>7f3k-9d2m</li><li>a83f-29dk</li><li>qq1z-88mn</li>' +
    '<li>x0p4-rr3e</li><li>8k2j-m9vd</li><li>zz91-3bqa</li></ul>' +
    '<button>Done</button>' +
    '</body></html>';

  it('is flagged via plain body.textContent (pre-fix)', () => {
    const dom = new JSDOM(BACKUP_CODES_PAGE);
    assert.equal(codeListDetected(dom.window.document.body.textContent), true);
  });

  it('is flagged via visible text only, density alone (post-fix, element-scoped path)', () => {
    const dom = new JSDOM(BACKUP_CODES_PAGE, { runScripts: 'dangerously' });
    const visibleText = dom.window.eval(`${visibleTextFnSrc}; __senVisibleText(document.body)`);
    assert.equal(codeListDetected(visibleText), true);
  });

  it('is flagged via visible text, keyword-gated (post-fix, whole-page path)', () => {
    const dom = new JSDOM(BACKUP_CODES_PAGE, { runScripts: 'dangerously' });
    const visibleText = dom.window.eval(`${visibleTextFnSrc}; __senVisibleText(document.body)`);
    assert.equal(codeListNearBackupKeyword(visibleText), true);
  });
});

// PRI-3360 round 2 (jc review of #65, finding 1, cause (b)): HN's front
// page specifically tripped the heuristic even with scripts/styles
// removed, because the served markup glues each story's rank number
// directly onto the next story's title with no whitespace at all
// ("...145 comments2.Cloudflare acquires Deno..."), and a flat text walk
// with no separator reads that boundary as a single token. This isolates
// that exact mechanism in a minimal fixture (no real-page download
// needed to demonstrate it).
describe('visibleTextFnSrc inserts a block-boundary separator (HN-style glued text)', () => {
  const GLUED_PAGE =
    '<!DOCTYPE html><html><body>' +
    '<table>' +
    '<tr><td>1.<a href="/a">Story One</a> 280 points | 145 comments</td></tr>' +
    '<tr><td>2.<a href="/b">Story Two</a> 990 points | 516 comments</td></tr>' +
    '<tr><td>3.<a href="/c">Story Three</a> 222 points | 120 comments</td></tr>' +
    '<tr><td>4.<a href="/d">Story Four</a> 452 points | 96 comments</td></tr>' +
    '<tr><td>5.<a href="/e">Story Five</a> 164 points | 16 comments</td></tr>' +
    '<tr><td>6.<a href="/f">Story Six</a> 547 points | 445 comments</td></tr>' +
    '<tr><td>7.<a href="/g">Story Seven</a> 310 points | 88 comments</td></tr>' +
    '</table>' +
    '</body></html>';

  it('does not glue a comment count onto the next row\'s rank number into one token', () => {
    const dom = new JSDOM(GLUED_PAGE, { runScripts: 'dangerously' });
    const visibleText = dom.window.eval(`${visibleTextFnSrc}; __senVisibleText(document.body)`);
    assert.equal(codeListDetected(visibleText), false);
  });

  it('WOULD be glued without the block-boundary separator (sanity check that the fixture exercises the real mechanism)', () => {
    // Same walk as visibleTextFnSrc but with the block-level \n insertion
    // removed, to confirm this fixture actually exercises the bug
    // visibleTextFnSrc fixes, rather than passing for an unrelated reason.
    const noSeparatorFnSrc = visibleTextFnSrc.replace(/if \(isBlock\) out \+= '\\n';/g, '');
    const dom = new JSDOM(GLUED_PAGE, { runScripts: 'dangerously' });
    const gluedText = dom.window.eval(`${noSeparatorFnSrc}; __senVisibleText(document.body)`);
    assert.equal(codeListDetected(gluedText), true, 'fixture should reproduce the glued-token bug when the separator is removed');
  });
});
