/**
 * Cookie management — currently just a single "clear everything" action.
 *
 * Takes `getPageSession(tabIndexOrWsUrl)`: a resolver provided by chrome-ws-lib
 * that handles both tab-index and ws-url inputs, lazy-bootstraps the CDP bridge,
 * and returns a pageSession driving CDP via flatten mode.
 */
function attachCookies({ getPageSession }) {
  async function clearCookies(tabIndexOrWsUrl) {
    const ps = await getPageSession(tabIndexOrWsUrl);
    await ps.send('Network.clearBrowserCookies', {});
  }

  return { clearCookies };
}

module.exports = { attachCookies };
