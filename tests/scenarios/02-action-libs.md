# Scenario 02 — All 12 migrated action libs

**Goal:** Exercise each migrated action lib at least once to surface any regressions in the bridge dispatch.

## Setup

Navigate to `https://www.iana.org/help/example-domains` — it has links, headings, multiple paragraphs. If that doesn't work, fall back to `data:text/html,<h1>Test</h1><a id="link" href="https://example.com">Link</a><input id="i"><select id="s"><option value="a">A</option><option value="b">B</option></select>`.

## Steps (one per lib)

1. **navigation**: navigate to the URL above
2. **extraction (extractText)**: extract the h1 text
3. **extraction (getHtml)**: get the full HTML of the page
4. **extraction (getAttribute)**: get the `href` attribute of the first `<a>` (or `#link`)
5. **evaluation**: evaluate `2 + 2` and confirm result is `4`
6. **mouse (click)**: click the first `<a>` or `#link`. If it navigates away, that's fine — that's a click working.
7. **navigation (back)**: navigate back to the start URL
8. **keyboard-input (fill)**: fill the input with `"hello"` (or skip if no input; report)
9. **select-option**: select the second option in the `<select>` (or skip)
10. **viewport (setViewport)**: set viewport to 800x600
11. **viewport (getViewport)**: read viewport back — should reflect 800x600
12. **screenshot**: take a screenshot, confirm non-empty PNG
13. **cookies (clearCookies)**: clear cookies — should not throw
14. **file-upload**: skip unless there's a `<input type=file>` — just confirm tool exists
15. **capture (auto-capture)**: any of the above that triggers auto-capture should produce a markdown+html artifact

## Pass criteria

- Every lib that's applicable executes without error
- Numeric / string returns match expected
- Any unsupported step (no file input, no select) is reported as "N/A — skipped" rather than treated as failure

## Failure signals

- "is not a function" — migration broke an exported function
- CDP method errors — pageSession.send dispatch is wrong
- Hangs — the Fetch.requestPaused-continueRequest bug from F4 might have come back
- "Page is behind a dialog" when no dialog should be open — dialog state leaking

Report the matrix: 14 libs × pass / fail / skip.
