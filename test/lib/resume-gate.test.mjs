// PRI-3710: unit coverage for the external-resumer opt-out in isolation
// (see browser-bridge-resume-race.test.mjs for how browser-bridge.js
// actually uses it).
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hasExternalResumer } = require('../../skills/browsing/lib/resume-gate.js');

const ENV_VAR = 'SUPERPOWERS_CHROME_EXTERNAL_RESUMER';

describe('resume-gate: hasExternalResumer', () => {
  let originalValue;

  beforeEach(() => {
    originalValue = process.env[ENV_VAR];
  });

  afterEach(() => {
    if (originalValue === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = originalValue;
  });

  it('is false when the env var is unset — the plain-user-of-this-plugin default', () => {
    delete process.env[ENV_VAR];
    assert.equal(hasExternalResumer(), false);
  });

  it('is true when the env var is exactly "1"', () => {
    process.env[ENV_VAR] = '1';
    assert.equal(hasExternalResumer(), true);
  });

  it('is false for any other value — no silent truthy coercion', () => {
    for (const value of ['true', 'yes', '0', '', '2']) {
      process.env[ENV_VAR] = value;
      assert.equal(hasExternalResumer(), false, `expected false for ${JSON.stringify(value)}`);
    }
  });
});
