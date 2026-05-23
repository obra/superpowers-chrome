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
  it('source handles typeof payload === "string" in ATTR case', () => {
    // The fix adds a branch for bare string payloads in the ATTR handler.
    // We look for the pattern in the source.
    const attrSection = srcContent.slice(srcContent.indexOf('BrowserAction.ATTR'));
    const nextCaseIdx = attrSection.indexOf('case BrowserAction', 10);
    const attrHandler = nextCaseIdx > 0 ? attrSection.slice(0, nextCaseIdx) : attrSection.slice(0, 500);
    assert.ok(
      attrHandler.includes("typeof payload === 'string'") ||
      attrHandler.includes('typeof payload === "string"'),
      'ATTR handler should check typeof payload === "string" for bare-string form'
    );
  });
});

// ---------------------------------------------------------------------------
// Fix 2b: drag_drop liberal payload acceptance
// ---------------------------------------------------------------------------

describe('Fix 2b: drag_drop accepts bare string and bare {x,y} payload', () => {
  it('source handles bare string payload in DRAG_DROP case', () => {
    const dragSection = srcContent.slice(srcContent.indexOf('BrowserAction.DRAG_DROP'));
    const nextCaseIdx = dragSection.indexOf('case BrowserAction', 10);
    const dragHandler = nextCaseIdx > 0 ? dragSection.slice(0, nextCaseIdx) : dragSection.slice(0, 600);
    assert.ok(
      dragHandler.includes("typeof payload === 'string'") ||
      dragHandler.includes('typeof payload === "string"'),
      'DRAG_DROP handler should accept bare string payload'
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
  it('source returns "Error: Element not found: <selector>" from extract', () => {
    assert.ok(
      srcContent.includes('Error: Element not found:'),
      'extract handler should prefix "Error:" before "Element not found:"'
    );
  });

  it('extract error prefix starts with "Error:" like click errors', () => {
    // Ensure the pattern is consistent with how click errors are surfaced
    const extractSection = srcContent.slice(srcContent.indexOf('BrowserAction.EXTRACT'));
    const nextCase = extractSection.indexOf('case BrowserAction', 10);
    const extractHandler = nextCase > 0 ? extractSection.slice(0, nextCase) : extractSection.slice(0, 800);
    assert.ok(
      extractHandler.includes('Error: Element not found'),
      'extract handler should produce "Error: Element not found: <selector>"'
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
  it('EXTRACT handler calls parsePayload with defaultKey="format"', () => {
    // Earlier code used parsePayload(payload, 'selector') which silently
    // routed payload="html" into selector="html" and left format="text"
    // (the default). Regression caught by scenario 02 step 3.
    // Match against the executable line specifically (no comment lines start
    // with `const p = parsePayload`).
    assert.match(
      srcContent,
      /const p = parsePayload\(payload,\s*['"]format['"]\)/,
      'EXTRACT handler should use parsePayload(payload, "format") on the executable line'
    );
  });

  it('bundle reflects the parsePayload("format") form', () => {
    // The bundle goes to users; make sure the source fix actually shipped.
    // The bundle has no comments, so a plain substring search is enough.
    assert.ok(
      bundleSrc.includes('parsePayload(payload, "format")') ||
      bundleSrc.includes("parsePayload(payload, 'format')"),
      'bundle should include the parsePayload(payload, "format") call'
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
