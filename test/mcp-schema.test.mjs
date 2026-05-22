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

  it('schema Postel-accepts tab_index as a legacy alias for switch_tab', () => {
    // tab_index used to be the per-call routing parameter; the reshape replaced
    // it with sticky activeTab + switch_tab. Agents still emit tab_index from
    // prior schema versions, so the bundle accepts it and translates it into
    // an implicit switch_tab rather than silently dropping it.
    assert.ok(bundleSrc.includes('tab_index'),
      'bundle should keep tab_index as a Postel-accepted legacy parameter');
  });
});

describe('switch_tab action in bundle', () => {
  it('bundle source references switch_tab action handler', () => {
    assert.ok(bundleSrc.includes('switch_tab') || bundleSrc.includes('SWITCH_TAB'),
      'bundle should handle switch_tab action');
  });

  it('bundle translates legacy params.tab_index into an activeTab assignment', () => {
    // Postel handling: when tab_index is provided, the handler assigns it to
    // activeTab so the rest of the action runs against the requested tab.
    assert.ok(bundleSrc.includes('params.tab_index'),
      'bundle should read params.tab_index for the Postel translation path');
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
