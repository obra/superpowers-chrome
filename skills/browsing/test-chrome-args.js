#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const modulePath = path.join(__dirname, 'chrome-ws-lib.js');

function withEnv(env, fn) {
  const prev = {};
  for (const key of Object.keys(env)) {
    prev[key] = process.env[key];
    if (env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = env[key];
    }
  }
  delete require.cache[require.resolve(modulePath)];
  const mod = require(modulePath);
  try {
    fn(mod);
  } finally {
    delete require.cache[require.resolve(modulePath)];
    for (const key of Object.keys(env)) {
      if (prev[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev[key];
      }
    }
  }
}

const BASE_OPTS = {
  chosenPort: 9222,
  chromeUserDataDir: '/tmp/test-profile',
  chromeHeadless: false,
};

function run() {
  withEnv({ CHROME_EXTRA_ARGS: undefined }, ({ buildChromeArgs }) => {
    assert.strictEqual(typeof buildChromeArgs, 'function', 'buildChromeArgs must be exported');
    const args = buildChromeArgs(BASE_OPTS);
    assert.ok(args.includes('--remote-debugging-port=9222'), 'includes the port flag');
    assert.ok(args.includes('--user-data-dir=/tmp/test-profile'), 'includes the user-data-dir flag');
    assert.ok(args.includes('--no-sandbox'), 'includes an expected baseline flag');
    assert.ok(!args.includes('--headless=new'), 'no headless flag when chromeHeadless is false');
  });

  withEnv({ CHROME_EXTRA_ARGS: undefined }, ({ buildChromeArgs }) => {
    const args = buildChromeArgs({ ...BASE_OPTS, chromeHeadless: true });
    assert.ok(args.includes('--headless=new'), 'headless flag present when chromeHeadless is true');
  });

  withEnv({ CHROME_EXTRA_ARGS: '--use-gl=angle --use-angle=swiftshader-webgl --enable-unsafe-swiftshader' }, ({ buildChromeArgs }) => {
    const args = buildChromeArgs(BASE_OPTS);
    assert.ok(args.includes('--use-gl=angle'), 'extra arg --use-gl=angle appended');
    assert.ok(args.includes('--use-angle=swiftshader-webgl'), 'extra arg --use-angle=swiftshader-webgl appended');
    assert.ok(args.includes('--enable-unsafe-swiftshader'), 'extra arg --enable-unsafe-swiftshader appended');
  });

  withEnv({ CHROME_EXTRA_ARGS: '  --flag-a   --flag-b\t--flag-c\n' }, ({ buildChromeArgs }) => {
    const args = buildChromeArgs(BASE_OPTS);
    assert.ok(args.includes('--flag-a'), 'splits on multiple spaces');
    assert.ok(args.includes('--flag-b'), 'splits on tab');
    assert.ok(args.includes('--flag-c'), 'splits on newline');
    assert.ok(!args.includes(''), 'no empty tokens from whitespace runs');
  });

  withEnv({ CHROME_EXTRA_ARGS: '' }, ({ buildChromeArgs }) => {
    const baseline = buildChromeArgs.call(null, BASE_OPTS);
    // An empty env var should not add any tokens
    assert.strictEqual(baseline.filter(a => a === '').length, 0, 'empty env var does not add empty tokens');
  });

  console.log('All chrome args tests passed.');
}

run();
