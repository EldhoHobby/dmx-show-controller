import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudio } from '../shared/analysis/analyze.js';
import { synthesizeDemo, DEMO_STRUCTURE } from '../tools/make-demo-audio.js';
import { generateShow } from '../shared/autogen.js';
import { createShow } from '../shared/show.js';
import { applyOp } from '../shared/ops.js';
import { validateShow } from '../shared/validate.js';
import { createEvaluator } from '../shared/evaluate.js';

const cases = [
  { bpm: 128, sampleRate: 44100, leadInMs: 333 },
  { bpm: 174, sampleRate: 44100, leadInMs: 120 },
  // Past the point where a preference for ~120 BPM used to flip the reading to half time.
  { bpm: 185, sampleRate: 44100, leadInMs: 0 },
  { bpm: 100, sampleRate: 48000, leadInMs: 50 },
];

test('a track that is mostly digital silence still reads its tempo', () => {
  // A window with no energy at all, in a song whose median window also has none, used to
  // normalize by 1/0 = Infinity. Every score became NaN, no comparison was ever true, and
  // the tempo path backtraced to the bottom of the search range (60 BPM).
  const demo = synthesizeDemo({ sampleRate: 22050, bpm: 128 });
  const silence = new Float32Array(demo.samples.length * 2); // two thirds of the file silent
  const padded = new Float32Array(silence.length + demo.samples.length);
  padded.set(demo.samples, silence.length);
  const a = analyzeAudio({ channels: [padded], sampleRate: 22050 });
  assert.ok(Math.abs(a.bpm - 128) < 1, `tempo ${a.bpm} (should not collapse to the slowest tempo)`);
});

for (const c of cases) {
  test(`analysis of a ${c.bpm} BPM track at ${c.sampleRate} Hz`, () => {
    const demo = synthesizeDemo(c);
    const a = analyzeAudio({ channels: [demo.samples], sampleRate: c.sampleRate });

    assert.ok(Math.abs(a.bpm - c.bpm) < 0.2, `tempo ${a.bpm}`);
    assert.equal(a.steadyTempo, true);

    // Every kick drum should have a grid beat within 15 ms.
    const worst = Math.max(...demo.truth.kicks.map((k) => Math.min(...a.beats.map((b) => Math.abs(b - k)))));
    assert.ok(worst < 15, `worst beat error ${worst.toFixed(1)} ms`);

    // The downbeat must start bars where the song's bars start.
    const beatMs = 60000 / c.bpm;
    const phase = (((a.beats[a.downbeat] - c.leadInMs) / beatMs) % 4 + 4) % 4;
    assert.ok(phase < 0.1 || phase > 3.9, `downbeat phase ${phase}`);

    // Both drops found, each within one beat of the truth.
    const truthDrops = demo.truth.sections.filter((s) => s.name === 'drop').map((s) => s.startMs);
    assert.equal(a.drops.length, truthDrops.length, `drops ${a.drops}`);
    truthDrops.forEach((d, i) => assert.ok(Math.abs(a.drops[i] - d) < beatMs, `drop ${i}: ${a.drops[i]} vs ${d}`));

    // Section labels in order.
    assert.deepEqual(a.sections.map((s) => s.label), DEMO_STRUCTURE.map((s) => s.name));
    assert.equal(a.peaks.length, 2048);
    assert.equal(a.energy.length, a.beats.length);
  });
}

test('a mashup that changes tempo gets a beat grid that follows both songs', () => {
  // DJ mashups and dance medleys change tempo between songs: 24 bars of the demo at 118 BPM
  // spliced to 24 bars of it at 128 BPM, each from its groove on (kick, claps, hi-hats).
  const fs = 22050;
  const part = (bpm) => {
    const demo = synthesizeDemo({ bpm, sampleRate: fs });
    const barMs = 240000 / bpm;
    const [from, to] = [8 * barMs, 32 * barMs];
    const samples = demo.samples.subarray(Math.round((from / 1000) * fs), Math.round((to / 1000) * fs));
    return { samples, kicks: demo.truth.kicks.filter((k) => k >= from && k < to).map((k) => k - from) };
  };
  const [a, b] = [part(118), part(128)];
  const samples = new Float32Array(a.samples.length + b.samples.length);
  samples.set(a.samples);
  samples.set(b.samples, a.samples.length);
  const splice = (a.samples.length / fs) * 1000;
  const kicks = [...a.kicks, ...b.kicks.map((k) => k + splice)];

  const r = analyzeAudio({ channels: [samples], sampleRate: fs });
  assert.equal(r.steadyTempo, false);
  assert.equal(r.tempos.length, 2, JSON.stringify(r.tempos));
  assert.ok(Math.abs(r.tempos[0].bpm - 118) < 0.3 && Math.abs(r.tempos[1].bpm - 128) < 0.3, JSON.stringify(r.tempos));
  assert.ok(Math.abs(r.tempos[1].start - splice) < 3000, `tempo change at ${r.tempos[1].start} ms, splice at ${splice} ms`);
  // Every kick has a grid beat within 15 ms, right up to the splice and from it on.
  const worst = Math.max(...kicks.map((k) => Math.min(...r.beats.map((x) => Math.abs(x - k)))));
  assert.ok(worst < 15, `worst beat error ${worst.toFixed(1)} ms`);
  // No doubled or dropped beat where the songs meet.
  const gaps = r.beats.slice(1).map((t, i) => t - r.beats[i]);
  assert.ok(Math.min(...gaps) > 0.9 * (60000 / 128) && Math.max(...gaps) < 1.1 * (60000 / 118), `beat gaps ${Math.min(...gaps)}-${Math.max(...gaps)} ms`);
});

test('analysis refuses audio that is too short', () => {
  assert.throws(() => analyzeAudio({ channels: [new Float32Array(1000)], sampleRate: 44100 }), /too short/);
});

test('auto-generated show validates cleanly and lights the drops', () => {
  const demo = synthesizeDemo({ bpm: 128, sampleRate: 22050 });
  const a = analyzeAudio({ channels: [demo.samples], sampleRate: 22050 });
  const show = createShow('Generated');
  applyOp(show, { type: 'tempo.set', changes: { bpm: a.bpm, beats: a.beats, downbeat: a.downbeat, beatsPerBar: 4 } });
  applyOp(show, { type: 'analysis.set', analysis: a });
  applyOp(show, { type: 'timeline.setDuration', durationMs: Math.round(a.durationMs) });
  const fixtures = [
    ...[-4, -2, 2, 4].map((x, i) => ({ id: `par${i}`, name: `Par ${i + 1}`, profileId: 'generic.rgbw-7ch', universe: 1, address: 1 + i * 7, position: { x, y: 3, z: 0 } })),
    ...[-3, 3].map((x, i) => ({ id: `mh${i}`, name: `Mover ${i + 1}`, profileId: 'generic.wash-mover-14ch', universe: 1, address: 100 + i * 14, position: { x, y: 4, z: -1 }, rotation: { x: 180, y: 0, z: 0 } })),
    { id: 'strobe', name: 'Strobe', profileId: 'generic.strobe-2ch', universe: 1, address: 200, position: { x: 0, y: 4, z: -1 } },
  ];
  for (const f of fixtures) applyOp(show, { type: 'fixture.add', fixture: f });

  const timeline = generateShow(show, { style: 'energetic' });
  applyOp(show, { type: 'timeline.set', timeline });
  assert.ok(show.timeline.clips.length > 30, `${show.timeline.clips.length} clips`);
  for (const c of show.timeline.clips) {
    assert.ok(c.start >= 0 && c.end <= show.timeline.durationMs + 1, 'clips stay inside the song');
  }
  const v = validateShow(show, { routedUniverses: new Set([1]) });
  assert.equal(v.errors, 0, JSON.stringify(v.issues.filter((i) => i.level === 'error')));
  assert.deepEqual(v.issues.map((i) => i.code), [], 'a generated show has no warnings either');

  // At the first drop everything flashes, and the strobe unit fires.
  const ev = createEvaluator(show);
  const drop = a.drops[0];
  const atDrop = ev.evaluate(drop + 50);
  assert.ok(atDrop.get('par0').dimmer > 0.9, 'drop hit');
  assert.ok(atDrop.get('strobe').strobe > 0.5, 'strobe fires on the drop');
  // In the intro the strobe is dark.
  assert.equal(ev.evaluate(2000).get('strobe').dimmer, 0);
  // Same input, same show.
  const again = generateShow(show, { style: 'energetic' });
  assert.equal(again.clips.length, timeline.clips.length);
});
