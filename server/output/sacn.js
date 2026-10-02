// sACN (ANSI E1.31-2018) data packets: one 638-byte UDP packet per universe per frame,
// multicast to 239.255.<hi>.<lo> or unicast to a node, port 5568.
//
// Layout (offsets in bytes):
//   0  root layer      preamble 0x0010, postamble 0, "ASC-E1.17", flags+length, vector 4, CID
//   38 framing layer   flags+length, vector 2, source name[64], priority, sync addr, sequence,
//                      options, universe
//   115 DMP layer      flags+length, vector 2, 0xa1, first addr 0, increment 1, count 513,
//                      start code 0, 512 slots

import dgram from 'node:dgram';

export const SACN_PORT = 5568;
export const SACN_PACKET_SIZE = 638;
const ACN_PACKET_ID = Buffer.from([0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0x00, 0x00, 0x00]);

export const OPTION_PREVIEW = 0x80;
export const OPTION_TERMINATED = 0x40;

export function multicastAddress(universe) {
  return `239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`;
}

/** 16-byte CID from a UUID string. */
export function cidFromUuid(uuid) {
  const hex = String(uuid).replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error('Invalid CID UUID');
  return Buffer.from(hex, 'hex');
}

/** UTF-8 source name, at most 63 bytes so the 64-byte field stays null-terminated. */
function encodeSourceName(name) {
  let s = String(name || 'DMX Show Controller');
  while (Buffer.byteLength(s, 'utf8') > 63) s = s.slice(0, -1);
  return Buffer.from(s, 'utf8');
}

export function writeSacnPacket(buf, { cid, sourceName, priority = 100, sequence = 0, universe, data, options = 0 }) {
  buf.fill(0, 0, SACN_PACKET_SIZE);
  // Root layer
  buf.writeUInt16BE(0x0010, 0);
  buf.writeUInt16BE(0x0000, 2);
  ACN_PACKET_ID.copy(buf, 4);
  buf.writeUInt16BE(0x7000 | (SACN_PACKET_SIZE - 16), 16);
  buf.writeUInt32BE(0x00000004, 18);
  cid.copy(buf, 22, 0, 16);
  // Framing layer
  buf.writeUInt16BE(0x7000 | (SACN_PACKET_SIZE - 38), 38);
  buf.writeUInt32BE(0x00000002, 40);
  (Buffer.isBuffer(sourceName) ? sourceName : encodeSourceName(sourceName)).copy(buf, 44, 0, 63);
  buf.writeUInt8(Math.max(0, Math.min(200, priority | 0)), 108);
  buf.writeUInt16BE(0, 109);
  buf.writeUInt8(sequence & 0xff, 111);
  buf.writeUInt8(options & 0xff, 112);
  buf.writeUInt16BE(universe & 0xffff, 113);
  // DMP layer
  buf.writeUInt16BE(0x7000 | (SACN_PACKET_SIZE - 115), 115);
  buf.writeUInt8(0x02, 117);
  buf.writeUInt8(0xa1, 118);
  buf.writeUInt16BE(0x0000, 119);
  buf.writeUInt16BE(0x0001, 121);
  buf.writeUInt16BE(513, 123);
  buf.writeUInt8(0x00, 125);
  if (data) buf.set(data.subarray(0, 512), 126);
  return buf;
}

/** Parse a data packet (used by tests and diagnostics). Returns null when it is not E1.31 data. */
export function parseSacnPacket(buf) {
  if (buf.length < 126 || !buf.subarray(4, 16).equals(ACN_PACKET_ID)) return null;
  if (buf.readUInt32BE(18) !== 4 || buf.readUInt32BE(40) !== 2 || buf.readUInt8(117) !== 2) return null;
  const count = buf.readUInt16BE(123);
  return {
    cid: buf.subarray(22, 38).toString('hex'),
    sourceName: buf.subarray(44, 108).toString('utf8').replace(/\0.*$/s, ''),
    priority: buf.readUInt8(108),
    sequence: buf.readUInt8(111),
    options: buf.readUInt8(112),
    universe: buf.readUInt16BE(113),
    startCode: buf.readUInt8(125),
    data: buf.subarray(126, 125 + count),
  };
}

export class SacnOutput {
  /**
   * @param {object} cfg
   * @param {Buffer} cfg.cid          16-byte component id, stable per installation
   * @param {number[]} cfg.universes  universes to send
   * @param {'multicast'|'unicast'} cfg.mode
   * @param {string} cfg.unicast      node IP for unicast mode
   * @param {string} cfg.interface    local IP of the NIC to send multicast from ('' = OS default)
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.type = 'sacn';
    this.sourceName = encodeSourceName(cfg.sourceName);
    this.sequences = new Map();
    this.buffers = new Map();
    this.pending = new Set();
    this.stats = { packets: 0, errors: 0, skipped: 0, lastError: null };
    this.socket = null;
    this.ready = false;
  }

  target(universe) {
    return this.cfg.mode === 'unicast' && this.cfg.unicast ? this.cfg.unicast : multicastAddress(universe);
  }

  open() {
    return new Promise((resolve) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.socket = socket;
      socket.on('error', (err) => this.fail(err));
      socket.bind({ port: 0, address: this.cfg.interface || undefined, exclusive: true }, () => {
        try {
          if (this.cfg.mode !== 'unicast') {
            socket.setMulticastTTL(Math.max(1, this.cfg.ttl || 1));
            socket.setMulticastLoopback(true);
            if (this.cfg.interface) socket.setMulticastInterface(this.cfg.interface);
          }
          this.ready = true;
        } catch (err) {
          this.fail(err);
        }
        resolve(this);
      });
    });
  }

  fail(err) {
    this.stats.errors++;
    this.stats.lastError = err.message;
  }

  send(universes, options = 0) {
    if (!this.ready) return;
    for (const u of this.cfg.universes) {
      // UDP sends are asynchronous; never rewrite a buffer the OS has not sent yet.
      if (this.pending.has(u)) {
        this.stats.skipped++;
        continue;
      }
      let buf = this.buffers.get(u);
      if (!buf) this.buffers.set(u, (buf = Buffer.alloc(SACN_PACKET_SIZE)));
      const seq = ((this.sequences.get(u) ?? -1) + 1) & 0xff;
      this.sequences.set(u, seq);
      writeSacnPacket(buf, {
        cid: this.cfg.cid,
        sourceName: this.sourceName,
        priority: this.cfg.priority ?? 100,
        sequence: seq,
        universe: u,
        data: universes.get(u),
        options,
      });
      this.pending.add(u);
      this.socket.send(buf, 0, SACN_PACKET_SIZE, this.cfg.port || SACN_PORT, this.target(u), (err) => {
        this.pending.delete(u);
        if (err) this.fail(err);
        else this.stats.packets++;
      });
    }
  }

  /** E1.31 6.2.6: send three Stream_Terminated packets so receivers release immediately. */
  async close() {
    if (this.ready) {
      this.ready = false;
      for (let i = 0; i < 3; i++) {
        for (const u of this.cfg.universes) {
          const seq = ((this.sequences.get(u) ?? -1) + 1) & 0xff;
          this.sequences.set(u, seq);
          const buf = writeSacnPacket(Buffer.alloc(SACN_PACKET_SIZE), {
            cid: this.cfg.cid,
            sourceName: this.sourceName,
            priority: this.cfg.priority ?? 100,
            sequence: seq,
            universe: u,
            data: null,
            options: OPTION_TERMINATED,
          });
          this.socket.send(buf, 0, SACN_PACKET_SIZE, this.cfg.port || SACN_PORT, this.target(u));
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    }
    this.ready = false;
    await new Promise((r) => (this.socket ? this.socket.close(() => r()) : r()));
  }

  describe() {
    return this.cfg.mode === 'unicast' && this.cfg.unicast
      ? `unicast to ${this.cfg.unicast}`
      : `multicast${this.cfg.interface ? ` via ${this.cfg.interface}` : ''}`;
  }
}
