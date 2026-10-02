// Timeline evaluation: show + time -> the state of every fixture at that instant.
//
// The engine runs this at the DMX frame rate to produce output, and the browser runs the very
// same code at screen refresh rate to drive the 3D visualizer, so what you see is what is sent.
//
// Layering rules (like a lighting console):
//   - tracks are layers, bottom to top; inside a track clips apply in start-time order
//   - with the live auto show on (Live mode), it takes the timeline's place: the generator's
//     looks played from the live-audio beat clock (shared/live-show.js)
//   - intensity is Highest-Takes-Precedence (HTP) unless a clip says "override"
//   - colour, position, zoom, strobe, gobo and prism are Latest-Takes-Precedence (LTP):
//     the top-most active clip that sets them wins, crossfading by the clip's fade
//   - above the timeline, in order: active scenes, live-audio reactions, manual faders
//     (the "programmer"), then Prime/Calibrate, which owns a moving head while it is aimed
//   - the live layer (grand master, blackout, flash buttons) is applied last, and blackout
//     also silences manual raw channel values that carry intensity (see dmx-render.js)

import { createTempo } from './tempo.js';
import { fixtureRole, panRange, profileCaps, resolveProfile, tiltRange } from './fixture-library.js';
import { livePlan } from './live-show.js';
import { aimAt, rotationMatrix } from './kinematics.js';
import { hsvToRgb, isColor } from './color.js';
import { fixtureGroups } from './groups.js';
import { clamp, fract, hash32, lerp, mod, smoothstep, stringHash } from './util.js';

export function defaultState() {
  return { dimmer: 0, color: [1, 1, 1], pan: 0, tilt: 0, strobe: 0, zoom: 0.5, gobo: 0, prism: 0 };
}

const num = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const WHITE = [1, 1, 1];
const posNum = (v, fallback) => (typeof v === 'number' && v > 0 ? v : fallback);

function fadeAlpha(clip, t) {
  let a = 1;
  if (clip.fadeIn > 0 && t < clip.start + clip.fadeIn) a = Math.min(a, (t - clip.start) / clip.fadeIn);
  if (clip.fadeOut > 0 && t > clip.end - clip.fadeOut) a = Math.min(a, (clip.end - t) / clip.fadeOut);
  return clamp(a, 0, 1);
}

function setDimmer(s, value, alpha, mode) {
  if (mode === 'set') {
    s.dimmer = lerp(s.dimmer, value, alpha);
  } else {
    const v = value * alpha;
    if (v > s.dimmer) s.dimmer = v;
  }
}

function setColor(s, rgb, alpha) {
  if (!isColor(rgb)) return;
  if (alpha >= 1) s.color = [rgb[0], rgb[1], rgb[2]];
  else s.color = [lerp(s.color[0], rgb[0], alpha), lerp(s.color[1], rgb[1], alpha), lerp(s.color[2], rgb[2], alpha)];
}

function setNum(s, key, v, alpha) {
  if (!Number.isFinite(v)) return;
  s[key] = alpha >= 1 ? v : lerp(s[key], v, alpha);
}

function setStep(s, key, v, alpha) {
  if (Number.isFinite(v) && alpha >= 0.5) s[key] = v;
}

function mixValue(a, b, u) {
  if (Array.isArray(a) && Array.isArray(b)) return a.map((x, i) => lerp(x, num(b[i], x), u));
  return lerp(a, b, u);
}

/** Value of a keyframe list at a time relative to the clip start. */
export function interpolateKeys(list, rel) {
  if (!list || !list.length) return undefined;
  if (rel <= list[0].t) return list[0].v;
  const last = list[list.length - 1];
  if (rel >= last.t) return last.v;
  let lo = 0;
  let hi = list.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (list[mid].t <= rel) lo = mid;
    else hi = mid;
  }
  const a = list[lo];
  const b = list[lo + 1];
  let u = (rel - a.t) / (b.t - a.t || 1);
  if (a.ease === 'step') u = 0;
  else if (a.ease === 'smooth') u = smoothstep(u);
  return mixValue(a.v, b.v, u);
}

function prepareKeys(keys) {
  const out = [];
  if (!keys || typeof keys !== 'object') return out;
  for (const param of ['dimmer', 'color', 'pan', 'tilt', 'zoom', 'strobe']) {
    const list = keys[param];
    if (!Array.isArray(list)) continue;
    const clean = list
      .filter((k) => k && Number.isFinite(k.t) && (param === 'color' ? isColor(k.v) : Number.isFinite(k.v)))
      .map((k) => ({ t: k.t, v: k.v, ease: k.ease || 'linear' }))
      .sort((a, b) => a.t - b.t);
    if (clean.length) out.push([param, clean]);
  }
  return out;
}

function prepareClip(clip, byId) {
  const members = clip.fixtures.map((id) => byId.get(id)).filter(Boolean);
  const order = clip.params?.order || 'x';
  const ordered = members.slice();
  if (order === 'x') {
    ordered.sort(
      (a, b) => a.fixture.position.x - b.fixture.position.x || a.fixture.position.z - b.fixture.position.z,
    );
  }
  const slots = new Map();
  let slotCount = ordered.length;
  if (order === 'center' && ordered.length) {
    const xs = ordered.map((m) => m.fixture.position.x);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const byDistance = ordered
      .map((m) => ({ m, d: Math.abs(m.fixture.position.x - cx) }))
      .sort((a, b) => a.d - b.d);
    let ring = -1;
    let ringStart = -Infinity;
    for (const { m, d } of byDistance) {
      if (d - ringStart > 0.05) {
        ring++;
        ringStart = d;
      }
      slots.set(m.id, ring);
    }
    slotCount = ring + 1;
  } else {
    ordered.forEach((m, i) => slots.set(m.id, i));
  }
  return {
    clip,
    members: ordered.map((rec) => ({ rec, slot: slots.get(rec.id) })),
    slotCount: Math.max(1, slotCount),
    seed: stringHash(clip.id),
    keys: clip.type === 'keyframes' ? prepareKeys(clip.params?.keys) : null,
  };
}

function movementOffset(shape, phase) {
  switch (shape) {
    case 'figure8': return [Math.sin(phase), Math.sin(2 * phase)];
    case 'sweep': return [Math.sin(phase), 0];
    case 'tilt': return [0, Math.sin(phase)];
    case 'ballyhoo': return [Math.sin(phase), Math.sin(1.5 * phase + 0.7)];
    default: return [Math.cos(phase), Math.sin(phase)];
  }
}

const HANDLERS = {
  static(pc, t, beat, alpha, states) {
    const p = pc.clip.params;
    for (const { rec } of pc.members) {
      const s = states.get(rec.id);
      if (p.dimmer != null) setDimmer(s, num(p.dimmer), alpha, p.dimmerMode);
      if (p.color != null) setColor(s, p.color, alpha);
      if (p.position === 'aim' && rec.aim) {
        setNum(s, 'pan', rec.aim.pan, alpha);
        setNum(s, 'tilt', rec.aim.tilt, alpha);
      } else if (p.position === 'manual') {
        setNum(s, 'pan', num(p.pan), alpha);
        setNum(s, 'tilt', num(p.tilt), alpha);
      }
      if (p.zoom != null) setNum(s, 'zoom', num(p.zoom), alpha);
      if (p.strobe != null) setNum(s, 'strobe', num(p.strobe), alpha);
      if (p.gobo != null) setStep(s, 'gobo', num(p.gobo), alpha);
      if (p.prism != null) setStep(s, 'prism', num(p.prism), alpha);
    }
  },

  pulse(pc, t, beat, alpha, states) {
    const p = pc.clip.params;
    const division = posNum(p.division, 1);
    const offset = num(p.offset, 0);
    const decay = clamp(num(p.decay, 0.6), 0.01, 1);
    const level = num(p.level, 1);
    const spread = num(p.spread, 0);
    for (const { rec, slot } of pc.members) {
      const s = states.get(rec.id);
      const phase = fract((beat - offset) / division - (spread * slot) / pc.slotCount);
      const env = phase < decay ? (1 - phase / decay) ** 2 : 0;
      setDimmer(s, level * env, alpha, p.dimmerMode);
      if (p.color != null) setColor(s, p.color, alpha);
    }
  },

  chase(pc, t, beat, alpha, states) {
    const p = pc.clip.params;
    const step = posNum(p.step, 1);
    const width = Math.max(1, Math.round(num(p.width, 1)));
    const tail = Math.max(0, Math.round(num(p.tail, 0)));
    const level = num(p.level, 1);
    const dir = p.direction || 'forward';
    const n = pc.slotCount;
    const k = Math.floor(beat / step);
    let head;
    if (dir === 'backward') head = n - 1 - mod(k, n);
    else if (dir === 'bounce') {
      const period = Math.max(1, 2 * n - 2);
      const m = mod(k, period);
      head = m < n ? m : period - m;
    } else if (dir === 'random') head = hash32(k * 7919 + pc.seed) % n;
    else head = mod(k, n);
    for (const { rec, slot } of pc.members) {
      const s = states.get(rec.id);
      let d;
      if (dir === 'bounce' || dir === 'random') d = Math.abs(slot - head);
      else if (dir === 'backward') d = mod(slot - head, n);
      else d = mod(head - slot, n);
      let v = 0;
      if (d < width) v = 1;
      else if (tail > 0 && d < width + tail) v = 1 - (d - width + 1) / (tail + 1);
      setDimmer(s, level * v, alpha, p.dimmerMode);
      if (p.color != null) setColor(s, p.color, alpha);
    }
  },

  strobe(pc, t, beat, alpha, states) {
    const p = pc.clip.params;
    const rate = clamp(num(p.rate, 0.7), 0, 1);
    const level = num(p.level, 1);
    for (const { rec } of pc.members) {
      const s = states.get(rec.id);
      setStep(s, 'strobe', rate, alpha);
      setDimmer(s, level, alpha, 'htp');
      if (p.color != null) setColor(s, p.color, alpha);
    }
  },

  colorCycle(pc, t, beat, alpha, states) {
    const p = pc.clip.params;
    const cycle = posNum(p.cycle, 16);
    const spread = num(p.spread, 0.5);
    const sat = clamp(num(p.saturation, 1), 0, 1);
    for (const { rec, slot } of pc.members) {
      const hue = fract(beat / cycle + (spread * slot) / pc.slotCount);
      setColor(states.get(rec.id), hsvToRgb(hue, sat, 1), alpha);
    }
  },

  colorStep(pc, t, beat, alpha, states) {
    const p = pc.clip.params;
    const colors = Array.isArray(p.colors) ? p.colors.filter(isColor) : [];
    if (!colors.length) return;
    const step = posNum(p.step, 4);
    const k = Math.floor(beat / step);
    for (const { rec, slot } of pc.members) {
      const idx = mod(k + (p.alternate ? slot : 0), colors.length);
      setColor(states.get(rec.id), colors[idx], alpha);
    }
  },

  movement(pc, t, beat, alpha, states) {
    const p = pc.clip.params;
    const cycle = posNum(p.cycle, 8);
    const sizePan = num(p.sizePan, 30);
    const sizeTilt = num(p.sizeTilt, 20);
    const spread = num(p.spread, 0.25);
    for (const { rec, slot } of pc.members) {
      if (!rec.caps.panTilt) continue;
      const s = states.get(rec.id);
      const phase = 2 * Math.PI * (beat / cycle + (spread * slot) / pc.slotCount);
      const [dx, dy] = movementOffset(p.shape, phase);
      const center = p.center === 'manual' || !rec.aim ? { pan: num(p.pan), tilt: num(p.tilt) } : rec.aim;
      setNum(s, 'pan', center.pan + sizePan * dx, alpha);
      setNum(s, 'tilt', center.tilt + sizeTilt * dy, alpha);
    }
  },

  keyframes(pc, t, beat, alpha, states) {
    const rel = t - pc.clip.start;
    const mode = pc.clip.params.dimmerMode;
    for (const [param, list] of pc.keys) {
      const v = interpolateKeys(list, rel);
      if (v === undefined) continue;
      for (const { rec } of pc.members) {
        const s = states.get(rec.id);
        if (param === 'dimmer') setDimmer(s, v, alpha, mode);
        else if (param === 'color') setColor(s, v, alpha);
        else setNum(s, param, v, alpha);
      }
    }
  },
};

/** Grand master, blackout and flash buttons from Live mode. Blackout always wins. */
export function applyLive(states, live) {
  if (!live) return;
  const master = live.blackout ? 0 : clamp(num(live.master, 1), 0, 1);
  for (const s of states.values()) {
    if (live.flash === 'blinder') {
      s.dimmer = 1;
      s.color = [1, 1, 1];
      s.strobe = 0;
    } else if (live.flash === 'strobe') {
      s.dimmer = 1;
      s.color = [1, 1, 1];
      s.strobe = 0.85;
    }
    s.dimmer *= master;
  }
}

// ---- Layers above the timeline --------------------------------------------------------

/** Scenes and faders hold exact values: intensity overrides (LTP) instead of adding. */
function applyAttrs(s, attrs, alpha) {
  if (attrs.dimmer != null) setDimmer(s, attrs.dimmer, alpha, 'set');
  if (attrs.color) setColor(s, attrs.color, alpha);
  if (attrs.pan != null) setNum(s, 'pan', attrs.pan, alpha);
  if (attrs.tilt != null) setNum(s, 'tilt', attrs.tilt, alpha);
  if (attrs.zoom != null) setNum(s, 'zoom', attrs.zoom, alpha);
  if (attrs.strobe != null) setNum(s, 'strobe', attrs.strobe, alpha);
  if (attrs.gobo != null) setStep(s, 'gobo', attrs.gobo, alpha);
  if (attrs.prism != null) setStep(s, 'prism', attrs.prism, alpha);
}

/** 0..1 visibility of an active scene { id, at, releasedAt } at engine time `now`. */
export function sceneAlpha(scene, entry, now) {
  const fade = scene.fadeMs || 0;
  let a = fade > 0 ? clamp((now - entry.at) / fade, 0, 1) : 1;
  if (entry.releasedAt != null) a = Math.min(a, fade > 0 ? 1 - clamp((now - entry.releasedAt) / fade, 0, 1) : 0);
  return a;
}

/** The latest hit in a band, as an envelope: its strength at the hit, falling to 0 over decayMs. */
export function onsetEnvelope(rt, band, decayMs, now) {
  const at = rt?.last?.[band];
  if (at == null) return 0;
  const since = now - at;
  if (since < 0) return rt.strength?.[band] ?? 1; // another window's clock is a hair behind
  if (since >= decayMs) return 0;
  return (rt.strength?.[band] ?? 1) * (1 - since / decayMs) ** 2;
}

function applyReactive(states, mappings, groups, scenesById, rt, now) {
  const each = (ids, fn) => {
    for (const id of ids) {
      const s = states.get(id);
      if (s) fn(s);
    }
  };
  for (const m of mappings) {
    const ids = groups.get(m.target) || [];
    const env = onsetEnvelope(rt, m.band, m.decayMs, now);
    switch (m.action) {
      case 'pulse':
        if (env > 0) each(ids, (s) => setDimmer(s, m.amount * env, 1, 'htp'));
        break;
      case 'flash':
        if (env > 0) each(ids, (s) => {
          setDimmer(s, m.amount * env, 1, 'htp');
          setColor(s, [1, 1, 1], env);
        });
        break;
      case 'strobe':
        if (env > 0) each(ids, (s) => {
          s.strobe = 0.9;
          setDimmer(s, m.amount, 1, 'htp');
        });
        break;
      case 'colorStep': {
        const n = rt.count?.[m.band] || 0;
        if (m.colors?.length && n > 0) {
          const c = m.colors[n % m.colors.length];
          each(ids, (s) => setColor(s, c, 1));
        }
        break;
      }
      case 'follow': {
        const level = clamp(num(rt.env?.[m.band]), 0, 1);
        each(ids, (s) => setDimmer(s, m.amount * level, 1, 'htp'));
        break;
      }
      case 'scene': {
        const scene = scenesById.get(m.sceneId);
        if (scene && env > 0) {
          for (const fx in scene.attrs) {
            const s = states.get(fx);
            if (s) applyAttrs(s, scene.attrs[fx], env * m.amount);
          }
        }
        break;
      }
      default:
        break;
    }
  }
}

/** Raw channel values from active scenes, then manual faders (which win): fixture -> ch -> value. */
function collectRaw(activeScenes, scenesById, programmer, now) {
  const raw = new Map();
  const put = (fx, chans) => {
    let m = raw.get(fx);
    if (!m) raw.set(fx, (m = new Map()));
    for (const k in chans) m.set(Number(k), chans[k]);
  };
  for (const entry of activeScenes || []) {
    const scene = scenesById.get(entry.id);
    if (scene && sceneAlpha(scene, entry, now) >= 0.5) for (const fx in scene.raw) put(fx, scene.raw[fx]);
  }
  if (programmer?.raw) for (const fx in programmer.raw) put(fx, programmer.raw[fx]);
  return raw;
}

/**
 * Raw channel values replace bytes exactly at render time. This mirrors them back into the
 * fixture states so the 3D view shows them too (intensity, RGB, pan/tilt, zoom, strobe).
 */
function rawToStates(states, raw, byId) {
  for (const [fx, chans] of raw) {
    const rec = byId.get(fx);
    const s = states.get(fx);
    if (!rec || !s) continue;
    const channels = rec.profile.channels;
    let color = null;
    const pos = {};
    for (const [i, v] of chans) {
      const ch = channels[i];
      if (!ch) continue;
      const lo = ch.min ?? 0;
      const hi = ch.max ?? 255;
      const lin = hi > lo ? clamp((v - lo) / (hi - lo), 0, 1) : 0;
      const n = ch.invert ? 1 - lin : lin;
      switch (ch.attr) {
        case 'dimmer':
          s.dimmer = n;
          break;
        case 'red':
          (color ||= [...s.color])[0] = n;
          break;
        case 'green':
          (color ||= [...s.color])[1] = n;
          break;
        case 'blue':
          (color ||= [...s.color])[2] = n;
          break;
        case 'zoom':
          s.zoom = n;
          break;
        case 'strobe': {
          const sMin = ch.min ?? 1;
          s.strobe = v === (ch.off ?? 0) ? 0 : clamp((v - sMin) / ((ch.max ?? 255) - sMin || 1), 0, 1);
          break;
        }
        case 'pan':
        case 'tilt':
          (pos[ch.attr] ||= {})[ch.fine ? 'fine' : 'coarse'] = v;
          break;
        default:
          break;
      }
    }
    if (color) {
      if (rec.caps.dimmer) s.color = color;
      else {
        const m = Math.max(...color);
        s.dimmer = m;
        if (m > 0) s.color = color.map((c) => c / m);
      }
    }
    for (const attr of ['pan', 'tilt']) {
      const p = pos[attr];
      if (!p) continue;
      const range = attr === 'pan' ? panRange(rec.profile) : tiltRange(rec.profile);
      let v;
      if (rec.fineAttrs.has(attr)) {
        const cur = Math.round(clamp((s[attr] + range / 2) / range, 0, 1) * 65535);
        v = ((p.coarse ?? cur >> 8) * 256 + (p.fine ?? (cur & 255))) / 65535;
      } else {
        v = (p.coarse ?? 0) / 255;
      }
      s[attr] = v * range - range / 2;
    }
  }
}

/** Prime/Calibrate: an open white beam at the (calibrated) aim point; others off if asked. */
function applyCalibration(states, cal, fixtures) {
  const targets = new Set();
  if (!cal) return targets;
  for (const rec of fixtures) if (rec.caps.panTilt && (cal.all || rec.id === cal.fixtureId)) targets.add(rec.id);
  for (const rec of fixtures) {
    const s = states.get(rec.id);
    if (targets.has(rec.id)) {
      s.dimmer = 1;
      s.color = [1, 1, 1];
      s.strobe = 0;
      s.zoom = 0;
      s.gobo = 0;
      s.prism = 0;
      s.pan = rec.aim.pan;
      s.tilt = rec.aim.tilt;
    } else if (cal.othersOff !== false) {
      s.dimmer = 0;
    }
  }
  return targets;
}

/**
 * Prepare a show for fast repeated evaluation. Rebuild whenever the show changes;
 * evaluate() itself allocates only the per-fixture state objects.
 */
export function createEvaluator(show) {
  const tempo = createTempo(show.tempo);
  const audience = show.stage?.audience || { x: 0, y: 1.6, z: 8 };
  const fixtures = [];
  for (const f of show.fixtures) {
    const profile = resolveProfile(show, f.profileId);
    if (!profile) continue;
    const matrix = rotationMatrix(f.rotation);
    const caps = profileCaps(profile);
    // Aim at the centre point, corrected by the offset saved in Prime/Calibrate. Every "aim"
    // position uses this, so generated shows pick up calibration automatically.
    const base = caps.panTilt ? aimAt(f, audience, profile, matrix) : null;
    fixtures.push({
      id: f.id,
      fixture: f,
      profile,
      caps,
      matrix,
      fineAttrs: new Set(profile.channels.filter((c) => c.fine).map((c) => c.attr)),
      aim: base
        ? { pan: base.pan + (f.calibration?.pan || 0), tilt: base.tilt + (f.calibration?.tilt || 0), reachable: base.reachable }
        : null,
    });
  }
  const byId = new Map(fixtures.map((x) => [x.id, x]));
  const trackOrder = new Map(show.timeline.tracks.map((tr, i) => [tr.id, i]));
  const muted = new Set(show.timeline.tracks.filter((tr) => tr.muted).map((tr) => tr.id));
  const prepared = show.timeline.clips
    .filter((c) => trackOrder.has(c.track) && !muted.has(c.track) && c.end > c.start && HANDLERS[c.type])
    .map((c) => prepareClip(c, byId))
    .sort((a, b) => trackOrder.get(a.clip.track) - trackOrder.get(b.clip.track) || a.clip.start - b.clip.start);
  const scenesById = new Map((show.scenes || []).map((s) => [s.id, s]));
  const groups = new Map(fixtureGroups(show).map((g) => [g.key, g.fixtures]));
  const mappings = show.audioReactive?.mappings || [];

  // ---- Live auto show: the generator's fixture roles, prepared looks cached by plan ----
  const roleOf = (rec) => fixtureRole(rec.profile);
  const ids = (list) => list.map((r) => r.id);
  const liveMovers = ids(fixtures.filter((r) => roleOf(r) === 'mover'));
  const liveStrobes = ids(fixtures.filter((r) => roleOf(r) === 'strobe'));
  const washRecs = fixtures.filter((r) => roleOf(r) === 'wash' || roleOf(r) === 'dimmer');
  const liveWashes = ids(washRecs);
  const liveTargets = {
    base: [...liveMovers, ...liveWashes],
    rhythm: liveWashes,
    // Every other wash in stage order, for the off-beat hi-hat flicks.
    sparkle: ids(washRecs.slice().sort((a, b) => a.fixture.position.x - b.fixture.position.x).filter((_, i) => i % 2 === 1)),
    beams: liveMovers,
    backbeat: liveMovers.length ? liveMovers : liveStrobes,
    move: liveMovers,
    color: ids(fixtures.filter((r) => r.caps.color && roleOf(r) !== 'strobe')),
  };
  const liveStyle = show.audioReactive?.autoStyle || 'balanced';
  const liveSeed = stringHash(show.meta?.name || 'show') % 6;
  const liveCache = new Map();
  const livePrepared = (key, make) => {
    let v = liveCache.get(key);
    if (!v) {
      v = make();
      liveCache.set(key, v);
      if (liveCache.size > 64) liveCache.delete(liveCache.keys().next().value);
    }
    return v;
  };
  const virtualClip = (name, type, params, targets) => prepareClip({ id: `auto-${name}`, type, params, fixtures: targets, start: 0, end: Infinity, fadeIn: 0, fadeOut: 0 }, byId);

  /** A pulse fired by the real drum hit in a band, decaying over decayMs. */
  function hitPulse(pc, rt, band, decayMs, alpha, states, now) {
    const env = onsetEnvelope(rt, band, decayMs, now);
    if (env <= 0) return;
    const level = num(pc.clip.params.level, 1);
    for (const { rec } of pc.members) setDimmer(states.get(rec.id), level * env, alpha, 'htp');
  }

  function applyLiveShow(states, auto, rt, now) {
    const plan = livePlan(auto, { style: liveStyle, seed: liveSeed }, now);
    const L = livePrepared(plan.key, () => {
      const out = {};
      for (const [name, layer] of Object.entries(plan.look)) {
        if (layer && liveTargets[name]?.length) out[name] = virtualClip(name, layer.type, layer.params, liveTargets[name]);
      }
      return out;
    });
    const a = plan.alpha;
    const run = (pc) => pc && HANDLERS[pc.clip.type](pc, now, plan.beat, a, states);
    run(L.base);
    if (plan.build) {
      for (const id of liveTargets.base) setDimmer(states.get(id), plan.build.level, a, 'htp');
      const step = plan.build.step;
      run(livePrepared(`build|${step}`, () => virtualClip('build', 'chase', { step, direction: 'forward', width: step <= 0.25 ? 2 : 1, tail: step <= 0.25 ? 0 : 1, level: 0.9, order: step <= 0.25 ? 'center' : 'x', dimmerMode: 'htp' }, liveWashes)));
    } else if (L.rhythm) {
      if (plan.kickPulse) hitPulse(L.rhythm, rt, 'low', num(L.rhythm.clip.params.decay, 0.6) * plan.beatMs, a, states, now);
      else run(L.rhythm);
    }
    if (L.sparkle) hitPulse(L.sparkle, rt, 'high', 0.25 * plan.beatMs, a, states, now);
    run(L.beams);
    if (L.backbeat) hitPulse(L.backbeat, rt, 'mid', 0.35 * plan.beatMs, a, states, now);
    run(L.move);
    run(L.color);
    // The drop hit (and a softer one when the kick comes back): full white, fading out.
    const flash = Math.max(plan.dropHit, plan.kickBack);
    if (flash > 0) {
      for (const id of liveTargets.base) {
        const st = states.get(id);
        setDimmer(st, flash, 1, 'htp');
        setColor(st, WHITE, flash);
      }
    }
    if (plan.dropStrobe || plan.build?.strobe) {
      for (const id of liveStrobes) {
        const st = states.get(id);
        st.strobe = plan.dropStrobe ? 0.85 : 0.6;
        setDimmer(st, 1, 1, 'htp');
      }
    }
  }

  /**
   * @param t     show position in ms
   * @param live  live state: master, blackout, flash, scenes, calibrate, audioReactive,
   *              programmer (manual faders) and reactive (live audio), as the engine holds it
   * @param now   engine clock in ms, for scene fades and audio hits (defaults to t)
   */
  function evaluate(t, live, now = t) {
    const states = new Map();
    for (const rec of fixtures) states.set(rec.id, defaultState());
    const ctx = live || {};
    if (ctx.autoShow) {
      applyLiveShow(states, ctx.reactive?.auto, ctx.reactive, now);
    } else {
      const beat = tempo.musicalBeat(t);
      for (const pc of prepared) {
        const c = pc.clip;
        if (t < c.start || t >= c.end) continue;
        const alpha = fadeAlpha(c, t);
        if (alpha <= 0) continue;
        HANDLERS[c.type](pc, t, beat, alpha, states);
      }
    }
    for (const entry of ctx.scenes || []) {
      const scene = scenesById.get(entry.id);
      if (!scene) continue;
      const a = sceneAlpha(scene, entry, now);
      if (a <= 0) continue;
      for (const fx in scene.attrs) {
        const s = states.get(fx);
        if (s) applyAttrs(s, scene.attrs[fx], a);
      }
    }
    if (ctx.audioReactive && ctx.reactive) applyReactive(states, mappings, groups, scenesById, ctx.reactive, now);
    if (ctx.programmer?.attrs) {
      for (const fx in ctx.programmer.attrs) {
        const s = states.get(fx);
        if (s) applyAttrs(s, ctx.programmer.attrs[fx], 1);
      }
    }
    const raw = ctx.calibrate ? new Map() : collectRaw(ctx.scenes, scenesById, ctx.programmer, now);
    if (raw.size) rawToStates(states, raw, byId);
    applyCalibration(states, ctx.calibrate, fixtures);
    applyLive(states, live);
    states.raw = raw;
    states.intensity = ctx.blackout ? 0 : clamp(num(ctx.master, 1), 0, 1);
    states.flash = !!ctx.flash;
    return states;
  }

  return { tempo, fixtures, byId, groups, evaluate, clipCount: prepared.length };
}
