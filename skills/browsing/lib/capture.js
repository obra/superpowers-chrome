const fs = require('fs');
const path = require('path');
const { getXdgCacheHome } = require('./chrome-launcher-helpers');
const { generateHtmlDiff } = require('./html-diff');
const { throwIfExceptionDetails } = require('./cdp-utils');
const markdownScript = require('./page-scripts/markdown');
const domSummaryScript = require('./page-scripts/dom-summary');
const renderedTextScript = require('./page-scripts/rendered-text');
const { containsCredentialShaped, credentialCaptureAllowed, secretMarkerRefusal, CREDENTIAL_SUPPRESSED_NOTICE } = require('./credential-guard');
const { pageHasSecretMarker, refreshSecretLatch, isSecretLatched } = require('./secret-marker');

// Only these DOM-summary lines are returned for a suppressed capture: they
// are element counts and landmark structure. The title and headings lines
// are page text and are dropped even when they look harmless, because a
// truncated heading can carry a partial secret the detector can't match.
function suppressedDomSummary(domSummary) {
  return String(domSummary || '')
    .split('\n')
    .filter(line => line.startsWith('Interactive:') || line.startsWith('Layout:'))
    .join('\n');
}

// Module-level registry of active session-cleanup callbacks.
// Per-session initializeSession adds its bound cleanup to the set;
// cleanupSession removes itself when it runs.
//
// Process exit handlers are registered exactly once for the whole module
// (not per session), so multiple ChromeSession instances in one process
// don't accumulate N×3 handlers.
const activeCleanups = new Set();
let processHandlersRegistered = false;

function ensureProcessHandlersRegistered() {
  if (processHandlersRegistered) return;
  processHandlersRegistered = true;
  const runAll = () => { for (const fn of activeCleanups) fn(); };
  process.on('exit', runAll);
  process.on('SIGINT', () => { runAll(); process.exit(0); });
  process.on('SIGTERM', () => { runAll(); process.exit(0); });
}

/**
 * Auto-capture: every DOM-mutating action drops a {prefix}.html / .md / .png /
 * -console.txt set into the session directory so the user (or model) can
 * read what the page looked like instead of re-querying via CDP. The
 * session dir is XDG-rooted at ~/.cache/superpowers/browser/YYYY-MM-DD/
 * session-{timestamp} and is cleaned up on process exit / SIGINT / SIGTERM.
 *
 * Three layers:
 *   - Session lifecycle: initializeSession, cleanupSession, createCapturePrefix.
 *   - Page extractors: generateDomSummary, getPageSize, generateMarkdown.
 *   - Capture primitives: capturePageArtifacts (post-action snapshot) and
 *     captureActionWithDiff (before/after pair with HTML diff and saved
 *     focus restoration around the screenshot).
 *   - WithCapture wrappers: thin adapters that pair an action with a
 *     post-action capturePageArtifacts.
 *
 * `attachCapture({ state, getPageSession, getHtml,
 *                 screenshot, actions: { click, fill, selectOption, evaluate } })`
 * returns the bound API.
 */
function attachCapture({ state, getPageSession, getHtml, screenshot, actions, dialogs }) {
  const { renderSyntheticArtifacts } = require('./dialogs-render.js');
  function initializeSession() {
    if (!state.sessionDir) {
      // ~/.cache/superpowers/browser/YYYY-MM-DD/session-{timestamp}
      const cacheHome = getXdgCacheHome();
      const dateStr = new Date().toISOString().split('T')[0];
      const sessionId = `session-${Date.now()}`;

      state.sessionDir = path.join(cacheHome, 'superpowers', 'browser', dateStr, sessionId);
      fs.mkdirSync(state.sessionDir, { recursive: true });
      state.captureCounter = 0;

      console.error(`Browser session directory: ${state.sessionDir}`);

      ensureProcessHandlersRegistered();
      activeCleanups.add(cleanupSession);
    }
    return state.sessionDir;
  }

  function cleanupSession() {
    if (state.sessionDir) {
      try {
        fs.rmSync(state.sessionDir, { recursive: true, force: true });
        console.error(`Cleaned up session directory: ${state.sessionDir}`);
      } catch (error) {
        console.error(`Failed to cleanup session directory: ${error.message}`);
      }
      state.sessionDir = null;
    }
    activeCleanups.delete(cleanupSession);
  }

  function createCapturePrefix(actionType = 'navigate') {
    initializeSession();
    state.captureCounter++;
    return `${String(state.captureCounter).padStart(3, '0')}-${actionType}`;
  }

  // Token-efficient page summary: heading list, interactive-element counts,
  // main/nav landmark detection. Used in the auto-capture artifact bundle so
  // the model can decide whether to read the .md or .html file.
  async function generateDomSummary(tabIndexOrWsUrl) {
    const ps = await getPageSession(tabIndexOrWsUrl);
    const result = await ps.send('Runtime.evaluate', {
      expression: domSummaryScript,
      returnByValue: true
    });
    throwIfExceptionDetails(result);
    return result.result.value;
  }

  async function getPageSize(tabIndexOrWsUrl) {
    const ps = await getPageSession(tabIndexOrWsUrl);

    const js = `({
      width: window.innerWidth,
      height: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight
    })`;

    const result = await ps.send('Runtime.evaluate', {
      expression: js,
      returnByValue: true
    });
    throwIfExceptionDetails(result);
    return result.result.value;
  }

  // Render the page to markdown for token-efficient consumption. Includes
  // images >= 100x100 in a header summary; inlines image references >= 50x50
  // with size info; skips smaller icons.
  async function generateMarkdown(tabIndexOrWsUrl) {
    const ps = await getPageSession(tabIndexOrWsUrl);
    const result = await ps.send('Runtime.evaluate', {
      expression: markdownScript,
      returnByValue: true
    });
    throwIfExceptionDetails(result);
    return result.result.value;
  }

  // Rendered text the HTML scan can't see: innerText (joins split inline
  // runs), open shadow roots, live input values. See page-scripts/rendered-text.js.
  async function getRenderedText(tabIndexOrWsUrl) {
    const ps = await getPageSession(tabIndexOrWsUrl);
    const result = await ps.send('Runtime.evaluate', {
      expression: renderedTextScript,
      returnByValue: true
    });
    throwIfExceptionDetails(result);
    return result.result.value;
  }

  // obra#52 review round 2, finding 2: mustSuppress above only regexes
  // already-serialized text (outerHTML, rendered text, markdown, dom
  // summary) for either a token shape or a `<... data-sen-secret` tag in
  // markup. That misses a marker living in a shadow root or a same-origin
  // iframe (never serialized into outerHTML) AND it can never see a marker
  // that was present but has since been removeAttribute'd — both real gaps
  // for auto-capture specifically, since auto-capture is what writes a
  // page's FIRST, not-yet-marked appearance to disk, before any later
  // action gets a chance to mark it.
  //
  // This is the single gate every disk-writing capture path must call,
  // checked against the SAME tab reference the content about to be written
  // came from ("that exact state", not an earlier point-in-time check from
  // before the content was fetched): it ORs the regex check with a fresh
  // live-marker scan AND the tab's sticky secret-seen latch (so a page that
  // was marked at any point stays suppressed even if the marker is gone by
  // the time this specific capture runs). If the live check itself cannot
  // complete (a thrown error — CDP failure, timeout, closed session), this
  // fails closed: the check "can't complete" counts as "must suppress",
  // never as "clean", so nothing gets written.
  async function mustSuppressPageState(tabIndexOrWsUrl, ...pageTexts) {
    if (credentialCaptureAllowed()) return false;
    // Compute BOTH signals unconditionally, never short-circuiting past the
    // live check just because the regex already proves suppression: this
    // is also the only place some callers ever refresh the secret-seen
    // latch, and a marker whose serialized tag happens to ALSO match the
    // regex (a plain, non-shadow-root marker) must still get latched here,
    // or a later dialog/console/eval check on this same tab would find no
    // recorded latch to consult.
    const shapeMatch = pageTexts.some(containsCredentialShaped);
    let latched;
    try {
      const ps = await getPageSession(tabIndexOrWsUrl);
      latched = await refreshSecretLatch(state, ps);
    } catch (_err) {
      latched = true;
    }
    return shapeMatch || latched;
  }

  // Dialog-specific variant of the check above, used where the caller (see
  // captureActionWithDiff's after-dialog branch) keeps returning the
  // rendered artifacts even when suppressed, relying on the top-level
  // redactUnlessAllowed regex pass (mcp/src/index.ts) to blank a
  // credential-SHAPED substring from the dialog message before it reaches
  // the agent. That works for a token-shaped secret but not for a marker-
  // latched one: a bare TOTP seed alert()'d from a data-sen-secret element
  // (obra#52 review round 2, finding 1) has no shape for that regex to
  // find. Returns which signal fired, not just whether to suppress, so the
  // caller can tell them apart: shape-only suppression keeps returning the
  // raw artifacts (existing behavior, still redacted later by shape); a
  // latched tab must not, because there is nothing later that can redact a
  // shapeless value — the caller must swap the message text out itself.
  //
  // Deliberately does NOT call refreshSecretLatch (a live Runtime.evaluate
  // round trip) here: this runs while a native dialog is OPEN, and the
  // renderer's JS thread is paused for as long as it is, so a fresh CDP
  // evaluate against this same page can hang until the CDP send timeout
  // fires — turning every dialog action into a many-second stall, and
  // (once it times out) fail-closed would then latch every dialog
  // regardless of shape, not just marker-latched ones, which regressed a
  // passing token-shape test the first time this was tried. Instead this
  // reads the CACHED verdict only (isSecretLatched — a plain map lookup,
  // no CDP call): whatever an earlier action or navigate() already
  // recorded before the dialog opened. That is always available for the
  // cases this guards, since the marker (if any) had to already be on the
  // page, and get scanned by ensureSecretSeenSentinel/pageHasSecretMarker
  // in some prior guarded call, before this dialog could read and alert()
  // its value in the first place.
  async function dialogSuppressionInfo(tabIndexOrWsUrl, ...pageTexts) {
    if (credentialCaptureAllowed()) return { suppress: false, latched: false };
    const shapeMatch = pageTexts.some(containsCredentialShaped);
    let latched = false;
    try {
      const ps = await getPageSession(tabIndexOrWsUrl);
      latched = isSecretLatched(state, ps.sessionId);
    } catch (_err) {
      // Can't even resolve the page session: nothing to look up, and no
      // live check was attempted, so this is not itself a fail-closed case.
    }
    return { suppress: shapeMatch || latched, latched };
  }

  async function pageContainsCredentialShaped(tabIndexOrWsUrl) {
    const [html, renderedText, ps] = await Promise.all([
      getHtml(tabIndexOrWsUrl),
      getRenderedText(tabIndexOrWsUrl),
      getPageSession(tabIndexOrWsUrl),
    ]);
    // obra#52 review finding 4: screenshots and auto-capture used only the
    // HTML-string regex check (containsCredentialShaped), which requires
    // the marker's tag to be in the serialized top-document outerHTML. A
    // marker inside an open shadow root or a same-origin iframe is
    // invisible there, so a screenshot of that page still legibly showed
    // the seed. OR in the live-DOM check (secret-marker.js) instead - the
    // same one eval/extract/attr use - which recurses into both.
    return containsCredentialShaped(html)
      || containsCredentialShaped(renderedText)
      || (!credentialCaptureAllowed() && await pageHasSecretMarker(ps));
  }

  // A screenshot that never leaves an image of a credential-shaped page on
  // disk. Checked before (an already-secret page is never shot) and again
  // after, because a token can appear while the pixels are taken (an XHR
  // completing after "Generate"); a match then deletes the file. Returns the
  // saved path, or null when the page was credential-shaped.
  async function screenshotUnlessCredentialShaped(tabIndexOrWsUrl, filename, selector = null, fullPage = false) {
    if (credentialCaptureAllowed()) return screenshot(tabIndexOrWsUrl, filename, selector, fullPage);
    if (await pageContainsCredentialShaped(tabIndexOrWsUrl)) return null;
    const saved = await screenshot(tabIndexOrWsUrl, filename, selector, fullPage);
    if (await pageContainsCredentialShaped(tabIndexOrWsUrl)) {
      fs.rmSync(saved, { force: true });
      return null;
    }
    return saved;
  }

  // Write content to a file inside dir, silently skipping if dir doesn't exist.
  function writeIfDir(dir, filename, content) {
    if (!dir) return;
    try {
      fs.writeFileSync(path.join(dir, filename), content);
    } catch (_err) {
      // Best-effort; missing session dir is not fatal.
    }
  }

  // Single post-action snapshot: html + markdown + screenshot + console-log
  // placeholder, all parallelised. Filenames share a numbered prefix so the
  // session dir reads like a flat timeline.
  async function capturePageArtifacts(tabIndexOrWsUrl, actionType = 'navigate') {
    const ps = await getPageSession(tabIndexOrWsUrl);

    // Dialog short-circuit: when a native browser dialog is open on this tab,
    // return synthetic artifacts without issuing any CDP calls to the page.
    if (dialogs) {
      const open = dialogs.getOpen(ps.sessionId);
      if (open) {
        const artifacts = renderSyntheticArtifacts(open);
        const prefix = createCapturePrefix(actionType);
        const dir = state.sessionDir;
        // The dialog's message (and, for prompt, its default value) is
        // page/JS-controlled text — alert()/confirm()/prompt()/beforeunload
        // can all put a credential-shaped string there. Guard it exactly
        // like the on-page path below: no files, a credentialSuppressed
        // marker, no payload — `open` itself carries the message, so only
        // its `kind` (the one field a caller actually reads) survives.
        // Cached-only check (dialogSuppressionInfo), not a live CDP call:
        // this branch is explicitly "no CDP calls while a dialog is open"
        // (see above); a fresh Runtime.evaluate against a page whose JS
        // thread is paused for a native dialog can hang until timeout.
        const { suppress } = await dialogSuppressionInfo(tabIndexOrWsUrl, artifacts.markdown, artifacts.html, artifacts.consoleSnapshot);
        if (suppress) {
          return {
            capturePrefix: prefix,
            sessionDir: dir,
            files: null,
            dialog: { kind: open.kind },
            credentialSuppressed: true,
          };
        }
        writeIfDir(dir, `${prefix}.md`, artifacts.markdown);
        writeIfDir(dir, `${prefix}.html`, artifacts.html);
        writeIfDir(dir, `${prefix}-console.txt`, artifacts.consoleSnapshot);
        return {
          capturePrefix: prefix,
          sessionDir: dir,
          files: {
            html: dir ? path.join(dir, `${prefix}.html`) : null,
            markdown: dir ? path.join(dir, `${prefix}.md`) : null,
            screenshot: null,
            consoleLog: dir ? path.join(dir, `${prefix}-console.txt`) : null,
          },
          markdown: artifacts.markdown,
          html: artifacts.html,
          consoleSnapshot: artifacts.consoleSnapshot,
          png: undefined,
          dialog: open,
        };
      }
    }

    const prefix = createCapturePrefix(actionType);
    const dir = initializeSession();
    const htmlPath = path.join(dir, `${prefix}.html`);
    const markdownPath = path.join(dir, `${prefix}.md`);
    const screenshotPath = path.join(dir, `${prefix}.png`);
    const consoleLogPath = path.join(dir, `${prefix}-console.txt`);

    // Screenshot first, then read the content that gets checked and written,
    // so the check is never earlier than the pixels: a token revealed at any
    // point before the last artifact means no artifact survives.
    const shot = await screenshotUnlessCredentialShaped(tabIndexOrWsUrl, screenshotPath);

    const [html, markdown, pageSize, domSummary, renderedText] = await Promise.all([
      getHtml(tabIndexOrWsUrl),
      generateMarkdown(tabIndexOrWsUrl),
      getPageSize(tabIndexOrWsUrl),
      generateDomSummary(tabIndexOrWsUrl),
      getRenderedText(tabIndexOrWsUrl)
    ]);

    // Always run mustSuppressPageState (which also refreshes the secret-
    // seen latch) even when `!shot` already decided to suppress on its
    // own — `||` short-circuiting must never skip the latch refresh, or a
    // marker this call is the FIRST to observe would never get latched
    // for later actions/dialogs on this tab to check against.
    const stateSuppressed = await mustSuppressPageState(tabIndexOrWsUrl, html, markdown, domSummary, renderedText);
    if (!shot || stateSuppressed) {
      fs.rmSync(screenshotPath, { force: true });
      return {
        capturePrefix: prefix,
        sessionDir: dir,
        files: null,
        pageSize,
        domSummary: suppressedDomSummary(domSummary),
        credentialSuppressed: true
      };
    }

    fs.writeFileSync(htmlPath, html || '');
    fs.writeFileSync(markdownPath, markdown || '');
    fs.writeFileSync(consoleLogPath, '# Console Log\n# TODO: Console logging not yet implemented\n');

    return {
      capturePrefix: prefix,
      sessionDir: dir,
      files: {
        html: htmlPath,
        markdown: markdownPath,
        screenshot: screenshotPath,
        consoleLog: consoleLogPath
      },
      pageSize,
      domSummary
    };
  }

  // Before/after capture pair with HTML diff. Wraps an actionFn so callers
  // get the action result alongside the diff and screenshots. Saves and
  // restores focus around the BEFORE screenshot — taking a screenshot can
  // shift focus, which then breaks any focus-dependent action that follows.
  async function captureActionWithDiff(tabIndexOrWsUrl, actionType, actionFn, settleTime = 3000) {
    const ps = await getPageSession(tabIndexOrWsUrl);

    // Pin the tab handle to the targetId resolved NOW so that a popup spawned
    // by the action does not shift "tab 0" before the AFTER-capture runs
    // (Bug 3 fix: resolve once at action start, use throughout).
    const pinnedTab = { id: ps.targetId };

    // If a dialog is open, skip BEFORE-capture entirely. The page's execution
    // context is suspended (e.g. waiting for basic-auth credentials), so any
    // Runtime.evaluate call would hang until timeout. The inner action handles
    // dialog routing via withDialogAwarenessForSession.
    if (dialogs && dialogs.getOpen(ps.sessionId)) {
      return { actionResult: await actionFn() };
    }

    const prefix = createCapturePrefix(actionType);
    const dir = initializeSession();

    async function saveFocus() {
      const result = await ps.send('Runtime.evaluate', {
        expression: `
          (() => {
            const el = document.activeElement;
            if (!el || el === document.body) return null;
            // Build a unique selector for the focused element
            if (el.id) return { type: 'id', value: el.id };
            if (el.name) return { type: 'name', value: el.name, tag: el.tagName.toLowerCase() };
            // Fallback: sibling-index path from body
            const focusPath = [];
            let current = el;
            while (current && current !== document.body) {
              const parent = current.parentElement;
              if (!parent) break;
              const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
              const index = siblings.indexOf(current);
              focusPath.unshift({ tag: current.tagName.toLowerCase(), index });
              current = parent;
            }
            return { type: 'path', value: focusPath };
          })()
        `,
        returnByValue: true
      });
      throwIfExceptionDetails(result);
      return result.result?.value;
    }

    async function restoreFocus(focusInfo) {
      if (!focusInfo) return;
      let selector;
      if (focusInfo.type === 'id') {
        selector = `document.getElementById(${JSON.stringify(focusInfo.value)})`;
      } else if (focusInfo.type === 'name') {
        selector = `document.querySelector(${JSON.stringify(focusInfo.tag + '[name="' + focusInfo.value + '"]')})`;
      } else if (focusInfo.type === 'path') {
        selector = `(() => {
          let el = document.body;
          const focusPath = ${JSON.stringify(focusInfo.value)};
          for (const step of focusPath) {
            const children = Array.from(el.children).filter(c => c.tagName.toLowerCase() === step.tag);
            el = children[step.index];
            if (!el) return null;
          }
          return el;
        })()`;
      }
      if (selector) {
        const restoreResult = await ps.send('Runtime.evaluate', {
          // preventScroll: true avoids scrolling the page to bring the
          // re-focused element into view, which would undo any explicit
          // scroll() the user just performed (Bug 4 fix).
          expression: `(() => { const el = ${selector}; if (el) el.focus({ preventScroll: true }); })()`
        });
        throwIfExceptionDetails(restoreResult);
      }
    }

    // BEFORE: html + screenshot, with focus saved/restored around the screenshot.
    // Use pinnedTab throughout so a popup spawned mid-action doesn't redirect
    // capture to the wrong tab.
    // The BEFORE html is read after the screenshot so its check is never
    // earlier than the pixels (see capturePageArtifacts).
    const beforeScreenshotPath = path.join(dir, `${prefix}-before.png`);
    const focusInfo = await saveFocus();
    const beforeShot = await screenshotUnlessCredentialShaped(pinnedTab, beforeScreenshotPath);
    await restoreFocus(focusInfo);
    const [beforeHtml, beforeRenderedText] = await Promise.all([
      getHtml(pinnedTab),
      getRenderedText(pinnedTab)
    ]);
    // See the comment on the equivalent line in capturePageArtifacts:
    // this must run unconditionally, not after a short-circuiting `||`,
    // so the secret-seen latch always gets refreshed.
    const beforeStateSuppressed = await mustSuppressPageState(pinnedTab, beforeHtml, beforeRenderedText);
    const beforeSuppressed = !beforeShot || beforeStateSuppressed;

    const actionResult = await actionFn();

    // AFTER-capture short-circuit: if the action opened a dialog, skip the
    // AFTER-capture to avoid Runtime.evaluate hangs while the page is suspended.
    // Return the action result plus a synthetic dialog artifact so the caller
    // sees a clean "dialog now open" response rather than a timeout.
    if (dialogs) {
      const openAfter = dialogs.getOpen(ps.sessionId);
      if (openAfter) {
        const artifacts = renderSyntheticArtifacts(openAfter);
        const afterPrefix = createCapturePrefix(actionType);
        const dir = state.sessionDir;
        // Same guard as capturePageArtifacts's dialog short-circuit above: the
        // dialog's message is page/JS-controlled and can carry a
        // credential-shaped OR marker-latched string. Only the disk write is
        // suppressed here for a plain shape match — `artifacts` (with its
        // dialog::accept/dismiss instructions) and the dialog's `kind` still
        // go back to the caller, because the top-level redactUnlessAllowed
        // pass in mcp/src/index.ts already blanks any credential-SHAPED
        // substring in the final response text before it reaches the agent.
        // A marker-latched tab (obra#52 review round 2, finding 1: alert()
        // showing a shapeless secret, e.g. a bare TOTP seed) has nothing for
        // that regex to find, so this rebuilds the artifacts with the
        // message itself swapped for the suppression notice instead of
        // trusting a later pass to redact substrings out of it.
        // `credentialSuppressed: true` tells that layer to add the ⚠️ notice
        // alongside the artifacts either way.
        const { suppress, latched } = await dialogSuppressionInfo(pinnedTab, artifacts.markdown, artifacts.html, artifacts.consoleSnapshot);
        if (suppress) {
          const safeArtifacts = latched
            ? renderSyntheticArtifacts({
                ...openAfter,
                payload: { ...openAfter.payload, message: CREDENTIAL_SUPPRESSED_NOTICE, defaultPrompt: undefined },
              })
            : artifacts;
          return {
            actionResult,
            capture: null,
            dialog: { kind: openAfter.kind },
            artifacts: safeArtifacts,
            credentialSuppressed: true,
          };
        }
        writeIfDir(dir, `${afterPrefix}.md`, artifacts.markdown);
        writeIfDir(dir, `${afterPrefix}.html`, artifacts.html);
        writeIfDir(dir, `${afterPrefix}-console.txt`, artifacts.consoleSnapshot);
        return {
          actionResult,
          capture: null,
          dialog: openAfter,
          artifacts,
        };
      }
    }

    // Settle: lets React re-renders, animations, and post-action XHRs complete
    // before the AFTER snapshot.
    await new Promise(resolve => setTimeout(resolve, settleTime));

    // AFTER: screenshot first, then read what gets checked and written.
    const afterScreenshotPath = path.join(dir, `${prefix}-after.png`);
    const afterShot = beforeSuppressed ? null : await screenshotUnlessCredentialShaped(pinnedTab, afterScreenshotPath);

    const [afterHtml, markdown, pageSize, domSummary, afterRenderedText] = await Promise.all([
      getHtml(pinnedTab),
      generateMarkdown(pinnedTab),
      getPageSize(pinnedTab),
      generateDomSummary(pinnedTab),
      getRenderedText(pinnedTab)
    ]);

    // Either side showing a secret suppresses the whole action's capture:
    // the diff of a before-page secret would reprint it as a REMOVED line.
    // Both screenshots are removed too, so the action leaves no artifacts.
    const afterStateSuppressed = await mustSuppressPageState(pinnedTab, afterHtml, markdown, domSummary, afterRenderedText);
    if (beforeSuppressed || !afterShot || afterStateSuppressed) {
      fs.rmSync(beforeScreenshotPath, { force: true });
      fs.rmSync(afterScreenshotPath, { force: true });
      return {
        actionResult,
        capture: {
          prefix,
          sessionDir: dir,
          files: {},
          pageSize,
          domSummary: suppressedDomSummary(domSummary),
          diffSummary: '',
          credentialSuppressed: true
        }
      };
    }

    const diff = generateHtmlDiff(beforeHtml, afterHtml);

    const beforeHtmlPath = path.join(dir, `${prefix}-before.html`);
    const afterHtmlPath = path.join(dir, `${prefix}-after.html`);
    const diffPath = path.join(dir, `${prefix}-diff.txt`);
    const markdownPath = path.join(dir, `${prefix}.md`);

    fs.writeFileSync(beforeHtmlPath, beforeHtml || '');
    fs.writeFileSync(afterHtmlPath, afterHtml || '');
    fs.writeFileSync(diffPath, diff);
    fs.writeFileSync(markdownPath, markdown || '');

    return {
      actionResult,
      capture: {
        prefix,
        sessionDir: dir,
        files: {
          beforeHtml: beforeHtmlPath,
          afterHtml: afterHtmlPath,
          diff: diffPath,
          markdown: markdownPath,
          beforeScreenshot: beforeScreenshotPath,
          afterScreenshot: afterScreenshotPath
        },
        pageSize,
        domSummary,
        diffSummary: diff.split('\n').slice(0, 5).join('\n') + (diff.split('\n').length > 5 ? '\n...' : '')
      }
    };
  }

  // *WithCapture wrappers — perform an action, then capturePageArtifacts.
  // The MCP server consumes these directly; the bare action variants stay
  // exported for callers (and tests) that don't want auto-capture.
  async function clickWithCapture(tabIndexOrWsUrl, selector) {
    const ps = await getPageSession(tabIndexOrWsUrl);
    const run = async () => {
      const clickResult = await actions.click(tabIndexOrWsUrl, selector);

      // dialog::* selectors handle a native dialog (accept/dismiss).  After the
      // dialog is handled the page may immediately navigate or resume execution,
      // so issuing Runtime.evaluate for a capture would race against that and
      // timeout.  Skip post-action capture; the next real page action will
      // capture the settled state.
      if (typeof selector === 'string' && selector.startsWith('dialog::')) {
        return { action: 'click', selector, dialogHandled: true, result: clickResult };
      }

      // Pin the page session by targetId so a newly-spawned popup does not
      // change what "tab 0" resolves to between the action and the capture
      // (Bug 3 fix: resolve once, pass the stable tab handle forward).
      const pinnedTab = { id: ps.targetId };
      const artifacts = await capturePageArtifacts(pinnedTab, 'click');
      return {
        action: 'click',
        selector,
        pageSize: artifacts.pageSize,
        capturePrefix: artifacts.capturePrefix,
        sessionDir: artifacts.sessionDir,
        files: artifacts.files,
        domSummary: artifacts.domSummary,
        credentialSuppressed: artifacts.credentialSuppressed,
        consoleLog: [] // Placeholder
      };
    };
    if (dialogs && dialogs.withDialogAwarenessForSession) {
      return dialogs.withDialogAwarenessForSession('click', ps, { selector }, run);
    }
    return run();
  }

  // set_attr (obra#50 follow-up — see lib/set-attribute.js for the guard
  // rationale): a write-only action, so its post-action capture is the
  // same single post-capture click/select use, gated by the SAME
  // credential-shape suppression as every other *WithCapture wrapper
  // (mustSuppress inside capturePageArtifacts). It is deliberately NOT
  // additionally gated behind the page-wide secret-marker check eval
  // uses — actions.setAttribute (lib/set-attribute.js) already refuses on
  // its own if the TARGET element is marked, which is the only read this
  // action could possibly need to make.
  async function setAttributeWithCapture(tabIndexOrWsUrl, selector, name, value) {
    const ps = await getPageSession(tabIndexOrWsUrl);
    const run = async () => {
      await actions.setAttribute(tabIndexOrWsUrl, selector, name, value);
      const pinnedTab = { id: ps.targetId };
      const artifacts = await capturePageArtifacts(pinnedTab, 'set_attr');
      return {
        action: 'set_attr',
        selector,
        name,
        pageSize: artifacts.pageSize,
        capturePrefix: artifacts.capturePrefix,
        sessionDir: artifacts.sessionDir,
        files: artifacts.files,
        domSummary: artifacts.domSummary,
        credentialSuppressed: artifacts.credentialSuppressed,
        consoleLog: [] // Placeholder
      };
    };
    if (dialogs && dialogs.withDialogAwarenessForSession) {
      return dialogs.withDialogAwarenessForSession('set_attr', ps, { selector }, run);
    }
    return run();
  }

  async function fillWithCapture(tabIndexOrWsUrl, selector, value) {
    const ps = await getPageSession(tabIndexOrWsUrl);
    const pinnedTab = { id: ps.targetId };
    const run = async () => {
      await actions.fill(tabIndexOrWsUrl, selector, value);
      const artifacts = await capturePageArtifacts(pinnedTab, 'type');
      return {
        action: 'type',
        selector,
        value,
        pageSize: artifacts.pageSize,
        capturePrefix: artifacts.capturePrefix,
        sessionDir: artifacts.sessionDir,
        files: artifacts.files,
        domSummary: artifacts.domSummary,
        credentialSuppressed: artifacts.credentialSuppressed,
        consoleLog: [] // Placeholder
      };
    };
    if (dialogs && dialogs.withDialogAwarenessForSession) {
      return dialogs.withDialogAwarenessForSession('type', ps, { selector }, run);
    }
    return run();
  }

  async function selectOptionWithCapture(tabIndexOrWsUrl, selector, value) {
    const ps = await getPageSession(tabIndexOrWsUrl);
    const pinnedTab = { id: ps.targetId };
    const run = async () => {
      await actions.selectOption(tabIndexOrWsUrl, selector, value);
      const artifacts = await capturePageArtifacts(pinnedTab, 'select');
      return {
        action: 'select',
        selector,
        value,
        pageSize: artifacts.pageSize,
        capturePrefix: artifacts.capturePrefix,
        sessionDir: artifacts.sessionDir,
        files: artifacts.files,
        domSummary: artifacts.domSummary,
        credentialSuppressed: artifacts.credentialSuppressed,
        consoleLog: [] // Placeholder
      };
    };
    if (dialogs && dialogs.withDialogAwarenessForSession) {
      return dialogs.withDialogAwarenessForSession('select', ps, { selector }, run);
    }
    return run();
  }

  // eval runs arbitrary caller JS against the live page and hands back
  // whatever it returns, verbatim — there is no result shape to inspect
  // and redact after the fact the way a plain-text extraction can be
  // scanned. So this checks BEFORE running the expression at all and
  // refuses outright when the marker is present, rather than trying to
  // run the expression and filter its result: a value-blind expression
  // (`.textContent.length`) is fine for a token-shaped secret (whose shape
  // lets the final redaction pass confirm nothing leaked) but not for a
  // data-sen-secret page, which by definition has no shape to verify
  // against. Refusing is also what keeps this from ever mutating the live
  // DOM to get a safe answer: the expression simply never runs.
  async function evaluateWithCapture(tabIndexOrWsUrl, expression) {
    const ps = await getPageSession(tabIndexOrWsUrl);
    const pinnedTab = { id: ps.targetId };
    const run = async () => {
      if (!credentialCaptureAllowed() && await refreshSecretLatch(state, ps)) {
        throw new Error(secretMarkerRefusal('eval'));
      }

      // obra#52 review round 2, finding 1: a post-hoc "is the marker present
      // now" recheck (the round-1 fix, below this comment in spirit) only
      // ever gated the RETURN path. It missed three other channels the
      // expression can use to get the value out without ever "returning"
      // it past that check:
      //   - throw new Error(secret) — a rejected promise, a different code
      //     path than the one the old recheck guarded.
      //   - console.log(secret) then return something inert — the value
      //     never appears in the return path at all.
      //   - el.removeAttribute('data-sen-secret'); return el.textContent —
      //     the expression erases the evidence as its own last synchronous
      //     step, so a recheck that only looks at the LIVE DOM afterward
      //     finds nothing to refuse on.
      // Running the expression and inspecting only its outcome can't close
      // all three at once; latching on ANY observation (including the
      // sticky, mutation-record-based sentinel — see secret-marker.js —
      // which sees the removeAttribute call itself, not just its aftermath)
      // and gating BOTH the success and the error path on that latch does.
      let result, evalError;
      try {
        result = await actions.evaluate(tabIndexOrWsUrl, expression);
      } catch (err) {
        evalError = err;
      }

      let latchedAfter;
      try {
        latchedAfter = !credentialCaptureAllowed() && await refreshSecretLatch(state, ps);
      } catch (_err) {
        // The latch check itself failed (CDP error, closed session, etc.) —
        // fail closed exactly like an observed marker: refuse rather than
        // let a result or error we couldn't vet through.
        latchedAfter = !credentialCaptureAllowed();
      }
      if (latchedAfter) {
        throw new Error(secretMarkerRefusal('eval'));
      }
      if (evalError) throw evalError;

      const artifacts = await capturePageArtifacts(pinnedTab, 'eval');
      return {
        action: 'eval',
        expression,
        result,
        pageSize: artifacts.pageSize,
        capturePrefix: artifacts.capturePrefix,
        sessionDir: artifacts.sessionDir,
        files: artifacts.files,
        domSummary: artifacts.domSummary,
        credentialSuppressed: artifacts.credentialSuppressed,
        consoleLog: [] // Placeholder
      };
    };
    if (dialogs && dialogs.withDialogAwarenessForSession) {
      return dialogs.withDialogAwarenessForSession('eval', ps, {}, run);
    }
    return run();
  }

  // Whole-page rendered text for extract's format='text' with no selector.
  // Uses innerText (see page-scripts/rendered-text.js on why: it collapses
  // display:none, joins inline runs the way a screenshot would show them),
  // which only reads right off the live, laid-out DOM — unlike extractText
  // and getSanitizedHtml (lib/extraction.js), there is no detached-clone
  // trick available here, since a clone has no layout for innerText to
  // read. So this refuses outright on a marker instead, the same as eval.
  async function extractPageText(tabIndexOrWsUrl) {
    const ps = await getPageSession(tabIndexOrWsUrl);
    // refreshSecretLatch (not the bare live-marker check) so a page that was
    // marked at any point stays refused here even after removeAttribute
    // (obra#52 review round 2, finding 1).
    if (!credentialCaptureAllowed() && await refreshSecretLatch(state, ps)) {
      throw new Error(secretMarkerRefusal('extract'));
    }
    return actions.evaluate(tabIndexOrWsUrl, 'document.body.innerText');
  }

  return {
    initializeSession,
    cleanupSession,
    createCapturePrefix,
    generateDomSummary,
    getPageSize,
    generateMarkdown,
    capturePageArtifacts,
    captureActionWithDiff,
    pageContainsCredentialShaped,
    screenshotUnlessCredentialShaped,
    clickWithCapture,
    fillWithCapture,
    selectOptionWithCapture,
    evaluateWithCapture,
    extractPageText,
    setAttributeWithCapture,
  };
}

module.exports = { attachCapture };
