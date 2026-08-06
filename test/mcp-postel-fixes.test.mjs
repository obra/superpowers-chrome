/**
 * Tests for MCP-layer Postel fixes (liberal payload acceptance) and
 * auto-restart banner behavior.
 *
 * Covers:
 *  - Fix 1: auto-restart banner prepended to first action after Chrome restart
 *  - Fix 2a: attr accepts bare string payload (attribute name)
 *  - Fix 2b: drag_drop accepts bare string and bare {x,y} payload
 *  - Fix 4 (cosmetic): extract error prefix matches click's format
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bundleSrc = fs.readFileSync(
  path.join(__dirname, '..', 'mcp', 'dist', 'index.js'),
  'utf8'
);
const srcFile = path.join(__dirname, '..', 'mcp', 'src', 'index.ts');
const srcContent = fs.readFileSync(srcFile, 'utf8');

// ---------------------------------------------------------------------------
// Fix 1: auto-restart banner
// ---------------------------------------------------------------------------

describe('Fix 1: auto-restart banner in MCP source', () => {
  it('RESTART_BANNER constant is defined in source', () => {
    assert.ok(
      srcContent.includes('RESTART_BANNER') || bundleSrc.includes('Chrome auto-restarted'),
      'source should define RESTART_BANNER or contain the banner text'
    );
  });

  it('banner text includes "about:blank" to indicate URL reset', () => {
    assert.ok(
      srcContent.includes('about:blank') || bundleSrc.includes('about:blank'),
      'banner should mention about:blank'
    );
  });

  it('chromeWasRestarted flag is used in source', () => {
    assert.ok(
      srcContent.includes('chromeWasRestarted'),
      'source should use chromeWasRestarted flag'
    );
  });

  it('startChrome return value is consumed to set chromeWasRestarted', () => {
    // The fix requires checking the boolean returned by startChrome()
    assert.ok(
      srcContent.includes('spawned') || srcContent.includes('chromeWasRestarted = true'),
      'source should set chromeWasRestarted based on startChrome() return value'
    );
  });
});

// ---------------------------------------------------------------------------
// Fix 2a: attr liberal payload acceptance
// ---------------------------------------------------------------------------

describe('Fix 2a: attr accepts bare string payload', () => {
  it("source routes ATTR through the shared parsePayload(payload, 'attr') normalizer", () => {
    // As of the Postel's-law refactor (see mcp/src/payload.ts and
    // test/payload-normalization.test.mjs for the behavioral coverage),
    // the bare-string-is-the-attribute-name case is no longer a bespoke
    // `typeof payload === 'string'` branch inline in the ATTR handler --
    // it's the literal-wrap fallback of parsePayload's 'structured'
    // handling for the 'attr' action, which also now accepts a
    // JSON-encoded {selector,attr} string. This test just checks the
    // handler is wired to that shared mechanism; the actual behavior
    // (bare string AND JSON string AND native object) is covered
    // behaviorally in test/payload-normalization.test.mjs.
    const attrSection = srcContent.slice(srcContent.indexOf('BrowserAction.ATTR'));
    const nextCaseIdx = attrSection.indexOf('case BrowserAction', 10);
    const attrHandler = nextCaseIdx > 0 ? attrSection.slice(0, nextCaseIdx) : attrSection.slice(0, 500);
    assert.ok(
      attrHandler.includes("parsePayload(payload, 'attr')") ||
      attrHandler.includes('parsePayload(payload, "attr")'),
      "ATTR handler should call parsePayload(payload, 'attr')"
    );
  });
});

// ---------------------------------------------------------------------------
// Fix 2b: drag_drop liberal payload acceptance
// ---------------------------------------------------------------------------

describe('Fix 2b: drag_drop accepts bare string and bare {x,y} payload', () => {
  it('source decodes a JSON-shaped string up front, then still accepts a bare string payload in DRAG_DROP case', () => {
    // Since the Postel's-law refactor, DRAG_DROP first runs the payload
    // through tryParseJsonObject() (shared with scroll's decoding) so a
    // JSON-encoded {source,target} string works too; a bare (non-JSON)
    // string still falls through unchanged to the original bare-string =
    // target-selector handling. See test/payload-normalization.test.mjs
    // for the behavioral coverage of both forms.
    const dragSection = srcContent.slice(srcContent.indexOf('BrowserAction.DRAG_DROP'));
    const nextCaseIdx = dragSection.indexOf('case BrowserAction', 10);
    const dragHandler = nextCaseIdx > 0 ? dragSection.slice(0, nextCaseIdx) : dragSection.slice(0, 600);
    assert.ok(
      dragHandler.includes('tryParseJsonObject(payload)'),
      'DRAG_DROP handler should decode a JSON-shaped string via tryParseJsonObject'
    );
    assert.ok(
      dragHandler.includes("typeof decodedPayload === 'string'") ||
      dragHandler.includes('typeof decodedPayload === "string"'),
      'DRAG_DROP handler should still accept a bare string payload (as decodedPayload)'
    );
  });

  it('source handles bare {x,y} object payload without target/source fields in DRAG_DROP', () => {
    const dragSection = srcContent.slice(srcContent.indexOf('BrowserAction.DRAG_DROP'));
    const nextCaseIdx = dragSection.indexOf('case BrowserAction', 10);
    const dragHandler = nextCaseIdx > 0 ? dragSection.slice(0, nextCaseIdx) : dragSection.slice(0, 600);
    // Should check for x/y without requiring a .target field
    assert.ok(
      dragHandler.includes('.x !== undefined') || dragHandler.includes('p.x'),
      'DRAG_DROP handler should detect bare coords object'
    );
  });
});

// ---------------------------------------------------------------------------
// Fix 4 (cosmetic): extract error prefix
// ---------------------------------------------------------------------------

describe('Fix 4: extract error prefix matches click error format', () => {
  // Element-not-found now throws (issue #44) so the catch-all flags it with
  // isError: true; the catch-all's "Error: " prefix keeps the user-visible
  // text identical to the old in-band string and to click's format.
  it('extract handler throws "Element not found: <selector>"', () => {
    const extractSection = srcContent.slice(srcContent.indexOf('BrowserAction.EXTRACT'));
    const nextCase = extractSection.indexOf('case BrowserAction', 10);
    const extractHandler = nextCase > 0 ? extractSection.slice(0, nextCase) : extractSection.slice(0, 800);
    assert.ok(
      extractHandler.includes('throw new Error(`Element not found:'),
      'extract handler should throw "Element not found: <selector>"'
    );
  });

  it('catch-all prefixes "Error:" so extract matches click error format', () => {
    assert.ok(
      srcContent.includes('text: `Error: ${errorMessage}`'),
      'catch-all should surface thrown errors with the "Error:" prefix'
    );
  });
});

// ---------------------------------------------------------------------------
// Fix 5: Postel-accept legacy tab_index parameter (implicit switch_tab)
// ---------------------------------------------------------------------------

describe('Fix 5: tab_index is Postel-accepted as implicit switch_tab', () => {
  it('UseBrowserParams declares an optional tab_index field', () => {
    // Find the schema block and verify tab_index is declared with .optional()
    const schemaStart = srcContent.indexOf('const UseBrowserParams');
    const schemaEnd = srcContent.indexOf('};', schemaStart);
    const schemaBlock = srcContent.slice(schemaStart, schemaEnd);
    assert.ok(
      /tab_index:\s*z\.number\([\s\S]*?\.optional\(\)/.test(schemaBlock),
      'UseBrowserParams should declare tab_index as z.number().int().min(0).optional()'
    );
  });

  it('handler translates tab_index into activeTab assignment', () => {
    // After Zod parse, the handler must mutate activeTab when tab_index is present.
    const handlerStart = srcContent.indexOf('z.object(UseBrowserParams).parse(args)');
    assert.ok(handlerStart > 0, 'should find the Zod parse call in the handler');
    const slice = srcContent.slice(handlerStart, handlerStart + 600);
    assert.ok(
      /params\.tab_index/.test(slice) && /activeTab\s*=\s*params\.tab_index/.test(slice),
      'handler should read params.tab_index and assign it to activeTab'
    );
  });

  it('schema description steers agents to switch_tab', () => {
    const schemaStart = srcContent.indexOf('const UseBrowserParams');
    const schemaEnd = srcContent.indexOf('};', schemaStart);
    const schemaBlock = srcContent.slice(schemaStart, schemaEnd);
    // Find the tab_index entry's describe(...) call
    const tabIndexIdx = schemaBlock.indexOf('tab_index:');
    assert.ok(tabIndexIdx > 0, 'tab_index entry should exist');
    const describeBlock = schemaBlock.slice(tabIndexIdx, tabIndexIdx + 400);
    assert.ok(
      /switch_tab/.test(describeBlock),
      'tab_index description should mention switch_tab as the preferred action'
    );
  });
});

// ---------------------------------------------------------------------------
// Fix 6: extract accepts a bare-string payload as the format
// ---------------------------------------------------------------------------

describe('Fix 6: extract treats bare-string payload as format, not selector', () => {
  // Earlier code used parsePayload(payload, 'selector') which silently
  // routed payload="html" into selector="html" and left format="text"
  // (the default). Regression caught by scenario 02 step 3.
  //
  // Since the Postel's-law refactor, parsePayload(payload, action) takes
  // the action name and looks up its defaultKey from the PAYLOAD_SPECS
  // table in mcp/src/payload.ts, rather than taking the field name
  // directly. The two things this test actually needs to guard — (a) the
  // EXTRACT handler is wired to the 'extract' spec, not a leftover
  // 'selector' one, and (b) that spec's defaultKey really is 'format', not
  // 'selector' — are checked separately below.
  it('EXTRACT handler calls parsePayload(payload, \'extract\')', () => {
    // Match against the executable line specifically (no comment lines start
    // with `const p = parsePayload`).
    assert.match(
      srcContent,
      /const p = parsePayload\(payload,\s*['"]extract['"]\)/,
      'EXTRACT handler should use parsePayload(payload, "extract") on the executable line'
    );
  });

  it("PAYLOAD_SPECS['extract'].defaultKey is 'format', not 'selector'", async () => {
    const { PAYLOAD_SPECS } = await import(
      path.join(__dirname, '..', 'mcp', 'dist', 'payload.js')
    );
    assert.equal(PAYLOAD_SPECS.extract.defaultKey, 'format');
  });

  it('bundle reflects the parsePayload(payload, "extract") call', () => {
    // The bundle goes to users; make sure the source fix actually shipped.
    // The bundle has no comments, so a plain substring search is enough.
    assert.ok(
      bundleSrc.includes('parsePayload(payload, "extract")') ||
      bundleSrc.includes("parsePayload(payload, 'extract')"),
      'bundle should include the parsePayload(payload, "extract") call'
    );
  });
});

// ---------------------------------------------------------------------------
// startChrome return value contract (supports Fix 1)
// ---------------------------------------------------------------------------

describe('startChrome returns boolean: true for new spawn, false for reconnect', () => {
  const chromeSrc = fs.readFileSync(
    path.join(__dirname, '..', 'skills', 'browsing', 'lib', 'chrome-process.js'),
    'utf8'
  );

  it('startChrome returns false when reconnecting to existing Chrome', () => {
    assert.ok(
      chromeSrc.includes('return false;'),
      'startChrome should return false on reconnect/adopt paths'
    );
  });

  it('startChrome returns true when spawning a new Chrome', () => {
    assert.ok(
      chromeSrc.includes('return true;'),
      'startChrome should return true after launching a new Chrome process'
    );
  });
});
