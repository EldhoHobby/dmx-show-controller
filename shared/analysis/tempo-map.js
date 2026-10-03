// Tempo through a song, for songs whose tempo changes: DJ mashups, dance medleys, live bands.
//
//   1. tempogram: the onset envelope's autocorrelation in 8 s windows, one per second, read
//      at every tempo from 60 to 200 BPM in 0.5 % steps. A tempo scores by how strongly the
//      onsets repeat at its beat and at two beats, with a broad preference for 120 BPM.
//   2. tempo path: the best tempo per window, kept steady unless the music clearly moves
//      (Viterbi: a small drift is cheap, a jump costs a fixed amount, so one odd window or a
//      drumless breakdown does not change the tempo, but a new song in a medley does).
//   3. per-frame beat period for the beat tracker, and the path's steady segments.
//
// Pure JS, no DOM; used by analyze.js.

const WINDOW_S = 8;
const HOP_S = 1;
const MIN_BPM = 60;
const MAX_BPM = 200;
const STEP = 1.005; // tempo resolution: 0.5 %
const DRIFT_STEPS = 1; // up to 0.5 % a second follows a DJ riding the pitch or a drummer pushing
const DRIFT_COST = 0.04; // per 0.5 % step between neighbouring windows (1 s apart)
const JUMP_COST = 1.5; // any bigger change, in units of a clear window's score
const SEGMENT_SPLIT = 0.025; // a segment ends where the tempo has moved 2.5 % from its start

const prior = (bpm) => Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);

/**
 * @param onset      onset envelope (detrended, non-negative), one value per frame
 * @param frameRate  frames per second
 * @returns {{ periodAt: Float32Array, segments: {from, to, period}[], period: number }}
 *   periodAt  beat period in frames at every frame
 *   segments  stretches of steady tempo (frames [from, to)), with their median period
 *   period    the period of the longest segment, for display and fallbacks
 */
export function tempoMap(onset, frameRate, debug = null) {
  const n = onset.length;
  const win = Math.max(8, Math.min(n, Math.round(WINDOW_S * frameRate)));
  const hop = Math.max(1, Math.round(HOP_S * frameRate));
  const tempos = [];
  for (let b = MIN_BPM; b <= MAX_BPM + 1e-9; b *= STEP) tempos.push(b);
  const S = tempos.length;
  const lags = tempos.map((b) => (60 * frameRate) / b);
  const maxLag = Math.min(win - 1, Math.ceil(lags[0] * 2) + 2);

  // ---- 1. Tempogram ------------------------------------------------------------------
  const starts = [];
  for (let s = 0; s + win <= n; s += hop) starts.push(s);
  if (!starts.length || starts.at(-1) + win < n) starts.push(Math.max(0, n - win));
  const W = starts.length;
  const score = Array.from({ length: W }, () => new Float64Array(S));
  const beatLevel = Array.from({ length: W }, () => new Float64Array(S)); // repeats at one beat
  const x = new Float64Array(win);
  const acs = [];
  for (let w = 0; w < W; w++) {
    const a = starts[w];
    const len = Math.min(win, n - a);
    let mean = 0;
    for (let i = 0; i < len; i++) mean += onset[a + i];
    mean /= len;
    for (let i = 0; i < len; i++) x[i] = onset[a + i] - mean;
    const ac = new Float64Array(maxLag + 2);
    for (let lag = 0; lag <= maxLag && lag < len; lag++) {
      let s = 0;
      for (let i = 0, m = len - lag; i < m; i++) s += x[i] * x[i + lag];
      ac[lag] = s / (len - lag);
    }
    acs.push(ac);
  }
  // Each window against the song's typical onset strength, not its own: a drumless intro's
  // faint wobble must not look as rhythmic as the drop (a window's own scale would make it so).
  const typical = acs.map((ac) => ac[0]).sort((p, q) => p - q)[W >> 1];
  for (let w = 0; w < W; w++) {
    const ac = acs[w];
    const len = Math.min(win, n - starts[w]);
    // A silent window has no energy of its own and, if most of the song is silent, no
    // typical energy either. 1/0 is Infinity, which is truthy, so `|| 0` never caught it:
    // every score downstream became NaN and the path collapsed to the slowest tempo.
    const denom = Math.max(ac[0], typical);
    const norm = denom > 0 ? 1 / denom : 0;
    const at = (L) => {
      const i = Math.floor(L);
      if (i + 1 >= len || i + 1 > maxLag) return 0;
      const f = L - i;
      return (ac[i] * (1 - f) + ac[i + 1] * f) * norm;
    };
    for (let s = 0; s < S; s++) {
      const L = lags[s];
      // The beat and two beats: the same score the whole-song estimate always used.
      beatLevel[w][s] = Math.max(0, at(L));
      const v = beatLevel[w][s] + 0.5 * Math.max(0, at(2 * L));
      score[w][s] = v * prior(tempos[s]);
    }
  }

  // ---- 2. Tempo path (Viterbi) --------------------------------------------------------
  // Scale so a clear window's best tempo scores about 1: the costs are in those units.
  const peaks = score.map((row) => Math.max(...row)).sort((p, q) => p - q);
  const ref = peaks[Math.floor(0.75 * (peaks.length - 1))] || 1;
  const cost = new Float64Array(S * S);
  for (let i = 0; i < S; i++) {
    for (let j = 0; j < S; j++) {
      const d = Math.abs(i - j);
      cost[i * S + j] = d <= DRIFT_STEPS ? d * DRIFT_COST : JUMP_COST;
    }
  }
  // Double and half time are one beat read two ways, so the path keeps the reading it has
  // unless the other is clearly better: a tempo also scores 90 % of its double time, and of
  // its half time when the music still repeats at its own beat. In a triplet passage it does
  // not (three hits to the slower beat put the faster one between hits half the time), so the
  // reading moves to the slower beat there.
  const octave = Math.round(Math.log(2) / Math.log(STEP));
  // Halving a tempo never loses support — every other onset still lines up — so both
  // readings of a fast track score alike and the 120 BPM preference decides, which tips to
  // half time above about 170 BPM. Doubling, by contrast, needs onsets between the beats.
  // So where a tempo's double is nearly as rhythmic as the tempo itself, the double is the
  // real beat and the slower reading is held back. Reading half time is also the worse
  // error to make: it puts every other onset off the grid, where double time keeps them all
  // on it.
  // Off-beat hi-hats put real onsets between the beats of slow music, so the double has to
  // repeat nearly as strongly as the tempo itself before it counts as the beat. Measured on
  // the demo synth from 60 to 200 BPM, this takes the tempos read an octave out from 13 of
  // 24 down to 4, without breaking any that were right before.
  const DOUBLE_IS_REAL = 0.7; // its double repeats at least this strongly as itself
  const HALF_TIME_HOLD = 0.8; // how far the slower reading is then held back
  const emit = score.map((row, w) =>
    row.map((v, s) => {
      const half = beatLevel[w][s] >= 0.5 * (beatLevel[w][s - octave] || 0) ? row[s - octave] || 0 : 0;
      const doubleReal = beatLevel[w][s + octave] >= DOUBLE_IS_REAL * beatLevel[w][s];
      const own = doubleReal ? v * HALF_TIME_HOLD : v;
      return Math.max(own, 0.9 * (row[s + octave] || 0), 0.9 * half) / ref;
    }),
  );
  let acc = Float64Array.from(emit[0]);
  const back = Array.from({ length: W }, () => new Int32Array(S));
  for (let w = 1; w < W; w++) {
    const next = new Float64Array(S);
    for (let s = 0; s < S; s++) {
      let best = -Infinity;
      let bi = 0;
      for (let p = 0; p < S; p++) {
        const v = acc[p] - cost[p * S + s];
        if (v > best) {
          best = v;
          bi = p;
        }
      }
      next[s] = best + emit[w][s];
      back[w][s] = bi;
    }
    acc = next;
  }
  const path = new Int32Array(W);
  let last = 0;
  for (let s = 1; s < S; s++) if (acc[s] > acc[last]) last = s;
  path[W - 1] = last;
  for (let w = W - 1; w > 0; w--) path[w - 1] = back[w][path[w]];

  // ---- 3. Segments and the per-frame period ------------------------------------------------
  const centre = (w) => starts[w] + Math.min(win, n - starts[w]) / 2;
  const segments = [];
  let from = 0;
  for (let w = 1; w <= W; w++) {
    const jump = w === W || Math.abs(Math.log(tempos[path[w]] / tempos[path[from]])) > Math.log(1 + SEGMENT_SPLIT);
    if (!jump) continue;
    const list = Array.from(path.slice(from, w), (s) => lags[s]).sort((p, q) => p - q);
    segments.push({ w0: from, w1: w, period: list[list.length >> 1] });
    from = w;
  }
  // Segment edges halfway between the windows on either side of a jump.
  segments.forEach((seg, i) => {
    seg.from = i === 0 ? 0 : Math.round((centre(seg.w0 - 1) + centre(seg.w0)) / 2);
    seg.to = i === segments.length - 1 ? n : Math.round((centre(seg.w1 - 1) + centre(seg.w1)) / 2);
  });
  const periodAt = new Float32Array(n);
  for (const seg of segments) {
    // Within a segment, follow the path's drift from window to window.
    for (let t = seg.from; t < seg.to; t++) {
      let w = seg.w0;
      while (w + 1 < seg.w1 && centre(w + 1) <= t) w++;
      const L0 = lags[path[w]];
      if (w + 1 < seg.w1 && t >= centre(w)) {
        const f = (t - centre(w)) / (centre(w + 1) - centre(w));
        periodAt[t] = L0 + (lags[path[w + 1]] - L0) * f;
      } else periodAt[t] = L0;
    }
  }
  if (debug) Object.assign(debug, { tempos, score, path, starts, win, ref });
  const longest = segments.reduce((b, s) => (s.to - s.from > b.to - b.from ? s : b), segments[0]);
  return {
    periodAt,
    segments: segments.map(({ from: f, to, period }) => ({ from: f, to, period })),
    period: longest.period,
  };
}
