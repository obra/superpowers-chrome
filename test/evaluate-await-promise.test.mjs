import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// evaluate / evaluateJson live in lib/evaluation.js since the file split.
const source = readFileSync(join(__dirname, '../skills/browsing/lib/evaluation.js'), 'utf8');

// Extract the evaluate() function body from source.
// We verify the CDP call parameters directly rather than mocking the CDP connection,
// since the real behavior depends on Chrome and can only be integration-tested.
function extractFunction(name) {
  // Match "async function <name>(...) {" and capture the balanced braces body
  const pattern = new RegExp(`async function ${name}\\s*\\([^)]*\\)\\s*\\{`);
  const match = source.match(pattern);
  if (!match) return null;

  const start = match.index + match[0].length - 1; // the opening {
  let depth = 1;
  let i = start + 1;
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  }
  return source.slice(start, i);
}

describe('evaluate() awaits promises', () => {

  it('evaluate() passes awaitPromise: true to Runtime.evaluate', () => {
    const body = extractFunction('evaluate');
    assert.ok(body, 'evaluate() function not found in source');
    assert.ok(
      body.includes('awaitPromise: true'),
      'evaluate() must include awaitPromise: true in its Runtime.evaluate call'
    );
  });

  it('evaluateJson() passes awaitPromise: true to Runtime.evaluate', () => {
    const body = extractFunction('evaluateJson');
    assert.ok(body, 'evaluateJson() function not found in source');
    assert.ok(
      body.includes('awaitPromise: true'),
      'evaluateJson() must include awaitPromise: true (regression check)'
    );
  });
});
