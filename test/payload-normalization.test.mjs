/**
 * Behavioral tests for use_browser's payload normalization
 * (mcp/src/payload.ts, compiled to mcp/dist/payload.js).
 *
 * These EXECUTE the normalization logic — they are not source-text/grep
 * assertions like test/mcp-postel-fixes.test.mjs. That file's tests
 * (e.g. `assert.ok(srcContent.includes('RESTART_BANNER'))`) only check that
 * a string appears somewhere in the source; they can't catch a logic bug.
 * The bug this fix addresses — set_viewport/mouse_move given a
 * JSON-stringified payload throwing "requires payload with width and
 * height" even though both were supplied — shipped despite a test file
 * named "postel fixes" specifically because none of those tests actually
 * called the normalization code.
 *
 * mcp/dist/payload.js is emitted directly by `tsc` (mcp/tsconfig.json has
 * outDir=dist, rootDir=src) as a plain, side-effect-free ES module, so it
 * can be imported here without booting Chrome or an MCP server — unlike
 * mcp/dist/index.js, which runs main() (connects an MCP stdio transport
 * and auto-starts Chrome) as an unconditional side effect of being
 * imported. index.ts re-exports the same functions for completeness, but
 * tests import the payload module directly to avoid that.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  PAYLOAD_SPECS,
  parsePayload,
  resolveStrictStructuredPayload,
  tryParseJsonObject,
  tryParseCoords,
} = await import(path.join(__dirname, '..', 'mcp', 'dist', 'payload.js'));

// ---------------------------------------------------------------------------
// The reported bug and its twin: set_viewport / mouse_move (strict
// structured — no legitimate bare-string form at all).
// ---------------------------------------------------------------------------

describe('set_viewport: stringified JSON payload (the reported bug)', () => {
  it('a JSON-stringified {width,height} object resolves with numeric fields', () => {
    const resolved = resolveStrictStructuredPayload('{"width":390,"height":844}');
    assert.equal(resolved.errorDetail, undefined);
    assert.equal(resolved.object.width, 390);
    assert.equal(resolved.object.height, 844);
  });

  it('produces the SAME resolved object as passing the native object directly', () => {
    const fromString = resolveStrictStructuredPayload('{"width":390,"height":844,"mobile":true}');
    const fromObject = resolveStrictStructuredPayload({ width: 390, height: 844, mobile: true });
    assert.deepEqual(fromString.object, fromObject.object);
  });

  it('a malformed JSON string is reported as malformed JSON, not "missing fields"', () => {
    const resolved = resolveStrictStructuredPayload('{"width":390,"height":');
    assert.equal(resolved.object, undefined);
    assert.match(resolved.errorDetail, /could not be parsed as JSON/);
  });

  it('no payload at all is reported as "no payload", not "missing fields"', () => {
    const resolved = resolveStrictStructuredPayload(undefined);
    assert.equal(resolved.object, undefined);
    assert.match(resolved.errorDetail, /no payload was supplied/);
  });

  it('valid JSON that is not an object (e.g. a bare number) is reported honestly', () => {
    const resolved = resolveStrictStructuredPayload('390');
    assert.equal(resolved.object, undefined);
    assert.match(resolved.errorDetail, /valid JSON but not an object/);
  });

  it('valid JSON object missing required fields resolves (caller checks fields itself)', () => {
    // resolveStrictStructuredPayload's job is only to get to a real object;
    // the width/height-specific "missing" check happens at the call site,
    // which is what lets it produce field-specific error text.
    const resolved = resolveStrictStructuredPayload('{"mobile":true}');
    assert.equal(resolved.errorDetail, undefined);
    assert.equal(resolved.object.width, undefined);
  });
});

describe('mouse_move: stringified JSON payload (the twin of the reported bug)', () => {
  it('a JSON-stringified {x,y} object resolves with numeric fields', () => {
    const resolved = resolveStrictStructuredPayload('{"x":100,"y":200}');
    assert.equal(resolved.errorDetail, undefined);
    assert.equal(resolved.object.x, 100);
    assert.equal(resolved.object.y, 200);
  });

  it('produces the SAME resolved object as passing the native object directly', () => {
    const fromString = resolveStrictStructuredPayload('{"x":100,"y":200,"steps":10}');
    const fromObject = resolveStrictStructuredPayload({ x: 100, y: 200, steps: 10 });
    assert.deepEqual(fromString.object, fromObject.object);
  });

  it('a malformed JSON string is reported as malformed JSON', () => {
    const resolved = resolveStrictStructuredPayload('{"x":100,"y":');
    assert.equal(resolved.object, undefined);
    assert.match(resolved.errorDetail, /could not be parsed as JSON/);
  });

  it('no payload at all is reported as "no payload"', () => {
    const resolved = resolveStrictStructuredPayload(null);
    assert.equal(resolved.object, undefined);
    assert.match(resolved.errorDetail, /no payload was supplied/);
  });
});

// ---------------------------------------------------------------------------
// Regression guard: scalar/text actions are NEVER JSON-parsed, even when
// their literal value happens to look like JSON. This is the guard for
// the whole refactor — a blanket "always JSON.parse strings" rule would
// break every one of these.
// ---------------------------------------------------------------------------

describe('scalar actions: string payload is taken literally, never JSON-parsed', () => {
  it('eval: a JS-array-literal payload ([1,2]) stays a string, is not parsed', () => {
    const p = parsePayload('[1, 2]', 'eval');
    assert.equal(typeof p.expression, 'string');
    assert.equal(p.expression, '[1, 2]');
  });

  it('eval: a JSON-object-shaped payload ({"a":1}) stays a string, is not parsed', () => {
    const p = parsePayload('{"a":1}', 'eval');
    assert.equal(typeof p.expression, 'string');
    assert.equal(p.expression, '{"a":1}');
  });

  it('type: literal text that happens to look like JSON stays a string', () => {
    const p = parsePayload('{"a":1}', 'type');
    assert.equal(typeof p.text, 'string');
    assert.equal(p.text, '{"a":1}');
  });

  it('await_text: literal search text that happens to look like JSON stays a string', () => {
    const p = parsePayload('[1,2]', 'await_text');
    assert.equal(typeof p.text, 'string');
    assert.equal(p.text, '[1,2]');
  });

  it('select: a literal option value that happens to look like JSON stays a string', () => {
    const p = parsePayload('{"a":1}', 'select');
    assert.equal(typeof p.value, 'string');
    assert.equal(p.value, '{"a":1}');
  });

  it('every scalar-kind action in PAYLOAD_SPECS refuses to parse a JSON-object-looking string', () => {
    for (const [action, spec] of Object.entries(PAYLOAD_SPECS)) {
      if (spec.kind !== 'scalar') continue;
      const literal = '{"looksLikeJson":true}';
      const p = parsePayload(literal, action);
      assert.equal(
        p[spec.defaultKey],
        literal,
        `${action} (scalar) should wrap the literal string unchanged under "${spec.defaultKey}"`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Structured (lenient) actions: stringified JSON and native object payloads
// produce the same result, for every 'structured' action in PAYLOAD_SPECS.
// A non-JSON-looking string still falls back to the historical literal
// wrap under defaultKey (so a bare selector/path/name/keyword keeps
// working exactly as before).
// ---------------------------------------------------------------------------

describe('structured actions: stringified JSON payload == native object payload', () => {
  const cases = {
    navigate: { url: 'https://example.com' },
    extract: { format: 'html', selector: '.price' },
    screenshot: { path: 'out.png', fullpage: true },
    attr: { selector: 'a', attr: 'href' },
    await_element: { selector: '#el', timeout: 5000 },
    new_tab: { url: 'https://example.com' },
    set_profile: { name: 'work' },
    keyboard_press: { key: 'Tab', modifiers: { shift: true } },
    get_console_messages: { since: 1716000000000 },
    switch_tab: { tab: 2 },
  };

  for (const [action, obj] of Object.entries(cases)) {
    it(`${action}: JSON.stringify(objectForm) resolves identically to the object itself`, () => {
      const fromString = parsePayload(JSON.stringify(obj), action);
      const fromObject = parsePayload(obj, action);
      assert.deepEqual(fromString, fromObject);
      assert.deepEqual(fromString, obj);
    });
  }

  it('file_upload: a JSON array-of-paths string resolves like a native array', () => {
    const fromString = parsePayload('["/a.pdf","/b.jpg"]', 'file_upload');
    const fromArray = parsePayload({ files: ['/a.pdf', '/b.jpg'] }, 'file_upload');
    assert.deepEqual(fromString, fromArray);
  });

  it('file_upload: a JSON {selector,files} object string resolves like the native object', () => {
    const obj = { selector: '#upload', files: ['/a.pdf'] };
    const fromString = parsePayload(JSON.stringify(obj), 'file_upload');
    const fromObject = parsePayload(obj, 'file_upload');
    assert.deepEqual(fromString, fromObject);
  });

  it('a bare (non-JSON) string still falls back to the literal wrap under defaultKey', () => {
    // Existing behavior for every structured-but-not-strict action must be
    // unchanged: a plain string (a URL, a selector, a keyword, a name...)
    // is not valid JSON, so it's wrapped exactly as it always was.
    assert.deepEqual(parsePayload('https://example.com', 'navigate'), { url: 'https://example.com' });
    assert.deepEqual(parsePayload('.price', 'await_element'), { selector: '.price' });
    assert.deepEqual(parsePayload('href', 'attr'), { attr: 'href' });
    assert.deepEqual(parsePayload('work', 'set_profile'), { name: 'work' });
    assert.deepEqual(parsePayload('screenshot.png', 'screenshot'), { path: 'screenshot.png' });
    assert.deepEqual(parsePayload('Tab', 'keyboard_press'), { key: 'Tab' });
  });

  it('malformed JSON string falls back to literal wrap rather than throwing (lenient actions have a legitimate bare-string meaning)', () => {
    // Unlike set_viewport/mouse_move, these actions DO have a valid
    // bare-string meaning, so an unparseable string is not an error — it's
    // just treated as the literal value, same as always.
    const p = parsePayload('{"path":"out.png"', 'screenshot'); // truncated/invalid JSON
    assert.equal(p.path, '{"path":"out.png"');
  });
});

// ---------------------------------------------------------------------------
// scroll / drag_drop: previously hand-rolled ad hoc JSON.parse fallbacks,
// now folded into the shared tryParseJsonObject/tryParseCoords mechanism.
// These don't go through parsePayload() (their bare-string form maps to a
// different field than their object form's defaultKey), so they're tested
// via the shared primitives + a spot-check that the two forms produce
// equivalent decoded objects.
// ---------------------------------------------------------------------------

describe('scroll / drag_drop: shared JSON-object decoding primitive', () => {
  it('tryParseJsonObject decodes a plain object string', () => {
    assert.deepEqual(tryParseJsonObject('{"deltaX":0,"deltaY":500}'), { deltaX: 0, deltaY: 500 });
  });

  it('tryParseJsonObject returns undefined for a non-JSON string (e.g. a CSS selector)', () => {
    assert.equal(tryParseJsonObject('.container'), undefined);
  });

  it('tryParseJsonObject returns undefined for an attribute selector starting with "["', () => {
    // [data-foo] starts with '[' but is not valid JSON — must not be
    // mistaken for an array/object and must not throw.
    assert.equal(tryParseJsonObject('[data-foo]'), undefined);
  });

  it('tryParseJsonObject returns undefined for malformed JSON (does not throw)', () => {
    assert.equal(tryParseJsonObject('{"deltaX":'), undefined);
  });

  it('tryParseJsonObject returns undefined for a JSON array (object-only helper)', () => {
    assert.equal(tryParseJsonObject('["a","b"]'), undefined);
  });

  it('drag_drop: a JSON-stringified {source,target} object decodes like the native object', () => {
    const obj = { source: '#card', target: '#column-2' };
    assert.deepEqual(tryParseJsonObject(JSON.stringify(obj)), obj);
  });

  it('tryParseCoords decodes a JSON {x,y} string', () => {
    assert.deepEqual(tryParseCoords('{"x":300,"y":200}'), { x: 300, y: 200 });
  });

  it('tryParseCoords returns undefined for a plain selector string (drag_drop target form)', () => {
    assert.equal(tryParseCoords('#target'), undefined);
  });
});

// ---------------------------------------------------------------------------
// PAYLOAD_SPECS sanity: the enumeration itself.
// ---------------------------------------------------------------------------

describe('PAYLOAD_SPECS: the action -> shape declaration table', () => {
  it('covers every action that has a documented multi-field object form', () => {
    const expectedActions = [
      'navigate', 'type', 'extract', 'screenshot', 'select', 'eval', 'attr',
      'await_element', 'await_text', 'new_tab', 'set_profile', 'file_upload',
      'keyboard_press', 'get_console_messages', 'switch_tab',
    ];
    for (const action of expectedActions) {
      assert.ok(PAYLOAD_SPECS[action], `PAYLOAD_SPECS should declare "${action}"`);
      assert.ok(['scalar', 'structured'].includes(PAYLOAD_SPECS[action].kind));
      assert.equal(typeof PAYLOAD_SPECS[action].defaultKey, 'string');
    }
  });

  it('classifies exactly the code/free-text actions as scalar', () => {
    const scalarActions = Object.entries(PAYLOAD_SPECS)
      .filter(([, spec]) => spec.kind === 'scalar')
      .map(([action]) => action)
      .sort();
    assert.deepEqual(scalarActions, ['await_text', 'eval', 'select', 'type']);
  });

  it('parsePayload throws for an action with no registered spec', () => {
    assert.throws(() => parsePayload('x', 'not_a_real_action'), /no PayloadSpec registered/);
  });
});
