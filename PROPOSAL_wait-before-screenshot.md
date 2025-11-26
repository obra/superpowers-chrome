## Proposal: wait hooks for reliable auto screenshots

- Problem: auto screenshots fire immediately after actions; animated dialogs are still hidden (opacity/transform), so captures can miss them even though they exist in the DOM.
- Impact: screenshots may show the underlying page instead of the UI the user just opened.
- Fix: allow an optional post-action delay (`waitAfterActionMs`) and a screenshot `waitForVisible` on a selector before capture. Defaults stay lightweight to avoid regressions.
- Identified and prepared by Codex CLI (GPT-5) while debugging missing controls in captured images.
