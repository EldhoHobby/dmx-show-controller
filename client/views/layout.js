// Stage layout editor: drag fixtures to place them, drag the handle on a beam line to aim them.
//
// Three views of the same stage, in metres, on the axes used everywhere else:
//   Top    from above: X left to right as the audience sees it, the audience at the bottom
//   Front  as the audience sees it: X across, height Y up
//   Side   from the side: upstage on the left, the audience on the right, height Y up
//
// The line from a fixture shows where its beam points with pan and tilt at zero (a moving
// head's home, straight out of its base). In the top view its handle turns the fixture
// (rotation Y); in the front and side views it tilts it (rotation X) and keeps the turn.
// Fixtures given a roll (rotation Z) in the inspector can be moved here but not aimed.

import { h, mount, fitCanvas } from '../lib/dom.js';
import { resolveProfile, profileCaps, fixtureRole } from '/shared/fixture-library.js';
import { rotationMatrix } from '/shared/kinematics.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
export const ROLE_COLORS = { mover: '#f5a524', wash: '#4f9dff', strobe: '#e7eaf0', dimmer: '#b48cff' };

const VIEWS = {
  top: { label: 'Top', h: 'x', v: 'z', up: false, hint: 'from above · audience at the bottom' },
  front: { label: 'Front', h: 'x', v: 'y', up: true, hint: 'as the audience sees it' },
  side: { label: 'Side', h: 'z', v: 'y', up: true, hint: 'from the side · audience on the right' },
};

const GRID = 0.25; // metres
const ANGLE_STEP = 5; // degrees
const round2 = (v) => Math.round(v * 100) / 100;
const round1 = (v) => Math.round(v * 10) / 10;
const snap = (v, step) => Math.round(v / step) * step;
/** Degrees into (-180, 180]. */
function normDeg(a) {
  const x = ((((a + 180) % 360) + 360) % 360) - 180;
  return x === -180 ? 180 : x;
}
const col = (m, i) => [m[i], m[3 + i], m[6 + i]];
const AX = { x: 0, y: 1, z: 2 };

function load(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

export class LayoutEditor {
  constructor(store) {
    this.store = store;
    this.view = VIEWS[load('layoutView', 'top')] ? load('layoutView', 'top') : 'top';
    this.canvas = h('canvas', { class: 'layout-canvas', tabindex: '0', 'aria-label': 'Stage layout. Drag fixtures to move them; arrow keys nudge the selection.' });
    this.readout = h('span', { class: 'muted mono layout-readout' });
    this.tabs = h('div', { class: 'seg', role: 'tablist' });
    this.drag = null;
    this.hover = null;
    this.preview = new Map(); // fixture id -> { position, rotation } while dragging
    this.map = null;
    this.items = [];
    this.el = h('div', { class: 'card layout-card' },
      h('div', { class: 'row wrap', style: { marginBottom: '8px' } },
        h('h2', { style: { margin: 0 } }, 'Stage layout'),
        this.tabs,
        h('div', { class: 'grow' }),
        this.readout,
      ),
      h('div', { class: 'layout-wrap' }, this.canvas),
      h('p', { class: 'muted layout-hint' },
        'Drag a fixture to move it, or the dot at the end of its beam line to aim it. Shift- or Ctrl-click picks several; drag across empty space to pick an area. ',
        'Snaps to 25 cm and 5° (hold Alt for free movement). Arrow keys nudge the selection 10 cm (Shift: 50 cm).'),
    );
    this.renderTabs();

    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('pointercancel', () => this.cancel());
    c.addEventListener('lostpointercapture', () => this.drag && this.cancel());
    c.addEventListener('pointerleave', () => {
      if (!this.drag && this.hover) {
        this.hover = null;
        this.draw();
      }
    });
    c.addEventListener('keydown', (e) => this.onKey(e));
    new ResizeObserver(() => this.draw()).observe(c);
    store.on('show', () => this.draw());
    store.on('selection', () => this.draw());
  }

  renderTabs() {
    mount(this.tabs, Object.entries(VIEWS).map(([id, v]) =>
      h('button', {
        class: id === this.view ? 'active' : '',
        role: 'tab',
        'aria-selected': String(id === this.view),
        title: v.hint,
        onclick: () => {
          this.view = id;
          try {
            localStorage.setItem('layoutView', id);
          } catch {}
          this.renderTabs();
          this.draw();
        },
      }, v.label)));
  }

  // ---- Geometry ------------------------------------------------------------------------

  fixtureNow(f) {
    const p = this.preview.get(f.id);
    return p ? { ...f, position: p.position || f.position, rotation: p.rotation || f.rotation } : f;
  }

  computeMap(w, hgt) {
    const show = this.store.show;
    const V = VIEWS[this.view];
    const st = show.stage;
    const ext = { x: [-st.width / 2, st.width / 2], y: [0, st.height], z: [-st.depth, 0.5] };
    const grow = (p) => {
      for (const k of ['x', 'y', 'z']) {
        ext[k][0] = Math.min(ext[k][0], p[k]);
        ext[k][1] = Math.max(ext[k][1], p[k]);
      }
    };
    for (const f of show.fixtures) grow(f.position);
    grow(st.audience);
    const margin = 0.8;
    const [h0, h1] = [ext[V.h][0] - margin, ext[V.h][1] + margin];
    const [v0, v1] = [ext[V.v][0] - margin, ext[V.v][1] + margin];
    const pad = 18;
    const scale = Math.max(4, Math.min((w - pad * 2) / (h1 - h0), (hgt - pad * 2) / (v1 - v0)));
    const ox = (w - (h1 - h0) * scale) / 2;
    const oy = (hgt - (v1 - v0) * scale) / 2;
    return { V, h0, h1, v0, v1, scale, ox, oy, w, hgt };
  }

  toScreen(p) {
    const m = this.map;
    const x = m.ox + (p[m.V.h] - m.h0) * m.scale;
    const y = m.V.up ? m.oy + (m.v1 - p[m.V.v]) * m.scale : m.oy + (p[m.V.v] - m.v0) * m.scale;
    return [x, y];
  }

  /** World coordinates of a screen point on the view's two axes. */
  toWorld(sx, sy) {
    const m = this.map;
    return {
      [m.V.h]: m.h0 + (sx - m.ox) / m.scale,
      [m.V.v]: m.V.up ? m.v1 - (sy - m.oy) / m.scale : m.v0 + (sy - m.oy) / m.scale,
    };
  }

  /** Screen direction (unit-ish) of a world vector projected onto this view. */
  projectDir(d) {
    const V = this.map.V;
    const x = d[AX[V.h]];
    const y = V.up ? -d[AX[V.v]] : d[AX[V.v]];
    return [x, y];
  }

  /**
   * The line drawn from a fixture and whether its handle can aim it in this view.
   * Returns { dir: [sx, sy] screen direction, len: projected length 0..1, front: bool, aim: bool }.
   */
  arrowFor(f, rec) {
    const m = rotationMatrix(f.rotation);
    const beam = col(m, 1);
    const roll = Math.abs(normDeg(f.rotation?.z || 0)) > 0.5;
    if (this.view === 'top') {
      // A beam pointing straight up or down has no direction from above; a moving head
      // then shows its front (where tilt swings to), which the turn handle sets instead.
      let v = beam;
      let front = false;
      if (Math.hypot(beam[0], beam[2]) < 0.35 && rec.caps.panTilt) {
        v = col(m, 2);
        front = true;
      }
      const len = Math.hypot(v[0], v[2]);
      return { dir: this.projectDir(v), len, front, aim: len >= 0.35 && !roll, vec: v };
    }
    const ry = (f.rotation?.y || 0) * D2R;
    const lever = this.view === 'side' ? Math.cos(ry) : Math.sin(ry);
    const [dx, dy] = this.projectDir(beam);
    return { dir: [dx, dy], len: Math.hypot(dx, dy), front: false, aim: Math.abs(lever) >= 0.25 && !roll, vec: beam };
  }

  // ---- Drawing -------------------------------------------------------------------------

  draw() {
    const show = this.store.show;
    if (!show || !this.canvas.isConnected) return;
    const { ctx, w, h: hgt } = fitCanvas(this.canvas);
    if (!this.drag) this.map = this.computeMap(w, hgt);
    const m = this.map;
    const V = m.V;
    ctx.fillStyle = '#0d0f13';
    ctx.fillRect(0, 0, w, hgt);

    // 1 m grid, stronger every 5 m.
    ctx.lineWidth = 1;
    for (let a = Math.ceil(m.h0); a <= m.h1; a++) {
      const [x] = this.toScreen({ [V.h]: a, [V.v]: m.v0 });
      ctx.strokeStyle = a % 5 === 0 ? '#232a35' : '#171c24';
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, hgt);
      ctx.stroke();
    }
    for (let b = Math.ceil(m.v0); b <= m.v1; b++) {
      const [, y] = this.toScreen({ [V.h]: m.h0, [V.v]: b });
      ctx.strokeStyle = b % 5 === 0 ? '#232a35' : '#171c24';
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(w, Math.round(y) + 0.5);
      ctx.stroke();
    }

    this.drawStage(ctx, show.stage);

    // Fixtures.
    const selected = this.store.ui.selectedFixtures;
    const aud = show.stage.audience;
    const [ax, ay] = this.toScreen(aud);
    const items = [];
    for (const f0 of show.fixtures) {
      const f = this.fixtureNow(f0);
      const profile = resolveProfile(show, f.profileId);
      const caps = profile ? profileCaps(profile) : { panTilt: false };
      const role = profile ? fixtureRole(profile) : 'dimmer';
      const [x, y] = this.toScreen(f.position);
      const rec = { id: f.id, f, caps, role, x, y, sel: selected.has(f.id) };
      rec.arrow = this.arrowFor(f, rec);
      items.push(rec);
    }
    this.items = items;
    const showNames = items.length <= 24 || m.scale > 40;
    for (const r of items) {
      if (!r.caps.panTilt) continue;
      ctx.strokeStyle = r.sel ? 'rgba(245,165,36,0.45)' : 'rgba(245,165,36,0.16)';
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(r.x, r.y);
      ctx.lineTo(ax, ay);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const r of items) {
      const color = ROLE_COLORS[r.role] || '#8d96a7';
      const a = r.arrow;
      const active = r.sel || this.hover?.id === r.id || this.drag?.id === r.id;
      // Beam line: its true projected length, so a beam pointing into the screen looks short.
      const L = 40;
      const n = Math.hypot(a.dir[0], a.dir[1]) || 1;
      const reach = Math.max(14, L * a.len);
      r.hx = r.x + (a.dir[0] / n) * reach;
      r.hy = r.y + (a.dir[1] / n) * reach;
      if (a.len > 0.05) {
        ctx.strokeStyle = active ? color : `${color}88`;
        ctx.lineWidth = active ? 2 : 1.5;
        if (a.front) ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(r.x, r.y);
        ctx.lineTo(r.hx, r.hy);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        // Pointing straight at or away from the viewer.
        ctx.strokeStyle = `${color}aa`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(r.x, r.y, 13, 0, Math.PI * 2);
        ctx.stroke();
      }
      // Body.
      ctx.fillStyle = r.sel ? color : '#2a313d';
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (r.caps.panTilt) ctx.arc(r.x, r.y, 8, 0, Math.PI * 2);
      else ctx.roundRect(r.x - 7, r.y - 7, 14, 14, 3);
      ctx.fill();
      ctx.stroke();
      // Aim handle.
      if (active && a.aim && a.len > 0.05) {
        ctx.fillStyle = '#0d0f13';
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(r.hx, r.hy, 5.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }

    // Names: selected and hovered first; a name that would overlap one already drawn is left out.
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    const boxes = [];
    const isActive = (r) => r.sel || this.hover?.id === r.id || this.drag?.id === r.id;
    for (const r of [...items].sort((a, b) => isActive(b) - isActive(a))) {
      if (!showNames && !isActive(r)) continue;
      const tw = ctx.measureText(r.f.name).width;
      const box = [r.x - tw / 2 - 3, r.y + 11, tw + 6, 13];
      if (boxes.some((b) => box[0] < b[0] + b[2] && b[0] < box[0] + box[2] && box[1] < b[1] + b[3] && b[1] < box[1] + box[3])) continue;
      boxes.push(box);
      ctx.fillStyle = isActive(r) ? '#e7eaf0' : '#8d96a7';
      ctx.fillText(r.f.name, r.x, r.y + 21);
    }

    // Centre point on top of everything.
    ctx.strokeStyle = '#f5a524';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(ax, ay, 7, 0, Math.PI * 2);
    ctx.moveTo(ax - 11, ay);
    ctx.lineTo(ax + 11, ay);
    ctx.moveTo(ax, ay - 11);
    ctx.lineTo(ax, ay + 11);
    ctx.stroke();
    ctx.fillStyle = '#f5a524';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Centre point', ax + 12, ay - 8);

    if (this.drag?.kind === 'band') {
      const b = this.drag;
      ctx.strokeStyle = '#4f9dff';
      ctx.fillStyle = 'rgba(79,157,255,0.1)';
      ctx.lineWidth = 1;
      const rx = Math.min(b.x0, b.x1);
      const ry = Math.min(b.y0, b.y1);
      ctx.fillRect(rx, ry, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      ctx.strokeRect(rx + 0.5, ry + 0.5, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
    }

    ctx.fillStyle = '#5d6676';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${V.label} view · ${V.hint}`, 8, hgt - 8);
  }

  drawStage(ctx, st) {
    const V = this.map.V;
    const line = (a, b, color, width = 1, dash = null) => {
      const [x0, y0] = this.toScreen(a);
      const [x1, y1] = this.toScreen(b);
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash || []);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    const label = (p, text, align = 'left') => {
      const [x, y] = this.toScreen(p);
      ctx.fillStyle = '#5d6676';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = align;
      ctx.fillText(text, x, y);
    };
    const hw = st.width / 2;
    if (V.v === 'z') {
      const [x0, y0] = this.toScreen({ x: -hw, z: -st.depth });
      const [x1, y1] = this.toScreen({ x: hw, z: 0 });
      ctx.fillStyle = '#161b23';
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeStyle = '#2a313d';
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
      line({ x: -hw, z: 0 }, { x: hw, z: 0 }, '#3a4352', 2);
      label({ x: -hw + 0.15, z: -st.depth + 0.4 }, 'STAGE');
      label({ x: -hw + 0.15, z: 0.45 }, 'FRONT EDGE · AUDIENCE ↓');
    } else if (V.h === 'x') {
      line({ x: -hw - 2, y: 0 }, { x: hw + 2, y: 0 }, '#3a4352', 2);
      line({ x: -hw, y: 0 }, { x: -hw, y: st.height }, '#2a313d', 1, [4, 4]);
      line({ x: hw, y: 0 }, { x: hw, y: st.height }, '#2a313d', 1, [4, 4]);
      line({ x: -hw, y: st.height }, { x: hw, y: st.height }, '#2a313d', 1, [4, 4]);
      label({ x: -hw + 0.15, y: st.height - 0.35 }, `STAGE ${st.width} × ${st.height} m`);
    } else {
      line({ z: -st.depth - 1, y: 0 }, { z: 12, y: 0 }, '#2a313d', 1);
      line({ z: -st.depth, y: 0 }, { z: 0, y: 0 }, '#3a4352', 3);
      line({ z: -st.depth, y: 0 }, { z: -st.depth, y: st.height }, '#2a313d', 1, [4, 4]);
      label({ z: -st.depth + 0.15, y: st.height - 0.35 }, 'UPSTAGE');
      label({ z: 0.2, y: 0.25 }, 'AUDIENCE →');
    }
  }

  // ---- Interaction ---------------------------------------------------------------------

  pointer(e) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  hit(sx, sy) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const r = this.items[i];
      const active = r.sel || this.hover?.id === r.id;
      if (active && r.arrow.aim && r.arrow.len > 0.05 && Math.hypot(sx - r.hx, sy - r.hy) <= 9) return { kind: 'aim', rec: r };
    }
    for (let i = this.items.length - 1; i >= 0; i--) {
      const r = this.items[i];
      if (Math.hypot(sx - r.x, sy - r.y) <= 11) return { kind: 'body', rec: r };
    }
    return null;
  }

  onDown(e) {
    if (e.button !== 0 || !this.store.show) return;
    this.canvas.focus({ preventScroll: true });
    const [sx, sy] = this.pointer(e);
    const target = this.hit(sx, sy);
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const sel = this.store.ui.selectedFixtures;
    this.canvas.setPointerCapture(e.pointerId);
    if (target?.kind === 'aim') {
      this.drag = { kind: 'aim', id: target.rec.id, start: target.rec.f.rotation, moved: false };
      return;
    }
    if (target?.kind === 'body') {
      const id = target.rec.id;
      let toggleOff = false;
      if (!sel.has(id)) this.store.selectFixtures([id], additive);
      else if (additive) toggleOff = true;
      const ids = [...this.store.ui.selectedFixtures];
      const starts = new Map(this.store.show.fixtures.filter((f) => ids.includes(f.id)).map((f) => [f.id, { ...f.position }]));
      this.drag = { kind: 'move', id, starts, p0: this.toWorld(sx, sy), moved: false, toggleOff };
      return;
    }
    if (!additive && sel.size) this.store.selectFixtures([]);
    this.drag = { kind: 'band', x0: sx, y0: sy, x1: sx, y1: sy, additive, moved: false, base: new Set(this.store.ui.selectedFixtures) };
  }

  onMove(e) {
    const [sx, sy] = this.pointer(e);
    const d = this.drag;
    if (!d) {
      const t = this.hit(sx, sy);
      const id = t?.rec.id || null;
      this.canvas.style.cursor = t?.kind === 'aim' ? 'crosshair' : t ? 'move' : 'default';
      if ((this.hover?.id || null) !== id) {
        this.hover = id ? { id } : null;
        this.draw();
      }
      this.showReadout(t?.rec.f || null);
      return;
    }
    const V = this.map.V;
    if (d.kind === 'move') {
      const p = this.toWorld(sx, sy);
      const grabbed = d.starts.get(d.id);
      if (!grabbed) return;
      let dh = p[V.h] - d.p0[V.h];
      let dv = p[V.v] - d.p0[V.v];
      if (!d.moved && Math.hypot(dh, dv) * this.map.scale < 3) return;
      d.moved = true;
      if (!e.altKey) {
        dh = snap(grabbed[V.h] + dh, GRID) - grabbed[V.h];
        dv = snap(grabbed[V.v] + dv, GRID) - grabbed[V.v];
      }
      this.preview.clear();
      for (const [id, s] of d.starts) {
        const position = { ...s, [V.h]: round2(s[V.h] + dh), [V.v]: round2(s[V.v] + dv) };
        if (position.y < -1) position.y = -1;
        this.preview.set(id, { position });
      }
      const f = this.store.show.fixtures.find((x) => x.id === d.id);
      if (f) this.showReadout(this.fixtureNow(f));
    } else if (d.kind === 'aim') {
      const f = this.store.show.fixtures.find((x) => x.id === d.id);
      if (!f) return;
      const rotation = this.aimRotation(f, sx, sy, !e.altKey);
      if (!rotation) return;
      d.moved = true;
      this.preview.set(d.id, { rotation });
      this.readout.textContent = `${f.name} · tilt ${rotation.x}° · turn ${rotation.y}°`;
    } else if (d.kind === 'band') {
      d.x1 = sx;
      d.y1 = sy;
      d.moved = d.moved || Math.hypot(sx - d.x0, sy - d.y0) > 3;
      if (d.moved) {
        const [x0, x1] = [Math.min(d.x0, d.x1), Math.max(d.x0, d.x1)];
        const [y0, y1] = [Math.min(d.y0, d.y1), Math.max(d.y0, d.y1)];
        const inside = this.items.filter((r) => r.x >= x0 && r.x <= x1 && r.y >= y0 && r.y <= y1).map((r) => r.id);
        // The rest of the page hears about it once, on release.
        const sel = this.store.ui.selectedFixtures;
        sel.clear();
        for (const id of [...(d.additive ? d.base : []), ...inside]) sel.add(id);
      }
    }
    this.draw();
  }

  /** New rotation that points the fixture's arrow at the pointer (null if not possible). */
  aimRotation(f, sx, sy, snapping) {
    const rot = { x: f.rotation?.x || 0, y: f.rotation?.y || 0, z: f.rotation?.z || 0 };
    const [fx, fy] = this.toScreen(f.position);
    const sdx = sx - fx;
    const sdy = sy - fy;
    if (Math.hypot(sdx, sdy) < 6) return null;
    const V = this.map.V;
    // Pointer direction in world terms on this view's axes.
    const wh = sdx;
    const wv = V.up ? -sdy : sdy;
    const step = snapping ? ANGLE_STEP : 0;
    const finish = (r) => ({ x: round1(normDeg(r.x)), y: round1(normDeg(r.y)), z: r.z });
    if (this.view === 'top') {
      const rec = this.items.find((r) => r.id === f.id);
      const useFront = rec?.arrow.front;
      const local = useFront ? [0, 0, 1] : [0, 1, 0];
      // The arrow's direction from above with no turn; the turn adds to its angle.
      const m0 = rotationMatrix({ x: rot.x, y: 0, z: rot.z });
      const v0 = [m0[0] * local[0] + m0[1] * local[1] + m0[2] * local[2], 0, m0[6] * local[0] + m0[7] * local[1] + m0[8] * local[2]];
      const a0 = Math.atan2(v0[0], v0[2]) * R2D;
      let ry = Math.atan2(wh, wv) * R2D - a0;
      if (step) ry = snap(ry, step);
      return finish({ ...rot, y: ry });
    }
    // Front or side: tilt (rotation X) so the beam's projection points at the pointer.
    // Beam with no roll = [sin y · sin x, cos x, cos y · sin x].
    const ry = rot.y * D2R;
    const lever = this.view === 'side' ? Math.cos(ry) : Math.sin(ry);
    if (Math.abs(lever) < 0.25) return null;
    let rx = Math.atan2(wh / lever, wv) * R2D;
    if (step) rx = snap(rx, step);
    return finish({ ...rot, x: rx });
  }

  async onUp(e) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {}
    if (d.kind === 'band') {
      this.store.emit('selection');
      return this.draw();
    }
    if (d.kind === 'move' && !d.moved) {
      if (d.toggleOff) {
        this.store.ui.selectedFixtures.delete(d.id);
        this.store.emit('selection');
      }
      return this.draw();
    }
    const ops = [];
    for (const [id, p] of this.preview) {
      const changes = {};
      if (p.position) changes.position = p.position;
      if (p.rotation) changes.rotation = p.rotation;
      ops.push({ type: 'fixture.update', id, changes });
    }
    if (!ops.length) return this.draw();
    // Keep showing the new places until the engine confirms them, so nothing jumps back.
    try {
      await this.store.op({ type: 'batch', ops });
    } catch {}
    this.preview.clear();
    this.draw();
  }

  cancel() {
    this.drag = null;
    this.preview.clear();
    this.draw();
  }

  onKey(e) {
    const ids = [...this.store.ui.selectedFixtures];
    if (!ids.length || !this.map) return;
    const V = this.map.V;
    const step = e.shiftKey ? 0.5 : 0.1;
    let dh = 0;
    let dv = 0;
    if (e.key === 'ArrowLeft') dh = -step;
    else if (e.key === 'ArrowRight') dh = step;
    else if (e.key === 'ArrowUp') dv = V.up ? step : -step;
    else if (e.key === 'ArrowDown') dv = V.up ? -step : step;
    else if (e.key === 'Escape') return this.store.selectFixtures([]);
    else return;
    e.preventDefault();
    const ops = this.store.show.fixtures
      .filter((f) => ids.includes(f.id))
      .map((f) => ({ type: 'fixture.update', id: f.id, changes: { position: { ...f.position, [V.h]: round2(f.position[V.h] + dh), [V.v]: round2(f.position[V.v] + dv) } } }));
    this.store.op({ type: 'batch', ops });
  }

  showReadout(f) {
    if (!f) {
      this.readout.textContent = '';
      return;
    }
    const p = f.position;
    this.readout.textContent = `${f.name} · X ${p.x.toFixed(2)} · Y ${p.y.toFixed(2)} · Z ${p.z.toFixed(2)} m`;
  }
}
