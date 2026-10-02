// DMX channel monitor: all 512 channels of one universe, computed with the engine's own code.

import { h, select, fitCanvas } from '../lib/dom.js';
import { renderUniverses } from '/shared/dmx-render.js';

export class Monitor {
  constructor(store) {
    this.store = store;
    this.universe = 1;
    this.buffers = new Map();
    this.canvas = h('canvas', { class: 'monitor' });
    this.picker = h('span');
    this.el = h('div', { class: 'stack' }, h('div', { class: 'row' }, h('h3', { class: 'grow' }, 'DMX monitor'), this.picker), this.canvas);
    this.hover = null;
    this.canvas.addEventListener('mousemove', (e) => {
      const r = this.canvas.getBoundingClientRect();
      const col = Math.floor(((e.clientX - r.left) / r.width) * 32);
      const row = Math.floor(((e.clientY - r.top) / r.height) * 16);
      this.hover = row * 32 + col;
    });
    this.canvas.addEventListener('mouseleave', () => (this.hover = null));
    this.last = 0;
    store.on('show', () => this.renderPicker());
    store.on('outputs', () => this.renderPicker());
    store.on('frame', (pos) => this.draw(pos));
  }

  renderPicker() {
    const show = this.store.show;
    if (!show) return;
    const set = new Set([...show.fixtures.map((f) => f.universe), ...this.store.routedUniverses()]);
    if (!set.size) set.add(1);
    const list = [...set].sort((a, b) => a - b);
    if (!set.has(this.universe)) this.universe = list[0];
    this.picker.replaceChildren(select(list.map((u) => [u, `Universe ${u}`]), this.universe, (v) => (this.universe = v)));
  }

  draw(pos) {
    if (!this.canvas.isConnected || !this.store.show) return;
    const t = performance.now();
    if (t - this.last < 60) return; // ~15 fps is plenty for numbers
    this.last = t;
    const ev = this.store.evaluator();
    const now = this.store.net.serverNow();
    const states = ev.evaluate(pos, this.store.liveContext(), now);
    renderUniverses(ev, states, now, this.buffers);
    const data = this.buffers.get(this.universe) || new Uint8Array(512);
    const { ctx, w, h: hh } = fitCanvas(this.canvas);
    const cw = w / 32;
    const ch = hh / 16;
    ctx.fillStyle = '#0d0f13';
    ctx.fillRect(0, 0, w, hh);
    const starts = new Map();
    for (const rec of ev.fixtures) if (rec.fixture.universe === this.universe) starts.set(rec.fixture.address - 1, rec.fixture.name);
    for (let i = 0; i < 512; i++) {
      const x = (i % 32) * cw;
      const y = Math.floor(i / 32) * ch;
      const v = data[i];
      ctx.fillStyle = '#171b22';
      ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2);
      if (v) {
        ctx.fillStyle = `rgba(245,165,36,${0.35 + 0.65 * (v / 255)})`;
        const bh = (ch - 2) * (v / 255);
        ctx.fillRect(x + 1, y + ch - 1 - bh, cw - 2, bh);
      }
      if (starts.has(i)) {
        ctx.fillStyle = '#4f9dff';
        ctx.fillRect(x, y + 1, 2, ch - 2);
      }
    }
    if (this.hover != null && this.hover >= 0 && this.hover < 512) {
      const i = this.hover;
      const label = `Ch ${i + 1}: ${data[i]}`;
      ctx.font = '600 12px system-ui';
      const tw = ctx.measureText(label).width + 12;
      const x = Math.min(w - tw, (i % 32) * cw);
      const y = Math.max(0, Math.floor(i / 32) * ch - 22);
      ctx.fillStyle = 'rgba(0,0,0,0.85)';
      ctx.fillRect(x, y, tw, 20);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x + 6, y + 14);
    }
  }
}
