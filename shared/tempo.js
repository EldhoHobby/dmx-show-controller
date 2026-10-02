// Musical time. The show stores a beat grid alongside its millisecond timeline so the editor
// can snap to beats and effects can be written in beats ("chase every half beat").
//
// tempo = {
//   bpm,          beats per minute (used for extrapolation and when no beat list exists)
//   offset,       ms of beat 0 when there is no beat list
//   beats,        optional ascending list of detected beat times in ms (follows tempo drift)
//   beatsPerBar,  usually 4
//   downbeat,     index of a beat that starts a bar, so bar maths line up with the music
// }

import { lastIndexAtOrBefore } from './util.js';

export function createTempo(tempo = {}) {
  const bpm = tempo.bpm > 0 ? tempo.bpm : 120;
  const period = 60000 / bpm;
  const offset = Number.isFinite(tempo.offset) ? tempo.offset : 0;
  const beats = Array.isArray(tempo.beats) && tempo.beats.length >= 2 ? tempo.beats : null;
  const beatsPerBar = tempo.beatsPerBar > 0 ? Math.round(tempo.beatsPerBar) : 4;
  const downbeat = Number.isFinite(tempo.downbeat) ? tempo.downbeat : 0;

  /** Fractional beat index at a time; beat 0 is the first grid beat. */
  function beatAt(ms) {
    if (!beats) return (ms - offset) / period;
    const n = beats.length;
    if (ms <= beats[0]) return (ms - beats[0]) / period;
    if (ms >= beats[n - 1]) return n - 1 + (ms - beats[n - 1]) / period;
    const i = lastIndexAtOrBefore(beats, ms);
    return i + (ms - beats[i]) / (beats[i + 1] - beats[i]);
  }

  /** Time in ms of a (fractional) beat index. */
  function timeAt(beat) {
    if (!beats) return offset + beat * period;
    const n = beats.length;
    if (beat <= 0) return beats[0] + beat * period;
    if (beat >= n - 1) return beats[n - 1] + (beat - (n - 1)) * period;
    const i = Math.floor(beat);
    return beats[i] + (beat - i) * (beats[i + 1] - beats[i]);
  }

  /** Beat counted from the downbeat, so multiples of beatsPerBar fall on bar lines. */
  function musicalBeat(ms) {
    return beatAt(ms) - downbeat;
  }

  function barBeat(ms) {
    // Display only: a beat detected a few ms after a time still counts as that beat,
    // so the song start reads 1.1 rather than the end of a pickup bar.
    const b = musicalBeat(ms) + 0.02;
    const bar = Math.floor(b / beatsPerBar);
    const inBar = b - bar * beatsPerBar;
    return { bar: bar + 1, beat: Math.floor(inBar) + 1, fraction: inBar - Math.floor(inBar) };
  }

  /** Snap a time to the nearest grid division (in beats, e.g. 1, 0.5, 4 for bars). */
  function snap(ms, division = 1) {
    const b = musicalBeat(ms);
    return timeAt(Math.round(b / division) * division + downbeat);
  }

  /** Grid lines in a time window, for drawing rulers. */
  function gridLines(fromMs, toMs, division = 1) {
    const out = [];
    const start = Math.ceil(musicalBeat(fromMs) / division) * division;
    const end = musicalBeat(toMs);
    for (let b = start; b <= end && out.length < 20000; b += division) {
      const isBar = Math.abs(b / beatsPerBar - Math.round(b / beatsPerBar)) < 1e-6;
      out.push({ ms: timeAt(b + downbeat), beat: b, isBar, bar: Math.floor(b / beatsPerBar) + 1 });
    }
    return out;
  }

  return { bpm, period, beatsPerBar, downbeat, beatAt, timeAt, musicalBeat, barBeat, snap, gridLines };
}

/** Uniform beat list from bpm and the time of one beat, covering 0..durationMs. */
export function uniformBeats(bpm, anchorMs, durationMs) {
  const period = 60000 / bpm;
  const first = anchorMs - Math.floor(anchorMs / period) * period;
  const out = [];
  for (let t = first; t <= durationMs + period; t += period) out.push(Math.round(t * 1000) / 1000);
  return out;
}
