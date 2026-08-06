import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = path.join(__dirname, '..', 'mcp', 'dist', 'index.js');

const READY_MARKER = 'running via stdio';

/**
 * Spawn the bundled server and resolve once it reports readiness on stderr.
 * Rejects if it dies first or never becomes ready.
 */
function spawnServer({ readyTimeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [BUNDLE_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      reject(new Error(`server never became ready in ${readyTimeoutMs}ms\nstderr:\n${stderr}`));
    }, readyTimeoutMs);

    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      if (!settled && stderr.includes(READY_MARKER)) {
        settled = true;
        clearTimeout(timer);
        resolve({ proc, getStderr: () => stderr });
      }
    });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    proc.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`server exited before ready (code=${code}, signal=${signal})\nstderr:\n${stderr}`));
    });
  });
}

function waitForExit(proc, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

describe('host lifecycle', () => {
  // The leak this guards against: the SDK's stdio transport subscribes only to
  // stdin's 'data' and 'error', so EOF on the pipe used to reach nothing and the
  // process outlived its host indefinitely — holding a profile lock, which
  // pushed the next server onto `<profile>-2` and a second Chrome.
  it('exits when the host closes stdin', async () => {
    const { proc, getStderr } = await spawnServer();

    proc.stdin.end();

    const exit = await waitForExit(proc, 5000);
    if (!exit) {
      proc.kill('SIGKILL');
      assert.fail(`server still running 5s after stdin closed\nstderr:\n${getStderr()}`);
    }
    assert.strictEqual(exit.signal, null, `expected a clean exit, got signal ${exit.signal}`);
    assert.strictEqual(exit.code, 0, `expected exit code 0, got ${exit.code}`);
    assert.match(getStderr(), /exiting: stdin closed by host/);
  });

  // The complement: the shutdown path must not be so eager that an idle server
  // quits while its host is alive and simply has nothing to say yet.
  it('keeps running while the host holds stdin open', async () => {
    const { proc, getStderr } = await spawnServer();

    const exit = await waitForExit(proc, 3000);
    const stderr = getStderr();
    proc.kill('SIGKILL');

    assert.strictEqual(
      exit,
      null,
      `server exited on its own while stdin was open (code=${exit?.code}, signal=${exit?.signal})\nstderr:\n${stderr}`
    );
  });
});
