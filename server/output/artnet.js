// Art-Net 4 ArtDmx packets, UDP port 6454.
//
// Layout: "Art-Net\0", OpCode 0x5000 (little-endian), ProtVer 14 (big-endian), Sequence,
// Physical, SubUni (low 8 bits of the 15-bit port address), Net (high 7 bits),
// Length (big-endian, even, 2..512), data.
//
// Art-Net numbers universes from 0, sACN from 1. This app numbers universes from 1 everywhere
// and converts here with `universeOffset` (default -1, so app universe 1 = Art-Net 0:0:0).

import dgram from 'node:dgram';

export const ARTNET_PORT = 6454;
export const ARTDMX_SIZE = 18 + 512;
const HEADER = Buffer.from('Art-Net\0', 'latin1');

export function writeArtDmx(buf, { sequence = 0, physical = 0, portAddress, data }) {
  HEADER.copy(buf, 0);
  buf.writeUInt16LE(0x5000, 8);
  buf.writeUInt16BE(14, 10);
  buf.writeUInt8(sequence & 0xff, 12);
  buf.writeUInt8(physical & 0xff, 13);
  buf.writeUInt8(portAddress & 0xff, 14);
  buf.writeUInt8((portAddress >> 8) & 0x7f, 15);
  buf.writeUInt16BE(512, 16);
  buf.fill(0, 18, ARTDMX_SIZE);
  if (data) buf.set(data.subarray(0, 512), 18);
  return buf;
}

export function parseArtDmx(buf) {
  if (buf.length < 18 || !buf.subarray(0, 8).equals(HEADER) || buf.readUInt16LE(8) !== 0x5000) return null;
  const length = buf.readUInt16BE(16);
  return {
    protocol: buf.readUInt16BE(10),
    sequence: buf.readUInt8(12),
    portAddress: buf.readUInt8(14) | (buf.readUInt8(15) << 8),
    data: buf.subarray(18, 18 + length),
  };
}

export class ArtNetOutput {
  /**
   * @param {object} cfg
   * @param {number[]} cfg.universes  app universes (1-based) to send
   * @param {string} cfg.host         node IP, or a broadcast address such as 2.255.255.255
   * @param {number} cfg.universeOffset added to the app universe to get the Art-Net port address
   * @param {string} cfg.interface    local IP to send from ('' = OS default)
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.type = 'artnet';
    this.sequence = 0;
    this.buffers = new Map();
    this.pending = new Set();
    this.stats = { packets: 0, errors: 0, skipped: 0, lastError: null };
    this.socket = null;
    this.ready = false;
  }

  open() {
    return new Promise((resolve) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.socket = socket;
      // See SacnOutput.open: a bind that fails never reaches the listening callback, so the
      // promise has to settle from the error path as well or configure() hangs for ever.
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve(this);
      };
      socket.on('error', (err) => {
        this.fail(err);
        done();
      });
      socket.bind({ port: 0, address: this.cfg.interface || undefined, exclusive: true }, () => {
        try {
          socket.setBroadcast(true);
          this.ready = true;
        } catch (err) {
          this.fail(err);
        }
        done();
      });
    });
  }

  fail(err) {
    this.stats.errors++;
    this.stats.lastError = err.message;
  }

  send(universes) {
    if (!this.ready) return;
    // One sequence number per frame (1..255; 0 would disable sequencing at the receiver).
    this.sequence = (this.sequence % 255) + 1;
    for (const u of this.cfg.universes) {
      if (this.pending.has(u)) {
        this.stats.skipped++;
        continue;
      }
      const portAddress = u + (this.cfg.universeOffset ?? -1);
      if (portAddress < 0 || portAddress > 0x7fff) continue;
      let buf = this.buffers.get(u);
      if (!buf) this.buffers.set(u, (buf = Buffer.alloc(ARTDMX_SIZE)));
      writeArtDmx(buf, { sequence: this.sequence, portAddress, data: universes.get(u) });
      this.pending.add(u);
      this.socket.send(buf, 0, ARTDMX_SIZE, this.cfg.port || ARTNET_PORT, this.cfg.host, (err) => {
        this.pending.delete(u);
        if (err) this.fail(err);
        else this.stats.packets++;
      });
    }
  }

  async close() {
    this.ready = false;
    await new Promise((r) => (this.socket ? this.socket.close(() => r()) : r()));
  }

  describe() {
    return `to ${this.cfg.host}`;
  }
}
