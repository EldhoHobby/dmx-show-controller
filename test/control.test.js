// Manual faders, raw channels, scenes, calibration, automatic groups and live-audio reactions.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createShow, normalizeShow, normalizeScene } from '../shared/show.js';
import { applyOp } from '../shared/ops.js';
import { createEvaluator } from '../shared/evaluate.js';
import { renderUniverses } from '../shared/dmx-render.js';
import { fixtureGroups } from '../shared/groups.js';
import { validateShow } from '../shared/validate.js';
import { applyProgrammer, emptyProgrammer, mergeSets, programmerHolds } from '../shared/programmer.js';

function rig() {
  const show = createShow('Control');
  const add = (fixture) => applyOp(show, { type: 'fixture.add', fixture });
  add({ id: 'p1', name: 'Par 1', profileId: 'generic.rgbw-7ch', universe: 1, address: 1, position: { x: -2, y: 3, z: 0 } });
  add({ id: 'p2', name: 'Par 2', profileId: 'generic.rgbw-7ch', universe: 1, address: 8, position: { x: 2, y: 3, z: 0 } });
  add({ id: 'rgb', name: 'RGB', profileId: 'generic.rgb', universe: 1, address: 20, position: { x: 0, y: 0, z: 1 } });
  add({ id: 'mh', name: 'Mover', profileId: 'generic.wash-mover-14ch', universe: 1, address: 30, position: { x: 0, y: 4, z: 0 }, rotation: { x: 180, y: 0, z: 0 } });
  applyOp(show, { type: 'clip.add', clip: { id: 'base', type: 'static', track: 'trk_base', start: 0, end: 60000, fixtures: ['p1', 'p2', 'mh'], params: { dimmer: 0.3, color: [1, 0, 0], position: 'aim' } } });
  return show;
}

const frame = (show, live, t = 1000, now = t) => {
  const ev = createEvaluator(show);
  const states = ev.evaluate(t, live, now);
  return { ev, states, dmx: renderUniverses(ev, states, now).get(1) };
};

test('manual faders override the show (intensity included) until released', () => {
  const show = rig();
  const { states } = frame(show, { master: 1, programmer: { attrs: { p1: { dimmer: 0.1, color: [0, 0, 1] } }, raw: {} } });
  assert.equal(states.get('p1').dimmer, 0.1, 'a fader can pull intensity below the show (override, not HTP)');
  assert.deepEqual(states.get('p1').color, [0, 0, 1]);
  assert.equal(states.get('p2').dimmer, 0.3, 'other fixtures keep running the show');
});

test('raw channel values land exactly, but blackout and the grand master still govern intensity', () => {
  const show = rig();
  const raw = { p1: { 0: 200, 5: 77 }, rgb: { 0: 255 }, mh: { 0: 10 } };
  let { dmx } = frame(show, { master: 1, programmer: { attrs: {}, raw } });
  assert.equal(dmx[0], 200, 'dimmer channel');
  assert.equal(dmx[5], 77, 'strobe channel');
  assert.equal(dmx[19], 255, 'red of an RGB-only par');
  assert.equal(dmx[29], 10, 'mover pan coarse');
  ({ dmx } = frame(show, { master: 0.5, programmer: { attrs: {}, raw } }));
  assert.equal(dmx[0], 100, 'grand master halves a manual dimmer value');
  assert.equal(dmx[19], 128, 'and the colour of a fixture without a dimmer channel');
  assert.equal(dmx[29], 10, 'but not position');
  ({ dmx } = frame(show, { master: 1, blackout: true, programmer: { attrs: {}, raw } }));
  assert.equal(dmx[0], 0, 'blackout silences manual intensity');
  assert.equal(dmx[19], 0);
  assert.equal(dmx[5], 77, 'non-intensity channels keep their value in blackout');
});

test('a raw channel moves only its own channel, not the rest of the fixture', () => {
  const show = rig();
  // 'rgb' has no dimmer channel, so intensity rides on its colour channels. Mirroring the
  // raw byte back into the state used to seed the untouched components from the state's hue
  // ([1,1,1] by default), which drove them to full: dragging Red alone turned the par white.
  let { dmx } = frame(show, { master: 1, programmer: { attrs: {}, raw: { rgb: { 0: 255 } } } });
  assert.deepEqual([...dmx.slice(19, 22)], [255, 0, 0], 'red only');
  ({ dmx } = frame(show, { master: 1, programmer: { attrs: {}, raw: { rgb: { 1: 200 } } } }));
  assert.deepEqual([...dmx.slice(19, 22)], [0, 200, 0], 'green only');
  ({ dmx } = frame(show, { master: 1, programmer: { attrs: {}, raw: { rgb: { 0: 255, 1: 100 } } } }));
  assert.deepEqual([...dmx.slice(19, 22)], [255, 100, 0], 'two channels set, the third stays put');

  // p1 is an RGBW par with a dimmer channel: its colour channels are independent of it.
  ({ dmx } = frame(show, { master: 1, programmer: { attrs: {}, raw: { p1: { 1: 180 } } } }));
  assert.equal(dmx[1], 180, 'red');
  assert.equal(dmx[2], 0, 'green untouched');
  assert.equal(dmx[3], 0, 'blue untouched');
});

test('raw values are mirrored into the 3D view', () => {
  const show = rig();
  // 16-bit pan: coarse 192, fine 0 = 75% of 540 degrees = +135 degrees from centre.
  const { states } = frame(show, { master: 1, programmer: { attrs: {}, raw: { p1: { 0: 255 }, mh: { 0: 192, 1: 0 } } } });
  assert.equal(states.get('p1').dimmer, 1);
  assert.ok(Math.abs(states.get('mh').pan - (192 * 256 / 65535 * 540 - 270)) < 0.01, `pan ${states.get('mh').pan}`);
});

test('scenes fade in and out on the engine clock, and their raw values apply once mostly in', () => {
  const show = rig();
  applyOp(show, { type: 'scene.add', scene: { id: 'sc', name: 'Blue', fadeMs: 1000, attrs: { p1: { dimmer: 1, color: [0, 0, 1] } }, raw: { p2: { 5: 99 } } } });
  const at = 10000;
  const mid = frame(show, { master: 1, scenes: [{ id: 'sc', at }] }, 1000, at + 500);
  assert.ok(Math.abs(mid.states.get('p1').dimmer - 0.65) < 1e-9, 'halfway between 0.3 and 1');
  assert.equal(mid.dmx[7 + 5], 99, 'raw value applied at 50%');
  const full = frame(show, { master: 1, scenes: [{ id: 'sc', at }] }, 1000, at + 2000);
  assert.deepEqual(full.states.get('p1').color, [0, 0, 1]);
  const out = frame(show, { master: 1, scenes: [{ id: 'sc', at, releasedAt: at + 2000 }] }, 1000, at + 3000);
  assert.equal(out.states.get('p1').dimmer, 0.3, 'released and faded out');
});

test('calibration offsets move every aim, including generated "aim" positions', () => {
  const show = rig();
  const before = frame(show, { master: 1 }).states.get('mh');
  applyOp(show, { type: 'fixture.update', id: 'mh', changes: { calibration: { pan: 4, tilt: -2.5 } } });
  const after = frame(show, { master: 1 }).states.get('mh');
  assert.ok(Math.abs(after.pan - before.pan - 4) < 1e-9);
  assert.ok(Math.abs(after.tilt - before.tilt + 2.5) < 1e-9);
});

test('Prime/Calibrate: an open white beam on the target, others dark, manual values ignored', () => {
  const show = rig();
  const { states, ev } = frame(show, { master: 1, calibrate: { fixtureId: 'mh', othersOff: true }, programmer: { attrs: {}, raw: { mh: { 0: 5 } } } });
  const mh = states.get('mh');
  assert.equal(mh.dimmer, 1);
  assert.deepEqual(mh.color, [1, 1, 1]);
  assert.equal(mh.zoom, 0, 'narrowest beam to see the spot');
  assert.equal(mh.pan, ev.byId.get('mh').aim.pan);
  assert.equal(states.get('p1').dimmer, 0);
  assert.equal(states.raw.size, 0);
  const all = frame(show, { master: 1, calibrate: { all: true, othersOff: false } }).states;
  assert.equal(all.get('mh').dimmer, 1);
  assert.equal(all.get('p1').dimmer, 0.3, 'others keep the show when not switched off');
});

test('automatic groups: by role and by identical type, without duplicates', () => {
  const show = rig();
  const groups = fixtureGroups(show);
  const keys = groups.map((g) => g.key);
  assert.deepEqual(keys, ['all', 'role:mover', 'role:wash', 'type:generic.rgbw-7ch', 'type:generic.rgb']);
  assert.deepEqual(groups.find((g) => g.key === 'role:wash').fixtures, ['p1', 'rgb', 'p2'], 'left to right on stage');
  assert.ok(groups.find((g) => g.key === 'role:mover').caps.panTilt);
  // With only one kind of wash the type group would repeat the role group, so it is dropped.
  applyOp(show, { type: 'fixture.remove', id: 'rgb' });
  assert.ok(!fixtureGroups(show).some((g) => g.key === 'type:generic.rgbw-7ch'));
});

test('live audio: kick hits pulse the washes, the mid band steps colour, levels can drive intensity', () => {
  const show = rig();
  const hitAt = 50000;
  const reactive = { last: { low: hitAt, mid: hitAt, high: null }, strength: { low: 1, mid: 1, high: 0 }, count: { low: 1, mid: 3, high: 0 }, env: { low: 0.4, mid: 0, high: 0, energy: 0 } };
  const live = { master: 1, audioReactive: true, reactive };
  const onHit = frame(show, live, 1000, hitAt).states;
  assert.equal(onHit.get('p1').dimmer, 1, 'kick pulse at the hit');
  const colors = show.audioReactive.mappings.find((m) => m.action === 'colorStep').colors;
  assert.deepEqual(onHit.get('p1').color, colors[3 % colors.length], 'mid hit count picks the palette colour');
  const later = frame(show, live, 1000, hitAt + 400).states;
  assert.equal(later.get('p1').dimmer, 0.3, 'pulse has decayed back to the show');
  const off = frame(show, { ...live, audioReactive: false }, 1000, hitAt).states;
  assert.equal(off.get('p1').dimmer, 0.3, 'nothing reacts while audio-reactive is off');
  applyOp(show, { type: 'reactive.set', changes: { mappings: [{ id: 'f', band: 'low', action: 'follow', target: 'role:wash', amount: 1, decayMs: 100 }] } });
  assert.equal(frame(show, live, 1000, hitAt + 10000).states.get('p2').dimmer, 0.4, 'follow mirrors the band level');
});

test('scene, reactive and calibration edits undo exactly; hostile values are clamped', () => {
  const show = rig();
  const before = JSON.stringify(show);
  const inverses = [
    applyOp(show, { type: 'scene.add', scene: { id: 's1', name: 'A', attrs: { p1: { dimmer: 5, pan: 9999 } }, raw: { p1: { 3: 999, 600: 1 } } } }),
    applyOp(show, { type: 'scene.update', id: 's1', changes: { name: 'B', fadeMs: 500 } }),
    applyOp(show, { type: 'reactive.set', changes: { sensitivity: { low: 2, mid: 1, high: 1 } } }),
    applyOp(show, { type: 'fixture.update', id: 'mh', changes: { calibration: { pan: 3, tilt: 1 } } }),
  ];
  const s1 = show.scenes[0];
  assert.equal(s1.attrs.p1.dimmer, 1, 'dimmer clamped to 1');
  assert.equal(s1.attrs.p1.pan, 720, 'pan clamped');
  assert.deepEqual(s1.raw.p1, { 3: 255 }, 'DMX value clamped, impossible channel dropped');
  for (const inv of inverses.reverse()) applyOp(show, inv);
  assert.equal(JSON.stringify(show), before);
  const evil = normalizeScene(JSON.parse('{"id":"x","attrs":{"__proto__":{"dimmer":1},"p1":{"__proto__":1,"dimmer":0.5}}}'));
  assert.deepEqual(Object.keys(evil.attrs), ['p1']);
  assert.equal({}.dimmer, undefined);
});

test('shows round-trip scenes, reactions and calibration; validation flags stale scenes', () => {
  const show = rig();
  applyOp(show, { type: 'scene.add', scene: { id: 's1', name: 'Ghost', attrs: { gone: { dimmer: 1 } }, raw: { p1: { 30: 10 } } } });
  applyOp(show, { type: 'fixture.update', id: 'mh', changes: { calibration: { pan: 2, tilt: 0 } } });
  const again = normalizeShow(JSON.parse(JSON.stringify(show)));
  assert.equal(again.scenes.length, 1);
  assert.equal(again.fixtures.find((f) => f.id === 'mh').calibration.pan, 2);
  assert.equal(again.audioReactive.mappings.length, 3);
  const codes = validateShow(again).issues.map((i) => i.code);
  assert.ok(codes.includes('scene-missing-fixtures'));
  assert.ok(codes.includes('scene-channel-range'));
});

test('manual control updates: a window replaying its unconfirmed moves ends where the engine does', () => {
  let p = emptyProgrammer();
  p = applyProgrammer(p, { set: { attrs: { a: { dimmer: 0.5, pan: 10 } }, raw: { a: { 3: 200 } } } });
  p = applyProgrammer(p, { set: { attrs: { a: { pan: null } } } });
  assert.deepEqual(p, { attrs: { a: { dimmer: 0.5 } }, raw: { a: { 3: 200 } } }, 'null releases one value');
  p = applyProgrammer(p, { clear: { fixtures: ['a'] }, set: { attrs: { b: { dimmer: 1 } } } });
  assert.deepEqual(p, { attrs: { b: { dimmer: 1 } }, raw: {} }, 'clear happens before set');
  assert.deepEqual(applyProgrammer(p, { set: { attrs: { ghost: { dimmer: 1 } } } }, new Set(['b'])).attrs, { b: { dimmer: 1 } }, 'the engine drops fixtures that are not patched');
  assert.deepEqual(
    mergeSets({ attrs: { a: { dimmer: 1, pan: 5 } } }, { attrs: { a: { pan: null } }, raw: { a: { 0: 9 } } }),
    { attrs: { a: { dimmer: 1, pan: null } }, raw: { a: { 0: 9 } } },
    'pending fader moves combine, keeping releases',
  );
  // What a window shows (engine state + its in-flight messages) is what the engine ends with.
  const inflight = [{ set: { attrs: { a: { dimmer: 0.2 } } } }, { set: { attrs: { a: { dimmer: 0.4 } } } }, { clear: 'all' }, { set: { raw: { a: { 1: 7 } } } }];
  const local = inflight.reduce((acc, m) => applyProgrammer(acc, m), emptyProgrammer());
  const engine = inflight.reduce((acc, m) => applyProgrammer(acc, m, new Set(['a'])), emptyProgrammer());
  assert.deepEqual(local, engine);
  assert.deepEqual(local, { attrs: {}, raw: { a: { 1: 7 } } });
  assert.equal(programmerHolds(local), true);
  assert.equal(programmerHolds(local, 'b'), false);
});
