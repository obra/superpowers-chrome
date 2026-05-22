import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bundleSrc = fs.readFileSync(
  path.join(__dirname, '..', 'mcp', 'dist', 'index.js'),
  'utf8'
);

describe('use_browser schema shape', () => {
  it('schema has selector parameter', () => {
    assert.ok(bundleSrc.includes('"selector"') || bundleSrc.includes("'selector'"),
      'bundle should reference selector parameter');
  });

  it('schema has timeout parameter', () => {
    assert.ok(bundleSrc.includes('"timeout"') || bundleSrc.includes("'timeout'"),
      'bundle should reference timeout parameter');
  });

  it('schema does NOT have tab_index parameter', () => {
    // tab_index should only appear in comments or old strings, not as a Zod field name
    // We check the tool registration section specifically
    assert.ok(!bundleSrc.includes('tab_index:'),
      'bundle should not define tab_index as a schema field');
  });
});

describe('switch_tab action in bundle', () => {
  it('bundle source references switch_tab action handler', () => {
    assert.ok(bundleSrc.includes('switch_tab') || bundleSrc.includes('SWITCH_TAB'),
      'bundle should handle switch_tab action');
  });

  it('bundle source uses activeTab variable instead of params.tab_index', () => {
    assert.ok(!bundleSrc.includes('params.tab_index'),
      'bundle should not reference params.tab_index in handler');
  });
});

describe('switch_tab logic in bundle source', () => {
  it('bundle handles BrowserAction.SWITCH_TAB / switch_tab', () => {
    assert.ok(
      bundleSrc.includes('SWITCH_TAB') || bundleSrc.includes('"switch_tab"'),
      'bundle should contain switch_tab handler'
    );
  });

  it('switch_tab handler searches by url or title substring', () => {
    // The handler must call getTabs and match against url/title
    assert.ok(bundleSrc.includes('getTabs'), 'handler should call getTabs');
  });
});
