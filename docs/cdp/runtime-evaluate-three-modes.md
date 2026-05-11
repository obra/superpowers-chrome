# Runtime.evaluate has three orthogonal return modes; choosing wrong loses type information or hangs on Promises

`Runtime.evaluate` is the workhorse for "run this JS in the page and get the answer back." Three parameters fundamentally change its semantics:

1. **`returnByValue: true`** — Chrome JSON-serializes the result and ships the value back. The reply's `result.result.value` is what you want. DOM nodes and other host objects become opaque descriptions (`{type: "object", subtype: "node"}`) because JSON-serializing them loses identity. Use this when the expression returns a primitive, plain object, or array of primitives.

2. **`returnByValue: false`** (the default) — Chrome returns a `RemoteObject` handle: `{type, subtype?, objectId?, description?}`. You can hold the `objectId` and pass it to `Runtime.callFunctionOn` for further operations against the same object identity. This is the path you take when you need to manipulate DOM nodes from outside, hold a reference across calls, or inspect a complex shape without losing it to JSON.

3. **`awaitPromise: true`** — if the expression evaluates to a Promise, Chrome waits and returns the resolved value (subject to `returnByValue` rules). Without this, your `result.value` is the Promise object itself, which serializes to `{type: "object", subtype: "promise"}` and is useless. *This is the foot-gun for async code* — forgetting it and getting back "Promise" descriptors instead of the awaited value is the most common cause of "why is my eval returning nothing?"

Two more details that aren't optional:

- **`exceptionDetails`**: if the expression threw (including an unhandled rejection when `awaitPromise: true`), the reply contains a top-level `exceptionDetails` object alongside `result`. The `result` field is *not* an error — it's the thrown value's RemoteObject (often a string description). Library code must check `exceptionDetails` and surface it, otherwise the caller silently sees a stringified `Error: ...` masquerading as a return value.

- **`contextId` / `uniqueContextId`**: if omitted, the eval runs in the page's default world. To eval in an isolated world (e.g. one you created via `Page.createIsolatedWorld`), pass the world's context id. `uniqueContextId` is the cross-process-safe variant — recommended for any new code.

## For superpowers-chrome
The library wraps `Runtime.evaluate` in `lib/evaluation.js` and provides three variants: `evaluate` (returnByValue + awaitPromise), `evaluateJson` (wraps the expression to tag DOM nodes), and `evaluateRaw` (returnByValue: false). All three call `throwIfExceptionDetails` to surface thrown errors. An advanced consumer who needs to hold an objectId across calls should reach for `evaluateRaw`; one who wants typed handling of DOM-vs-primitive returns should reach for `evaluateJson`.

See also: [isolated-worlds-and-execution-contexts](isolated-worlds-and-execution-contexts.md), [navigation-listener-ordering-race](navigation-listener-ordering-race.md)

Sources:
- CDP Runtime domain: https://chromedevtools.github.io/devtools-protocol/tot/Runtime/
- `superpowers-chrome/skills/browsing/lib/evaluation.js`
- gauntlet commit 95910fe (throw on Runtime.evaluate exceptionDetails — the bug this prevents)
