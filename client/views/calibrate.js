// Prime / Calibrate: make every moving head really meet at the centre point.
//
// Prime sends the moving heads (all, or one at a time) to where the show computes the centre
// point, with an open white beam and the other lights dark. Where a beam lands off the mark,
// nudge it onto the mark. The nudge is saved in the show as that fixture's offset and added to
// every position the show gives it: hand-made cues and generated designs alike.
//
// The arrows move the spot in stage terms (left/right as the audience sees it, further/closer
// on the floor), whichever way the fixture hangs: the pan/tilt change for a given spot move is
// solved from the fixture's geometry.

import { h, mount, icon, toast, numberInput } from '../lib/dom.js';
import { beamDirection } from '/shared/kinematics.js';
import { clamp } from '/shared/util.js';

const STEPS = [
  { id: 'fine', label: '2 cm', m: 0.02, deg: 0.1 },
  { id: 'small', label: '10 cm', m: 0.1, deg: 0.5 },
  { id: 'big', label: '50 cm', m: 0.5, deg: 2 },
];
const round2 = (v) => Math.round(v * 100) / 100;

/**
 * Where a fixture's beam meets the plane through the target: the floor-level plane for a
 * steep beam, the plane facing the audience for a shallow one.
 */
function spotFn(rec, target) {
  const f = rec.fixture;
  const p = f.position;
  const probe = beamDirection(f, rec.aim.pan, rec.aim.tilt, rec.matrix);
  const steep = Math.abs(probe[1]) >= 0.3;
  const at = (pan, tilt) => {
    const d = beamDirection(f, pan, tilt, rec.matrix);
    if (steep) {
      if (Math.abs(d[1]) < 1e-6) return null;
      const t = (target.y - p.y) / d[1];
      return t > 0 ? [p.x + d[0] * t, p.z + d[2] * t] : null;
    }
    if (Math.abs(d[2]) < 1e-6) return null;
    const t = (target.z - p.z) / d[2];
    return t > 0 ? [p.x + d[0] * t, p.y + d[1] * t] : null;
  };
  return { at, steep };
}

/**
 * Pan/tilt change (degrees) that moves the spot by (du, dv) metres on that plane:
 * u = X (left to right as the audience sees it), v = Z on the floor or Y on the wall.
 * Null when the geometry gives no stable answer (beam nearly parallel to the plane).
 */
export function solveNudge(rec, target, pan, tilt, du, dv) {
  const { at } = spotFn(rec, target);
  const e = 0.05;
  const p0 = at(pan, tilt);
  const pp = at(pan + e, tilt);
  const pt = at(pan, tilt + e);
  if (!p0 || !pp || !pt) return null;
  const j00 = (pp[0] - p0[0]) / e;
  const j10 = (pp[1] - p0[1]) / e;
  const j01 = (pt[0] - p0[0]) / e;
  const j11 = (pt[1] - p0[1]) / e;
  const det = j00 * j11 - j01 * j10;
  if (Math.abs(det) < 1e-6) return null;
  const dPan = (j11 * du - j01 * dv) / det;
  const dTilt = (-j10 * du + j00 * dv) / det;
  if (!Number.isFinite(dPan) || !Number.isFinite(dTilt) || Math.abs(dPan) > 20 || Math.abs(dTilt) > 20) return null;
  return { pan: dPan, tilt: dTilt };
}

export class CalibrateView {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.el = h('div', { class: 'calibrate' });
    this.step = 'small';
    this.othersOff = true;
    // Nudges not yet confirmed by the engine, so fast key presses all count.
    this.pendingCal = new Map();
    this.store.on('show', () => this.render());
    this.store.on('live', () => this.render());
    document.addEventListener('keydown', (e) => this.onKey(e));
  }

  get calibrating() {
    return this.store.live.calibrate;
  }

  movers() {
    return this.store.evaluator().fixtures.filter((r) => r.caps.panTilt);
  }

  calibration(id) {
    const f = this.store.show.fixtures.find((x) => x.id === id);
    return this.pendingCal.get(id)?.value || f?.calibration || { pan: 0, tilt: 0 };
  }

  render() {
    const st = this.store;
    if (!st.show || !this.el.isConnected) return;
    const focusKey = document.activeElement?.dataset?.focusKey;
    const show = st.show;
    const aud = show.stage.audience;
    const cal = this.calibrating;
    const movers = this.movers();
    const setAud = (changes) => st.op({ type: 'stage.set', changes: { audience: { ...aud, ...changes } } });
    const presets = [
      ['Stage centre, floor', { x: 0, y: 0, z: round2(-show.stage.depth / 2) }],
      ['Front edge, floor', { x: 0, y: 0, z: 0 }],
      ['Audience, head height', { x: 0, y: 1.7, z: 4 }],
    ];
    const issues = new Map();
    for (const i of st.validation().issues) if (i.code === 'calibration-range' || i.code === 'aim-unreachable') for (const id of i.fixtures) issues.set(id, i.message);

    mount(this.el,
      h('div', { class: 'card stack' },
        h('h2', { style: { margin: 0 } }, 'Centre point'),
        h('p', { class: 'muted', style: { margin: 0 } }, 'The spot every moving head aims at when a cue or a generated design says “aim”. Mark it in the room (tape on the floor works), then calibrate below so every beam really lands on it.'),
        h('div', { class: 'row wrap' },
          h('span', { class: 'muted' }, 'X'), numberInput(aud.x, (v) => setAud({ x: v }), { step: 0.1, 'data-focus-key': 'aud-x', style: { width: '72px' } }),
          h('span', { class: 'muted' }, 'Y (height)'), numberInput(aud.y, (v) => setAud({ y: v }), { step: 0.1, 'data-focus-key': 'aud-y', style: { width: '72px' } }),
          h('span', { class: 'muted' }, 'Z'), numberInput(aud.z, (v) => setAud({ z: v }), { step: 0.1, 'data-focus-key': 'aud-z', style: { width: '72px' } }),
          h('span', { class: 'muted' }, 'metres'),
        ),
        h('div', { class: 'chips' }, presets.map(([label, p]) => h('button', { class: 'btn small', onclick: () => setAud(p) }, label))),
      ),
      h('div', { class: 'card stack' },
        h('div', { class: 'row wrap' },
          h('h2', { style: { margin: 0 } }, 'Prime'),
          cal ? h('span', { class: 'badge warn' }, icon('target', 12), cal.all ? 'All moving heads on the centre point' : 'Calibrating one moving head') : null,
        ),
        h('p', { class: 'muted', style: { margin: 0 } }, 'Opens every moving head white and narrow at the centre point, so you can see whether the beams meet. Nothing else in the show plays while this is on.'),
        h('div', { class: 'row wrap' },
          h('button', { class: `btn ${cal?.all ? 'on' : 'primary'}`, disabled: !movers.length, onclick: () => st.setLive({ calibrate: { all: true, othersOff: this.othersOff } }) }, icon('target', 14), 'Prime all moving heads'),
          h('button', { class: 'btn', disabled: !cal, onclick: () => st.setLive({ calibrate: null }) }, 'Stop'),
          h('label', { class: 'row', style: { gap: '4px' } },
            h('input', { type: 'checkbox', checked: this.othersOff, onchange: (e) => {
              this.othersOff = e.target.checked;
              if (cal) st.setLive({ calibrate: { ...cal, othersOff: this.othersOff } });
            } }),
            'Other lights off'),
        ),
        movers.length ? null : h('div', { class: 'note' }, 'No moving heads in the patch. Calibration is only needed for fixtures with pan and tilt.'),
      ),
      movers.length ? h('div', { class: 'card stack' },
        h('h2', { style: { margin: 0 } }, 'Calibrate each moving head'),
        h('p', { class: 'muted', style: { margin: 0 } }, 'Pick one, look where its spot lands, and move it onto the mark. Arrow keys work too (Shift for bigger steps). The offset is saved with the show.'),
        h('div', { class: 'cal-list' }, movers.map((rec) => this.moverRow(rec, cal, issues.get(rec.id)))),
      ) : null,
    );
    if (focusKey) this.el.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
  }

  moverRow(rec, cal, issue) {
    const st = this.store;
    const id = rec.id;
    const f = rec.fixture;
    const off = this.calibration(id);
    const active = cal && !cal.all && cal.fixtureId === id;
    const row = h('div', { class: `cal-row${active ? ' active' : ''}` },
      h('div', { class: 'row wrap' },
        h('strong', {}, f.name),
        h('span', { class: 'muted mono' }, `pan ${off.pan >= 0 ? '+' : ''}${off.pan.toFixed(2)}° · tilt ${off.tilt >= 0 ? '+' : ''}${off.tilt.toFixed(2)}°`),
        issue ? h('span', { class: 'badge warn', title: issue }, icon('warn', 12), 'out of reach') : null,
        h('div', { class: 'grow' }),
        active
          ? h('button', { class: 'btn small', onclick: () => st.setLive({ calibrate: null }) }, 'Done')
          : h('button', { class: 'btn small primary', onclick: () => this.calibrate(id) }, icon('target', 12), 'Calibrate'),
      ),
      active ? this.nudgePanel(rec, off) : null,
    );
    return row;
  }

  calibrate(id) {
    this.store.setLive({ calibrate: { fixtureId: id, othersOff: this.othersOff } });
  }

  nudgePanel(rec, off) {
    const st = this.store;
    const id = rec.id;
    const steep = rec.aim ? spotFn(rec, st.show.stage.audience).steep : true;
    const arrow = (label, du, dv, title) => h('button', { class: 'btn nudge', title, 'aria-label': title, onclick: () => this.nudge(id, du, dv) }, label);
    const setOff = (changes) => this.saveOffset(id, { ...this.calibration(id), ...changes });
    const movers = this.movers();
    const next = movers[(movers.findIndex((r) => r.id === id) + 1) % movers.length];
    return h('div', { class: 'nudge-panel' },
      h('div', { class: 'nudge-pad' },
        h('span'), arrow('▲', 0, steep ? -1 : 1, steep ? 'Spot further away (upstage)' : 'Spot higher'), h('span'),
        arrow('◀', -1, 0, 'Spot to the left (as the audience sees it)'), h('span', { class: 'nudge-mid' }, icon('target', 18)), arrow('▶', 1, 0, 'Spot to the right'),
        h('span'), arrow('▼', 0, steep ? 1 : -1, steep ? 'Spot closer (toward the audience)' : 'Spot lower'), h('span'),
      ),
      h('div', { class: 'stack', style: { gap: '10px' } },
        h('div', { class: 'row wrap' },
          h('span', { class: 'muted' }, 'Step'),
          h('div', { class: 'seg' }, STEPS.map((s) => h('button', { class: s.id === this.step ? 'active' : '', onclick: () => ((this.step = s.id), this.render()) }, s.label))),
        ),
        h('div', { class: 'row wrap' },
          h('span', { class: 'muted' }, 'Offset pan'), numberInput(off.pan, (v) => setOff({ pan: v }), { step: 0.1, 'data-focus-key': `${id}:pan`, style: { width: '72px' } }),
          h('span', { class: 'muted' }, 'tilt'), numberInput(off.tilt, (v) => setOff({ tilt: v }), { step: 0.1, 'data-focus-key': `${id}:tilt`, style: { width: '72px' } }),
          h('span', { class: 'muted' }, 'degrees'),
        ),
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn small', onclick: () => setOff({ pan: 0, tilt: 0 }) }, 'Reset offset'),
          movers.length > 1 ? h('button', { class: 'btn small', onclick: () => this.calibrate(next.id) }, `Next: ${next.fixture.name} ▶`) : null,
        ),
        h('div', { class: 'muted', style: { fontSize: '11px' } }, steep
          ? 'The arrows move the spot on the floor: ◀ ▶ left/right as the audience sees it, ▲ further from the audience, ▼ closer.'
          : 'This beam is nearly level, so the arrows move the spot on a wall facing the audience: ◀ ▶ left/right, ▲ ▼ up/down.'),
      ),
    );
  }

  /** Move the spot by one step in stage terms; falls back to plain pan/tilt steps. */
  nudge(id, du, dv, scale = 1) {
    const st = this.store;
    const rec = st.evaluator().byId.get(id);
    if (!rec?.aim) return;
    const step = STEPS.find((s) => s.id === this.step) || STEPS[1];
    const saved = rec.fixture.calibration || { pan: 0, tilt: 0 };
    const cur = this.calibration(id);
    // The evaluator's aim includes the saved offset; add any nudges still on their way.
    const pan = rec.aim.pan - saved.pan + cur.pan;
    const tilt = rec.aim.tilt - saved.tilt + cur.tilt;
    const d = solveNudge(rec, st.show.stage.audience, pan, tilt, du * step.m * scale, dv * step.m * scale)
      || { pan: du * step.deg * scale, tilt: -dv * step.deg * scale };
    this.saveOffset(id, { pan: cur.pan + d.pan, tilt: cur.tilt + d.tilt });
  }

  saveOffset(id, value) {
    const v = { pan: round2(clamp(value.pan, -180, 180)), tilt: round2(clamp(value.tilt, -180, 180)) };
    const entry = { value: v, n: (this.pendingCal.get(id)?.n || 0) + 1 };
    this.pendingCal.set(id, entry);
    this.store
      .op({ type: 'fixture.update', id, changes: { calibration: v } })
      .catch((err) => toast(err.message, 'error'))
      .finally(() => {
        const e = this.pendingCal.get(id);
        if (e && --e.n <= 0) this.pendingCal.delete(id);
        this.render();
      });
    this.render();
  }

  onKey(e) {
    const cal = this.calibrating;
    if (!this.el.isConnected || !cal?.fixtureId || cal.all) return;
    const t = e.target;
    if (t instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable || t.tagName === 'CANVAS')) return;
    const rec = this.store.evaluator().byId.get(cal.fixtureId);
    if (!rec?.aim) return;
    const steep = spotFn(rec, this.store.show.stage.audience).steep;
    const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, steep ? -1 : 1], ArrowDown: [0, steep ? 1 : -1] };
    const m = moves[e.key];
    if (!m) return;
    e.preventDefault();
    this.nudge(cal.fixtureId, m[0], m[1], e.shiftKey ? 5 : 1);
  }
}
