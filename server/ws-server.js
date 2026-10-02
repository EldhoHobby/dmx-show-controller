// Minimal RFC 6455 WebSocket server on Node's http module (no dependencies).
// Supports text and binary messages, fragmentation, ping/pong and close; no extensions.

import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

export function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function reject(socket, code, extraHeaders = '') {
  const text = { 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 426: 'Upgrade Required' }[code] || 'Error';
  socket.end(`HTTP/1.1 ${code} ${text}\r\n${extraHeaders}Connection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * Handle WebSocket upgrades on `path`. `verifyOrigin(req)` guards against other websites
 * opening a socket to the local engine from the operator's browser.
 */
export function attachWebSocketServer(server, { path = '/ws', maxPayload = 64 * 1024 * 1024, verifyOrigin, onConnection }) {
  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return reject(socket, 400);
    }
    if (pathname !== path) return reject(socket, 404);
    if ((req.headers.upgrade || '').toLowerCase() !== 'websocket') return reject(socket, 400);
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key)) return reject(socket, 400);
    if (req.headers['sec-websocket-version'] !== '13') return reject(socket, 426, 'Sec-WebSocket-Version: 13\r\n');
    if (verifyOrigin && !verifyOrigin(req)) return reject(socket, 403);

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    const conn = new WsConnection(socket, maxPayload);
    onConnection(conn, req);
    if (head && head.length) conn.receive(head);
  });
}

export class WsConnection {
  constructor(socket, maxPayload) {
    this.socket = socket;
    this.maxPayload = maxPayload;
    this.chunks = [];
    this.buffered = 0;
    this.fragments = null;
    this.fragmentOpcode = 0;
    this.fragmentSize = 0;
    this.open = true;
    this.lastActivity = Date.now();
    this.onmessage = null;
    this.onclose = null;
    socket.on('data', (d) => this.receive(d));
    socket.on('close', () => this.closed());
    socket.on('error', () => this.closed());
  }

  get bufferedAmount() {
    return this.socket.writableLength;
  }

  receive(chunk) {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    while (this.open) {
      const frame = this.parseFrame();
      if (!frame) break;
      this.handleFrame(frame);
    }
  }

  /** Make sure the first queued chunk holds at least n bytes (n <= buffered). */
  head(n) {
    if (this.chunks[0].length >= n) return this.chunks[0];
    let total = 0;
    let k = 0;
    while (total < n) total += this.chunks[k++].length;
    const merged = Buffer.concat(this.chunks.slice(0, k));
    this.chunks.splice(0, k, merged);
    return merged;
  }

  take(n) {
    const first = this.head(n);
    let out;
    if (first.length === n) {
      out = first;
      this.chunks.shift();
    } else {
      out = first.subarray(0, n);
      this.chunks[0] = first.subarray(n);
    }
    this.buffered -= n;
    return out;
  }

  parseFrame() {
    if (this.buffered < 2) return null;
    const h = this.head(Math.min(this.buffered, 14));
    const b0 = h[0];
    const b1 = h[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;
    if (b0 & 0x70) return this.fail(1002);
    if (!masked) return this.fail(1002); // clients must mask
    if (len === 126) {
      if (h.length < 4) return null;
      len = h.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (h.length < 10) return null;
      if (h.readUInt32BE(2) !== 0) return this.fail(1009);
      len = h.readUInt32BE(6);
      offset = 10;
    }
    if (opcode >= 0x8 && (!fin || len > 125)) return this.fail(1002);
    if (len > this.maxPayload) return this.fail(1009);
    const total = offset + 4 + len;
    if (this.buffered < total) return null;
    const frame = Buffer.from(this.take(total)); // own copy: we unmask in place
    const mask = frame.subarray(offset, offset + 4);
    const payload = frame.subarray(offset + 4);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    return { fin, opcode, payload };
  }

  handleFrame({ fin, opcode, payload }) {
    this.lastActivity = Date.now();
    switch (opcode) {
      case OP.CLOSE:
        this.writeFrame(OP.CLOSE, payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0));
        this.socket.end();
        this.closed();
        return;
      case OP.PING:
        this.writeFrame(OP.PONG, payload);
        return;
      case OP.PONG:
        return;
      case OP.CONT:
        if (!this.fragments) return void this.fail(1002);
        this.fragments.push(payload);
        this.fragmentSize += payload.length;
        if (this.fragmentSize > this.maxPayload) return void this.fail(1009);
        if (fin) {
          const data = Buffer.concat(this.fragments);
          const op = this.fragmentOpcode;
          this.fragments = null;
          this.emit(op, data);
        }
        return;
      case OP.TEXT:
      case OP.BINARY:
        if (this.fragments) return void this.fail(1002);
        if (fin) this.emit(opcode, payload);
        else {
          this.fragments = [payload];
          this.fragmentOpcode = opcode;
          this.fragmentSize = payload.length;
        }
        return;
      default:
        this.fail(1002);
    }
  }

  emit(opcode, data) {
    if (!this.onmessage) return;
    if (opcode === OP.TEXT) this.onmessage(data.toString('utf8'), false);
    else this.onmessage(data, true);
  }

  writeFrame(opcode, payload) {
    if (this.socket.destroyed) return false;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
      header.writeUInt32BE(len >>> 0, 6);
    }
    header[0] = 0x80 | opcode;
    this.socket.write(Buffer.concat([header, payload]));
    return true;
  }

  /** Send a string as text or a Buffer/typed array as binary. */
  send(data) {
    if (!this.open) return false;
    if (typeof data === 'string') return this.writeFrame(OP.TEXT, Buffer.from(data, 'utf8'));
    return this.writeFrame(OP.BINARY, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  }

  ping() {
    if (this.open) this.writeFrame(OP.PING, Buffer.alloc(0));
  }

  close(code = 1000) {
    if (!this.open) return;
    const b = Buffer.alloc(2);
    b.writeUInt16BE(code, 0);
    this.writeFrame(OP.CLOSE, b);
    this.socket.end();
    this.closed();
  }

  fail(code) {
    this.close(code);
    return null;
  }

  closed() {
    if (!this.open) return;
    this.open = false;
    this.chunks = [];
    this.buffered = 0;
    if (this.onclose) this.onclose();
  }
}
