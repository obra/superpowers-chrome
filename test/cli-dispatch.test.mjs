/**
 * Tests for the chrome-ws CLI's command-dispatch layer.
 *
 * The 07-cli-smoke scenario surfaced two issues at the dispatch boundary:
 *   1. `stop` is advertised in --help but had no dispatch case, so
 *      invoking it fell through to the `raw` usage banner and exited 1.
 *   2. The fallthrough error printed the raw usage instead of saying
 *      "Unknown command: X", which made the `stop` regression look like
 *      a raw-command argument problem.
 *
 * These tests don't need a real Chrome — they exercise the CLI's argv
 * parsing and dispatch table directly via child_process.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'skills', 'browsing', 'chrome-ws');

function runCLI(args, { timeoutMs = 5000 } = {}) {
  return spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
  });
}

describe('chrome-ws CLI dispatch', () => {
  it('--help lists `stop` as a command', () => {
    const r = runCLI(['--help']);
    assert.equal(r.status, 0, '--help should exit 0');
    assert.match(r.stdout, /^\s*stop\s+/m, 'help should advertise a stop command');
  });

  it('unknown command prints "Unknown command:" not the raw usage banner', () => {
    const r = runCLI(['nopesauce']);
    assert.equal(r.status, 1, 'unknown command should exit 1');
    assert.match(r.stderr, /Unknown command: nopesauce/);
    assert.doesNotMatch(
      r.stderr,
      /Usage: chrome-ws raw </,
      'unknown commands must not print the raw-only usage banner'
    );
    assert.match(r.stderr, /chrome-ws --help/, 'should steer the user to --help');
  });

  it('raw with missing args still prints the raw-specific usage', () => {
    // After separating "unknown command" from "raw arg validation",
    // the raw-usage banner is reserved for actual raw-call mistakes.
    const r = runCLI(['raw']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Usage: chrome-ws raw <tab-index-or-ws-url> <json-rpc-payload>/);
  });

  it('stop is dispatched (does not fall through to the unknown-command path)', () => {
    // With Chrome not running, `stop` should fail with a stop-specific
    // error — NOT "Unknown command" and NOT the raw usage banner. The
    // exact failure text depends on the underlying killChrome behavior;
    // what matters is that the dispatch hit the stop branch.
    const r = runCLI(['stop']);
    assert.doesNotMatch(
      r.stderr,
      /Unknown command/,
      'stop must not be reported as unknown — it has a dispatch case'
    );
    assert.doesNotMatch(
      r.stderr,
      /Usage: chrome-ws raw </,
      'stop must not print the raw usage banner'
    );
  });
});
