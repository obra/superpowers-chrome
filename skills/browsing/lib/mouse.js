const { getElementSelector } = require('./element-selector');
const { throwIfExceptionDetails } = require('./cdp-utils');

// Brief pause between the last mouseMoved step and mouseReleased so apps
// that process drag events asynchronously have time to commit.
const DRAG_SETTLE_MS = 50;

// Default RNG (uses Math.random). Injectable via _rng for deterministic tests.
function defaultRng() {
  return Math.random();
}

/**
 * Compute N evenly-spaced points along a quadratic Bezier curve from
 * (x0,y0) to (x1,y1) with a perpendicular-offset control point.
 * The offset is a random fraction of the chord length so paths curve
 * naturally but don't overshoot wildly.
 *
 * Returns an array of {x, y} integer coordinates, NOT including the
 * start point but INCLUDING the end point.
 */
function bezierPoints(x0, y0, x1, y1, n, rng) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // Control point: midpoint ± perpendicular offset (5%–25% of chord).
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const perpScale = (0.05 + rng() * 0.20) * dist;
  // Perpendicular unit vector (rotate 90°): (-dy/dist, dx/dist)
  const perpX = dist > 0 ? (-dy / dist) * perpScale : 0;
  const perpY = dist > 0 ? (dx / dist) * perpScale : 0;
  const cx = mx + perpX;
  const cy = my + perpY;

  const points = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    // Quadratic Bezier: B(t) = u²·P0 + 2u·t·Pc + t²·P1
    points.push({
      x: Math.round(u * u * x0 + 2 * u * t * cx + t * t * x1),
      y: Math.round(u * u * y0 + 2 * u * t * cy + t * t * y1),
    });
  }
  return points;
}

/**
 * Ease-in/ease-out (sinusoidal) weight for step i of n total steps.
 * Returns a value 0–1 that is small at start and end, large in middle.
 */
function easeWeight(i, n) {
  return Math.sin((i / n) * Math.PI);
}

/**
 * CDP mouse actions — click, hover, drag, mouse-move, scroll, double-click,
 * right-click. Every entry resolves to real `Input.dispatchMouseEvent`
 * calls so React (and other framework) synthetic-event handlers see
 * genuine input. JRV-124 and friends established this as the default click
 * path; the older `el.click()` route survives only as a fallback for
 * hidden-element edge cases inside `click`.
 *
 * `attachMouse({ getPageSession, dialogs, _rng })` returns the bound action
 * methods. The pre-action element-coordinate lookup uses the shared
 * `getElementSelector` from lib/element-selector — same visibility-aware
 * picker the rest of the library uses.
 *
 * `_rng` is injectable for deterministic tests; defaults to Math.random.
 */
function attachMouse({ getPageSession, dialogs, _rng }) {
  const { tryHandleDialogSelectorForSession } = require('./dialogs-router.js');

  // Per-session last-known cursor position. Chains consecutive moves so the
  // path starts where the cursor actually is rather than (0,0).
  const lastMousePos = { x: 0, y: 0 };

  // Resolve the random number generator.
  const rng = typeof _rng === 'function' ? _rng : defaultRng;

  /**
   * Send a humanised sequence of mouseMoved events from (fromX, fromY) to
   * (toX, toY) using a quadratic Bezier path with ease-in/ease-out timing.
   *
   * The number of intermediate steps scales with distance so short moves are
   * still smooth and long moves don't fire an unreasonable number of events.
   * Total duration scales with distance: ~80ms per 200px, capped 30–400ms.
   * Inter-event delay follows ease-in/ease-out (slow at start/end) with
   * ±10% random jitter per step.
   *
   * The final event is ALWAYS dispatched at the exact integer target coords.
   * Updates lastMousePos after completion.
   */
  async function humanMouseMove(ps, fromX, fromY, toX, toY, extraParams = {}) {
    const dx = toX - fromX;
    const dy = toY - fromY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Steps: at least 10, one per 15px, no more than 120.
    const steps = Math.min(120, Math.max(10, Math.round(dist / 15)));

    // Total duration: 80ms per 200px, clamped 30–400ms.
    const totalMs = Math.min(400, Math.max(30, (dist / 200) * 80));

    // Compute weighted step durations (ease-in/ease-out).
    const weights = Array.from({ length: steps }, (_, i) => easeWeight(i + 1, steps));
    const weightSum = weights.reduce((a, b) => a + b, 0);

    // Bezier path (includes end point).
    const points = bezierPoints(fromX, fromY, toX, toY, steps, rng);

    for (let i = 0; i < steps; i++) {
      const { x, y } = i === steps - 1
        ? { x: Math.round(toX), y: Math.round(toY) }
        : points[i];

      await ps.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x,
        y,
        ...extraParams,
      });

      // Compute this step's delay with ±10% jitter.
      const baseDuration = (weights[i] / weightSum) * totalMs;
      const jitter = 1 + (rng() * 0.2 - 0.1);
      const delayMs = Math.round(baseDuration * jitter);
      if (delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    lastMousePos.x = Math.round(toX);
    lastMousePos.y = Math.round(toY);
  }

  // Common helper: resolve a CSS/XPath selector to centered viewport coords
  // after scrolling the element into view. Returns { x, y } or throws.
  async function resolveCenter(ps, selector, label = 'Element') {
    const js = `
      (() => {
        const el = ${getElementSelector(selector)};
        if (!el) return { found: false };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = el.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          found: true
        };
      })()
    `;
    const result = await ps.send('Runtime.evaluate', {
      expression: js,
      returnByValue: true
    });
    throwIfExceptionDetails(result);
    if (!result.result.value || !result.result.value.found) {
      throw new Error(`${label} not found: ${selector}`);
    }
    return { x: result.result.value.x, y: result.result.value.y };
  }

  /**
   * Click element using CDP mouse events (works with React and all frameworks).
   * Moves the cursor to the element center via a humanised Bezier path before
   * pressing. Falls back to `el.click()` if CDP coordinate resolution throws
   * but the element exists. Throws if the element cannot be found at all —
   * never report a fake-success click on a missing selector.
   */
  async function click(tabIndexOrWsUrl, selector) {
    const ps = await getPageSession(tabIndexOrWsUrl);

    if (selector && selector.startsWith('dialog::') && dialogs) {
      const state = dialogs.getOpen(ps.sessionId);
      const routed = await tryHandleDialogSelectorForSession({ selector, op: 'click', state, pageSession: ps });
      if (routed.handled) {
        if (routed.error) throw new Error(routed.error);
        if (routed.clearDialog) dialogs.clear(ps.sessionId);
        return routed.result;
      }
    }

    try {
      const { x, y } = await resolveCenter(ps, selector);

      await humanMouseMove(ps, lastMousePos.x, lastMousePos.y, x, y);

      await ps.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', clickCount: 1
      });
      await ps.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', clickCount: 1
      });

      return { clicked: true, x, y };
    } catch (_e) {
      // Skip the fallback when a dialog is already open for this session:
      // the press/release timed out because the click opened a dialog and the
      // page is paused. Running Element.click() now queues a SECOND click
      // event behind the dialog, so dismissing later spawns another confirm
      // (scenario 03 step 6 regression). Propagate the original timeout so
      // the caller learns the click landed on a dialog.
      if (dialogs && dialogs.getOpen && dialogs.getOpen(ps.sessionId)) {
        throw _e;
      }
      // Fallback for cases where CDP coordinate resolution failed but the
      // element actually exists (e.g., hidden / zero bounding rect). Resolve
      // the element first, click via JS only if it's really there, and
      // propagate a not-found error otherwise — never silently succeed.
      const js = `(() => {
        const _el = ${getElementSelector(selector)};
        if (!_el) return { found: false };
        _el.click();
        return { found: true };
      })()`;
      const fallbackResult = await ps.send('Runtime.evaluate', {
        expression: js,
        returnByValue: true,
      });
      throwIfExceptionDetails(fallbackResult);
      if (!fallbackResult.result.value || !fallbackResult.result.value.found) {
        throw new Error(`Element not found: ${selector}`);
      }
      return { clicked: true, fallback: true };
    }
  }

  /**
   * Hover over an element using CDP mouseMoved.
   * Triggers CSS :hover, mouseenter/mouseover events, tooltips, dropdown menus.
   * Uses a humanised Bezier path to reach the element.
   */
  async function hover(tabIndexOrWsUrl, selector) {
    const ps = await getPageSession(tabIndexOrWsUrl);
    const { x, y } = await resolveCenter(ps, selector);

    await humanMouseMove(ps, lastMousePos.x, lastMousePos.y, x, y);

    return { hovered: true, x, y };
  }

  /**
   * Drag from source element to target element or coordinates.
   * Uses Input.dispatchMouseEvent to trigger native drag-and-drop, bypassing
   * the DataTransfer restriction on synthetic JS DragEvents.
   *
   * @param {number|string} tabIndexOrWsUrl - Tab index or WebSocket URL
   * @param {string} sourceSelector - CSS/XPath selector for the drag source
   * @param {string|{x:number,y:number}} target - Target selector string or {x,y} coordinates
   * @param {object} options
   * @param {number} [options.steps=8] - Intermediate mouseMoved steps (must exceed
   *                                     the browser's ~4px drag-detection threshold)
   */
  async function drag(tabIndexOrWsUrl, sourceSelector, target, options = {}) {
    const ps = await getPageSession(tabIndexOrWsUrl);
    const steps = options.steps || 8;

    const src = await resolveCenter(ps, sourceSelector, 'Source element');

    let dst;
    if (typeof target === 'object' && target.x !== undefined && target.y !== undefined) {
      dst = { x: target.x, y: target.y };
    } else {
      dst = await resolveCenter(ps, target, 'Target element');
    }

    await ps.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: src.x, y: src.y, button: 'left', clickCount: 1
    });

    for (let i = 1; i <= steps; i++) {
      const ratio = i / steps;
      await ps.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(src.x + (dst.x - src.x) * ratio),
        y: Math.round(src.y + (dst.y - src.y) * ratio),
        button: 'left'
      });
    }

    // Brief pause for apps that process drag events asynchronously.
    await new Promise(resolve => setTimeout(resolve, DRAG_SETTLE_MS));

    await ps.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: Math.round(dst.x),
      y: Math.round(dst.y),
      button: 'left',
      clickCount: 1
    });

    return { dragged: true, from: { x: src.x, y: src.y }, to: { x: dst.x, y: dst.y }, steps };
  }

  /**
   * Move mouse to specific coordinates using a humanised Bezier path.
   * Useful for: pre-click mouse patterns (bot detection), captcha puzzles,
   * hover effects on coordinate-based targets.
   *
   * `options.fromX`/`fromY` set an explicit start; otherwise the last-known
   * cursor position (maintained across consecutive moves) is used as the
   * start so chains of moves flow naturally.
   */
  async function mouseMove(tabIndexOrWsUrl, x, y, options = {}) {
    const ps = await getPageSession(tabIndexOrWsUrl);

    const fromX = options.fromX !== undefined ? options.fromX : lastMousePos.x;
    const fromY = options.fromY !== undefined ? options.fromY : lastMousePos.y;

    await humanMouseMove(ps, fromX, fromY, x, y);

    return { moved: true, x, y };
  }

  /**
   * Scroll using CDP mouse-wheel events.
   * Simulates real wheel input — bot detectors flag JavaScript `scrollTo`.
   *
   * @param {object} options
   * @param {string} [options.selector] - Element to anchor the wheel event on
   * @param {number} [options.deltaX=0] - Horizontal scroll (positive = right)
   * @param {number} [options.deltaY=0] - Vertical scroll (positive = down)
   */
  async function scroll(tabIndexOrWsUrl, options = {}) {
    const ps = await getPageSession(tabIndexOrWsUrl);

    let x = options.x || 100;
    let y = options.y || 100;

    if (options.selector) {
      // Inline the selector lookup (rather than using the throwing resolveCenter)
      // so a missing element falls back to default coordinates instead of throwing —
      // matches the pre-extraction scroll() behaviour. CDP errors still propagate.
      const js = `
        (() => {
          const el = ${getElementSelector(options.selector)};
          if (!el) return { found: false };
          const rect = el.getBoundingClientRect();
          return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            found: true
          };
        })()
      `;
      const result = await ps.send('Runtime.evaluate', {
        expression: js,
        returnByValue: true
      });
      throwIfExceptionDetails(result);
      if (result.result.value && result.result.value.found) {
        x = result.result.value.x;
        y = result.result.value.y;
      }
    }

    await ps.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.round(x),
      y: Math.round(y),
      deltaX: options.deltaX || 0,
      deltaY: options.deltaY || 0
    });

    return { scrolled: true, x, y, deltaX: options.deltaX || 0, deltaY: options.deltaY || 0 };
  }

  /**
   * Double-click an element using CDP mouse events.
   * Moves to element via humanised Bezier path, then fires
   * mousedown, mouseup, click, mousedown, mouseup, click, dblclick.
   */
  async function doubleClick(tabIndexOrWsUrl, selector) {
    const ps = await getPageSession(tabIndexOrWsUrl);
    const { x, y } = await resolveCenter(ps, selector);

    await humanMouseMove(ps, lastMousePos.x, lastMousePos.y, x, y);

    await ps.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 1
    });
    await ps.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 1
    });
    // Second click with clickCount: 2 triggers dblclick.
    await ps.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 2
    });
    await ps.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 2
    });

    return { doubleClicked: true, x, y };
  }

  /**
   * Right-click an element using CDP mouse events.
   * Moves to element via humanised Bezier path, then fires
   * mousedown (button 2), mouseup (button 2), contextmenu.
   */
  async function rightClick(tabIndexOrWsUrl, selector) {
    const ps = await getPageSession(tabIndexOrWsUrl);
    const { x, y } = await resolveCenter(ps, selector);

    await humanMouseMove(ps, lastMousePos.x, lastMousePos.y, x, y);

    await ps.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'right', clickCount: 1
    });
    await ps.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'right', clickCount: 1
    });

    return { rightClicked: true, x, y };
  }

  return { click, hover, drag, mouseMove, scroll, doubleClick, rightClick };
}

module.exports = { attachMouse };
