import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const require = createRequire(import.meta.url);
const { WebSocketClient } = require('../../skills/browsing/lib/websocket-client.js');

// Why this test exists: Chrome 153 returns the `101 Switching Protocols`
// response in a way Node's HTTP parser routes to the `'response'` event
// instead of the `'upgrade'` event. The original handshake used
// `http.request` + `req.on('upgrade')`, which never fired in that case, so
// `connect()` never resolved and every CDP command (navigate/eval/click/
// extract/screenshot) hung for its full timeout. This test reproduces that
// exact failure mode with a bare TCP server that speaks the 101 response
// directly (never going through Node's http 'upgrade' machinery at all),
// and pins that the raw-socket handshake completes regardless of how the
// server emits its 101.
function startRawHandshakeServer() {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      socket.once('data', () => {
        // Reply with a 101 Switching Protocols directly on the socket.
        // This is the wire-level response Chrome 153 sends; using a bare
        // net server means Node's http 'upgrade' event is never involved
        // on the server side either, mirroring the client-side regression.
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: WebSocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${randomBytes(16).toString('base64')}\r\n` +
          '\r\n',
        );
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        shutdown: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe('websocket-client raw-socket handshake (Chrome 153 regression)', () => {
  it('resolves connect() when the server replies 101 directly on the socket', async () => {
    const srv = await startRawHandshakeServer();
    try {
      const ws = new WebSocketClient(`ws://127.0.0.1:${srv.port}/devtools/page/abc`);
      // The old http.request + 'upgrade' implementation would hang here
      // until its 30s timeout because the 101 never fires Node's 'upgrade'
      // event when the server emits it the way Chrome 153 does. Race against
      // a deadline so a regression fails fast instead of hanging the suite.
      const result = await Promise.race([
        ws.connect().then(() => 'connected'),
        new Promise((r) => setTimeout(() => 'timeout', 3000)),
      ]);
      assert.equal(result, 'connected', 'connect() did not resolve — raw-socket handshake regressed');
      try { ws.close(); } catch { /* best-effort */ }
    } finally {
      await srv.shutdown();
    }
  });
});
