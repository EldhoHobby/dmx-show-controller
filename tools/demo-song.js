// Synthesizes "Neon Mile", the three-minute demo track: 128 BPM, A minor, club arrangement.
//
// This is a small software synth rather than a sample player, so the repository stays free of
// audio files and the track can be regenerated anywhere. It is deliberately more musical than
// tools/make-demo-audio.js (which stays as the fixed-structure fixture the analysis tests use):
// a chord progression, a bass line, an arpeggio and a lead melody over a 909-style kit, with
// sidechain ducking and a reverb send so the mix pumps the way a real club track does.
//
// The arrangement matters for lighting: each section has a clearly different energy, and the
// builds empty out just before the drops, which is what gives the generated show its arc.
//
//   node tools/demo-song.js            writes samples/neon-mile-128bpm.wav

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SR = 44100;
export const BPM = 128;
const BEAT = 60 / BPM;
const BAR = 4 * BEAT;
const TAIL_SEC = 2; // let the last chord and the reverb ring out past the final bar

export const SONG_STRUCTURE = [
  { name: 'intro', bars: 8 },
  { name: 'groove', bars: 8 },
  { name: 'build', bars: 8 },
  { name: 'drop', bars: 16 },
  { name: 'breakdown', bars: 8 },
  { name: 'groove', bars: 8 },
  { name: 'build', bars: 8 },
  { name: 'drop', bars: 16 },
  { name: 'outro', bars: 16 },
];

// A minor: i - VI - III - VII, one chord per bar. Semitones are relative to A4 (440 Hz), so
// the triads sit around the fourth octave and the bass two octaves below the chord root.
const PROGRESSION = [
  { name: 'Am', root: -12, tones: [-12, -9, -5] },
  { name: 'F', root: -16, tones: [-16, -12, -9] },
  { name: 'C', root: -9, tones: [-9, -5, -2] },
  { name: 'G', root: -14, tones: [-14, -10, -7] },
];

// The hook, over the four-bar progression: [beat, length in beats, semitones from A4].
const LEAD = [
  [0, 1, 7], [1.5, 0.5, 12], [2, 1, 10], [3, 1, 7],
  [4, 1, 5], [5.5, 0.5, 3], [6, 1.5, 7], [7.5, 0.5, 8],
  [8, 1, 10], [9.5, 0.5, 7], [10, 1, 3], [11, 1, 5],
  [12, 1.5, 2], [13.5, 0.5, 5], [14, 2, 10],
];

const hz = (semitones) => 440 * 2 ** (semitones / 12);

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

/** Band-limited step, so the saw oscillators do not alias into a buzz in the top octaves. */
function polyBlep(t, dt) {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

function sawOsc(phase0 = 0) {
  let phase = phase0;
  return (freq) => {
    const dt = freq / SR;
    phase += dt;
    if (phase >= 1) phase -= 1;
    return 2 * phase - 1 - polyBlep(phase, dt);
  };
}

/** Chamberlin state-variable low-pass; cutoff is read per sample so envelopes can sweep it. */
function lowpass(q = 1.1) {
  let low = 0;
  let band = 0;
  return (x, cutoff) => {
    const f = 2 * Math.sin((Math.PI * Math.min(cutoff, SR * 0.24)) / SR);
    low += f * band;
    band += f * (x - low - q * band);
    return low;
  };
}

function highpass(q = 1.0) {
  let low = 0;
  let band = 0;
  return (x, cutoff) => {
    const f = 2 * Math.sin((Math.PI * Math.min(cutoff, SR * 0.24)) / SR);
    low += f * band;
    const high = x - low - q * band;
    band += f * high;
    return high;
  };
}

const attackRelease = (t, dur, a, r) => Math.min(1, t / a) * Math.min(1, Math.max(0, (dur - t) / r));

// ---- Mix buses ------------------------------------------------------------------------
// Drums stay dry and un-ducked; everything melodic goes through the sidechain. The send bus
// is mono into the reverb, which spreads it back out across the stereo field.

function makeBus(n) {
  return [new Float32Array(n), new Float32Array(n)];
}

export function synthesizeSong({ seed = 7 } = {}) {
  const totalBars = SONG_STRUCTURE.reduce((s, x) => s + x.bars, 0);
  const musicSec = totalBars * BAR;
  const length = Math.ceil((musicSec + TAIL_SEC) * SR);
  const drums = makeBus(length);
  const music = makeBus(length);
  const send = new Float32Array(length); // reverb send, mono in
  const noise = rng(seed);

  /** Render a voice into a bus with constant-power panning. */
  const add = (bus, startSec, durSec, fn, { pan = 0, sendAmt = 0 } = {}) => {
    const s0 = Math.round(startSec * SR);
    const n = Math.round(durSec * SR);
    const l = Math.cos(((pan + 1) * Math.PI) / 4);
    const r = Math.sin(((pan + 1) * Math.PI) / 4);
    for (let i = 0; i < n; i++) {
      const j = s0 + i;
      if (j < 0 || j >= length) continue;
      const v = fn(i / SR);
      if (v === 0) continue;
      bus[0][j] += v * l;
      bus[1][j] += v * r;
      if (sendAmt) send[j] += v * sendAmt;
    }
  };

  // ---- Drums --------------------------------------------------------------------------

  const kickTimes = [];
  const kick = (t0, gain = 1) => {
    kickTimes.push(t0);
    const hp = highpass();
    add(drums, t0, 0.42, (t) => {
      // Pitch drops from 115 Hz to 48 Hz in about 30 ms: the thump plus the attack transient.
      const fEnd = 48;
      const fStart = 115;
      const tp = 0.03;
      const phase = 2 * Math.PI * (fEnd * t + (fStart - fEnd) * tp * (1 - Math.exp(-t / tp)));
      const body = Math.sin(phase) * Math.exp(-t / 0.15);
      const click = t < 0.006 ? hp(noise(), 3000) * 0.5 * (1 - t / 0.006) : 0;
      return gain * (body * 1.1 + click);
    });
  };

  const clap = (t0, gain = 1) => {
    const hp = highpass(0.9);
    const lp = lowpass(0.9);
    add(
      drums,
      t0,
      0.3,
      (t) => {
        // Three fast repeats then the body: that stutter is what makes it read as a clap.
        const rep = t < 0.03 ? (t % 0.01 < 0.005 ? 1 : 0.35) : 1;
        const env = t < 0.03 ? rep : Math.exp(-(t - 0.03) / 0.055);
        return gain * lp(hp(noise(), 1100), 7000) * env * 1.6;
      },
      { pan: 0.08, sendAmt: 0.22 * gain },
    );
  };

  const snare = (t0, gain = 1) => {
    const hp = highpass(0.9);
    add(drums, t0, 0.2, (t) => {
      const tone = (Math.sin(2 * Math.PI * 185 * t) + Math.sin(2 * Math.PI * 278 * t)) * 0.3;
      return gain * (hp(noise(), 900) * 1.2 + tone) * Math.exp(-t / 0.045);
    });
  };

  const hat = (t0, gain = 1, open = false) => {
    const hp = highpass(0.8);
    const decay = open ? 0.16 : 0.028;
    add(
      drums,
      t0,
      open ? 0.3 : 0.07,
      (t) => gain * hp(noise(), 7500) * Math.exp(-t / decay) * 0.9,
      { pan: open ? -0.25 : 0.18 },
    );
  };

  const crash = (t0, gain = 1) => {
    const hpL = highpass(0.7);
    const hpR = highpass(0.7);
    add(drums, t0, 2.2, (t) => gain * hpL(noise(), 4200) * Math.exp(-t / 0.75) * 0.5, { pan: -0.6, sendAmt: 0.3 * gain });
    add(drums, t0, 2.2, (t) => gain * hpR(noise(), 5200) * Math.exp(-t / 0.6) * 0.5, { pan: 0.6 });
  };

  // ---- Melodic voices -----------------------------------------------------------------

  const bass = (t0, dur, semi, gain = 1) => {
    const osc = sawOsc();
    const sub = sawOsc();
    const lp = lowpass(1.4);
    const f = hz(semi);
    add(music, t0, dur + 0.05, (t) => {
      const env = Math.min(1, t / 0.004) * Math.exp(-t / (dur * 0.7));
      // The filter closes as the note decays, which keeps the low end from turning to mud.
      const cutoff = 140 + 900 * Math.exp(-t / 0.09);
      const x = osc(f) * 0.7 + Math.sin(2 * Math.PI * f * 0.5 * t) * 0.5 + sub(f * 1.005) * 0.3;
      return gain * lp(x, cutoff) * env;
    });
  };

  const pad = (t0, dur, tones, gain = 1, cutoffFn = () => 1400) => {
    // Three detuned saws per chord tone, each voice panned a little differently: a wide,
    // slow bed that the sidechain can pump against.
    tones.forEach((semi, k) => {
      const f = hz(semi);
      const oscs = [sawOsc(0.1 * k), sawOsc(0.4 + 0.1 * k), sawOsc(0.7 + 0.1 * k)];
      const lp = lowpass(0.9);
      const pan = (k - (tones.length - 1) / 2) * 0.5;
      add(
        music,
        t0,
        dur,
        (t) => {
          const env = attackRelease(t, dur, 0.7, 0.9);
          const x = oscs[0](f) + oscs[1](f * 1.004) + oscs[2](f * 0.996);
          return (gain * lp(x, cutoffFn(t / dur)) * env) / 3;
        },
        { pan, sendAmt: gain * 0.3 },
      );
    });
  };

  const pluck = (t0, dur, semi, gain = 1, pan = 0) => {
    const osc = sawOsc();
    const lp = lowpass(1.6);
    const f = hz(semi);
    add(
      music,
      t0,
      Math.min(dur, 0.3),
      (t) => {
        const env = Math.min(1, t / 0.002) * Math.exp(-t / 0.07);
        return gain * lp(osc(f) + osc(f * 2.01) * 0.3, 500 + 4500 * Math.exp(-t / 0.05)) * env;
      },
      { pan, sendAmt: gain * 0.25 },
    );
  };

  const lead = (t0, dur, semi, gain = 1) => {
    // Supersaw: seven detuned voices spread across the stereo field.
    const f = hz(semi);
    const detunes = [-0.013, -0.008, -0.003, 0, 0.003, 0.008, 0.013];
    detunes.forEach((d, k) => {
      const osc = sawOsc(k * 0.137);
      const lp = lowpass(0.9);
      const pan = (k - 3) / 3.6;
      add(
        music,
        t0,
        dur + 0.12,
        (t) => {
          const env = attackRelease(t, dur + 0.12, 0.012, 0.11);
          return (gain * lp(osc(f * (1 + d)), 2200 + 1800 * Math.exp(-t / 0.2)) * env) / detunes.length;
        },
        { pan, sendAmt: (gain * 0.3) / detunes.length },
      );
    });
  };

  /** Noise sweep that rises over a build; the filter opening is what creates the tension. */
  const riser = (t0, dur, gain = 1) => {
    const hp = highpass(0.9);
    const lp = lowpass(0.8);
    add(
      music,
      t0,
      dur,
      (t) => {
        const p = t / dur;
        const n = lp(hp(noise(), 300 + 2600 * p ** 2), 1200 + 9000 * p ** 2);
        const tone = Math.sin(2 * Math.PI * (300 + 900 * p ** 3) * t) * 0.25 * p;
        return gain * (n * 1.4 + tone) * (0.2 + 0.8 * p ** 2);
      },
      { sendAmt: gain * 0.25 },
    );
  };

  /** Sub boom under a drop, so the first bar lands with weight. */
  const impact = (t0, gain = 1) => {
    add(music, t0, 1.6, (t) => {
      const f = 60 * Math.exp(-t / 0.5) + 32;
      return gain * Math.sin(2 * Math.PI * f * t) * Math.exp(-t / 0.4);
    });
  };

  // ---- Arrangement --------------------------------------------------------------------

  const chordAt = (bar) => PROGRESSION[bar % PROGRESSION.length];
  const sections = [];
  let bar = 0;

  for (let si = 0; si < SONG_STRUCTURE.length; si++) {
    const part = SONG_STRUCTURE[si];
    const startSec = bar * BAR;
    sections.push({ name: part.name, startMs: startSec * 1000, bars: part.bars });
    const next = SONG_STRUCTURE[si + 1];

    for (let b = 0; b < part.bars; b++) {
      const barStart = (bar + b) * BAR;
      const chord = chordAt(bar + b);
      const beatAt = (k) => barStart + k * BEAT;
      const progress = part.bars > 1 ? b / (part.bars - 1) : 1;
      const isLastBar = b === part.bars - 1;

      switch (part.name) {
        case 'intro': {
          // No kick at all: the first kick of the song should be the start of the groove.
          if (b % 4 === 0) pad(barStart, 4 * BAR, chord.tones, 0.16, (p) => 500 + 900 * p);
          if (b >= 2) for (let k = 0; k < 4; k++) hat(beatAt(k + 0.5), 0.1 + 0.05 * progress);
          // A quiet tick on the beat from halfway, so the beat tracker has the grid early.
          if (b >= 4) for (let k = 0; k < 4; k++) hat(beatAt(k), 0.05);
          if (b >= 6) {
            const tones = [...chord.tones, chord.tones[0] + 12];
            for (let k = 0; k < 4; k++) pluck(beatAt(k), BEAT, tones[[0, 2, 1, 3][k]] + 12, 0.09, (k - 1.5) / 3);
          }
          if (isLastBar) riser(barStart, BAR, 0.1);
          break;
        }

        case 'groove': {
          if (b % 4 === 0) pad(barStart, 4 * BAR, chord.tones, 0.17);
          // Deliberately well under the drop: the groove has to leave somewhere to go.
          for (let k = 0; k < 4; k++) {
            kick(beatAt(k), 0.52);
            hat(beatAt(k + 0.5), 0.1);
          }
          clap(beatAt(1), 0.26);
          clap(beatAt(3), 0.26);
          // Off-beat house bass, with the root on the downbeat.
          bass(barStart, BEAT * 0.45, chord.root, 0.26);
          for (let k = 0; k < 4; k++) bass(beatAt(k + 0.5), BEAT * 0.4, chord.root + (k === 2 ? 12 : 0), 0.21);
          if (b >= 4) {
            const tones = [...chord.tones, chord.tones[0] + 12];
            for (let k = 0; k < 8; k++) {
              const semi = tones[[0, 2, 1, 3, 2, 1, 3, 2][k]] + 12;
              pluck(beatAt(k * 0.5), BEAT * 0.5, semi, 0.11, ((k % 4) - 1.5) / 3);
            }
          }
          break;
        }

        case 'build': {
          const open = progress; // the pad filter opens as the build climbs
          if (b % 4 === 0) pad(barStart, 4 * BAR, chord.tones, 0.16, (p) => 700 + 4200 * (open + p * 0.25));
          // The kick and the bass leave early and the low end empties out: that hole is what
          // makes the drop land, and it is also what tells the analyser a drop follows.
          if (b < 5) for (let k = 0; k < 4; k++) kick(beatAt(k), 0.6 - 0.07 * b);
          if (b < 3) bass(barStart, BEAT * 0.45, chord.root, 0.3 * (1 - progress));
          // Snare roll: quarters, then eighths, then sixteenths, then a 32nd flourish.
          const div = progress < 0.4 ? 1 : progress < 0.7 ? 0.5 : progress < 0.95 ? 0.25 : 0.125;
          for (let k = 0; k < 4 / div; k++) {
            snare(barStart + k * div * BEAT, (0.1 + 0.3 * progress) * (div <= 0.25 ? 0.7 : 1));
          }
          if (b === 0) riser(barStart, part.bars * BAR, 0.22);
          if (isLastBar) {
            // Empty the last half-bar so the drop hits into silence.
            hat(beatAt(2), 0.2, true);
          }
          break;
        }

        case 'drop': {
          if (b % 4 === 0) pad(barStart, 4 * BAR, chord.tones, 0.15, () => 2600);
          if (b === 0 || b === 8) crash(barStart, 0.5);
          if (b === 0) impact(barStart, 0.5);
          for (let k = 0; k < 4; k++) {
            kick(beatAt(k), 1);
            hat(beatAt(k + 0.5), k === 3 ? 0.2 : 0.14, k === 3);
            hat(beatAt(k + 0.25), 0.06);
          }
          clap(beatAt(1), 0.55);
          clap(beatAt(3), 0.55);
          bass(barStart, BEAT * 0.45, chord.root, 0.62);
          for (let k = 0; k < 4; k++) {
            bass(beatAt(k + 0.5), BEAT * 0.4, chord.root + (k === 2 ? 12 : 0), 0.55);
          }
          // The hook plays through each four-bar cycle, an octave up in the second half.
          const cycleBar = b % 4;
          const octave = b >= 8 ? 12 : 0;
          for (const [beat, len, semi] of LEAD) {
            if (Math.floor(beat / 4) !== cycleBar) continue;
            lead(barStart + (beat % 4) * BEAT, len * BEAT, semi + octave, 0.2);
          }
          if (isLastBar) for (let k = 0; k < 4; k++) snare(beatAt(3 + k * 0.25), 0.18);
          break;
        }

        case 'breakdown': {
          if (b % 4 === 0) pad(barStart, 4 * BAR, chord.tones, 0.26, (p) => 900 + 1500 * p);
          if (b % 2 === 0) hat(beatAt(2.5), 0.07);
          // The hook returns stripped bare, which is the emotional centre of the track.
          if (b >= 2) {
            const cycleBar = b % 4;
            for (const [beat, len, semi] of LEAD) {
              if (Math.floor(beat / 4) !== cycleBar) continue;
              lead(barStart + (beat % 4) * BEAT, len * BEAT, semi, 0.13);
            }
          }
          if (b >= 6) snare(beatAt(3.5), 0.12 + 0.1 * (b - 6));
          if (isLastBar && next?.name !== 'build') riser(barStart, BAR, 0.14);
          break;
        }

        case 'outro': {
          // A clear wind-down rather than a second groove: the hook is gone, the kit thins
          // out bar by bar and the pad is left holding the last chord.
          const fade = Math.max(0, 1 - b / (part.bars - 1));
          if (b % 4 === 0) pad(barStart, 4 * BAR, chord.tones, 0.2 * (0.4 + 0.6 * fade));
          if (b < 8) {
            for (let k = 0; k < 4; k++) {
              kick(beatAt(k), 0.3 * fade + 0.06);
              if (b < 6) hat(beatAt(k + 0.5), 0.08 * fade);
            }
          }
          if (b < 4) {
            clap(beatAt(1), 0.22 * fade);
            clap(beatAt(3), 0.22 * fade);
            bass(barStart, BEAT * 0.45, chord.root, 0.3 * fade);
            for (let k = 0; k < 4; k++) bass(beatAt(k + 0.5), BEAT * 0.4, chord.root, 0.24 * fade);
          }
          break;
        }

        default:
          break;
      }
    }
    bar += part.bars;
  }

  // ---- Sidechain, reverb, master ------------------------------------------------------

  const duck = sidechainEnvelope(kickTimes, length);
  for (let i = 0; i < length; i++) {
    music[0][i] *= duck[i];
    music[1][i] *= duck[i];
    send[i] *= duck[i];
  }

  const wetL = schroeder(send, 0);
  const wetR = schroeder(send, 23);

  const out = makeBus(length);
  for (let i = 0; i < length; i++) {
    out[0][i] = drums[0][i] + music[0][i] + wetL[i] * 0.3;
    out[1][i] = drums[1][i] + music[1][i] + wetR[i] * 0.3;
  }

  // Soft limiter, then normalize so the file peaks just under full scale.
  let peak = 0;
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < length; i++) {
      const v = Math.tanh(out[c][i] * 1.1);
      out[c][i] = v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
  }
  const gain = peak > 0 ? 0.92 / peak : 1;
  for (let c = 0; c < 2; c++) for (let i = 0; i < length; i++) out[c][i] *= gain;

  return {
    channels: out,
    sampleRate: SR,
    durationMs: (length / SR) * 1000,
    bpm: BPM,
    truth: { bpm: BPM, sections, kicks: kickTimes.map((t) => t * 1000) },
  };
}

/** Pumping: every kick ducks the melodic bus, recovering over about a sixteenth of a bar. */
function sidechainEnvelope(kickTimes, length, depth = 0.62, tau = 0.13) {
  const env = new Float32Array(length).fill(1);
  const span = Math.round(0.5 * SR);
  for (const kt of kickTimes) {
    const s0 = Math.round(kt * SR);
    for (let i = 0; i < span; i++) {
      const j = s0 + i;
      if (j < 0 || j >= length) continue;
      const g = 1 - depth * Math.exp(-(i / SR) / tau);
      if (g < env[j]) env[j] = g;
    }
  }
  return env;
}

/** Schroeder reverb: four parallel comb filters into two allpasses. Cheap, and enough here. */
function schroeder(input, spread, { feedback = 0.84, damp = 0.22 } = {}) {
  const combs = [1557, 1617, 1491, 1422].map((d) => d + spread);
  const allpasses = [225, 556].map((d) => d + spread);
  const out = new Float32Array(input.length);
  for (const d of combs) {
    const buf = new Float32Array(d);
    let idx = 0;
    let store = 0;
    for (let i = 0; i < input.length; i++) {
      const y = buf[idx];
      store = y * (1 - damp) + store * damp;
      buf[idx] = input[i] + store * feedback;
      idx = idx + 1 === d ? 0 : idx + 1;
      out[i] += y;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] *= 0.25;
  for (const d of allpasses) {
    const buf = new Float32Array(d);
    let idx = 0;
    for (let i = 0; i < out.length; i++) {
      const x = out[i];
      const y = buf[idx];
      buf[idx] = x + y * 0.5;
      out[i] = y - x;
      idx = idx + 1 === d ? 0 : idx + 1;
    }
  }
  return out;
}

/** 16-bit interleaved stereo WAV. */
export function encodeWavStereo(channels, sampleRate) {
  const frames = channels[0].length;
  const bytes = frames * 2 * 2;
  const buf = Buffer.alloc(44 + bytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + bytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(2, 22); // stereo
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 4, 28); // byte rate
  buf.writeUInt16LE(4, 32); // block align
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(bytes, 40);
  let p = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < 2; c++) {
      const v = Math.max(-32768, Math.min(32767, Math.round(channels[c][i] * 32767)));
      buf.writeInt16LE(v, p);
      p += 2;
    }
  }
  return buf;
}

export const SONG_NAME = 'Neon Mile (128 BPM)';
export const SONG_FILE = 'neon-mile-128bpm.wav';

export function projectRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const song = synthesizeSong();
  const file = join(projectRoot(), 'samples', SONG_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, encodeWavStereo(song.channels, song.sampleRate));
  console.log(`Wrote ${file} (${(song.durationMs / 1000).toFixed(1)} s, ${song.bpm} BPM)`);
}
