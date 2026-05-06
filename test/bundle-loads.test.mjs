import { describe, it } from 'node:test';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = path.join(__dirname, '..', 'mcp', 'dist', 'index.js');

describe('bundle loads', () => {
  it('mcp/dist/index.js boots and responds to MCP initialize within 5s', async () => {
    await new Promise((resolve, reject) => {
      const proc = spawn('node', [BUNDLE_PATH], {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let stderr = '';
      let stdout = '';
      let resolved = false;

      proc.stdout.on('data', (d) => {
        stdout += d.toString();
        if (stdout.includes('"jsonrpc"') && stdout.includes('"id":1')) {
          resolved = true;
          proc.kill();
          resolve();
        }
      });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', reject);
      proc.on('exit', (code, signal) => {
        if (resolved) return;
        if (signal === 'SIGTERM' || signal === 'SIGKILL') return;
        reject(new Error(`bundle exited unexpectedly (code=${code}, signal=${signal})\nstderr:\n${stderr}\nstdout:\n${stdout}`));
      });

      // Send a minimal MCP initialize request.
      proc.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'bundle-test', version: '0' }
        }
      }) + '\n');

      setTimeout(() => {
        if (!resolved) {
          proc.kill();
          reject(new Error(`bundle did not respond to MCP initialize within 5s\nstderr:\n${stderr}\nstdout:\n${stdout}`));
        }
      }, 5000);
    });
  });
});
