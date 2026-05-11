# Network domain observes requests; Fetch domain intercepts them — Network.requestIntercepted is deprecated, use Fetch.requestPaused

CDP has two overlapping HTTP-flavored domains. Telling them apart is the first thing to get right when adding traffic instrumentation.

**`Network`** is for observation. `Network.enable` turns on a stream of events: `Network.requestWillBeSent`, `Network.responseReceived`, `Network.loadingFinished`, `Network.loadingFailed`. You can read headers, see body sizes, get the response body via `Network.getResponseBody(requestId)` after the response arrives. You *cannot* modify, block, or substitute the request through this domain in the modern protocol. `Network.setRequestInterception` and the related `Network.requestIntercepted` event are deprecated; new code should not call them.

**`Fetch`** is for interception. `Fetch.enable({patterns: [...]})` causes Chrome to pause matching requests and emit `Fetch.requestPaused`. The request hangs until you respond with `Fetch.continueRequest` (let it proceed, optionally with mutations), `Fetch.fulfillRequest` (synthesize a response, never hit the network), or `Fetch.failRequest` (abort with a reason). Patterns filter by URL, resource type, and the request stage (request vs. response — you can pause again after the response headers arrive for response-stage mutations).

The split exists because observation and interception have different cost profiles. Always-on observation of every request is cheap; pausing every request to give your code a chance to mutate it adds round-trips to every page load. Fetch patterns let you opt in narrowly — e.g. "only pause requests to api.example.com" — instead of paying the latency tax universally.

A trap that shows up in practice: enabling `Fetch` without responding to every `requestPaused` event will hang the page. Tests pass with one slow request; production with hundreds of subresources stalls indefinitely. Always wire a "continue everything we don't care about" handler before enabling Fetch in production.

## For superpowers-chrome
The library doesn't currently use either domain in the orchestrator surface; consumers wanting traffic capture or mutation must reach for the page session's raw `send`/`onEvent`. Recommended extension shape: a `pageSession.network` namespace that wraps `Network.enable` and exposes a request observer; a separate `pageSession.intercept(patterns, handler)` that wraps `Fetch.enable` with a default-continue handler to prevent hangs. Keep them separate — bundling them risks consumers paying interception cost when they only wanted observation.

See also: [target-autoattach-vs-discovertargets](target-autoattach-vs-discovertargets.md), [runtime-evaluate-three-modes](runtime-evaluate-three-modes.md)

Sources:
- CDP Network domain: https://chromedevtools.github.io/devtools-protocol/tot/Network/
- CDP Fetch domain: https://chromedevtools.github.io/devtools-protocol/tot/Fetch/
- Deprecation note on `Network.requestIntercepted`: https://chromedevtools.github.io/devtools-protocol/tot/Network/#event-requestIntercepted
