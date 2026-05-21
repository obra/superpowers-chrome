import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WebSocketClient } = require('../../skills/browsing/lib/websocket-client.js');

// Why this test exists: the downstream Gauntlet fork hit a nasty
// failure mode when it replaced this hand-rolled WebSocket client
// with Bun's built-in. Bun's client negotiates `permessage-deflate`
// by default and intermittently fails to decompress frames Chrome's
// CDP sends, closing the connection with code=1002 "Invalid
// compressed data" mid-run. Gauntlet PRI-1690 traced this back to
// the lost property: upstream's hand-rolled upgrade request never
// advertised any extensions, so compression never got negotiated.
// This test pins that property — any future refactor that switches
// to a library which advertises permessage-deflate should fail here.
function startCaptureServer() {
  return new Promise((resolve) => {
    let resolveHeaders;
    const headersPromise = new Promise((r) => { resolveHeaders = r; });

    const server = createServer();
    const openSockets = new Set();
    server.on('upgrade', (req, socket) => {
      openSockets.add(socket);
      socket.on('close', () => openSockets.delete(socket));
      resolveHeaders({ ...req.headers });
      // Drop the connection — we only care about the headers the
      // client sent. Closing immediately keeps the test from holding
      // a socket open while server.close() waits.
      socket.destroy();
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        awaitHeaders: () => headersPromise,
        shutdown: () =>
          new Promise((r) => {
            for (const s of openSockets) s.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

describe('websocket-client compression negotiation', () => {
  it('does not advertise permessage-deflate in the upgrade handshake', async () => {
    const srv = await startCaptureServer();
    try {
      const ws = new WebSocketClient(`ws://127.0.0.1:${srv.port}/test`);
      // Don't await the connect — we only care about what the client
      // sent in the upgrade. Suppress any rejection so it doesn't
      // surface as unhandled.
      ws.connect().catch(() => {});

      const headers = await srv.awaitHeaders();
      const ext = headers['sec-websocket-extensions'] ?? '';
      assert.doesNotMatch(
        ext,
        /permessage-deflate/i,
        `upgrade requested permessage-deflate (got header ${JSON.stringify(ext)}); see Gauntlet PRI-1690 for why this is load-bearing`,
      );

      try { ws.close(); } catch { /* best-effort */ }
    } finally {
      await srv.shutdown();
    }
  });
});
