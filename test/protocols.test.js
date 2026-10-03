import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { randomUUID } from 'node:crypto';
import {
  SACN_PACKET_SIZE,
  SacnOutput,
  cidFromUuid,
  multicastAddress,
  parseSacnPacket,
  writeSacnPacket,
  OPTION_TERMINATED,
  DISCOVERY_UNIVERSE,
  discoveryPackets,
} from '../server/output/sacn.js';
import {
  ARTDMX_SIZE,
  ArtNetOutput,
  isArtPoll,
  parseArtDmx,
  parseArtPollReply,
  writeArtDmx,
  writeArtPollReply,
} from '../server/output/artnet.js';

const cid = cidFromUuid('6ba7b810-9dad-11d1-80b4-00c04fd430c8');

test('sACN universe discovery matches the E1.31 section 6.4 layout', () => {
  const [p] = discoveryPackets({ cid, sourceName: 'Test', universes: [2, 1, 5] });
  assert.equal(p.length, 126, '120 header bytes plus two per universe');
  assert.equal(p.readUInt16BE(0), 0x0010, 'preamble size');
  assert.equal(p.subarray(4, 16).toString('latin1'), 'ASC-E1.17\0\0\0', 'ACN packet identifier');
  assert.equal(p.readUInt16BE(16), 0x7000 | (p.length - 16), 'root flags and length');
  assert.equal(p.readUInt32BE(18), 0x00000008, 'VECTOR_ROOT_E131_EXTENDED');
  assert.deepEqual(p.subarray(22, 38), cid, 'CID');
  assert.equal(p.readUInt16BE(38), 0x7000 | (p.length - 38), 'framing flags and length');
  assert.equal(p.readUInt32BE(40), 0x00000002, 'VECTOR_E131_EXTENDED_DISCOVERY');
  assert.equal(p.subarray(44, 108).toString('utf8').replace(/\0+$/, ''), 'Test', 'source name');
  assert.equal(p.readUInt32BE(108), 0, 'reserved');
  assert.equal(p.readUInt16BE(112), 0x7000 | (p.length - 112), 'discovery flags and length');
  assert.equal(p.readUInt32BE(114), 0x00000001, 'VECTOR_UNIVERSE_DISCOVERY_UNIVERSE_LIST');
  assert.equal(p[118], 0, 'page');
  assert.equal(p[119], 0, 'last page');
  assert.deepEqual([p.readUInt16BE(120), p.readUInt16BE(122), p.readUInt16BE(124)], [1, 2, 5], 'universes, ascending');
  assert.equal(multicastAddress(DISCOVERY_UNIVERSE), '239.255.250.214', 'discovery goes to universe 64214');

  // Over 512 universes pages, and every page says which of them it is.
  const pages = discoveryPackets({ cid, sourceName: 'Test', universes: Array.from({ length: 600 }, (_, i) => i + 1) });
  assert.equal(pages.length, 2);
  assert.deepEqual(pages.map((b) => [b[118], b[119]]), [[0, 1], [1, 1]]);
  assert.deepEqual(pages.map((b) => b.length), [120 + 512 * 2, 120 + 88 * 2]);
});

test('sACN packet matches the E1.31 layout byte for byte', () => {
  const data = new Uint8Array(512).map((_, i) => i & 0xff);
  const buf = writeSacnPacket(Buffer.alloc(SACN_PACKET_SIZE), { cid, sourceName: 'Test', priority: 100, sequence: 7, universe: 2, data });
  assert.equal(buf.length, 638);
  assert.equal(buf.readUInt16BE(0), 0x0010, 'preamble size');
  assert.equal(buf.readUInt16BE(2), 0x0000, 'postamble size');
  assert.equal(buf.subarray(4, 16).toString('latin1'), 'ASC-E1.17\0\0\0', 'ACN packet identifier');
  assert.equal(buf.readUInt16BE(16), 0x7000 | 622, 'root flags+length');
  assert.equal(buf.readUInt32BE(18), 0x00000004, 'VECTOR_ROOT_E131_DATA');
  assert.deepEqual(buf.subarray(22, 38), cid, 'CID');
  assert.equal(buf.readUInt16BE(38), 0x7000 | 600, 'framing flags+length');
  assert.equal(buf.readUInt32BE(40), 0x00000002, 'VECTOR_E131_DATA_PACKET');
  assert.equal(buf.subarray(44, 48).toString(), 'Test');
  assert.equal(buf[48], 0, 'source name null-terminated');
  assert.equal(buf[108], 100, 'priority');
  assert.equal(buf.readUInt16BE(109), 0, 'sync address');
  assert.equal(buf[111], 7, 'sequence');
  assert.equal(buf[112], 0, 'options');
  assert.equal(buf.readUInt16BE(113), 2, 'universe');
  assert.equal(buf.readUInt16BE(115), 0x7000 | 523, 'DMP flags+length');
  assert.equal(buf[117], 0x02, 'VECTOR_DMP_SET_PROPERTY');
  assert.equal(buf[118], 0xa1, 'address and data type');
  assert.equal(buf.readUInt16BE(119), 0, 'first property address');
  assert.equal(buf.readUInt16BE(121), 1, 'address increment');
  assert.equal(buf.readUInt16BE(123), 513, 'property value count');
  assert.equal(buf[125], 0, 'DMX start code');
  assert.equal(buf[126], 0);
  assert.equal(buf[126 + 300], 300 & 0xff);
  assert.equal(buf[637], 511 & 0xff);
});

test('sACN source names are truncated to fit the 64-byte field', () => {
  const buf = writeSacnPacket(Buffer.alloc(SACN_PACKET_SIZE), { cid, sourceName: 'x'.repeat(100), universe: 1 });
  assert.equal(buf.subarray(44, 107).toString(), 'x'.repeat(63));
  assert.equal(buf[107], 0);
});

test('sACN multicast addresses follow 239.255.<hi>.<lo>', () => {
  assert.equal(multicastAddress(1), '239.255.0.1');
  assert.equal(multicastAddress(2), '239.255.0.2');
  assert.equal(multicastAddress(257), '239.255.1.1');
  assert.equal(multicastAddress(63999), '239.255.249.255');
});

test('Art-Net ArtDmx layout and universe numbering', () => {
  const data = new Uint8Array(512).fill(9);
  const buf = writeArtDmx(Buffer.alloc(ARTDMX_SIZE), { sequence: 3, portAddress: 0x0123, data });
  assert.equal(buf.subarray(0, 8).toString('latin1'), 'Art-Net\0');
  assert.equal(buf[8], 0x00, 'OpDmx low byte');
  assert.equal(buf[9], 0x50, 'OpDmx high byte');
  assert.equal(buf.readUInt16BE(10), 14, 'protocol version');
  assert.equal(buf[12], 3, 'sequence');
  assert.equal(buf[14], 0x23, 'SubUni');
  assert.equal(buf[15], 0x01, 'Net');
  assert.equal(buf.readUInt16BE(16), 512, 'length');
  const parsed = parseArtDmx(buf);
  assert.equal(parsed.portAddress, 0x0123);
  assert.equal(parsed.data[100], 9);
});

function receiver(port) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const packets = [];
    sock.on('message', (msg) => packets.push(Buffer.from(msg)));
    sock.bind(port, '127.0.0.1', () => resolve({ sock, packets, port: sock.address().port }));
  });
}

test('SacnOutput sends real UDP packets with incrementing sequence, then terminates the stream', async () => {
  const rx = await receiver(0);
  const out = new SacnOutput({ cid, sourceName: 'Unit', universes: [1, 2], mode: 'unicast', unicast: '127.0.0.1', port: rx.port, priority: 100 });
  await out.open();
  const u1 = new Uint8Array(512);
  u1[0] = 255;
  u1[511] = 42;
  for (let i = 0; i < 3; i++) {
    out.send(new Map([[1, u1]]));
    await new Promise((r) => setTimeout(r, 20));
  }
  await out.close();
  await new Promise((r) => setTimeout(r, 50));
  rx.sock.close();
  const parsed = rx.packets.map(parseSacnPacket).filter(Boolean);
  const uni1 = parsed.filter((p) => p.universe === 1);
  const uni2 = parsed.filter((p) => p.universe === 2);
  assert.ok(uni1.length >= 6, `expected data + terminate packets, got ${uni1.length}`);
  assert.equal(uni1[0].data[0], 255);
  assert.equal(uni1[0].data[511], 42);
  assert.equal(uni2[0].data[0], 0, 'a routed universe with no data is sent as zeros');
  assert.deepEqual(uni1.slice(0, 3).map((p) => p.sequence), [0, 1, 2]);
  assert.equal(uni1.filter((p) => p.options & OPTION_TERMINATED).length, 3, 'three Stream_Terminated packets');
  assert.equal(uni1[0].sourceName, 'Unit');
});

test('ArtNetOutput maps app universe 1 to Art-Net port address 0', async () => {
  const rx = await receiver(0);
  // discovery off: this test owns rx.port, and test files run in parallel, so nothing here
  // should be competing for a listening socket.
  const out = new ArtNetOutput({ universes: [1, 3], host: '127.0.0.1', port: rx.port, universeOffset: -1, discovery: false });
  await out.open();
  out.send(new Map([[1, new Uint8Array(512).fill(1)]]));
  await new Promise((r) => setTimeout(r, 50));
  await out.close();
  rx.sock.close();
  const ports = rx.packets.map(parseArtDmx).map((p) => p.portAddress).sort();
  assert.deepEqual(ports, [0, 2]);
});

test('ArtPollReply matches the Art-Net 4 layout and answers a real poll', async () => {
  const p = parseArtPollReply(
    writeArtPollReply({
      ip: [10, 0, 0, 7],
      mac: [1, 2, 3, 4, 5, 6],
      longName: 'Test desk',
      net: 1,
      subNet: 2,
      portAddresses: [0x120, 0x121],
      bindIndex: 3,
    }),
  );
  assert.ok(p, 'reply parses');
  assert.deepEqual(p.ip, [10, 0, 0, 7]);
  assert.equal(p.port, 6454, 'the reply advertises the Art-Net port, little-endian');
  assert.equal(p.net, 1);
  assert.equal(p.subNet, 2);
  assert.equal(p.ports, 2);
  assert.deepEqual(p.portTypes.slice(0, 2), [0x80, 0x80], 'output, DMX512');
  assert.deepEqual(p.goodOutput.slice(0, 2), [0x80, 0x80], 'data is being transmitted');
  assert.deepEqual(p.swOut.slice(0, 2), [0, 1], 'low nibble of each port address');
  assert.equal(p.style, 1, 'StController');
  assert.deepEqual(p.mac, [1, 2, 3, 4, 5, 6]);
  assert.equal(p.bindIndex, 3);
  assert.equal(p.status2 & 0x08, 0x08, 'speaks Art-Net 3/4');
  assert.equal(p.longName, 'Test desk');

  // ArtDmx must not be mistaken for a poll.
  assert.equal(isArtPoll(writeArtDmx(Buffer.alloc(ARTDMX_SIZE), { portAddress: 0, data: null })), false);

  // End to end over UDP: poll in, replies out, four ports to a packet.
  const port = 36454; // not 6454, so the test never competes with real Art-Net software
  const out = new ArtNetOutput({
    universes: [1, 2, 3, 4, 5, 6],
    host: '127.0.0.1',
    universeOffset: -1,
    discoveryPort: port,
    sourceName: 'Unit desk',
  });
  await out.open();
  const poll = Buffer.alloc(14);
  Buffer.from('Art-Net\0', 'latin1').copy(poll, 0);
  poll.writeUInt16LE(0x2000, 8);
  poll.writeUInt16BE(14, 10);
  assert.equal(isArtPoll(poll), true);

  const replies = [];
  const asker = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  asker.on('message', (m) => replies.push(Buffer.from(m)));
  await new Promise((r) => asker.bind(0, '127.0.0.1', r));
  asker.send(poll, 0, poll.length, port, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 300));
  asker.close();
  await out.close();

  const parsed = replies.map(parseArtPollReply).filter(Boolean);
  assert.equal(parsed.length, 2, `six universes need two replies, got ${parsed.length}`);
  assert.deepEqual(parsed.map((r) => r.ports), [4, 2]);
  assert.deepEqual(parsed.map((r) => r.bindIndex), [1, 2], 'each reply says which of the set it is');
  assert.deepEqual(parsed[0].swOut, [0, 1, 2, 3]);
  assert.deepEqual(parsed[1].swOut.slice(0, 2), [4, 5]);
  assert.equal(parsed[0].longName, 'Unit desk');
});

test('CID parsing rejects malformed UUIDs', () => {
  assert.equal(cidFromUuid(randomUUID()).length, 16);
  assert.throws(() => cidFromUuid('not-a-uuid'));
});
