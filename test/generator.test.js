// The drum pattern from song analysis, and how the show generator uses it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudio } from '../shared/analysis/analyze.js';
import { synthesizeDemo } from '../tools/make-demo-audio.js';
import { generateShow } from '../shared/autogen.js';
import { readGroove } from '../shared/looks.js';
import { createShow } from '../shared/show.js';
import { applyOp } from '../shared/ops.js';
import { validateShow } from '../shared/validate.js';
import { createEvaluator } from '../shared/evaluate.js';

const RIG = [
  ...[-4, -2, 2, 4].map((x, i) => ({ id: `par${i}`, name: `Par ${i + 1}`, profileId: 'generic.rgbw-7ch', universe: 1, address: 1 + i * 7, position: { x, y: 3, z: 0 } })),
  ...[-3, 3].map((x, i) => ({ id: `mh${i}`, name: `Mover ${i + 1}`, profileId: 'generic.wash-mover-14ch', universe: 1, address: 100 + i * 14, position: { x, y: 4, z: -1 }, rotation: { x: 180, y: 0, z: 0 } })),
  { id: 'strobe', name: 'Strobe', profileId: 'generic.strobe-2ch', universe: 1, address: 200, position: { x: 0, y: 4, z: -1 } },
];

function showFor(analysis, tempo) {
  const show = createShow('Generated');
  applyOp(show, { type: 'tempo.set', changes: tempo });
  applyOp(show, { type: 'analysis.set', analysis });
  applyOp(show, { type: 'timeline.setDuration', durationMs: Math.round(analysis.durationMs) });
  for (const fixture of RIG) applyOp(show, { type: 'fixture.add', fixture });
  return show;
}

// The synthetic demo track, analysed once for all the tests below.
const demo = synthesizeDemo({ bpm: 128, sampleRate: 22050 });
const A = analyzeAudio({ channels: [demo.samples], sampleRate: 22050 });
const demoShow = () => showFor(A, { bpm: A.bpm, beats: A.beats, downbeat: A.downbeat, beatsPerBar: 4 });
const beatsOf = (s) => A.beats.map((b, i) => [b, i]).filter(([b]) => b >= s.start && b < s.end).map(([, i]) => i);
const barPos = (i) => (((i - A.downbeat) % 4) + 4) % 4;

test('song analysis reads the drum pattern of each section', () => {
  assert.equal(A.version, 2);
  const grooves = A.sections.map((s) => [s.label, readGroove(A.drums, beatsOf(s), barPos)]);
  const kickOf = (label) => grooves.filter(([l]) => l === label).map(([, g]) => g.kick);
  assert.deepEqual(kickOf('intro'), ['none'], 'the intro has hi-hats and pads but no kick');
  assert.deepEqual(kickOf('breakdown'), ['none']);
  assert.deepEqual(kickOf('groove'), ['four']);
  assert.deepEqual(kickOf('drop'), ['four', 'four']);
  for (const [label, g] of grooves) {
    if (label === 'drop') {
      assert.ok(g.backbeat, 'claps on 2 and 4 in the drops');
      assert.ok(g.hats, 'off-beat hi-hats in the drops');
    }
    if (label === 'build') assert.ok(!g.backbeat, 'claps on every beat in a build are not a backbeat');
  }
  // It survives being saved in a show.
  assert.deepEqual(demoShow().analysis.drums.kick.slice(0, 64), A.drums.kick.slice(0, 64));
});

test('generated shows follow the drums, vary every phrase and validate cleanly', () => {
  const show = demoShow();
  const timeline = generateShow(show, { style: 'balanced' });
  applyOp(show, { type: 'timeline.set', timeline });
  const v = validateShow(show);
  assert.equal(v.errors + v.warnings, 0, JSON.stringify(v.issues));
  const inSection = (label, n = 0) => {
    const s = A.sections.filter((x) => x.label === label)[n];
    return timeline.clips.filter((c) => c.start >= s.start - 1 && c.start < s.end - 1);
  };
  const rhythm = (clips) => clips.filter((c) => c.track === 'trk_rhythm');
  // No beat pulses where there is no kick.
  for (const label of ['intro', 'breakdown']) {
    assert.ok(rhythm(inSection(label)).every((c) => c.type !== 'pulse' || c.params.division >= 4), `${label}: no beat-by-beat pulse`);
  }
  // Drops pulse on every kick, flick the hi-hats and flare the snares.
  const drop = inSection('drop');
  assert.ok(rhythm(drop).every((c) => c.type === 'pulse' && c.params.division === 1));
  assert.ok(drop.some((c) => c.track === 'trk_hats' && c.params.offset === 0.5), 'off-beat hi-hat flicks');
  assert.ok(drop.some((c) => c.track === 'trk_snare' && c.params.division === 2 && c.params.offset === 1), 'snare flares on 2 and 4');
  // The 16-bar drop is two phrases that do not look the same.
  const moves = drop.filter((c) => c.track === 'trk_move').map((c) => c.params.shape);
  assert.equal(moves.length, 2);
  assert.notEqual(moves[0], moves[1]);
  // Builds ramp up: brighter at the end than at the start, and white just before the drop.
  const build = inSection('build').find((c) => c.type === 'keyframes');
  assert.ok(build.params.keys.dimmer.at(-1).v > build.params.keys.dimmer[0].v);
  assert.deepEqual(build.params.keys.color.at(-1).v, [1, 1, 1]);
});

test('in a drop the hi-hat flicks land between the kicks on every other wash', () => {
  const show = demoShow();
  applyOp(show, { type: 'timeline.set', timeline: generateShow(show, { style: 'balanced' }) });
  const ev = createEvaluator(show);
  const drop = A.sections.find((s) => s.label === 'drop');
  const b = beatsOf(drop)[8];
  const off = (A.beats[b] + A.beats[b + 1]) / 2 + 15; // just after the off-beat
  const states = ev.evaluate(off);
  const flicked = ['par1', 'par3'].map((id) => states.get(id).dimmer);
  const steady = ['par0', 'par2'].map((id) => states.get(id).dimmer);
  assert.ok(Math.min(...flicked) > Math.max(...steady) + 0.15, `flicked ${flicked} vs ${steady}`);
});

// Hand-made analyses for patterns the demo track does not contain.
function synthetic({ bars = 16, label = 'groove', kick, snare = () => 0.1, hat = () => 0.1 }) {
  const beats = bars * 4;
  const durationMs = beats * 500;
  const analysis = {
    version: 2,
    durationMs,
    bpm: 120,
    confidence: 1,
    sections: [{ start: 0, end: durationMs, energy: 0.6, label }],
    drops: [],
    energy: Array(beats).fill(0.6),
    peaks: [],
    onsets: [],
    drums: { kick: Array.from({ length: beats }, (_, i) => kick(i)), snare: Array.from({ length: beats }, (_, i) => snare(i)), hat: Array.from({ length: beats }, (_, i) => hat(i)) },
  };
  return showFor(analysis, { bpm: 120, offset: 0, beatsPerBar: 4, downbeat: 0 });
}

test('half-time kicks get a pulse every two beats; a broken beat gets a chase', () => {
  const half = synthetic({ kick: (i) => (i % 4 === 0 || i % 4 === 2 ? 0.9 : 0) });
  const r1 = generateShow(half).clips.filter((c) => c.track === 'trk_rhythm');
  assert.ok(r1.length && r1.every((c) => c.type === 'pulse' && c.params.division === 2), JSON.stringify(r1.map((c) => c.params)));
  const broken = synthetic({ kick: (i) => ([0, 3, 6, 10, 13].includes(i % 16) ? 0.9 : 0) });
  const r2 = generateShow(broken).clips.filter((c) => c.track === 'trk_rhythm');
  assert.ok(r2.every((c) => c.type === 'chase'));
});

test('a drum fill at the end of a phrase gets a quick chase; a plain phrase end does not', () => {
  const fills = (i) => (i === 30 || i === 31 ? 0.9 : 0.1);
  const show = synthetic({ kick: () => 0.9, snare: fills, hat: fills });
  const fill = generateShow(show).clips.filter((c) => c.name === 'Fill');
  assert.equal(fill.length, 1);
  assert.equal(fill[0].start, 15500, 'the last beat of the first 8-bar phrase');
  assert.equal(fill[0].end, 16000);
  const plain = synthetic({ kick: () => 0.9 });
  assert.equal(generateShow(plain).clips.filter((c) => c.name === 'Fill').length, 0);
});

test('shows analysed before drum detection still generate, with section-based rhythms', () => {
  const show = synthetic({ kick: () => 0.9 });
  show.analysis.drums = null;
  const timeline = generateShow(show);
  const rhythm = timeline.clips.filter((c) => c.track === 'trk_rhythm');
  assert.ok(rhythm.length > 0 && rhythm.every((c) => c.type === 'chase'));
  assert.ok(!timeline.clips.some((c) => c.track === 'trk_hats' || c.track === 'trk_snare'));
});

test('a pulse offset moves the hits: every 2 beats, offset 1 = beats 2 and 4', () => {
  const show = createShow('Offset');
  applyOp(show, { type: 'tempo.set', changes: { bpm: 120, offset: 0, downbeat: 0 } });
  applyOp(show, { type: 'fixture.add', fixture: { id: 'p', name: 'P', profileId: 'generic.rgbw-7ch', universe: 1, address: 1 } });
  applyOp(show, { type: 'clip.add', clip: { id: 'c', type: 'pulse', track: 'trk_rhythm', start: 0, end: 8000, fixtures: ['p'], params: { division: 2, offset: 1, decay: 0.3, level: 1 } } });
  const ev = createEvaluator(show);
  const at = (beat) => ev.evaluate(beat * 500 + 1).get('p').dimmer;
  assert.ok(at(1) > 0.95 && at(3) > 0.95, 'hits on beats 2 and 4');
  assert.ok(at(0) < 0.05 && at(2) < 0.05, 'nothing on 1 and 3');
});
