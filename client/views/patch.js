// Patch: which fixtures exist, their DMX addresses, and where they hang on the stage.
//
// The page is built from fixed sections, so the layout editor keeps its canvas (and a drag in
// progress) while the table and the address grid re-render around it.

import { h, mount, select, numberInput, textInput, icon, toast, dialog, pickFile, confirmDialog, keepFocus } from '../lib/dom.js';
import { allProfiles, footprint, resolveProfile, profileCaps, checkProfile, fixtureRole, channelName, channelSummary } from '/shared/fixture-library.js';
import { fixtureGroups } from '/shared/groups.js';
import { LayoutEditor, ROLE_COLORS } from './layout.js';
import { importOflFixture, oflModes } from '/shared/ofl-import.js';
import { uid } from '/shared/util.js';

export const MOUNTS = [
  { id: 'truss-angled', label: 'Truss, angled at audience', y: 4, z: -1.5, rotation: { x: 150, y: 0, z: 0 }, moverRotation: { x: 180, y: 0, z: 0 } },
  { id: 'truss-down', label: 'Truss, pointing down', y: 4, z: -1.5, rotation: { x: 180, y: 0, z: 0 }, moverRotation: { x: 180, y: 0, z: 0 } },
  { id: 'floor-up', label: 'Floor, pointing up', y: 0.2, z: -0.5, rotation: { x: 0, y: 0, z: 0 }, moverRotation: { x: 0, y: 0, z: 0 } },
  { id: 'floor-front', label: 'Floor, aimed at audience', y: 0.2, z: -0.3, rotation: { x: 60, y: 0, z: 0 }, moverRotation: { x: 0, y: 0, z: 0 } },
  { id: 'back-wall', label: 'Back wall, facing audience', y: 2.5, z: -5.5, rotation: { x: 90, y: 0, z: 0 }, moverRotation: { x: 90, y: 0, z: 0 } },
];

const sameRot = (a, b) => ['x', 'y', 'z'].every((k) => Math.abs((a?.[k] || 0) - (b?.[k] || 0)) < 0.01);

function mountOf(f, isMover) {
  return MOUNTS.find((m) => sameRot(f.rotation, isMover ? m.moverRotation : m.rotation))?.id || 'custom';
}

/** First address in a universe where `count` channels fit, or null. */
export function nextFreeAddress(show, universe, count, skipIds = new Set()) {
  const used = new Uint8Array(513);
  for (const f of show.fixtures) {
    if (f.universe !== universe || skipIds.has(f.id)) continue;
    const n = footprint(resolveProfile(show, f.profileId));
    for (let c = f.address; c < f.address + n && c <= 512; c++) used[c] = 1;
  }
  for (let a = 1; a + count - 1 <= 512; a++) {
    let free = true;
    for (let c = a; c < a + count; c++) {
      if (used[c]) {
        free = false;
        a = c;
        break;
      }
    }
    if (free) return a;
  }
  return null;
}

export class PatchView {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.layout = new LayoutEditor(this.store);
    this.hosts = { main: h('div'), stage: h('div'), matrix: h('div'), groups: h('div'), profiles: h('div') };
    this.el = h('div', { class: 'patch' }, this.hosts.main, this.layout.el, this.hosts.stage, this.hosts.matrix, this.hosts.groups, this.hosts.profiles);
    this.matrixUniverse = 1;
    this.adding = false;
    this.addOpts = { profileId: 'generic.rgbw-7ch', count: 4, prefix: '', universe: 1, address: null, mount: 'truss-angled' };
    this.store.on('show', () => this.render());
    this.store.on('selection', () => this.render());
    this.store.on('outputs', () => this.render());
  }

  render() {
    const { show } = this.store;
    if (!show) return;
    const restoreFocus = keepFocus(this.el);
    const validation = this.store.validation();
    const problems = new Map();
    for (const i of validation.issues) for (const id of i.fixtures) problems.set(id, [...(problems.get(id) || []), i.message]);
    const universes = new Set(show.fixtures.map((f) => f.universe));
    const channels = show.fixtures.reduce((s, f) => s + footprint(resolveProfile(show, f.profileId)), 0);
    const selected = this.store.ui.selectedFixtures;

    mount(
      this.hosts.main,
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'row wrap', style: { marginBottom: '12px' } },
          h('h2', {}, 'Patch'),
          h('span', { class: 'muted' }, `${show.fixtures.length} fixtures · ${universes.size} universe${universes.size === 1 ? '' : 's'} · ${channels} channels`),
          h('div', { class: 'grow' }),
          h('button', { class: 'btn', onclick: () => this.importProfile() }, icon('open'), 'Import fixture file'),
          h('button', { class: 'btn primary', onclick: () => ((this.adding = !this.adding), this.render()) }, icon('plus'), 'Add fixtures'),
        ),
        this.adding ? this.addPanel() : null,
        selected.size ? this.bulkBar(selected) : null,
        show.fixtures.length ? this.table(problems) : h('div', { class: 'empty' }, 'No fixtures yet. Add some to start designing — the generic profiles work for a first try, or import exact ones from Open Fixture Library.'),
      ),
    );
    this.layout.draw();
    mount(this.hosts.stage, this.stageCard());
    mount(this.hosts.matrix, this.matrixCard());
    mount(this.hosts.groups, this.groupsCard());
    mount(this.hosts.profiles, this.profilesCard());
    restoreFocus();
  }

  table(problems) {
    const { show } = this.store;
    const selected = this.store.ui.selectedFixtures;
    const profiles = allProfiles(show);
    const allSelected = show.fixtures.length > 0 && show.fixtures.every((f) => selected.has(f.id));
    const update = (f, changes) => this.store.op({ type: 'fixture.update', id: f.id, changes });
    return h(
      'div',
      { style: { overflowX: 'auto' } },
      h(
        'table',
        { class: 'grid' },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', {}, h('input', { type: 'checkbox', checked: allSelected, title: 'Select all', onchange: (e) => this.store.selectFixtures(e.target.checked ? show.fixtures.map((f) => f.id) : []) })),
            ['Name', 'Type', 'Univ.', 'Address', 'Channels', 'X (m)', 'Y (m)', 'Z (m)', 'Mounting', ''].map((t) => h('th', {}, t)),
          ),
        ),
        h(
          'tbody',
          {},
          show.fixtures.map((f) => {
            const profile = resolveProfile(show, f.profileId);
            const n = footprint(profile);
            const isMover = profile ? profileCaps(profile).panTilt : false;
            const issues = problems.get(f.id);
            const key = (field) => ({ 'data-focus-key': `${f.id}:${field}` });
            return h(
              'tr',
              { class: `${selected.has(f.id) ? 'selected' : ''} ${issues ? 'problem' : ''}`, title: issues ? issues.join('\n') : null },
              h('td', {}, h('input', { type: 'checkbox', checked: selected.has(f.id), onchange: (e) => this.toggle(f.id, e.target.checked) })),
              h('td', {}, textInput(f.name, (v) => update(f, { name: v }), { class: 'name', ...key('name') })),
              h('td', {}, select(
                [...(profile ? [] : [[f.profileId, `Missing: ${f.profileId}`]]), ...profiles.map((p) => [p.id, p.name])],
                f.profileId,
                (v) => update(f, { profileId: v }),
                key('profile'),
              )),
              h('td', {}, numberInput(f.universe, (v) => update(f, { universe: v }), { min: 1, max: 63999, style: { width: '56px' }, ...key('universe') })),
              h('td', {}, numberInput(f.address, (v) => update(f, { address: v }), { min: 1, max: 512, ...key('address') })),
              h('td', { class: 'mono muted' }, profile ? `${f.address}–${f.address + n - 1}` : '?'),
              ['x', 'y', 'z'].map((axis) =>
                h('td', {}, numberInput(f.position[axis], (v) => update(f, { position: { ...f.position, [axis]: v } }), { step: 0.1, class: 'pos', ...key(axis) })),
              ),
              h('td', {}, select(
                [...MOUNTS.map((m) => [m.id, m.label]), ['custom', 'Custom rotation']],
                mountOf(f, isMover),
                (v) => {
                  const m = MOUNTS.find((x) => x.id === v);
                  if (m) update(f, { rotation: { ...(isMover ? m.moverRotation : m.rotation) } });
                  else this.store.selectFixtures([f.id]);
                },
                key('mount'),
              )),
              h('td', {}, h('button', { class: 'btn ghost small', title: 'Remove fixture', onclick: () => this.remove([f.id]) }, icon('trash', 14))),
            );
          }),
        ),
      ),
    );
  }

  toggle(id, on) {
    const sel = this.store.ui.selectedFixtures;
    if (on) sel.add(id);
    else sel.delete(id);
    this.store.emit('selection');
  }

  bulkBar(selected) {
    const ids = [...selected];
    return h(
      'div',
      { class: 'row wrap note', style: { marginBottom: '10px' } },
      h('strong', {}, `${ids.length} selected`),
      h('button', { class: 'btn small', onclick: () => this.readdress(ids) }, 'Re-address in a row'),
      h('button', { class: 'btn small', onclick: () => this.spread(ids) }, 'Spread across stage'),
      h('button', { class: 'btn small danger', onclick: () => this.remove(ids) }, icon('trash', 14), 'Remove'),
      h('button', { class: 'btn small ghost', onclick: () => this.store.selectFixtures([]) }, 'Clear selection'),
    );
  }

  addPanel() {
    const { show } = this.store;
    const o = this.addOpts;
    const profiles = allProfiles(show);
    const profile = resolveProfile(show, o.profileId) || profiles[0];
    const n = footprint(profile);
    const suggested = nextFreeAddress(show, o.universe, n) ?? 1;
    const set = (k) => (v) => {
      o[k] = v;
      if (k === 'universe' || k === 'profileId') o.address = null;
      this.render();
    };
    return h(
      'div',
      { class: 'card', style: { background: 'var(--panel-2)', marginBottom: '12px' } },
      h(
        'div',
        { class: 'stack' },
        h('label', { class: 'field' }, h('span', {}, 'Fixture type'), select(profiles.map((p) => [p.id, `${p.name}${p.manufacturer && p.manufacturer !== 'Generic' ? ` — ${p.manufacturer}` : ''}`]), profile.id, set('profileId'))),
        h('div', { class: 'muted', style: { marginLeft: '128px' } }, `${n} channels: ${channelSummary(profile)}`),
        h('label', { class: 'field' }, h('span', {}, 'How many'), numberInput(o.count, set('count'), { min: 1, max: 64 })),
        h('label', { class: 'field' }, h('span', {}, 'Name'), textInput(o.prefix, (v) => (o.prefix = v), { placeholder: defaultPrefix(profile) })),
        h('label', { class: 'field' }, h('span', {}, 'Universe'), numberInput(o.universe, set('universe'), { min: 1, max: 63999 })),
        h('label', { class: 'field' }, h('span', {}, 'Start address'), h('div', { class: 'row' }, numberInput(o.address ?? suggested, (v) => (o.address = v), { min: 1, max: 512 }), h('span', { class: 'muted' }, `next free is ${suggested}; later fixtures follow on`))),
        h('label', { class: 'field' }, h('span', {}, 'Mounting'), select(MOUNTS.map((m) => [m.id, m.label]), o.mount, set('mount'))),
        h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
          h('button', { class: 'btn ghost', onclick: () => ((this.adding = false), this.render()) }, 'Cancel'),
          h('button', { class: 'btn primary', onclick: () => this.addFixtures(profile, o.address ?? suggested) }, `Add ${o.count}`),
        ),
      ),
    );
  }

  async addFixtures(profile, startAddress) {
    const { show } = this.store;
    const o = this.addOpts;
    const count = Math.max(1, Math.min(64, Math.round(o.count)));
    const n = footprint(profile);
    const isMover = profileCaps(profile).panTilt;
    const m = MOUNTS.find((x) => x.id === o.mount) || MOUNTS[0];
    const width = show.stage.width;
    const prefix = (o.prefix || defaultPrefix(profile)).trim();
    const existing = show.fixtures.filter((f) => f.name.startsWith(prefix)).length;
    let universe = o.universe;
    let address = startAddress;
    const ops = [];
    for (let i = 0; i < count; i++) {
      if (address + n - 1 > 512) {
        universe += 1;
        address = nextFreeAddress(show, universe, n) ?? 1;
      }
      const x = count === 1 ? 0 : -width / 2 + 1 + ((width - 2) * i) / (count - 1);
      ops.push({
        type: 'fixture.add',
        fixture: {
          id: uid('fx'),
          name: `${prefix} ${existing + i + 1}`,
          profileId: profile.id,
          universe,
          address,
          position: { x: Math.round(x * 100) / 100, y: m.y, z: m.id === 'back-wall' ? -show.stage.depth + 0.3 : m.z },
          rotation: { ...(isMover ? m.moverRotation : m.rotation) },
        },
      });
      address += n;
    }
    try {
      await this.store.op({ type: 'batch', ops });
      this.adding = false;
      this.addOpts.address = null;
      toast(`Added ${count} × ${profile.name}`, 'ok');
      this.render();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async remove(ids) {
    const ok = await confirmDialog('Remove fixtures', `Remove ${ids.length} fixture${ids.length === 1 ? '' : 's'}? They are also taken out of every clip. You can undo this.`, 'Remove');
    if (!ok) return;
    await this.store.op({ type: 'batch', ops: ids.map((id) => ({ type: 'fixture.remove', id })) }).catch(() => {});
    this.store.selectFixtures([]);
  }

  readdress(ids) {
    const { show } = this.store;
    const list = show.fixtures.filter((f) => ids.includes(f.id));
    // The selection can name fixtures the show no longer has, if another window removed
    // them or the engine came back with a different show.
    if (!list.length) return;
    const first = list[0];
    let universe = first.universe;
    let address = first.address;
    const ops = [];
    for (const f of list) {
      const n = footprint(resolveProfile(show, f.profileId));
      if (address + n - 1 > 512) {
        universe++;
        address = 1;
      }
      ops.push({ type: 'fixture.update', id: f.id, changes: { universe, address } });
      address += n;
    }
    this.store.op({ type: 'batch', ops });
  }

  spread(ids) {
    const { show } = this.store;
    const list = show.fixtures.filter((f) => ids.includes(f.id));
    if (!list.length) return;
    const w = show.stage.width;
    const ops = list.map((f, i) => ({
      type: 'fixture.update',
      id: f.id,
      changes: { position: { ...f.position, x: list.length === 1 ? 0 : Math.round((-w / 2 + 1 + ((w - 2) * i) / (list.length - 1)) * 100) / 100 } },
    }));
    this.store.op({ type: 'batch', ops });
  }

  // ---- DMX address grid ----------------------------------------------------------------

  /** Can fixture `id` start at `address` in `universe` without overlapping another one? */
  canPlace(id, universe, address) {
    const { show } = this.store;
    const f = show.fixtures.find((x) => x.id === id);
    if (!f) return false;
    const n = footprint(resolveProfile(show, f.profileId));
    if (address < 1 || address + n - 1 > 512) return false;
    return show.fixtures.every((o) => {
      if (o.id === id || o.universe !== universe) return true;
      const m = footprint(resolveProfile(show, o.profileId));
      return address + n - 1 < o.address || address > o.address + m - 1;
    });
  }

  moveFixture(id, universe, address) {
    const f = this.store.show.fixtures.find((x) => x.id === id);
    if (!f || (f.universe === universe && f.address === address)) return;
    if (!this.canPlace(id, universe, address)) return toast(`${f.name} does not fit at ${universe}.${address}: it would overlap another fixture or run past channel 512.`, 'error');
    this.store.op({ type: 'fixture.update', id, changes: { universe, address } });
  }

  matrixCard() {
    const { show } = this.store;
    const universes = [...new Set([...show.fixtures.map((f) => f.universe), ...this.store.routedUniverses()])].sort((a, b) => a - b);
    if (!universes.length) universes.push(1);
    if (!universes.includes(this.matrixUniverse)) this.matrixUniverse = universes[0];
    const u = this.matrixUniverse;
    const selected = this.store.ui.selectedFixtures;
    const occupant = new Array(512).fill(null);
    const clash = new Uint8Array(512);
    const info = new Map();
    for (const f of show.fixtures) {
      if (f.universe !== u) continue;
      const profile = resolveProfile(show, f.profileId);
      const n = footprint(profile) || 1;
      info.set(f.id, { f, n, profile, role: profile ? fixtureRole(profile) : 'dimmer' });
      for (let c = f.address - 1; c < Math.min(512, f.address - 1 + n); c++) {
        if (occupant[c]) clash[c] = 1;
        else occupant[c] = f.id;
      }
    }
    const used = occupant.filter(Boolean).length;
    const clashes = clash.reduce((a, b) => a + b, 0);
    const cells = [];
    for (let i = 0; i < 512; i++) {
      const id = occupant[i];
      const rec = id ? info.get(id) : null;
      const first = rec && rec.f.address - 1 === i;
      const ch = rec ? i - (rec.f.address - 1) : -1;
      const chDef = rec?.profile?.channels[ch];
      const chName = chDef ? channelName(chDef) : '';
      const span = first ? Math.min(rec.n, 32 - (i % 32)) : 0;
      cells.push(h('div', {
        class: `cell${rec ? ' used' : ''}${first ? ' first' : ''}${clash[i] ? ' clash' : ''}${id && selected.has(id) ? ' sel' : ''}`,
        dataset: { addr: String(i + 1), id: id || '' },
        style: rec ? `--fx:${ROLE_COLORS[rec.role] || '#8d96a7'};--span:${span}` : null,
        title: rec
          ? `${u}.${i + 1} — ${rec.f.name}: ${chName} (channel ${ch + 1} of ${rec.n})${clash[i] ? '\nOverlap: two fixtures use this address' : ''}`
          : `${u}.${i + 1} — free`,
      }, first ? h('span', {}, rec.f.name) : rec ? null : h('i', {}, String(i + 1))));
    }
    const grid = h('div', { class: 'dmx-matrix' }, cells);
    this.attachMatrixDrag(grid, u, info);
    return h('div', { class: 'card' },
      h('div', { class: 'row wrap', style: { marginBottom: '8px' } },
        h('h2', { style: { margin: 0 } }, 'DMX addresses'),
        h('div', { class: 'seg' }, universes.map((x) => h('button', { class: x === u ? 'active' : '', onclick: () => ((this.matrixUniverse = x), this.render()) }, `Universe ${x}`))),
        h('span', { class: 'muted' }, `${used} of 512 channels used`),
        clashes ? h('span', { class: 'badge error' }, `${clashes} overlapping`) : null,
      ),
      grid,
      h('p', { class: 'muted layout-hint' }, 'Drag a fixture to a new start address, or select one fixture (here or in the table) and click a free channel to move it there — also into another universe.'),
    );
  }

  attachMatrixDrag(grid, universe, info) {
    let drag = null;
    const clearGhost = () => grid.querySelectorAll('.ghost').forEach((c) => c.classList.remove('ghost', 'bad'));
    grid.addEventListener('pointerdown', (e) => {
      const cell = e.target.closest('.cell');
      if (!cell || e.button !== 0) return;
      const addr = Number(cell.dataset.addr);
      const id = cell.dataset.id;
      if (!id) {
        const sel = [...this.store.ui.selectedFixtures];
        if (sel.length === 1) this.moveFixture(sel[0], universe, addr);
        else if (sel.length > 1) toast('Select just one fixture to move it to a free address.', 'info', 3000);
        return;
      }
      const rec = info.get(id);
      drag = { id, offset: addr - rec.f.address, n: rec.n, target: rec.f.address, moved: false, additive: e.shiftKey || e.ctrlKey || e.metaKey };
      grid.setPointerCapture(e.pointerId);
    });
    grid.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const cell = document.elementFromPoint(e.clientX, e.clientY)?.closest('.cell');
      if (!cell || !grid.contains(cell)) return;
      const start = Number(cell.dataset.addr) - drag.offset;
      if (start === drag.target) return;
      drag.target = start;
      drag.moved = true;
      clearGhost();
      const ok = this.canPlace(drag.id, universe, start);
      for (let a = Math.max(1, start); a < start + drag.n && a <= 512; a++) grid.children[a - 1].classList.add('ghost', ...(ok ? [] : ['bad']));
    });
    const end = () => {
      const d = drag;
      drag = null;
      clearGhost();
      if (!d) return;
      if (!d.moved) {
        if (d.additive) this.toggle(d.id, !this.store.ui.selectedFixtures.has(d.id));
        else this.store.selectFixtures([d.id]);
        return;
      }
      this.moveFixture(d.id, universe, d.target);
    };
    grid.addEventListener('pointerup', end);
    grid.addEventListener('pointercancel', () => {
      drag = null;
      clearGhost();
    });
  }

  groupsCard() {
    const groups = fixtureGroups(this.store.show);
    if (!groups.length) return null;
    const can = (c) => [c.intensity && 'intensity', c.color && 'colour', c.panTilt && 'pan/tilt', c.zoom && 'zoom', c.strobe && 'strobe', c.gobo && 'gobo', c.prism && 'prism'].filter(Boolean).join(' · ');
    const kinds = { all: 'everything', role: 'similar fixtures', type: 'identical fixtures' };
    return h('div', { class: 'card' },
      h('div', { class: 'row wrap', style: { marginBottom: '8px' } },
        h('h2', { style: { margin: 0 } }, 'Groups'),
        h('span', { class: 'muted' }, 'Made automatically from what each fixture can do and from identical fixture types; they follow the patch.'),
      ),
      h('div', { style: { overflowX: 'auto' } },
        h('table', { class: 'grid' },
          h('thead', {}, h('tr', {}, ['Group', 'Kind', 'Fixtures', 'Can do', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, groups.map((g) => h('tr', {},
            h('td', {}, h('strong', {}, g.name)),
            h('td', { class: 'muted' }, kinds[g.kind]),
            h('td', { class: 'mono' }, String(g.fixtures.length)),
            h('td', { class: 'muted' }, can(g.caps)),
            h('td', { style: { textAlign: 'right' } },
              h('button', { class: 'btn small ghost', onclick: () => this.store.selectFixtures(g.fixtures) }, 'Select'),
              h('button', { class: 'btn small', onclick: () => this.app.showControl?.(g.key) }, icon('sliders', 12), 'Faders'),
            ),
          ))),
        ),
      ),
    );
  }

  stageCard() {
    const st = this.store.show.stage;
    const set = (changes) => this.store.op({ type: 'stage.set', changes });
    const num = (v, fn, extra = {}) => numberInput(v, fn, { step: 0.5, style: { width: '70px' }, ...extra });
    return h(
      'div',
      { class: 'card' },
      h('h2', {}, 'Stage and centre point'),
      h('p', { class: 'muted', style: { margin: '0 0 10px' } }, 'Metres. X runs left to right as the audience sees it, Y is height, Z points toward the audience; the stage front edge is at Z = 0. Moving heads aim at the centre point (fine-tune each one on the Calibrate page), and chases run left to right by X.'),
      h(
        'div',
        { class: 'row wrap' },
        h('span', { class: 'muted' }, 'Stage width'), num(st.width, (v) => set({ width: v }), { min: 1 }),
        h('span', { class: 'muted' }, 'depth'), num(st.depth, (v) => set({ depth: v }), { min: 1 }),
        h('span', { class: 'muted' }, 'height'), num(st.height, (v) => set({ height: v }), { min: 1 }),
        h('span', { class: 'muted', style: { marginLeft: '16px' } }, 'Centre point X'), num(st.audience.x, (v) => set({ audience: { ...st.audience, x: v } })),
        h('span', { class: 'muted' }, 'Y'), num(st.audience.y, (v) => set({ audience: { ...st.audience, y: v } })),
        h('span', { class: 'muted' }, 'Z'), num(st.audience.z, (v) => set({ audience: { ...st.audience, z: v } })),
      ),
    );
  }

  profilesCard() {
    const { show } = this.store;
    if (!show.profiles.length) return null;
    const used = new Set(show.fixtures.map((f) => f.profileId));
    return h(
      'div',
      { class: 'card' },
      h('h2', {}, 'Fixture profiles in this show'),
      h('div', { style: { overflowX: 'auto' } }, h('table', { class: 'grid' },
        h('thead', {}, h('tr', {}, ['Name', 'Maker', 'Channels', 'Source', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, show.profiles.map((p) =>
          h('tr', {},
            h('td', {}, p.name),
            h('td', { class: 'muted' }, p.manufacturer || ''),
            h('td', { class: 'mono' }, String(p.channels.length)),
            h('td', { class: 'muted' }, p.source || 'Embedded'),
            h('td', {}, used.has(p.id)
              ? h('span', { class: 'muted' }, 'in use')
              : h('button', { class: 'btn ghost small', onclick: () => this.store.op({ type: 'profile.remove', id: p.id }) }, icon('trash', 14))),
          ),
        )),
      )),
    );
  }

  async importProfile() {
    const file = await pickFile('.json,application/json');
    if (!file) return;
    let json;
    try {
      json = JSON.parse(await file.text());
    } catch {
      return toast('That file is not valid JSON.', 'error');
    }
    try {
      let profile;
      if (Array.isArray(json.channels) && json.id) {
        const errors = checkProfile(json);
        if (errors.length) throw new Error(errors.join('; '));
        profile = json;
      } else {
        const modes = oflModes(json);
        let modeIndex = 0;
        if (modes.length > 1) {
          let chosen = 0;
          const picked = await dialog(
            `Choose a DMX mode for ${json.name || 'this fixture'}`,
            h('div', { class: 'stack' },
              h('p', { class: 'muted' }, 'Pick the mode the fixture itself is set to (on its menu or DIP switches).'),
              select(modes.map((m) => [m.index, `${m.name} — ${m.channelCount} channels`]), 0, (v) => (chosen = v)),
            ),
            [['Cancel', null], ['Import', true, 'primary']],
          );
          if (!picked) return;
          modeIndex = chosen;
        }
        const maker = json.manufacturer?.name || (await askManufacturer());
        profile = importOflFixture(json, { modeIndex, manufacturer: maker || '' });
      }
      await this.store.op({ type: 'profile.add', profile });
      this.addOpts.profileId = profile.id;
      this.adding = true;
      toast(`Imported ${profile.name} (${profile.channels.length} channels)`, 'ok');
      this.render();
    } catch (err) {
      toast(err.message, 'error', 7000);
    }
  }
}

async function askManufacturer() {
  let value = '';
  const ok = await dialog(
    'Manufacturer',
    h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'Open Fixture Library files do not include the maker; enter it so the profile is easy to find (optional).'),
      textInput('', (v) => (value = v), { placeholder: 'e.g. Chauvet DJ', oninput: (e) => (value = e.target.value) }),
    ),
    [['Skip', false], ['OK', true, 'primary']],
  );
  return ok ? value.trim() : '';
}

function defaultPrefix(profile) {
  if (profileCaps(profile).panTilt) return 'Mover';
  if (profile.kind === 'strobe') return 'Strobe';
  if (profile.kind === 'dimmer') return 'Dimmer';
  return 'Par';
}
