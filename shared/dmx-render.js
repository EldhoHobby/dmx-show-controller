// Fixture state -> DMX channel bytes, using each fixture's profile and patch address.

import { panRange, tiltRange } from './fixture-library.js';
import { colorDistance, normalizeColor } from './color.js';
import { clamp, fract, lerp } from './util.js';

export const UNIVERSE_SIZE = 512;

/** Software strobe for fixtures without a strobe channel: on/off from the wall clock. */
export function softwareStrobeOn(strobe, wallMs) {
  if (!(strobe > 0.001)) return true;
  const hz = lerp(1.5, 14, clamp(strobe, 0, 1));
  return fract((wallMs / 1000) * hz) < 0.35;
}

function slotDmx(slots, index) {
  if (!slots?.length) return 0;
  const slot = slots[clamp(Math.round(index) || 0, 0, slots.length - 1)];
  return slot.dmx ?? 0;
}

function wheelDmx(slots, rgb) {
  if (!slots?.length) return 0;
  const want = normalizeColor(rgb);
  let best = slots[0];
  let bestD = Infinity;
  for (const slot of slots) {
    if (!slot.color) continue;
    const d = colorDistance(want, slot.color);
    if (d < bestD) {
      bestD = d;
      best = slot;
    }
  }
  return best.dmx ?? 0;
}

/**
 * Channel values for one fixture record (from createEvaluator) in state s.
 * Writes into `out` (length = profile channel count) and returns it.
 */
export function fixtureChannels(rec, s, wallMs, out = new Uint8Array(rec.profile.channels.length)) {
  const { profile, caps } = rec;
  let dim = clamp(s.dimmer, 0, 1);
  if (s.strobe > 0.001 && !caps.strobe && !softwareStrobeOn(s.strobe, wallMs)) dim = 0;

  let r = clamp(s.color[0], 0, 1);
  let g = clamp(s.color[1], 0, 1);
  let b = clamp(s.color[2], 0, 1);
  // Fixtures without a dimmer channel get intensity baked into their colour channels.
  if (!caps.dimmer) {
    r *= dim;
    g *= dim;
    b *= dim;
  }
  let w = 0;
  if (caps.color === 'rgb' && caps.white && profile.whiteMode !== 'none') {
    w = Math.min(r, g, b);
    r -= w;
    g -= w;
    b -= w;
  } else if (caps.color === 'white') {
    w = caps.dimmer ? 1 : dim;
  }
  const pr = panRange(profile);
  const tr = tiltRange(profile);
  const values = {
    dimmer: dim,
    red: r,
    green: g,
    blue: b,
    white: w,
    amber: 0,
    uv: 0,
    cyan: 1 - r,
    magenta: 1 - g,
    yellow: 1 - b,
    zoom: clamp(s.zoom, 0, 1),
    pan: clamp((s.pan + pr / 2) / pr, 0, 1),
    tilt: clamp((s.tilt + tr / 2) / tr, 0, 1),
  };

  const channels = profile.channels;
  for (let i = 0; i < channels.length; i++) {
    const ch = channels[i];
    let dmx;
    switch (ch.attr) {
      case 'fixed':
        dmx = ch.value ?? 0;
        break;
      case 'strobe':
        dmx = s.strobe > 0.001 ? lerp(ch.min ?? 1, ch.max ?? 255, clamp(s.strobe, 0, 1)) : (ch.off ?? 0);
        break;
      case 'prism':
        dmx = s.prism >= 0.5 ? (ch.on ?? 255) : (ch.off ?? 0);
        break;
      case 'gobo':
        dmx = slotDmx(ch.slots, s.gobo);
        break;
      case 'colorWheel':
        dmx = wheelDmx(ch.slots, s.color);
        break;
      default: {
        let v = values[ch.attr] ?? 0;
        if (ch.invert) v = 1 - v;
        if (rec.fineAttrs.has(ch.attr)) {
          const v16 = Math.round(v * 65535);
          dmx = ch.fine ? v16 & 255 : v16 >> 8;
        } else {
          const lo = ch.min ?? 0;
          const hi = ch.max ?? 255;
          dmx = lo + (hi - lo) * v;
        }
      }
    }
    out[i] = clamp(Math.round(dmx), 0, 255);
  }
  return out;
}

// Colour channels are the intensity of a fixture that has no dimmer channel.
const COLOR_INTENSITY = new Set(['red', 'green', 'blue', 'white', 'amber', 'uv']);

/**
 * Render all fixtures into universe buffers (Map universe -> Uint8Array(512)).
 * Buffers are reused between frames; universes with no fixtures stay at zero.
 * Raw channel values from manual faders and scenes (states.raw) replace bytes last; those
 * that carry intensity still obey the grand master and blackout, and flash buttons win.
 */
export function renderUniverses(evaluator, states, wallMs, universes = new Map()) {
  for (const buf of universes.values()) buf.fill(0);
  for (const rec of evaluator.fixtures) {
    const s = states.get(rec.id);
    if (!s) continue;
    const f = rec.fixture;
    const n = rec.profile.channels.length;
    const start = f.address - 1;
    if (start < 0 || start + n > UNIVERSE_SIZE) continue; // reported by validation
    let buf = universes.get(f.universe);
    if (!buf) {
      buf = new Uint8Array(UNIVERSE_SIZE);
      universes.set(f.universe, buf);
    }
    buf.set(fixtureChannels(rec, s, wallMs), start);
  }
  if (states.raw?.size) {
    const intensity = states.intensity ?? 1;
    for (const [fx, chans] of states.raw) {
      const rec = evaluator.byId.get(fx);
      if (!rec) continue;
      const f = rec.fixture;
      const channels = rec.profile.channels;
      const start = f.address - 1;
      const buf = universes.get(f.universe);
      if (!buf || start < 0 || start + channels.length > UNIVERSE_SIZE) continue;
      for (const [i, v] of chans) {
        const ch = channels[i];
        if (!ch) continue;
        const carriesIntensity = ch.attr === 'dimmer' || (!rec.caps.dimmer && COLOR_INTENSITY.has(ch.attr));
        if (!carriesIntensity) buf[start + i] = v;
        else if (!states.flash) buf[start + i] = Math.round(v * intensity);
      }
    }
  }
  return universes;
}
