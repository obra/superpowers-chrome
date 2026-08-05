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
  describeUnusableScrollPayload,
  resolveConsoleSince,
  tryParseIntegerValue,
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
// scroll: the empty-error-detail bug (obra's review nit on PR #43). A
// string payload that's valid JSON but not a direction keyword or a
// {deltaX,deltaY} object (e.g. '[1,2]', '5') used to reach the throw with
// an EMPTY detail — the JSON.parse-and-discard probe in the old inline
// code succeeded silently instead of explaining the shape mismatch, unlike
// every other structured action's three-way (missing / unparsable /
// wrong-shape) error split.
// ---------------------------------------------------------------------------

describe('scroll: honest detail when a string payload is JSON but not a usable shape', () => {
  it('a JSON array ("[1,2]") is reported as valid JSON but not an object, not left blank', () => {
    const detail = describeUnusableScrollPayload('[1,2]');
    assert.notEqual(detail, '');
    assert.match(detail, /valid JSON but not an object/);
    assert.match(detail, /\[1,2\]/);
  });

  it('a bare JSON number ("5") is reported as valid JSON but not an object, not left blank', () => {
    const detail = describeUnusableScrollPayload('5');
    assert.notEqual(detail, '');
    assert.match(detail, /valid JSON but not an object/);
  });

  it('a string that is not valid JSON at all is still reported as unparsable (unchanged case)', () => {
    const detail = describeUnusableScrollPayload('not json at all {');
    assert.notEqual(detail, '');
    assert.match(detail, /could not be parsed as JSON/);
  });
});

// ---------------------------------------------------------------------------
// get_console_messages: a bare epoch-ms string must work like {since:n}.
// The Postel gap this PR exists to close, and the same honesty class as the
// misleading error: a payload of '1785900000000' used to be wrapped as the
// STRING {since:'1785900000000'}, fail the handler's typeof-number check,
// and be dropped without a word — returning every message as if no filter
// had been asked for.
// ---------------------------------------------------------------------------

describe('get_console_messages: bare numeric string since (the Postel gap)', () => {
  it('a bare epoch-ms string is coerced to a NUMBER under `since`', () => {
    const p = parsePayload('1785900000000', 'get_console_messages');
    assert.equal(p.since, 1785900000000);
    assert.equal(typeof p.since, 'number');
  });

  it('a bare epoch-ms string resolves identically to the {since:n} object form', () => {
    const fromString = parsePayload('1785900000000', 'get_console_messages');
    const fromObject = parsePayload({ since: 1785900000000 }, 'get_console_messages');
    assert.deepEqual(fromString, fromObject);
    assert.deepEqual(
      resolveConsoleSince(fromString.since),
      resolveConsoleSince(fromObject.since)
    );
    assert.equal(resolveConsoleSince(fromString.since).ms, 1785900000000);
  });

  it('the JSON-stringified object form still works (unchanged)', () => {
    const p = parsePayload('{"since":1785900000000}', 'get_console_messages');
    assert.equal(resolveConsoleSince(p.since).ms, 1785900000000);
  });

  it('a non-numeric bare string is an explicit error, never silently ignored', () => {
    const p = parsePayload('yesterday', 'get_console_messages');
    // Not coerced: stays the literal string under the defaultKey...
    assert.equal(p.since, 'yesterday');
    // ...and resolving it reports the problem instead of dropping the filter.
    const resolved = resolveConsoleSince(p.since);
    assert.equal(resolved.ms, undefined);
    assert.match(resolved.errorDetail, /epoch-ms timestamp/);
    assert.match(resolved.errorDetail, /yesterday/);
  });

  it('an absent payload means "no filter" — no error, no since', () => {
    for (const absent of [undefined, null]) {
      const p = parsePayload(absent, 'get_console_messages');
      assert.deepEqual(p, {});
      const resolved = resolveConsoleSince(p.since);
      assert.equal(resolved.ms, undefined);
      assert.equal(resolved.errorDetail, undefined);
    }
  });

  it('a numeric string inside the object form is accepted too', () => {
    const p = parsePayload({ since: '1785900000000' }, 'get_console_messages');
    assert.equal(resolveConsoleSince(p.since).ms, 1785900000000);
  });

  it('a number since keeps its historical leniency (floats pass through)', () => {
    assert.equal(resolveConsoleSince(1785900000000).ms, 1785900000000);
    assert.equal(resolveConsoleSince(1.5).ms, 1.5);
  });

  it('non-timestamp since values are reported, not swallowed', () => {
    for (const bad of ['1.5', '1e3', 'now', '', true, {}, Number.NaN, Number.POSITIVE_INFINITY]) {
      const resolved = resolveConsoleSince(bad);
      assert.equal(resolved.ms, undefined, `${JSON.stringify(bad)} should not resolve`);
      assert.ok(resolved.errorDetail, `${JSON.stringify(bad)} should report an errorDetail`);
    }
  });

  it('the numeric coercion is declared per-action, not hardcoded at a call site', () => {
    assert.equal(PAYLOAD_SPECS.get_console_messages.numericDefaultKey, true);
    // switch_tab's bare string is ALSO legitimately a url/title substring,
    // so it must NOT be coerced here — it resolves numeric-vs-substring itself.
    assert.notEqual(PAYLOAD_SPECS.switch_tab.numericDefaultKey, true);
    assert.equal(parsePayload('1', 'switch_tab').tab, '1');
  });

  it('tryParseIntegerValue accepts integers/digit-strings and rejects the rest', () => {
    assert.equal(tryParseIntegerValue(42), 42);
    assert.equal(tryParseIntegerValue('42'), 42);
    assert.equal(tryParseIntegerValue('-42'), -42);
    assert.equal(tryParseIntegerValue(' 42 '), 42);
    for (const bad of ['1.5', '1e3', '0x10', '', ' ', 'abc', '4 2', 1.5, Number.NaN, null, undefined, {}]) {
      assert.equal(tryParseIntegerValue(bad), undefined, `${JSON.stringify(bad)} should be rejected`);
    }
  });
});

// ---------------------------------------------------------------------------
// Idiom consolidation: parsePayload's structured path and tryParseJsonObject
// are now built on ONE shared decode primitive. These pin the behavior that
// had to survive the consolidation unchanged — including the one difference
// that was deliberately KEPT (see the trimBeforeParse note on parsePayload):
// a JSON string prefixed by something JSON.parse rejects but trim() removes
// (BOM, non-breaking space) still literal-wraps for parsePayload while
// tryParseJsonObject still parses it.
// ---------------------------------------------------------------------------

describe('consolidated JSON decode: behavior preserved on both sides', () => {
  it('structured object strings still parse to the object', () => {
    assert.deepEqual(parsePayload('{"url":"https://x.com"}', 'navigate'), { url: 'https://x.com' });
  });

  it('structured array strings still wrap under defaultKey (file_upload)', () => {
    assert.deepEqual(parsePayload('["/a.txt","/b.txt"]', 'file_upload'), { files: ['/a.txt', '/b.txt'] });
  });

  it('a CSS attribute selector still literal-wraps, never parses as an array', () => {
    assert.deepEqual(parsePayload('[data-foo]', 'await_element'), { selector: '[data-foo]' });
  });

  it('malformed JSON still literal-wraps rather than throwing', () => {
    assert.deepEqual(parsePayload('{"url":', 'navigate'), { url: '{"url":' });
  });

  it('a parsed non-object primitive still literal-wraps (non-numeric specs)', () => {
    assert.deepEqual(parsePayload('5', 'navigate'), { url: '5' });
    assert.deepEqual(parsePayload('true', 'navigate'), { url: 'true' });
  });

  it('scalar actions are still never parsed', () => {
    assert.deepEqual(parsePayload('{"a":1}', 'eval'), { expression: '{"a":1}' });
  });

  it('the one deliberately-kept difference: trim-sensitive JSON prefixes', () => {
    const bom = '\uFEFF{"url":"https://x.com"}';
    // parsePayload parses the RAW string, which JSON.parse rejects for a BOM,
    // so it literal-wraps exactly as it always has.
    assert.deepEqual(parsePayload(bom, 'navigate'), { url: bom });
    // tryParseJsonObject trims first, so it parses — also exactly as before.
    assert.deepEqual(tryParseJsonObject(bom), { url: 'https://x.com' });
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
