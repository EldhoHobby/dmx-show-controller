// Moving-head geometry. World space is metres: +X stage right (as seen from the audience),
// +Y up, +Z toward the audience. A fixture's "home" beam (pan 0, tilt 0) points along its
// local +Y axis, i.e. out of the base. Tilt swings the beam toward local +Z, pan turns it
// about local +Y. Fixture rotation is Euler XYZ in degrees, applied X then Y then Z.
//
// Typical mounting:
//   floor, beam up         rotation { x: 0,   y: 0, z: 0 }
//   hung from truss, down  rotation { x: 180, y: 0, z: 0 }
//   on a wall, at audience rotation { x: 90,  y: 0, z: 0 }

import { clamp } from './util.js';
import { panRange, tiltRange } from './fixture-library.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** 3x3 rotation matrix (row-major) for Euler angles in degrees, R = Rz * Ry * Rx. */
export function rotationMatrix(rot = {}) {
  const x = (rot.x || 0) * D2R;
  const y = (rot.y || 0) * D2R;
  const z = (rot.z || 0) * D2R;
  const cx = Math.cos(x), sx = Math.sin(x);
  const cy = Math.cos(y), sy = Math.sin(y);
  const cz = Math.cos(z), sz = Math.sin(z);
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ];
}

function mulVec(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

function mulVecTransposed(m, v) {
  return [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];
}

export function localBeamDirection(panDeg, tiltDeg) {
  const p = panDeg * D2R;
  const t = tiltDeg * D2R;
  return [Math.sin(t) * Math.sin(p), Math.cos(t), Math.sin(t) * Math.cos(p)];
}

/** World-space unit vector of the beam for a fixture at the given pan/tilt (degrees). */
export function beamDirection(fixture, panDeg, tiltDeg, matrix = rotationMatrix(fixture.rotation)) {
  return mulVec(matrix, localBeamDirection(panDeg, tiltDeg));
}

/**
 * Pan/tilt (degrees, relative to home) that points the fixture at a world-space target.
 * Picks the reachable solution closest to home; clamps when the target is out of range.
 */
export function aimAt(fixture, target, profile, matrix = rotationMatrix(fixture.rotation)) {
  const pos = fixture.position || { x: 0, y: 0, z: 0 };
  let v = [target.x - pos.x, target.y - pos.y, target.z - pos.z];
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len < 1e-6) return { pan: 0, tilt: 0, reachable: true };
  v = v.map((c) => c / len);
  const l = mulVecTransposed(matrix, v);
  const tilt = Math.acos(clamp(l[1], -1, 1)) * R2D;
  const pan = Math.atan2(l[0], l[2]) * R2D;
  const halfPan = panRange(profile) / 2;
  const halfTilt = tiltRange(profile) / 2;
  const candidates = [
    { pan, tilt },
    { pan: pan + 180, tilt: -tilt },
    { pan: pan - 180, tilt: -tilt },
    { pan: pan + 360, tilt },
    { pan: pan - 360, tilt },
  ];
  let best = null;
  for (const c of candidates) {
    if (Math.abs(c.pan) <= halfPan + 1e-9 && Math.abs(c.tilt) <= halfTilt + 1e-9) {
      const cost = Math.abs(c.pan) + Math.abs(c.tilt);
      if (!best || cost < best.cost) best = { ...c, cost };
    }
  }
  if (best) return { pan: best.pan, tilt: best.tilt, reachable: true };
  return { pan: clamp(pan, -halfPan, halfPan), tilt: clamp(tilt, -halfTilt, halfTilt), reachable: false };
}

/** Where the beam axis meets the floor (y = 0), or null when it points up or sideways. */
export function floorHit(position, dir) {
  if (dir[1] > -1e-4) return null;
  const d = -position.y / dir[1];
  return { x: position.x + dir[0] * d, y: 0, z: position.z + dir[2] * d, distance: d };
}
