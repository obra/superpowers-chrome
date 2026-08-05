/**
 * Payload normalization for the use_browser tool's `payload` parameter.
 *
 * `payload` is declared as `z.union([z.string(), z.record(z.any())])` —
 * every action accepts either a real object or a string. The string form
 * exists because MCP clients frequently JSON.stringify their arguments
 * regardless of the target action's shape (see e.g. the mouse_move example
 * in skills/browsing/SKILL.md, which passes
 * `payload: "{\"x\":100,\"y\":200}"`).
 *
 * Historically, a string payload was never JSON.parse'd — it was wrapped
 * literally as `{ [defaultKey]: <the raw string> }`. That's correct for
 * actions whose payload IS free text or code (eval's JS source, type's
 * literal text, await_text's search string — see PAYLOAD_SPECS below), but
 * wrong for actions whose payload is a multi-field object with no
 * legitimate bare-string meaning (set_viewport's {width,height},
 * mouse_move's {x,y}): a caller who JSON.stringify'd `{width:390,
 * height:844}` got back a payload of `{ viewport: '{"width":390,...}' }`,
 * `vp.width` was `undefined`, and the action threw "requires payload with
 * width and height" — even though both were supplied, just encoded as a
 * string instead of passed as an object.
 *
 * This module is the single place that decides, per action, whether a
 * string payload should be treated as encoded JSON to deserialize
 * ('structured') or taken literally as the value itself ('scalar' — code
 * or free text). It has no side effects and doesn't touch chrome-ws, so it
 * can be imported directly by tests without booting a browser or an MCP
 * server.
 */

export type PayloadKind = 'structured' | 'scalar';

export interface PayloadSpec {
  kind: PayloadKind;
  /** The object key a bare (non-JSON, or not-an-object) string payload is wrapped under. */
  defaultKey: string;
  /**
   * True when defaultKey is semantically an INTEGER, so a bare numeric
   * string payload should be wrapped as a number rather than as the raw
   * string. Declared here (not special-cased in the action's handler) so
   * the per-action shape table stays the single source of truth for how a
   * string payload is interpreted.
   *
   * Only get_console_messages sets this: its `since` is an epoch-ms
   * timestamp, and a caller passing the bare string '1785900000000' plainly
   * means that instant. Deliberately NOT set for switch_tab, whose bare
   * string is ALSO legitimately a URL/title substring — it resolves numeric
   * vs. substring itself, and coercing here would change which branch a
   * numeric-looking string takes.
   */
  numericDefaultKey?: boolean;
}

/**
 * Per-action payload shape declaration — the source of truth Postel's-law
 * string handling is driven from.
 *
 * kind: 'scalar' — the string IS the value. NEVER JSON.parse'd, no matter
 * how JSON-ish it looks. This is for code or free text where a payload of
 * `[1,2]` or `{"a":1}` is a perfectly normal *literal* value and silently
 * reinterpreting it would change what a currently-working call does:
 * eval (JS source), type (literal text to type), await_text (literal text
 * to wait for), select (a dropdown option's literal value/text).
 *
 * kind: 'structured' — the payload is semantically an object with named
 * fields. A string payload is JSON.parse'd; if it parses to a plain
 * object, that object *is* the payload (Postel's law: a stringified
 * encoding of the object form works the same as passing the object
 * directly). If it parses to an array, the array is wrapped under
 * defaultKey (file_upload's `files` may legitimately be a JSON array of
 * paths). If parsing fails, or produces something else, parsePayload()
 * falls back to the historical literal-wrap under defaultKey — most
 * 'structured' actions also have a legitimate single-value bare-string
 * form (navigate's URL, a CSS selector, an attribute/key/profile name, a
 * file path, a format keyword) so a non-JSON string must still work
 * exactly as it always has, not error out.
 *
 * Two actions — set_viewport and mouse_move — are 'structured' with NO
 * legitimate bare-string fallback at all (there's no sensible single
 * string that means "width and height" or "x and y"). Those two use
 * resolveStrictStructuredPayload() below instead of parsePayload(), so a
 * string that isn't parseable JSON produces an honest error instead of
 * being silently wrapped and then failing a field check with a misleading
 * "missing" message.
 *
 * scroll and drag_drop are NOT listed here: their bare-string form maps to
 * a *different* field than their object form's defaultKey would (scroll's
 * bare string is a direction keyword, not a deltaX/deltaY value; drag_drop's
 * bare string is the *target* selector, not the *source*), and drag_drop
 * additionally has a bare-coordinates form. A single generic
 * `{ [defaultKey]: string }` wrap can't express that, so they keep bespoke
 * dispatch in index.ts — but that dispatch uses the same tryParseJsonObject()
 * primitive defined below instead of ad hoc inline JSON.parse calls.
 */
export const PAYLOAD_SPECS: Record<string, PayloadSpec> = {
  navigate: { kind: 'structured', defaultKey: 'url' },
  type: { kind: 'scalar', defaultKey: 'text' },
  extract: { kind: 'structured', defaultKey: 'format' },
  screenshot: { kind: 'structured', defaultKey: 'path' },
  select: { kind: 'scalar', defaultKey: 'value' },
  eval: { kind: 'scalar', defaultKey: 'expression' },
  attr: { kind: 'structured', defaultKey: 'attr' },
  await_element: { kind: 'structured', defaultKey: 'selector' },
  await_text: { kind: 'scalar', defaultKey: 'text' },
  new_tab: { kind: 'structured', defaultKey: 'url' },
  set_profile: { kind: 'structured', defaultKey: 'name' },
  file_upload: { kind: 'structured', defaultKey: 'files' },
  keyboard_press: { kind: 'structured', defaultKey: 'key' },
  get_console_messages: { kind: 'structured', defaultKey: 'since', numericDefaultKey: true },
  switch_tab: { kind: 'structured', defaultKey: 'tab' },
};

/** Truncate a string for embedding in an error message. */
export function truncateForError(s: string, max = 80): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * The one JSON-decode primitive every string-payload path is built on.
 *
 * Both callers want the same thing — "parse this string IF it's JSON of the
 * shape I expect, otherwise tell me nothing and let me keep the literal
 * string" — so the mechanics (prefix gate, try/catch, shape check) live
 * here once instead of being spelled out twice.
 *
 * `opener` is the character a JSON value of the wanted shape must start
 * with ('{' for an object, '[' for an array). Gating on it keeps CSS
 * attribute selectors like `[data-foo]` (start with '[', NOT valid JSON)
 * and other bare strings from even being offered to JSON.parse.
 *
 * `trimBeforeParse` exists because the two historical idioms differed here
 * and collapsing them would change behavior (see the comment on
 * parsePayload's structured path):
 *   - true  -> the trimmed string is parsed (tryParseJsonObject's long-
 *              standing behavior, used by scroll/drag_drop).
 *   - false -> the raw string is parsed, so leading characters JSON.parse
 *              itself rejects (a BOM, a non-breaking space — JSON.parse
 *              only accepts space/\t/\n/\r as whitespace) keep failing to
 *              parse and fall back to the literal wrap, exactly as
 *              parsePayload has always done.
 * The prefix gate always looks at the trimmed string; only what gets handed
 * to JSON.parse differs.
 */
function tryParseJsonShape(
  payload: unknown,
  opener: '{' | '[',
  trimBeforeParse: boolean
): unknown {
  if (typeof payload !== 'string') return undefined;
  const trimmed = payload.trim();
  if (!trimmed.startsWith(opener)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimBeforeParse ? trimmed : payload);
  } catch {
    // Not valid JSON — caller keeps the original literal string.
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const wantArray = opener === '[';
  return Array.isArray(parsed) === wantArray ? parsed : undefined;
}

/**
 * Attempt to JSON.parse a string payload into a plain object (never an
 * array — callers that want array results, like file_upload's file list,
 * handle that themselves). Returns undefined if the input isn't a string,
 * doesn't look JSON-shaped, or fails to parse / doesn't parse to a plain
 * object. Deliberately conservative: only strings starting with '{' are
 * attempted, so CSS attribute selectors like `[data-foo]` (which start
 * with '[' and are NOT valid JSON) are never at risk of misinterpretation.
 */
export function tryParseJsonObject(payload: unknown): Record<string, any> | undefined {
  return tryParseJsonShape(payload, '{', true) as Record<string, any> | undefined;
}

/**
 * True-integer parse for values that are semantically integers (epoch-ms
 * timestamps). Accepts a number that is already an integer, or a string of
 * plain digits with an optional leading '-'. Deliberately rejects floats
 * ('1.5'), exponent notation ('1e3'), hex, whitespace-only, empty strings
 * and anything outside the safe-integer range: an epoch-ms value is an
 * integer, and a caller who sent something else more likely has a bug than
 * an intent, so the caller reports it rather than guessing.
 */
export function tryParseIntegerValue(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Resolve get_console_messages' `since` filter to epoch ms.
 *
 * Three outcomes, mirroring resolveStrictStructuredPayload's honest split:
 *   - absent (no payload / no `since`) -> {} : return every message, the
 *     long-standing default.
 *   - usable -> { ms } : a number, or a bare/embedded integer string, so
 *     payload '1785900000000' behaves exactly like {since:1785900000000}.
 *   - unusable -> { errorDetail } : `since` WAS supplied but can't be a
 *     timestamp ('yesterday', '1.5', true, {}). Previously these were
 *     silently dropped and every message was returned as if no filter had
 *     been asked for — the same quiet-wrong-answer class as the misleading
 *     "missing fields" error this module was written to fix.
 *
 * Non-integer FINITE numbers are accepted (and floored by Date) rather than
 * rejected, preserving the historical `typeof since === 'number'` behavior
 * for callers already passing one.
 */
export function resolveConsoleSince(value: unknown): { ms?: number; errorDetail?: string } {
  if (value === undefined || value === null) return {};
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return { ms: value };
    return { errorDetail: `since must be an epoch-ms timestamp, got the non-finite number ${String(value)}` };
  }
  const asInteger = tryParseIntegerValue(value);
  if (asInteger !== undefined) return { ms: asInteger };
  const shown = typeof value === 'string' ? truncateForError(value) : typeof value;
  return {
    errorDetail: `since must be an epoch-ms timestamp (a number, or a string of digits), got ${shown}`,
  };
}

/**
 * Attempt to JSON.parse a string into {x,y} coordinates. Returns undefined
 * if it isn't a string, isn't valid JSON, or doesn't have numeric x/y.
 */
export function tryParseCoords(payload: unknown): { x: number; y: number } | undefined {
  const obj = tryParseJsonObject(payload);
  if (obj && typeof obj.x === 'number' && typeof obj.y === 'number') {
    return { x: obj.x, y: obj.y };
  }
  return undefined;
}

/**
 * Explain why a scroll payload string wasn't a usable {deltaX,deltaY}
 * shape, once it's already failed the direction-keyword check and the
 * tryParseJsonObject() decode. Two distinct causes, same as
 * resolveStrictStructuredPayload's split:
 *   (a) the string wasn't valid JSON at all
 *   (b) it was valid JSON but not an object (e.g. '[1,2]', '5') —
 *       previously reported with an EMPTY detail, silently dropping the
 *       "payload parsed but wasn't the right shape" information that
 *       every other structured action's error already gives.
 */
export function describeUnusableScrollPayload(payload: string): string {
  try {
    JSON.parse(payload);
  } catch {
    return `payload was a string that could not be parsed as JSON: ${truncateForError(payload)}`;
  }
  return `payload was valid JSON but not an object with deltaX/deltaY (or a recognized direction string): ${truncateForError(payload)}`;
}

/**
 * Coerce a payload to an object per the action's PayloadSpec.
 *
 *  - undefined/null payload -> {}
 *  - object payload -> returned as-is (unchanged; this path never had a bug)
 *  - string payload, kind 'scalar' -> always `{ [defaultKey]: payload }`,
 *    literally, never parsed — this is the code/free-text exemption.
 *  - string payload, kind 'structured' -> decoded via the shared
 *    tryParseJsonShape() primitive. A plain object result is returned
 *    directly. An array result is wrapped under defaultKey (file_upload's
 *    files list). For a spec with numericDefaultKey, a bare integer string
 *    is wrapped as a NUMBER under defaultKey (get_console_messages'
 *    epoch-ms `since`). Anything else (parse failure, or a parsed primitive
 *    like a bare boolean/null) falls back to the literal wrap under
 *    defaultKey, so an existing bare-string call (a URL, a selector, a key
 *    name, a file path, ...) keeps working exactly as before.
 *
 * The object and array decodes go through the same primitive that backs
 * tryParseJsonObject(), so there is one implementation of "maybe-JSON
 * string -> shape" rather than the two idioms this module used to carry.
 * The primitive is called with trimBeforeParse=false here, preserving this
 * path's historical raw-JSON.parse semantics: a JSON string prefixed with
 * something JSON.parse rejects but String.trim() removes (a BOM, a
 * non-breaking space) has always fallen back to the literal wrap for these
 * actions, and it still does. That single flag is the ONE difference left
 * between the two callers, and it is deliberate — collapsing it would
 * change behavior for whichever side lost its policy.
 */
export function parsePayload(
  payload: string | Record<string, any> | undefined | null,
  action: keyof typeof PAYLOAD_SPECS
): Record<string, any> {
  const spec = PAYLOAD_SPECS[action];
  if (!spec) {
    throw new Error(`parsePayload: no PayloadSpec registered for action "${action}"`);
  }
  if (payload === undefined || payload === null) return {};
  if (typeof payload !== 'string') return payload as Record<string, any>;

  if (spec.kind === 'scalar') {
    return { [spec.defaultKey]: payload };
  }

  // kind === 'structured'
  const asObject = tryParseJsonShape(payload, '{', false) as Record<string, any> | undefined;
  if (asObject) return asObject;

  const asArray = tryParseJsonShape(payload, '[', false) as any[] | undefined;
  if (asArray) return { [spec.defaultKey]: asArray };

  if (spec.numericDefaultKey) {
    const asInteger = tryParseIntegerValue(payload);
    if (asInteger !== undefined) return { [spec.defaultKey]: asInteger };
  }

  return { [spec.defaultKey]: payload };
}

/**
 * Result of resolving a "strict structured" payload — one with NO
 * legitimate bare-string meaning at all (set_viewport, mouse_move). Either
 * `object` is set (a real object to read fields from) or `errorDetail` is
 * set (a human-readable reason suitable for embedding in the action's
 * error message), never both.
 */
export type StrictStructuredResult =
  | { object: Record<string, any>; errorDetail?: undefined }
  | { object?: undefined; errorDetail: string };

/**
 * Resolve a payload for an action whose shape is ALWAYS an object with no
 * valid bare-string fallback. Distinguishes the three distinct caller
 * mistakes the old generic "requires payload with X and Y" message
 * collapsed into one:
 *   (a) no payload was supplied at all
 *   (b) payload was a string that isn't valid JSON
 *   (c) payload was valid JSON but not a plain object (e.g. a bare number)
 * Missing/invalid individual fields (width without height, x without y)
 * are NOT this function's job — the caller checks those on the returned
 * object and can report exactly which field was missing, now that it's
 * looking at a genuinely-parsed object instead of a stray string.
 */
export function resolveStrictStructuredPayload(
  payload: string | Record<string, any> | undefined | null
): StrictStructuredResult {
  if (payload === undefined || payload === null) {
    return { errorDetail: 'no payload was supplied' };
  }
  if (typeof payload === 'object') {
    return { object: payload };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return {
      errorDetail: `payload was a string that could not be parsed as JSON: ${truncateForError(payload)}`,
    };
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return { object: parsed as Record<string, any> };
  }
  return {
    errorDetail: `payload was valid JSON but not an object: ${truncateForError(payload)}`,
  };
}
