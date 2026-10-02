// Small helpers shared by the engine (Node) and the browser client.
// Everything in /shared must run unchanged in both environments: no Node or DOM APIs.

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const fract = (v) => v - Math.floor(v);
export const mod = (n, m) => ((n % m) + m) % m;
export const smoothstep = (t) => t * t * (3 - 2 * t);

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Short random id with a readable prefix, e.g. "fx_k2j9q0ab". */
export function uid(prefix = 'id') {
  let s = '';
  for (let i = 0; i < 8; i++) s += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  return `${prefix}_${s}`;
}

export function deepClone(v) {
  return v === undefined ? undefined : structuredClone(v);
}

export function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Deterministic 32-bit integer hash; used for repeatable "random" chases. */
export function hash32(n) {
  let x = (n | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

/** Seeded PRNG (mulberry32). Returns a function producing floats in [0, 1). */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function stringHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Binary search: index of the last element <= value in an ascending array, or -1. */
export function lastIndexAtOrBefore(sorted, value) {
  let lo = 0;
  let hi = sorted.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= value) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

export function median(values) {
  if (!values.length) return 0;
  const s = Float64Array.from(values).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function formatTime(ms, withMillis = true) {
  const neg = ms < 0;
  const t = Math.abs(ms);
  const m = Math.floor(t / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const msPart = Math.floor(t % 1000);
  const base = `${neg ? '-' : ''}${m}:${String(s).padStart(2, '0')}`;
  return withMillis ? `${base}.${String(msPart).padStart(3, '0')}` : base;
}
