// What a beam looks like in the 3D view: an open beam is one soft cone; a gobo breaks it into
// a pattern of narrow shafts (the projected shapes); a prism splits whatever the beam is into
// three copies fanned around its axis, the way a 3-facet prism does. Pure geometry, so the
// 3D view stays simple and this can be tested.

/**
 * Gobo patterns, by wheel slot (slot 0 is open; slots past the end repeat the list). Each is
 * a ring of `ring` shafts at `radius` of the beam's half-angle, `width` of the beam's angle
 * wide, plus an optional shaft in the centre.
 */
export const GOBO_PATTERNS = [
  { name: 'dots', ring: 6, radius: 0.62, width: 0.2 },
  { name: 'triangle', ring: 3, radius: 0.55, width: 0.28, center: true },
  { name: 'star', ring: 8, radius: 0.7, width: 0.14 },
  { name: 'flower', ring: 5, radius: 0.5, width: 0.24, center: true },
  { name: 'ring', ring: 12, radius: 0.78, width: 0.09 },
  { name: 'cross', ring: 4, radius: 0.45, width: 0.3 },
  { name: 'split', ring: 2, radius: 0.5, width: 0.36 },
];

const D2R = Math.PI / 180;
const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Two unit vectors at right angles to `dir` and to each other. */
function basis(dir) {
  const helper = Math.abs(dir[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
  const u = norm(cross(helper, dir));
  return [u, cross(dir, u)];
}

/** `dir` tipped by `angle` degrees toward the side at `phi` radians around it. */
function tip(dir, u, w, phi, angle) {
  const t = angle * D2R;
  const side = [u[0] * Math.cos(phi) + w[0] * Math.sin(phi), u[1] * Math.cos(phi) + w[1] * Math.sin(phi), u[2] * Math.cos(phi) + w[2] * Math.sin(phi)];
  return norm([dir[0] * Math.cos(t) + side[0] * Math.sin(t), dir[1] * Math.cos(t) + side[1] * Math.sin(t), dir[2] * Math.cos(t) + side[2] * Math.sin(t)]);
}

/** The gobo pattern for a wheel slot, or null when the beam is open. */
export function goboPattern(slot) {
  const n = Math.round(slot) || 0;
  return n >= 1 ? GOBO_PATTERNS[(n - 1) % GOBO_PATTERNS.length] : null;
}

/**
 * The shafts that make up a beam: [{ dir, angle, share, shaped }].
 * @param dir    beam direction (unit vector)
 * @param angle  full beam angle, degrees
 * @param gobo   gobo wheel slot (0 = open)
 * @param prism  0..1, on from 0.5
 * share is each shaft's part of the brightness; shaped marks gobo shafts (drawn crisp).
 */
export function beamParts(dir, angle, gobo = 0, prism = 0) {
  const pattern = goboPattern(gobo);
  const [u, w] = basis(dir);
  // A prism fans out three copies, a little more than half a beam apart.
  const spread = Math.max(5, angle * 0.6);
  const copies = prism >= 0.5 ? [0, 1, 2].map((k) => tip(dir, u, w, (2 * Math.PI * k) / 3 + Math.PI / 2, spread)) : [dir];
  const parts = [];
  for (const d of copies) {
    if (!pattern) {
      parts.push({ dir: d, angle, share: 1 / copies.length, shaped: false });
      continue;
    }
    const [pu, pw] = basis(d);
    const count = pattern.ring + (pattern.center ? 1 : 0);
    const share = Math.min(1, 1.6 / count) / (copies.length > 1 ? 1.5 : 1);
    for (let k = 0; k < pattern.ring; k++) {
      parts.push({ dir: tip(d, pu, pw, (2 * Math.PI * k) / pattern.ring, pattern.radius * (angle / 2)), angle: angle * pattern.width, share, shaped: true });
    }
    if (pattern.center) parts.push({ dir: d, angle: angle * pattern.width, share, shaped: true });
  }
  return parts;
}
