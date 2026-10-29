const crypto = require('crypto');
const net = require('net');

/**
 * Minimal dependency-free WebSocket client used for CDP transport.
 *
 * We don't pull in `ws` or any other npm package: the MCP server is shipped
 * as a single bundled file and the browsing skill is a plain script, so a
 * zero-dependency Node-only implementation keeps both distribution paths
 * trivial. Only the slice of RFC 6455 we actually need is implemented:
 * client-side handshake, masked text frames out, unmasked text frames in
 * (with 7/16/64-bit length fields), and best-effort close.
 *
 * Event interface mirrors the `ws` package: `on('open'|'message'|'error'|
 * 'close', cb)`. `connect()` returns a Promise that resolves once the
 * upgrade completes.
 *
 * Handshake is performed on a bare `net.Socket` rather than via
 * `http.request` + the `'upgrade'` event: Chrome 153 (and other builds)
 * returns the `101 Switching Protocols` response in a way Node's HTTP
 * parser routes to the `'response'` event instead of `'upgrade'`, so the
 * `http.request`-based handshake never resolves and every CDP command
 * (navigate/eval/click/extract/screenshot) hangs for its full timeout.
 * Sending the upgrade request ourselves and reading the `101` status line
 * off the socket sidesteps Node's upgrade/response routing entirely.
 */
class WebSocketClient {
  constructor(url) {
    this.url = new URL(url);
    this.callbacks = {};
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.connected = false;
  }

  on(event, callback) {
    this.callbacks[event] = callback;
  }

  isConnected() {
    return this.connected && this.socket !== null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');

      const socket = net.createConnection({
        host: this.url.hostname,
        port: parseInt(this.url.port || '80', 10),
      });

      let handshakeBuf = Buffer.alloc(0);
      let handshakeDone = false;
      let failed = false;

      const fail = (err) => {
        if (failed || handshakeDone) return;
        failed = true;
        try { socket.destroy(); } catch {}
        if (this.callbacks.error) this.callbacks.error(err);
        reject(err);
      };

      socket.on('error', fail);

      socket.on('connect', () => {
        const path = this.url.pathname + this.url.search;
        const req =
          `GET ${path} HTTP/1.1\r\n` +
          `Host: ${this.url.hostname}:${this.url.port}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\n` +
          `Sec-WebSocket-Version: 13\r\n\r\n`;
        socket.write(req, 'utf8');
      });

      socket.on('data', (data) => {
        if (handshakeDone) return;
        handshakeBuf = Buffer.concat([handshakeBuf, data]);
        // Wait for the full HTTP response headers (terminated by \r\n\r\n).
        const headerEnd = handshakeBuf.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const headerStr = handshakeBuf.slice(0, headerEnd).toString('utf8');
        const statusLine = headerStr.split('\r\n')[0];
        if (!/^HTTP\/1\.[01] 101/.test(statusLine)) {
          fail(new Error(`WebSocket handshake failed: ${statusLine}`));
          return;
        }
        // Any bytes after the headers belong to the first WebSocket frame.
        const leftover = handshakeBuf.slice(headerEnd + 4);
        handshakeDone = true;
        this.socket = socket;
        this.connected = true;

        // Switch to the steady-state frame reader on the same socket.
        socket.removeAllListeners('data');
        socket.on('data', (d) => {
          this.buffer = Buffer.concat([this.buffer, d]);
          this.processFrames();
        });
        socket.on('error', (err) => {
          this.connected = false;
          if (this.callbacks.error) this.callbacks.error(err);
        });
        socket.on('close', () => {
          this.connected = false;
          if (this.callbacks.close) this.callbacks.close();
        });

        if (leftover.length > 0) {
          this.buffer = Buffer.concat([this.buffer, leftover]);
          this.processFrames();
        }
        if (this.callbacks.open) this.callbacks.open();
        resolve();
      });
    });
  }

  processFrames() {
    while (this.buffer.length >= 2) {
      const firstByte = this.buffer[0];
      const secondByte = this.buffer[1];

      const _fin = (firstByte & 0x80) !== 0;
      const opcode = firstByte & 0x0F;
      const _masked = (secondByte & 0x80) !== 0;
      let payloadLen = secondByte & 0x7F;

      let offset = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        payloadLen = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      if (this.buffer.length < offset + payloadLen) return;

      const payload = this.buffer.slice(offset, offset + payloadLen);
      this.buffer = this.buffer.slice(offset + payloadLen);

      if (opcode === 0x1 && this.callbacks.message) {
        this.callbacks.message(payload.toString('utf8'));
      }
    }
  }

  send(data) {
    if (!this.socket || !this.connected) {
      throw new Error('WebSocket not connected');
    }
    const payload = Buffer.from(data, 'utf8');
    const payloadLen = payload.length;

    let frame;
    let offset = 2;

    if (payloadLen < 126) {
      frame = Buffer.alloc(payloadLen + 6);
      frame[1] = payloadLen | 0x80;
    } else if (payloadLen < 65536) {
      frame = Buffer.alloc(payloadLen + 8);
      frame[1] = 126 | 0x80;
      frame.writeUInt16BE(payloadLen, 2);
      offset = 4;
    } else {
      frame = Buffer.alloc(payloadLen + 14);
      frame[1] = 127 | 0x80;
      frame.writeBigUInt64BE(BigInt(payloadLen), 2);
      offset = 10;
    }

    frame[0] = 0x81; // FIN + text frame

    const mask = Buffer.alloc(4);
    crypto.randomFillSync(mask);
    mask.copy(frame, offset);
    offset += 4;

    for (let i = 0; i < payloadLen; i++) {
      frame[offset + i] = payload[i] ^ mask[i % 4];
    }

    this.socket.write(frame);
  }

  close() {
    this.connected = false;
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
  }
}

module.exports = { WebSocketClient };
