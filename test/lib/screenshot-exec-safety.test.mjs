import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { makePageSessionFake } from './_helpers.mjs';

const require = createRequire(import.meta.url);

// Regression tests for the screenshot-path command injection (CWE-78) fixed
// in 5a183e1 ("Pass screenshot downscale paths to image tools as arguments").
// Baseline v3.0.2 interpolated the caller-controlled screenshot path into a
// shell string — execSync(`sips ... "${filepath}" ...`) — so a `"` in the
// path broke out of the quoting and executed arbitrary commands. The fix
// passes the path as a single argv element to execFileSync (no shell).
// These tests pin the fixed behaviour at the child_process boundary, on both
// the macOS (sips) and Linux (ImageMagick) shapes:
//   1. no string-form exec is ever used;
//   2. the hostile path travels as ONE verbatim argv element;
//   3. no injected command executes (marker files never appear).
//
// Seam: require.cache injection of a recording child_process stub (precedent:
// chrome-process.test.mjs). screenshot.js destructures execFileSync at module
// load, so the stub must be installed before a fresh require of the module.
// The os module is stubbed the same way to exercise the Linux branch.

const SCREENSHOT_PATH = require.resolve('../../skills/browsing/lib/screenshot.js');
const FAKE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// Slash-free hostile basename: covers `"` (quote breakout), `;`, `$()` and
// backticks. A filename is a single path segment, so any `/` in the payload
// would just become a directory separator — real-world injection shapes use
// relative marker targets, which is why the tests chdir into the temp dir:
// if a shell ever executed the string, the markers would land there.
const HOSTILE_BASENAME =
  'evil";touch RCE_MARKER_SEMI;echo "$(touch RCE_MARKER_SUBSHELL)";`touch RCE_MARKER_BACKTICK`;"y.png';
const MARKERS = ['RCE_MARKER_SEMI', 'RCE_MARKER_SUBSHELL', 'RCE_MARKER_BACKTICK'];

function makeChildProcessStub(calls, { width = 4000, height = 3000 } = {}) {
  return {
    execFileSync(file, args, options) {
      calls.push({ fn: 'execFileSync', file, args, options });
      if (file === 'sips' && args.includes('-g')) {
        return `pixelWidth: ${width}\npixelHeight: ${height}\n`;
      }
      if (file === 'identify') {
        return `${width} ${height}\n`;
      }
      return '';
    },
    execSync(command, options) {
      calls.push({ fn: 'execSync', command, options });
      return '';
    },
  };
}

// Load a fresh copy of screenshot.js bound to stubbed child_process and os.
function loadWithStubs(platform, stubOptions) {
  const realOs = require('os'); // ensure the real builtin is cached so we can restore it
  const origCp = require.cache['child_process'];
  const origOs = require.cache['os'];
  const origScreenshot = require.cache[SCREENSHOT_PATH];

  const calls = [];
  require.cache['child_process'] = {
    id: 'child_process', filename: 'child_process', loaded: true,
    exports: makeChildProcessStub(calls, stubOptions),
  };
  require.cache['os'] = {
    id: 'os', filename: 'os', loaded: true,
    exports: { ...realOs, platform: () => platform },
  };
  delete require.cache[SCREENSHOT_PATH];
  const { attachScreenshot } = require(SCREENSHOT_PATH);

  let restored = false;
  function restore() {
    if (restored) return;
    restored = true;
    if (origCp) { require.cache['child_process'] = origCp; } else { delete require.cache['child_process']; }
    if (origOs) { require.cache['os'] = origOs; } else { delete require.cache['os']; }
    if (origScreenshot) { require.cache[SCREENSHOT_PATH] = origScreenshot; } else { delete require.cache[SCREENSHOT_PATH]; }
  }
  return { attachScreenshot, calls, restore };
}

function makeScreenshotDriver(attachScreenshot) {
  const ps = makePageSessionFake({
    'Page.captureScreenshot': () => ({ data: FAKE_PNG_BASE64 }),
    'Runtime.evaluate': () => ({ result: { value: { width: 1024, height: 768 } } }),
  });
  const { screenshot } = attachScreenshot({ getPageSession: async () => ps });
  return screenshot;
}

async function withTempCwd(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'screenshot-exec-safety-'));
  const origCwd = process.cwd();
  process.chdir(dir);
  try {
    await fn(dir);
  } finally {
    process.chdir(origCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function assertNoShellAndNoMarkers(calls, dir) {
  const shellCalls = calls.filter(c => c.fn === 'execSync');
  assert.deepEqual(shellCalls, [], 'no string-form exec (shell) may be used');
  for (const marker of MARKERS) {
    assert.equal(fs.existsSync(path.join(dir, marker)), false, `${marker} must never be created`);
  }
}

// The whole suite is POSIX-only: win32 has no downscale path at all, and
// the hostile filename is unrepresentable there (`"` is illegal in Windows
// filenames — writeFileSync fails with ENOENT before any image tool runs).
describe('screenshot exec safety (CWE-78 regression)', {
  skip: process.platform === 'win32' && 'no downscale path on win32; hostile filename is unrepresentable',
}, () => {
  it('macOS: hostile path reaches sips as one verbatim argv element, no shell', async () => {
    await withTempCwd(async (dir) => {
      const { attachScreenshot, calls, restore } = loadWithStubs('darwin');
      try {
        const hostile = path.join(dir, HOSTILE_BASENAME);
        const screenshot = makeScreenshotDriver(attachScreenshot);
        const returned = await screenshot(0, hostile);

        assert.equal(returned, hostile);
        assert.ok(fs.existsSync(hostile), 'PNG written under the literal hostile name');

        // Probe (every screenshot) + downscale (stubbed 4000x3000 > 1800 cap).
        assert.equal(calls.length, 2);
        assert.equal(calls[0].fn, 'execFileSync');
        assert.equal(calls[0].file, 'sips');
        assert.deepEqual(calls[0].args, ['-g', 'pixelWidth', '-g', 'pixelHeight', hostile]);
        assert.equal(calls[1].fn, 'execFileSync');
        assert.equal(calls[1].file, 'sips');
        assert.deepEqual(calls[1].args, ['-Z', '1800', hostile]);

        assertNoShellAndNoMarkers(calls, dir);
      } finally {
        restore();
      }
    });
  });

  it('Linux: hostile path reaches identify/convert as verbatim argv elements, no shell', async () => {
    await withTempCwd(async (dir) => {
      const { attachScreenshot, calls, restore } = loadWithStubs('linux');
      try {
        const hostile = path.join(dir, HOSTILE_BASENAME);
        const screenshot = makeScreenshotDriver(attachScreenshot);
        await screenshot(0, hostile);

        assert.equal(calls.length, 2);
        assert.equal(calls[0].fn, 'execFileSync');
        assert.equal(calls[0].file, 'identify');
        assert.deepEqual(calls[0].args, ['-format', '%w %h', hostile]);
        assert.equal(calls[1].fn, 'execFileSync');
        assert.equal(calls[1].file, 'convert');
        // Input and output operands: the path appears twice, each time as its
        // own whole argv element.
        assert.deepEqual(calls[1].args, [hostile, '-resize', '1800x1800>', hostile]);

        assertNoShellAndNoMarkers(calls, dir);
      } finally {
        restore();
      }
    });
  });

  it('small images: probe runs on every screenshot, downscale is skipped', async () => {
    await withTempCwd(async (dir) => {
      const { attachScreenshot, calls, restore } = loadWithStubs('darwin', { width: 800, height: 600 });
      try {
        const hostile = path.join(dir, HOSTILE_BASENAME);
        const screenshot = makeScreenshotDriver(attachScreenshot);
        await screenshot(0, hostile);

        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].args, ['-g', 'pixelWidth', '-g', 'pixelHeight', hostile]);

        assertNoShellAndNoMarkers(calls, dir);
      } finally {
        restore();
      }
    });
  });
});
