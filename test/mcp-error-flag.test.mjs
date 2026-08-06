/**
 * Tests for issue #44: MCP tool errors must set isError: true on the
 * CallToolResult so clients (loop breakers, failure telemetry) see failures.
 *
 * Covers:
 *  - Catch-all error handler flags thrown errors with isError: true
 *  - Successful tool results are not flagged
 *  - No in-band `return `Error:...`` strings bypass the error flag
 *  - DialogRefusal synthetic response stays non-error (deliberate guidance)
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = path.join(__dirname, '..', 'mcp', 'dist', 'index.js');
const srcContent = fs.readFileSync(
  path.join(__dirname, '..', 'mcp', 'src', 'index.ts'),
  'utf8'
);

/**
 * Boots the bundled MCP server, runs the MCP handshake, issues one
 * use_browser tools/call, and returns the parsed CallToolResult.
 */
function callUseBrowser(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [BUNDLE_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.kill();
      fn(value);
    };

    const timer = setTimeout(() => {
      finish(reject, new Error(`no tools/call response within 10s\nstderr:\n${stderr}\nstdout:\n${stdout}`));
    }, 10000);

    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => finish(reject, err));
    proc.on('exit', (code, signal) => {
      if (!settled) {
        finish(reject, new Error(`server exited before responding (code=${code}, signal=${signal})\nstderr:\n${stderr}`));
      }
    });

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 2) {
          if (msg.error) {
            finish(reject, new Error(`protocol-level error: ${JSON.stringify(msg.error)}`));
          } else {
            finish(resolve, msg.result);
          }
          return;
        }
      }
    });

    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'error-flag-test', version: '0' }
      }
    }) + '\n');
    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized'
    }) + '\n');
    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'use_browser', arguments: args }
    }) + '\n');
  });
}

describe('issue #44: tool errors carry isError: true', () => {
  it('a handler validation error returns isError: true', async () => {
    // set_profile with no payload throws without needing Chrome.
    const result = await callUseBrowser({ action: 'set_profile' });
    assert.ok(result.content?.[0]?.text?.startsWith('Error:'),
      `expected error text, got: ${JSON.stringify(result.content)}`);
    assert.equal(result.isError, true,
      `error result must set isError: true, got: ${JSON.stringify(result)}`);
  });

  it('a successful action does not set isError', async () => {
    const result = await callUseBrowser({ action: 'help' });
    assert.ok(result.content?.[0]?.text?.length > 0, 'help should return text');
    assert.ok(!result.isError,
      `success result must not set isError, got: ${JSON.stringify(result.isError)}`);
  });

  it('no in-band `return `Error:...`` strings bypass the error flag', () => {
    // Errors must throw (routing through the flagged catch-all), not return
    // success-shaped strings that merely start with "Error:".
    const inBand = srcContent.match(/return\s+[`"']Error:/g) || [];
    assert.deepEqual(inBand, [],
      `found in-band error-string returns that bypass isError: ${JSON.stringify(inBand)}`);
  });

  it('DialogRefusal synthetic response stays non-error', () => {
    // The dialog refusal is deliberate guidance, not a failure; its return
    // block must not set isError.
    const refusalBlock = srcContent.match(
      /formatDialogRefusal\(error as any\)[\s\S]{0,120}?\};/
    );
    assert.ok(refusalBlock, 'dialog refusal return block should exist');
    assert.ok(!refusalBlock[0].includes('isError'),
      'dialog refusal must remain a non-error result');
  });
});
