import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSession } = require('../skills/browsing/chrome-ws-lib.js');

describe('chrome-ws-lib exposes dialogs API', () => {
  it('session has a dialogs property with getOpen / withDialogAwareness', () => {
    const session = createSession();
    assert.equal(typeof session.dialogs.getOpen, 'function');
    assert.equal(typeof session.dialogs.withDialogAwareness, 'function');
  });
});
