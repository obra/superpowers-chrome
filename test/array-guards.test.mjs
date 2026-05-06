import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// resolveWsUrl / getTabs / closeTab live in lib/tabs.js since the file split.
const source = readFileSync(join(__dirname, '../skills/browsing/lib/tabs.js'), 'utf8');

// Extract a function body by name (matches "async function name(...) { ... }")
function extractFunction(name) {
  const pattern = new RegExp(`async function ${name}\\s*\\([^)]*\\)\\s*\\{`);
  const match = source.match(pattern);
  if (!match) return null;

  const start = match.index + match[0].length - 1;
  let depth = 1;
  let i = start + 1;
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  }
  return source.slice(start, i);
}

describe('Array guards on chromeHttp("/json") results', () => {

  it('resolveWsUrl() guards against non-array chromeHttp response', () => {
    const body = extractFunction('resolveWsUrl');
    assert.ok(body, 'resolveWsUrl() function not found');
    assert.ok(
      body.includes('Array.isArray'),
      'resolveWsUrl() must check Array.isArray() before calling .filter() on chromeHttp result'
    );
  });

  it('getTabs() guards against non-array chromeHttp response', () => {
    const body = extractFunction('getTabs');
    assert.ok(body, 'getTabs() function not found');
    assert.ok(
      body.includes('Array.isArray'),
      'getTabs() must check Array.isArray() (regression check)'
    );
  });

  it('closeTab() guards against non-array chromeHttp response', () => {
    const body = extractFunction('closeTab');
    assert.ok(body, 'closeTab() function not found');
    assert.ok(
      body.includes('Array.isArray'),
      'closeTab() must check Array.isArray() before calling .find() on chromeHttp result'
    );
  });
});
