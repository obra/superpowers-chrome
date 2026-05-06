/**
 * Line-based diff between two HTML strings using Myers' algorithm.
 * Returns a human-readable summary with REMOVED and ADDED sections,
 * capped at 50 lines per side with "and N more" footer. Used by
 * capturePageArtifacts to attach a diff to the captured page state.
 *
 * Myers (not set-based) so reordered identical lines are correctly
 * detected as a remove + add pair, not "no changes."
 *
 * Pure function. Hand-rolled — no npm dependency.
 */

const MAX_LINES_PER_SIDE = 50;
const MAX_LINE_LENGTH = 200;

// Myers' O((N+M)D) shortest-edit-script. Returns an array of
// { type: 'eq'|'del'|'add', value: string } operations in order.
function myersDiff(a, b) {
  const N = a.length;
  const M = b.length;
  const max = N + M;
  const v = new Array(2 * max + 1);
  const trace = [];

  v[max + 1] = 0;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[max + k - 1] < v[max + k + 1])) {
        x = v[max + k + 1];
      } else {
        x = v[max + k - 1] + 1;
      }
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) {
        x++; y++;
      }
      v[max + k] = x;
      if (x >= N && y >= M) {
        // Backtrack through the trace to build the edit script.
        return backtrack(trace, a, b, N, M, max);
      }
    }
  }
  return [];
}

function backtrack(trace, a, b, N, M, max) {
  const ops = [];
  let x = N;
  let y = M;
  for (let d = trace.length - 1; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && v[max + k - 1] < v[max + k + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = v[max + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: 'eq', value: a[x - 1] });
      x--; y--;
    }
    if (d > 0) {
      if (x === prevX) {
        ops.push({ type: 'add', value: b[y - 1] });
        y--;
      } else {
        ops.push({ type: 'del', value: a[x - 1] });
        x--;
      }
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ type: 'eq', value: a[x - 1] });
    x--; y--;
  }
  return ops.reverse();
}

function generateHtmlDiff(beforeHtml, afterHtml) {
  const beforeLines = (beforeHtml || '').split('\n');
  const afterLines = (afterHtml || '').split('\n');

  const ops = myersDiff(beforeLines, afterLines);

  const removed = ops.filter(o => o.type === 'del' && o.value.trim()).map(o => o.value);
  const added = ops.filter(o => o.type === 'add' && o.value.trim()).map(o => o.value);

  let diff = '';
  if (removed.length > 0) {
    diff += '=== REMOVED ===\n';
    diff += removed.slice(0, MAX_LINES_PER_SIDE)
      .map(l => '- ' + l.slice(0, MAX_LINE_LENGTH))
      .join('\n');
    if (removed.length > MAX_LINES_PER_SIDE) {
      diff += `\n... and ${removed.length - MAX_LINES_PER_SIDE} more removed lines`;
    }
    diff += '\n\n';
  }
  if (added.length > 0) {
    diff += '=== ADDED ===\n';
    diff += added.slice(0, MAX_LINES_PER_SIDE)
      .map(l => '+ ' + l.slice(0, MAX_LINE_LENGTH))
      .join('\n');
    if (added.length > MAX_LINES_PER_SIDE) {
      diff += `\n... and ${added.length - MAX_LINES_PER_SIDE} more added lines`;
    }
  }

  if (!diff) {
    diff = '(no changes detected)';
  }

  return diff;
}

module.exports = { generateHtmlDiff };
