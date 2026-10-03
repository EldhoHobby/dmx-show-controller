// The live beat clock and song-part tracker, on a synthetic DJ set (test/fixtures/dj-set.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveTracker, estimatePeriod, liveBeat } from '../shared/analysis/live-tracker.js';
import { djSet } from './fixtures/dj-set.js';
import { createLiveDetector } from '../shared/analysis/live-detector.js';
import { synthesizeDemo } from '../tools/make-demo-audio.js';

/**
 * Feed a set to a tracker the way the engine does: hits as they come, levels ~50 times a
 * second, an update every frame. Without measured levels (set.levels: [{ t, lv }]), the
 * input is steady while the set plays and silent before and after it.
 */
function run(set, { onKick, every } = {}) {
  const tr = createLiveTracker();
  const sections = [];
  let h = 0;
  let l = 0;
  const first = set.hits[0]?.t ?? 0;
  for (let t = 0; t < set.end + 4000; t += 25) {
    while (h < set.hits.length && set.hits[h].t <= t) {
      const e = set.hits[h++];
      if (e.band === 0 && onKick && tr.period) onKick(e.t, tr.snapshot(e.t));
      tr.hit(e.band, e.t);
    }
    if (set.levels) {
      while (l < set.levels.length && set.levels[l].t <= t) tr.levels(set.levels[l].lv, set.levels[l++].t);
    } else tr.levels(t >= first - 100 && t <= set.end ? [0.5, 0.5, 0.5, 0.6] : [0, 0, 0, 0], t);
    tr.update(t);
    const s = tr.snapshot(t);
    if (sections.at(-1)?.name !== s.section) sections.push({ name: s.section, t });
    every?.(t, s);
  }
  return { tr, sections };
}

const mod = (n, m) => ((n % m) + m) % m;

for (const [bpm, jitter] of [[126, 3], [174, 5], [100, 8]]) {
  test(`live tracker follows a ${bpm} BPM set with ±${jitter} ms timing`, () => {
    const set = djSet({ bpm, jitter });
    const errors = [];
    let atDrop = null;
    let inDrop = null;
    const drop = set.parts.find((p) => p.name === 'drop');
    const back = set.parts.at(-1);
    const { tr, sections } = run(set, {
      onKick: (t, s) => {
        const b = liveBeat(s, t);
        if (t > set.parts[0].start + 4000) errors.push(Math.abs(b - Math.round(b)) * s.period);
      },
      every: (t, s) => {
        if (!atDrop && s.dropAt != null) atDrop = s;
        if (!inDrop && t > drop.start + 3 * 4 * set.P) inDrop = s;
      },
    });

    assert.deepEqual(
      sections.map((x) => x.name),
      ['quiet', 'groove', 'breakdown', 'groove', 'build', 'drop', 'high', 'breakdown', 'groove', 'breakdown', 'quiet'],
    );
    // The drop lands on its first kick, as bar 1 of a phrase, at the right tempo.
    assert.ok(Math.abs(atDrop.dropAt - drop.start) < 40, `drop at ${atDrop.dropAt - drop.start} ms from the truth`);
    assert.ok(Math.abs(atDrop.bpm - bpm) < 0.5, `tempo ${atDrop.bpm}`);
    assert.equal(mod(Math.round(liveBeat(atDrop, atDrop.dropAt)) - atDrop.barOffset, 4), 0);
    assert.equal(atDrop.sectionBeat, Math.round(liveBeat(atDrop, atDrop.dropAt)));
    // The beat clock: kicks land on its beats, including the first ones after 8 bars without a kick.
    const sorted = errors.slice().sort((a, b) => a - b);
    assert.ok(sorted.at(-1) < 3 * jitter + 6, `worst kick ${sorted.at(-1).toFixed(1)} ms off the clock`);
    assert.ok(sorted[sorted.length >> 1] < jitter + 3, `median ${sorted[sorted.length >> 1].toFixed(1)} ms`);
    // The drums in the drop: four on the floor, snares on 2 and 4, off-beat hi-hats.
    assert.deepEqual({ ...inDrop.groove, kickRate: undefined }, { kick: 'four', backbeat: true, hats: true, kickRate: undefined });
    // The kick coming back without a build is a return, not a second drop.
    const final = tr.snapshot(set.end + 4000);
    assert.equal(final.drops, 1);
    assert.ok(Math.abs(final.returnAt - back.start) < 40, `return at ${final.returnAt - back.start} ms`);
  });
}

test('tempo from kick gaps folds doubles and halves, and refuses an irregular beat', () => {
  const at = (n, p) => Array.from({ length: n }, (_, i) => 1000 + i * p);
  assert.ok(Math.abs(estimatePeriod(at(8, 500)) - 500) < 0.01);
  assert.ok(Math.abs(estimatePeriod(at(8, 1000)) - 500) < 0.01, 'kicks every other beat: same tempo, 120 BPM');
  assert.ok(Math.abs(estimatePeriod(at(8, 250)) - 500) < 0.01, '16th-note kicks fold down');
  assert.equal(estimatePeriod([0, 500, 800, 1700, 1900, 2950, 3100, 4200]), 0);
  assert.equal(estimatePeriod(at(4, 500)), 0, 'needs four gaps');
});

test('the clock follows the DJ speeding up from 120 to 128 BPM without a false drop', () => {
  const hits = [];
  let t = 1000;
  for (let b = 0; b < 32; b++, t += 500) hits.push({ t, band: 0 });
  for (let b = 0; b < 48; b++, t += 468.75) hits.push({ t, band: 0 });
  const set = { hits, end: t, parts: [] };
  const { tr, sections } = run(set);
  const s = tr.snapshot(t - 1);
  assert.ok(Math.abs(s.bpm - 128) < 0.5, `tempo ${s.bpm}`);
  assert.deepEqual(sections.map((x) => x.name).slice(0, 2), ['quiet', 'groove']);
  assert.ok(!sections.some((x) => x.name === 'drop' || x.name === 'build'));
  const b = liveBeat(s, hits.at(-1).t);
  assert.ok(Math.abs(b - Math.round(b)) * s.period < 10, 'back on the beat');
});

test('a syncopated beat (3-3-2 kicks, claps on every beat) keeps the clock on the beat, with no false build or drop', () => {
  // Kuthu and other Indian dance beats: the kick plays 3+3+2 sixteenths across two beats, so
  // its gaps never agree on a tempo. The claps, the hi-hats and the way it all repeats do.
  const bpm = 118;
  const P = 60000 / bpm;
  let seed = 11;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const j = () => (rnd() * 2 - 1) * 5;
  const hits = [];
  const start = 1000;
  const beats = 160;
  for (let b = 0; b < beats; b++) {
    const t = start + b * P;
    if (b % 2 === 0) hits.push({ t: t + j(), band: 0 }, { t: t + 0.75 * P + j(), band: 0 });
    else hits.push({ t: t + 0.5 * P + j(), band: 0 });
    hits.push({ t: t + j(), band: 1 });
    if (rnd() < 0.5) hits.push({ t: t + 0.5 * P + j(), band: 2 });
  }
  hits.sort((a, b) => a.t - b.t);
  const off = [];
  const { tr, sections } = run({ hits, end: start + beats * P }, {
    every: (t, s) => {
      // From 12 s in, every true beat should sit on the clock (checked as it is predicted).
      if (t < start + 12000 || t > start + (beats - 2) * P || !s.period) return;
      const truth = start + Math.round((t - start) / P) * P;
      if (Math.abs(truth - t) < 12.5) {
        const b = liveBeat(s, truth);
        off.push(Math.abs(b - Math.round(b)) * s.period);
      }
    },
  });
  const s = tr.snapshot(start + (beats - 1) * P);
  assert.ok(Math.abs(s.bpm - bpm) < 1, `tempo ${s.bpm}`);
  const within = off.filter((d) => d < 30).length / off.length;
  assert.ok(within > 0.95, `${Math.round(within * 100)}% of beats within 30 ms of the clock`);
  assert.equal(s.drops, 0);
  assert.ok(!sections.some((x) => x.name === 'build' || x.name === 'drop'), sections.map((x) => x.name).join(' '));
});

test('quiet when the input stops; no tempo, no hits: nothing pretends to play', () => {
  const tr = createLiveTracker();
  tr.update(0);
  assert.equal(tr.snapshot(0).section, 'quiet');
  assert.equal(liveBeat(tr.snapshot(0), 1000), null);
  // Music without a kick for two seconds is a breakdown, not a groove.
  for (let t = 0; t <= 3000; t += 250) tr.hit(2, t);
  tr.update(3000);
  assert.equal(tr.snapshot(3000).section, 'breakdown');
});

test('the demo song through the real live detector: both drops caught on the beat', () => {
  // The detector's hits are messier than the synthetic set: the kick's click also lands in
  // the snare band, the drop's off-beat bass in the kick band, and the build's claps are too
  // quiet to register. The drops must still be found, on the beat, and nothing else.
  const fs = 48000;
  const demo = synthesizeDemo({ bpm: 128, sampleRate: fs });
  const det = createLiveDetector(fs);
  const hits = [];
  const levels = [];
  const peak = [0, 0, 0, 0];
  for (let i = 0, block = 1; i < demo.samples.length; i += 128, block++) {
    for (const e of det.process(demo.samples.subarray(i, i + 128))) hits.push({ t: (det.samples / fs) * 1000, band: e.band });
    // Levels as the audio worklet reports them: the peak of every 7 blocks.
    det.levels().forEach((v, b) => (peak[b] = Math.max(peak[b], v)));
    if (block % 7 === 0) {
      levels.push({ t: (det.samples / fs) * 1000, lv: peak.slice() });
      peak.fill(0);
    }
  }
  const drops = [];
  const { tr } = run({ hits, levels, end: demo.durationMs }, {
    every: (t, s) => {
      if (s.dropAt != null && drops.at(-1) !== s.dropAt) drops.push(s.dropAt);
    },
  });
  const truth = demo.truth.sections.filter((x) => x.name === 'drop').map((x) => x.startMs);
  assert.equal(drops.length, truth.length, `drops at ${drops}`);
  drops.forEach((d, i) => assert.ok(Math.abs(d - truth[i]) < 60, `drop ${i + 1} ${(d - truth[i]).toFixed(0)} ms from the truth`));
  assert.ok(Math.abs(tr.snapshot(demo.durationMs).bpm - 128) < 0.5);
});
