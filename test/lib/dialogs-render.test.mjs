import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { renderSyntheticArtifacts } = require('../../skills/browsing/lib/dialogs-render.js');

function golden(name) {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf8');
}

describe('renderSyntheticArtifacts', () => {
  it('renders alert markdown matching golden file', () => {
    const out = renderSyntheticArtifacts({
      kind: 'alert',
      payload: { message: 'Something happened.', url: 'http://example.com', defaultPrompt: '', hasBrowserHandler: false },
      staged: {},
    });
    assert.equal(out.markdown.trim(), golden('dialog-alert.md').trim());
  });
});
