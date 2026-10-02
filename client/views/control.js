// Control: manual faders for groups and single fixtures, every DMX channel of a fixture, and
// scenes recorded from those values.
//
// Values set here (the "programmer") override the show on the real lights until released,
// per fixture or all at once. Intensity set here replaces the show's intensity rather than
// adding to it, so a fader can also take a light down; blackout and the grand master still
// apply. Faders that are not held follow the show's output, so they always show what the
// lights are doing.

import { h, mount, icon, toast, confirmDialog, fitCanvas, numberInput, textInput } from '../lib/dom.js';
import { fixtureGroups } from '/shared/groups.js';
import { panRange, tiltRange } from '/shared/fixture-library.js';
import { renderUniverses } from '/shared/dmx-render.js';
import { NAMED_COLORS, hexToRgb, rgbToHex } from '/shared/color.js';
import { clamp, uid } from '/shared/util.js';

const SWATCHES = ['white', 'warm', 'red', 'orange', 'amber', 'yellow', 'green', 'cyan', 'blue', 'violet', 'magenta', 'pink'];
export const SCENE_COLORS = ['#4f8fe8', '#e5484d', '#34c98b', '#f5a524', '#b48cff', '#3fa7a0', '#ff7ab6', '#e7eaf0'];
const pct = (v) => `${Math.round(v * 100)}%`;
const deg = (v) => `${Math.round(v)}°`;

function load(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

/** Does this edit change what the Control page shows (fixtures, profiles, scenes)? */
function touchesControl(op) {
  if (!op) return true;
  if (op.type === 'batch') return op.ops.some(touchesControl);
  return op.type === 'show.replace' || /^(fixture|profile|scene)\./.test(op.type);
}

export class ControlView {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.groupKey = load('controlGroup', 'all');
    this.fixtureId = null;
    this.el = h('div', { class: 'control' });
    this.faders = [];
    this.channelRows = [];
    this.sceneRows = new Map();
    this.xy = null;
    this.states = null;
    this.buffers = new Map();
    this.lastTick = 0;
    this.pointerDown = false;
    this.pendingRender = false;
    this.sceneName = '';
    this.sceneFade = 1;
    this.releaseAfterRecord = true;

    // A re-render while a fader is held under a finger would drop it; wait for the release.
    this.el.addEventListener('pointerdown', () => (this.pointerDown = true));
    window.addEventListener('pointerup', () => {
      this.pointerDown = false;
      if (this.pendingRender) this.render();
    });
    this.store.on('show', (op) => touchesControl(op) && this.render());
    this.store.on('selection', () => {
      const sel = [...this.store.ui.selectedFixtures];
      if (sel.length === 1 && sel[0] !== this.fixtureId) {
        this.fixtureId = sel[0];
        this.render();
      }
    });
    this.store.on('programmer', () => this.refresh());
    this.store.on('live', () => this.refreshScenes());
    this.store.on('frame', (pos) => this.tick(pos));
  }

  showGroup(key) {
    this.groupKey = key;
    save('controlGroup', key);
    this.render();
  }

  showFixture(id) {
    this.fixtureId = id;
    this.store.selectFixtures([id]);
    this.render();
  }

  render() {
    const { show } = this.store;
    if (!show || !this.el.isConnected) return;
    if (this.pointerDown) {
      this.pendingRender = true;
      return;
    }
    this.pendingRender = false;
    this.faders = [];
    this.channelRows = [];
    this.xy = null;
    const groups = fixtureGroups(show);
    const group = groups.find((g) => g.key === this.groupKey) || groups[0];
    if (group) this.groupKey = group.key;
    if (this.fixtureId && !show.fixtures.some((f) => f.id === this.fixtureId)) this.fixtureId = null;
    if (!this.fixtureId && group) this.fixtureId = group.fixtures[0] || null;
    this.updateStates(this.store.positionNow());
    mount(this.el,
      h('div', { class: 'control-grid' },
        group ? this.groupCard(groups, group) : h('div', { class: 'card empty' }, 'Patch some fixtures first (Patch page), then control them here.'),
        this.fixtureId ? this.fixtureCard(this.fixtureId) : null,
      ),
      this.scenesCard(),
    );
    this.refresh();
  }

  // ---- Values --------------------------------------------------------------------------

  tick(pos) {
    if (!this.el.isConnected) return;
    const t = performance.now();
    if (t - this.lastTick < 100) return; // the faders follow the output ~10 times a second
    this.lastTick = t;
    this.updateStates(pos);
    this.refresh();
  }

  updateStates(pos) {
    const ev = this.store.evaluator();
    const now = this.store.net.serverNow();
    this.states = ev.evaluate(pos, this.store.liveContext(), now);
    renderUniverses(ev, this.states, now, this.buffers);
  }

  refresh() {
    if (!this.el.isConnected) return;
    for (const f of this.faders) f.update();
    for (const r of this.channelRows) this.updateChannel(r);
    this.xy?.draw();
    this.refreshScenes();
  }

  /** A held value (programmer) or else what the show is doing right now. */
  value(id, attr) {
    const held = this.store.programmer.attrs[id]?.[attr];
    return held ?? this.states?.get(id)?.[attr];
  }

  // ---- Building blocks -----------------------------------------------------------------

  fader({ label, min = 0, max = 1, step = 0.005, get, set, held, release, format }) {
    const input = h('input', { type: 'range', min, max, step, 'aria-label': label });
    const out = h('output', {});
    const row = h('div', { class: 'fader' },
      h('span', { class: 'fader-label' }, label),
      input,
      out,
      h('button', { class: 'btn ghost small rel', title: `Release ${label.toLowerCase()} (back to the show)`, onclick: release }, '×'),
    );
    input.addEventListener('input', () => {
      const v = Number(input.value);
      out.textContent = format(v);
      set(v);
    });
    this.faders.push({
      update: () => {
        row.classList.toggle('held', held());
        const v = get();
        if (typeof v === 'number' && Number.isFinite(v)) {
          if (Number(input.value) !== v) input.value = String(v);
          out.textContent = format(v);
        }
      },
    });
    return row;
  }

  colorRow(get, set, held, release) {
    const picker = h('input', { type: 'color', 'aria-label': 'Colour' });
    picker.addEventListener('input', () => set(hexToRgb(picker.value)));
    const row = h('div', { class: 'fader color-row' },
      h('span', { class: 'fader-label' }, 'Colour'),
      h('div', { class: 'swatches' },
        SWATCHES.map((name) => h('button', { class: 'swatch', title: name, 'aria-label': name, style: { background: rgbToHex(NAMED_COLORS[name]) }, onclick: () => set(NAMED_COLORS[name]) })),
        picker,
      ),
      h('button', { class: 'btn ghost small rel', title: 'Release colour (back to the show)', onclick: release }, '×'),
    );
    this.faders.push({
      update: () => {
        row.classList.toggle('held', held());
        const c = get();
        if (Array.isArray(c) && document.activeElement !== picker) picker.value = rgbToHex(c);
      },
    });
    return row;
  }

  // ---- Groups --------------------------------------------------------------------------

  groupCard(groups, group) {
    const st = this.store;
    const ev = st.evaluator();
    const ids = group.fixtures;
    const c = group.caps;
    const recs = ids.map((id) => ev.byId.get(id)).filter(Boolean);
    const movers = recs.filter((r) => r.caps.panTilt);
    // A group fader shows the first held value, else what the first member is doing now.
    const first = (attr, list = ids) => {
      for (const id of list) {
        const v = st.programmer.attrs[id]?.[attr];
        if (v != null) return v;
      }
      return this.states?.get(list[0])?.[attr];
    };
    const heldAll = (attr, list = ids) => list.length > 0 && list.every((id) => st.programmer.attrs[id]?.[attr] != null);
    const setAll = (attr, v, only = ids) => st.setProgrammer({ attrs: Object.fromEntries(only.map((id) => [id, { [attr]: v }])) });
    const releaseAttr = (attr, list = ids) => st.setProgrammer({ attrs: Object.fromEntries(list.map((id) => [id, { [attr]: null }])) });
    const attrFader = (label, attr, opts = {}) => this.fader({
      label,
      get: () => first(attr, opts.only),
      set: (v) => setAll(attr, v, opts.only),
      held: () => heldAll(attr, opts.only),
      release: () => releaseAttr(attr, opts.only),
      format: pct,
      ...opts,
    });
    const halfPan = movers.length ? Math.min(...movers.map((r) => panRange(r.profile) / 2)) : 270;
    const halfTilt = movers.length ? Math.min(...movers.map((r) => tiltRange(r.profile) / 2)) : 135;
    const goboSlots = recs.filter((r) => r.caps.gobo).map((r) => r.profile.channels.find((ch) => ch.attr === 'gobo')?.slots?.length || 1);
    const byId = new Map(st.show.fixtures.map((f) => [f.id, f]));
    return h('div', { class: 'card stack' },
      h('div', { class: 'row wrap' },
        h('h2', { style: { margin: 0 } }, 'Group faders'),
        h('div', { class: 'grow' }),
        h('button', { class: 'btn small', disabled: !st.programmerHolds(), onclick: () => st.clearProgrammer('all'), title: 'Every fixture back to the show' }, 'Release everything'),
      ),
      h('div', { class: 'chips' }, groups.map((g) => h('button', { class: `btn small${g.key === group.key ? ' on' : ''}`, onclick: () => this.showGroup(g.key) }, `${g.name} · ${g.fixtures.length}`))),
      c.intensity ? attrFader('Intensity', 'dimmer') : null,
      c.color ? this.colorRow(() => first('color'), (rgb) => setAll('color', rgb), () => heldAll('color'), () => releaseAttr('color')) : null,
      movers.length ? attrFader('Pan', 'pan', { min: -halfPan, max: halfPan, step: 0.1, format: deg, only: movers.map((r) => r.id) }) : null,
      movers.length ? attrFader('Tilt', 'tilt', { min: -halfTilt, max: halfTilt, step: 0.1, format: deg, only: movers.map((r) => r.id) }) : null,
      c.zoom ? attrFader('Zoom', 'zoom') : null,
      c.strobe ? attrFader('Strobe', 'strobe', { format: (v) => (v < 0.01 ? 'off' : pct(v)) }) : null,
      goboSlots.length ? attrFader('Gobo', 'gobo', { min: 0, max: Math.max(1, Math.min(...goboSlots) - 1), step: 1, format: (v) => `#${Math.round(v)}` }) : null,
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn small', onclick: () => st.setProgrammer({ attrs: Object.fromEntries(ids.map((id) => [id, { dimmer: 1, color: [1, 1, 1] }])) }) }, 'Full white'),
        h('button', { class: 'btn small', onclick: () => setAll('dimmer', 0) }, 'Off'),
        movers.length ? h('button', { class: 'btn small', title: 'Point every moving head in the group at the centre point (with its calibration)', onclick: () => this.toCentre(movers) }, icon('target', 12), 'To centre point') : null,
        h('div', { class: 'grow' }),
        h('button', { class: 'btn small', disabled: !ids.some((id) => st.programmerHolds(id)), onclick: () => st.clearProgrammer(ids) }, 'Release group'),
      ),
      h('h3', {}, 'Fixtures in this group'),
      h('div', { class: 'chips' }, ids.map((id) =>
        h('button', { class: `btn small${id === this.fixtureId ? ' on' : ''}`, onclick: () => this.showFixture(id), title: st.programmerHolds(id) ? 'Held by the faders' : null },
          st.programmerHolds(id) ? h('span', { class: 'dot warn' }) : null, byId.get(id)?.name || id))),
    );
  }

  toCentre(recs) {
    const attrs = {};
    for (const r of recs) if (r.aim) attrs[r.id] = { pan: r.aim.pan, tilt: r.aim.tilt };
    this.store.setProgrammer({ attrs });
  }

  // ---- One fixture ---------------------------------------------------------------------

  fixtureCard(id) {
    const st = this.store;
    const f = st.show.fixtures.find((x) => x.id === id);
    if (!f) return null;
    const rec = st.evaluator().byId.get(id);
    if (!rec) {
      return h('div', { class: 'card' }, h('h2', {}, f.name), h('p', { class: 'muted' }, `Its fixture type (${f.profileId}) is missing. Import the profile on the Patch page.`));
    }
    const p = rec.profile;
    const c = rec.caps;
    const held = (attr) => st.programmer.attrs[id]?.[attr] != null;
    const set = (attr, v) => st.setProgrammer({ attrs: { [id]: { [attr]: v } } });
    const rel = (attr) => st.setProgrammer({ attrs: { [id]: { [attr]: null } } });
    const attrFader = (label, attr, opts = {}) => this.fader({ label, get: () => this.value(id, attr), set: (v) => set(attr, v), held: () => held(attr), release: () => rel(attr), format: pct, ...opts });
    const gobo = p.channels.find((ch) => ch.attr === 'gobo');
    return h('div', { class: 'card stack' },
      h('div', { class: 'row wrap' },
        h('h2', { style: { margin: 0 } }, f.name),
        h('span', { class: 'muted' }, `${p.name} · universe ${f.universe} · ${f.address}–${f.address + p.channels.length - 1}`),
        h('div', { class: 'grow' }),
        c.emitsLight ? h('button', { class: 'btn small', title: 'Full, open white so you can find this fixture', onclick: () => st.setProgrammer({ attrs: { [id]: { dimmer: 1, color: [1, 1, 1], ...(c.zoom ? { zoom: 0.4 } : {}) } } }) }, 'Highlight') : null,
        h('button', { class: 'btn small', disabled: !st.programmerHolds(id), onclick: () => st.clearProgrammer([id]) }, 'Release'),
      ),
      c.panTilt ? this.xyPad(rec) : null,
      c.emitsLight ? attrFader('Intensity', 'dimmer') : null,
      c.color && c.color !== 'white' ? this.colorRow(() => this.value(id, 'color'), (rgb) => set('color', rgb), () => held('color'), () => rel('color')) : null,
      c.zoom ? attrFader('Zoom', 'zoom') : null,
      c.strobe ? attrFader('Strobe', 'strobe', { format: (v) => (v < 0.01 ? 'off' : pct(v)) }) : null,
      gobo ? attrFader('Gobo', 'gobo', { min: 0, max: Math.max(1, (gobo.slots?.length || 1) - 1), step: 1, format: (v) => gobo.slots?.[Math.round(v)]?.name || `#${Math.round(v)}` }) : null,
      h('div', { class: 'row', style: { marginTop: '6px' } },
        h('h3', {}, 'DMX channels'),
        h('span', { class: 'muted', style: { fontSize: '11px' } }, 'Address · function · value you set · value going out now'),
      ),
      h('div', { class: 'channels' }, p.channels.map((ch, i) => this.channelRow(rec, ch, i))),
    );
  }

  channelRow(rec, ch, i) {
    const st = this.store;
    const id = rec.id;
    const name = ch.label || `${ch.attr}${ch.fine ? ' fine' : ''}`;
    const input = h('input', { type: 'range', min: 0, max: 255, step: 1, 'aria-label': `Channel ${rec.fixture.address + i}: ${name}` });
    const num = h('input', { type: 'number', min: 0, max: 255, class: 'ch-num', 'aria-label': `${name} value` });
    const out = h('span', { class: 'ch-out mono', title: 'Value going out on DMX now' });
    const set = (v) => st.setProgrammer({ raw: { [id]: { [i]: v } } });
    input.addEventListener('input', () => {
      num.value = input.value;
      set(Number(input.value));
    });
    num.addEventListener('change', () => {
      const v = clamp(Math.round(Number(num.value) || 0), 0, 255);
      num.value = String(v);
      input.value = String(v);
      set(v);
    });
    const row = h('div', { class: 'ch-row' },
      h('span', { class: 'ch-label', title: name }, h('b', { class: 'mono' }, String(rec.fixture.address + i)), ` ${name}`),
      input,
      num,
      out,
      h('button', { class: 'btn ghost small rel', title: 'Release this channel', onclick: () => st.setProgrammer({ raw: { [id]: { [i]: null } } }) }, '×'),
    );
    this.channelRows.push({ row, input, num, out, id, i, universe: rec.fixture.universe, start: rec.fixture.address - 1 });
    return row;
  }

  updateChannel(r) {
    const held = this.store.programmer.raw[r.id]?.[r.i];
    const live = this.buffers.get(r.universe)?.[r.start + r.i] ?? 0;
    r.row.classList.toggle('held', held != null);
    r.out.textContent = String(live);
    const v = held ?? live;
    if (Number(r.input.value) !== v) r.input.value = String(v);
    if (document.activeElement !== r.num && Number(r.num.value) !== v) r.num.value = String(v);
  }

  /** Pan/tilt pad: click or drag to place the beam; Shift-drag for fine moves. */
  xyPad(rec) {
    const st = this.store;
    const id = rec.id;
    const halfPan = panRange(rec.profile) / 2;
    const halfTilt = tiltRange(rec.profile) / 2;
    const canvas = h('canvas', { class: 'xy-pad', tabindex: '0', 'aria-label': 'Pan and tilt. Arrow keys move the beam; Shift for fine steps.' });
    const readout = h('span', { class: 'mono muted' });
    const toXY = (pan, tilt, w, hh) => [((pan + halfPan) / (2 * halfPan)) * w, (1 - (tilt + halfTilt) / (2 * halfTilt)) * hh];
    const fromXY = (x, y, w, hh) => [clamp((x / w) * 2 * halfPan - halfPan, -halfPan, halfPan), clamp((1 - y / hh) * 2 * halfTilt - halfTilt, -halfTilt, halfTilt)];
    const setPT = (pan, tilt) => st.setProgrammer({ attrs: { [id]: { pan: Math.round(pan * 10) / 10, tilt: Math.round(tilt * 10) / 10 } } });
    const current = () => [this.value(id, 'pan') ?? 0, this.value(id, 'tilt') ?? 0];
    const draw = () => {
      if (!canvas.isConnected) return;
      const { ctx, w, h: hh } = fitCanvas(canvas);
      ctx.fillStyle = '#0d0f13';
      ctx.fillRect(0, 0, w, hh);
      ctx.lineWidth = 1;
      for (let a = -Math.floor(halfPan / 90) * 90; a <= halfPan; a += 90) {
        const [x] = toXY(a, 0, w, hh);
        ctx.strokeStyle = a === 0 ? '#3a4352' : '#1f252f';
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, hh);
        ctx.stroke();
      }
      for (let a = -Math.floor(halfTilt / 45) * 45; a <= halfTilt; a += 45) {
        const [, y] = toXY(0, a, w, hh);
        ctx.strokeStyle = a === 0 ? '#3a4352' : '#1f252f';
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
      if (rec.aim) {
        const [x, y] = toXY(rec.aim.pan, rec.aim.tilt, w, hh);
        ctx.strokeStyle = '#f5a524';
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.moveTo(x - 10, y);
        ctx.lineTo(x + 10, y);
        ctx.moveTo(x, y - 10);
        ctx.lineTo(x, y + 10);
        ctx.stroke();
      }
      const s = this.states?.get(id);
      if (s) {
        const [x, y] = toXY(s.pan, s.tilt, w, hh);
        ctx.fillStyle = '#4f9dff';
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
      }
      const a = st.programmer.attrs[id];
      if (a && (a.pan != null || a.tilt != null)) {
        const [x, y] = toXY(a.pan ?? s?.pan ?? 0, a.tilt ?? s?.tilt ?? 0, w, hh);
        ctx.strokeStyle = '#e7eaf0';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 9, 0, Math.PI * 2);
        ctx.stroke();
      }
      const [pan, tilt] = current();
      readout.textContent = `pan ${pan.toFixed(1)}° · tilt ${tilt.toFixed(1)}°`;
    };
    let drag = null;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      canvas.setPointerCapture(e.pointerId);
      const [pan, tilt] = current();
      drag = { fine: e.shiftKey, x: e.clientX, y: e.clientY, pan, tilt };
      if (!drag.fine) move(e);
    });
    const move = (e) => {
      if (!drag) return;
      const r = canvas.getBoundingClientRect();
      if (drag.fine) {
        const dp = ((e.clientX - drag.x) / r.width) * 2 * halfPan * 0.1;
        const dt = (-(e.clientY - drag.y) / r.height) * 2 * halfTilt * 0.1;
        setPT(clamp(drag.pan + dp, -halfPan, halfPan), clamp(drag.tilt + dt, -halfTilt, halfTilt));
      } else {
        const [pan, tilt] = fromXY(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
        setPT(pan, tilt);
      }
    };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', () => (drag = null));
    canvas.addEventListener('pointercancel', () => (drag = null));
    canvas.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.1 : 1;
      const [pan, tilt] = current();
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      const m = moves[e.key];
      if (!m) return;
      e.preventDefault();
      setPT(clamp(pan + m[0], -halfPan, halfPan), clamp(tilt + m[1], -halfTilt, halfTilt));
    });
    this.xy = { draw };
    return h('div', { class: 'xy' },
      canvas,
      h('div', { class: 'row wrap' },
        readout,
        h('div', { class: 'grow' }),
        rec.aim ? h('button', { class: 'btn small', title: 'Aim at the centre point (with this fixture’s calibration)', onclick: () => setPT(rec.aim.pan, rec.aim.tilt) }, icon('target', 12), 'Centre point') : null,
        h('button', { class: 'btn small', title: 'Pan and tilt at zero: straight out of the base', onclick: () => setPT(0, 0) }, 'Home'),
        h('button', { class: 'btn small ghost', onclick: () => st.setProgrammer({ attrs: { [id]: { pan: null, tilt: null } } }) }, 'Release position'),
      ),
      h('div', { class: 'muted', style: { fontSize: '11px' } }, 'Blue: where the beam is now · white ring: held by you · orange cross: the centre point. Shift-drag for fine moves.'),
    );
  }

  // ---- Scenes --------------------------------------------------------------------------

  scenesCard() {
    const st = this.store;
    const scenes = st.show.scenes;
    this.sceneRows = new Map();
    this.recordBtn = h('button', { class: 'btn primary', onclick: () => this.recordScene() }, icon('plus', 14), 'Record scene');
    const nameInput = h('input', { type: 'text', placeholder: `Scene ${scenes.length + 1}`, value: this.sceneName, 'aria-label': 'Name for the new scene', style: { width: '170px' } });
    nameInput.addEventListener('input', () => (this.sceneName = nameInput.value));
    nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && this.recordScene());
    const fadeInput = numberInput(this.sceneFade, (v) => (this.sceneFade = clamp(v, 0, 60)), { min: 0, max: 60, step: 0.1, 'aria-label': 'Fade time in seconds', style: { width: '64px' } });
    return h('div', { class: 'card stack' },
      h('div', { class: 'row wrap' },
        h('h2', { style: { margin: 0 } }, 'Scenes'),
        h('span', { class: 'muted' }, 'A scene stores what the faders and channels above hold. Trigger scenes here or in Live mode: they fade in over the show and back out when released.'),
      ),
      h('div', { class: 'row wrap' },
        nameInput,
        h('span', { class: 'muted' }, 'fade'), fadeInput, h('span', { class: 'muted' }, 's'),
        this.recordBtn,
        h('label', { class: 'row', style: { gap: '4px' } },
          h('input', { type: 'checkbox', checked: this.releaseAfterRecord, onchange: (e) => (this.releaseAfterRecord = e.target.checked) }),
          'Release faders after recording'),
      ),
      scenes.length ? h('div', { class: 'scene-list' }, scenes.map((sc) => this.sceneRow(sc))) : h('p', { class: 'muted', style: { margin: 0 } }, 'No scenes yet. Set some faders, then Record scene.'),
      scenes.length ? h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => st.sceneCmd('releaseAll') }, 'Release all scenes')) : null,
    );
  }

  sceneRow(sc) {
    const st = this.store;
    const update = (changes) => st.op({ type: 'scene.update', id: sc.id, changes });
    const goBtn = h('button', { class: 'btn small scene-go', onclick: () => st.sceneCmd('toggle', sc.id) }, 'Go');
    const fixtures = new Set([...Object.keys(sc.attrs), ...Object.keys(sc.raw)]).size;
    const updateBtn = h('button', { class: 'btn small ghost', title: 'Replace this scene with what the faders hold now', onclick: () => this.updateScene(sc) }, 'Update');
    const row = h('div', { class: 'scene-row' },
      h('input', { type: 'color', value: sc.color, title: 'Button colour', 'aria-label': 'Button colour', onchange: (e) => update({ color: e.target.value }) }),
      textInput(sc.name, (v) => update({ name: v }), { class: 'scene-name', 'aria-label': 'Scene name' }),
      h('span', { class: 'muted hide-phone' }, `${fixtures} fixture${fixtures === 1 ? '' : 's'}`),
      h('span', { class: 'muted' }, 'fade'),
      numberInput(sc.fadeMs / 1000, (v) => update({ fadeMs: Math.round(clamp(v, 0, 60) * 1000) }), { min: 0, max: 60, step: 0.1, 'aria-label': 'Fade seconds', style: { width: '60px' } }),
      h('div', { class: 'grow' }),
      goBtn,
      h('button', { class: 'btn small ghost', title: 'Put this scene on the faders to change it', onclick: () => this.loadScene(sc) }, 'Edit'),
      updateBtn,
      h('button', { class: 'btn small ghost', title: 'Delete scene', 'aria-label': 'Delete scene', onclick: () => this.deleteScene(sc) }, icon('trash', 14)),
    );
    this.sceneRows.set(sc.id, { row, goBtn, updateBtn });
    return row;
  }

  refreshScenes() {
    const active = this.store.live.scenes || [];
    const holds = this.store.programmerHolds();
    for (const [id, r] of this.sceneRows) {
      const on = active.some((e) => e.id === id && e.releasedAt == null);
      r.goBtn.textContent = on ? 'Release' : 'Go';
      r.goBtn.classList.toggle('on', on);
      r.row.classList.toggle('active', on);
      r.updateBtn.disabled = !holds;
    }
    if (this.recordBtn) {
      this.recordBtn.disabled = !holds;
      this.recordBtn.title = holds ? 'Store what the faders hold as a new scene' : 'Set some faders or channels first';
    }
  }

  async recordScene() {
    const st = this.store;
    if (!st.programmerHolds()) return toast('Set some faders or channels first: a scene records what they hold.', 'info');
    const n = st.show.scenes.length;
    const p = st.programmer;
    const scene = { id: uid('sc'), name: this.sceneName.trim() || `Scene ${n + 1}`, color: SCENE_COLORS[n % SCENE_COLORS.length], fadeMs: Math.round(this.sceneFade * 1000), attrs: p.attrs, raw: p.raw };
    try {
      await st.op({ type: 'scene.add', scene });
      this.sceneName = '';
      toast(`Recorded “${scene.name}”.`, 'ok');
      if (this.releaseAfterRecord) st.clearProgrammer('all');
      this.render();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  loadScene(sc) {
    this.store.clearProgrammer('all');
    this.store.setProgrammer({ attrs: sc.attrs, raw: sc.raw });
    toast(`“${sc.name}” is on the faders. Change it, then press Update on its row.`, 'info', 5000);
  }

  async updateScene(sc) {
    const p = this.store.programmer;
    await this.store.op({ type: 'scene.update', id: sc.id, changes: { attrs: p.attrs, raw: p.raw } }).catch(() => {});
    toast(`Updated “${sc.name}”.`, 'ok');
  }

  async deleteScene(sc) {
    const ok = await confirmDialog('Delete scene', `Delete “${sc.name}”? You can undo this.`, 'Delete');
    if (ok) this.store.op({ type: 'scene.remove', id: sc.id }).catch(() => {});
  }
}
