// Live audio-in analysis: kick / mid / hi-hat hits and levels, sample by sample.
//
// Runs on the browser's real-time audio thread (an AudioWorklet, see
// client/live-audio-worklet.js) on the show computer, and in Node for the tests. It uses IIR
// filters and envelope followers instead of FFT blocks, so a hit is reported within a few
// milliseconds of the sound instead of after a whole analysis window.
//
//   low  (kick)       4th-order low-pass at 150 Hz
//   mid  (snare/voc)  high-pass 400 Hz + low-pass 3 kHz (above the kick's beater click)
//   high (hi-hats)    4th-order high-pass at 6 kHz
//
// Per band: a fast envelope (1 ms attack) is compared with a short reference, the fast
// envelope's own average over the last ~50 ms. A drum hit is a sudden jump: the fast envelope
// leaps to several times its recent average within milliseconds. Steady sound (noise, held
// notes) keeps the two close together, so it does not trigger. A refractory period makes one
// drum hit one event. Levels are normalized by a slowly decaying peak, so they stay meaningful
// whether the input is quiet or loud.

// floor: a hit must also reach this share of the band's recent peak. The mid band needs a
// high floor: kick clicks and hi-hats leak into it, but the snare is its loudest event.
const BANDS = [
  { name: 'low', release: 0.04, ratio: 2.2, floor: 0.15, refractory: 0.12 },
  { name: 'mid', release: 0.03, ratio: 2.2, floor: 0.45, refractory: 0.09 },
  { name: 'high', release: 0.015, ratio: 2.4, floor: 0.15, refractory: 0.05 },
];

function biquad(type, f0, q, fs) {
  // Keep the corner below Nyquist. Past it sin(w0) turns negative, alpha with it, and a0
  // crosses zero: the filter's poles leave the unit circle and it diverges to NaN on the
  // first sample. A Bluetooth headset in hands-free mode can hand us an 8 kHz context, where
  // the 6 kHz hi-hat filter would do exactly that and kill the high band for the session.
  const w0 = (2 * Math.PI * Math.min(f0, fs * 0.45)) / fs;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  let b0;
  let b1;
  let b2;
  if (type === 'lowpass') {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = (1 - cos) / 2;
  } else {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
  }
  const a0 = 1 + alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
}

function step(f, x) {
  const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
  f.x2 = f.x1;
  f.x1 = x;
  f.y2 = f.y1;
  f.y1 = y;
  return y;
}

// Butterworth 4th order = two biquads with these Qs.
const BW4 = [0.5412, 1.3066];

export function createLiveDetector(sampleRate, { sensitivity = {} } = {}) {
  const fs = sampleRate;
  const k = (seconds) => 1 - Math.exp(-1 / (seconds * fs));
  const dc = biquad('highpass', 30, 0.707, fs);
  const chains = [
    BW4.map((q) => biquad('lowpass', 150, q, fs)),
    [biquad('highpass', 400, 0.707, fs), biquad('lowpass', 3000, 0.707, fs)],
    BW4.map((q) => biquad('highpass', 6000, q, fs)),
  ];
  const attack = k(0.001);
  const baseK = k(0.05);
  const peakDecay = Math.exp(Math.log(0.5) / (4 * fs)); // peak halves every 4 s without new peaks
  const state = BANDS.map((b) => ({
    fast: 0,
    base: 1e-6,
    peak: 1e-4,
    prev: 0,
    armed: true,
    lastHit: -Infinity,
    release: k(b.release),
    ratio: b.ratio,
    floor: b.floor,
    refractory: Math.round(b.refractory * fs),
    sens: 1,
  }));
  let energy = 0;
  let energyPeak = 1e-4;
  const energyAttack = k(0.005);
  const energyRelease = k(0.2);
  let n = 0;
  const warmup = Math.round(0.25 * fs); // let the envelopes settle before reporting hits
  const kickTimes = [];
  const NONE = [];

  function setSensitivity(s) {
    BANDS.forEach((b, i) => {
      const v = s?.[b.name];
      if (typeof v === 'number' && v > 0) state[i].sens = v;
    });
  }
  setSensitivity(sensitivity);

  /** Process one block of mono samples; returns hits as [{ band, strength }]. */
  function process(block) {
    let events = NONE;
    for (let i = 0; i < block.length; i++, n++) {
      const x = step(dc, block[i]);
      const ax = Math.abs(x);
      energy += (ax > energy ? energyAttack : energyRelease) * (ax - energy);
      if (energy > energyPeak) energyPeak = energy;
      else energyPeak *= peakDecay;
      for (let b = 0; b < 3; b++) {
        let y = x;
        for (const f of chains[b]) y = step(f, y);
        const st = state[b];
        const a = Math.abs(y);
        st.fast += (a > st.fast ? attack : st.release) * (a - st.fast);
        st.base += baseK * (st.fast - st.base);
        if (st.fast > st.peak) st.peak = st.fast;
        else st.peak *= peakDecay;
        const threshold = st.base * (st.ratio / st.sens);
        if (!st.armed && st.fast < st.base * 1.2) st.armed = true;
        if (
          n >= warmup &&
          st.armed &&
          st.fast > threshold &&
          st.fast > st.prev &&
          st.fast > st.peak * st.floor &&
          n - st.lastHit >= st.refractory
        ) {
          st.armed = false;
          st.lastHit = n;
          if (events === NONE) events = [];
          // A hit is reported the moment the envelope crosses its threshold, before the sound
          // has peaked, so the envelope here says nothing about how loud the hit will be: hits
          // are triggers at full strength. Loudness reaches the lights through levels().
          events.push({ band: b, strength: 1 });
          if (b === 0) {
            kickTimes.push(n / fs);
            if (kickTimes.length > 24) kickTimes.shift();
          }
        }
        st.prev = st.fast;
      }
    }
    return events;
  }

  /**
   * [low, mid, high, overall], each 0..1 relative to its recent peak. Pass an array to fill
   * to avoid allocating on the audio thread.
   */
  function levels(out = [0, 0, 0, 0]) {
    for (let b = 0; b < 3; b++) out[b] = state[b].peak > 0 ? Math.min(1, state[b].fast / state[b].peak) : 0;
    out[3] = energyPeak > 0 ? Math.min(1, energy / energyPeak) : 0;
    return out;
  }

  /** Tempo from the gaps between kicks, folded into 80-180 BPM; 0 until there are enough. */
  function bpm() {
    const gaps = [];
    for (let i = 1; i < kickTimes.length; i++) {
      let g = kickTimes[i] - kickTimes[i - 1];
      if (g < 0.25 || g > 2) continue;
      while (g > 0.75) g /= 2;
      while (g < 1 / 3) g *= 2;
      gaps.push(g);
    }
    if (gaps.length < 4) return 0;
    gaps.sort((a, b) => a - b);
    const m = gaps[gaps.length >> 1];
    return Math.round((600 / m)) / 10;
  }

  return { process, levels, bpm, setSensitivity, get samples() { return n; } };
}

export const LIVE_BANDS = BANDS.map((b) => b.name);
