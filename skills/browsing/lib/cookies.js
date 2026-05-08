/**
 * Cookie management — currently just a single "clear everything" action.
 *
 * Helpers accept `tabIndexOrPageSession` and route through
 * `pageSession.send`.
 */
function attachCookies({ getPageSession }) {
  async function clearCookies(tabIndexOrPageSession) {
    const ps = await getPageSession(tabIndexOrPageSession);
    await ps.send('Network.clearBrowserCookies', {});
  }

  return { clearCookies };
}

module.exports = { attachCookies };
