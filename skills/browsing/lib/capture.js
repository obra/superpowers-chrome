const fs = require('fs');
const path = require('path');
const { getXdgCacheHome } = require('./chrome-launcher-helpers');
const { generateHtmlDiff } = require('./html-diff');
const { throwIfExceptionDetails } = require('./cdp-utils');
const markdownScript = require('./page-scripts/markdown');
const domSummaryScript = require('./page-scripts/dom-summary');
const renderedTextScript = require('./page-scripts/rendered-text');
const { containsCredentialShaped, credentialCaptureAllowed } = require('./credential-guard');

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

  // True when auto-capture must not copy this page's content anywhere.
  // Always false when SUPERPOWERS_CHROME_ALLOW_CREDENTIAL_CAPTURE=1.
  function mustSuppress(...pageTexts) {
    return !credentialCaptureAllowed() && pageTexts.some(containsCredentialShaped);
  }

  async function pageContainsCredentialShaped(tabIndexOrWsUrl) {
    const [html, renderedText] = await Promise.all([
      getHtml(tabIndexOrWsUrl),
      getRenderedText(tabIndexOrWsUrl)
    ]);
    return containsCredentialShaped(html) || containsCredentialShaped(renderedText);
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
        if (mustSuppress(artifacts.markdown, artifacts.html, artifacts.consoleSnapshot)) {
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

    if (!shot || mustSuppress(html, markdown, domSummary, renderedText)) {
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
    const beforeSuppressed = !beforeShot || mustSuppress(beforeHtml, beforeRenderedText);

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
        // credential-shaped string. Only the disk write is suppressed here —
        // `artifacts` (with its dialog::accept/dismiss instructions) and the
        // dialog's `kind` still go back to the caller, because the top-level
        // redactUnlessAllowed pass in mcp/src/index.ts already blanks any
        // credential-shaped substring in the final response text before it
        // reaches the agent. `credentialSuppressed: true` tells that layer to
        // add the ⚠️ notice alongside the (redacted) artifacts, instead of
        // dropping them.
        if (mustSuppress(artifacts.markdown, artifacts.html, artifacts.consoleSnapshot)) {
          return {
            actionResult,
            capture: null,
            dialog: { kind: openAfter.kind },
            artifacts,
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
    if (beforeSuppressed || !afterShot || mustSuppress(afterHtml, markdown, domSummary, afterRenderedText)) {
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

  async function evaluateWithCapture(tabIndexOrWsUrl, expression) {
    const ps = await getPageSession(tabIndexOrWsUrl);
    const pinnedTab = { id: ps.targetId };
    const run = async () => {
      const result = await actions.evaluate(tabIndexOrWsUrl, expression);
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
  };
}

module.exports = { attachCapture };
