/**
 * Programmatic file upload via `DOM.setFileInputFiles` — the only way to
 * set files on an `<input type="file">` from outside the page, since JS
 * security restrictions block synthetic file assignment.
 *
 * Resolves the input element via `DOM.querySelector` for CSS selectors
 * or `DOM.performSearch` + `DOM.getSearchResults` for XPath, then attaches
 * the absolute file paths to the input.
 *
 * `attachFileUpload({ resolveWsUrl, sendCdpCommand })` returns the bound
 * action.
 */
function attachFileUpload({ resolveWsUrl, sendCdpCommand }) {
  async function fileUpload(tabIndexOrWsUrl, selector, filePaths) {
    const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

    const docResult = await sendCdpCommand(wsUrl, 'DOM.getDocument', {});
    const rootNodeId = docResult.root.nodeId;

    let nodeId;
    if (selector.startsWith('/') || selector.startsWith('//')) {
      const searchResult = await sendCdpCommand(wsUrl, 'DOM.performSearch', {
        query: selector
      });
      if (searchResult.resultCount === 0) {
        throw new Error(`File input not found: ${selector}`);
      }
      const nodesResult = await sendCdpCommand(wsUrl, 'DOM.getSearchResults', {
        searchId: searchResult.searchId,
        fromIndex: 0,
        toIndex: 1
      });
      nodeId = nodesResult.nodeIds[0];
    } else {
      const queryResult = await sendCdpCommand(wsUrl, 'DOM.querySelector', {
        nodeId: rootNodeId,
        selector: selector
      });
      nodeId = queryResult.nodeId;
    }

    if (!nodeId) {
      throw new Error(`File input not found: ${selector}`);
    }

    await sendCdpCommand(wsUrl, 'DOM.setFileInputFiles', {
      files: filePaths,
      nodeId: nodeId
    });

    return { uploaded: true, files: filePaths.length };
  }

  return { fileUpload };
}

module.exports = { attachFileUpload };
