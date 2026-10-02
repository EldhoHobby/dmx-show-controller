// Live mode: run the show. Big clock, transport, master, blackout, flash buttons, scenes,
// live audio, health.

import { h, mount, icon, toast, fitCanvas } from '../lib/dom.js';
import { drawOverview } from '../lib/draw.js';
import { createTempo } from '/shared/tempo.js';
import { formatTime } from '/shared/util.js';
import { Visualizer } from './visualizer.js';
import { Monitor } from './monitor.js';
import { ScenePads } from './scene-pads.js';
import { AudioPanel } from './audio-panel.js';

export class LiveView {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.vizCanvas = h('canvas', { 'aria-label': '3D stage view' });
    this.viz = new Visualizer(this.store, this.vizCanvas);
    this.progress = h('canvas', { class: 'live-progress', title: 'Click to jump (double-click while playing)' });
    this.monitor = new Monitor(this.store);
    this.scenePads = new ScenePads(this.store);
    this.audioPanel = new AudioPanel(app);
    this.clock = h('div', { class: 'live-clock' }, '0:00.0');
    this.barBeat = h('b', {}, '1.1');
    this.remaining = h('span', {});
    this.bpm = h('span', {});
    this.playBtn = h('button', { class: 'btn primary big-btn', title: 'Play / pause (Space)', onclick: () => app.togglePlay() }, icon('play', 24));
    this.outputsEl = h('div', {});
    this.flashes = {};
    this.el = h('div', { class: 'live-view' });
    this.build();

    this.progress.addEventListener('click', (e) => {
      if (this.store.transport.playing) return toast('Double-click to jump while the show is playing.', 'info', 2500);
      this.seekFromEvent(e);
    });
    this.progress.addEventListener('dblclick', (e) => this.seekFromEvent(e));

    this.store.on('frame', (pos) => this.frame(pos));
    this.store.on('transport', () => this.updateTransport());
    this.store.on('live', () => this.updateLive());
    this.store.on('status', () => this.updateOutputs());
    this.store.on('show', (op) => {
      if (!op || op.type === 'show.replace' || op.type === 'meta.set') this.build();
    });
  }

  seekFromEvent(e) {
    const r = this.progress.getBoundingClientRect();
    this.app.seek(((e.clientX - r.left) / r.width) * this.store.show.timeline.durationMs);
  }

  build() {
    const { show } = this.store;
    if (!show) return;
    const v = this.store.validation();
    const badge = v.errors
      ? h('button', { class: 'badge error', onclick: () => this.app.showIssues() }, `${v.errors} problem${v.errors === 1 ? '' : 's'}`)
      : show.validated
        ? h('span', { class: 'badge ok' }, icon('check', 12), 'Validated show file')
        : h('span', { class: 'badge' }, 'Not validated');
    const audioOk = this.store.audio.buffer && this.store.audio.hash === show.audio?.hash;
    this.masterInput = h('input', { type: 'range', min: 0, max: 100, step: 1, value: String(Math.round(this.store.live.master * 100)), 'aria-label': 'Grand master' });
    this.masterOut = h('output', {}, `${Math.round(this.store.live.master * 100)}%`);
    this.masterInput.addEventListener('input', () => {
      this.masterOut.textContent = `${this.masterInput.value}%`;
      this.store.setLive({ master: Number(this.masterInput.value) / 100 });
    });
    this.blackoutBtn = h('button', { class: 'btn danger blackout', title: 'Blackout (B)', onclick: () => this.store.setLive({ blackout: !this.store.live.blackout }) }, 'BLACKOUT');
    const flash = (kind, label, keyHint) => {
      const btn = h('button', { class: 'btn', title: `Hold to flash (${keyHint})` }, label);
      const on = (e) => {
        e.preventDefault();
        this.store.setLive({ flash: kind });
      };
      const off = () => {
        if (this.store.live.flash === kind) this.store.setLive({ flash: null });
      };
      btn.addEventListener('pointerdown', on);
      btn.addEventListener('pointerup', off);
      btn.addEventListener('pointerleave', off);
      btn.addEventListener('pointercancel', off);
      btn.addEventListener('contextmenu', (e) => e.preventDefault()); // long press on a phone
      this.flashes[kind] = btn;
      return btn;
    };

    mount(
      this.el,
      h('div', { class: 'live-head' },
        this.playBtn,
        h('button', { class: 'btn big-btn', title: 'Stop and return to the start', onclick: () => this.app.stop() }, icon('stop', 22)),
        h('div', { class: 'stack', style: { gap: '4px' } },
          h('span', { class: 'muted', style: { fontSize: '11px' } }, 'NUDGE'),
          h('div', { class: 'row', style: { gap: '4px' } },
            h('button', { class: 'btn small', title: 'Lights 50 ms earlier (←)', onclick: () => this.app.nudge(-50) }, '◀ 50'),
            h('button', { class: 'btn small', title: 'Lights 50 ms later (→)', onclick: () => this.app.nudge(50) }, '50 ▶'),
          ),
        ),
        this.clock,
        h('div', { class: 'live-sub' }, h('span', {}, 'BAR.BEAT'), this.barBeat),
        h('div', { class: 'live-sub' }, h('span', {}, 'REMAINING'), h('b', {}, this.remaining)),
        h('div', { class: 'live-sub' }, h('span', {}, 'TEMPO'), h('b', {}, this.bpm)),
        h('div', { class: 'grow' }),
        h('div', { class: 'stack', style: { alignItems: 'flex-end', gap: '6px' } },
          h('strong', {}, show.meta.name),
          h('div', { class: 'row' }, badge,
            show.audio ? h('label', { class: 'row', style: { gap: '4px' }, title: audioOk ? 'This device plays the song and the lights follow it' : 'Tick to fetch the song from the show computer and play it here' },
              h('input', { type: 'checkbox', checked: this.app.playAudio, onchange: (e) => this.app.setPlayAudio(e.target.checked) }), 'Play song here') : null,
            h('button', { class: 'btn small', onclick: () => this.app.openShow() }, icon('open', 14), 'Open show file'),
          ),
        ),
      ),
      h('div', { class: 'live-main' }, h('div', { class: 'live-viz' }, this.vizCanvas), this.progress),
      h('div', { class: 'live-side' },
        h('div', { class: 'card stack' },
          h('h3', {}, 'Grand master'),
          h('div', { class: 'master' }, this.masterInput, this.masterOut),
          this.blackoutBtn,
          h('div', { class: 'flash-row' }, flash('blinder', 'BLINDER', 'hold F'), flash('strobe', 'STROBE', 'hold S')),
        ),
        this.scenePads.el,
        this.audioPanel.el,
        h('div', { class: 'card stack' }, h('h3', {}, 'Output'), this.outputsEl),
        h('div', { class: 'card' }, this.monitor.el),
        h('div', { class: 'card muted', style: { fontSize: '12px' } },
          h('strong', { style: { color: 'var(--text)' } }, 'Keys  '),
          'Space play/pause · B blackout · hold F blinder · hold S strobe · ← → nudge 50 ms'),
      ),
    );
    this.monitor.renderPicker();
    this.scenePads.build();
    this.audioPanel.build();
    this.updateTransport();
    this.updateLive();
    this.updateOutputs();
  }

  start() {
    this.viz.start();
  }

  stop() {
    this.viz.stop();
  }

  frame(pos) {
    if (!this.el.isConnected) return;
    const show = this.store.show;
    const tempo = createTempo(show.tempo);
    const bb = tempo.barBeat(pos);
    this.clock.textContent = formatTime(pos).slice(0, -2);
    this.barBeat.textContent = `${bb.bar}.${bb.beat}`;
    this.remaining.textContent = formatTime(Math.max(0, show.timeline.durationMs - pos), false);
    this.bpm.textContent = `${tempo.bpm.toFixed(1)}`;
    const { ctx, w, h: hh } = fitCanvas(this.progress);
    drawOverview(ctx, w, hh, this.store, pos);
  }

  updateTransport() {
    const playing = this.store.transport.playing;
    this.playBtn.replaceChildren(icon(playing ? 'pause' : 'play', 24));
  }

  updateLive() {
    const live = this.store.live;
    if (!this.blackoutBtn) return;
    this.blackoutBtn.classList.toggle('on', live.blackout);
    if (document.activeElement !== this.masterInput) {
      this.masterInput.value = String(Math.round(live.master * 100));
      this.masterOut.textContent = `${Math.round(live.master * 100)}%`;
    }
    for (const [kind, btn] of Object.entries(this.flashes)) btn.classList.toggle('active', live.flash === kind);
  }

  updateOutputs() {
    const st = this.store.status;
    if (!st) return;
    const lines = (st.outputs || []).map((o) =>
      h('div', { class: 'out-line' },
        h('span', { class: `dot ${o.ready && !o.errors ? 'ok' : o.ready ? 'warn' : 'error'}` }),
        h('span', { class: 'grow' }, `${o.type === 'sacn' ? 'sACN' : 'Art-Net'} U${o.universes.join(', U')} ${o.target}`),
        o.errors ? h('span', { class: 'badge error', title: o.lastError }, `${o.errors} err`) : null,
      ),
    );
    for (const c of this.store.clients) if (c.usbUniverse) lines.push(h('div', { class: 'out-line' }, h('span', { class: 'dot ok' }), h('span', {}, `USB U${c.usbUniverse} via ${c.name}`)));
    if (!lines.length) lines.push(h('div', { class: 'out-line' }, h('span', { class: 'dot error' }), 'No DMX output is enabled — see Edit › Outputs.'));
    const e = st.engine;
    if (e) lines.push(h('div', { class: 'out-line muted' }, `Engine ${e.fps} fps · ${this.store.clients.length} window${this.store.clients.length === 1 ? '' : 's'} connected`));
    mount(this.outputsEl, lines);
  }
}
