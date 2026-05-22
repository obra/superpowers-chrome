import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { makePageSessionFake } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachMouse } = require('../../skills/browsing/lib/mouse.js');

// Deterministic RNG: always returns 0.5 (mid-range), which eliminates
// jitter and produces a predictable Bezier offset.
function deterministicRng() { return 0.5; }

describe('mouse', () => {
  function setup(handlers = {}) {
    const ps = makePageSessionFake({
      'Runtime.evaluate': () => ({ result: { value: { found: true, x: 100, y: 200 } } }),
      'Input.dispatchMouseEvent': () => ({}),
      ...handlers
    });
    const getPageSession = async () => ps;
    return { ...attachMouse({ getPageSession, _rng: deterministicRng }), ps };
  }

  it('click sends humanised mouseMoved events then mousePressed + mouseReleased at element center', async () => {
    const { click, ps } = setup();
    await click(0, '#button');

    const mouseCalls = ps.calls.filter(c => c.method === 'Input.dispatchMouseEvent');
    // There should be at least 3 events: N mouseMoved + mousePressed + mouseReleased.
    assert.ok(mouseCalls.length >= 3, `expected >=3 mouse events, got ${mouseCalls.length}`);

    const movedCalls = mouseCalls.filter(c => c.params.type === 'mouseMoved');
    assert.ok(movedCalls.length >= 1, 'expected at least one mouseMoved before click');

    // Last moved event must be at the exact element center.
    const lastMoved = movedCalls[movedCalls.length - 1];
    assert.equal(lastMoved.params.x, 100);
    assert.equal(lastMoved.params.y, 200);

    // mousePressed and mouseReleased must be at element center.
    const pressedCall = mouseCalls.find(c => c.params.type === 'mousePressed');
    const releasedCall = mouseCalls.find(c => c.params.type === 'mouseReleased');
    assert.ok(pressedCall, 'expected mousePressed');
    assert.ok(releasedCall, 'expected mouseReleased');
    assert.equal(pressedCall.params.x, 100);
    assert.equal(pressedCall.params.y, 200);
  });

  it('click throws when selector matches no element (no silent success)', async () => {
    // Both resolveCenter and the fallback see the element as missing.
    // The function must propagate that as an error rather than returning
    // { clicked: true, fallback: true } — that lies to the caller.
    const { click } = setup({
      'Runtime.evaluate': () => ({ result: { value: { found: false } } })
    });
    await assert.rejects(
      () => click(0, '#nonexistent'),
      /not found/i,
    );
  });

  it('click falls back to el.click() when CDP coord resolution throws but element exists', async () => {
    let callCount = 0;
    const ps = makePageSessionFake({
      'Runtime.evaluate': () => {
        callCount++;
        // 1st call: resolveCenter — return found:false so it throws.
        // 2nd call: fallback — return found:true so click succeeds.
        return { result: { value: { found: callCount === 1 ? false : true } } };
      },
      'Input.dispatchMouseEvent': () => ({}),
    });
    const getPageSession = async () => ps;
    const { click } = attachMouse({ getPageSession });
    const result = await click(0, '#hidden-but-exists');
    assert.equal(result.fallback, true);
    const evals = ps.calls.filter(c => c.method === 'Runtime.evaluate');
    assert.equal(evals.length, 2);
  });

  it('hover sends humanised mouseMoved events ending at element center', async () => {
    const { hover, ps } = setup();
    await hover(0, '#tooltip-target');
    const mouseCalls = ps.calls.filter(c => c.method === 'Input.dispatchMouseEvent');
    assert.ok(mouseCalls.length >= 1, 'expected at least one mouseMoved');
    // All events must be mouseMoved (hover produces no press/release).
    for (const c of mouseCalls) {
      assert.equal(c.params.type, 'mouseMoved');
    }
    // Final event must be at the exact element center.
    const last = mouseCalls[mouseCalls.length - 1];
    assert.equal(last.params.x, 100);
    assert.equal(last.params.y, 200);
  });

  it('drag sends mousePressed, N intermediate mouseMoved, then mouseReleased', async () => {
    const { drag, ps } = setup();
    await drag(0, '#src', '#dst', { steps: 4 });
    const mouseCalls = ps.calls.filter(c => c.method === 'Input.dispatchMouseEvent');
    // 1 pressed + 4 moved + 1 released = 6
    assert.equal(mouseCalls.length, 6);
    assert.equal(mouseCalls[0].params.type, 'mousePressed');
    assert.equal(mouseCalls[mouseCalls.length - 1].params.type, 'mouseReleased');
  });

  it('drag accepts coordinate target instead of selector', async () => {
    const { drag, ps } = setup();
    await drag(0, '#src', { x: 500, y: 600 }, { steps: 2 });
    const mouseCalls = ps.calls.filter(c => c.method === 'Input.dispatchMouseEvent');
    const lastMove = mouseCalls[mouseCalls.length - 2]; // last move before release
    assert.equal(lastMove.params.x, 500);
    assert.equal(lastMove.params.y, 600);
  });

  it('mouseMove sends humanised mouseMoved events ending at target coords', async () => {
    const { mouseMove, ps } = setup();
    // Move from (0,0) to (300,400) — distance ~500px, so well above 10 steps minimum.
    await mouseMove(0, 300, 400);
    const mouseCalls = ps.calls.filter(c => c.method === 'Input.dispatchMouseEvent');
    // All must be mouseMoved.
    for (const c of mouseCalls) {
      assert.equal(c.params.type, 'mouseMoved');
    }
    // At least 10 steps for a ~500px move.
    assert.ok(mouseCalls.length >= 10, `expected >=10 events for ~500px move, got ${mouseCalls.length}`);
    // Final event must be at exact target.
    const last = mouseCalls[mouseCalls.length - 1];
    assert.equal(last.params.x, 300);
    assert.equal(last.params.y, 400);
  });

  it('scroll sends mouseWheel with deltaX/deltaY', async () => {
    const { scroll, ps } = setup();
    await scroll(0, { deltaX: 0, deltaY: 500 });
    const wheelCall = ps.calls.find(c => c.method === 'Input.dispatchMouseEvent');
    assert.equal(wheelCall.params.type, 'mouseWheel');
    assert.equal(wheelCall.params.deltaY, 500);
  });

  it('doubleClick sends humanised move then two press/release pairs with clickCount 1 then 2', async () => {
    const { doubleClick, ps } = setup();
    await doubleClick(0, '#item');
    const mouseCalls = ps.calls.filter(c => c.method === 'Input.dispatchMouseEvent');
    // Humanised move (N events) + mousePressed(1) + mouseReleased(1) + mousePressed(2) + mouseReleased(2).
    assert.ok(mouseCalls.length >= 4, `expected >=4 mouse events, got ${mouseCalls.length}`);
    const pressedCalls = mouseCalls.filter(c => c.params.type === 'mousePressed');
    const releasedCalls = mouseCalls.filter(c => c.params.type === 'mouseReleased');
    assert.equal(pressedCalls.length, 2);
    assert.equal(releasedCalls.length, 2);
    assert.equal(pressedCalls[0].params.clickCount, 1);
    assert.equal(pressedCalls[1].params.clickCount, 2);
  });

  it('rightClick uses button: "right" for press and release', async () => {
    const { rightClick, ps } = setup();
    await rightClick(0, '#contextmenu-target');
    const mouseCalls = ps.calls.filter(c => c.method === 'Input.dispatchMouseEvent');
    const pressedCall = mouseCalls.find(c => c.params.type === 'mousePressed');
    assert.ok(pressedCall, 'expected mousePressed');
    assert.equal(pressedCall.params.button, 'right');
  });
});

describe('mouse humanization', () => {
  function setupWithRng(rngValue = 0.5, handlers = {}) {
    const ps = makePageSessionFake({
      'Runtime.evaluate': () => ({ result: { value: { found: true, x: 100, y: 100 } } }),
      'Input.dispatchMouseEvent': () => ({}),
      ...handlers,
    });
    const getPageSession = async () => ps;
    // Fixed RNG: always returns same value for deterministic paths.
    const rng = () => rngValue;
    return { ...attachMouse({ getPageSession, _rng: rng }), ps };
  }

  it('mouseMove from (0,0) to (300,0) emits >3 mouseMoved events all with type=mouseMoved', async () => {
    const { mouseMove, ps } = setupWithRng(0.5);
    await mouseMove(0, 300, 0, { fromX: 0, fromY: 0 });
    const moved = ps.calls.filter(c => c.method === 'Input.dispatchMouseEvent');
    assert.ok(moved.length > 3, `expected >3 events, got ${moved.length}`);
    for (const c of moved) {
      assert.equal(c.params.type, 'mouseMoved');
    }
  });

  it('mouseMove final event is exactly at target coords', async () => {
    const { mouseMove, ps } = setupWithRng(0.5);
    await mouseMove(0, 200, 150, { fromX: 0, fromY: 0 });
    const moved = ps.calls.filter(c => c.method === 'Input.dispatchMouseEvent');
    const last = moved[moved.length - 1];
    assert.equal(last.params.x, 200);
    assert.equal(last.params.y, 150);
  });

  it('mouseMove path deviates from a straight line (Bezier curve)', async () => {
    const { mouseMove, ps } = setupWithRng(0.5);
    // Move along a diagonal: straight line would have x === y at all points.
    await mouseMove(0, 200, 200, { fromX: 0, fromY: 0 });
    const moved = ps.calls.filter(c =>
      c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mouseMoved'
    );
    // Skip first and last; check that at least one intermediate point is off
    // the straight line y=x (i.e. x !== y).
    const intermediate = moved.slice(0, -1);
    const anyDeviation = intermediate.some(c => c.params.x !== c.params.y);
    assert.ok(anyDeviation, 'expected at least one Bezier point to deviate from straight line y=x');
  });

  it('mouseMove chains: second move starts from where first ended', async () => {
    const { mouseMove, ps } = setupWithRng(0.5);
    // First move to (100, 100)
    await mouseMove(0, 100, 100, { fromX: 0, fromY: 0 });
    const firstMoved = ps.calls.filter(c => c.method === 'Input.dispatchMouseEvent');
    const lastOfFirst = firstMoved[firstMoved.length - 1];
    assert.equal(lastOfFirst.params.x, 100);
    assert.equal(lastOfFirst.params.y, 100);

    ps.calls.length = 0; // clear recorded calls

    // Second move with no fromX/fromY — should start from (100,100) not (0,0).
    // If it started from (0,0) to (200,200), all points would have x==y for
    // a straight line; starting from (100,100) to (200,200) would also have
    // x==y on a straight line. Use a different target to make it distinct.
    await mouseMove(0, 300, 100); // fromX/fromY defaults to lastMousePos
    const secondMoved = ps.calls.filter(c => c.method === 'Input.dispatchMouseEvent');
    // The first event of the second move should not be at (0,0).
    const firstOfSecond = secondMoved[0];
    // It should be between (100,100) and (300,100) — x > 100 shows we started from (100,100).
    assert.ok(firstOfSecond.params.x > 0 || firstOfSecond.params.y > 0,
      'second move should not start from origin');
    // Final event at exact target.
    const lastOfSecond = secondMoved[secondMoved.length - 1];
    assert.equal(lastOfSecond.params.x, 300);
    assert.equal(lastOfSecond.params.y, 100);
  });
});

describe('mouse click routes dialog::* selectors', () => {
  it('click dialog::accept invokes the dialog router and skips DOM resolution', async () => {
    const ps = makePageSessionFake({
      'Page.handleJavaScriptDialog': () => ({}),
    });
    const dialogState = { kind: 'alert', payload: { message: 'x', url: '', defaultPrompt: '', hasBrowserHandler: false }, staged: {} };
    const dialogs = {
      getOpen: () => dialogState,
    };
    const getPageSession = async () => ps;
    const { click } = attachMouse({ getPageSession, dialogs });
    await click(0, 'dialog::accept');
    const call = ps.calls.find(c => c.method === 'Page.handleJavaScriptDialog');
    assert.ok(call, 'expected Page.handleJavaScriptDialog call');
    assert.equal(call.params.accept, true);
    // No DOM-resolution call (Runtime.evaluate) should have happened.
    assert.ok(!ps.calls.some(c => c.method === 'Runtime.evaluate'));
  });
});
