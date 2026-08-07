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

    // Tear down gracefully so exit handlers run and no session dir is orphaned.
    proc.stdin.end();
    await waitForExit(proc, 5000) || proc.kill('SIGKILL');

    assert.strictEqual(
      exit,
      null,
      `server exited on its own while stdin was open (code=${exit?.code}, signal=${exit?.signal})\nstderr:\n${stderr}`
    );
  });

  // The ppid watchdog is the backstop for stdin staying open on someone else's
  // behalf. CHROME_WS_PPID_WATCHDOG_MS makes the interval configurable — the
  // escape hatch for exotic wrappers, and what makes this branch testable at
  // all (the default is 30s).
  it('exits via the ppid watchdog when the parent dies but stdin stays open', async () => {
    // An intermediary parent spawns the server with inherited stdio and exits
    // 2s later, reparenting the server. The server's stdin write end is held
    // by the pipeline's `sleep` — NOT by the intermediary or this process —
    // so stdin stays open past the reparent. (A plain `... &` would redirect
    // the background job's stdin to /dev/null; a direct child would have its
    // pipes closed by Node the moment the intermediary exits.)
    const intermediary =
      'const{spawn}=require("child_process");' +
      'const c=spawn(process.execPath,[process.argv[1]],{stdio:"inherit"});' +
      'c.unref();setTimeout(()=>process.exit(0),2000);';
    const proc = spawn(
      'sh',
      ['-c', `sleep 15 | node -e '${intermediary}' "${BUNDLE_PATH}"`],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CHROME_WS_PPID_WATCHDOG_MS: '150' },
      }
    );

    // Detect the exit by its stderr attribution (the pipe's `sleep` holds the
    // write end for 15s, so waiting for stream close would prove nothing).
    let stderr = '';
    const sawReparent = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 8000);
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
        if (/exiting: reparented/.test(stderr)) {
          clearTimeout(timer);
          resolve(true);
        }
      });
    });

    proc.kill('SIGKILL');
    proc.stdout.destroy();
    proc.stderr.destroy();
    assert.ok(sawReparent,
      `server did not exit via the ppid watchdog after losing its parent\nstderr:\n${stderr}`);
  });

  // An error-driven transport close (oversized frame blowing the 10MB
  // ReadBuffer) is a failure with a live host and must not report success.
  it('exits nonzero when the transport closes due to an error', async () => {
    const { proc, getStderr } = await spawnServer();

    // A single frame over the SDK's 10MB ReadBuffer limit, no newline. The
    // server exits mid-write, so swallow the resulting EPIPE on our side.
    proc.stdin.on('error', () => {});
    proc.stdin.write(Buffer.alloc(11 * 1024 * 1024, 'x'));

    const exit = await waitForExit(proc, 5000);
    if (!exit) {
      proc.kill('SIGKILL');
      assert.fail(`server still running 5s after oversized frame\nstderr:\n${getStderr()}`);
    }
    assert.strictEqual(exit.signal, null, `expected a clean exit, got signal ${exit.signal}`);
    assert.strictEqual(exit.code, 1,
      `error-driven close must exit nonzero, got ${exit.code}\nstderr:\n${getStderr()}`);
  });
});
