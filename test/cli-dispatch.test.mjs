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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'skills', 'browsing', 'chrome-ws');

function runCLI(args, { env = {}, timeoutMs = 5000 } = {}) {
  return spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
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

  it('start uses the shared Chrome arg builder and honors CHROME_EXTRA_ARGS', () => {
    const dir = path.join(tmpdir(), `chrome-ws-cli-args-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const fakeChrome = path.join(dir, 'fake-chrome');
    const argsFile = path.join(dir, 'args.json');

    writeFileSync(fakeChrome, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.FAKE_CHROME_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
`, { mode: 0o755 });

    try {
      const r = runCLI(['--port=49217', 'start'], {
        env: {
          CHROME_WS_BROWSER: fakeChrome,
          CHROME_EXTRA_ARGS: '--headless=new --disable-gpu --flag-from-env',
          FAKE_CHROME_ARGS_FILE: argsFile,
        },
        timeoutMs: 5000,
      });

      assert.equal(r.status, 1, 'fake Chrome never opens the debug port, so start should fail');
      assert.ok(existsSync(argsFile), 'fake Chrome should have been spawned');

      const args = JSON.parse(readFileSync(argsFile, 'utf8'));
      assert.ok(args.includes('--remote-debugging-port=49217'));
      assert.ok(args.some(a => a.startsWith('--user-data-dir=')));
      assert.ok(args.includes('--no-first-run'), 'baseline shared-helper flag should be present');
      assert.ok(args.includes('--headless=new'), 'CHROME_EXTRA_ARGS should be appended');
      assert.ok(args.includes('--disable-gpu'), 'CHROME_EXTRA_ARGS should support multiple flags');
      assert.ok(args.includes('--flag-from-env'), 'CHROME_EXTRA_ARGS should reach CLI start');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Issue #35: when Chrome dies at launch, the CLI previously reported the
  // ambiguous "Chrome started but remote debugging not accessible" and threw
  // Chrome's stderr away, sending users down the wrong diagnostic path.
  it('start reports an immediate Chrome exit with its code and stderr', () => {
    const dir = path.join(tmpdir(), `chrome-ws-cli-exit-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const fakeChrome = path.join(dir, 'fake-chrome');

    writeFileSync(fakeChrome, `#!/usr/bin/env node
console.error('Running as root without --no-sandbox is not supported.');
process.exit(3);
`, { mode: 0o755 });

    try {
      const r = runCLI(['--port=49219', 'start'], {
        env: { CHROME_WS_BROWSER: fakeChrome },
        timeoutMs: 8000,
      });

      assert.equal(r.status, 1, 'start should fail when Chrome dies immediately');
      assert.match(r.stderr, /Chrome exited with code 3 before opening the debug port/);
      assert.match(r.stderr, /Running as root without --no-sandbox/,
        "Chrome's own stderr must be surfaced");
      assert.doesNotMatch(r.stderr, /Chrome started but remote debugging not accessible/,
        'the old misleading message must be gone');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('start distinguishes a live Chrome with an unresponsive debug port', () => {
    const dir = path.join(tmpdir(), `chrome-ws-cli-live-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const fakeChrome = path.join(dir, 'fake-chrome');

    // Stays alive past the CLI's verify window without opening the port.
    writeFileSync(fakeChrome, `#!/usr/bin/env node
setTimeout(() => {}, 5000);
`, { mode: 0o755 });

    try {
      const r = runCLI(['--port=49220', 'start'], {
        env: { CHROME_WS_BROWSER: fakeChrome },
        timeoutMs: 8000,
      });

      assert.equal(r.status, 1);
      assert.match(r.stderr, /Chrome is running but the debug port .* is not responding/,
        'a live-but-unreachable Chrome must be reported as such');
      assert.doesNotMatch(r.stderr, /Chrome exited/,
        'must not claim Chrome exited when it is still running');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('start reports a spawn failure cleanly instead of an uncaught exception', () => {
    const dir = path.join(tmpdir(), `chrome-ws-cli-spawnfail-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    // A directory passes the CLI's existence check but cannot be executed.

    try {
      const r = runCLI(['--port=49221', 'start'], {
        env: { CHROME_WS_BROWSER: dir },
        timeoutMs: 8000,
      });

      assert.equal(r.status, 1);
      assert.match(r.stderr, /Failed to launch Chrome/,
        'spawn failure must produce a clear message');
      assert.doesNotMatch(r.stderr, /at .*chrome-ws/,
        'must not dump an uncaught-exception stack trace');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('start stays headed by default (no --headless=new without CHROME_EXTRA_ARGS)', () => {
    const dir = path.join(tmpdir(), `chrome-ws-cli-headed-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const fakeChrome = path.join(dir, 'fake-chrome');
    const argsFile = path.join(dir, 'args.json');

    writeFileSync(fakeChrome, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.FAKE_CHROME_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
`, { mode: 0o755 });

    try {
      const r = runCLI(['--port=49218', 'start'], {
        env: {
          CHROME_WS_BROWSER: fakeChrome,
          FAKE_CHROME_ARGS_FILE: argsFile,
        },
        timeoutMs: 5000,
      });

      assert.equal(r.status, 1, 'fake Chrome never opens the debug port, so start should fail');
      assert.ok(existsSync(argsFile), 'fake Chrome should have been spawned');

      const args = JSON.parse(readFileSync(argsFile, 'utf8'));
      assert.ok(args.includes('--no-first-run'), 'shared-helper baseline flag should be present');
      assert.ok(!args.includes('--headless=new'),
        'CLI start must stay headed by default (chromeHeadless: false)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
