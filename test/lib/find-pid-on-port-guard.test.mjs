import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Regression tests for the port handling in findPidOnPort:
//  - d205cbd ("Normalize port to a number in findPidOnPort") added the
//    Number() + integer/range guard so hostile strings are rejected before
//    any external command runs;
//  - the follow-up execFileSync conversion removed the shell entirely:
//    lsof/netstat are invoked argv-form, so even a bypassed guard could not
//    smuggle metacharacters into a shell. The win32 `netstat | findstr`
//    pipeline became netstat + a JS filter matching the local-address column
//    on an exact `:PORT` suffix.
// These tests pin:
//   1. injection-shaped and malformed inputs are rejected (null) before ANY
//      process is spawned — the exec stub must never be called;
//   2. accepted inputs reach lsof only as canonical-integer argv elements;
//   3. win32 filters netstat output in JS with exact port matching.
//
// Seam: require.cache injection of a recording child_process stub (precedent:
// chrome-process.test.mjs). findPidOnPort requires child_process lazily inside
// the function body, so the stub is picked up at call time. No real lsof or
// netstat ever runs in these tests.

const { findPidOnPort } = require('../../skills/browsing/lib/chrome-launcher-helpers.js');

const NETSTAT_LISTENING_9222 =
  '  TCP    127.0.0.1:9222      0.0.0.0:0      LISTENING      4321\r\n';

function withStubbedExec({ platform, netstatOutput = NETSTAT_LISTENING_9222, run }) {
  const origCp = require.cache['child_process'];
  const calls = [];
  require.cache['child_process'] = {
    id: 'child_process', filename: 'child_process', loaded: true,
    exports: {
      execFileSync(file, args, options) {
        calls.push({ fn: 'execFileSync', file, args, options });
        if (file === 'lsof') return '4321\n';
        if (file === 'netstat') return netstatOutput;
        return '';
      },
      execSync(command, options) {
        calls.push({ fn: 'execSync', command, options });
        return '';
      },
    },
  };
  const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform');
  if (platform) {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }
  try {
    run(calls);
  } finally {
    if (origCp) { require.cache['child_process'] = origCp; } else { delete require.cache['child_process']; }
    if (platform) {
      Object.defineProperty(process, 'platform', platformDesc);
    }
  }
}

const REJECTED_INPUTS = [
  '9222; touch pwn',
  '$(touch pwn)',
  '`touch pwn`',
  '9222 && id',
  '9222 | id',
  '9222\ntouch pwn',
  '123abc',
  '',
  'NaN',
  'Infinity',
  '-1',
  '0',
  '65536',
  '9222.5',
  null,
  undefined,
];

describe('findPidOnPort port guard (command-injection regression)', () => {
  it('rejects injection-shaped and malformed inputs before any process runs', () => {
    withStubbedExec({
      platform: 'darwin',
      run(calls) {
        for (const input of REJECTED_INPUTS) {
          calls.length = 0;
          assert.equal(findPidOnPort(input), null, `expected null for ${JSON.stringify(input)}`);
          assert.equal(calls.length, 0, `no process may be spawned for ${JSON.stringify(input)}`);
        }
      },
    });
  });

  it('win32: rejects injection-shaped inputs before any process runs', () => {
    withStubbedExec({
      platform: 'win32',
      run(calls) {
        for (const input of ['9222 & whoami', '9222; touch pwn', '65536', '123abc']) {
          calls.length = 0;
          assert.equal(findPidOnPort(input), null, `expected null for ${JSON.stringify(input)}`);
          assert.equal(calls.length, 0, `no process may be spawned for ${JSON.stringify(input)}`);
        }
      },
    });
  });

  it('passes accepted inputs to lsof as canonical-integer argv, never a shell', () => {
    const ACCEPTED = [
      ['9222', '-ti:9222'],
      [9222, '-ti:9222'],
      [' 9222 ', '-ti:9222'],
      ['9222\n', '-ti:9222'],
      ['9.222e3', '-ti:9222'],
      ['0x23fa', '-ti:9210'],
      ['1', '-ti:1'],
      ['65535', '-ti:65535'],
    ];
    withStubbedExec({
      platform: 'darwin',
      run(calls) {
        for (const [input, expectedFlag] of ACCEPTED) {
          calls.length = 0;
          assert.equal(findPidOnPort(input), 4321, `expected parsed pid for ${JSON.stringify(input)}`);
          assert.equal(calls.length, 1, `exactly one probe for ${JSON.stringify(input)}`);
          assert.equal(calls[0].fn, 'execFileSync', 'must not use a shell');
          assert.equal(calls[0].file, 'lsof');
          assert.deepEqual(calls[0].args, [expectedFlag, '-sTCP:LISTEN']);
          assert.match(expectedFlag, /^-ti:\d+$/);
        }
      },
    });
  });

  it('win32: runs netstat argv-form and parses the exact LISTENING line', () => {
    withStubbedExec({
      platform: 'win32',
      run(calls) {
        assert.equal(findPidOnPort('9222'), 4321);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].fn, 'execFileSync', 'must not use a shell');
        assert.equal(calls[0].file, 'netstat');
        assert.deepEqual(calls[0].args, ['-ano']);
      },
    });
  });

  it('win32: returns null when only a different port is listening', () => {
    // The JS filter must match the requested port exactly on the
    // local-address column, not just any LISTENING line.
    withStubbedExec({
      platform: 'win32',
      netstatOutput: '  TCP    127.0.0.1:19222     0.0.0.0:0      LISTENING      4321\r\n',
      run() {
        assert.equal(findPidOnPort('9222'), null);
        assert.equal(findPidOnPort('19222'), 4321);
      },
    });
  });
});
