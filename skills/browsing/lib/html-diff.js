/**
 * Line-set diff between two HTML strings — produces a human-readable
 * summary with REMOVED and ADDED sections, capped at 50 lines per side
 * with "and N more" footer. Used by capturePageArtifacts to attach a
 * diff to the captured page state.
 *
 * Pure function. Set-based, not order-sensitive — good enough for the
 * "what changed on the page" use case, fast to compute on multi-megabyte
 * DOMs, and avoids pulling in a real diff library.
 */
function generateHtmlDiff(beforeHtml, afterHtml) {
  const beforeLines = (beforeHtml || '').split('\n');
  const afterLines = (afterHtml || '').split('\n');

  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);

  const removed = beforeLines.filter(line => !afterSet.has(line) && line.trim());
  const added = afterLines.filter(line => !beforeSet.has(line) && line.trim());

  let diff = '';
  if (removed.length > 0) {
    diff += '=== REMOVED ===\n';
    diff += removed.slice(0, 50).map(l => '- ' + l.slice(0, 200)).join('\n');
    if (removed.length > 50) diff += `\n... and ${removed.length - 50} more removed lines`;
    diff += '\n\n';
  }
  if (added.length > 0) {
    diff += '=== ADDED ===\n';
    diff += added.slice(0, 50).map(l => '+ ' + l.slice(0, 200)).join('\n');
    if (added.length > 50) diff += `\n... and ${added.length - 50} more added lines`;
  }

  if (!diff) {
    diff = '(no changes detected)';
  }

  return diff;
}

module.exports = { generateHtmlDiff };
