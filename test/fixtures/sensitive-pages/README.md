# Sensitive-page fixtures

## `slack-token-types-docs.html`

Slack's real "Tokens" developer-docs page, used by `test/credential-guard-
mcp.test.mjs`'s `"Slack's token-types docs page stays readable"` suite as
an UNLISTED page: a real page that legitimately prints EXAMPLE token
strings to explain their format, which must stay fully readable
(`eval`/`extract` not refused at all) while the existing, unconditional
output-level redaction still masks the example tokens in anything that
actually reaches the agent.

Fetched 2026-10-10 with `curl -sL -A "Mozilla/5.0 ..." <url>` (plain HTTP
GET, matching "served HTML," the same convention `test/lib/fixtures/
code-list-negatives/` uses):

- `https://api.slack.com/authentication/token-types` — redirects to
  `https://docs.slack.dev/authentication/tokens/` (Slack migrated this
  page to a new docs site; the redirect target is what was actually
  fetched and saved).

Trimmed to just the `<article>` element (the real doc content, dropping
the site nav/sidebar/footer chrome) — from ~56KB served down to ~20KB.

Every real example token Slack's own page shows (three `xoxp-`-prefixed
variants in the "rotating a short token secret for a longer secret" code
sample, PLUS the same first example's tail named bare in the surrounding
prose -- "the secret is `<tail>`") is replaced with a placeholder
(`{{EXAMPLE_TOKEN_N}}` for the prefixed examples, `{{EXAMPLE_TOKEN_0_TAIL}}`
for the bare prose mention) in this committed file. The test substitutes
its OWN fake filler of the SAME LENGTH as each real tail before serving
the page over `file://`.

The fake filler is NOT assembled from the real tails' own hex characters
(an earlier version did this via `.join()`, which avoided a literal
match in source but still produced Slack's actual example VALUE once
assembled at runtime). It is plain `'f'.repeat(N)` filler, obviously
fake, at the exact length of each real tail the fixture is standing in
for -- preserving the one thing the test actually needs (a length
boundary: one of the three examples is deliberately 2 characters short
of `TOKEN_PATTERNS`' 20-character minimum, to prove the existing
output-redaction regex does not mask it) without reproducing anything
that looks like a real secret.
