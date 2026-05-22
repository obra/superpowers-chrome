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
 * Path resolution for user-supplied filenames:
 *   - Absolute path (starts with `/` or a Windows drive letter) → used as-is.
 *   - Relative path → resolved against the session directory. If no session
 *     directory exists yet, `initializeSession()` is called to create one.
 *   - No filename supplied → auto-generates a timestamped name in session dir.
 *
 * `attachScreenshot({ getPageSession, state, initializeSession })` returns
 * the bound action. `state` and `initializeSession` are optional; when
 * absent, relative paths are resolved against CWD (legacy behaviour).
 */
function attachScreenshot({ getPageSession, state, initializeSession }) {
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

  /**
   * Resolve a user-supplied filename to an absolute path.
   *
   * - Absolute path → unchanged.
   * - Relative path → joined with session dir (creating it if necessary).
   * - Falsy (null / undefined / '') → auto-generated name in session dir.
   */
  function resolveScreenshotPath(filename) {
    if (!filename) {
      // Auto-generate a timestamped filename in the session dir.
      const dir = initializeSession ? initializeSession() : (state && state.sessionDir) || process.cwd();
      return path.join(dir, `screenshot-${Date.now()}.png`);
    }

    // Absolute: /foo/bar or C:\foo\bar (Windows).
    if (path.isAbsolute(filename)) {
      return filename;
    }

    // Relative: join with session dir.
    let dir;
    if (initializeSession) {
      dir = initializeSession();
    } else if (state && state.sessionDir) {
      dir = state.sessionDir;
    } else {
      // No session context — fall back to CWD (legacy behaviour).
      return path.resolve(filename);
    }
    return path.join(dir, filename);
  }

  async function screenshot(tabIndexOrWsUrl, filename, selector = null, fullPage = false) {
    const resolvedFilename = resolveScreenshotPath(filename);
    const pageSession = await getPageSession(tabIndexOrWsUrl);

    let clip;
    if (fullPage) {
      const metrics = await pageSession.send('Page.getLayoutMetrics');
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
      const result = await pageSession.send('Runtime.evaluate', {
        expression: js,
        returnByValue: true
      });
      throwIfExceptionDetails(result);
      clip = result.result.value;
    } else {
      // Explicit viewport clip — required for correct sizing on Linux HiDPI.
      const vpResult = await pageSession.send('Runtime.evaluate', {
        expression: '({ width: window.innerWidth, height: window.innerHeight })',
        returnByValue: true
      });
      throwIfExceptionDetails(vpResult);
      const { width, height } = vpResult.result.value;
      clip = { x: 0, y: 0, width, height, scale: 1 };
    }

    const result = await pageSession.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: fullPage,
      clip
    });

    const buffer = Buffer.from(result.data, 'base64');
    fs.writeFileSync(resolvedFilename, buffer);

    await downscaleImageIfNeeded(resolvedFilename, MAX_IMAGE_DIMENSION_PX);

    return resolvedFilename;
  }

  return { screenshot };
}

module.exports = { attachScreenshot };
