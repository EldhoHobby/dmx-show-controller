// Art-Net 4 on UDP port 6454: ArtDmx out, and ArtPoll in / ArtPollReply out, so Art-Net
// management software can discover this controller.
//
// ArtDmx layout: "Art-Net\0", OpCode 0x5000 (little-endian), ProtVer 14 (big-endian),
// Sequence, Physical, SubUni (low 8 bits of the 15-bit port address), Net (high 7 bits),
// Length (big-endian, even, 2..512 — always a full 512 here), data.
//
// Art-Net numbers universes from 0, sACN from 1. This app numbers universes from 1 everywhere
// and converts here with `universeOffset` (default -1, so app universe 1 = Art-Net 0:0:0).

import dgram from 'node:dgram';
import os from 'node:os';

export const ARTNET_PORT = 6454;
export const ARTDMX_SIZE = 18 + 512;
export const ARTPOLL_REPLY_SIZE = 239;
const HEADER = Buffer.from('Art-Net\0', 'latin1');
const OP_POLL = 0x2000;
const OP_POLL_REPLY = 0x2100;
const PORTS_PER_REPLY = 4; // the packet has room for exactly four

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

/** True if this is an ArtPoll, the discovery request every Art-Net controller broadcasts. */
export function isArtPoll(buf) {
  return buf.length >= 14 && buf.subarray(0, 8).equals(HEADER) && buf.readUInt16LE(8) === OP_POLL;
}

/**
 * ArtPollReply (Art-Net 4): how a source says what it is and which universes it drives.
 * Without it, Art-Net management software cannot see this controller at all.
 *
 * One packet describes at most four ports, and they share a Net and Sub-Net, so a source
 * driving more than four universes — or universes spanning Net/Sub-Net — sends several,
 * each with its own bindIndex.
 */
export function writeArtPollReply({
  ip = [0, 0, 0, 0],
  mac = [0, 0, 0, 0, 0, 0],
  shortName = 'DMX Show',
  longName = 'DMX Show Controller',
  nodeReport = '',
  net = 0,
  subNet = 0,
  portAddresses = [],
  bindIndex = 1,
  sending = true,
}) {
  const buf = Buffer.alloc(ARTPOLL_REPLY_SIZE);
  HEADER.copy(buf, 0);
  buf.writeUInt16LE(OP_POLL_REPLY, 8);
  Buffer.from(ip).copy(buf, 10, 0, 4);
  buf.writeUInt16LE(ARTNET_PORT, 14);
  buf.writeUInt8(0, 16); // VersInfoH
  buf.writeUInt8(3, 17); // VersInfoL
  buf.writeUInt8(net & 0x7f, 18);
  buf.writeUInt8(subNet & 0x0f, 19);
  buf.writeUInt16BE(0x00ff, 20); // Oem: unregistered
  buf.writeUInt8(0, 22); // no UBEA
  // Indicators normal, port addresses set from this machine's configuration.
  buf.writeUInt8(0xe0, 23);
  buf.writeUInt16LE(0, 24); // EstaMan: unregistered
  buf.write(shortName.slice(0, 17), 26, 17, 'latin1');
  buf.write(longName.slice(0, 63), 44, 63, 'latin1');
  buf.write(nodeReport.slice(0, 63), 108, 63, 'latin1');
  const n = Math.min(portAddresses.length, PORTS_PER_REPLY);
  buf.writeUInt16BE(n, 172);
  for (let i = 0; i < n; i++) {
    buf.writeUInt8(0x80, 174 + i); // port type: output, DMX512
    buf.writeUInt8(sending ? 0x80 : 0x00, 182 + i); // GoodOutput: data is being transmitted
    buf.writeUInt8(portAddresses[i] & 0x0f, 190 + i); // SwOut: the port address's low nibble
  }
  buf.writeUInt8(1, 200); // Style: StController — this generates Art-Net rather than outputting DMX
  Buffer.from(mac).copy(buf, 201, 0, 6);
  Buffer.from(ip).copy(buf, 207, 0, 4); // BindIp
  buf.writeUInt8(bindIndex, 211);
  buf.writeUInt8(0x08, 212); // Status2: speaks Art-Net 3/4, so 15-bit port addresses are understood
  return buf;
}

/** Parse an ArtPollReply, for tests and for anything that wants to read one back. */
export function parseArtPollReply(buf) {
  if (buf.length < ARTPOLL_REPLY_SIZE || !buf.subarray(0, 8).equals(HEADER)) return null;
  if (buf.readUInt16LE(8) !== OP_POLL_REPLY) return null;
  const ports = buf.readUInt16BE(172);
  const str = (at, len) => buf.subarray(at, at + len).toString('latin1').replace(/\0.*$/, '');
  return {
    ip: [...buf.subarray(10, 14)],
    port: buf.readUInt16LE(14),
    net: buf.readUInt8(18),
    subNet: buf.readUInt8(19),
    shortName: str(26, 18),
    longName: str(44, 64),
    nodeReport: str(108, 64),
    ports,
    portTypes: [...buf.subarray(174, 178)],
    goodOutput: [...buf.subarray(182, 186)],
    swOut: [...buf.subarray(190, 194)],
    style: buf.readUInt8(200),
    mac: [...buf.subarray(201, 207)],
    bindIndex: buf.readUInt8(211),
    status2: buf.readUInt8(212),
  };
}

/** The local IPv4 address and MAC to advertise: the configured interface, else the first real one. */
export function localInterface(preferred = '') {
  const nics = Object.values(os.networkInterfaces()).flat().filter(Boolean);
  const v4 = nics.filter((n) => n.family === 'IPv4' || n.family === 4);
  const pick = (preferred && v4.find((n) => n.address === preferred)) || v4.find((n) => !n.internal) || v4[0];
  if (!pick) return { ip: [0, 0, 0, 0], mac: [0, 0, 0, 0, 0, 0] };
  return {
    ip: pick.address.split('.').map(Number),
    mac: (pick.mac || '').split(':').map((h) => parseInt(h, 16) || 0).slice(0, 6).concat([0, 0, 0, 0, 0, 0]).slice(0, 6),
  };
}

export class ArtNetOutput {
  /**
   * @param {object} cfg
   * @param {number[]} cfg.universes  app universes (1-based) to send
   * @param {string} cfg.host         node IP, or a broadcast address such as 2.255.255.255
   * @param {number} cfg.universeOffset added to the app universe to get the Art-Net port address
   * @param {string} cfg.interface    local IP to send from ('' = OS default)
   * @param {string} cfg.sourceName   long name this controller reports in ArtPollReply
   * @param {number} [cfg.port]       non-standard ArtDmx destination port (default 6454)
   * @param {boolean} [cfg.discovery] false to not answer ArtPoll at all
   * @param {number} [cfg.discoveryPort] port to listen for ArtPoll on (default 6454; the
   *                                  tests use another so they need not take the real one)
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
          this.listenForPolls();
        } catch (err) {
          this.fail(err);
        }
        done();
      });
    });
  }

  /**
   * Answer ArtPoll, so Art-Net management software can discover this controller.
   *
   * Deliberately a second socket. Port 6454 is shared ground — another Art-Net tool on the
   * same machine may already hold it — and discovery is a convenience, while sending DMX is
   * not. So a bind failure here is kept on this.pollError and otherwise ignored: nothing
   * logs it or reports it in status today, and output is unaffected either way.
   */
  listenForPolls() {
    if (this.pollSocket || this.cfg.discovery === false) return;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.pollSocket = sock;
    sock.on('error', (err) => {
      this.pollError = err.message;
      this.pollSocket = null;
      try {
        sock.close();
      } catch {}
    });
    sock.on('message', (msg, rinfo) => {
      if (!isArtPoll(msg)) return;
      // Replies go straight back to whoever asked, which reaches it whatever subnet the
      // configured broadcast address covers.
      for (const reply of this.pollReplies()) {
        sock.send(reply, 0, reply.length, rinfo.port || ARTNET_PORT, rinfo.address, (err) => {
          if (err) this.pollError = err.message;
        });
      }
    });
    // Always the standard port — discovery only works if we listen where pollers ask.
    // cfg.port redirects where *data* goes; discoveryPort exists so tests need not take 6454.
    sock.bind({ port: this.cfg.discoveryPort ?? ARTNET_PORT, exclusive: false }, () => {
      try {
        sock.setBroadcast(true);
      } catch {}
    });
  }

  /** One reply per group of up to four ports that share a Net and Sub-Net. */
  pollReplies() {
    const { ip, mac } = localInterface(this.cfg.interface);
    const addresses = this.cfg.universes
      .map((u) => u + (this.cfg.universeOffset ?? -1))
      .filter((a) => a >= 0 && a <= 0x7fff);
    const groups = new Map();
    for (const a of addresses) {
      const key = `${(a >> 8) & 0x7f}:${(a >> 4) & 0x0f}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    const out = [];
    let bindIndex = 1;
    for (const [key, list] of groups) {
      const [net, subNet] = key.split(':').map(Number);
      for (let i = 0; i < list.length; i += PORTS_PER_REPLY) {
        out.push(
          writeArtPollReply({
            ip,
            mac,
            longName: this.cfg.sourceName || 'DMX Show Controller',
            nodeReport: `#0001 [0000] ${this.stats.packets} ArtDmx packets sent`,
            net,
            subNet,
            portAddresses: list.slice(i, i + PORTS_PER_REPLY),
            bindIndex: bindIndex++,
            sending: this.ready,
          }),
        );
      }
    }
    // A source with no universes still answers, so it shows up as present but idle.
    if (!out.length) {
      out.push(writeArtPollReply({ ip, mac, longName: this.cfg.sourceName || 'DMX Show Controller', sending: false }));
    }
    return out;
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
    const sock = this.pollSocket;
    this.pollSocket = null;
    if (sock) {
      await new Promise((r) => {
        try {
          sock.close(() => r());
        } catch {
          r();
        }
      });
    }
    await new Promise((r) => (this.socket ? this.socket.close(() => r()) : r()));
  }

  describe() {
    return `to ${this.cfg.host}`;
  }
}
