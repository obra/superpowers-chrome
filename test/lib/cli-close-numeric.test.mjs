/**
 * Verify that `chrome-ws close <N>` accepts a numeric tab index rather than
 * requiring a ws:// URL. Before the fix, the CLI's close command extracted a
 * tab ID directly via a ws:// URL regex and rejected non-URL arguments with
 * "Invalid WebSocket URL". After the fix, it routes through resolveWsUrl()
 * which handles numeric indices and fails with a connection error instead.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, '../../skills/browsing/chrome-ws');

function runCli(args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI_PATH, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      resolve({ stdout, stderr, code: null, timedOut: true });
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut: false });
    });
  });
}

describe('chrome-ws close numeric tab index', () => {
  it('close 0 does not reject with "Invalid WebSocket URL"', async () => {
    // We don't have Chrome running, so it will fail — but the error must come
    // from a connection failure (resolveWsUrl tried to call /json) rather than
    // the old "Invalid WebSocket URL" path that rejected non-ws:// strings.
    const { stderr } = await runCli(['close', '0'], 3000);
    assert.ok(
      !stderr.includes('Invalid WebSocket URL'),
      `Expected connection error, not "Invalid WebSocket URL". Got: ${stderr}`
    );
  });

  it('close with a ws:// URL still works (does not regress)', async () => {
    // A well-formed ws:// URL should proceed past URL parsing and fail at
    // connection or HTTP close, not at URL validation.
    const { stderr } = await runCli(
      ['close', 'ws://127.0.0.1:19999/devtools/page/AAAA-BBBB'],
      3000
    );
    assert.ok(
      !stderr.includes('Invalid WebSocket URL'),
      `Should not reject valid ws:// URL. Got: ${stderr}`
    );
  });
});
