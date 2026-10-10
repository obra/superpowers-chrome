# Sensitive-page fixtures (PRI-3360 round 4)

## `slack-token-types-docs.html`

Slack's real "Tokens" developer-docs page, used by `test/credential-guard-
mcp.test.mjs`'s `"PRI-3360 round 4: Slack's token-types docs page stays
readable"` suite as the UNLISTED page jc's round-4 review named: a real page
that legitimately prints EXAMPLE token strings to explain their format,
which must stay fully readable (`eval`/`extract` not refused at all) while
the existing, unconditional output-level redaction still masks the example
tokens in anything that actually reaches the agent.

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
sample) is replaced with a `{{EXAMPLE_TOKEN_N}}`
placeholder in this committed file — the test substitutes its OWN fake,
assembled-at-runtime token strings of the same shape before serving the
page over `file://`, so no complete token-shaped literal sits in the
fixture on disk (the same reason `FAKE_TOKEN`/`FAKE_SLACK_APP_TOKEN`
elsewhere in this repo's tests are assembled from parts rather than
written as one literal — GitHub push protection rejects those even when
they are obviously fake or, as here, a real public documentation
example).
