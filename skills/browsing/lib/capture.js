const fs = require('fs');
const path = require('path');
const { getXdgCacheHome } = require('./chrome-launcher-helpers');
const { generateHtmlDiff } = require('./html-diff');
const { throwIfExceptionDetails } = require('./cdp-utils');
const markdownScript = require('./page-scripts/markdown');
const domSummaryScript = require('./page-scripts/dom-summary');

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
 * Helpers accept `tabIndexOrPageSession` and route through
 * `pageSession.send`.
 */
function attachCapture({ state, getPageSession, getHtml, screenshot, actions }) {
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
  async function generateDomSummary(tabIndexOrPageSession) {
    const ps = await getPageSession(tabIndexOrPageSession);
    const result = await ps.send('Runtime.evaluate', {
      expression: domSummaryScript,
      returnByValue: true,
    });
    throwIfExceptionDetails(result);
    return result.result.value;
  }

  async function getPageSize(tabIndexOrPageSession) {
    const ps = await getPageSession(tabIndexOrPageSession);

    const js = `({
      width: window.innerWidth,
      height: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight
    })`;

    const result = await ps.send('Runtime.evaluate', {
      expression: js,
      returnByValue: true,
    });
    throwIfExceptionDetails(result);
    return result.result.value;
  }

  // Render the page to markdown for token-efficient consumption. Includes
  // images >= 100x100 in a header summary; inlines image references >= 50x50
  // with size info; skips smaller icons.
  async function generateMarkdown(tabIndexOrPageSession) {
    const ps = await getPageSession(tabIndexOrPageSession);
    const result = await ps.send('Runtime.evaluate', {
      expression: markdownScript,
      returnByValue: true,
    });
    throwIfExceptionDetails(result);
    return result.result.value;
  }

  // Single post-action snapshot: html + markdown + screenshot + console-log
  // placeholder, all parallelised. Filenames share a numbered prefix so the
  // session dir reads like a flat timeline.
  async function capturePageArtifacts(tabIndexOrPageSession, actionType = 'navigate') {
    const prefix = createCapturePrefix(actionType);
    const dir = initializeSession();

    const [html, markdown, pageSize, domSummary] = await Promise.all([
      getHtml(tabIndexOrPageSession),
      generateMarkdown(tabIndexOrPageSession),
      getPageSize(tabIndexOrPageSession),
      generateDomSummary(tabIndexOrPageSession),
    ]);

    const htmlPath = path.join(dir, `${prefix}.html`);
    const markdownPath = path.join(dir, `${prefix}.md`);
    const screenshotPath = path.join(dir, `${prefix}.png`);
    const consoleLogPath = path.join(dir, `${prefix}-console.txt`);

    fs.writeFileSync(htmlPath, html || '');
    fs.writeFileSync(markdownPath, markdown || '');
    fs.writeFileSync(consoleLogPath, '# Console Log\n# TODO: Console logging not yet implemented\n');

    await screenshot(tabIndexOrPageSession, screenshotPath);

    return {
      capturePrefix: prefix,
      sessionDir: dir,
      files: {
        html: htmlPath,
        markdown: markdownPath,
        screenshot: screenshotPath,
        consoleLog: consoleLogPath,
      },
      pageSize,
      domSummary,
    };
  }

  // Before/after capture pair with HTML diff. Wraps an actionFn so callers
  // get the action result alongside the diff and screenshots. Saves and
  // restores focus around the BEFORE screenshot — taking a screenshot can
  // shift focus, which then breaks any focus-dependent action that follows.
  async function captureActionWithDiff(tabIndexOrPageSession, actionType, actionFn, settleTime = 3000) {
    const prefix = createCapturePrefix(actionType);
    const dir = initializeSession();
    const ps = await getPageSession(tabIndexOrPageSession);

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
        returnByValue: true,
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
          expression: `(() => { const el = ${selector}; if (el) el.focus(); })()`,
        });
        throwIfExceptionDetails(restoreResult);
      }
    }

    // BEFORE: html + screenshot, with focus saved/restored around the screenshot.
    const beforeHtml = await getHtml(ps);
    const focusInfo = await saveFocus();
    const beforeScreenshotPath = path.join(dir, `${prefix}-before.png`);
    await screenshot(ps, beforeScreenshotPath);
    await restoreFocus(focusInfo);

    const actionResult = await actionFn();

    // Settle: lets React re-renders, animations, and post-action XHRs complete
    // before the AFTER snapshot.
    await new Promise((resolve) => setTimeout(resolve, settleTime));

    const [afterHtml, markdown, pageSize, domSummary] = await Promise.all([
      getHtml(ps),
      generateMarkdown(ps),
      getPageSize(ps),
      generateDomSummary(ps),
    ]);

    const diff = generateHtmlDiff(beforeHtml, afterHtml);

    const beforeHtmlPath = path.join(dir, `${prefix}-before.html`);
    const afterHtmlPath = path.join(dir, `${prefix}-after.html`);
    const diffPath = path.join(dir, `${prefix}-diff.txt`);
    const markdownPath = path.join(dir, `${prefix}.md`);
    const afterScreenshotPath = path.join(dir, `${prefix}-after.png`);

    fs.writeFileSync(beforeHtmlPath, beforeHtml || '');
    fs.writeFileSync(afterHtmlPath, afterHtml || '');
    fs.writeFileSync(diffPath, diff);
    fs.writeFileSync(markdownPath, markdown || '');
    await screenshot(ps, afterScreenshotPath);

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
          afterScreenshot: afterScreenshotPath,
        },
        pageSize,
        domSummary,
        diffSummary: diff.split('\n').slice(0, 5).join('\n') + (diff.split('\n').length > 5 ? '\n...' : ''),
      },
    };
  }

  // *WithCapture wrappers — perform an action, then capturePageArtifacts.
  // The MCP server consumes these directly; the bare action variants stay
  // exported for callers (and tests) that don't want auto-capture.
  async function clickWithCapture(tabIndexOrPageSession, selector) {
    await actions.click(tabIndexOrPageSession, selector);
    const artifacts = await capturePageArtifacts(tabIndexOrPageSession, 'click');
    return {
      action: 'click',
      selector,
      pageSize: artifacts.pageSize,
      capturePrefix: artifacts.capturePrefix,
      sessionDir: artifacts.sessionDir,
      files: artifacts.files,
      domSummary: artifacts.domSummary,
      consoleLog: [], // Placeholder
    };
  }

  async function fillWithCapture(tabIndexOrPageSession, selector, value) {
    await actions.fill(tabIndexOrPageSession, selector, value);
    const artifacts = await capturePageArtifacts(tabIndexOrPageSession, 'type');
    return {
      action: 'type',
      selector,
      value,
      pageSize: artifacts.pageSize,
      capturePrefix: artifacts.capturePrefix,
      sessionDir: artifacts.sessionDir,
      files: artifacts.files,
      domSummary: artifacts.domSummary,
      consoleLog: [], // Placeholder
    };
  }

  async function selectOptionWithCapture(tabIndexOrPageSession, selector, value) {
    await actions.selectOption(tabIndexOrPageSession, selector, value);
    const artifacts = await capturePageArtifacts(tabIndexOrPageSession, 'select');
    return {
      action: 'select',
      selector,
      value,
      pageSize: artifacts.pageSize,
      capturePrefix: artifacts.capturePrefix,
      sessionDir: artifacts.sessionDir,
      files: artifacts.files,
      domSummary: artifacts.domSummary,
      consoleLog: [], // Placeholder
    };
  }

  async function evaluateWithCapture(tabIndexOrPageSession, expression) {
    const result = await actions.evaluate(tabIndexOrPageSession, expression);
    const artifacts = await capturePageArtifacts(tabIndexOrPageSession, 'eval');
    return {
      action: 'eval',
      expression,
      result,
      pageSize: artifacts.pageSize,
      capturePrefix: artifacts.capturePrefix,
      sessionDir: artifacts.sessionDir,
      files: artifacts.files,
      domSummary: artifacts.domSummary,
      consoleLog: [], // Placeholder
    };
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
    clickWithCapture,
    fillWithCapture,
    selectOptionWithCapture,
    evaluateWithCapture,
  };
}

module.exports = { attachCapture };
