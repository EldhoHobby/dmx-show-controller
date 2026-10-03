// Regressions for inputs that are not merely invalid but actively hostile: a show file, an
// edit operation or a live-audio stream crafted to stop the engine putting DMX on the wire.
// Each test here failed before the guard it covers.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createShow, normalizeClip, normalizeShow } from '../shared/show.js';
import { applyOp, OpError } from '../shared/ops.js';
import { createEvaluator } from '../shared/evaluate.js';
import { renderUniverses } from '../shared/dmx-render.js';
import { defaultParams } from '../shared/clip-types.js';
import { validateShow } from '../shared/validate.js';
import { createLiveTracker } from '../shared/analysis/live-tracker.js';
import { createRequestHandler } from '../server/http.js';

// Keys every object literal answers to. A plain `TABLE[name]` lookup reads these back as
// truthy — Object.prototype itself, a constructor, a method — so a name check written that
// way lets them through.
const PROTOTYPE_KEYS = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf'];

test('a clip type borrowed from Object.prototype is refused, not dispatched as a handler', () => {
  for (const type of PROTOTYPE_KEYS) {
    assert.equal(normalizeClip({ id: 'c', type, start: 0, end: 1000 }, new Set(['t'])), null, `clip type "${type}" must be refused`);
    assert.deepEqual(defaultParams(type), {}, `defaultParams("${type}") must not read Object.prototype`);
  }

  // The whole path a show file takes: normalize, build the evaluator, render a frame. Before
  // the guard, "__proto__" reached HANDLERS[c.type] and threw on every frame for ever — the
  // frame loop catches that, so the process stayed up with the lights frozen, and the show
  // was autosaved so a restart did not help either.
  const show = normalizeShow({
    format: 'dmx-show',
    version: 1,
    fixtures: [{ id: 'f1', profileId: 'generic.rgbw-7ch', universe: 1, address: 1 }],
    timeline: {
      durationMs: 60000,
      tracks: [{ id: 't' }],
      clips: [
        { id: 'bad', type: '__proto__', track: 't', start: 0, end: 60000, fixtures: ['f1'] },
        { id: 'ok', type: 'static', track: 't', start: 0, end: 60000, fixtures: ['f1'], params: { dimmer: 1 } },
      ],
    },
  });
  assert.deepEqual(show.timeline.clips.map((c) => c.id), ['ok'], 'the poisoned clip is dropped');
  const ev = createEvaluator(show);
  const universes = renderUniverses(ev, ev.evaluate(1000, {}, 1000), 1000, new Map());
  assert.equal(universes.get(1)[0], 255, 'the rest of the show still renders');

  // A clip that somehow carries such a type anyway (an older file, a client-built show) must
  // be reported by validation rather than silently accepted.
  const sneaked = structuredClone(show);
  sneaked.timeline.clips.push({ ...show.timeline.clips[0], id: 'sneak', type: '__proto__' });
  const report = validateShow(sneaked);
  assert.ok(report.issues.some((e) => e.level === 'error' && e.code === 'clip-type'), 'validation names the unknown clip type');
  const ev2 = createEvaluator(sneaked);
  assert.doesNotThrow(() => ev2.evaluate(1000, {}, 1000), 'the evaluator skips it rather than calling it');
});

test("a clip's fixture list is a set, so one small clip cannot become millions of members", () => {
  // A pixel profile may declare cells up to 1023, and a clip may list 1024 fixtures. Listing
  // the same pixel bar over and over turned a few kilobytes of show file into a million
  // members for the evaluator to walk on every frame: the engine kept running but dropped
  // from 40 frames a second to about 3.
  const clip = normalizeClip(
    { id: 'c', type: 'chase', track: 't', start: 0, end: 1000, fixtures: new Array(1024).fill('f1') },
    new Set(['t']),
  );
  assert.deepEqual(clip.fixtures, ['f1'], 'repeats collapse');

  const show = normalizeShow({
    format: 'dmx-show',
    version: 1,
    profiles: [{ id: 'px', name: 'Pixel', kind: 'pixel', channels: [{ attr: 'red', cell: 0 }, { attr: 'green', cell: 1023 }] }],
    fixtures: [{ id: 'f1', profileId: 'px', universe: 1, address: 1 }],
    timeline: {
      durationMs: 60000,
      tracks: [{ id: 't' }],
      clips: [{ id: 'c', type: 'chase', track: 't', start: 0, end: 60000, fixtures: new Array(1024).fill('f1'), params: { order: 'center' } }],
    },
  });
  const started = Date.now();
  const ev = createEvaluator(show);
  for (let i = 0; i < 20; i++) renderUniverses(ev, ev.evaluate(1000 + i, {}, 1000 + i), 1000 + i, new Map());
  assert.ok(Date.now() - started < 2000, `20 frames took ${Date.now() - started} ms; the clip was not collapsed`);
});

test('ops: removing a profile and undoing puts it back in its own place', () => {
  const show = createShow('Profiles');
  const profile = (id) => ({ id, name: id, manufacturer: 'Test', kind: 'par', channels: [{ attr: 'dimmer' }, { attr: 'red' }] });
  for (const id of ['pf1', 'pf2', 'pf3']) applyOp(show, { type: 'profile.add', profile: profile(id) });
  const before = JSON.stringify(show);

  // The middle one: appending it back on undo used to leave the list in a different order,
  // so the show after undo was not the show before the edit.
  const inverse = applyOp(show, { type: 'profile.remove', id: 'pf2' });
  assert.deepEqual(show.profiles.map((p) => p.id), ['pf1', 'pf3']);
  applyOp(show, inverse);
  assert.equal(JSON.stringify(show), before, 'undo restores the show byte for byte');

  // ...and the same for a batch that fails partway: ops.js rolls back by applying the
  // inverses it has collected, so an inexact inverse corrupts the rollback too.
  assert.throws(
    () => applyOp(show, { type: 'batch', ops: [{ type: 'profile.remove', id: 'pf2' }, { type: 'clip.remove', id: 'no-such-clip' }] }),
    OpError,
  );
  assert.equal(JSON.stringify(show), before, 'a failed batch leaves the show exactly as it was');
});

test('live audio: a flood of hits cannot stall the frame loop', { timeout: 60000 }, () => {
  // The engine takes up to 16 hits per message with no rate limit, and the detector that
  // feeds it tops out near 40 a second. A window sending far faster used to grow the
  // tracker's hit lists without bound, and the work over them is quadratic: a ten-second
  // burst left the engine sending no DMX at all for the next minute.
  const tr = createLiveTracker();
  const t0 = 1_000_000;
  const n = 40000;
  for (let i = 0; i < n; i++) tr.hit(i % 3, t0 + (i * 2000) / n);

  const started = Date.now();
  for (let i = 0; i < 40; i++) {
    tr.update(t0 + 2000 + i);
    tr.snapshot(t0 + 2000 + i);
  }
  const elapsed = Date.now() - started;
  // One second of frames at 40 Hz. Unbounded, a single update() over this many hits took
  // tens of seconds on its own.
  assert.ok(elapsed < 2000, `a second of frames took ${elapsed} ms after a flood of ${n} hits`);

  // The cap must not break ordinary tracking: a steady 120 BPM kick still locks the clock.
  const tr2 = createLiveTracker();
  let t = 500_000;
  for (let b = 0; b < 40; b++, t += 500) {
    tr2.hit(0, t);
    tr2.levels([0.5, 0.4, 0.3, 0.6], t);
    tr2.update(t);
  }
  const snap = tr2.snapshot(t);
  assert.ok(Math.abs(snap.bpm - 120) < 2, `tracked ${snap.bpm} BPM, expected 120`);
  assert.equal(snap.locked, true);
});

test('media upload: two windows sending the same song at once both succeed, intact', { timeout: 30000 }, async () => {
  // Both requests name the file by its hash, so they used to share one part file: each
  // truncated and overwrote the other's bytes, and whichever lost the race was told the
  // upload had failed even though the audio was on disk.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmx-media-'));
  const mediaDir = path.join(dataDir, 'media');
  const log = { info() {}, warn() {}, error() {} };
  const server = http.createServer(createRequestHandler({
    root: path.resolve(import.meta.dirname, '..'),
    mediaDir,
    log,
    getInfo: () => ({ name: 'DMX Show Controller' }),
  }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  const audio = Buffer.from('RIFFfake-wave-data'.repeat(20000)); // ~360 KB
  const hash = crypto.createHash('sha256').update(audio).digest('hex');

  /** PUT the audio in chunks `gap` ms apart, so the two uploads really do overlap. */
  const upload = (gap) => new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let reply = '';
    sock.on('data', (d) => (reply += d));
    sock.on('error', () => resolve('error'));
    sock.on('close', () => resolve((reply.match(/^HTTP\/1\.1 (\d+)/) || [])[1] || 'none'));
    sock.on('connect', async () => {
      sock.write(`PUT /api/media/${hash} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: audio/wav\r\nContent-Length: ${audio.length}\r\nConnection: close\r\n\r\n`);
      for (let i = 0; i < audio.length; i += 40000) {
        sock.write(audio.subarray(i, i + 40000));
        await new Promise((r) => setTimeout(r, gap));
      }
    });
  });

  // 201 for a request that stored the file, 200 for one that found it already there; a 500
  // ("Could not store audio") is the failure this guards against.
  const codes = await Promise.all([upload(20), upload(35)]);
  assert.ok(codes.every((c) => c === '200' || c === '201'), `both uploads should be accepted, got ${codes.join(' and ')}`);

  const stored = fs.readFileSync(path.join(mediaDir, hash));
  assert.equal(crypto.createHash('sha256').update(stored).digest('hex'), hash, 'the stored file matches its hash');
  assert.deepEqual(fs.readdirSync(mediaDir).filter((f) => f.endsWith('.part')), [], 'no part files left behind');

  await new Promise((r) => server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('a window that stops reading is closed, not fed until the engine runs out of memory', async () => {
  // Measured before this guard: one socket that completes the handshake and never reads,
  // while another window edits, took the engine from 72 MB to 383 MB on a short run and
  // was still climbing with no ceiling. DMX kept flowing, so it kills a machine quietly
  // over an evening rather than failing outright.
  //
  // Dropping the message is not an option the way it is for USB frames — the next frame
  // replaces the last, but a missed `op` leaves that window's show silently wrong. So the
  // socket is closed and the client's own reconnect re-syncs it with a fresh `welcome`.
  const { Session } = await import('../server/session.js');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmx-backlog-'));
  const session = new Session({ dataDir, log: { info() {}, warn() {}, error() {} } });

  const makeClient = (id, backlog, view = 'design') => {
    const sent = [];
    const conn = {
      open: true,
      bufferedAmount: backlog,
      send: (text) => sent.push(text),
      close: () => {
        conn.open = false;
        conn.closed = true;
      },
    };
    session.clients.set(id, { id, conn, name: id, view, usbUniverse: null, address: '127.0.0.1' });
    return { conn, sent };
  };

  const healthy = makeClient('healthy', 0);
  const asleep = makeClient('asleep', 8 * 1024 * 1024); // well past the ceiling
  const nearly = makeClient('nearly', 1024 * 1024); // busy but keeping up

  session.broadcast({ t: 'test', payload: 'x' });

  assert.equal(healthy.sent.length, 1, 'a window that is reading still gets the message');
  assert.equal(nearly.sent.length, 1, 'a merely busy window is not punished');
  assert.equal(asleep.sent.length, 0, 'nothing more is queued onto the one that stopped reading');
  assert.equal(asleep.conn.closed, true, 'and it is closed so it reconnects and re-syncs');
  assert.equal(healthy.conn.closed, undefined);

  fs.rmSync(dataDir, { recursive: true, force: true });
});
