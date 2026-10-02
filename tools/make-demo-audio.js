// Synthesizes a club-style demo track with a known structure, for testing the analysis and
// for trying the app without your own music. Writes samples/demo-128bpm.wav when run directly:
//   node tools/make-demo-audio.js
//
// The structure is the ground truth the tests check against.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEMO_STRUCTURE = [
  { name: 'intro', bars: 8 },
  { name: 'groove', bars: 8 },
  { name: 'build', bars: 8 },
  { name: 'drop', bars: 16 },
  { name: 'breakdown', bars: 8 },
  { name: 'build', bars: 4 },
  { name: 'drop', bars: 8 },
  { name: 'outro', bars: 4 },
];

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

export function synthesizeDemo({ sampleRate = 22050, bpm = 128, leadInMs = 0 } = {}) {
  const beatSec = 60 / bpm;
  const totalBars = DEMO_STRUCTURE.reduce((s, x) => s + x.bars, 0);
  const lead = Math.round((leadInMs / 1000) * sampleRate);
  const length = lead + Math.ceil(totalBars * 4 * beatSec * sampleRate) + sampleRate;
  const out = new Float32Array(length);
  const noise = rng(42);
  const add = (startSec, durSec, fn) => {
    const s0 = lead + Math.round(startSec * sampleRate);
    const n = Math.round(durSec * sampleRate);
    for (let i = 0; i < n && s0 + i < length; i++) out[s0 + i] += fn(i / sampleRate);
  };
  const kick = (t0, gain) =>
    add(t0, 0.35, (t) => {
      const f = 50 + 100 * Math.exp(-t / 0.03);
      const phase = 2 * Math.PI * (50 * t + (100 * 0.03) * (1 - Math.exp(-t / 0.03)));
      return gain * Math.sin(phase) * Math.exp(-t / 0.12) + (t < 0.002 ? gain * 0.3 * noise() : 0) + 0 * f;
    });
  const hat = (t0, gain) => {
    let prev = 0;
    add(t0, 0.06, (t) => {
      const n = noise();
      const hp = n - prev;
      prev = n;
      return gain * hp * Math.exp(-t / 0.015);
    });
  };
  const clap = (t0, gain) =>
    add(t0, 0.25, (t) => gain * (0.7 * noise() + 0.3 * Math.sin(2 * Math.PI * 200 * t)) * Math.exp(-t / 0.06));
  const bass = (t0, dur, gain, freq = 55) => {
    let lp = 0;
    add(t0, dur, (t) => {
      const saw = 2 * ((freq * t) % 1) - 1;
      lp += 0.08 * (saw - lp);
      return gain * lp * Math.min(1, t / 0.005) * Math.exp(-t / (dur * 0.6));
    });
  };
  const pad = (t0, dur, gain) =>
    add(t0, dur, (t) => {
      const env = Math.min(1, t / 0.5) * Math.min(1, (dur - t) / 0.5);
      const chord = [220, 261.63, 329.63, 440].reduce((s, f, k) => s + Math.sin(2 * Math.PI * (f + k * 0.7) * t), 0);
      return (gain * env * chord) / 4;
    });
  const sweep = (t0, dur, gain) =>
    add(t0, dur, (t) => gain * (t / dur) ** 2 * noise());

  let bar = 0;
  const truth = { sections: [], kicks: [], bpm, leadInMs };
  for (const part of DEMO_STRUCTURE) {
    const startSec = bar * 4 * beatSec;
    truth.sections.push({ name: part.name, startMs: leadInMs + startSec * 1000, bars: part.bars });
    const beats = part.bars * 4;
    for (let b = 0; b < beats; b++) {
      const t = startSec + b * beatSec;
      const inLastBar = b >= beats - 4;
      switch (part.name) {
        case 'intro':
          hat(t + beatSec / 2, 0.12);
          if (b % 16 === 0) pad(t, 16 * beatSec, 0.08);
          break;
        case 'groove':
          kick(t, 0.55);
          truth.kicks.push(leadInMs + t * 1000);
          hat(t + beatSec / 2, 0.15);
          if (b % 2 === 1) clap(t, 0.12);
          if (b % 16 === 0) pad(t, 16 * beatSec, 0.07);
          break;
        case 'build': {
          const progress = b / beats;
          if (!inLastBar) {
            kick(t, 0.5);
            truth.kicks.push(leadInMs + t * 1000);
          }
          const hitsPerBeat = progress < 0.5 ? 1 : progress < 0.75 ? 2 : 4;
          for (let h = 0; h < hitsPerBeat; h++) clap(t + (h * beatSec) / hitsPerBeat, 0.08 + 0.2 * progress);
          if (b === 0) sweep(t, beats * beatSec, 0.25);
          break;
        }
        case 'drop':
          kick(t, 0.9);
          truth.kicks.push(leadInMs + t * 1000);
          bass(t + beatSec / 2, beatSec / 2, 0.55);
          hat(t + beatSec / 2, 0.25);
          hat(t + beatSec / 4, 0.1);
          if (b % 2 === 1) clap(t, 0.3);
          if (b % 16 === 0) pad(t, 16 * beatSec, 0.1);
          break;
        case 'breakdown':
          if (b % 16 === 0) pad(t, 16 * beatSec, 0.12);
          if (b % 2 === 0) hat(t + beatSec / 2, 0.06);
          break;
        case 'outro':
          kick(t, 0.45);
          truth.kicks.push(leadInMs + t * 1000);
          hat(t + beatSec / 2, 0.1);
          break;
        default:
          break;
      }
    }
    bar += part.bars;
  }
  // Soft limiter so peaks stay inside [-1, 1].
  for (let i = 0; i < length; i++) out[i] = Math.tanh(out[i] * 1.2) * 0.9;
  return { samples: out, sampleRate, truth, durationMs: (length / sampleRate) * 1000 };
}

export function encodeWav(samples, sampleRate) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  }
  return buf;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { samples, sampleRate, durationMs } = synthesizeDemo({ sampleRate: 22050 });
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const file = join(root, 'samples', 'demo-128bpm.wav');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, encodeWav(samples, sampleRate));
  console.log(`Wrote ${file} (${(durationMs / 1000).toFixed(1)} s, 128 BPM)`);
}
