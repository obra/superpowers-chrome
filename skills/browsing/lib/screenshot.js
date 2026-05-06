const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');
const { getElementSelector } = require('./element-selector');
const { throwIfExceptionDetails } = require('./cdp-utils');

// Auto-downscale cap so screenshots fit Claude's many-image mode size limit
// (max 2000px). Headroom of 200px keeps us safely under.
const MAX_IMAGE_DIMENSION_PX = 1800;

/**
 * Page / element / full-page screenshots via CDP Page.captureScreenshot,
 * with auto-downscaling so the resulting PNG fits Claude's many-image mode
 * size limit (max dimension 2000 — we cap at 1800 for headroom).
 *
 * Three clip modes, picked from the args:
 *   - `fullPage: true` — Page.getLayoutMetrics → captureBeyondViewport
 *   - `selector` set — element's getBoundingClientRect
 *   - default — explicit viewport clip from window.innerWidth/Height
 *
 * The default-viewport clip is load-bearing on Linux: without it Chrome
 * uses its internal DPI-scaled dimensions, which produces oversized
 * screenshots on HiDPI displays (Xft.dpi:144 etc).
 *
 * Downscaling is best-effort and platform-specific (sips on macOS,
 * ImageMagick on Linux, no-op on Windows). Failures are silent — better
 * to have a big PNG than no PNG.
 *
 * `attachScreenshot({ resolveWsUrl, sendCdpCommand })` returns the bound
 * action.
 */
function attachScreenshot({ resolveWsUrl, sendCdpCommand }) {
  async function downscaleImageIfNeeded(filepath, maxDimension = MAX_IMAGE_DIMENSION_PX) {
    const platform = os.platform();

    try {
      let width, height;

      if (platform === 'darwin') {
        const output = execSync(`sips -g pixelWidth -g pixelHeight "${filepath}" 2>/dev/null`, { encoding: 'utf8' });
        const widthMatch = output.match(/pixelWidth:\s*(\d+)/);
        const heightMatch = output.match(/pixelHeight:\s*(\d+)/);
        width = widthMatch ? parseInt(widthMatch[1]) : 0;
        height = heightMatch ? parseInt(heightMatch[1]) : 0;
      } else if (platform === 'linux') {
        try {
          const output = execSync(`identify -format "%w %h" "${filepath}" 2>/dev/null`, { encoding: 'utf8' });
          [width, height] = output.trim().split(' ').map(Number);
        } catch {
          // ImageMagick not available — skip downscaling.
          return;
        }
      } else {
        // Windows: no shipped downscale path.
        return;
      }

      if (width <= maxDimension && height <= maxDimension) {
        return;
      }

      if (platform === 'darwin') {
        execSync(`sips -Z ${maxDimension} "${filepath}" 2>/dev/null`);
      } else if (platform === 'linux') {
        execSync(`convert "${filepath}" -resize ${maxDimension}x${maxDimension}\\> "${filepath}" 2>/dev/null`);
      }
    } catch (_e) {
      // Better to ship a too-big PNG than none.
    }
  }

  async function screenshot(tabIndexOrWsUrl, filename, selector = null, fullPage = false) {
    const wsUrl = await resolveWsUrl(tabIndexOrWsUrl);

    let clip;
    if (fullPage) {
      const metrics = await sendCdpCommand(wsUrl, 'Page.getLayoutMetrics');
      const { width, height } = metrics.contentSize;
      clip = { x: 0, y: 0, width, height, scale: 1 };
    } else if (selector) {
      const js = `
        (() => {
          const el = ${getElementSelector(selector)};
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          return {
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
            scale: 1
          };
        })()
      `;
      const result = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
        expression: js,
        returnByValue: true
      });
      throwIfExceptionDetails(result);
      clip = result.result.value;
    } else {
      // Explicit viewport clip — required for correct sizing on Linux HiDPI.
      const vpResult = await sendCdpCommand(wsUrl, 'Runtime.evaluate', {
        expression: '({ width: window.innerWidth, height: window.innerHeight })',
        returnByValue: true
      });
      throwIfExceptionDetails(vpResult);
      const { width, height } = vpResult.result.value;
      clip = { x: 0, y: 0, width, height, scale: 1 };
    }

    const result = await sendCdpCommand(wsUrl, 'Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: fullPage,
      clip
    });

    const buffer = Buffer.from(result.data, 'base64');
    fs.writeFileSync(filename, buffer);

    await downscaleImageIfNeeded(filename, MAX_IMAGE_DIMENSION_PX);

    return path.resolve(filename);
  }

  return { screenshot };
}

module.exports = { attachScreenshot };
