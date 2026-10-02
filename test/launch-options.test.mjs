/**
 * resolveHeadless (mcp/src/launch-options.ts, compiled to
 * mcp/dist/launch-options.js): flags win, then CHROME_WS_HEADLESS, then display
 * auto-detection. The environment variable is the only way to choose headless
 * for a plugin-installed server, whose command line the user cannot change.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHeadless as resolve } from '../mcp/dist/launch-options.js';

const resolveHeadless = (...args) => resolve(...args).headless;

const withDisplay = () => true;
const noDisplay = () => false;

test('flags win over the environment and display detection', () => {
  assert.equal(resolveHeadless(['--headless'], { CHROME_WS_HEADLESS: '0' }, withDisplay), true);
  assert.equal(resolveHeadless(['--headed'], { CHROME_WS_HEADLESS: '1' }, noDisplay), false);
});

test('CHROME_WS_HEADLESS chooses the mode when no flag is given', () => {
  for (const value of ['1', 'true', 'YES', ' on ']) {
    assert.equal(resolveHeadless([], { CHROME_WS_HEADLESS: value }, withDisplay), true, value);
  }
  for (const value of ['0', 'false', 'No', 'off']) {
    assert.equal(resolveHeadless([], { CHROME_WS_HEADLESS: value }, noDisplay), false, value);
  }
});

test('without a flag or variable, the display decides (unchanged default)', () => {
  assert.equal(resolveHeadless([], {}, withDisplay), false);
  assert.equal(resolveHeadless([], {}, noDisplay), true);
  assert.equal(resolveHeadless([], { CHROME_WS_HEADLESS: '' }, noDisplay), true);
});

test('an unrecognized value is reported and ignored', () => {
  const warnings = [];
  assert.equal(resolveHeadless([], { CHROME_WS_HEADLESS: 'maybe' }, withDisplay, (m) => warnings.push(m)), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /CHROME_WS_HEADLESS="maybe"/);
});

test('the reason names what decided the mode', () => {
  assert.equal(resolve([], { CHROME_WS_HEADLESS: '1' }, withDisplay).reason, 'set by CHROME_WS_HEADLESS');
  assert.equal(resolve(['--headless'], {}, withDisplay).reason, 'forced via --headless');
  assert.equal(resolve([], {}, noDisplay).reason, 'auto-detected no display');
});
