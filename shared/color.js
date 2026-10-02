// Colours are stored as [r, g, b] arrays of 0..1 floats everywhere in the show model.

import { clamp, fract } from './util.js';

export function hsvToRgb(h, s, v) {
  const hh = fract(h) * 6;
  const i = Math.floor(hh);
  const f = hh - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  switch (i) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

export function rgbToHex(rgb) {
  const c = (x) => Math.round(clamp(x, 0, 1) * 255).toString(16).padStart(2, '0');
  return `#${c(rgb[0])}${c(rgb[1])}${c(rgb[2])}`;
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return [1, 1, 1];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function isColor(v) {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
}

export function mixColor(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function colorDistance(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

/** Scale a colour so its brightest component is 1 (hue/saturation only). */
export function normalizeColor(rgb) {
  const m = Math.max(rgb[0], rgb[1], rgb[2]);
  return m > 1e-6 ? [rgb[0] / m, rgb[1] / m, rgb[2] / m] : [1, 1, 1];
}

export const NAMED_COLORS = {
  white: [1, 1, 1],
  warm: [1, 0.72, 0.42],
  red: [1, 0, 0],
  orange: [1, 0.45, 0],
  amber: [1, 0.6, 0],
  yellow: [1, 0.9, 0],
  lime: [0.6, 1, 0],
  green: [0, 1, 0.1],
  cyan: [0, 0.9, 1],
  blue: [0, 0.15, 1],
  violet: [0.45, 0, 1],
  magenta: [1, 0, 0.75],
  pink: [1, 0.25, 0.55],
};
