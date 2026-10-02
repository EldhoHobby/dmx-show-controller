import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveDetector } from '../shared/analysis/live-detector.js';

// A synthetic drum loop at 120 BPM: kicks on every beat, snares on 2 and 4, hi-hats on the
// off-beats, over a low noise floor. Returns the signal and the true hit times.
function drumLoop(fs = 48000, seconds = 8) {
  const out = new Float32Array(fs * seconds);
  let seed = 7;
  const noise = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 4294967296) * 2 - 1;
  };
  for (let i = 0; i < out.length; i++) out[i] = 0.004 * noise();
  // Each sound gets a 5 ms fade-out so cutting it off does not itself sound like a hit.
  const add = (t0, dur, fn) => {
    const s0 = Math.round(t0 * fs);
    const len = Math.round(dur * fs);
    const fade = Math.round(0.005 * fs);
    for (let i = 0; i < len && s0 + i < out.length; i++) out[s0 + i] += fn(i / fs) * Math.min(1, (len - i) / fade);
  };
  const truth = { kick: [], snare: [], hat: [] };
  for (let beat = 0; beat < (seconds - 1) * 2; beat++) {
    const t = 0.5 + beat * 0.5;
    truth.kick.push(t);
    add(t, 0.4, (x) => 0.8 * Math.sin(2 * Math.PI * (55 * x + 40 * 0.02 * (1 - Math.exp(-x / 0.02)))) * Math.exp(-x / 0.15));
    if (beat % 2 === 1) {
      truth.snare.push(t);
      add(t, 0.3, (x) => (0.35 * noise() + 0.3 * Math.sin(2 * Math.PI * 220 * x)) * Math.exp(-x / 0.06));
    }
    truth.hat.push(t + 0.25);
    let prev = 0;
    add(t + 0.25, 0.08, (x) => {
      const w = noise();
      const hp = w - prev;
      prev = w;
      return 0.3 * hp * Math.exp(-x / 0.02);
    });
  }
  return { out, fs, truth };
}

function run(signal, fs) {
  const det = createLiveDetector(fs);
  const hits = { 0: [], 1: [], 2: [] };
  for (let i = 0; i < signal.length; i += 128) {
    const events = det.process(signal.subarray(i, i + 128));
    for (const e of events) hits[e.band].push(det.samples / fs); // reported at the end of the block
  }
  return { det, hits };
}

/** For each true time, the delay to the first detection after it (or Infinity). */
const delays = (truth, found) => truth.map((t) => Math.min(...found.filter((f) => f >= t - 0.002).map((f) => f - t)));

test('live detector separates kick, snare and hi-hat hits with low latency', (t) => {
  const { out, fs, truth } = drumLoop();
  const { det, hits } = run(out, fs);

  const kickDelay = delays(truth.kick, hits[0]);
  assert.ok(kickDelay.every((d) => d < 0.03), `every kick detected within 30 ms (worst ${(Math.max(...kickDelay) * 1000).toFixed(1)} ms)`);
  assert.equal(hits[0].length, truth.kick.length, 'one low-band hit per kick, none on hats or snares');

  const hatDelay = delays(truth.hat, hits[2]);
  assert.ok(hatDelay.every((d) => d < 0.02), `every hi-hat detected within 20 ms (worst ${(Math.max(...hatDelay) * 1000).toFixed(1)} ms)`);

  const snareDelay = delays(truth.snare, hits[1]);
  assert.ok(snareDelay.every((d) => d < 0.03), `every snare detected in the mid band within 30 ms`);
  // Once it has heard a snare (it adapts to the input level), the mid band ignores kick
  // clicks and hi-hat leakage: only snares.
  const settledMid = hits[1].filter((t) => t > 1.5);
  assert.equal(settledMid.length, truth.snare.filter((t) => t > 1.5).length, `mid hits after settling: ${settledMid}`);

  const median = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  const ms = (v) => (v * 1000).toFixed(1);
  t.diagnostic(`detection delay (median / worst): kick ${ms(median(kickDelay))} / ${ms(Math.max(...kickDelay))} ms, snare ${ms(median(snareDelay))} / ${ms(Math.max(...snareDelay))} ms, hi-hat ${ms(median(hatDelay))} / ${ms(Math.max(...hatDelay))} ms; tempo ${det.bpm()} BPM`);
  assert.ok(median(kickDelay) < 0.015, `median kick latency ${(median(kickDelay) * 1000).toFixed(1)} ms`);
  assert.ok(Math.abs(det.bpm() - 120) <= 1, `live tempo ${det.bpm()}`);
});

test('live detector stays quiet on steady noise and reports levels in 0..1', () => {
  const fs = 48000;
  const det = createLiveDetector(fs);
  let seed = 1;
  const block = new Float32Array(128);
  let hits = 0;
  for (let b = 0; b < (fs * 4) / 128; b++) {
    for (let i = 0; i < 128; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      block[i] = 0.1 * ((seed / 4294967296) * 2 - 1);
    }
    if (b > (fs * 0.5) / 128) hits += det.process(block).length; // ignore the first half second
    else det.process(block);
  }
  assert.ok(hits < 8, `steady noise should not look like drums (${hits} hits in 3.5 s)`);
  assert.ok(det.levels().every((v) => v >= 0 && v <= 1));
  assert.equal(det.bpm(), 0);
});
