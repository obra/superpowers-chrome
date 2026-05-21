import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { makePageSessionFake } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachFileUpload } = require('../../skills/browsing/lib/file-upload.js');

describe('file-upload', () => {
  function setup(handlers) {
    const ps = makePageSessionFake(handlers);
    const getPageSession = async () => ps;
    return { ...attachFileUpload({ getPageSession }), ps };
  }

  it('CSS selector path queries via DOM.querySelector and sets files', async () => {
    const { fileUpload, ps } = setup({
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.querySelector': () => ({ nodeId: 42 }),
      'DOM.setFileInputFiles': () => ({})
    });
    const result = await fileUpload(0, '#file-input', ['/tmp/a.txt']);
    assert.equal(result.uploaded, true);
    assert.equal(result.files, 1);

    const methods = ps.calls.map(c => c.method);
    assert.deepEqual(methods, ['DOM.getDocument', 'DOM.querySelector', 'DOM.setFileInputFiles']);
    assert.deepEqual(ps.calls[2].params, { files: ['/tmp/a.txt'], nodeId: 42 });
  });

  it('XPath selector path uses DOM.performSearch', async () => {
    const { fileUpload, ps } = setup({
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.performSearch': () => ({ resultCount: 1, searchId: 'abc' }),
      'DOM.getSearchResults': () => ({ nodeIds: [99] }),
      'DOM.setFileInputFiles': () => ({})
    });
    await fileUpload(0, '//input[@type="file"]', ['/tmp/x.png']);
    const methods = ps.calls.map(c => c.method);
    assert.deepEqual(methods, ['DOM.getDocument', 'DOM.performSearch', 'DOM.getSearchResults', 'DOM.setFileInputFiles']);
    assert.equal(ps.calls[3].params.nodeId, 99);
  });

  it('throws if XPath selector matches no elements', async () => {
    const { fileUpload } = setup({
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.performSearch': () => ({ resultCount: 0 })
    });
    await assert.rejects(() => fileUpload(0, '//nope', ['/tmp/a']), /File input not found/);
  });

  it('throws if CSS selector matches no element', async () => {
    const { fileUpload } = setup({
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.querySelector': () => ({ nodeId: 0 })
    });
    await assert.rejects(() => fileUpload(0, '#nope', ['/tmp/a']), /File input not found/);
  });
});
