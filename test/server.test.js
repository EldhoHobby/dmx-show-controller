// End-to-end: boot the real engine, drive it like two browser windows would, and check the
// sACN packets it actually puts on the network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { parseSacnPacket } from '../server/output/sacn.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function bootEngine() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmx-test-'));
  const rx = dgram.createSocket('udp4');
  const packets = [];
  rx.on('message', (m) => {
    const p = parseSacnPacket(Buffer.from(m));
    if (p) p.at = performance.now();
    packets.push(p);
  });
  await new Promise((r) => rx.bind(0, '127.0.0.1', r));
  fs.mkdirSync(path.join(dataDir, 'config'));
  fs.writeFileSync(
    path.join(dataDir, 'config', 'outputs.json'),
    JSON.stringify({ frameRate: 40, outputs: [{ type: 'sacn', enabled: true, universes: [1], mode: 'unicast', unicast: '127.0.0.1', port: rx.address().port }] }),
  );
  const port = await freePort();
  const child = spawn(process.execPath, ['server/index.js', '--port', String(port), '--data', dataDir], { cwd: root });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`engine did not start:\n${output}`)), 10000);
    const onData = (d) => {
      output += d;
      if (output.includes('DMX engine running')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`engine exited (${code}):\n${output}`)));
  });
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    packets,
    async stop() {
      child.kill('SIGINT');
      await new Promise((r) => child.once('exit', r));
      rx.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

class Client {
  constructor(url) {
    this.messages = [];
    this.waiters = [];
    this.ws = new WebSocket(url);
    this.ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      const msg = JSON.parse(e.data);
      this.messages.push(msg);
      this.waiters = this.waiters.filter((w) => !(w.pred(msg) && (w.resolve(msg), true)));
    };
    this.opened = new Promise((r) => (this.ws.onopen = r));
  }
  next(pred, ms = 3000) {
    const found = this.messages.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for message')), ms);
      this.waiters.push({ pred, resolve: (m) => (clearTimeout(timer), resolve(m)) });
    });
  }
  /** The next matching message that arrives after this call (older ones are ignored). */
  fresh(pred, ms = 3000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for message')), ms);
      this.waiters.push({ pred, resolve: (m) => (clearTimeout(timer), resolve(m)) });
    });
  }
  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }
}

const latestFrame = async (packets, after) => {
  await sleep(120);
  const fresh = packets.filter((p) => p && p.universe === 1).slice(after);
  return fresh.at(-1).data;
};

function rawUpgrade(port, origin) {
  return new Promise((resolve) => {
    const req = http.request({
      port,
      host: '127.0.0.1',
      path: '/ws',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        Origin: origin,
      },
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve('error'));
    req.end();
  });
}

test('engine end to end: sync between windows, DMX on the wire, security guards', { timeout: 60000 }, async () => {
  const engine = await bootEngine();
  try {
    // Static app and path traversal guard.
    const page = await fetch(`${engine.base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/i);
    assert.equal((await fetch(`${engine.base}/shared/show.js`)).status, 200);
    assert.notEqual((await fetch(`${engine.base}/..%2fserver%2findex.js`)).status, 200);
    assert.notEqual((await fetch(`${engine.base}/shared/..%2f..%2fpackage.json`)).status, 200);

    // Another website must not be able to open a control socket from the operator's browser.
    assert.equal(await rawUpgrade(engine.port, 'http://evil.example'), 403);
    assert.equal(await rawUpgrade(engine.port, `http://127.0.0.1:${engine.port}`), 101);

    const a = new Client(`ws://127.0.0.1:${engine.port}/ws`);
    const b = new Client(`ws://127.0.0.1:${engine.port}/ws`);
    await Promise.all([a.opened, b.opened]);
    const welcome = await a.next((m) => m.t === 'welcome');
    assert.equal(welcome.show.format, 'dmx-show');

    // An edit from window A reaches window B.
    a.send({ t: 'op', opId: 1, op: { type: 'fixture.add', fixture: { id: 'par', name: 'Par', profileId: 'generic.rgbw-7ch', universe: 1, address: 1 } } });
    const seen = await b.next((m) => m.t === 'op' && m.op.type === 'fixture.add');
    assert.equal(seen.op.fixture.id, 'par');
    a.send({ t: 'op', opId: 2, op: { type: 'clip.add', clip: { id: 'red', type: 'static', track: 'trk_base', start: 0, end: 600000, fixtures: ['par'], params: { dimmer: 1, color: [1, 0, 0] } } } });
    await b.next((m) => m.t === 'op' && m.op.type === 'clip.add');

    // ...and the engine is now sending it as DMX.
    let frame = await latestFrame(engine.packets, engine.packets.length);
    assert.deepEqual(Array.from(frame.slice(0, 7)), [255, 255, 0, 0, 0, 0, 0]);

    // Rejected edits are reported to the sender only.
    a.send({ t: 'op', opId: 3, op: { type: 'clip.remove', id: 'nope' } });
    const nack = await a.next((m) => m.t === 'nack' && m.opId === 3);
    assert.match(nack.error, /not found/);

    // Grand master and blackout act on the output immediately.
    a.send({ t: 'live', changes: { master: 0.5 } });
    await b.next((m) => m.t === 'live' && m.live.master === 0.5);
    frame = await latestFrame(engine.packets, engine.packets.length);
    assert.equal(frame[0], 128);
    a.send({ t: 'live', changes: { blackout: true } });
    await b.next((m) => m.t === 'live' && m.live.blackout === true);
    frame = await latestFrame(engine.packets, engine.packets.length);
    assert.equal(frame[0], 0);

    // A held flash button is released if its window disconnects.
    b.send({ t: 'live', changes: { blackout: false, flash: 'blinder' } });
    await a.next((m) => m.t === 'live' && m.live.flash === 'blinder');
    b.ws.close();
    await a.next((m) => m.t === 'live' && m.live.flash === null && !m.live.blackout);

    // Transport: play moves the clock, and every window is told.
    a.send({ t: 'transport', action: 'play' });
    const playing = await a.next((m) => m.t === 'transport' && m.transport.playing);
    assert.equal(playing.transport.playing, true);
    a.send({ t: 'transport', action: 'seek', position: 30000 });
    const seeked = await a.next((m) => m.t === 'transport' && m.transport.position >= 30000);
    assert.ok(seeked.transport.position >= 30000);

    // Audio cache: the hash is checked on upload.
    const audio = crypto.randomBytes(5000);
    const hash = crypto.createHash('sha256').update(audio).digest('hex');
    const wrong = await fetch(`${engine.base}/api/media/${'0'.repeat(64)}`, { method: 'PUT', body: audio, headers: { 'Content-Type': 'audio/wav' } });
    assert.equal(wrong.status, 400);
    const put = await fetch(`${engine.base}/api/media/${hash}`, { method: 'PUT', body: audio, headers: { 'Content-Type': 'audio/wav', 'X-File-Name': 'song.wav' } });
    assert.equal(put.status, 201);
    const got = Buffer.from(await (await fetch(`${engine.base}/api/media/${hash}`)).arrayBuffer());
    assert.ok(got.equals(audio));

    // Frame rate sanity: ~40 packets per second for one universe.
    const before = engine.packets.length;
    await sleep(1000);
    const perSecond = engine.packets.length - before;
    assert.ok(perSecond >= 30 && perSecond <= 50, `${perSecond} packets/s`);
    a.ws.close();
  } finally {
    await engine.stop();
  }
});

test('engine end to end: manual faders, scenes, calibration and live-audio hits on the wire', { timeout: 60000 }, async (t) => {
  const engine = await bootEngine();
  try {
    const a = new Client(`ws://127.0.0.1:${engine.port}/ws`);
    await a.opened;
    const welcome = await a.next((m) => m.t === 'welcome');
    assert.deepEqual(welcome.programmer, { attrs: {}, raw: {} });
    assert.equal(welcome.reactive.bpm, 0);
    let opId = 0;
    const op = async (o) => {
      const id = ++opId;
      a.send({ t: 'op', opId: id, op: o });
      const reply = await a.next((m) => (m.t === 'op' || m.t === 'nack') && m.opId === id);
      assert.equal(reply.t, 'op', reply.error);
    };
    const out = () => latestFrame(engine.packets, engine.packets.length);
    await op({ type: 'fixture.add', fixture: { id: 'par', name: 'Par', profileId: 'generic.rgbw-7ch', universe: 1, address: 1, position: { x: 0, y: 3, z: 0 } } });
    await op({ type: 'fixture.add', fixture: { id: 'mh', name: 'Mover', profileId: 'generic.wash-mover-14ch', universe: 1, address: 30, position: { x: 0, y: 4, z: 0 }, rotation: { x: 180, y: 0, z: 0 } } });
    await op({ type: 'clip.add', clip: { id: 'base', type: 'static', track: 'trk_base', start: 0, end: 600000, fixtures: ['par'], params: { dimmer: 0.3, color: [1, 0, 0] } } });
    assert.equal((await out())[0], 77);

    // Manual faders and raw channels win over the show until they are released.
    a.send({ t: 'programmer', set: { attrs: { par: { dimmer: 1 } }, raw: { par: { 5: 77 } } } });
    const prog = await a.fresh((m) => m.t === 'programmer');
    assert.deepEqual(prog.programmer, { attrs: { par: { dimmer: 1 } }, raw: { par: { 5: 77 } } });
    let frame = await out();
    assert.deepEqual([frame[0], frame[5]], [255, 77]);
    a.send({ t: 'programmer', set: { raw: { par: { 5: null } } } });
    assert.deepEqual((await a.fresh((m) => m.t === 'programmer')).programmer.raw, {});
    a.send({ t: 'programmer', clear: 'all' });
    await a.fresh((m) => m.t === 'programmer');
    frame = await out();
    assert.deepEqual([frame[0], frame[5]], [77, 0]);

    // A recorded scene: go, then toggle off (no fade); every window hears about it.
    await op({ type: 'scene.add', scene: { id: 'sc', name: 'Blue', fadeMs: 0, attrs: { par: { dimmer: 1, color: [0, 0, 1] } } } });
    a.send({ t: 'scene', action: 'go', id: 'sc' });
    await a.fresh((m) => m.t === 'live' && m.live.scenes.some((e) => e.id === 'sc'));
    assert.deepEqual(Array.from((await out()).slice(0, 4)), [255, 0, 0, 255]);
    a.send({ t: 'scene', action: 'toggle', id: 'sc' });
    await a.fresh((m) => m.t === 'live' && m.live.scenes.length === 0);
    assert.equal((await out())[0], 77);

    // Prime: the mover opens at its centre point, the rest goes dark; a saved offset moves it.
    a.send({ t: 'live', changes: { calibrate: { fixtureId: 'mh', othersOff: true } } });
    await a.fresh((m) => m.t === 'live' && m.live.calibrate?.fixtureId === 'mh');
    frame = await out();
    assert.equal(frame[0], 0, 'par dark while priming');
    assert.equal(frame[34], 255, 'mover open');
    const panBefore = frame[29] * 256 + frame[30];
    await op({ type: 'fixture.update', id: 'mh', changes: { calibration: { pan: 10, tilt: 0 } } });
    frame = await out();
    const moved = Math.abs(frame[29] * 256 + frame[30] - panBefore);
    assert.ok(Math.abs(moved - (10 / 540) * 65535) < 3, `pan moved ${moved} DMX steps`);
    a.send({ t: 'live', changes: { calibrate: null } });
    await a.fresh((m) => m.t === 'live' && m.live.calibrate === null);
    assert.equal((await out())[0], 77);

    // Live audio: a separate socket (the browser's audio worker) reports hits. Each hit goes
    // out as its own DMX frame at once; a full-strength pulse can only come from a frame
    // computed at the moment of the hit, so this measures the real hit-to-network delay.
    a.send({ t: 'live', changes: { audioReactive: true } });
    await a.fresh((m) => m.t === 'live' && m.live.audioReactive);
    const mic = new Client(`ws://127.0.0.1:${engine.port}/ws?view=audio`);
    await mic.opened;
    const micWelcome = await mic.next((m) => m.t === 'welcome');
    assert.equal(micWelcome.show, undefined, 'the audio socket gets no copy of the show');
    await a.next((m) => m.t === 'clients' && m.clients.some((c) => c.view === 'audio'));
    const latencies = [];
    for (let i = 0; i < 6; i++) {
      const from = engine.packets.length;
      const sentAt = performance.now();
      mic.send({ t: 'au', on: [[0, 1]], lv: [0.8, 0.1, 0.1, 0.5], bpm: 128 });
      await sleep(400);
      const hit = engine.packets.slice(from).find((p) => p && p.universe === 1 && p.data[0] >= 250);
      if (hit) latencies.push(hit.at - sentAt);
    }
    assert.ok(latencies.length >= 5, `a full-strength frame for ${latencies.length} of 6 hits`);
    const median = latencies.sort((x, y) => x - y)[latencies.length >> 1];
    t.diagnostic(`live-audio hit to sACN packet: median ${median.toFixed(2)} ms, worst ${latencies.at(-1).toFixed(2)} ms`);
    assert.ok(median < 15, `median hit-to-DMX ${median.toFixed(1)} ms`);
    const reactive = a.messages.findLast((m) => m.t === 'reactive').reactive;
    assert.equal(reactive.count.low, 6);
    assert.equal(reactive.bpm, 128);
    assert.ok(a.messages.some((m) => m.t === 'status' && m.status.engine.hitFps > 0), 'status reports hit frames');
    assert.ok(!mic.messages.some((m) => m.t === 'reactive'), 'the audio socket is kept free of show traffic');

    // A second window starting live audio while the first is listening is refused (it would
    // double every hit) and told why.
    const mic2 = new Client(`ws://127.0.0.1:${engine.port}/ws?view=audio`);
    await mic2.opened;
    mic.send({ t: 'au', lv: [0.1, 0, 0, 0.1] });
    mic2.send({ t: 'au', on: [[0, 1]], lv: [1, 1, 1, 1] });
    const refused = await mic2.next((m) => m.t === 'error');
    assert.match(refused.message, /already the live audio input/);
    await sleep(100);
    assert.equal(a.messages.findLast((m) => m.t === 'reactive').reactive.count.low, 6, 'its hit was not counted');
    mic2.ws.close();

    // With audio-reactive off, hits are still metered but do not touch the lights.
    a.send({ t: 'live', changes: { audioReactive: false } });
    await a.fresh((m) => m.t === 'live' && !m.live.audioReactive);
    const from = engine.packets.length;
    mic.send({ t: 'au', on: [[0, 1]], lv: [0.8, 0, 0, 0.5] });
    await sleep(200);
    assert.ok(!engine.packets.slice(from).some((p) => p && p.universe === 1 && p.data[0] > 77));
    // Closing the audio window zeroes the meters for everyone.
    mic.ws.close();
    const quiet = await a.fresh((m) => m.t === 'reactive' && m.reactive.source === null);
    assert.equal(quiet.reactive.env.low, 0);
    a.ws.close();
  } finally {
    await engine.stop();
  }
});
