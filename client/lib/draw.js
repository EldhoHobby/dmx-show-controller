// Canvas drawing shared by the song overview, the timeline header and the live progress bar.

import { SECTION_COLORS } from './dom.js';

/** Peak values (0..1) for each pixel column between t0 and t1 (ms). */
export function peakColumns(store, t0, t1, columns) {
  const out = new Float32Array(Math.max(1, columns));
  const span = t1 - t0;
  if (span <= 0) return out;
  const fine = store.audio?.buffer && store.audio.hash === store.show.audio?.hash ? store.audio.peaks(200) : null;
  if (fine) {
    const vals = fine.values;
    let max = 1e-6;
    for (let i = 0; i < vals.length; i += 7) if (vals[i] > max) max = vals[i];
    for (let c = 0; c < columns; c++) {
      const a = Math.floor(((t0 + (span * c) / columns) / 1000) * 200);
      const b = Math.max(a + 1, Math.floor(((t0 + (span * (c + 1)) / columns) / 1000) * 200));
      let m = 0;
      for (let i = Math.max(0, a); i < Math.min(vals.length, b); i++) if (vals[i] > m) m = vals[i];
      out[c] = m / max;
    }
    return out;
  }
  const peaks = store.show.analysis?.peaks;
  const duration = store.show.analysis?.durationMs || store.show.timeline.durationMs;
  if (!peaks?.length) return out;
  for (let c = 0; c < columns; c++) {
    const a = Math.floor(((t0 + (span * c) / columns) / duration) * peaks.length);
    const b = Math.max(a + 1, Math.floor(((t0 + (span * (c + 1)) / columns) / duration) * peaks.length));
    let m = 0;
    for (let i = Math.max(0, a); i < Math.min(peaks.length, b); i++) if (peaks[i] > m) m = peaks[i];
    out[c] = m;
  }
  return out;
}

export function drawWave(ctx, x, y, w, h, values, color) {
  ctx.fillStyle = color;
  const mid = y + h / 2;
  for (let i = 0; i < values.length; i++) {
    const a = values[i] * (h / 2) * 0.95;
    if (a > 0.3) ctx.fillRect(x + (i * w) / values.length, mid - a, Math.max(1, w / values.length), a * 2);
  }
}

export function drawSections(ctx, sections, xOf, y, h, { labels = true, alpha = 0.22 } = {}) {
  for (const s of sections || []) {
    const x0 = xOf(s.start);
    const x1 = xOf(s.end);
    if (x1 < 0 || x0 > ctx.canvas.width) continue;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = SECTION_COLORS[s.label] || '#555';
    ctx.fillRect(x0, y, x1 - x0, h);
    ctx.globalAlpha = 1;
    ctx.fillStyle = SECTION_COLORS[s.label] || '#555';
    ctx.fillRect(x0, y, Math.max(1, x1 - x0), 3);
    if (labels && x1 - x0 > 40) {
      ctx.fillStyle = '#d8dce4';
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.fillText(s.label.toUpperCase(), x0 + 5, y + 15);
    }
  }
}

export function drawDrops(ctx, drops, xOf, y) {
  ctx.fillStyle = '#ff5050';
  for (const d of drops || []) {
    const x = xOf(d);
    ctx.beginPath();
    ctx.moveTo(x - 5, y);
    ctx.lineTo(x + 5, y);
    ctx.lineTo(x, y + 7);
    ctx.fill();
  }
}

export function drawPlayhead(ctx, x, y, h) {
  ctx.fillStyle = '#f5a524';
  ctx.fillRect(Math.round(x) - 1, y, 2, h);
}

/** Whole-song overview: sections, waveform, drops, playhead. */
export function drawOverview(ctx, w, h, store, position) {
  const show = store.show;
  const duration = show.timeline.durationMs;
  const xOf = (t) => (t / duration) * w;
  ctx.clearRect(0, 0, w, h);
  drawSections(ctx, show.analysis?.sections, xOf, 0, h, { labels: w > 400 });
  drawWave(ctx, 0, 18, w, h - 22, peakColumns(store, 0, duration, Math.floor(w)), 'rgba(160, 175, 200, 0.75)');
  drawDrops(ctx, show.analysis?.drops, xOf, 0);
  drawPlayhead(ctx, xOf(position), 0, h);
}
