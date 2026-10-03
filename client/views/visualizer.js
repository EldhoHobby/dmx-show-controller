// Real-time 3D stage view in plain WebGL (no library, so it works offline at the venue).
//
// It evaluates the show with the same shared code the engine uses, at the same transport
// position, so the beams on screen are what the DMX output is doing. Beams are additive cones
// with a soft core; floor spots appear where beams hit the floor. Gobos break a beam into
// narrow shafts with patterned floor spots and prisms split it in three (shared/beam-shapes.js);
// pixel bars glow cell by cell, each cell with a beam of its own.
//
// Mouse/touch: drag to orbit, wheel or pinch to zoom, double-click to reset the camera.

import { beamDirection, floorHit } from '/shared/kinematics.js';
import { beamAngle, cellOffsets } from '/shared/fixture-library.js';
import { softwareStrobeOn } from '/shared/dmx-render.js';
import { beamParts } from '/shared/beam-shapes.js';

const VS = `
attribute vec3 aPos;
attribute float aAlpha;
uniform mat4 uMvp;
varying float vAlpha;
void main() {
  vAlpha = aAlpha;
  gl_Position = uMvp * vec4(aPos, 1.0);
}`;

const FS = `
precision mediump float;
uniform vec4 uColor;
varying float vAlpha;
void main() {
  gl_FragColor = vec4(uColor.rgb, uColor.a * vAlpha);
}`;

// ---- Matrices (column-major, as WebGL expects) ---------------------------------------

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}

function lookAt(eye, center, up) {
  let zx = eye[0] - center[0];
  let zy = eye[1] - center[1];
  let zz = eye[2] - center[2];
  let len = Math.hypot(zx, zy, zz);
  zx /= len;
  zy /= len;
  zz /= len;
  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz);
  xx /= len;
  xy /= len;
  xz /= len;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  return new Float32Array([
    xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ]);
}

function multiply(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

/** Model matrix whose local X/Y/Z axes map to the given world vectors, scaled, then moved. */
function basisMatrix(pos, ax, ay, az, sx, sy, sz) {
  return new Float32Array([
    ax[0] * sx, ax[1] * sx, ax[2] * sx, 0,
    ay[0] * sy, ay[1] * sy, ay[2] * sy, 0,
    az[0] * sz, az[1] * sz, az[2] * sz, 0,
    pos[0], pos[1], pos[2], 1,
  ]);
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

// ---- Geometry (x, y, z, alpha per vertex) --------------------------------------------

function coneGeometry(segments = 28) {
  const v = [];
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    v.push(0, 0, 0, 1, Math.cos(a0), 1, Math.sin(a0), 0, Math.cos(a1), 1, Math.sin(a1), 0);
  }
  return new Float32Array(v);
}

function discGeometry(segments = 32) {
  const v = [];
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    v.push(0, 0, 0, 1, Math.cos(a0), 0, Math.sin(a0), 0, Math.cos(a1), 0, Math.sin(a1), 0);
  }
  return new Float32Array(v);
}

function boxGeometry() {
  const p = [
    [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5],
    [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5],
  ];
  const faces = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [0, 3, 7, 4], [1, 2, 6, 5]];
  const v = [];
  for (const [a, b, c, d] of faces) for (const i of [a, b, c, a, c, d]) v.push(...p[i], 1);
  return new Float32Array(v);
}

function quadGeometry() {
  return new Float32Array([0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 1, 0, 0, 1, 1]);
}

function gridGeometry(x0, x1, z0, z1) {
  const v = [];
  for (let x = x0; x <= x1; x++) v.push(x, 0, z0, 1, x, 0, z1, 1);
  for (let z = z0; z <= z1; z++) v.push(x0, 0, z, 1, x1, 0, z, 1);
  return new Float32Array(v);
}

export class Visualizer {
  constructor(store, canvas, { label = null } = {}) {
    this.store = store;
    this.canvas = canvas;
    this.label = label;
    this.cam = { yaw: 0, pitch: 0.28, dist: 15, target: [0, 1.6, 1.5] };
    this.running = false;
    this.init();
    this.bindControls();
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.gl = null;
    });
    canvas.addEventListener('webglcontextrestored', () => this.init());
  }

  init() {
    const gl = this.canvas.getContext('webgl', { antialias: true, alpha: false, premultipliedAlpha: false });
    if (!gl) {
      this.gl = null;
      if (this.label) this.label.textContent = 'WebGL is not available in this browser.';
      return;
    }
    this.gl = gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    this.prog = prog;
    this.loc = {
      pos: gl.getAttribLocation(prog, 'aPos'),
      alpha: gl.getAttribLocation(prog, 'aAlpha'),
      mvp: gl.getUniformLocation(prog, 'uMvp'),
      color: gl.getUniformLocation(prog, 'uColor'),
    };
    const buffer = (data) => {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      return { buf: b, count: data.length / 4 };
    };
    this.geo = {
      cone: buffer(coneGeometry()),
      disc: buffer(discGeometry()),
      box: buffer(boxGeometry()),
      quad: buffer(quadGeometry()),
      grid: buffer(gridGeometry(-12, 12, -12, 14)),
    };
  }

  bindControls() {
    const c = this.canvas;
    const pointers = new Map();
    let pinch = 0;
    c.style.touchAction = 'none';
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    c.addEventListener('pointermove', (e) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      if (pointers.size === 1) {
        this.cam.yaw -= (e.clientX - p.x) * 0.006;
        this.cam.pitch = Math.max(-0.1, Math.min(1.45, this.cam.pitch + (e.clientY - p.y) * 0.005));
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch) this.zoom(pinch / d);
        pinch = d;
      }
      p.x = e.clientX;
      p.y = e.clientY;
    });
    const up = (e) => {
      pointers.delete(e.pointerId);
      pinch = 0;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoom(Math.exp(e.deltaY * 0.001));
      },
      { passive: false },
    );
    c.addEventListener('dblclick', () => {
      this.cam = { yaw: 0, pitch: 0.28, dist: 15, target: [0, 1.6, 1.5] };
    });
  }

  zoom(factor) {
    this.cam.dist = Math.max(3, Math.min(45, this.cam.dist * factor));
  }

  start() {
    if (this.running) return;
    this.running = true;
    // At most 30 frames a second: the DMX output itself runs at 40, and a laptop showing the
    // 3D view in three windows at the screen's 60-144 Hz had no processor left for the engine.
    let last = 0;
    const loop = (now = performance.now()) => {
      if (!this.running) return;
      if (now - last >= 1000 / 30 - 4) {
        last = now;
        this.render();
      }
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  draw(geo, mode, mvp, color) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, geo.buf);
    gl.vertexAttribPointer(this.loc.pos, 3, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(this.loc.alpha, 1, gl.FLOAT, false, 16, 12);
    gl.uniformMatrix4fv(this.loc.mvp, false, mvp);
    gl.uniform4fv(this.loc.color, color);
    gl.drawArrays(mode, 0, geo.count);
  }

  render() {
    const gl = this.gl;
    const { store } = this;
    if (!gl || !store.show) return;
    const cssW = this.canvas.clientWidth;
    const cssH = this.canvas.clientHeight;
    if (!cssW || !cssH) return; // hidden
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(cssW * dpr);
    const h = Math.round(cssH * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.024, 0.027, 0.035, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.enableVertexAttribArray(this.loc.pos);
    gl.enableVertexAttribArray(this.loc.alpha);

    const { yaw, pitch, dist, target } = this.cam;
    const eye = [
      target[0] + dist * Math.cos(pitch) * Math.sin(yaw),
      target[1] + dist * Math.sin(pitch),
      target[2] + dist * Math.cos(pitch) * Math.cos(yaw),
    ];
    const vp = multiply(perspective(0.85, w / h, 0.1, 200), lookAt(eye, target, [0, 1, 0]));

    // Solid pass: floor, stage, fixture bodies.
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    this.draw(this.geo.grid, gl.LINES, vp, [0.13, 0.15, 0.18, 1]);
    const stage = store.show.stage;
    const stageM = basisMatrix([-stage.width / 2, 0.005, -stage.depth], [1, 0, 0], [0, 1, 0], [0, 0, 1], stage.width, 1, stage.depth);
    this.draw(this.geo.quad, gl.TRIANGLES, multiply(vp, stageM), [0.09, 0.1, 0.13, 1]);
    const aud = stage.audience;
    const audM = basisMatrix([aud.x - 0.4, 0.01, aud.z - 0.4], [1, 0, 0], [0, 1, 0], [0, 0, 1], 0.8, 1, 0.8);
    this.draw(this.geo.quad, gl.TRIANGLES, multiply(vp, audM), [0.4, 0.28, 0.05, 1]);

    const ev = store.evaluator();
    const position = store.positionNow();
    const states = ev.evaluate(position, store.liveContext(), store.net.serverNow());
    const wall = performance.now();
    const beams = [];
    const glows = [];
    const lit = (st) => {
      if (!st) return 0;
      let dim = Math.max(0, Math.min(1, st.dimmer));
      if (st.strobe > 0.001 && !softwareStrobeOn(st.strobe, wall)) dim = 0;
      return dim < 0.01 ? 0 : dim;
    };
    for (const rec of ev.fixtures) {
      const f = rec.fixture;
      const s = states.get(rec.id);
      const pos = [f.position.x, f.position.y, f.position.z];
      const m = rec.matrix;
      const ax = [m[0], m[3], m[6]];
      const ay = [m[1], m[4], m[7]];
      const az = [m[2], m[5], m[8]];
      if (rec.cells) {
        // A pixel bar: a slim body the length of its cells, every cell glowing and shining.
        const offs = cellOffsets(rec.profile);
        const xs = offs.map((o) => o[0]);
        const zs = offs.map((o) => o[1]);
        const pitch = offs.length > 1 ? Math.max(0.03, Math.abs(xs[1] - xs[0]) || Math.abs(zs[1] - zs[0])) : 0.12;
        const width = Math.max(...xs) - Math.min(...xs) + pitch;
        const depth = Math.max(...zs) - Math.min(...zs) + pitch;
        this.draw(this.geo.box, gl.TRIANGLES, multiply(vp, basisMatrix(pos, ax, ay, az, width, 0.07, Math.max(0.1, depth))), [0.2, 0.22, 0.26, 1]);
        for (const cell of rec.cells) {
          const cs = states.get(cell.id);
          const dim = lit(cs);
          if (!dim) continue;
          const cp = [cell.fixture.position.x, cell.fixture.position.y, cell.fixture.position.z];
          const face = [cp[0] + ay[0] * 0.04, cp[1] + ay[1] * 0.04, cp[2] + ay[2] * 0.04];
          glows.push({ m: basisMatrix(face, ax, ay, az, pitch * 0.8, 0.02, pitch * 0.8), color: cs.color, dim });
          // Pixels are watched directly: a short, faint wash rather than a long beam.
          beams.push({ pos: cp, dir: beamDirection(f, 0, 0, m), dim: dim * 0.22, color: cs.color, angle: beamAngle(rec.profile, cs.zoom), maxLen: 4, spot: false });
        }
        continue;
      }
      const bodyM = basisMatrix(pos, ax, ay, az, 0.32, rec.caps.panTilt ? 0.42 : 0.22, 0.32);
      this.draw(this.geo.box, gl.TRIANGLES, multiply(vp, bodyM), rec.caps.panTilt ? [0.3, 0.32, 0.37, 1] : [0.24, 0.26, 0.3, 1]);
      if (!rec.caps.emitsLight || !s) continue;
      const dim = lit(s);
      if (!dim) continue;
      const dir = rec.caps.panTilt ? beamDirection(f, s.pan, s.tilt, m) : beamDirection(f, 0, 0, m);
      beams.push({ pos, dir, dim, color: s.color, angle: beamAngle(rec.profile, s.zoom), gobo: rec.caps.gobo ? s.gobo : 0, prism: rec.caps.prism ? s.prism : 0 });
    }

    // Light pass: additive, no depth writes, so overlapping beams add up like real light.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.depthMask(false);
    for (const g of glows) {
      // Twice: the pixel itself, and a soft glow around it.
      this.draw(this.geo.box, gl.TRIANGLES, multiply(vp, g.m), [g.color[0], g.color[1], g.color[2], g.dim]);
      this.draw(this.geo.box, gl.TRIANGLES, multiply(vp, multiply(g.m, new Float32Array([1.8, 0, 0, 0, 0, 1.5, 0, 0, 0, 0, 1.8, 0, 0, 0, 0, 1]))), [g.color[0], g.color[1], g.color[2], 0.25 * g.dim]);
    }
    for (const b of beams) {
      const col = b.color;
      for (const part of beamParts(b.dir, b.angle, b.gobo || 0, b.prism || 0)) {
        const dir = part.dir;
        const dim = b.dim * part.share;
        const hit = floorHit({ x: b.pos[0], y: b.pos[1], z: b.pos[2] }, dir);
        const len = Math.min(b.maxLen || 22, hit ? hit.distance : 16);
        const half = (part.angle * Math.PI) / 360;
        const radius = len * Math.tan(half);
        const helper = Math.abs(dir[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
        const u = norm(cross(helper, dir));
        const wv = cross(u, dir);
        if (part.shaped) {
          // A gobo shaft: crisp, no soft halo.
          const shaft = basisMatrix(b.pos, u, dir, wv, radius, len, radius);
          this.draw(this.geo.cone, gl.TRIANGLES, multiply(vp, shaft), [col[0], col[1], col[2], 0.3 * dim]);
        } else {
          const outer = basisMatrix(b.pos, u, dir, wv, radius, len, radius);
          this.draw(this.geo.cone, gl.TRIANGLES, multiply(vp, outer), [col[0], col[1], col[2], 0.16 * dim]);
          const inner = basisMatrix(b.pos, u, dir, wv, radius * 0.45, len * 0.85, radius * 0.45);
          this.draw(this.geo.cone, gl.TRIANGLES, multiply(vp, inner), [col[0], col[1], col[2], 0.22 * dim]);
        }
        if (hit && hit.distance < 30 && b.spot !== false) {
          const r = Math.max(part.shaped ? 0.05 : 0.15, hit.distance * Math.tan(half) * 1.15);
          const spot = basisMatrix([hit.x, 0.02, hit.z], [1, 0, 0], [0, 1, 0], [0, 0, 1], r, 1, r);
          this.draw(this.geo.disc, gl.TRIANGLES, multiply(vp, spot), [col[0], col[1], col[2], (part.shaped ? 0.9 : 0.7) * dim]);
        }
      }
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }
}
