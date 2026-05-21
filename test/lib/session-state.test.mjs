import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createState } = require('../../skills/browsing/lib/session-state.js');

describe('session-state: bridge handles', () => {
  it('exposes browserBridge slot, initially null', () => {
    const state = createState();
    assert.equal(state.browserBridge, null);
  });

  it('exposes browserSession slot, initially null', () => {
    const state = createState();
    assert.equal(state.browserSession, null);
  });
});
