import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { makePageSessionFake } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const { attachMouse } = require('../../skills/browsing/lib/mouse.js');

describe('mouse', () => {
  function setup(handlers = {}) {
    const ps = makePageSessionFake({
      'Runtime.evaluate': () => ({ result: { value: { found: true, x: 100, y: 200 } } }),
      'Input.dispatchMouseEvent': () => ({}),
      ...handlers
    });
    const getPageSession = async () => ps;
    return { ...attachMouse({ getPageSession }), ps };
  }

  it('click sends mousePressed + mouseReleased at element center', async () => {
    const { click, ps } = setup();
    await click(0, '#button');

    const mouseCalls = ps.calls.filter(c => c.method === 'Input.dispatchMouseEvent');
    assert.equal(mouseCalls.length, 2);
    assert.equal(mouseCalls[0].params.type, 'mousePressed');
    assert.equal(mouseCalls[1].params.type, 'mouseReleased');
    assert.equal(mouseCalls[0].params.x, 100);
    assert.equal(mouseCalls[0].params.y, 200);
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

  it('hover sends a single mouseMoved at element center', async () => {
    const { hover, ps } = setup();
    await hover(0, '#tooltip-target');
    const mouseCalls = ps.calls.filter(c => c.method === 'Input.dispatchMouseEvent');
    assert.equal(mouseCalls.length, 1);
    assert.equal(mouseCalls[0].params.type, 'mouseMoved');
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

  it('mouseMove without steps sends one move at the target coords', async () => {
    const { mouseMove, ps } = setup();
    await mouseMove(0, 300, 400);
    const mouseCalls = ps.calls.filter(c => c.method === 'Input.dispatchMouseEvent');
    assert.equal(mouseCalls.length, 1);
    assert.equal(mouseCalls[0].params.x, 300);
    assert.equal(mouseCalls[0].params.y, 400);
  });

  it('scroll sends mouseWheel with deltaX/deltaY', async () => {
    const { scroll, ps } = setup();
    await scroll(0, { deltaX: 0, deltaY: 500 });
    const wheelCall = ps.calls.find(c => c.method === 'Input.dispatchMouseEvent');
    assert.equal(wheelCall.params.type, 'mouseWheel');
    assert.equal(wheelCall.params.deltaY, 500);
  });

  it('doubleClick sends two press/release pairs with clickCount 1 then 2', async () => {
    const { doubleClick, ps } = setup();
    await doubleClick(0, '#item');
    const mouseCalls = ps.calls.filter(c => c.method === 'Input.dispatchMouseEvent');
    assert.equal(mouseCalls.length, 4);
    assert.equal(mouseCalls[0].params.clickCount, 1);
    assert.equal(mouseCalls[2].params.clickCount, 2);
  });

  it('rightClick uses button: "right"', async () => {
    const { rightClick, ps } = setup();
    await rightClick(0, '#contextmenu-target');
    const mouseCalls = ps.calls.filter(c => c.method === 'Input.dispatchMouseEvent');
    assert.equal(mouseCalls[0].params.button, 'right');
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
