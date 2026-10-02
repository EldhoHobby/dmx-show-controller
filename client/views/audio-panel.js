// Live audio panel (Live mode): start the input on the controller computer, watch what it
// hears in three bands, run the auto show, and choose how the lights react.
//
// Meters come from the engine (every window sees them, phones included); only the computer
// running the controller can open the microphone or line-in.

import { h, mount, icon, toast, select } from '../lib/dom.js';
import { fixtureGroups } from '/shared/groups.js';
import { NAMED_COLORS, hexToRgb, rgbToHex } from '/shared/color.js';
import { uid } from '/shared/util.js';
import { liveAudioSupport } from '../lib/live-audio.js';
import { STYLES, labelName } from '/shared/looks.js';
import { AUTO_STYLES } from '/shared/show.js';
import { liveBeat } from '/shared/analysis/live-tracker.js';

const BANDS = [
  ['low', 'Kick', 'Kick drum and bass (below 150 Hz)'],
  ['mid', 'Snare', 'Snare, claps and vocals (400 Hz – 3 kHz)'],
  ['high', 'Hats', 'Hi-hats and cymbals (above 6 kHz)'],
];
const ACTIONS = [
  ['pulse', 'Pulse intensity'],
  ['flash', 'Flash white'],
  ['strobe', 'Strobe while hitting'],
  ['colorStep', 'Step colour'],
  ['follow', 'Follow the level'],
  ['scene', 'Bring in a scene'],
];
const touches = (op) => !op || ['show.replace', 'reactive.set'].includes(op.type) || /^(scene|fixture|profile)\./.test(op.type) || (op.type === 'batch' && op.ops.some(touches));

function load(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export class AudioPanel {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.el = h('div', { class: 'card stack audio-panel' });
    this.meters = [];
    this.shown = { low: 0, mid: 0, high: 0 }; // meter levels with a visible fall-off
    this.bpmEl = null;
    this.showReactions = load('showReactions', 'false') === 'true';
    this.devices = null;
    this.deviceId = load('liveAudioDevice', '');
    this.store.on('show', (op) => touches(op) && this.build());
    this.store.on('live', () => this.updateToggle());
    this.store.on('liveaudio', () => this.build());
    this.store.on('frame', () => this.updateMeters());
    navigator.mediaDevices?.addEventListener?.('devicechange', () => this.loadDevices());
  }

  async loadDevices() {
    if (!liveAudioSupport().ok) return;
    this.devices = await this.app.liveAudio.devices();
    if (this.el.isConnected) this.build();
  }

  build() {
    const st = this.store;
    const show = st.show;
    if (!show) return;
    const input = this.app.liveAudio;
    const support = liveAudioSupport();
    if (this.devices === null && support.ok) {
      this.devices = [];
      this.loadDevices();
    }
    this.autoToggle = h('button', {
      class: 'btn small',
      title: 'A whole light show from the music by itself: the generator’s looks, played on the live beat. It takes the timeline’s place while on.',
      onclick: () => st.setLive({ autoShow: !st.live.autoShow }),
    });
    this.beatDots = [0, 1, 2, 3].map(() => h('span', { class: 'beat-dot' }));
    this.autoStatus = h('span', { class: 'auto-status' });
    this.toggle = h('button', {
      class: 'btn small',
      title: 'When on, the reactions below drive the lights on top of the show',
      onclick: () => st.setLive({ audioReactive: !st.live.audioReactive }),
    });
    let source;
    if (input.state === 'on') {
      const lat = input.latency;
      source = h('div', { class: 'stack', style: { gap: '4px' } },
        h('div', { class: 'row' },
          h('span', { class: `dot ${input.relay === 'open' ? 'ok' : 'warn'}` }),
          h('span', { class: 'grow', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, input.deviceLabel),
          h('button', { class: 'btn small', onclick: () => input.stop() }, 'Stop'),
        ),
        h('span', { class: 'muted', style: { fontSize: '11px' } },
          lat ? `Input ${lat.input != null ? `${lat.input.toFixed(0)} ms` : '≈10 ms'} + ${lat.block.toFixed(1)} ms block + detection, then straight to the lights. ${input.sampleRate / 1000} kHz.` : ''),
      );
    } else if (input.state === 'starting') {
      source = h('div', { class: 'muted' }, 'Opening the audio input…');
    } else if (!support.ok) {
      source = h('div', { class: 'note', style: { fontSize: '12px' } }, support.reason);
    } else {
      const devices = this.devices || [];
      const options = [['', 'Default input'], ...devices.filter((d) => d.id !== 'default' && d.id !== '').map((d) => [d.id, d.label])];
      source = h('div', { class: 'row' },
        select(options, this.deviceId, (v) => {
          this.deviceId = v;
          try {
            localStorage.setItem('liveAudioDevice', v);
          } catch {}
        }, { 'aria-label': 'Audio input', style: { flex: '1', minWidth: '0' } }),
        h('button', { class: 'btn small primary', onclick: () => this.start() }, icon('mic', 14), 'Listen'),
      );
    }
    this.meters = BANDS.map(([band, label, title]) => {
      const bar = h('span', { class: 'meter-bar' });
      const hit = h('span', { class: 'meter-hit' });
      return { band, bar, hit, row: h('div', { class: 'meter', title }, h('span', { class: 'meter-label' }, label), h('span', { class: 'meter-track' }, bar), hit) };
    });
    this.bpmEl = h('b', { class: 'mono' }, '—');
    const sens = show.audioReactive.sensitivity;
    const sensRow = (band, label) => {
      const input = h('input', { type: 'range', min: 0.2, max: 3, step: 0.05, value: String(sens[band]), 'aria-label': `${label} sensitivity` });
      input.addEventListener('change', () => st.op({ type: 'reactive.set', changes: { sensitivity: { ...show.audioReactive.sensitivity, [band]: Number(input.value) } } }));
      return h('label', { class: 'sens' }, h('span', {}, label), input);
    };
    mount(this.el,
      h('div', { class: 'row' }, h('h3', {}, 'Live audio'), h('div', { class: 'grow' }), this.toggle),
      source,
      h('div', { class: 'meters' }, this.meters.map((m) => m.row)),
      h('div', { class: 'row', style: { fontSize: '12px' } }, h('span', { class: 'muted' }, 'Tempo heard'), this.bpmEl),
      h('div', { class: 'auto-show' },
        h('div', { class: 'row wrap', style: { gap: '6px' } },
          this.autoToggle,
          select(AUTO_STYLES.map((k) => [k, STYLES[k].label]), show.audioReactive.autoStyle, (v) => st.op({ type: 'reactive.set', changes: { autoStyle: v } }), { 'aria-label': 'Auto show style' }),
          h('div', { class: 'beat-dots', title: 'The beat the auto show is following' }, this.beatDots),
        ),
        this.autoStatus,
      ),
      h('details', { class: 'reactions', open: this.showReactions, ontoggle: (e) => {
        this.showReactions = e.target.open;
        try {
          localStorage.setItem('showReactions', String(this.showReactions));
        } catch {}
      } },
        h('summary', {}, `Reactions (${show.audioReactive.mappings.length}) and sensitivity`),
        h('div', { class: 'stack', style: { marginTop: '8px' } },
          h('div', { class: 'sens-row' }, BANDS.map(([band, label]) => sensRow(band, label))),
          show.audioReactive.mappings.map((m, i) => this.mappingRow(m, i)),
          h('div', { class: 'row' },
            h('button', { class: 'btn small', disabled: show.audioReactive.mappings.length >= 32, onclick: () => this.addMapping() }, icon('plus', 12), 'Add reaction'),
          ),
        ),
      ),
    );
    this.updateToggle();
    this.updateMeters();
  }

  async start() {
    try {
      await this.app.liveAudio.start(this.deviceId, this.store.show.audioReactive.sensitivity);
      this.devices = await this.app.liveAudio.devices(); // labels appear once allowed
      if (!this.store.live.audioReactive) toast('Listening. Turn on “Lights react” when you want the audio to drive the lights.', 'ok', 5000);
      this.build();
    } catch (err) {
      toast(err.message, 'error', 7000);
    }
  }

  updateToggle() {
    if (this.autoToggle) {
      const auto = this.store.live.autoShow;
      this.autoToggle.classList.toggle('on', auto);
      this.autoToggle.textContent = auto ? '● Auto show' : 'Auto show: off';
    }
    if (!this.toggle) return;
    const on = this.store.live.audioReactive;
    this.toggle.classList.toggle('on', on);
    this.toggle.textContent = on ? '● Lights react' : 'Lights react: off';
  }

  updateMeters() {
    if (!this.meters.length || !this.el.isConnected) return;
    const r = this.store.reactive;
    const now = this.store.net.serverNow();
    const live = r?.source != null;
    for (const m of this.meters) {
      const level = live ? r.env?.[m.band] || 0 : 0;
      this.shown[m.band] = Math.max(level, this.shown[m.band] * 0.88);
      m.bar.style.transform = `scaleX(${Math.min(1, this.shown[m.band])})`;
      const at = r?.last?.[m.band];
      m.hit.classList.toggle('on', live && at != null && now - at < 90);
    }
    this.bpmEl.textContent = live && r.bpm ? `${Math.round(r.bpm)} BPM` : live ? 'listening…' : 'no input';
    this.updateAuto(r?.auto, now);
  }

  /** What the auto show is following: the part of the song, the tempo, the beat in the bar. */
  updateAuto(a, now) {
    if (!this.autoStatus) return;
    const beat = liveBeat(a, now);
    const pos = beat == null ? -1 : (((Math.round(beat) - a.barOffset) % 4) + 4) % 4;
    const near = beat != null && Math.abs(beat - Math.round(beat)) < 0.12;
    this.beatDots.forEach((d, i) => d.classList.toggle('on', i === pos && near));
    let text;
    if (!a || a.section === 'quiet') text = 'Waiting for music.';
    else if (!a.period) text = 'Listening for a steady kick to find the beat…';
    else {
      const name = labelName(a.section);
      const bar = Math.floor((beat - a.sectionBeat) / 4) % 8 + 1;
      text = `${name} · ${a.bpm} BPM${a.locked ? '' : ' (holding the tempo)'} · bar ${bar} of 8`;
    }
    if (this.autoStatus.textContent !== text) this.autoStatus.textContent = text;
  }

  // ---- Reactions -----------------------------------------------------------------------

  setMappings(fn) {
    const mappings = fn(this.store.show.audioReactive.mappings.map((m) => ({ ...m })));
    this.store.op({ type: 'reactive.set', changes: { mappings } }).catch(() => {});
  }

  addMapping() {
    this.setMappings((list) => [...list, { id: uid('map'), band: 'low', action: 'pulse', target: 'all', amount: 1, decayMs: 250, sceneId: '', colors: [] }]);
  }

  mappingRow(m, index) {
    const st = this.store;
    const change = (changes) => this.setMappings((list) => list.map((x, i) => (i === index ? { ...x, ...changes } : x)));
    const groups = fixtureGroups(st.show);
    const targets = groups.map((g) => [g.key, g.name]);
    if (!groups.some((g) => g.key === m.target)) targets.push([m.target, 'Missing group']);
    const extra = [];
    if (m.action === 'colorStep') {
      const colors = m.colors.length ? m.colors : [NAMED_COLORS.blue];
      extra.push(h('div', { class: 'row wrap', style: { gap: '4px' } },
        h('span', { class: 'muted' }, 'Colours'),
        colors.map((c, ci) => h('input', {
          type: 'color',
          value: rgbToHex(c),
          'aria-label': `Colour ${ci + 1}`,
          onchange: (e) => change({ colors: colors.map((x, j) => (j === ci ? hexToRgb(e.target.value) : x)) }),
        })),
        colors.length < 8 ? h('button', { class: 'btn ghost small', title: 'Add a colour', onclick: () => change({ colors: [...colors, NAMED_COLORS.magenta] }) }, '+') : null,
        colors.length > 1 ? h('button', { class: 'btn ghost small', title: 'Remove the last colour', onclick: () => change({ colors: colors.slice(0, -1) }) }, '−') : null,
      ));
    }
    if (m.action === 'scene') {
      const scenes = st.show.scenes;
      extra.push(scenes.length
        ? select([['', 'Choose a scene'], ...scenes.map((s) => [s.id, s.name])], m.sceneId, (v) => change({ sceneId: v }), { 'aria-label': 'Scene' })
        : h('span', { class: 'muted' }, 'Record a scene first (Edit › Control).'));
    }
    const amount = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: String(m.amount), 'aria-label': 'Amount', style: { width: '70px' } });
    amount.addEventListener('change', () => change({ amount: Number(amount.value) }));
    const decay = h('input', { type: 'number', min: 20, max: 5000, step: 10, value: String(m.decayMs), 'aria-label': 'Decay in milliseconds', style: { width: '64px' } });
    decay.addEventListener('change', () => change({ decayMs: Number(decay.value) || 250 }));
    return h('div', { class: 'mapping' },
      h('div', { class: 'row wrap', style: { gap: '4px' } },
        select(BANDS.map(([b, label]) => [b, label]), m.band, (v) => change({ band: v }), { 'aria-label': 'Band' }),
        select(ACTIONS, m.action, (v) => change({ action: v }), { 'aria-label': 'Reaction' }),
        h('span', { class: 'muted' }, 'on'),
        select(targets, m.target, (v) => change({ target: v }), { 'aria-label': 'Fixtures', style: { maxWidth: '150px' } }),
        h('div', { class: 'grow' }),
        h('button', { class: 'btn ghost small', title: 'Remove this reaction', 'aria-label': 'Remove this reaction', onclick: () => this.setMappings((list) => list.filter((_, i) => i !== index)) }, icon('trash', 12)),
      ),
      h('div', { class: 'row wrap', style: { gap: '6px' } },
        m.action !== 'colorStep' ? [h('span', { class: 'muted' }, 'amount'), amount] : null,
        m.action !== 'colorStep' && m.action !== 'follow' ? [h('span', { class: 'muted' }, 'decay'), decay, h('span', { class: 'muted' }, 'ms')] : null,
        extra,
      ),
    );
  }
}
