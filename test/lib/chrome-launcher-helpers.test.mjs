import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const {
  PORT_RANGE_START,
  PORT_RANGE_END,
  buildChromeArgs,
  getXdgCacheHome,
  getChromeProfileDir,
  findPidOnPort,
} = require('../../skills/browsing/lib/chrome-launcher-helpers.js');

describe('chrome-launcher-helpers', () => {
  it('PORT_RANGE_START is 9222 (backward compat)', () => {
    assert.equal(PORT_RANGE_START, 9222);
    assert.ok(PORT_RANGE_END > PORT_RANGE_START);
  });

  it('buildChromeArgs includes the chosen port', () => {
    const args = buildChromeArgs({
      chosenPort: 9333,
      chromeUserDataDir: '/tmp/profile',
      chromeHeadless: false
    });
    assert.ok(args.includes('--remote-debugging-port=9333'));
    assert.ok(args.includes('--user-data-dir=/tmp/profile'));
    assert.ok(!args.includes('--headless=new'));
  });

  it('buildChromeArgs adds --headless=new when chromeHeadless is true', () => {
    const args = buildChromeArgs({
      chosenPort: 9333,
      chromeUserDataDir: '/tmp/profile',
      chromeHeadless: true
    });
    assert.ok(args.includes('--headless=new'));
  });

  it('buildChromeArgs appends CHROME_EXTRA_ARGS tokens', () => {
    process.env.CHROME_EXTRA_ARGS = '--use-gl=angle --enable-foo';
    try {
      const args = buildChromeArgs({
        chosenPort: 9333,
        chromeUserDataDir: '/tmp/profile',
        chromeHeadless: false
      });
      assert.ok(args.includes('--use-gl=angle'));
      assert.ok(args.includes('--enable-foo'));
    } finally {
      delete process.env.CHROME_EXTRA_ARGS;
    }
  });

  it('getXdgCacheHome returns a non-empty path', () => {
    const path = getXdgCacheHome();
    assert.equal(typeof path, 'string');
    assert.ok(path.length > 0);
  });

  it('getChromeProfileDir composes profile name into XDG path', () => {
    const dir = getChromeProfileDir('myprofile');
    assert.match(dir, /superpowers\/browser-profiles\/myprofile$/);
  });

  it('findPidOnPort returns null for an unbound port', async () => {
    const pid = await findPidOnPort(64999);
    assert.equal(pid, null);
  });

  it('findPidOnPort returns the current process PID for a port we bound', async () => {
    const net = await import('node:net');
    const server = net.default.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      const pid = await findPidOnPort(port);
      assert.equal(typeof pid, 'number');
      assert.equal(pid, process.pid);
    } finally {
      server.close();
    }
  });
});
