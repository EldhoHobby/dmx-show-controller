// The live auto show: the generator's looks driven by the live tracker's snapshot.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createShow } from '../shared/show.js';
import { applyOp } from '../shared/ops.js';
import { createEvaluator } from '../shared/evaluate.js';
import { livePlan } from '../shared/live-show.js';

function rig() {
  const show = createShow('Auto');
  const add = (fixture) => applyOp(show, { type: 'fixture.add', fixture });
  [-3, -1, 1, 3].forEach((x, i) => add({ id: `par${i}`, name: `Par ${i}`, profileId: 'generic.rgbw-7ch', universe: 1, address: 1 + 7 * i, position: { x, y: 3, z: 0 } }));
  [-2, 2].forEach((x, i) => add({ id: `mh${i}`, name: `Mover ${i}`, profileId: 'generic.wash-mover-14ch', universe: 1, address: 40 + 14 * i, position: { x, y: 4, z: 0 }, rotation: { x: 180, y: 0, z: 0 } }));
  add({ id: 'strobe', name: 'Strobe', profileId: 'generic.strobe-2ch', universe: 1, address: 80, position: { x: 0, y: 4, z: 0 } });
  // A full white look on the timeline, to show that the auto show replaces it.
  applyOp(show, { type: 'clip.add', clip: { id: 'white', type: 'static', track: 'trk_base', start: 0, end: 600000, fixtures: ['par0', 'par1', 'par2', 'par3'], params: { dimmer: 1, color: [1, 1, 1] } } });
  return show;
}

/** A tracker snapshot at 120 BPM (500 ms beats) with beat 0 at t = 0. */
const snap = (over = {}) => ({
  period: 500, anchor: 0, anchorBeat: 0, barOffset: 0, bpm: 120, locked: true,
  section: 'groove', sectionSince: -100000, sectionBeat: -200, dropAt: null, returnAt: null, drops: 0,
  groove: { kick: 'four', backbeat: true, hats: true }, roll: 0.5, energy: 0.7, ...over,
});
const reactive = (auto, last = {}) => ({ last: { low: null, mid: null, high: null, ...last }, strength: { low: 1, mid: 1, high: 1 }, count: { low: 0, mid: 0, high: 0 }, env: { low: 0, mid: 0, high: 0, energy: 0 }, auto });
const washes = ['par0', 'par1', 'par2', 'par3'];
const mean = (states, list, key = 'dimmer') => list.reduce((s, id) => s + states.get(id)[key], 0) / list.length;

test('the drop hit: everything white and full on the drop, strobes going', () => {
  const ev = createEvaluator(rig());
  const now = 50000;
  const s = ev.evaluate(0, { master: 1, autoShow: true, reactive: reactive(snap({ section: 'drop', dropAt: now - 30, sectionSince: now - 30, sectionBeat: 100, drops: 1 })) }, now);
  for (const id of [...washes, 'mh0', 'mh1']) {
    assert.ok(s.get(id).dimmer > 0.9, `${id} ${s.get(id).dimmer}`);
    assert.ok(Math.min(...s.get(id).color) > 0.9, `${id} white`);
  }
  assert.ok(s.get('strobe').strobe > 0.5 && s.get('strobe').dimmer === 1);
});

test('the auto show replaces the timeline, and only while it is on', () => {
  const ev = createEvaluator(rig());
  const quiet = ev.evaluate(0, { master: 1, autoShow: true, reactive: reactive(snap({ section: 'quiet' })) }, 1000);
  assert.ok(mean(quiet, washes) < 0.3, `quiet look is dim, not the timeline's full white (${mean(quiet, washes)})`);
  const off = ev.evaluate(0, { master: 1, autoShow: false }, 1000);
  assert.equal(mean(off, washes), 1, 'the timeline plays when the auto show is off');
  // Switched on before any audio arrived: also the quiet look.
  const none = ev.evaluate(0, { master: 1, autoShow: true, reactive: null }, 1000);
  assert.ok(mean(none, washes) < 0.3);
});

test('in a drop the washes pulse on the real kick, not on a guess', () => {
  const ev = createEvaluator(rig());
  const now = 80000 + 125; // a quarter beat after a clock beat
  const auto = snap({ section: 'drop', dropAt: 10000, sectionSince: 10000, sectionBeat: 20 });
  const onKick = ev.evaluate(0, { master: 1, autoShow: true, reactive: reactive(auto, { low: now - 5 }) }, now);
  const noKick = ev.evaluate(0, { master: 1, autoShow: true, reactive: reactive(auto, { low: now - 3000 }) }, now);
  const steady = ['par0', 'par2']; // not the hi-hat flick washes
  assert.ok(mean(onKick, steady) > 0.9, `just after a kick: ${mean(onKick, steady)}`);
  assert.ok(mean(noKick, steady) < 0.35, `no kick lately: ${mean(noKick, steady)}`);
  // Snares flare the moving heads; hi-hats flick every other wash.
  const flare = ev.evaluate(0, { master: 1, autoShow: true, reactive: reactive(auto, { mid: now - 5 }) }, now);
  assert.ok(mean(flare, ['mh0', 'mh1']) > 0.9);
  const flick = ev.evaluate(0, { master: 1, autoShow: true, reactive: reactive(auto, { high: now - 5 }) }, now);
  assert.ok(mean(flick, ['par1', 'par3']) > mean(flick, ['par0', 'par2']) + 0.2);
});

test('a breakdown breathes on the beat clock and ignores stray kicks', () => {
  const ev = createEvaluator(rig());
  const auto = snap({ section: 'breakdown', groove: { kick: 'none', backbeat: false, hats: false } });
  const plan = livePlan(auto, {}, 60000);
  assert.equal(plan.kickPulse, false);
  assert.equal(plan.look.rhythm.params.division, 8, 'a slow breath every two bars');
  const a = ev.evaluate(0, { master: 1, autoShow: true, reactive: reactive(auto, { low: 59995 }) }, 60000);
  const b = ev.evaluate(0, { master: 1, autoShow: true, reactive: reactive(auto, { low: null }) }, 60000);
  assert.deepEqual(washes.map((id) => a.get(id).dimmer), washes.map((id) => b.get(id).dimmer));
});

test('the speed dial stretches the beat-clock effects without touching the drum hits', () => {
  const auto = snap({ section: 'groove', groove: { kick: 'none', backbeat: false, hats: true } });
  const at = (speed) => livePlan(auto, { speed }, 10000);
  const step = (p) => p.look.rhythm.params.step ?? p.look.rhythm.params.division;
  // Halving the speed doubles how long each step is held.
  assert.deepEqual([0.25, 0.5, 1, 2].map((s) => step(at(s))), [8, 4, 2, 1]);
  // The look depends on the rate, so the prepared-layer cache key has to as well — without
  // it the old speed keeps playing until something else happens to change the key.
  assert.equal(new Set([0.25, 0.5, 1, 2].map((s) => at(s).key)).size, 4, 'each speed gets its own key');
  // Out of range or nonsense falls back to something sane rather than a zero-length step.
  for (const bad of [0, -1, 99, NaN, undefined]) {
    assert.ok(step(at(bad)) > 0 && Number.isFinite(step(at(bad))), `speed ${bad}`);
  }
  // Pulses fire on the real drum, so the dial must not move them off the beat.
  const kicky = (speed) => livePlan(snap({ section: 'drop', groove: { kick: 'four', backbeat: true, hats: true } }), { speed }, 10000);
  assert.equal(kicky(0.25).kickPulse, kicky(2).kickPulse, 'kick-following is unchanged by the dial');
});

test('a build speeds its chase up with the snare roll and brings the strobes in', () => {
  const slow = livePlan(snap({ section: 'build', roll: 1 }), {}, 1000);
  const eighths = livePlan(snap({ section: 'build', roll: 2 }), {}, 1000);
  const sixteenths = livePlan(snap({ section: 'build', roll: 4 }), {}, 1000);
  assert.deepEqual([slow.build.step, eighths.build.step, sixteenths.build.step], [1, 0.5, 0.25]);
  assert.equal(sixteenths.build.strobe, true);
  const ev = createEvaluator(rig());
  const s = ev.evaluate(0, { master: 1, autoShow: true, reactive: reactive(snap({ section: 'build', roll: 4 })) }, 1000);
  assert.ok(s.get('strobe').strobe > 0.5);
});

test('every drop gets a new palette; phrases vary the look', () => {
  const p1 = livePlan(snap({ section: 'drop', drops: 1 }), {}, 0);
  const p2 = livePlan(snap({ section: 'drop', drops: 2 }), {}, 0);
  assert.notEqual(p1.paletteIndex, p2.paletteIndex);
  const early = livePlan(snap({ section: 'drop', sectionBeat: 0 }), {}, 1000);
  const later = livePlan(snap({ section: 'drop', sectionBeat: 0 }), {}, 33 * 500);
  assert.equal(early.phrase, 0);
  assert.equal(later.phrase, 1);
  assert.notEqual(early.look.move.params.shape, later.look.move.params.shape);
});
