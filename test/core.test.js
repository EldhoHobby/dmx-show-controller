import test from 'node:test';
import assert from 'node:assert/strict';
import { createShow, exportShow, normalizeShow } from '../shared/show.js';
import { applyOp, OpError } from '../shared/ops.js';
import { createEvaluator, interpolateKeys } from '../shared/evaluate.js';
import { renderUniverses, softwareStrobeOn } from '../shared/dmx-render.js';
import { validateShow } from '../shared/validate.js';
import { createTempo } from '../shared/tempo.js';
import { aimAt, beamDirection } from '../shared/kinematics.js';
import { getBuiltinProfile } from '../shared/fixture-library.js';

function rig() {
  const show = createShow('Test');
  show.tempo = { bpm: 120, offset: 0, beatsPerBar: 4, downbeat: 0, beats: null }; // 500 ms beats
  const add = (fixture) => applyOp(show, { type: 'fixture.add', fixture });
  add({ id: 'p1', name: 'Par 1', profileId: 'generic.rgbw-7ch', universe: 1, address: 1, position: { x: -3, y: 3, z: 0 } });
  add({ id: 'p2', name: 'Par 2', profileId: 'generic.rgbw-7ch', universe: 1, address: 8, position: { x: -1, y: 3, z: 0 } });
  add({ id: 'p3', name: 'Par 3', profileId: 'generic.rgbw-7ch', universe: 1, address: 15, position: { x: 1, y: 3, z: 0 } });
  add({ id: 'p4', name: 'Par 4', profileId: 'generic.rgbw-7ch', universe: 1, address: 22, position: { x: 3, y: 3, z: 0 } });
  add({ id: 'rgb', name: 'RGB', profileId: 'generic.rgb', universe: 2, address: 1, position: { x: 0, y: 0, z: 2 } });
  add({ id: 'mh', name: 'Mover', profileId: 'generic.wash-mover-14ch', universe: 2, address: 10, position: { x: 0, y: 4, z: 0 }, rotation: { x: 180, y: 0, z: 0 } });
  return show;
}

const clip = (show, c) => applyOp(show, { type: 'clip.add', clip: { fadeIn: 0, fadeOut: 0, ...c } });

test('intensity is HTP across layers, colour is LTP from the top layer', () => {
  const show = rig();
  clip(show, { id: 'a', type: 'static', track: 'trk_base', start: 0, end: 10000, fixtures: ['p1'], params: { dimmer: 0.4, color: [1, 0, 0] } });
  clip(show, { id: 'b', type: 'static', track: 'trk_accent', start: 0, end: 10000, fixtures: ['p1'], params: { dimmer: 0.2, color: [0, 0, 1] } });
  const s = createEvaluator(show).evaluate(1000).get('p1');
  assert.equal(s.dimmer, 0.4, 'higher intensity wins even from a lower layer');
  assert.deepEqual(s.color, [0, 0, 1], 'top layer colour wins');
});

test('"override" intensity mixing lets a top layer black out lower layers', () => {
  const show = rig();
  clip(show, { id: 'a', type: 'static', track: 'trk_base', start: 0, end: 10000, fixtures: ['p1'], params: { dimmer: 1 } });
  clip(show, { id: 'b', type: 'static', track: 'trk_accent', start: 0, end: 10000, fixtures: ['p1'], params: { dimmer: 0, dimmerMode: 'set' } });
  assert.equal(createEvaluator(show).evaluate(1000).get('p1').dimmer, 0);
});

test('fades crossfade LTP colour and scale HTP intensity', () => {
  const show = rig();
  clip(show, { id: 'a', type: 'static', track: 'trk_base', start: 0, end: 10000, fixtures: ['p1'], params: { color: [1, 0, 0] } });
  clip(show, { id: 'b', type: 'static', track: 'trk_accent', start: 2000, end: 10000, fadeIn: 1000, fixtures: ['p1'], params: { dimmer: 1, color: [0, 0, 1] } });
  const s = createEvaluator(show).evaluate(2500).get('p1');
  assert.ok(Math.abs(s.dimmer - 0.5) < 1e-9);
  assert.deepEqual(s.color.map((v) => Math.round(v * 100) / 100), [0.5, 0, 0.5]);
});

test('a forward chase steps left to right by stage position, one fixture per beat', () => {
  const show = rig();
  // Patch order deliberately differs from stage order.
  clip(show, { id: 'c', type: 'chase', track: 'trk_rhythm', start: 0, end: 10000, fixtures: ['p3', 'p1', 'p4', 'p2'], params: { step: 1, direction: 'forward', width: 1, level: 1, order: 'x' } });
  const ev = createEvaluator(show);
  const lit = (t) => ['p1', 'p2', 'p3', 'p4'].filter((id) => ev.evaluate(t).get(id).dimmer > 0.5);
  assert.deepEqual(lit(100), ['p1']);
  assert.deepEqual(lit(600), ['p2']);
  assert.deepEqual(lit(1100), ['p3']);
  assert.deepEqual(lit(1600), ['p4']);
  assert.deepEqual(lit(2100), ['p1'], 'wraps around');
});

test('pulse peaks on the beat and decays', () => {
  const show = rig();
  clip(show, { id: 'p', type: 'pulse', track: 'trk_rhythm', start: 0, end: 10000, fixtures: ['p1'], params: { division: 1, decay: 0.5, level: 1 } });
  const ev = createEvaluator(show);
  assert.ok(ev.evaluate(1000).get('p1').dimmer > 0.99, 'on the beat');
  assert.ok(Math.abs(ev.evaluate(1125).get('p1').dimmer - 0.25) < 1e-6, 'quarter way into the decay');
  assert.equal(ev.evaluate(1300).get('p1').dimmer, 0, 'after the decay');
});

test('keyframes interpolate linearly, smoothly or hold', () => {
  const lin = [{ t: 0, v: 0, ease: 'linear' }, { t: 1000, v: 1 }];
  assert.equal(interpolateKeys(lin, 250), 0.25);
  const step = [{ t: 0, v: 0, ease: 'step' }, { t: 1000, v: 1 }];
  assert.equal(interpolateKeys(step, 999), 0);
  const smooth = [{ t: 0, v: 0, ease: 'smooth' }, { t: 1000, v: 1 }];
  assert.ok(interpolateKeys(smooth, 250) < 0.25);
  assert.deepEqual(interpolateKeys([{ t: 0, v: [0, 0, 0] }, { t: 100, v: [1, 1, 1] }], 50), [0.5, 0.5, 0.5]);
});

test('render: dimmer channel, RGB→RGBW white extraction, intensity baked into dimmer-less fixtures', () => {
  const show = rig();
  clip(show, { id: 'a', type: 'static', track: 'trk_base', start: 0, end: 10000, fixtures: ['p1', 'rgb'], params: { dimmer: 0.5, color: [1, 1, 0] } });
  const ev = createEvaluator(show);
  const u = renderUniverses(ev, ev.evaluate(1000), 1000);
  assert.deepEqual(Array.from(u.get(1).slice(0, 7)), [128, 255, 255, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(u.get(2).slice(0, 3)), [128, 128, 0], 'RGB-only par scales colour by intensity');
  clip(show, { id: 'w', type: 'static', track: 'trk_accent', start: 0, end: 10000, fixtures: ['p1'], params: { dimmer: 1, color: [1, 1, 1] } });
  const ev2 = createEvaluator(show);
  const u2 = renderUniverses(ev2, ev2.evaluate(1000), 1000);
  assert.deepEqual(Array.from(u2.get(1).slice(0, 5)), [255, 0, 0, 0, 255], 'pure white uses the white LED');
});

test('render: 16-bit pan/tilt split into coarse and fine bytes', () => {
  const show = rig();
  clip(show, { id: 'm', type: 'static', track: 'trk_base', start: 0, end: 10000, fixtures: ['mh'], params: { dimmer: 1, position: 'manual', pan: 0, tilt: 67.5 } });
  const ev = createEvaluator(show);
  const u = renderUniverses(ev, ev.evaluate(1000), 1000).get(2);
  const pan16 = u[9] * 256 + u[10];
  const tilt16 = u[11] * 256 + u[12];
  assert.equal(pan16, Math.round(0.5 * 65535), 'pan centre');
  assert.equal(tilt16, Math.round(0.75 * 65535), 'tilt +67.5 of 270 = 75%');
  assert.equal(u[15], 255, 'shutter open when not strobing');
});

test('aimAt points a truss-hung mover at the audience', () => {
  const show = rig();
  const mover = show.fixtures.find((f) => f.id === 'mh');
  const profile = getBuiltinProfile('generic.wash-mover-14ch');
  const target = { x: 2, y: 1.6, z: 8 };
  const aim = aimAt(mover, target, profile);
  assert.ok(aim.reachable);
  const d = beamDirection(mover, aim.pan, aim.tilt);
  const v = [target.x - 0, target.y - 4, target.z - 0];
  const len = Math.hypot(...v);
  const dot = (d[0] * v[0] + d[1] * v[1] + d[2] * v[2]) / len;
  assert.ok(dot > 0.9999, `beam should point at the target (cos ${dot})`);
});

test('software strobe flashes fixtures without a strobe channel', () => {
  let on = 0;
  for (let t = 0; t < 1000; t += 5) if (softwareStrobeOn(1, t)) on++;
  assert.ok(on > 50 && on < 100, `about 35% duty (${on}/200)`);
  assert.equal(softwareStrobeOn(0, 123), true);
});

test('live layer: grand master scales, blackout wins over flash', () => {
  const show = rig();
  clip(show, { id: 'a', type: 'static', track: 'trk_base', start: 0, end: 10000, fixtures: ['p1'], params: { dimmer: 1 } });
  const ev = createEvaluator(show);
  assert.equal(ev.evaluate(10, { master: 0.5 }).get('p1').dimmer, 0.5);
  assert.equal(ev.evaluate(10, { master: 1, flash: 'blinder' }).get('p2').dimmer, 1);
  assert.equal(ev.evaluate(10, { master: 1, blackout: true, flash: 'blinder' }).get('p1').dimmer, 0);
});

test('tempo maps follow a detected beat list and extrapolate past its ends', () => {
  const tempo = createTempo({ bpm: 120, beats: [1000, 1500, 2010, 2500], downbeat: 0 });
  assert.equal(tempo.beatAt(1500), 1);
  assert.ok(Math.abs(tempo.beatAt(1755) - 1.5) < 1e-9);
  assert.equal(tempo.beatAt(3000), 4);
  assert.equal(tempo.timeAt(2), 2010);
  assert.equal(tempo.snap(1740, 1), 1500);
});

test('ops: every edit has an exact inverse', () => {
  const show = rig();
  const before = JSON.stringify(show);
  const ops = [
    { type: 'fixture.update', id: 'p1', changes: { address: 30, name: 'Renamed', position: { x: 9, y: 9, z: 9 } } },
    { type: 'clip.add', clip: { id: 'x', type: 'chase', track: 'trk_rhythm', start: 0, end: 4000, fixtures: ['p1', 'p2'], params: { step: 1 } } },
    { type: 'clip.update', id: 'x', changes: { start: 500, params: { step: 0.5 } } },
    { type: 'track.remove', id: 'trk_rhythm' },
    { type: 'fixture.remove', id: 'p2' },
    { type: 'tempo.set', changes: { bpm: 128 } },
    { type: 'meta.set', changes: { name: 'Other' } },
    { type: 'timeline.setDuration', durationMs: 60000 },
  ];
  const inverses = ops.map((op) => applyOp(show, op));
  assert.notEqual(JSON.stringify(show), before);
  for (const inv of inverses.reverse()) applyOp(show, inv);
  assert.equal(JSON.stringify(show), before);
});

test('ops: hostile and malformed input is rejected or neutralized', () => {
  const show = rig();
  assert.throws(() => applyOp(show, { type: 'nope' }), OpError);
  assert.throws(() => applyOp(show, { type: 'fixture.update', id: 'missing', changes: {} }), OpError);
  assert.throws(() => applyOp(show, { type: 'clip.add', clip: { id: 'z', type: 'static', track: 'no-such-track', start: 0, end: 1 } }), OpError);
  const evil = JSON.parse('{"type":"fixture.update","id":"p1","changes":{"__proto__":{"polluted":true},"name":"ok"}}');
  applyOp(show, evil);
  assert.equal({}.polluted, undefined, 'no prototype pollution');
  assert.equal(show.fixtures[0].name, 'ok');
  // A failing batch leaves the show untouched.
  const before = JSON.stringify(show);
  assert.throws(() =>
    applyOp(show, { type: 'batch', ops: [{ type: 'meta.set', changes: { name: 'changed' } }, { type: 'clip.remove', id: 'missing' }] }),
  );
  assert.equal(JSON.stringify(show), before);
});

test('validation flags address overlaps, out-of-range patches and dangling clips', () => {
  const show = rig();
  applyOp(show, { type: 'fixture.add', fixture: { id: 'bad', name: 'Overlap', profileId: 'generic.rgbw-7ch', universe: 1, address: 5 } });
  applyOp(show, { type: 'fixture.add', fixture: { id: 'far', name: 'Too high', profileId: 'generic.wash-mover-14ch', universe: 1, address: 505 } });
  applyOp(show, { type: 'fixture.add', fixture: { id: 'ghost', name: 'Ghost', profileId: 'missing.profile', universe: 3, address: 1 } });
  clip(show, { id: 'o1', type: 'static', track: 'trk_base', start: 0, end: 5000, fixtures: ['p1'], params: { dimmer: 1 } });
  clip(show, { id: 'o2', type: 'static', track: 'trk_base', start: 4000, end: 8000, fixtures: ['p1'], params: { dimmer: 1 } });
  clip(show, { id: 'mv', type: 'movement', track: 'trk_move', start: 0, end: 5000, fixtures: ['mh'], params: { center: 'manual', pan: 250, tilt: 0, sizePan: 40, sizeTilt: 0 } });
  const v = validateShow(show, { routedUniverses: new Set([1]) });
  const codes = v.issues.map((i) => i.code);
  assert.ok(codes.includes('address-overlap'));
  assert.ok(codes.includes('address-range'));
  assert.ok(codes.includes('missing-profile'));
  assert.ok(codes.includes('clip-overlap'));
  assert.ok(codes.includes('pan-tilt-range'));
  assert.ok(codes.includes('universe-unrouted'), 'universe 2 has fixtures but is not routed');
  assert.equal(v.ok, false);
});

test('export embeds built-in profiles so the event file is self-contained', () => {
  const show = rig();
  const exported = JSON.parse(JSON.stringify(exportShow(show, { errors: 0, warnings: 0 })));
  const reopened = normalizeShow(exported);
  assert.deepEqual(new Set(reopened.profiles.map((p) => p.id)), new Set(['generic.rgbw-7ch', 'generic.rgb', 'generic.wash-mover-14ch']));
  assert.throws(() => normalizeShow({ hello: 'world' }), /not a DMX show/);
  assert.throws(() => normalizeShow({ format: 'dmx-show', version: 99 }), /newer version/);
});
