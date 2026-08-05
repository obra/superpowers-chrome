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
export declare const PAYLOAD_SPECS: Record<string, PayloadSpec>;
/** Truncate a string for embedding in an error message. */
export declare function truncateForError(s: string, max?: number): string;
/**
 * Attempt to JSON.parse a string payload into a plain object (never an
 * array — callers that want array results, like file_upload's file list,
 * handle that themselves). Returns undefined if the input isn't a string,
 * doesn't look JSON-shaped, or fails to parse / doesn't parse to a plain
 * object. Deliberately conservative: only strings starting with '{' are
 * attempted, so CSS attribute selectors like `[data-foo]` (which start
 * with '[' and are NOT valid JSON) are never at risk of misinterpretation.
 */
export declare function tryParseJsonObject(payload: unknown): Record<string, any> | undefined;
/**
 * Attempt to JSON.parse a string into {x,y} coordinates. Returns undefined
 * if it isn't a string, isn't valid JSON, or doesn't have numeric x/y.
 */
export declare function tryParseCoords(payload: unknown): {
    x: number;
    y: number;
} | undefined;
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
export declare function describeUnusableScrollPayload(payload: string): string;
/**
 * Coerce a payload to an object per the action's PayloadSpec.
 *
 *  - undefined/null payload -> {}
 *  - object payload -> returned as-is (unchanged; this path never had a bug)
 *  - string payload, kind 'scalar' -> always `{ [defaultKey]: payload }`,
 *    literally, never parsed — this is the code/free-text exemption.
 *  - string payload, kind 'structured' -> JSON.parse attempted. A plain
 *    object result is returned directly. An array result is wrapped under
 *    defaultKey (file_upload's files list). Anything else (parse failure,
 *    or a parsed primitive like a bare number/boolean/null) falls back to
 *    the literal wrap under defaultKey, so an existing bare-string call
 *    (a URL, a selector, a key name, a file path, ...) keeps working
 *    exactly as before.
 */
export declare function parsePayload(payload: string | Record<string, any> | undefined | null, action: keyof typeof PAYLOAD_SPECS): Record<string, any>;
/**
 * Result of resolving a "strict structured" payload — one with NO
 * legitimate bare-string meaning at all (set_viewport, mouse_move). Either
 * `object` is set (a real object to read fields from) or `errorDetail` is
 * set (a human-readable reason suitable for embedding in the action's
 * error message), never both.
 */
export type StrictStructuredResult = {
    object: Record<string, any>;
    errorDetail?: undefined;
} | {
    object?: undefined;
    errorDetail: string;
};
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
export declare function resolveStrictStructuredPayload(payload: string | Record<string, any> | undefined | null): StrictStructuredResult;
//# sourceMappingURL=payload.d.ts.map