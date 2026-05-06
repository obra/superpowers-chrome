// Pixel 7 UA string used for mobile emulation. Matches what Chrome's own
// device-mode dropdown sends for the same device.
const MOBILE_USER_AGENT = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

/**
 * Viewport / device emulation — set, clear, and read the CDP
 * Emulation.setDeviceMetricsOverride state. Mobile emulation toggles touch
 * input and a Pixel-7-class user-agent string in lockstep with the metrics.
 *
 * `attachViewport({ resolveWsUrl, sendCdpCommand })` returns the bound
 * actions. No session state is read directly — the helpers carry it via
 * closure capture.
 */
function attachViewport({ resolveWsUrl, sendCdpCommand }) {
  /**
   * Set device viewport / emulation parameters (CDP: Emulation.setDeviceMetricsOverride).
   *
   * @param {number|string} tabIndexOrWsUrl - Tab index or WebSocket URL
   * @param {Object} params
   * @param {number} [params.width=1200] - CSS pixels (320–7680)
   * @param {number} [params.height=800] - CSS pixels (200–4320)
   * @param {number} [params.deviceScaleFactor=1] - DPI multiplier (0.25–5)
   * @param {boolean} [params.mobile=false] - Touch + mobile UA when true
   */
  async function setViewport(tabIndexOrWsUrl, params) {
    if (!params || typeof params !== 'object') {
      throw new Error('setViewport requires a params object');
    }

    const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

    const viewportParams = {
      width: params.width ?? 1200,
      height: params.height ?? 800,
      deviceScaleFactor: params.deviceScaleFactor !== undefined ? params.deviceScaleFactor : 1,
      mobile: params.mobile === true
    };

    if (viewportParams.width < 320 || viewportParams.width > 7680) {
      throw new Error(`Invalid viewport width ${viewportParams.width} (must be 320-7680)`);
    }
    if (viewportParams.height < 200 || viewportParams.height > 4320) {
      throw new Error(`Invalid viewport height ${viewportParams.height} (must be 200-4320)`);
    }
    if (viewportParams.deviceScaleFactor < 0.25 || viewportParams.deviceScaleFactor > 5) {
      throw new Error(`Invalid deviceScaleFactor ${viewportParams.deviceScaleFactor} (must be 0.25-5)`);
    }

    await sendCdpCommand(wsUrl, 'Emulation.setDeviceMetricsOverride', viewportParams);

    if (viewportParams.mobile) {
      await sendCdpCommand(wsUrl, 'Emulation.setTouchEmulationEnabled', { enabled: true });
      await sendCdpCommand(wsUrl, 'Emulation.setUserAgentOverride', {
        userAgent: MOBILE_USER_AGENT
      });
    } else {
      await sendCdpCommand(wsUrl, 'Emulation.setTouchEmulationEnabled', { enabled: false });
      // Empty UA string resets to browser default (CDP convention)
      await sendCdpCommand(wsUrl, 'Emulation.setUserAgentOverride', { userAgent: '' });
    }

    return { ...viewportParams, touch: viewportParams.mobile };
  }

  /**
   * Clear viewport emulation (reset to browser default). Clears device
   * metrics, touch emulation, and UA override.
   */
  async function clearViewport(tabIndexOrWsUrl) {
    const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);
    await sendCdpCommand(wsUrl, 'Emulation.clearDeviceMetricsOverride', {});
    await sendCdpCommand(wsUrl, 'Emulation.setTouchEmulationEnabled', { enabled: false });
    await sendCdpCommand(wsUrl, 'Emulation.setUserAgentOverride', { userAgent: '' });
  }

  /**
   * Get current viewport dimensions from the browser.
   * Returns { innerWidth, innerHeight, outerWidth, outerHeight,
   *          devicePixelRatio, orientation }.
   */
  async function getViewport(tabIndexOrWsUrl) {
    const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

    const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
      expression: `({
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight,
        devicePixelRatio: window.devicePixelRatio,
        orientation: screen.orientation ? screen.orientation.type : 'unknown'
      })`,
      returnByValue: true
    });

    if (result.exceptionDetails) {
      throw new Error(`getViewport failed: ${result.exceptionDetails.text}`);
    }
    return result.result?.value || {};
  }

  return { setViewport, clearViewport, getViewport };
}

module.exports = { attachViewport };
