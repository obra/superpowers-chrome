# Code-list density false-positive fixtures (PRI-3360 round 2, jc review of #65)

Real, served HTML for pages jc found tripping the code-list density
heuristic via `document.body.textContent` (pre-fix) — `eval`/whole-page
`extract` would have been refused outright on every one of these,
with no narrower form for `eval` to fall back to.

Fetched with `curl -sL -A "Mozilla/5.0 ..." <url>` (plain HTTP GET, not a
browser — matches "served HTML," the same thing `document.body.textContent`
sees before any client JS runs) on 2026-10-09:

- `github-pr.html` — `https://github.com/obra/superpowers-chrome/pull/65`
- `github-repo.html` — `https://github.com/obra/superpowers-chrome`
- `github-rest-docs.html` — `https://docs.github.com/en/rest/pulls/pulls`
- `hn-front-page.html` — `https://news.ycombinator.com/`

Trimmed from the original served size (as large as ~880KB for the REST
docs page) by keeping whole top-level `<body>` children up to a size cap
(never cutting mid-tag) rather than a blind byte-offset truncation, which
previously broke the HTML structure badly enough to lose the very content
being tested. `github-rest-docs.html` additionally trims its two real
top-level children separately: the rendered `<div id="__next">`
(capped) and the embedded `<script id="__NEXT_DATA__" type="application/json">`
(sliced to its last ~60KB, which is inert JSON data never executed by
these tests — safe to truncate anywhere) — a Next.js SSR page's full
server-rendered props blob, which is exactly cause (a) in jc's review:
`document.body.textContent` includes `<script>` content, and this
particular script is large enough and ID/hash-dense enough to trip the
heuristic on its own, as confirmed empirically (see
`test/lib/code-list-detector.test.mjs`).

All four are confirmed, by direct measurement against this exact trimmed
HTML:
- **FLAGGED** via `codeListDetected(document.body.textContent)` — the
  pre-fix behavior.
- **clean** via `codeListDetected`/`codeListNearBackupKeyword` run over
  `visibleTextFnSrc`'s visible-text extraction — the post-fix behavior.

Every real identifier/hash/token string in these files is whatever the
site actually served; none of it is a secret (these are public pages),
but they're kept as-served rather than hand-edited, so the exact
token/density shape that caused the false positive is preserved.
