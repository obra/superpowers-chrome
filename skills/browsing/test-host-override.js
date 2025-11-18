#!/usr/bin/env node

const assert = require('assert');
const path = require('path');

const modulePath = path.join(__dirname, 'host-override.js');

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

function run() {
withEnv({ CHROME_WS_HOST: undefined, CHROME_WS_PORT: undefined }, ({ CHROME_DEBUG_HOST, CHROME_DEBUG_PORT, rewriteWsUrl }) => {
  assert.strictEqual(CHROME_DEBUG_HOST, '127.0.0.1', 'Default host should be 127.0.0.1');
  assert.strictEqual(CHROME_DEBUG_PORT, 9222, 'Default port should be 9222');
  const original = 'ws://localhost:9999/devtools/page/abc';
  const rewritten = rewriteWsUrl(original);
  assert.strictEqual(rewritten, original, 'rewrite should be a no-op without overrides');
  const passthrough = rewriteWsUrl(null);
  assert.strictEqual(passthrough, null, 'rewrite should pass through falsy inputs');
});

  withEnv({ CHROME_WS_HOST: '10.1.2.3', CHROME_WS_PORT: '9333' }, ({ CHROME_DEBUG_HOST, CHROME_DEBUG_PORT, rewriteWsUrl }) => {
    assert.strictEqual(CHROME_DEBUG_HOST, '10.1.2.3', 'Custom host should be respected');
    assert.strictEqual(CHROME_DEBUG_PORT, 9333, 'Custom port should be numeric');
    const rewritten = rewriteWsUrl('ws://127.0.0.1:9222/devtools/page/xyz');
    assert.strictEqual(
      rewritten,
      'ws://10.1.2.3:9333/devtools/page/xyz',
      'rewrite should swap host/port to custom values'
    );
  });

  console.log('host-override smoke test passed');
}

run();
