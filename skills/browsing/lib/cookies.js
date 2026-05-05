/**
 * Cookie management — currently just a single "clear everything" action.
 *
 * Builds against any session-scoped pair of `resolveWsUrl` (tab index → ws URL)
 * and `sendCdpCommand` (CDP request) — see `attachCookies({ resolveWsUrl,
 * sendCdpCommand })`. The returned methods carry the session binding through
 * closure capture of those helpers.
 */
function attachCookies({ resolveWsUrl, sendCdpCommand }) {
  async function clearCookies(tabIndexOrWsUrl) {
    const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
    await sendCdpCommand(wsUrl, 'Network.clearBrowserCookies', {});
  }

  return { clearCookies };
}

module.exports = { attachCookies };
