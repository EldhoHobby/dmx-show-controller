// Side panel: properties of the selected clip, fixture or layer.

import { h, mount, select, numberInput, textInput, icon } from '../lib/dom.js';
import { CLIP_TYPES, KEYFRAME_PARAMS, EASINGS, defaultParams } from '/shared/clip-types.js';
import { createTempo } from '/shared/tempo.js';
import { channelName, footprint, profileCaps, resolveProfile } from '/shared/fixture-library.js';
import { hexToRgb, rgbToHex } from '/shared/color.js';
import { formatTime } from '/shared/util.js';
import { fixtureGroups } from '/shared/groups.js';

export class Inspector {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.el = h('div', { class: 'inspector' });
    const rerender = () => this.render();
    this.store.on('selection', rerender);
    this.store.on('show', rerender);
  }

  render() {
    const { show, ui } = this.store;
    if (!show) return;
    const focusKey = document.activeElement?.dataset?.focusKey;
    const clips = show.timeline.clips.filter((c) => ui.selectedClips.has(c.id));
    let body;
    if (clips.length === 1) body = this.clipPanel(clips[0]);
    else if (clips.length > 1) body = this.multiPanel(clips);
    else if (ui.tab === 'patch' && ui.selectedFixtures.size === 1) body = this.fixturePanel(show.fixtures.find((f) => ui.selectedFixtures.has(f.id)));
    else if (ui.tab === 'timeline' && ui.selectedTrack && show.timeline.tracks.some((t) => t.id === ui.selectedTrack)) body = this.trackPanel(show.timeline.tracks.find((t) => t.id === ui.selectedTrack));
    else body = this.hint();
    mount(this.el, body);
    if (focusKey) this.el.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
  }

  hint() {
    const tab = this.store.ui.tab;
    const text = {
      patch: 'Select one fixture to see its channels and set a custom mounting rotation.',
      song: 'Load a song, check the beat grid, then generate a show.',
      timeline: 'Select a clip to edit it. Click a layer name to rename, mute or remove it.',
      outputs: 'Choose how DMX leaves this computer.',
    }[tab] || '';
    return h('div', { class: 'empty' }, text);
  }

  // ---- Clips -------------------------------------------------------------------------

  clipPanel(c) {
    const def = CLIP_TYPES[c.type];
    const update = (changes) => this.store.op({ type: 'clip.update', id: c.id, changes });
    const setParam = (key, value) => {
      const params = { ...c.params };
      if (value === undefined) delete params[key];
      else params[key] = value;
      update({ params });
    };
    const tempo = createTempo(this.store.show.tempo);
    const bb = (ms) => {
      const p = tempo.barBeat(ms);
      return `${p.bar}.${p.beat}`;
    };
    const key = (k) => ({ 'data-focus-key': `${c.id}:${k}` });
    const lengthBeats = tempo.beatAt(c.end) - tempo.beatAt(c.start);
    return h(
      'div',
      {},
      h('div', { class: 'row' },
        h('span', { class: 'sec-chip', style: { background: def.color } }),
        h('h2', { class: 'grow' }, def.label),
        h('button', { class: 'btn small danger', onclick: () => this.store.op({ type: 'clip.remove', id: c.id }) }, icon('trash', 14), 'Delete'),
      ),
      h('p', { class: 'muted', style: { margin: '4px 0 0' } }, def.hint),
      h('div', { class: 'section' },
        h('label', { class: 'field' }, h('span', {}, 'Name'), textInput(c.name, (v) => update({ name: v }), { placeholder: def.label, ...key('name') })),
        h('label', { class: 'field' }, h('span', {}, 'Type'), select(Object.entries(CLIP_TYPES).map(([k, d]) => [k, d.label]), c.type, (v) => update({ type: v, params: defaultParams(v) }), key('type'))),
        h('label', { class: 'field' }, h('span', {}, 'Starts'), h('div', { class: 'row' },
          numberInput(Math.round(c.start), (v) => update({ start: Math.max(0, v), end: Math.max(0, v) + (c.end - c.start) }), { step: 10, style: { width: '90px' }, ...key('start') }),
          h('span', { class: 'muted mono' }, `ms · bar ${bb(c.start)}`))),
        h('label', { class: 'field' }, h('span', {}, 'Length'), h('div', { class: 'row' },
          numberInput(Math.round(c.end - c.start), (v) => update({ end: c.start + Math.max(50, v) }), { step: 10, style: { width: '90px' }, ...key('len') }),
          h('span', { class: 'muted mono' }, `ms · ${lengthBeats.toFixed(lengthBeats % 1 ? 2 : 0)} beats`))),
        h('label', { class: 'field' }, h('span', {}, 'Fade in / out'), h('div', { class: 'row' },
          numberInput(Math.round(c.fadeIn), (v) => update({ fadeIn: Math.max(0, v) }), { step: 50, min: 0, ...key('fi') }),
          numberInput(Math.round(c.fadeOut), (v) => update({ fadeOut: Math.max(0, v) }), { step: 50, min: 0, ...key('fo') }),
          h('span', { class: 'muted' }, 'ms'))),
      ),
      h('div', { class: 'section' }, h('h3', {}, 'Settings'), this.paramFields(c, def, setParam, key)),
      c.type === 'keyframes' ? this.keyframeEditor(c, update) : null,
      h('div', { class: 'section' }, h('h3', {}, `Fixtures (${c.fixtures.length})`), this.fixturePicker(c.fixtures, (ids) => update({ fixtures: ids }))),
    );
  }

  paramFields(c, def, setParam, key) {
    const p = c.params || {};
    if (!def.params.length) return h('div', { class: 'muted' }, 'Edit keyframes below.');
    return def.params.map((spec) => {
      if (spec.showIf && !spec.showIf(p)) return null;
      const isSet = p[spec.key] !== undefined;
      const value = isSet ? p[spec.key] : spec.default;
      let control;
      if (spec.optional && !isSet) {
        control = h('button', { class: 'btn small ghost', onclick: () => setParam(spec.key, structuredClone(spec.default)) }, '+ set');
      } else {
        control = this.control(spec, value, (v) => setParam(spec.key, v), key(spec.key));
        if (spec.optional) {
          control = h('div', { class: 'field-row' }, control, h('button', { class: 'btn small ghost', title: 'Stop setting this', onclick: () => setParam(spec.key, undefined) }, '×'));
        }
      }
      return h('label', { class: 'field' }, h('span', {}, spec.label), control);
    });
  }

  control(spec, value, onChange, keyProps) {
    switch (spec.type) {
      case 'range': {
        const out = h('output', {}, Number(value).toFixed(2));
        const input = h('input', { type: 'range', min: spec.min, max: spec.max, step: spec.step, value: String(value), ...keyProps });
        input.addEventListener('input', () => (out.textContent = Number(input.value).toFixed(2)));
        input.addEventListener('change', () => onChange(Number(input.value)));
        return h('div', { class: 'field-row' }, input, out);
      }
      case 'number':
      case 'int':
        return numberInput(value, (v) => onChange(spec.type === 'int' ? Math.round(v) : v), { min: spec.min, max: spec.max, step: spec.step || 1, ...keyProps });
      case 'select':
        return select(spec.options, value, onChange, keyProps);
      case 'toggle':
        return h('input', { type: 'checkbox', checked: !!value, onchange: (e) => onChange(e.target.checked ? 1 : 0), ...keyProps });
      case 'color': {
        const input = h('input', { type: 'color', value: rgbToHex(value), ...keyProps });
        input.addEventListener('change', () => onChange(hexToRgb(input.value)));
        return input;
      }
      case 'colors': {
        const list = Array.isArray(value) ? value : [];
        return h('div', { class: 'palette' },
          list.map((col, i) => {
            const input = h('input', { type: 'color', value: rgbToHex(col) });
            input.addEventListener('change', () => onChange(list.map((x, j) => (j === i ? hexToRgb(input.value) : x))));
            return input;
          }),
          h('button', { class: 'btn small', title: 'Add a colour', onclick: () => onChange([...list, [1, 1, 1]]) }, '+'),
          list.length > 1 ? h('button', { class: 'btn small', title: 'Remove the last colour', onclick: () => onChange(list.slice(0, -1)) }, '−') : null,
        );
      }
      default:
        return h('span', { class: 'muted' }, String(value));
    }
  }

  keyframeEditor(c, update) {
    const keys = c.params?.keys || {};
    const setKeys = (next) => update({ params: { ...c.params, keys: next } });
    const rel = Math.round(this.store.positionNow() - c.start);
    const inClip = rel >= 0 && rel <= c.end - c.start;
    const params = Object.keys(KEYFRAME_PARAMS);
    return h('div', { class: 'section' },
      h('h3', {}, 'Keyframes'),
      h('p', { class: 'muted', style: { margin: 0 } }, 'Times are from the start of the clip. Each keyframe eases toward the next one.'),
      params.map((param) => {
        const spec = KEYFRAME_PARAMS[param];
        const list = (keys[param] || []).slice().sort((a, b) => a.t - b.t);
        const setList = (next) => setKeys({ ...keys, [param]: next.sort((a, b) => a.t - b.t) });
        if (!list.length) {
          return h('div', { class: 'row' }, h('span', { class: 'muted grow' }, spec.label),
            h('button', { class: 'btn small ghost', onclick: () => setList([{ t: 0, v: structuredClone(spec.default), ease: 'linear' }]) }, '+ animate'));
        }
        return h('div', { class: 'stack', style: { gap: '4px' } },
          h('div', { class: 'row' }, h('strong', { class: 'grow' }, spec.label),
            h('button', { class: 'btn small', disabled: !inClip, title: inClip ? 'Add a keyframe at the playhead' : 'Move the playhead inside the clip', onclick: () => setList([...list.filter((k) => k.t !== rel), { t: rel, v: structuredClone(interpolated(list, rel, spec)), ease: 'linear' }]) }, '+ at playhead'),
            h('button', { class: 'btn small ghost', title: 'Stop animating', onclick: () => {
              const next = { ...keys };
              delete next[param];
              setKeys(next);
            } }, '×')),
          h('table', { class: 'kf-table' }, h('tbody', {}, list.map((k, i) => h('tr', {},
            h('td', {}, numberInput(Math.round(k.t), (v) => setList(list.map((x, j) => (j === i ? { ...x, t: Math.max(0, v) } : x))), { step: 50, title: 'ms from clip start' })),
            h('td', {}, spec.kind === 'color'
              ? (() => {
                  const input = h('input', { type: 'color', value: rgbToHex(k.v) });
                  input.addEventListener('change', () => setList(list.map((x, j) => (j === i ? { ...x, v: hexToRgb(input.value) } : x))));
                  return input;
                })()
              : numberInput(k.v, (v) => setList(list.map((x, j) => (j === i ? { ...x, v } : x))), { step: spec.max > 1 ? 1 : 0.05, min: spec.min, max: spec.max })),
            h('td', {}, select(EASINGS, k.ease || 'linear', (v) => setList(list.map((x, j) => (j === i ? { ...x, ease: v } : x))))),
            h('td', {}, h('button', { class: 'btn small ghost', onclick: () => setList(list.filter((_, j) => j !== i)) }, '×')),
          )))),
        );
      }),
    );
  }

  fixturePicker(selectedIds, onChange) {
    const { show } = this.store;
    const set = new Set(selectedIds);
    // The automatic groups: similar fixtures (by role) and identical ones (by type).
    const groups = fixtureGroups(show);
    const roleGroups = groups.filter((g) => g.kind === 'role');
    const byId = new Map(show.fixtures.map((f) => [f.id, f]));
    const inRole = new Set(roleGroups.flatMap((g) => g.fixtures));
    const unknown = show.fixtures.filter((f) => !inRole.has(f.id));
    const sameSet = (ids) => ids.length === set.size && ids.every((id) => set.has(id));
    const toggleMany = (ids, on) => {
      const next = new Set(set);
      ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
      onChange(show.fixtures.filter((f) => next.has(f.id)).map((f) => f.id));
    };
    const item = (f) => h('label', {}, h('input', { type: 'checkbox', checked: set.has(f.id), onchange: (e) => toggleMany([f.id], e.target.checked) }), f.name);
    return h('div', { class: 'stack' },
      h('div', { class: 'chips' },
        h('button', { class: 'btn small', onclick: () => onChange([]) }, 'None'),
        groups.map((g) => h('button', {
          class: `btn small${set.size && sameSet(g.fixtures) ? ' on' : ''}`,
          title: `${g.fixtures.length} fixture${g.fixtures.length === 1 ? '' : 's'}`,
          onclick: () => onChange(g.fixtures),
        }, g.kind === 'all' ? 'All' : g.name)),
      ),
      h('div', { class: 'fx-list' },
        show.fixtures.length ? [
          roleGroups.map((g) => [
            h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '4px' } }, g.name),
            g.fixtures.map((id) => byId.get(id)).filter(Boolean).map(item),
          ]),
          unknown.length ? [h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '4px' } }, 'Missing fixture type'), unknown.map(item)] : null,
        ] : h('span', { class: 'muted' }, 'No fixtures patched.'),
      ),
    );
  }

  multiPanel(clips) {
    return h('div', {},
      h('h2', {}, `${clips.length} clips selected`),
      h('p', { class: 'muted' }, `From ${formatTime(Math.min(...clips.map((c) => c.start)))} to ${formatTime(Math.max(...clips.map((c) => c.end)))}. Drag any of them to move them together.`),
      h('div', { class: 'row' },
        h('button', { class: 'btn danger', onclick: () => this.store.op({ type: 'batch', ops: clips.map((c) => ({ type: 'clip.remove', id: c.id })) }) }, icon('trash', 14), 'Delete all'),
        h('button', { class: 'btn', onclick: () => this.store.selectClips([]) }, 'Clear selection'),
      ),
      h('div', { class: 'section' }, h('h3', {}, 'Set fixtures on all'), this.fixturePicker(
        [...new Set(clips.flatMap((c) => c.fixtures))],
        (ids) => this.store.op({ type: 'batch', ops: clips.map((c) => ({ type: 'clip.update', id: c.id, changes: { fixtures: ids } })) }),
      )),
    );
  }

  // ---- Fixtures and layers -----------------------------------------------------------

  fixturePanel(f) {
    if (!f) return this.hint();
    const { show } = this.store;
    const profile = resolveProfile(show, f.profileId);
    const update = (changes) => this.store.op({ type: 'fixture.update', id: f.id, changes });
    const rot = (axis) => numberInput(f.rotation[axis], (v) => update({ rotation: { ...f.rotation, [axis]: v } }), { step: 5, style: { width: '64px' }, 'data-focus-key': `${f.id}:r${axis}` });
    return h('div', {},
      h('h2', {}, f.name),
      h('p', { class: 'muted', style: { margin: '4px 0 0' } }, profile ? `${profile.name}${profile.manufacturer ? ` · ${profile.manufacturer}` : ''}` : `Missing profile ${f.profileId}`),
      h('div', { class: 'section' },
        h('h3', {}, 'Mounting rotation (degrees)'),
        h('div', { class: 'row' }, h('span', { class: 'muted' }, 'X'), rot('x'), h('span', { class: 'muted' }, 'Y'), rot('y'), h('span', { class: 'muted' }, 'Z'), rot('z')),
        h('p', { class: 'muted', style: { margin: 0 } }, 'X tilts the fixture forward/back, Y turns it, Z rolls it. A beam at rest points out of the fixture base: 0,0,0 points up, 180,0,0 hangs pointing down, 90,0,0 faces the audience. You can also drag fixtures and their beams in the stage layout on the Patch page.'),
      ),
      profile && profileCaps(profile).panTilt ? h('div', { class: 'section' },
        h('h3', {}, 'Calibration offset'),
        h('div', { class: 'row' },
          h('span', { class: 'mono' }, `pan ${f.calibration.pan.toFixed(2)}° · tilt ${f.calibration.tilt.toFixed(2)}°`),
          h('div', { class: 'grow' }),
          h('button', { class: 'btn small', onclick: () => {
            this.app.showTab('calibrate');
            this.store.setLive({ calibrate: { fixtureId: f.id, othersOff: true } });
          } }, icon('target', 12), 'Calibrate'),
        ),
        h('p', { class: 'muted', style: { margin: 0 } }, 'Added to every position the show gives this moving head, so it really hits the centre point.'),
      ) : null,
      profile ? h('div', { class: 'section' },
        h('button', { class: 'btn small', onclick: () => {
          this.store.selectFixtures([f.id]);
          this.app.showTab('control');
        } }, icon('sliders', 12), 'Test with faders and channels'),
      ) : null,
      profile ? h('div', { class: 'section' },
        h('h3', {}, `DMX channels ${f.address}–${f.address + footprint(profile) - 1} (universe ${f.universe})`),
        h('table', { class: 'grid' }, h('tbody', {}, profile.channels.map((ch, i) => h('tr', {},
          h('td', { class: 'mono muted' }, String(f.address + i)),
          h('td', {}, channelName(ch)),
          h('td', { class: 'muted' }, ch.attr === 'fixed' ? `fixed at ${ch.value}` : ch.fine ? `${ch.attr} (fine)` : ch.attr),
        )))),
      ) : null,
    );
  }

  trackPanel(t) {
    const tracks = this.store.show.timeline.tracks;
    const i = tracks.indexOf(t);
    const clipCount = this.store.show.timeline.clips.filter((c) => c.track === t.id).length;
    const move = (dir) => {
      const j = i + dir;
      if (j < 0 || j >= tracks.length) return;
      this.store.op({ type: 'batch', ops: [{ type: 'track.remove', id: t.id }, { type: 'track.add', track: t, index: j }, ...this.store.show.timeline.clips.filter((c) => c.track === t.id).map((c) => ({ type: 'clip.add', clip: c }))] });
    };
    return h('div', {},
      h('h2', {}, 'Layer'),
      h('div', { class: 'section' },
        h('label', { class: 'field' }, h('span', {}, 'Name'), textInput(t.name, (v) => this.store.op({ type: 'track.update', id: t.id, changes: { name: v } }), { 'data-focus-key': `${t.id}:name` })),
        h('label', { class: 'field' }, h('span', {}, 'Muted'), h('input', { type: 'checkbox', checked: t.muted, onchange: (e) => this.store.op({ type: 'track.update', id: t.id, changes: { muted: e.target.checked } }) })),
        h('p', { class: 'muted', style: { margin: 0 } }, `${clipCount} clips. Higher layers win for colour and position; intensity mixes highest-takes-precedence.`),
        h('div', { class: 'row' },
          h('button', { class: 'btn small', disabled: i === tracks.length - 1, onclick: () => move(1) }, 'Move up'),
          h('button', { class: 'btn small', disabled: i === 0, onclick: () => move(-1) }, 'Move down'),
          h('div', { class: 'grow' }),
          h('button', { class: 'btn small danger', disabled: tracks.length <= 1, onclick: () => this.store.op({ type: 'track.remove', id: t.id }) }, icon('trash', 14), 'Delete layer'),
        ),
      ),
    );
  }
}

function interpolated(list, rel, spec) {
  if (!list.length) return spec.default;
  let prev = list[0];
  for (const k of list) {
    if (k.t <= rel) prev = k;
  }
  return prev.v;
}
