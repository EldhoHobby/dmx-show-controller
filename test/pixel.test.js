// Pixel fixtures: bars whose cells light up one by one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createShow } from '../shared/show.js';
import { applyOp } from '../shared/ops.js';
import { createEvaluator } from '../shared/evaluate.js';
import { renderUniverses } from '../shared/dmx-render.js';
import { fixtureGroups } from '../shared/groups.js';
import { cellCount, cellOffsets, checkProfile, fixtureRole, getBuiltinProfile } from '../shared/fixture-library.js';

// generic.pixelbar-8rgb: ch 1 master dimmer, ch 2 strobe, then R G B for cells 1..8.
const RED = (cell) => 2 + 3 * cell;
const BLUE = (cell) => 4 + 3 * cell;

function rig(clips = [], bars = [{ id: 'barL', x: -1 }]) {
  const show = createShow('Pixels');
  applyOp(show, { type: 'tempo.set', changes: { bpm: 120, offset: 0, downbeat: 0 } });
  bars.forEach((b, i) => applyOp(show, { type: 'fixture.add', fixture: { id: b.id, name: b.id, profileId: b.profile || 'generic.pixelbar-8rgb', universe: 1, address: 1 + 64 * i, position: { x: b.x, y: 3, z: 0 }, rotation: { x: 180, y: 0, z: 0 } } }));
  for (const clip of clips) applyOp(show, { type: 'clip.add', clip: { track: 'trk_rhythm', start: 0, end: 60000, ...clip } });
  return show;
}
const dmxAt = (show, t, live = { master: 1 }) => {
  const ev = createEvaluator(show);
  return renderUniverses(ev, ev.evaluate(t, live), t).get(1);
};

test('the pixel bar profile: 8 cells across a metre, its own role and group', () => {
  const p = getBuiltinProfile('generic.pixelbar-8rgb');
  assert.equal(cellCount(p), 8);
  assert.deepEqual(checkProfile(p), []);
  assert.equal(fixtureRole(p), 'pixel');
  const xs = cellOffsets(p).map(([x]) => x);
  assert.ok(Math.abs(xs[0] + 0.4375) < 1e-9 && Math.abs(xs[7] - 0.4375) < 1e-9);
  assert.equal(cellCount(getBuiltinProfile('generic.rgbw-7ch')), 0, 'ordinary fixtures have no cells');
  const groups = fixtureGroups(rig());
  assert.ok(groups.some((g) => g.key === 'role:pixel' && g.name === 'Pixel bars'));
  assert.deepEqual(checkProfile({ id: 'x', name: 'x', channels: [{ attr: 'red', cell: -1 }] }).length, 1);
});

test('a chase on a pixel bar steps cell by cell, left to right as the audience sees it', () => {
  const show = rig([{ id: 'c', type: 'chase', fixtures: ['barL'], params: { step: 1, direction: 'forward', width: 1, tail: 0, level: 1, order: 'x', color: [1, 0, 0] } }]);
  for (const beat of [0, 3, 7]) {
    const dmx = dmxAt(show, beat * 500 + 50);
    const lit = [0, 1, 2, 3, 4, 5, 6, 7].filter((c) => dmx[RED(c)] > 200);
    assert.deepEqual(lit, [beat], `beat ${beat}`);
    assert.equal(dmx[0], 255, 'master dimmer open while a cell is lit');
  }
  // The bar hangs facing down (rotation x 180): its first cell is still on the audience's left.
  const ev = createEvaluator(show);
  const xs = ev.byId.get('barL').cells.map((c) => c.fixture.position.x);
  assert.ok(xs[0] < xs[7]);
});

test('two bars side by side chase as one line of 16 pixels', () => {
  const show = rig(
    [{ id: 'c', type: 'chase', fixtures: ['barR', 'barL'], params: { step: 1, direction: 'forward', width: 1, tail: 0, level: 1, order: 'x', color: [0, 0, 1] } }],
    [{ id: 'barL', x: -0.5 }, { id: 'barR', x: 0.5 }],
  );
  const dmx = dmxAt(show, 9 * 500 + 50);
  assert.equal(dmx[64 + BLUE(1)], 255, 'beat 9 = the second cell of the right-hand bar');
  assert.ok([0, 1, 2, 3, 4, 5, 6, 7].every((c) => dmx[BLUE(c)] === 0));
});

test('colours, scenes and faders reach every cell; grand master and blackout too', () => {
  const show = rig([{ id: 's', type: 'static', track: 'trk_base', fixtures: ['barL'], params: { dimmer: 0.5, color: [0, 0, 1] } }]);
  let dmx = dmxAt(show, 1000);
  assert.ok([0, 1, 2, 3, 4, 5, 6, 7].every((c) => dmx[BLUE(c)] === 128 && dmx[RED(c)] === 0), 'half-bright blue on every cell');
  dmx = dmxAt(show, 1000, { master: 0.5 });
  assert.equal(dmx[BLUE(4)], 64, 'grand master scales the cells');
  dmx = dmxAt(show, 1000, { master: 1, blackout: true });
  assert.ok(dmx.slice(0, 26).every((v) => v === 0), 'blackout: master dimmer and every cell at 0');
  dmx = dmxAt(show, 1000, { master: 1, programmer: { attrs: { barL: { dimmer: 1, color: [1, 0, 0] } }, raw: {} } });
  assert.ok([0, 1, 2, 3, 4, 5, 6, 7].every((c) => dmx[RED(c)] === 255 && dmx[BLUE(c)] === 0), 'a fader on the bar sets all its cells');
});

test('a raw channel of one cell lights just that cell, in the 3D view too', () => {
  const show = rig();
  const ev = createEvaluator(show);
  const live = { master: 1, programmer: { attrs: {}, raw: { barL: { [RED(5)]: 200 } } } };
  const states = ev.evaluate(1000, live);
  assert.ok(states.get('barL#5').dimmer > 0.75);
  assert.equal(states.get('barL#4').dimmer, 0);
  const dmx = renderUniverses(ev, states, 1000).get(1);
  assert.equal(dmx[RED(5)], 200);
});

test('a rainbow spreads its hues along the cells', () => {
  const show = rig([{ id: 'r', type: 'colorCycle', fixtures: ['barL'], params: { cycle: 16, spread: 1, saturation: 1, order: 'x' } }, { id: 'd', type: 'static', track: 'trk_base', fixtures: ['barL'], params: { dimmer: 1 } }]);
  const ev = createEvaluator(show);
  const s = ev.evaluate(100, { master: 1 });
  const hues = new Set([0, 2, 4, 6].map((c) => s.get(`barL#${c}`).color.map((v) => v.toFixed(2)).join(',')));
  assert.equal(hues.size, 4, 'four different colours on four cells');
});

test('a bar without a master channel carries its intensity in the colours', () => {
  const show = rig([{ id: 's', type: 'static', track: 'trk_base', fixtures: ['bar16'], params: { dimmer: 0.25, color: [1, 1, 1] } }], [{ id: 'bar16', x: 0, profile: 'generic.pixelbar-16rgb' }]);
  const dmx = dmxAt(show, 1000);
  assert.equal(dmx.slice(0, 48).filter((v) => v === 64).length, 48, 'every channel at a quarter');
});

test('beam shapes: open, gobo patterns and the three-way prism', async () => {
  const { beamParts, goboPattern, GOBO_PATTERNS } = await import('../shared/beam-shapes.js');
  const down = [0, -1, 0];
  const angleBetween = (a, b) => (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;
  const open = beamParts(down, 20);
  assert.equal(open.length, 1);
  assert.deepEqual([open[0].angle, open[0].share, open[0].shaped], [20, 1, false]);
  // Slot 1 = dots: six narrow shafts in a ring inside the beam.
  const dots = beamParts(down, 20, 1);
  assert.equal(dots.length, 6);
  assert.ok(dots.every((p) => p.shaped && p.angle < 20 && Math.abs(angleBetween(p.dir, down) - 0.62 * 10) < 1e-6));
  assert.equal(goboPattern(0), null);
  assert.equal(goboPattern(GOBO_PATTERNS.length + 1), GOBO_PATTERNS[0], 'slots past the list repeat it');
  // A prism: three copies fanned 120 degrees apart, the same distance from the axis.
  const prism = beamParts(down, 20, 0, 1);
  assert.equal(prism.length, 3);
  const tilts = prism.map((p) => angleBetween(p.dir, down));
  assert.ok(tilts.every((t) => Math.abs(t - 12) < 1e-6), `${tilts}`);
  assert.ok(Math.abs(angleBetween(prism[0].dir, prism[1].dir) - angleBetween(prism[1].dir, prism[2].dir)) < 1e-6);
  // Gobo and prism together: the pattern three times.
  assert.equal(beamParts(down, 20, 2, 1).length, 3 * (3 + 1));
});

// A clip ordered 'center' groups its members into rings by distance from the middle of the
// selection. Finding that middle used to spread every member into Math.min/Math.max, which
// a clip over a large pixel rig overflows: createEvaluator threw, the frame loop caught it
// and retried for ever, and the engine stopped sending DMX altogether.

test("a 'center' chase lights rings outwards from the middle of the selection", () => {
  const show = createShow('Rings');
  applyOp(show, { type: 'tempo.set', changes: { bpm: 120, offset: 0, downbeat: 0 } });
  // Deliberately off-centre on stage: the middle is the middle of the selection, not of x = 0.
  [10, 11, 12, 13, 14].forEach((x, i) =>
    applyOp(show, { type: 'fixture.add', fixture: { id: `d${i}`, name: `d${i}`, profileId: 'generic.dimmer', universe: 1, address: 1 + i, position: { x, y: 3, z: 0 }, rotation: { x: 180, y: 0, z: 0 } } }),
  );
  applyOp(show, {
    type: 'clip.add',
    clip: { id: 'c', type: 'chase', track: 'trk_rhythm', start: 0, end: 60000, fixtures: ['d0', 'd1', 'd2', 'd3', 'd4'], params: { order: 'center', step: 1, direction: 'forward', width: 1, tail: 0, level: 1 } },
  });
  // Five fixtures one metre apart make three rings: the middle one, then each neighbour pair.
  const ev = createEvaluator(show);
  assert.equal(ev.clipCount, 1);
  const lit = (beat) => {
    const dmx = renderUniverses(ev, ev.evaluate(beat * 500 + 50, { master: 1 }), 0).get(1);
    return [0, 1, 2, 3, 4].filter((i) => dmx[i] > 200);
  };
  assert.deepEqual(lit(0), [2], 'beat 0: the middle fixture');
  assert.deepEqual(lit(1), [1, 3], 'beat 1: the pair one metre out');
  assert.deepEqual(lit(2), [0, 4], 'beat 2: the outer pair');
  assert.deepEqual(lit(3), [2], 'beat 3: back to the middle');
});

test("a 'center' clip over a pixel rig too large to spread still builds, so the engine keeps sending", () => {
  // 1024 fixtures (the per-clip limit) of 160 cells each: 163 840 members, well past the
  // ~100 000 arguments a spread call accepts.
  const CELLS = 160;
  const channels = [];
  for (let c = 0; c < CELLS; c++) for (const attr of ['red', 'green', 'blue']) channels.push({ attr, cell: c });
  const profile = { id: 'test.bigpixel', name: `Pixel ${CELLS}`, manufacturer: 'Test', kind: 'pixel', beamAngle: 60, length: 1, channels };
  assert.deepEqual(checkProfile(profile), []);
  const fixtures = [];
  for (let i = 0; i < 1024; i++) {
    fixtures.push({ id: `px${i}`, name: `px${i}`, profileId: profile.id, universe: 1 + i, address: 1, position: { x: (i % 64) * 0.25, y: 3, z: Math.floor(i / 64) * 0.25 }, rotation: { x: 0, y: 0, z: 0 }, group: '', calibration: { pan: 0, tilt: 0 } });
  }
  const show = {
    meta: { name: 'Huge pixel wall' },
    stage: { audience: { x: 0, y: 1.6, z: 8 } },
    profiles: [profile],
    fixtures,
    tempo: { bpm: 120 },
    scenes: [],
    audioReactive: { mappings: [] },
    timeline: {
      durationMs: 60000,
      tracks: [{ id: 't1', name: 'Track', muted: false }],
      clips: [{ id: 'c1', type: 'chase', track: 't1', start: 0, end: 60000, fadeIn: 0, fadeOut: 0, fixtures: fixtures.map((f) => f.id), params: { order: 'center', step: 1, direction: 'forward', width: 1, tail: 0, level: 1 } }],
    },
  };
  const ev = createEvaluator(show);
  assert.equal(ev.clipCount, 1, 'the clip is prepared rather than thrown away');
  assert.equal(ev.fixtures.length, 1024);
  // And it evaluates: 1024 fixtures x 160 cells of state, with the chase actually lighting some.
  const states = ev.evaluate(1000, { master: 1 });
  assert.equal(states.size, 1024 * (CELLS + 1));
  assert.ok([...states.values()].some((s) => s.dimmer > 0.5), 'the chase lights part of the wall');
});
