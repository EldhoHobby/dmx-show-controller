// Song: load the music, analyse it, correct the beat grid, then generate the show.

import { h, mount, select, numberInput, icon, toast, confirmDialog, fitCanvas, SECTION_COLORS } from '../lib/dom.js';
import { drawOverview } from '../lib/draw.js';
import { createTempo, uniformBeats } from '/shared/tempo.js';
import { generateShow, STYLES } from '/shared/autogen.js';
import { formatTime, median, mod } from '/shared/util.js';

const LABELS = ['intro', 'groove', 'build', 'drop', 'high', 'breakdown', 'low', 'outro'];

export class SongView {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.el = h('div', { class: 'song' });
    this.busy = null; // { p, label }
    this.style = localStorage.getItem('genStyle') || 'balanced';
    this.taps = [];
    this.canvas = h('canvas', { class: 'overview', title: 'Click to move the playhead' });
    this.canvas.addEventListener('click', (e) => {
      const r = this.canvas.getBoundingClientRect();
      app.seek(((e.clientX - r.left) / r.width) * this.store.show.timeline.durationMs);
    });
    this.store.on('show', (op) => {
      if (!op || /^(audio|tempo|analysis|timeline|show)/.test(op.type)) this.render();
    });
    this.store.on('audio', () => this.render());
    this.store.on('frame', (pos) => this.drawCanvas(pos));
  }

  get hasAudio() {
    const a = this.store.audio;
    return !!(a.buffer && a.hash && a.hash === this.store.show.audio?.hash);
  }

  render() {
    const { show } = this.store;
    if (!show) return;
    const audio = this.store.audio;
    const cards = [];
    if (!this.hasAudio && !show.analysis) cards.push(this.dropCard());
    else cards.push(this.songCard());
    if (show.analysis) cards.push(this.generateCard(), this.syncCard());
    mount(this.el, ...cards);
    if (audio.buffer || show.analysis) requestAnimationFrame(() => this.drawCanvas(this.store.positionNow()));
  }

  dropCard() {
    const zone = h(
      'div',
      { class: 'dropzone' },
      h('h2', {}, 'Load the song'),
      h('p', {}, 'Drop an MP3, WAV, AAC/M4A or FLAC file here. It is analysed on this computer and never stored in the show file.'),
      h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '14px' } },
        h('button', { class: 'btn primary', onclick: () => this.chooseFile() }, icon('open'), 'Choose a song'),
        h('button', { class: 'btn', onclick: () => this.loadDemo() }, 'Use the 128 BPM demo track'),
      ),
      this.store.show.audio ? h('p', { class: 'muted', style: { marginTop: '14px' } }, `This show was made for “${this.store.show.audio.name}”. Load that file to hear it.`) : null,
      this.busy ? this.progress() : null,
    );
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('over');
      const file = e.dataTransfer.files?.[0];
      if (file) this.loadFile(file);
    });
    return h('div', { class: 'card' }, zone);
  }

  progress() {
    return h('div', { class: 'stack', style: { marginTop: '14px' } },
      h('div', { class: 'progress' }, h('div', { style: { width: `${Math.round(this.busy.p * 100)}%` } })),
      h('span', { class: 'muted' }, this.busy.label),
    );
  }

  songCard() {
    const { show } = this.store;
    const a = show.analysis;
    const audioName = this.hasAudio ? this.store.audio.name : show.audio?.name || 'Song';
    return h(
      'div',
      { class: 'card' },
      h('div', { class: 'row wrap', style: { marginBottom: '10px' } },
        h('h2', {}, audioName),
        h('span', { class: 'muted' }, formatTime(show.audio?.durationMs || show.timeline.durationMs, false)),
        this.hasAudio ? null : h('span', { class: 'badge warn' }, 'audio not loaded in this window'),
        h('div', { class: 'grow' }),
        this.hasAudio ? h('button', { class: 'btn', disabled: !!this.busy, onclick: () => this.analyse() }, 'Re-analyse') : null,
        h('button', { class: 'btn', disabled: !!this.busy, onclick: () => this.chooseFile() }, icon('open'), this.hasAudio ? 'Replace song' : 'Load song'),
      ),
      this.canvas,
      this.busy ? this.progress() : null,
      a ? this.analysisPanel(a) : null,
    );
  }

  analysisPanel(a) {
    const { show } = this.store;
    const tempo = show.tempo;
    const grid = createTempo(tempo);
    const tapBpm = this.tapBpm();
    return h(
      'div',
      { class: 'stack', style: { marginTop: '14px' } },
      h('div', { class: 'row wrap' },
        h('div', { class: 'stat' }, h('span', {}, 'Tempo (BPM)'), numberInput(Math.round(tempo.bpm * 100) / 100, (v) => this.setBpm(v), { min: 40, max: 250, step: 0.01, style: { width: '90px', fontSize: '18px', fontFamily: 'var(--mono)' } })),
        h('div', { class: 'stat' }, h('span', {}, 'Confidence'), h('b', {}, `${Math.round((a.confidence ?? 0) * 100)}%`)),
        h('div', { class: 'stat' }, h('span', {}, 'Sections'), h('b', {}, String(a.sections.length))),
        h('div', { class: 'stat' }, h('span', {}, 'Drops'), h('b', {}, String(a.drops.length))),
        h('div', { class: 'stack' },
          h('div', { class: 'row' },
            h('button', { class: 'btn small', title: 'Half the tempo', onclick: () => this.halve() }, '÷2'),
            h('button', { class: 'btn small', title: 'Double the tempo', onclick: () => this.double() }, '×2'),
            h('button', { class: 'btn small', onclick: () => this.tap() }, 'Tap'),
            tapBpm ? h('button', { class: 'btn small primary', onclick: () => this.setBpm(tapBpm) }, `Use ${tapBpm.toFixed(1)}`) : null,
          ),
          h('div', { class: 'row' },
            h('span', { class: 'muted' }, 'Grid'),
            h('button', { class: 'btn small', title: 'Move every beat 10 ms earlier', onclick: () => this.nudge(-10) }, '◀ 10 ms'),
            h('button', { class: 'btn small', title: 'Move every beat 10 ms later', onclick: () => this.nudge(10) }, '10 ms ▶'),
            h('span', { class: 'muted' }, 'Bar 1'),
            h('button', { class: 'btn small', title: 'Bars start one beat earlier', onclick: () => this.shiftDownbeat(-1) }, '◀'),
            h('button', { class: 'btn small', title: 'Bars start one beat later', onclick: () => this.shiftDownbeat(1) }, '▶'),
          ),
        ),
      ),
      a.confidence < 0.4 ? h('div', { class: 'note warn' }, 'The beat was hard to find in this song. Check the grid against the music (play it and watch the bar counter), and correct it with Tap, ×2/÷2 or the grid buttons.') : null,
      h('table', { class: 'grid' },
        h('thead', {}, h('tr', {}, ['Section', 'Starts', 'Bars', 'Energy'].map((t) => h('th', {}, t)))),
        h('tbody', {}, a.sections.map((s, i) => {
          const bars = Math.round((grid.beatAt(s.end) - grid.beatAt(s.start)) / grid.beatsPerBar);
          return h('tr', {},
            h('td', {}, h('span', { class: 'sec-chip', style: { background: SECTION_COLORS[s.label] } }), select(LABELS.map((l) => [l, l]), s.label, (v) => this.relabel(i, v))),
            h('td', { class: 'mono' }, h('a', { href: '#', onclick: (e) => (e.preventDefault(), this.app.seek(s.start)) }, formatTime(s.start))),
            h('td', { class: 'mono' }, String(bars)),
            h('td', {}, h('div', { class: 'progress', style: { width: '120px' } }, h('div', { style: { width: `${Math.round(s.energy * 100)}%`, background: SECTION_COLORS[s.label] } }))),
          );
        })),
      ),
      h('p', { class: 'muted' }, 'Section labels drive the generator: fix any the analysis got wrong before generating.'),
    );
  }

  generateCard() {
    const { show } = this.store;
    return h(
      'div',
      { class: 'card' },
      h('h2', {}, 'Generate the show'),
      h('p', { class: 'muted', style: { margin: '0 0 10px' } },
        `Builds a complete first draft from the ${show.analysis.sections.length} sections and your ${show.fixtures.length} fixtures: base looks, beat chases, movement, colour effects and drop hits on five tracks. Every clip can be edited afterwards.`),
      h('div', { class: 'row wrap' },
        h('span', { class: 'muted' }, 'Style'),
        select(Object.entries(STYLES).map(([k, s]) => [k, s.label]), this.style, (v) => {
          this.style = v;
          localStorage.setItem('genStyle', v);
        }),
        h('button', { class: 'btn primary', disabled: !show.fixtures.length, onclick: () => this.generate() }, icon('wand'), 'Generate show'),
        !show.fixtures.length ? h('span', { class: 'muted' }, 'Patch fixtures first.') : null,
      ),
    );
  }

  syncCard() {
    const audio = this.store.audio;
    return h(
      'div',
      { class: 'card' },
      h('h2', {}, 'Audio sync'),
      h('p', { class: 'muted', style: { margin: '0 0 10px' } }, 'If the lights look early or late against the music on your speakers, shift them here. Positive moves the lights later. This setting belongs to this computer, not the show.'),
      h('div', { class: 'row wrap' },
        h('span', { class: 'muted' }, 'Light offset'),
        numberInput(audio.offsetMs, (v) => audio.setOffset(Math.max(-500, Math.min(500, v))), { step: 5, min: -500, max: 500 }),
        h('span', { class: 'muted' }, 'ms'),
        h('span', { class: 'muted', style: { marginLeft: '18px' } }, 'Song volume'),
        (() => {
          const input = h('input', { type: 'range', min: 0, max: 100, step: 1, value: String(Math.round(audio.volume * 100)), 'aria-label': 'Song volume' });
          input.addEventListener('input', () => audio.setVolume(Number(input.value) / 100));
          return input;
        })(),
      ),
    );
  }

  drawCanvas(pos) {
    if (!this.canvas.isConnected || !this.store.show) return;
    const { ctx, w, h: hh } = fitCanvas(this.canvas);
    drawOverview(ctx, w, hh, this.store, pos);
  }

  // ---- Loading and analysis ---------------------------------------------------------

  async chooseFile() {
    const input = h('input', { type: 'file', accept: 'audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg', style: { display: 'none' } });
    input.addEventListener('change', () => input.files[0] && this.loadFile(input.files[0]));
    document.body.append(input);
    input.click();
    setTimeout(() => input.remove(), 60000);
  }

  async loadFile(file) {
    this.busy = { p: 0.02, label: `Decoding ${file.name}…` };
    this.render();
    try {
      const { hash, buffer } = await this.store.audio.loadFile(file);
      await this.afterLoad(file.name, hash, buffer);
    } catch (err) {
      this.busy = null;
      this.render();
      toast(err.message, 'error', 7000);
    }
  }

  async loadDemo() {
    this.busy = { p: 0.02, label: 'Loading the demo track…' };
    this.render();
    try {
      const { hash, buffer } = await this.store.audio.loadUrl('/samples/demo-128bpm.wav', 'Demo track (128 BPM).wav');
      await this.afterLoad('Demo track (128 BPM).wav', hash, buffer);
    } catch (err) {
      this.busy = null;
      this.render();
      toast(`${err.message}. Run “npm run demo-audio” once to create the demo track.`, 'error', 8000);
    }
  }

  async afterLoad(name, hash, buffer) {
    const { show } = this.store;
    const sameSong = show.audio?.hash === hash && show.analysis;
    if (sameSong) {
      this.busy = null;
      this.render();
      toast('Song loaded — it matches this show, so the existing analysis is kept.', 'ok');
      return;
    }
    await this.store.op({
      type: 'audio.set',
      audio: { name, hash, durationMs: Math.round(buffer.duration * 1000), sampleRate: buffer.sampleRate },
    });
    await this.analyse();
  }

  analyse() {
    const audio = this.store.audio;
    if (!audio.buffer) return;
    this.busy = { p: 0.03, label: 'Starting analysis…' };
    this.render();
    return new Promise((resolve) => {
      const worker = new Worker('/analysis-worker.js', { type: 'module' });
      const channels = audio.channelData();
      worker.onmessage = async (e) => {
        const m = e.data;
        if (m.type === 'progress') {
          this.busy = { p: m.p, label: `${m.label}…` };
          const bar = this.el.querySelector('.progress > div');
          const label = this.el.querySelector('.progress + span');
          if (bar) bar.style.width = `${Math.round(m.p * 100)}%`;
          if (label) label.textContent = this.busy.label;
          return;
        }
        worker.terminate();
        this.busy = null;
        if (m.type === 'error') {
          toast(m.message, 'error', 8000);
          this.render();
          return resolve();
        }
        await this.applyAnalysis(m.result);
        resolve();
      };
      worker.onerror = (e) => {
        worker.terminate();
        this.busy = null;
        toast(`Analysis failed: ${e.message}`, 'error', 8000);
        this.render();
        resolve();
      };
      worker.postMessage({ channels, sampleRate: audio.buffer.sampleRate }, channels.map((c) => c.buffer));
    });
  }

  async applyAnalysis(r) {
    const { beats, downbeat, beatsPerBar, ...analysis } = r;
    await this.store.op({
      type: 'batch',
      ops: [
        { type: 'tempo.set', changes: { bpm: r.bpm, beats, downbeat, beatsPerBar, offset: beats[0] ?? 0 } },
        { type: 'analysis.set', analysis },
        { type: 'timeline.setDuration', durationMs: Math.round(r.durationMs) },
      ],
    });
    toast(`Analysed: ${r.bpm} BPM, ${r.sections.length} sections, ${r.drops.length} drop${r.drops.length === 1 ? '' : 's'}.`, 'ok');
    this.render();
  }

  // ---- Beat grid corrections ---------------------------------------------------------

  setBeats(beats, downbeat, bpm) {
    this.store.op({ type: 'tempo.set', changes: { bpm, beats, downbeat, offset: beats[0] ?? 0 } });
  }

  setBpm(bpm) {
    if (!(bpm >= 40 && bpm <= 250)) return toast('Tempo must be between 40 and 250 BPM.', 'error');
    const t = createTempo(this.store.show.tempo);
    const anchor = t.timeAt(t.downbeat);
    const beats = uniformBeats(bpm, anchor, this.store.show.timeline.durationMs);
    const idx = beats.reduce((best, b, i) => (Math.abs(b - anchor) < Math.abs(beats[best] - anchor) ? i : best), 0);
    this.taps = [];
    this.setBeats(beats, idx, bpm);
  }

  double() {
    const { tempo } = this.store.show;
    const src = tempo.beats || uniformBeats(tempo.bpm, tempo.offset, this.store.show.timeline.durationMs);
    const beats = [];
    src.forEach((b, i) => {
      beats.push(b);
      if (i + 1 < src.length) beats.push((b + src[i + 1]) / 2);
    });
    this.setBeats(beats, tempo.downbeat * 2, tempo.bpm * 2);
  }

  halve() {
    const { tempo } = this.store.show;
    const src = tempo.beats || uniformBeats(tempo.bpm, tempo.offset, this.store.show.timeline.durationMs);
    const beats = src.filter((_, i) => mod(i - tempo.downbeat, 2) === 0);
    this.setBeats(beats, beats.indexOf(src[tempo.downbeat]), tempo.bpm / 2);
  }

  nudge(ms) {
    const { tempo } = this.store.show;
    const src = tempo.beats || uniformBeats(tempo.bpm, tempo.offset, this.store.show.timeline.durationMs);
    this.setBeats(src.map((b) => b + ms), tempo.downbeat, tempo.bpm);
  }

  shiftDownbeat(d) {
    const { tempo } = this.store.show;
    const n = tempo.beats?.length || 4;
    this.store.op({ type: 'tempo.set', changes: { downbeat: mod(tempo.downbeat + d, Math.min(n, 64)) } });
  }

  tap() {
    const t = performance.now();
    if (this.taps.length && t - this.taps[this.taps.length - 1] > 2000) this.taps = [];
    this.taps.push(t);
    if (this.taps.length > 12) this.taps.shift();
    this.render();
  }

  tapBpm() {
    if (this.taps.length < 4) return null;
    const intervals = this.taps.slice(1).map((t, i) => t - this.taps[i]);
    return 60000 / median(intervals);
  }

  relabel(index, label) {
    const analysis = structuredClone(this.store.show.analysis);
    analysis.sections[index].label = label;
    analysis.drops = analysis.sections.filter((s) => s.label === 'drop').map((s) => s.start);
    this.store.op({ type: 'analysis.set', analysis });
  }

  async generate() {
    const { show } = this.store;
    if (show.timeline.clips.length) {
      const ok = await confirmDialog('Replace the timeline?', `This replaces the ${show.timeline.clips.length} clips on the timeline with a newly generated show. You can undo it.`, 'Generate');
      if (!ok) return;
    }
    try {
      const timeline = generateShow(show, { style: this.style });
      await this.store.op({ type: 'timeline.set', timeline });
      toast(`Generated ${timeline.clips.length} clips. Press Space to play.`, 'ok');
      this.app.showTab('timeline');
    } catch (err) {
      toast(err.message, 'error', 7000);
    }
  }
}
