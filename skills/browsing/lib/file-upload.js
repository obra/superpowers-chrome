/**
 * Programmatic file upload via `DOM.setFileInputFiles` — the only way to
 * set files on an `<input type="file">` from outside the page, since JS
 * security restrictions block synthetic file assignment.
 *
 * Resolves the input element via `DOM.querySelector` for CSS selectors
 * or `DOM.performSearch` + `DOM.getSearchResults` for XPath, then attaches
 * the absolute file paths to the input.
 *
 * Helpers accept `tabIndexOrPageSession` and route through
 * `pageSession.send`.
 */
function attachFileUpload({ getPageSession }) {
  async function fileUpload(tabIndexOrPageSession, selector, filePaths) {
    const ps = await getPageSession(tabIndexOrPageSession);

    const docResult = await ps.send('DOM.getDocument', {});
    const rootNodeId = docResult.root.nodeId;

    let nodeId;
    if (selector.startsWith('/') || selector.startsWith('//')) {
      const searchResult = await ps.send('DOM.performSearch', {
        query: selector,
      });
      if (searchResult.resultCount === 0) {
        throw new Error(`File input not found: ${selector}`);
      }
      const nodesResult = await ps.send('DOM.getSearchResults', {
        searchId: searchResult.searchId,
        fromIndex: 0,
        toIndex: 1,
      });
      nodeId = nodesResult.nodeIds[0];
    } else {
      const queryResult = await ps.send('DOM.querySelector', {
        nodeId: rootNodeId,
        selector,
      });
      nodeId = queryResult.nodeId;
    }

    if (!nodeId) {
      throw new Error(`File input not found: ${selector}`);
    }

    await ps.send('DOM.setFileInputFiles', {
      files: filePaths,
      nodeId,
    });

    return { uploaded: true, files: filePaths.length };
  }

  return { fileUpload };
}

module.exports = { attachFileUpload };
