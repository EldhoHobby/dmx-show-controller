// Song analysis: tempo, beat grid, downbeats, energy, sections and drops.
//
// Pipeline
//   1. mix to mono and decimate to ~22 kHz
//   2. STFT (1024/256) -> log-magnitude spectral flux per band, loudness per frame
//   3. tempo through the song (tempo-map.js): autocorrelation in 8 s windows with a broad
//      preference for 120 BPM, joined into a path that holds steady but follows a real change
//      (mashups and medleys change tempo between songs)
//   4. beats: dynamic-programming beat tracker (Ellis 2007) following that tempo, then
//      regularized: each steady stretch gets an exact least-squares grid, a drifting one
//      keeps the tracked beats
//   5. downbeat phase from where energy changes land (phrases change on bar lines)
//   6. sections from bar-level novelty, snapped to 4/8-bar phrases; labelled by energy
//   7. drum pattern per beat: kick and snare on the beat, hi-hat on the off-beat
//
// Runs in a Web Worker in the browser and directly in Node for tests. Pure JS, no DOM.

import { createFFT, hannWindow } from './fft.js';
import { tempoMap } from './tempo-map.js';
import { clamp, median } from '../util.js';

export const ANALYSIS_VERSION = 3;

const FFT_SIZE = 1024;
const HOP = 256;
const TARGET_RATE = 22050;
const BANDS = { low: [30, 150], high: [2000, 9000] };
// Band flux peaks a few ms before the transient; measured on synthetic kicks at 100-174 BPM
// (beats came out 1-6 ms early before this correction).
const ONSET_LATENCY_MS = 4;

export function analyzeAudio(input, options = {}) {
  const onProgress = options.onProgress || (() => {});
  const { channels, sampleRate } = input;
  if (!channels?.length || !(sampleRate > 0)) throw new Error('No audio data to analyse.');
  const durationMs = (channels[0].length / sampleRate) * 1000;
  if (durationMs < 5000) throw new Error('The audio is too short to analyse (at least 5 seconds needed).');

  onProgress(0.02, 'Mixing down');
  const { mono, rate } = mixDown(channels, sampleRate);
  const feat = spectralFeatures(mono, rate, (f) => onProgress(0.05 + f * 0.6, 'Reading the spectrum'));

  onProgress(0.66, 'Finding the tempo');
  const onsetN = detrend(feat.onset, Math.round(feat.frameRate * 0.5));
  const map = tempoMap(onsetN, feat.frameRate, options.tempoDebug);

  onProgress(0.72, 'Tracking beats');
  const local = gaussianSmooth(onsetN, Math.max(0.5, map.period / 32));
  const tracked = trimBeats(trackBeats(local, map.periodAt), local);
  const frameMs = 1000 / feat.frameRate;
  const latency = ONSET_LATENCY_MS + (options.calibrationMs || 0);
  const trackedMs = tracked.map((f) => f * frameMs + latency);
  const grid = regularizeBeats(trackedMs, durationMs, map, frameMs);

  onProgress(0.82, 'Measuring energy');
  const perBeat = perBeatFeatures(grid.beats, feat);
  const downbeat = findDownbeat(perBeat, grid.beats, trackedMs);

  onProgress(0.9, 'Finding sections');
  const debug = options.debug ? {} : null;
  const sections = segmentSections(grid.beats, downbeat, perBeat, 4, durationMs, debug);
  sectionFeel(grid.beats, feat, sections, debug).forEach((feel, i) => {
    if (feel === 'triplet') sections[i].feel = feel;
  });
  const drops = sections.filter((s) => s.label === 'drop').map((s) => s.start);
  const drums = drumPattern(grid.beats, feat, debug);

  onProgress(0.96, 'Finishing');
  const salience = beatSalience(local, tracked);
  const result = {
    version: ANALYSIS_VERSION,
    durationMs: round(durationMs, 1),
    sampleRate,
    bpm: round(grid.bpm, 2),
    steadyTempo: grid.steady,
    tempos: grid.tempos.map((x) => ({ start: round(x.start, 1), bpm: round(x.bpm, 2) })),
    confidence: round(clamp((salience - 1) / 1.5, 0, 1), 2),
    beats: grid.beats.map((t) => round(t, 1)),
    downbeat,
    beatsPerBar: 4,
    sections,
    drops,
    energy: perBeat.combined.map((v) => round(v, 3)),
    drums,
    peaks: waveformPeaks(mono, 2048),
    onsets: pickOnsets(onsetN, feat.frameRate),
  };
  if (debug) {
    debug.tempoMap = map.segments.map((s) => ({ from: round(s.from * frameMs, 0), to: round(s.to * frameMs, 0), bpm: round((60 * feat.frameRate) / s.period, 2) }));
    result._debug = debug;
  }
  onProgress(1, 'Done');
  return result;
}

const round = (v, digits) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

// ---- 1. Mixdown --------------------------------------------------------------------------

function mixDown(channels, sampleRate) {
  const factor = Math.max(1, Math.round(sampleRate / TARGET_RATE));
  const rate = sampleRate / factor;
  const n = Math.floor(channels[0].length / factor);
  const mono = new Float32Array(n);
  const scale = 1 / (factor * channels.length);
  for (const ch of channels) {
    for (let i = 0, j = 0; i < n; i++) {
      let acc = 0;
      for (let k = 0; k < factor; k++, j++) acc += ch[j];
      mono[i] += acc * scale;
    }
  }
  return { mono, rate };
}

// ---- 2. Spectral features ----------------------------------------------------------------

/**
 * Log-spaced frequency bands (mel-like). Flux is measured per band rather than per FFT bin;
 * per-bin flux lets broadband hi-hats outvote the kick drum, and the tracker then locks onto
 * the off-beat in house and techno.
 */
function logBands(binHz, bins, count = 36, fmin = 40, fmax = 10000) {
  const top = Math.min(fmax, binHz * bins);
  const seen = new Set();
  const bands = [];
  for (let i = 0; i < count; i++) {
    const f0 = fmin * (top / fmin) ** (i / count);
    const f1 = fmin * (top / fmin) ** ((i + 1) / count);
    const b0 = Math.max(1, Math.floor(f0 / binHz));
    const b1 = Math.min(bins, Math.max(b0, Math.ceil(f1 / binHz) - 1));
    const key = `${b0}:${b1}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Kick drums live below 160 Hz; the crack of a snare or clap at 1-4.7 kHz, above most of a
    // kick's harmonics; hi-hats above 6 kHz.
    bands.push({ b0, b1, low: f1 <= 160, mid: f0 >= 1000 && f1 <= 4700, high: f0 >= 6000 });
  }
  return bands;
}

function spectralFeatures(mono, rate, progress) {
  const N = FFT_SIZE;
  const H = HOP;
  const frames = Math.max(2, Math.ceil(mono.length / H));
  const fft = createFFT(N);
  const win = hannWindow(N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const bins = N / 2;
  const binHz = rate / N;
  const band = ([lo, hi]) => [Math.max(1, Math.floor(lo / binHz)), Math.min(bins, Math.ceil(hi / binHz))];
  const [l0, l1] = band(BANDS.low);
  const [h0, h1] = band(BANDS.high);
  const bands = logBands(binHz, bins);
  const lowBands = Math.max(1, bands.filter((b) => b.low).length);
  const midBands = Math.max(1, bands.filter((b) => b.mid).length);
  const highBands = Math.max(1, bands.filter((b) => b.high).length);
  const mag = new Float64Array(bins + 1);
  let prev = new Float64Array(bands.length);
  let cur = new Float64Array(bands.length);
  const onset = new Float32Array(frames);
  const onsetLow = new Float32Array(frames);
  const onsetMid = new Float32Array(frames);
  const onsetHigh = new Float32Array(frames);
  const rms = new Float32Array(frames);
  const low = new Float32Array(frames);
  const high = new Float32Array(frames);
  const norm = 2 / N;

  for (let t = 0; t < frames; t++) {
    const center = t * H;
    const start = center - N / 2;
    for (let i = 0; i < N; i++) {
      const idx = start + i;
      re[i] = idx >= 0 && idx < mono.length ? mono[idx] * win[i] : 0;
      im[i] = 0;
    }
    let e = 0;
    let cnt = 0;
    const a = Math.max(0, center - H / 2);
    const b = Math.min(mono.length, center + H / 2);
    for (let i = a; i < b; i++) {
      e += mono[i] * mono[i];
      cnt++;
    }
    rms[t] = cnt ? Math.sqrt(e / cnt) : 0;

    fft(re, im);
    let eLow = 0;
    let eHigh = 0;
    for (let k = 1; k <= bins; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * norm;
      mag[k] = m;
      if (k >= l0 && k <= l1) eLow += m * m;
      else if (k >= h0 && k <= h1) eHigh += m * m;
    }
    let fl = 0;
    let fLow = 0;
    let fMid = 0;
    let fHigh = 0;
    for (let j = 0; j < bands.length; j++) {
      const { b0, b1 } = bands[j];
      let p = 0;
      for (let k = b0; k <= b1; k++) p += mag[k] * mag[k];
      const lb = Math.log1p((1e4 * p) / (b1 - b0 + 1));
      cur[j] = lb;
      const d = lb - prev[j];
      if (d > 0) {
        fl += d;
        if (bands[j].low) fLow += d;
        else if (bands[j].mid) fMid += d;
        else if (bands[j].high) fHigh += d;
      }
    }
    onset[t] = t === 0 ? 0 : fl / bands.length;
    onsetLow[t] = t === 0 ? 0 : fLow / lowBands;
    onsetMid[t] = t === 0 ? 0 : fMid / midBands;
    onsetHigh[t] = t === 0 ? 0 : fHigh / highBands;
    low[t] = eLow;
    high[t] = eHigh;
    const tmp = prev;
    prev = cur;
    cur = tmp;
    if ((t & 511) === 0) progress(t / frames);
  }
  return { onset, onsetLow, onsetMid, onsetHigh, rms, low, high, frameRate: rate / H, frames };
}

/** Remove the local mean (+-w frames), keep the positive part, scale to unit RMS. */
function detrend(x, w) {
  const n = x.length;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + x[i];
  const out = new Float32Array(n);
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w);
    const b = Math.min(n, i + w + 1);
    const v = Math.max(0, x[i] - (prefix[b] - prefix[a]) / (b - a));
    out[i] = v;
    sumSq += v * v;
  }
  const rmsv = Math.sqrt(sumSq / n) || 1;
  for (let i = 0; i < n; i++) out[i] /= rmsv;
  return out;
}

function gaussianSmooth(x, sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float64Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-0.5 * (i / sigma) ** 2);
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const n = x.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = -r; j <= r; j++) {
      const idx = i + j;
      if (idx >= 0 && idx < n) acc += x[idx] * k[j + r];
    }
    out[i] = acc;
  }
  return out;
}

// ---- 4. Beats ----------------------------------------------------------------------------

/** Ellis' dynamic-programming beat tracker; the expected beat period may change per frame. */
function trackBeats(local, periodAt) {
  const n = local.length;
  const tightness = 100;
  const cum = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  let maxLocal = 0;
  for (let i = 0; i < n; i++) if (local[i] > maxLocal) maxLocal = local[i];
  const threshold = 0.01 * maxLocal;
  let firstBeat = true;
  for (let t = 0; t < n; t++) {
    const period = periodAt[t];
    const lo = Math.max(1, Math.round(period / 2));
    const hi = Math.max(lo + 1, Math.round(period * 2));
    let best = -Infinity;
    let bi = -1;
    for (let p = Math.max(0, t - hi), end = t - lo; p <= end; p++) {
      const d = Math.log((t - p) / period);
      const v = cum[p] - tightness * d * d;
      if (v > best) {
        best = v;
        bi = p;
      }
    }
    if (bi < 0) {
      cum[t] = local[t];
      continue;
    }
    cum[t] = local[t] + best;
    if (firstBeat && local[t] < threshold) back[t] = -1;
    else {
      back[t] = bi;
      firstBeat = false;
    }
  }
  // Last beat: the final local maximum of the cumulative score that is reasonably strong.
  const maxima = [];
  for (let t = 1; t < n - 1; t++) if (cum[t] > cum[t - 1] && cum[t] >= cum[t + 1]) maxima.push(t);
  let last = -1;
  if (maxima.length) {
    const med = median(maxima.map((t) => cum[t]));
    for (const t of maxima) if (cum[t] * 2 > med) last = t;
  }
  if (last < 0) last = n - 1;
  const beats = [];
  for (let t = last; t >= 0 && beats.length < 100000; t = back[t]) beats.push(t);
  return beats.reverse();
}

/** Drop weak beats at the very start and end (silence, fade-outs). */
function trimBeats(beats, local) {
  if (beats.length < 8) return beats;
  const strength = beats.map((f) => local[f]);
  const sm = strength.map((_, i) => {
    let acc = 0;
    let w = 0;
    for (let j = -2; j <= 2; j++) {
      const v = strength[i + j];
      if (v !== undefined) {
        const k = 0.5 - 0.5 * Math.cos((2 * Math.PI * (j + 3)) / 6);
        acc += v * k;
        w += k;
      }
    }
    return acc / w;
  });
  const threshold = 0.5 * Math.sqrt(sm.reduce((s, v) => s + v * v, 0) / sm.length);
  let a = 0;
  let b = beats.length;
  while (a < b && sm[a] < threshold) a++;
  while (b > a && sm[b - 1] < threshold) b--;
  return b - a >= 8 ? beats.slice(a, b) : beats;
}

/**
 * Least-squares line through (beat index, time) for the beats `idx`, with one round of
 * outlier rejection. Steady when the beats sit close to it.
 */
function fitBeatLine(beats, idx) {
  const fit = (list) => {
    const n = list.length;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    for (const i of list) {
      sx += i;
      sy += beats[i];
      sxx += i * i;
      sxy += i * beats[i];
    }
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    return { slope, intercept: (sy - slope * sx) / n };
  };
  let use = idx;
  let line = fit(use);
  const off = (i) => beats[i] - (line.intercept + line.slope * i);
  const mad = median(use.map((i) => Math.abs(off(i)))) || 1;
  use = use.filter((i) => Math.abs(off(i)) < 4 * mad + 15);
  if (use.length >= 4) line = fit(use);
  const residStd = Math.sqrt(use.reduce((s, i) => s + off(i) ** 2, 0) / use.length);
  return { ...line, steady: residStd < Math.max(12, 0.05 * line.slope) };
}

/**
 * Fill dropped beats, then straighten each stretch of steady tempo from the tempo map: an
 * exact grid where the tracked beats fit one (produced music, the usual case), the tracked
 * beats where they wander (a live drummer, a DJ riding the pitch). Extends the grid over the
 * whole song so quiet intros and outros still have beats to snap to.
 * Returns the beats, the main tempo (of the longest stretch), whether the whole song keeps one
 * steady tempo, and the tempo of each stretch.
 */
function regularizeBeats(trackedMs, durationMs, map, frameMs) {
  const periodAt = (ms) => map.periodAt[clamp(Math.round(ms / frameMs), 0, map.periodAt.length - 1)] * frameMs;
  if (trackedMs.length < 4) {
    const period = map.period * frameMs;
    const beats = [];
    for (let t = 0; t <= durationMs; t += period) beats.push(t);
    return { beats, bpm: 60000 / period, steady: true, tempos: [{ start: 0, bpm: 60000 / period }] };
  }
  const beats = [trackedMs[0]];
  for (let i = 1; i < trackedMs.length; i++) {
    const prev = beats[beats.length - 1];
    const gap = trackedMs[i] - prev;
    const missing = Math.round(gap / periodAt((prev + trackedMs[i]) / 2)) - 1;
    for (let k = 1; k <= missing && missing < 64; k++) beats.push(prev + (gap * k) / (missing + 1));
    beats.push(trackedMs[i]);
  }

  // The tempo map's stretches, each with its beats and, if they keep a steady tempo, a line
  // fitted away from its edges (the map places a change only to within a second or so).
  const EDGE = 1500;
  const last = map.segments.length - 1;
  const segs = map.segments.map((seg, si) => {
    const a = si === 0 ? -Infinity : seg.from * frameMs;
    const b = si === last ? Infinity : seg.to * frameMs;
    const idx = [];
    beats.forEach((t, i) => {
      if (t >= a && t < b) idx.push(i);
    });
    const core = idx.filter((i) => beats[i] >= a + EDGE && beats[i] < b - EDGE);
    const line = core.length >= 12 ? fitBeatLine(beats, core) : idx.length >= 12 ? fitBeatLine(beats, idx) : null;
    return { a, b, idx, line: line?.steady ? line : null };
  });
  const on = (line, i) => line.intercept + line.slope * i;
  // Where two steady stretches meet, the tempo changes at the beat from which the second
  // line fits the tracked beats better than the first.
  for (let k = 0; k < last; k++) {
    const [p, q] = [segs[k], segs[k + 1]];
    if (!p.line || !q.line) continue;
    const near = [...p.idx, ...q.idx].filter((i) => Math.abs(beats[i] - q.a) < 3000);
    let cut = 0;
    let best = Infinity;
    for (let c = 0; c <= near.length; c++) {
      let cost = 0;
      near.forEach((i, j) => {
        cost += Math.abs(beats[i] - on(j < c ? p.line : q.line, i));
      });
      if (cost < best) {
        best = cost;
        cut = c;
      }
    }
    const toP = new Set(near.slice(0, cut));
    p.idx = [...p.idx.filter((i) => !near.includes(i)), ...toP].sort((x, y) => x - y);
    q.idx = [...near.filter((i) => !toP.has(i)), ...q.idx.filter((i) => !near.includes(i))].sort((x, y) => x - y);
  }

  const out = [];
  const stretches = [];
  let steady = segs.length === 1;
  for (const { a, b, idx, line } of segs) {
    if (!idx.length) continue;
    if (!line) steady = false;
    const first = out.length;
    for (const i of idx) {
      const t = line ? on(line, i) : beats[i];
      // Where two stretches meet, never two beats on top of each other.
      if (!out.length || t - out[out.length - 1] > 0.4 * periodAt(t)) out.push(t);
    }
    if (out.length - first < 2) continue;
    const period = line ? line.slope : median(out.slice(first + 1).map((t, k) => t - out[first + k]));
    // How much of the song this tempo covers (the first and last run to the song's ends).
    const span = Math.min(b, durationMs) - Math.max(a, 0);
    stretches.push({ start: out[first], span, period, line });
  }

  // Out to the song's start and end at the tempo of the first and last stretch.
  const head = stretches[0];
  const tail = stretches[stretches.length - 1];
  if (head.line) {
    // Keep a first beat that lands a hair before 0 ms (a downbeat right at the song start).
    const { slope, intercept } = head.line;
    const k0 = Math.round((out[0] - intercept) / slope);
    for (let k = k0 - 1; intercept + slope * k >= -0.3 * slope; k--) out.unshift(intercept + slope * k);
  } else {
    while (out[0] - head.period >= 0) out.unshift(out[0] - head.period);
  }
  while (out[out.length - 1] + tail.period <= durationMs) out.push(out[out.length - 1] + tail.period);
  const main = stretches.reduce((m, s) => (s.span > m.span ? s : m), stretches[0]);
  return {
    beats: out,
    bpm: 60000 / main.period,
    steady,
    tempos: stretches.map((s, i) => ({ start: i === 0 ? 0 : s.start, bpm: 60000 / s.period })),
  };
}

function beatSalience(local, beatFrames) {
  if (!beatFrames.length) return 1;
  let all = 0;
  for (let i = 0; i < local.length; i++) all += local[i];
  const meanAll = all / local.length || 1;
  const meanBeats = beatFrames.reduce((s, f) => s + local[f], 0) / beatFrames.length;
  return meanBeats / meanAll;
}

// ---- 5. Per-beat features and downbeats --------------------------------------------------

function robustNormalize(values) {
  const sorted = Float64Array.from(values).sort();
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
  const lo = q(0.05);
  const hi = q(0.95);
  const span = hi - lo || 1;
  return values.map((v) => clamp((v - lo) / span, 0, 1));
}

function perBeatFeatures(beatsMs, feat) {
  const fr = feat.frameRate;
  const n = beatsMs.length;
  const energy = new Array(n);
  const low = new Array(n);
  const high = new Array(n);
  const flux = new Array(n);
  const lowHit = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = clamp(Math.round((beatsMs[i] / 1000) * fr), 0, feat.frames - 1);
    const endMs = i + 1 < n ? beatsMs[i + 1] : beatsMs[i] + (beatsMs[i] - (beatsMs[i - 1] ?? beatsMs[i] - 500));
    const b = clamp(Math.round((endMs / 1000) * fr), a + 1, feat.frames);
    let r = 0;
    let l = 0;
    let h = 0;
    let f = 0;
    for (let t = a; t < b; t++) {
      r += feat.rms[t] * feat.rms[t];
      l += feat.low[t];
      h += feat.high[t];
      f += feat.onset[t];
    }
    const cnt = b - a;
    energy[i] = 10 * Math.log10(r / cnt + 1e-10);
    low[i] = 10 * Math.log10(l / cnt + 1e-12);
    high[i] = 10 * Math.log10(h / cnt + 1e-12);
    flux[i] = f / cnt;
    let hit = 0;
    for (let t = Math.max(0, a - 2); t <= Math.min(feat.frames - 1, a + 2); t++) hit = Math.max(hit, feat.onsetLow[t]);
    lowHit[i] = hit;
  }
  const e = robustNormalize(energy);
  const lo = robustNormalize(low);
  const hi = robustNormalize(high);
  const fx = robustNormalize(flux);
  return {
    energy: e,
    low: lo,
    high: hi,
    flux: fx,
    lowHit: robustNormalize(lowHit),
    combined: e.map((v, i) => clamp(0.6 * v + 0.4 * lo[i], 0, 1)),
  };
}

/** Which beat phase (0..3) starts the bars: energy changes and first kicks land on downbeats. */
function findDownbeat(perBeat, beatsMs, trackedMs) {
  const n = beatsMs.length;
  const score = [0, 0, 0, 0];
  const E = perBeat.combined;
  const mean = (a, b) => {
    let s = 0;
    for (let i = a; i < b; i++) s += E[i];
    return s / (b - a);
  };
  for (let i = 4; i + 4 <= n; i++) {
    score[i % 4] += Math.abs(mean(i, i + 4) - mean(i - 4, i)) + 0.15 * perBeat.lowHit[i];
  }
  // The first tracked (audible) beat usually starts a bar.
  if (trackedMs.length) {
    let first = 0;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(beatsMs[i] - trackedMs[0]);
      if (d < bestD) {
        bestD = d;
        first = i;
      }
    }
    const total = score.reduce((s, v) => s + v, 0) || 1;
    score[first % 4] += total * 0.08;
  }
  let best = 0;
  for (let p = 1; p < 4; p++) if (score[p] > score[best]) best = p;
  return best;
}

// ---- 7. Drum pattern ---------------------------------------------------------------------

// Per band: flux below `floor` (log-power units per band) is background, not a drum; `minRef`
// is the least a loud hit is assumed to reach, so a song without, say, hi-hats does not
// scale its background hiss up into a hi-hat pattern. Tuned on the synthetic demo track,
// whose snares and hi-hats are quiet; real recordings land well above these.
const DRUM_SCALE = { kick: { floor: 0.2, minRef: 0.8 }, snare: { floor: 0.015, minRef: 0.08 }, hat: { floor: 0.015, minRef: 0.08 } };

/**
 * How strongly a kick, a snare/clap and a hi-hat sound on each beat: kick and snare on the
 * beat itself, the hi-hat on the off-beat (the 8th note after it), where dance music puts
 * them. Each is scaled 0..1 against its own loud hits (95th percentile), with a floor so a
 * song without hi-hats does not turn background hiss into a hi-hat pattern.
 */
function drumPattern(beatsMs, feat, debug = null) {
  const fr = feat.frameRate;
  const n = beatsMs.length;
  const strongest = (arr, ms) => {
    const c = ((ms - ONSET_LATENCY_MS) / 1000) * fr;
    let m = 0;
    for (let t = Math.floor(c - 1.5); t <= Math.ceil(c + 1.5); t++) if (t >= 0 && t < feat.frames && arr[t] > m) m = arr[t];
    return m;
  };
  const kick = new Array(n);
  const snare = new Array(n);
  const hat = new Array(n);
  for (let i = 0; i < n; i++) {
    const b = beatsMs[i];
    const next = i + 1 < n ? beatsMs[i + 1] : b + (b - (i > 0 ? beatsMs[i - 1] : b - 500));
    kick[i] = strongest(feat.onsetLow, b);
    snare[i] = strongest(feat.onsetMid, b);
    hat[i] = strongest(feat.onsetHigh, (b + next) / 2);
  }
  if (debug) debug.drumsRaw = { kick: kick.slice(), snare: snare.slice(), hat: hat.slice() };
  const scale = (values, { floor, minRef }) => {
    const sorted = values.slice().sort((x, y) => x - y);
    const ref = Math.max(minRef, sorted[Math.floor(0.95 * (sorted.length - 1))] || 0);
    return values.map((v) => (v < floor ? 0 : round(clamp(v / ref, 0, 1), 2)));
  };
  return { kick: scale(kick, DRUM_SCALE.kick), snare: scale(snare, DRUM_SCALE.snare), hat: scale(hat, DRUM_SCALE.hat) };
}

/**
 * Straight or triplet, per section: where the onsets between the beats fall. A shuffle, a
 * 6/8 or 12/8 part puts them on the thirds of the beat; most pop and dance music on the
 * halves and quarters. The generator steps its chases and flicks to match.
 */
function sectionFeel(beatsMs, feat, sections, debug = null) {
  const frameMs = 1000 / feat.frameRate;
  // The drums set the feel, not the melody: kick, snare and hi-hat bands, each to unit mean.
  const unit = (arr) => {
    let s = 0;
    for (let f = 0; f < arr.length; f++) s += arr[f];
    return arr.length / (s || 1);
  };
  const [kLow, kMid, kHigh] = [unit(feat.onsetLow), unit(feat.onsetMid), unit(feat.onsetHigh)];
  const drum = (f) => feat.onsetLow[f] * kLow + feat.onsetMid[f] * kMid + feat.onsetHigh[f] * kHigh;
  return sections.map((s) => {
    // Average onset strength at 12 places in the beat, over the whole section.
    const sum = new Float64Array(12);
    const cnt = new Float64Array(12);
    let i = 0;
    for (let f = 0; f < feat.frames; f++) {
      const t = f * frameMs + ONSET_LATENCY_MS;
      if (t < s.start || t >= s.end) continue;
      while (i + 1 < beatsMs.length && beatsMs[i + 1] <= t) i++;
      if (i + 1 >= beatsMs.length || t < beatsMs[i]) continue;
      const pos = Math.round(((t - beatsMs[i]) / (beatsMs[i + 1] - beatsMs[i])) * 12) % 12;
      sum[pos] += drum(f);
      cnt[pos]++;
    }
    const v = Array.from(sum, (x, k) => x / (cnt[k] || 1));
    const mean = v.reduce((p, q) => p + q, 0) / 12 || 1;
    const r = v.map((x) => x / mean);
    // Both thirds must stand out, above the halves and quarters: music with hits all over the
    // beat, or a swung 16th here and there, stays straight.
    const thirds = Math.min(r[4], r[8]);
    const halves = Math.max(r[6], (r[3] + r[9]) / 2);
    const enough = beatsMs.filter((b) => b >= s.start && b < s.end).length >= 8;
    if (debug) (debug.feel ||= []).push({ start: s.start, profile: r.map((x) => round(x, 2)), thirds: round(thirds, 2), halves: round(halves, 2) });
    return enough && thirds > 1.1 && thirds >= 1.2 * halves ? 'triplet' : 'straight';
  });
}

// ---- 6. Sections -------------------------------------------------------------------------

function segmentSections(beatsMs, downbeat, perBeat, bpb, durationMs, debug) {
  const n = beatsMs.length;
  const bars = [];
  // Whole bars only: a partial last bar (fade-out, trailing silence) would fake a big change.
  for (let s = downbeat % bpb; s + bpb <= n; s += bpb) bars.push({ start: s, end: s + bpb });
  if (bars.length < 8) return [{ start: 0, end: durationMs, energy: 0.5, label: 'groove' }];
  const feats = bars.map(({ start, end }) => {
    const avg = (arr) => {
      let s = 0;
      for (let i = start; i < end; i++) s += arr[i];
      return s / (end - start);
    };
    return { e: avg(perBeat.energy), lo: avg(perBeat.low), hi: avg(perBeat.high), fx: avg(perBeat.flux) };
  });
  const B = bars.length;
  const mean = (from, to, key) => {
    let s = 0;
    for (let k = from; k < to; k++) s += feats[k][key];
    return s / (to - from);
  };

  // Novelty: how different the next w bars are from the previous w bars. Full windows only.
  const w = B >= 24 ? 4 : 2;
  const nov = new Array(B).fill(0);
  const rise = new Array(B).fill(0);
  for (let j = w; j + w <= B; j++) {
    const d = (key) => mean(j, j + w, key) - mean(j - w, j, key);
    nov[j] = 1.0 * Math.abs(d('e')) + 0.8 * Math.abs(d('lo')) + 0.5 * Math.abs(d('hi')) + 0.4 * Math.abs(d('fx'));
    rise[j] = 0.6 * d('e') + 0.4 * d('lo');
  }
  // Songs change on 4/8-bar phrases. Find the phrase phase that collects the most novelty.
  let phase = 0;
  let bestPhase = -1;
  for (let p = 0; p < 8; p++) {
    let s = 0;
    for (let j = p; j < B; j += 8) s += nov[j];
    if (s > bestPhase) {
      bestPhase = s;
      phase = p;
    }
  }
  const weighted = nov.map((v, j) => v * (mod8(j - phase) === 0 ? 1.25 : mod8(j - phase) % 4 === 0 ? 1.1 : 0.8));
  const maxW = Math.max(...weighted);
  if (debug) {
    debug.phase = phase;
    debug.bars = bars.map((b, j) => ({
      j,
      t: Math.round(beatsMs[b.start]),
      nov: round(weighted[j], 3),
      rise: round(rise[j], 2),
      e: round(feats[j].e, 2),
      lo: round(feats[j].lo, 2),
      hi: round(feats[j].hi, 2),
      fx: round(feats[j].fx, 2),
    }));
  }

  // Candidate boundaries: local peaks. Strong peaks and big upward jumps (drops) may sit
  // 4 bars apart; weaker ones need 8 bars of room so the song is not chopped up.
  const candidates = [];
  for (let j = w; j + w <= B; j++) {
    const v = weighted[j];
    if (v < 0.2 * maxW || v < 0.05) continue;
    if (v >= (weighted[j - 1] ?? 0) && v >= (weighted[j + 1] ?? 0)) candidates.push(j);
  }
  candidates.sort((x, y) => weighted[y] - weighted[x]);
  const chosen = [];
  for (const j of candidates) {
    const strong = weighted[j] >= 0.5 * maxW || rise[j] >= 0.2;
    const gap = strong ? 4 : 8;
    if (chosen.every((c) => Math.abs(c - j) >= gap)) chosen.push(j);
  }
  chosen.sort((x, y) => x - y);

  const bounds = [0, ...chosen, B];
  const makeSection = (b0, b1, isFirst, isLast) => {
    const e = mean(b0, b1, 'e');
    const lo = mean(b0, b1, 'lo');
    return {
      b0,
      b1,
      start: isFirst ? 0 : beatsMs[bars[b0].start],
      end: isLast ? durationMs : beatsMs[bars[b1].start],
      energy: clamp(0.6 * e + 0.4 * lo, 0, 1),
      low: lo,
    };
  };
  let sections = [];
  for (let k = 0; k + 1 < bounds.length; k++) {
    sections.push(makeSection(bounds[k], bounds[k + 1], k === 0, k + 2 === bounds.length));
  }
  sections = labelSections(sections);

  // A long stretch before a drop is usually a groove followed by an 8-bar build-up.
  const out = [];
  for (const s of sections) {
    if (s.label === 'build' && s.b1 - s.b0 >= 12) {
      const split = s.b1 - 8;
      const head = makeSection(s.b0, split, s.start === 0, false);
      head.label = s.start === 0 ? 'intro' : head.energy >= 0.4 ? 'groove' : 'low';
      const tail = makeSection(split, s.b1, false, s.end === durationMs);
      tail.label = 'build';
      out.push(head, tail);
    } else {
      out.push(s);
    }
  }
  return out.map((s) => ({ start: round(s.start, 1), end: round(s.end, 1), energy: round(s.energy, 3), label: s.label }));
}

const mod8 = (v) => ((v % 8) + 8) % 8;

function labelSections(sections) {
  const maxE = Math.max(...sections.map((s) => s.energy));
  // Only the peak tier counts as a drop; the first kick entry after an intro is a groove.
  const highCut = Math.max(0.55, maxE - 0.1);
  sections.forEach((s, i) => {
    const prev = sections[i - 1];
    if (s.energy >= highCut) {
      s.label = prev && s.energy - prev.energy >= 0.15 && s.low >= 0.45 ? 'drop' : 'high';
    } else if (i === 0) s.label = 'intro';
    else if (i === sections.length - 1 && s.energy < maxE - 0.15) s.label = 'outro';
    else if (prev && (prev.label === 'drop' || prev.label === 'high') && s.energy < 0.45) s.label = 'breakdown';
    else s.label = s.energy >= 0.4 ? 'groove' : 'low';
  });
  // The section right before a drop is its build-up.
  sections.forEach((s, i) => {
    const next = sections[i + 1];
    if (next?.label === 'drop' && s.label !== 'drop' && s.label !== 'high') s.label = 'build';
  });
  return sections;
}

// ---- Display helpers ---------------------------------------------------------------------

function waveformPeaks(mono, buckets) {
  const out = new Array(buckets).fill(0);
  const size = mono.length / buckets;
  let max = 1e-9;
  for (let b = 0; b < buckets; b++) {
    const a = Math.floor(b * size);
    const e = Math.min(mono.length, Math.floor((b + 1) * size));
    let m = 0;
    for (let i = a; i < e; i++) {
      const v = Math.abs(mono[i]);
      if (v > m) m = v;
    }
    out[b] = m;
    if (m > max) max = m;
  }
  return out.map((v) => round(v / max, 3));
}

function pickOnsets(onsetN, frameRate) {
  const out = [];
  const minGap = Math.round(frameRate * 0.08);
  let lastPick = -Infinity;
  for (let t = 1; t < onsetN.length - 1 && out.length < 4000; t++) {
    const v = onsetN[t];
    if (v > 2 && v >= onsetN[t - 1] && v >= onsetN[t + 1] && t - lastPick >= minGap) {
      out.push(round((t / frameRate) * 1000 + ONSET_LATENCY_MS, 1));
      lastPick = t;
    }
  }
  return out;
}
