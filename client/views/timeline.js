// Timeline editor (canvas). Lanes are layers: the top lane has the highest priority.
//
//   double-click a lane      add a clip (type from the toolbar) at that beat
//   drag a clip              move it (snaps to the grid); drag up/down to change lane
//   drag a clip edge         change its length
//   Alt + drag               copy instead of move
//   drag in the ruler        scrub the playhead
//   wheel / Ctrl+wheel       scroll / zoom
//   Delete, Ctrl+D, arrows   remove, duplicate, nudge the selected clips

import { h, mount, select, icon, fitCanvas, toast } from '../lib/dom.js';
import { CLIP_TYPES, defaultParams } from '/shared/clip-types.js';
import { createTempo } from '/shared/tempo.js';
import { peakColumns, drawWave, drawSections, drawDrops } from '../lib/draw.js';
import { uid, clamp } from '/shared/util.js';

const RULER_H = 24;
const WAVE_H = 56;
const TOP = RULER_H + WAVE_H;
const TRACK_H = 48;
const HEADER_W = 140;
const EDGE = 7;
const MIN_LEN = 50;

const SNAPS = [
  [0, 'No snap'],
  [0.25, 'Snap 1/16'],
  [0.5, 'Snap 1/8'],
  [1, 'Snap to beat'],
  [4, 'Snap to bar'],
];

export class TimelineView {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.view = { start: 0, msPerPx: 50 };
    this.fitted = false;
    this.newType = 'static';
    this.drag = null;
    this.preview = null;
    this.dirty = true;
    this.lastPos = -1;
    this.canvas = h('canvas', { tabindex: '0', 'aria-label': 'Timeline' });
    this.toolbar = h('div', { class: 'tl-toolbar' });
    this.wrap = h(
      'div',
      { class: 'tl-canvas-wrap' },
      this.canvas,
      h('div', { class: 'tl-hint' }, 'Double-click a lane to add · drag to move · edges to resize · Alt-drag copies · Ctrl+wheel zooms'),
    );
    this.el = h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } }, this.toolbar, this.wrap);
    this.bindEvents();
    this.store.on('show', () => {
      this.dirty = true;
      this.renderToolbar();
    });
    this.store.on('selection', () => (this.dirty = true));
    this.store.on('audio', () => (this.dirty = true));
    this.store.on('frame', (pos) => this.frame(pos));
    new ResizeObserver(() => (this.dirty = true)).observe(this.wrap);
  }

  // ---- Geometry ----------------------------------------------------------------------

  get tracks() {
    return this.store.show.timeline.tracks;
  }

  /** Lanes are drawn with the last track (highest priority) at the top. */
  laneOf(trackId) {
    const i = this.tracks.findIndex((t) => t.id === trackId);
    return i < 0 ? -1 : this.tracks.length - 1 - i;
  }

  trackAtLane(lane) {
    return this.tracks[this.tracks.length - 1 - lane] || null;
  }

  xOf(t) {
    return HEADER_W + (t - this.view.start) / this.view.msPerPx;
  }

  tOf(x) {
    return this.view.start + (x - HEADER_W) * this.view.msPerPx;
  }

  snap(t) {
    const div = this.store.ui.snap;
    if (!div) return Math.round(t);
    return createTempo(this.store.show.tempo).snap(t, div);
  }

  fit() {
    const w = this.canvas.clientWidth || 800;
    this.view.msPerPx = Math.max(1, this.store.show.timeline.durationMs / Math.max(100, w - HEADER_W - 20));
    this.view.start = 0;
    this.dirty = true;
  }

  zoom(factor, anchorX = HEADER_W) {
    const t = this.tOf(anchorX);
    this.view.msPerPx = clamp(this.view.msPerPx * factor, 0.5, 2000);
    this.view.start = t - (anchorX - HEADER_W) * this.view.msPerPx;
    this.clampView();
    this.dirty = true;
  }

  clampView() {
    const d = this.store.show.timeline.durationMs;
    const visible = (this.canvas.clientWidth - HEADER_W) * this.view.msPerPx;
    this.view.start = clamp(this.view.start, -visible * 0.05, Math.max(0, d - visible * 0.9));
  }

  clipRect(c) {
    const p = this.preview?.get(c.id);
    const start = p ? p.start : c.start;
    const end = p ? p.end : c.end;
    const lane = this.laneOf(p ? p.track : c.track);
    return { x0: this.xOf(start), x1: this.xOf(end), y0: TOP + lane * TRACK_H + 4, y1: TOP + (lane + 1) * TRACK_H - 4, start, end };
  }

  hitClip(x, y) {
    const clips = this.store.show.timeline.clips;
    for (let i = clips.length - 1; i >= 0; i--) {
      const r = this.clipRect(clips[i]);
      if (x >= r.x0 - 2 && x <= r.x1 + 2 && y >= r.y0 && y <= r.y1) {
        let part = 'body';
        if (r.x1 - r.x0 > 3 * EDGE) {
          if (x - r.x0 < EDGE) part = 'left';
          else if (r.x1 - x < EDGE) part = 'right';
        }
        return { clip: clips[i], part, rect: r };
      }
    }
    return null;
  }

  // ---- Toolbar -----------------------------------------------------------------------

  renderToolbar() {
    const ui = this.store.ui;
    mount(
      this.toolbar,
      select(SNAPS, ui.snap, (v) => {
        ui.snap = v;
        localStorage.setItem('snap', String(v));
      }),
      h('span', { class: 'muted', style: { marginLeft: '8px' } }, 'New clip'),
      select(Object.entries(CLIP_TYPES).map(([k, d]) => [k, d.label]), this.newType, (v) => (this.newType = v)),
      h('button', { class: 'btn small', onclick: () => this.addClipAt(this.store.positionNow(), this.store.ui.lastTrack || this.tracks.at(-1).id) }, icon('plus', 14), 'Add at playhead'),
      h('div', { class: 'grow' }),
      h('button', { class: 'btn small icon', title: 'Zoom out', onclick: () => this.zoom(1.5) }, '−'),
      h('button', { class: 'btn small icon', title: 'Zoom in', onclick: () => this.zoom(1 / 1.5) }, '+'),
      h('button', { class: 'btn small', onclick: () => this.fit() }, 'Fit song'),
      h('label', { class: 'row', style: { gap: '4px' } }, h('input', { type: 'checkbox', checked: ui.follow, onchange: (e) => (ui.follow = e.target.checked) }), 'Follow'),
      h('button', { class: 'btn small', onclick: () => this.addTrack() }, icon('plus', 14), 'Layer'),
    );
  }

  addTrack() {
    const n = this.tracks.length + 1;
    this.store.op({ type: 'track.add', track: { id: uid('trk'), name: `Layer ${n}` } });
  }

  // ---- Editing -----------------------------------------------------------------------

  defaultFixtures() {
    const sel = [...this.store.ui.selectedFixtures];
    return sel.length ? sel : this.store.show.fixtures.map((f) => f.id);
  }

  async addClipAt(t, trackId) {
    const tempo = createTempo(this.store.show.tempo);
    const start = Math.max(0, this.store.ui.snap ? tempo.snap(t, this.store.ui.snap) : t);
    const end = Math.min(this.store.show.timeline.durationMs, tempo.timeAt(tempo.beatAt(start) + tempo.beatsPerBar));
    if (end - start < MIN_LEN) return toast('No room for a clip there.', 'error');
    const clip = {
      id: uid('clp'),
      type: this.newType,
      track: trackId,
      start: Math.round(start),
      end: Math.round(end),
      fadeIn: 0,
      fadeOut: 0,
      fixtures: this.defaultFixtures(),
      params: defaultParams(this.newType),
    };
    await this.store.op({ type: 'clip.add', clip }).catch(() => {});
    this.store.selectClips([clip.id]);
  }

  deleteSelected() {
    const ids = [...this.store.ui.selectedClips];
    if (!ids.length) return;
    this.store.op({ type: 'batch', ops: ids.map((id) => ({ type: 'clip.remove', id })) });
  }

  duplicateSelected() {
    const clips = this.store.show.timeline.clips.filter((c) => this.store.ui.selectedClips.has(c.id));
    if (!clips.length) return;
    const span = Math.max(...clips.map((c) => c.end)) - Math.min(...clips.map((c) => c.start));
    const copies = clips.map((c) => ({ ...structuredClone(c), id: uid('clp'), start: c.start + span, end: c.end + span }));
    this.store.op({ type: 'batch', ops: copies.map((clip) => ({ type: 'clip.add', clip })) }).then(() => this.store.selectClips(copies.map((c) => c.id)));
  }

  nudgeSelected(dir) {
    const clips = this.store.show.timeline.clips.filter((c) => this.store.ui.selectedClips.has(c.id));
    if (!clips.length) return;
    const tempo = createTempo(this.store.show.tempo);
    const div = this.store.ui.snap || 0.25;
    const ops = clips.map((c) => {
      const start = Math.max(0, tempo.timeAt(tempo.beatAt(c.start) + dir * div));
      return { type: 'clip.update', id: c.id, changes: { start, end: start + (c.end - c.start) } };
    });
    this.store.op({ type: 'batch', ops });
  }

  handleKey(e) {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      this.deleteSelected();
      return true;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
      this.duplicateSelected();
      return true;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      this.store.selectClips(this.store.show.timeline.clips.map((c) => c.id));
      return true;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      this.nudgeSelected(e.key === 'ArrowLeft' ? -1 : 1);
      return true;
    }
    return false;
  }

  // ---- Mouse -------------------------------------------------------------------------

  bindEvents() {
    const c = this.canvas;
    const local = (e) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      c.focus();
      const { x, y } = local(e);
      if (x < HEADER_W) {
        const track = y >= TOP ? this.trackAtLane(Math.floor((y - TOP) / TRACK_H)) : null;
        if (track) {
          if (x > HEADER_W - 30) this.store.op({ type: 'track.update', id: track.id, changes: { muted: !track.muted } });
          this.store.ui.selectedTrack = track.id;
          this.store.ui.lastTrack = track.id;
          this.store.selectClips([]);
        }
        return;
      }
      if (y < TOP) {
        this.drag = { kind: 'seek' };
        this.app.seek(Math.max(0, this.tOf(x)));
        c.setPointerCapture(e.pointerId);
        return;
      }
      const hit = this.hitClip(x, y);
      if (!hit) {
        if (!e.shiftKey) this.store.selectClips([]);
        const track = this.trackAtLane(Math.floor((y - TOP) / TRACK_H));
        if (track) this.store.ui.lastTrack = track.id;
        return;
      }
      const sel = this.store.ui.selectedClips;
      if (e.shiftKey) {
        if (sel.has(hit.clip.id)) sel.delete(hit.clip.id);
        else sel.add(hit.clip.id);
        this.store.emit('selection');
      } else if (!sel.has(hit.clip.id)) {
        this.store.selectClips([hit.clip.id]);
      } else {
        this.store.emit('selection');
      }
      this.store.ui.lastTrack = hit.clip.track;
      const clips = this.store.show.timeline.clips.filter((cl) => sel.has(cl.id));
      this.drag = {
        kind: hit.part === 'left' ? 'resize-l' : hit.part === 'right' ? 'resize-r' : 'move',
        primary: hit.clip,
        startX: x,
        startY: y,
        copy: e.altKey,
        moved: false,
        originals: new Map(clips.map((cl) => [cl.id, { start: cl.start, end: cl.end, track: cl.track }])),
      };
      c.setPointerCapture(e.pointerId);
    });

    c.addEventListener('pointermove', (e) => {
      const { x, y } = local(e);
      if (!this.drag) {
        const hit = x > HEADER_W && y > TOP ? this.hitClip(x, y) : null;
        c.style.cursor = !hit ? (y < TOP && x > HEADER_W ? 'col-resize' : 'default') : hit.part === 'body' ? 'grab' : 'ew-resize';
        return;
      }
      const d = this.drag;
      if (d.kind === 'seek') {
        this.app.seek(Math.max(0, this.tOf(x)));
        return;
      }
      if (!d.moved && Math.abs(x - d.startX) < 3 && Math.abs(y - d.startY) < 3) return;
      d.moved = true;
      const dt = (x - d.startX) * this.view.msPerPx;
      const prim = d.originals.get(d.primary.id);
      const duration = this.store.show.timeline.durationMs;
      const preview = new Map();
      if (d.kind === 'move') {
        const newStart = this.snap(Math.max(0, prim.start + dt));
        const shift = newStart - prim.start;
        const laneShift = Math.round((y - d.startY) / TRACK_H);
        for (const [id, o] of d.originals) {
          const lane = clamp(this.laneOf(o.track) + laneShift, 0, this.tracks.length - 1);
          const len = o.end - o.start;
          const start = clamp(o.start + shift, 0, Math.max(0, duration - len));
          preview.set(id, { start, end: start + len, track: this.trackAtLane(lane).id });
        }
      } else if (d.kind === 'resize-l') {
        for (const [id, o] of d.originals) {
          const start = clamp(this.snap(o.start + dt), 0, o.end - MIN_LEN);
          preview.set(id, { start, end: o.end, track: o.track });
        }
      } else {
        for (const [id, o] of d.originals) {
          const end = clamp(this.snap(o.end + dt), o.start + MIN_LEN, duration);
          preview.set(id, { start: o.start, end, track: o.track });
        }
      }
      this.preview = preview;
      this.dirty = true;
    });

    const finish = () => {
      const d = this.drag;
      this.drag = null;
      if (!d || d.kind === 'seek' || !d.moved || !this.preview) {
        this.preview = null;
        this.dirty = true;
        return;
      }
      const preview = this.preview;
      const ops = [];
      const newIds = [];
      for (const [id, p] of preview) {
        const o = d.originals.get(id);
        if (d.copy && d.kind === 'move') {
          const src = this.store.show.timeline.clips.find((cl) => cl.id === id);
          const copy = { ...structuredClone(src), id: uid('clp'), start: Math.round(p.start), end: Math.round(p.end), track: p.track };
          newIds.push(copy.id);
          ops.push({ type: 'clip.add', clip: copy });
        } else if (p.start !== o.start || p.end !== o.end || p.track !== o.track) {
          ops.push({ type: 'clip.update', id, changes: { start: Math.round(p.start), end: Math.round(p.end), track: p.track } });
        }
      }
      // Keep the preview on screen until the engine confirms, so clips do not flicker back.
      const done = ops.length ? this.store.op({ type: 'batch', ops }) : Promise.resolve();
      done.finally(() => {
        this.preview = null;
        this.dirty = true;
        if (newIds.length) this.store.selectClips(newIds);
      });
    };
    c.addEventListener('pointerup', finish);
    c.addEventListener('pointercancel', finish);

    c.addEventListener('dblclick', (e) => {
      const { x, y } = local(e);
      if (x < HEADER_W || y < TOP) return;
      if (this.hitClip(x, y)) return;
      const track = this.trackAtLane(Math.floor((y - TOP) / TRACK_H));
      if (track) this.addClipAt(this.tOf(x), track.id);
    });

    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const { x } = local(e);
        if (e.ctrlKey || e.metaKey) this.zoom(Math.exp(e.deltaY * 0.0015), Math.max(HEADER_W, x));
        else {
          this.view.start += (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * this.view.msPerPx;
          this.clampView();
          this.store.ui.follow = this.store.transport.playing ? false : this.store.ui.follow;
          this.dirty = true;
        }
      },
      { passive: false },
    );
  }

  // ---- Drawing -----------------------------------------------------------------------

  frame(pos) {
    if (!this.canvas.isConnected || !this.store.show) return;
    if (!this.fitted && this.canvas.clientWidth > 0) {
      this.fit();
      this.fitted = true;
      this.store.ui.snap = Number(localStorage.getItem('snap') ?? 1);
      this.renderToolbar();
    }
    const playing = this.store.transport.playing;
    if (playing && this.store.ui.follow && !this.drag) {
      const w = this.canvas.clientWidth;
      const visible = (w - HEADER_W) * this.view.msPerPx;
      // Only page when the song does not already fit on screen.
      if (visible < this.store.show.timeline.durationMs) {
        const x = this.xOf(pos);
        if (x > w * 0.85 || x < HEADER_W) {
          this.view.start = pos - visible * 0.15;
          this.clampView();
          this.dirty = true;
        }
      }
    }
    if (!this.dirty && Math.abs(pos - this.lastPos) < 0.5) return;
    this.lastPos = pos;
    this.dirty = false;
    this.draw(pos);
  }

  draw(pos) {
    const { ctx, w, h: hh } = fitCanvas(this.canvas);
    const show = this.store.show;
    const tempo = createTempo(show.tempo);
    const duration = show.timeline.durationMs;
    const t0 = this.tOf(HEADER_W);
    const t1 = this.tOf(w);
    const tracksBottom = TOP + this.tracks.length * TRACK_H;

    ctx.fillStyle = '#0d0f13';
    ctx.fillRect(0, 0, w, hh);
    // Song area vs beyond the end.
    const endX = this.xOf(duration);
    ctx.fillStyle = '#11141a';
    ctx.fillRect(Math.max(HEADER_W, this.xOf(0)), TOP, Math.min(w, endX) - Math.max(HEADER_W, this.xOf(0)), tracksBottom - TOP);

    // Lanes
    for (let lane = 0; lane < this.tracks.length; lane++) {
      const tr = this.trackAtLane(lane);
      const y = TOP + lane * TRACK_H;
      if (tr.muted) {
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(HEADER_W, y, w - HEADER_W, TRACK_H);
      }
      ctx.fillStyle = '#20252f';
      ctx.fillRect(HEADER_W, y + TRACK_H - 1, w - HEADER_W, 1);
    }

    // Beat and bar grid
    const pxPerBeat = tempo.period / this.view.msPerPx;
    const division = pxPerBeat > 14 ? 1 : pxPerBeat * tempo.beatsPerBar > 10 ? tempo.beatsPerBar : tempo.beatsPerBar * 4;
    const lines = tempo.gridLines(Math.max(0, t0), Math.min(duration, t1), division);
    ctx.font = '11px system-ui, sans-serif';
    let lastLabelX = -100;
    for (const g of lines) {
      const x = Math.round(this.xOf(g.ms)) + 0.5;
      if (x < HEADER_W) continue;
      ctx.fillStyle = g.isBar ? '#283040' : '#1a1f28';
      ctx.fillRect(x, TOP, 1, tracksBottom - TOP);
      ctx.fillRect(x, RULER_H - (g.isBar ? 10 : 5), 1, g.isBar ? 10 : 5);
      if (g.isBar && x - lastLabelX > 34) {
        ctx.fillStyle = '#8d96a7';
        ctx.fillText(String(g.bar), x + 3, 13);
        lastLabelX = x;
      }
    }

    // Waveform band with sections
    ctx.save();
    ctx.beginPath();
    ctx.rect(HEADER_W, RULER_H, w - HEADER_W, WAVE_H);
    ctx.clip();
    drawSections(ctx, show.analysis?.sections, (t) => this.xOf(t), RULER_H, WAVE_H, { alpha: 0.18 });
    const cols = Math.max(1, Math.floor(w - HEADER_W));
    const values = peakColumns(this.store, Math.max(0, t0), Math.min(duration, t1), cols);
    const waveX0 = this.xOf(Math.max(0, t0));
    const waveX1 = this.xOf(Math.min(duration, t1));
    drawWave(ctx, waveX0, RULER_H + 18, waveX1 - waveX0, WAVE_H - 20, values, 'rgba(150,165,190,0.7)');
    drawDrops(ctx, show.analysis?.drops, (t) => this.xOf(t), RULER_H);
    ctx.restore();
    ctx.fillStyle = '#2a313d';
    ctx.fillRect(0, TOP - 1, w, 1);

    // Clips
    ctx.save();
    ctx.beginPath();
    ctx.rect(HEADER_W, TOP, w - HEADER_W, tracksBottom - TOP);
    ctx.clip();
    const selected = this.store.ui.selectedClips;
    for (const c of show.timeline.clips) {
      const r = this.clipRect(c);
      if (r.x1 < HEADER_W || r.x0 > w) continue;
      this.drawClip(ctx, c, r, selected.has(c.id));
    }
    if (this.drag?.copy && this.preview) {
      ctx.fillStyle = '#ffffff';
      ctx.font = '600 11px system-ui';
      ctx.fillText('copy', this.xOf([...this.preview.values()][0].start) + 4, TOP - 4);
    }
    ctx.restore();

    // Track headers
    ctx.fillStyle = '#151920';
    ctx.fillRect(0, 0, HEADER_W, hh);
    ctx.fillStyle = '#2a313d';
    ctx.fillRect(HEADER_W - 1, 0, 1, hh);
    ctx.fillStyle = '#8d96a7';
    ctx.font = '600 11px system-ui';
    ctx.fillText(`${tempo.bpm.toFixed(1)} BPM`, 10, 15);
    ctx.fillText('SONG', 10, RULER_H + 32);
    for (let lane = 0; lane < this.tracks.length; lane++) {
      const tr = this.trackAtLane(lane);
      const y = TOP + lane * TRACK_H;
      const active = this.store.ui.selectedTrack === tr.id;
      ctx.fillStyle = active ? '#222833' : '#151920';
      ctx.fillRect(0, y, HEADER_W - 1, TRACK_H);
      ctx.fillStyle = '#20252f';
      ctx.fillRect(0, y + TRACK_H - 1, HEADER_W, 1);
      ctx.fillStyle = tr.muted ? '#5d6676' : '#e7eaf0';
      ctx.font = '600 12px system-ui';
      ctx.fillText(truncate(ctx, tr.name, HEADER_W - 46), 10, y + 20);
      ctx.fillStyle = '#5d6676';
      ctx.font = '11px system-ui';
      ctx.fillText(lane === 0 ? 'top layer' : `layer ${this.tracks.length - lane}`, 10, y + 36);
      // Mute button
      ctx.fillStyle = tr.muted ? '#f5a524' : '#2a313d';
      roundRect(ctx, HEADER_W - 26, y + 14, 18, 18, 4);
      ctx.fill();
      ctx.fillStyle = tr.muted ? '#1a1203' : '#8d96a7';
      ctx.font = '700 10px system-ui';
      ctx.fillText('M', HEADER_W - 21, y + 27);
    }

    // Playhead
    const px = this.xOf(pos);
    if (px >= HEADER_W && px <= w) {
      ctx.fillStyle = '#f5a524';
      ctx.fillRect(Math.round(px) - 1, 0, 2, tracksBottom);
      ctx.beginPath();
      ctx.moveTo(px - 6, 0);
      ctx.lineTo(px + 6, 0);
      ctx.lineTo(px, 8);
      ctx.fill();
    }
    if (!show.timeline.clips.length) {
      ctx.fillStyle = '#5d6676';
      ctx.font = '13px system-ui';
      const msg = show.analysis ? 'Empty timeline — generate a show on the Song page, or double-click a lane to add a clip.' : 'Empty timeline — load and analyse a song on the Song page first, or double-click a lane to add a clip.';
      ctx.fillText(msg, HEADER_W + 20, tracksBottom + 30);
    }
  }

  drawClip(ctx, c, r, isSelected) {
    const def = CLIP_TYPES[c.type];
    const x0 = Math.max(r.x0, HEADER_W - 4);
    const width = Math.max(2, r.x1 - x0);
    const hgt = r.y1 - r.y0;
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = shade(def.color, -0.45);
    roundRect(ctx, x0, r.y0, width, hgt, 4);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = def.color;
    ctx.fillRect(x0, r.y0, width, 3);
    // Fades as ramps
    const fi = (c.fadeIn / this.view.msPerPx) | 0;
    const fo = (c.fadeOut / this.view.msPerPx) | 0;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    if (fi > 1) {
      ctx.beginPath();
      ctx.moveTo(r.x0, r.y1);
      ctx.lineTo(r.x0 + fi, r.y0 + 3);
      ctx.lineTo(r.x0, r.y0 + 3);
      ctx.fill();
    }
    if (fo > 1) {
      ctx.beginPath();
      ctx.moveTo(r.x1, r.y1);
      ctx.lineTo(r.x1 - fo, r.y0 + 3);
      ctx.lineTo(r.x1, r.y0 + 3);
      ctx.fill();
    }
    // Colour swatch for clips that set a colour
    const col = c.params?.color || (c.type === 'colorStep' && c.params?.colors?.[0]);
    if (col) {
      ctx.fillStyle = `rgb(${col.map((v) => Math.round(v * 255)).join(',')})`;
      ctx.fillRect(x0 + 4, r.y1 - 9, Math.min(22, width - 8), 5);
    }
    if (c.type === 'keyframes') {
      const keys = Object.values(c.params?.keys || {})[0] || [];
      ctx.fillStyle = '#e7eaf0';
      for (const k of keys) {
        const kx = this.xOf(r.start + k.t);
        const ky = (r.y0 + r.y1) / 2;
        ctx.beginPath();
        ctx.moveTo(kx, ky - 5);
        ctx.lineTo(kx + 5, ky);
        ctx.lineTo(kx, ky + 5);
        ctx.lineTo(kx - 5, ky);
        ctx.fill();
      }
    }
    if (width > 30) {
      ctx.fillStyle = '#f2f4f8';
      ctx.font = '600 11px system-ui';
      const label = c.name || def.label;
      ctx.fillText(truncate(ctx, label, width - 10), x0 + 5, r.y0 + 16);
      if (width > 90 && hgt > 30) {
        ctx.fillStyle = 'rgba(230,234,240,0.6)';
        ctx.font = '10px system-ui';
        ctx.fillText(truncate(ctx, `${def.label} · ${c.fixtures.length} fx`, width - 10), x0 + 5, r.y0 + 29);
      }
    }
    if (isSelected) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      roundRect(ctx, x0 + 1, r.y0 + 1, width - 2, hgt - 2, 4);
      ctx.stroke();
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function truncate(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxW) s = s.slice(0, -1);
  return s.length > 1 ? `${s}…` : '';
}

function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.round(Math.max(0, Math.min(255, v + v * amount)));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}
