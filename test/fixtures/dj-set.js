// A synthetic DJ set as the live detector would report it: kick (0), snare (1) and hi-hat (2)
// hits with timing jitter, plus the true start of each part. Used by the live-tracker tests.

export function djSet({ bpm = 126, jitter = 3, seed = 7, start = 1000 } = {}) {
  const P = 60000 / bpm;
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const j = () => (rnd() * 2 - 1) * jitter;
  const hits = [];
  const parts = [];
  const kicks = [];
  let t0 = start;
  const part = (name, bars, fn) => {
    parts.push({ name, start: t0, bars });
    const beats = bars * 4;
    for (let b = 0; b < beats; b++) fn(b, t0 + b * P, beats);
    t0 += beats * P;
  };
  const kick = (t) => {
    kicks.push(t);
    hits.push({ t: t + j(), band: 0 });
  };
  const snare = (t) => hits.push({ t: t + j(), band: 1 });
  const hat = (t) => hits.push({ t: t + j(), band: 2 });
  const fullGroove = (b, t) => {
    kick(t);
    if (b % 4 === 1 || b % 4 === 3) snare(t);
    hat(t + P / 2);
  };
  part('groove', 16, fullGroove);
  part('breakdown', 8, (b, t) => {
    if (b % 2 === 0) hat(t + P / 2);
  });
  part('build', 8, (b, t, n) => {
    const progress = b / n;
    const per = progress < 0.5 ? 1 : progress < 0.75 ? 2 : 4;
    for (let h = 0; h < per; h++) snare(t + (h * P) / per);
    if (b < n - 4) kick(t);
  });
  part('drop', 16, fullGroove);
  part('breakdown', 8, (b, t) => {
    if (b % 2 === 0) hat(t + P / 2);
  });
  part('groove', 8, fullGroove);
  hits.sort((a, b) => a.t - b.t);
  return { hits, parts, kicks, P, end: t0 };
}
