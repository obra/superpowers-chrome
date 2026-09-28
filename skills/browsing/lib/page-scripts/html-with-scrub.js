// Page-side script: loaded as a string and embedded in CDP
// Runtime.evaluate by lib/capture.js.
//
// Returns { raw, scrubbed }:
//   - `raw` is the plain document.documentElement.outerHTML. It is fed
//     unchanged into the credential-shape scan (lib/credential-guard.js),
//     so existing shape/marker detection (a token typed into a field, or a
//     data-sen-secret marker) keeps working exactly as before.
//   - `scrubbed` is the same serialization taken from a detached clone
//     with the `value` attribute and every `data-*` attribute removed
//     from input[type="password"], input[autocomplete="one-time-code"],
//     and any element carrying data-sen-secret. The clone is never
//     attached to the document, so this never touches the live page: the
//     real fields keep whatever the user typed and the form still submits.
//
// Why: outerHTML normally only reflects a field's *attribute*, not the
// live value a user typed — but a page's own change handler can mirror
// `.value` into an attribute (e.g. `setAttribute('data-initial-value', v)`
// for as-you-type validation UI, or straight onto `value` itself). That
// mirrored copy has no fixed shape a regex can recognize (a password or a
// 6-digit one-time code doesn't look like a Slack/GitHub/1Password
// token), so it sails past the shape-based guard. Auto-capture writes
// `scrubbed`, not `raw`, whenever the page isn't suppressed outright, so
// that mirrored copy never lands in the .html file on disk.
module.exports = `
  (() => {
    const raw = document.documentElement.outerHTML;
    const clone = document.documentElement.cloneNode(true);
    const SENSITIVE_SELECTOR =
      'input[type="password"], input[autocomplete="one-time-code"], [data-sen-secret]';
    for (const el of clone.querySelectorAll(SENSITIVE_SELECTOR)) {
      el.removeAttribute('value');
      for (const name of el.getAttributeNames()) {
        if (name.indexOf('data-') === 0) el.removeAttribute(name);
      }
    }
    return { raw, scrubbed: clone.outerHTML };
  })()
`;
