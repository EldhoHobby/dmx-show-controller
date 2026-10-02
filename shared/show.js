// The show document: patch, stage, beat grid, song analysis and the timeline.
// One format is used for the working session, autosave and the exported event file.
// It never contains the audio itself, only its name, length and a content hash.

import { BUILTIN_PROFILES, checkProfile, resolveProfile } from './fixture-library.js';
import { CLIP_TYPES } from './clip-types.js';
import { isPlainObject } from './util.js';

export const SHOW_FORMAT = 'dmx-show';
export const SHOW_VERSION = 1;

// Same shape normalizeTrack produces, so new and reloaded shows are identical.
export const DEFAULT_TRACKS = [
  { id: 'trk_base', name: 'Base look', muted: false },
  { id: 'trk_rhythm', name: 'Rhythm', muted: false },
  { id: 'trk_beams', name: 'Mover beams', muted: false },
  { id: 'trk_move', name: 'Movement', muted: false },
  { id: 'trk_color', name: 'Colour FX', muted: false },
  { id: 'trk_accent', name: 'Accents', muted: false },
];

export function createShow(name = 'Untitled show') {
  const now = new Date().toISOString();
  return {
    format: SHOW_FORMAT,
    version: SHOW_VERSION,
    meta: { name, created: now, modified: now, notes: '' },
    audio: null,
    stage: { width: 10, depth: 6, height: 5, audience: { x: 0, y: 1.6, z: 8 } },
    profiles: [],
    fixtures: [],
    tempo: { bpm: 120, offset: 0, beatsPerBar: 4, downbeat: 0, beats: null },
    analysis: null,
    timeline: { durationMs: 180000, tracks: DEFAULT_TRACKS.map((t) => ({ ...t })), clips: [] },
    scenes: [],
    audioReactive: defaultReactive(),
    validated: null,
  };
}

// ---------------------------------------------------------------------------------------
// Normalization: every show that arrives from a file or over the network goes through here.
// It rebuilds the document from known keys only, so unexpected or hostile input cannot add
// fields, change prototypes or smuggle in non-JSON values.

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Copy plain JSON data, dropping dangerous keys and anything that is not JSON. */
export function sanitizeJson(value, depth = 0) {
  if (depth > 12) return null;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (Array.isArray(value)) return value.slice(0, 100000).map((v) => sanitizeJson(v, depth + 1));
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) continue;
      const v = sanitizeJson(value[key], depth + 1);
      if (v !== undefined) out[key] = v;
    }
    return out;
  }
  return undefined;
}

const str = (v, fallback = '', max = 200) => (typeof v === 'string' ? v.slice(0, max) : fallback);
const num = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const int = (v, fallback = 0) => Math.round(num(v, fallback));
const vec3 = (v, fb = { x: 0, y: 0, z: 0 }) => ({ x: num(v?.x, fb.x), y: num(v?.y, fb.y), z: num(v?.z, fb.z) });
const numArray = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'number' && Number.isFinite(x)) : []);
const clampTo = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v) => clampTo(num(v), 0, 1);
const isRgb = (c) => Array.isArray(c) && c.length === 3 && c.every((x) => typeof x === 'number' && Number.isFinite(x));

// ---- Manual values (faders, scenes) ---------------------------------------------------

/** Attributes a fader or scene may set, with their allowed ranges (pan/tilt in degrees). */
export const ATTR_LIMITS = {
  dimmer: [0, 1],
  pan: [-720, 720],
  tilt: [-360, 360],
  zoom: [0, 1],
  strobe: [0, 1],
  gobo: [0, 64],
  prism: [0, 1],
};

const okId = (k) => typeof k === 'string' && k.length > 0 && k.length <= 64 && !FORBIDDEN_KEYS.has(k);

/** One fixture's attribute values. Unknown keys are dropped; null means "release" when kept. */
export function normalizeAttrs(a, { keepNull = false } = {}) {
  const out = {};
  if (!isPlainObject(a)) return out;
  for (const key of Object.keys(a)) {
    const v = a[key];
    if (key !== 'color' && !Object.hasOwn(ATTR_LIMITS, key)) continue;
    if (v === null) {
      if (keepNull) out[key] = null;
    } else if (key === 'color') {
      if (isRgb(v)) out.color = v.map(clamp01);
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      const [lo, hi] = ATTR_LIMITS[key];
      let x = clampTo(v, lo, hi);
      if (key === 'gobo') x = Math.round(x);
      if (key === 'prism') x = x >= 0.5 ? 1 : 0;
      out[key] = x;
    }
  }
  return out;
}

/** fixture id -> attribute values */
export function normalizeAttrMap(m, opts) {
  const out = {};
  if (!isPlainObject(m)) return out;
  for (const fx of Object.keys(m).slice(0, 2000)) {
    if (!okId(fx)) continue;
    const attrs = normalizeAttrs(m[fx], opts);
    if (Object.keys(attrs).length) out[fx] = attrs;
  }
  return out;
}

/** fixture id -> { channel index (0-based) -> DMX value 0..255 } */
export function normalizeRawMap(m, { keepNull = false } = {}) {
  const out = {};
  if (!isPlainObject(m)) return out;
  for (const fx of Object.keys(m).slice(0, 2000)) {
    if (!okId(fx) || !isPlainObject(m[fx])) continue;
    const chans = {};
    for (const k of Object.keys(m[fx])) {
      const ch = Number(k);
      if (!Number.isInteger(ch) || ch < 0 || ch > 511) continue;
      const v = m[fx][k];
      if (v === null) {
        if (keepNull) chans[ch] = null;
      } else if (typeof v === 'number' && Number.isFinite(v)) {
        chans[ch] = clampTo(Math.round(v), 0, 255);
      }
    }
    if (Object.keys(chans).length) out[fx] = chans;
  }
  return out;
}

export function normalizeScene(s) {
  if (!isPlainObject(s)) return null;
  const id = str(s.id, '', 64);
  if (!id) return null;
  return {
    id,
    name: str(s.name, '', 60) || 'Scene',
    color: typeof s.color === 'string' && /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#4f8fe8',
    fadeMs: clampTo(num(s.fadeMs), 0, 60000),
    attrs: normalizeAttrMap(s.attrs),
    raw: normalizeRawMap(s.raw),
  };
}

// ---- Live audio reactions -------------------------------------------------------------

export const REACTIVE_BANDS = ['low', 'mid', 'high'];
export const REACTIVE_ACTIONS = ['pulse', 'flash', 'strobe', 'colorStep', 'follow', 'scene'];

/** Kick pumps the washes, the mid band (snare, vocals) steps their colour, hi-hats flick the movers. */
export function defaultReactive() {
  return {
    sensitivity: { low: 1, mid: 1, high: 1 },
    mappings: [
      { id: 'map_kick', band: 'low', action: 'pulse', target: 'role:wash', amount: 1, decayMs: 260, sceneId: '', colors: [] },
      {
        id: 'map_mid',
        band: 'mid',
        action: 'colorStep',
        target: 'role:wash',
        amount: 1,
        decayMs: 300,
        sceneId: '',
        colors: [[0, 0.15, 1], [1, 0, 0.75], [0, 0.9, 1], [1, 0.6, 0]],
      },
      { id: 'map_hats', band: 'high', action: 'pulse', target: 'role:mover', amount: 0.8, decayMs: 120, sceneId: '', colors: [] },
    ],
  };
}

function normalizeMapping(m) {
  if (!isPlainObject(m)) return null;
  const id = str(m.id, '', 64);
  if (!id || !REACTIVE_BANDS.includes(m.band) || !REACTIVE_ACTIONS.includes(m.action)) return null;
  return {
    id,
    band: m.band,
    action: m.action,
    target: str(m.target, 'all', 160) || 'all',
    amount: clamp01(num(m.amount, 1)),
    decayMs: clampTo(num(m.decayMs, 250), 20, 5000),
    sceneId: str(m.sceneId, '', 64),
    colors: Array.isArray(m.colors) ? m.colors.filter(isRgb).slice(0, 16).map((c) => c.map(clamp01)) : [],
  };
}

export function normalizeReactive(r) {
  if (!isPlainObject(r)) return defaultReactive();
  const sens = isPlainObject(r.sensitivity) ? r.sensitivity : {};
  const s = (v) => clampTo(num(v, 1), 0.2, 3);
  return {
    sensitivity: { low: s(sens.low), mid: s(sens.mid), high: s(sens.high) },
    mappings: dedupe((Array.isArray(r.mappings) ? r.mappings : []).map(normalizeMapping).filter(Boolean)).slice(0, 32),
  };
}

export function normalizeProfile(p) {
  const clean = sanitizeJson(p);
  return checkProfile(clean).length ? null : clean;
}

export function normalizeFixture(f) {
  if (!isPlainObject(f)) return null;
  const id = str(f.id, '', 64);
  if (!id) return null;
  return {
    id,
    name: str(f.name, id, 80),
    profileId: str(f.profileId, '', 120),
    universe: Math.max(1, int(f.universe, 1)),
    address: Math.max(1, int(f.address, 1)),
    position: vec3(f.position),
    rotation: vec3(f.rotation),
    group: str(f.group, '', 40),
    // Moving heads: pan/tilt correction (degrees) found in Prime/Calibrate, added to every aim.
    calibration: {
      pan: clampTo(num(f.calibration?.pan), -180, 180),
      tilt: clampTo(num(f.calibration?.tilt), -180, 180),
    },
  };
}

export function normalizeClip(c, trackIds) {
  if (!isPlainObject(c)) return null;
  const id = str(c.id, '', 64);
  const type = str(c.type, '', 32);
  if (!id || !CLIP_TYPES[type]) return null;
  const start = Math.max(0, num(c.start));
  const end = Math.max(start + 1, num(c.end, start + 1000));
  return {
    id,
    type,
    name: str(c.name, '', 80),
    track: trackIds.has(c.track) ? c.track : [...trackIds][0],
    start,
    end,
    fadeIn: Math.max(0, num(c.fadeIn)),
    fadeOut: Math.max(0, num(c.fadeOut)),
    fixtures: Array.isArray(c.fixtures) ? c.fixtures.filter((x) => typeof x === 'string').slice(0, 1024) : [],
    params: isPlainObject(c.params) ? sanitizeJson(c.params) : {},
  };
}

export function normalizeAnalysis(a) {
  if (!isPlainObject(a)) return null;
  const sections = Array.isArray(a.sections)
    ? a.sections
        .filter(isPlainObject)
        .map((s) => ({ start: num(s.start), end: num(s.end), energy: num(s.energy), label: str(s.label, 'section', 24) }))
    : [];
  return {
    durationMs: num(a.durationMs),
    bpm: num(a.bpm),
    confidence: num(a.confidence),
    sections,
    drops: numArray(a.drops),
    energy: numArray(a.energy),
    peaks: numArray(a.peaks),
    onsets: numArray(a.onsets),
    version: int(a.version, 1),
  };
}

export function normalizeTrack(t) {
  if (!isPlainObject(t)) return null;
  const id = str(t.id, '', 64);
  return id ? { id, name: str(t.name, 'Track', 60), muted: t.muted === true } : null;
}

export function normalizeTempo(input) {
  const t = isPlainObject(input) ? input : {};
  const beats = numArray(t.beats);
  return {
    bpm: num(t.bpm, 120) > 0 ? Math.min(400, num(t.bpm, 120)) : 120,
    offset: num(t.offset),
    beatsPerBar: Math.min(16, Math.max(1, int(t.beatsPerBar, 4))),
    downbeat: int(t.downbeat),
    beats: beats.length >= 2 ? beats.sort((a, b) => a - b) : null,
  };
}

export function normalizeAudio(a) {
  if (!isPlainObject(a)) return null;
  return {
    name: str(a.name, 'audio', 200),
    hash: typeof a.hash === 'string' && /^[a-f0-9]{64}$/.test(a.hash) ? a.hash : null,
    durationMs: Math.max(0, num(a.durationMs)),
    sampleRate: Math.max(0, num(a.sampleRate)),
  };
}

export function normalizeStage(s) {
  const st = isPlainObject(s) ? s : {};
  return {
    width: Math.max(1, num(st.width, 10)),
    depth: Math.max(1, num(st.depth, 6)),
    height: Math.max(1, num(st.height, 5)),
    audience: vec3(st.audience, { x: 0, y: 1.6, z: 8 }),
  };
}

export function normalizeTimeline(input) {
  const tl = isPlainObject(input) ? input : {};
  const tracks = dedupe((Array.isArray(tl.tracks) ? tl.tracks : []).map(normalizeTrack).filter(Boolean));
  const finalTracks = tracks.length ? tracks : DEFAULT_TRACKS.map((t) => ({ ...t }));
  const trackIds = new Set(finalTracks.map((t) => t.id));
  return {
    durationMs: Math.max(1000, num(tl.durationMs, 180000)),
    tracks: finalTracks,
    clips: dedupe((Array.isArray(tl.clips) ? tl.clips : []).map((c) => normalizeClip(c, trackIds)).filter(Boolean)),
  };
}

/** Validate and rebuild a show. Throws with a readable message when it is not a show. */
export function normalizeShow(input) {
  if (!isPlainObject(input)) throw new Error('This file is not a DMX show (expected a JSON object).');
  if (input.format !== SHOW_FORMAT) throw new Error('This file is not a DMX show (missing "format": "dmx-show").');
  if (num(input.version, 1) > SHOW_VERSION) {
    throw new Error(`This show was made with a newer version (format ${input.version}). Update the app to open it.`);
  }
  const base = createShow();
  const meta = isPlainObject(input.meta) ? input.meta : {};
  return {
    format: SHOW_FORMAT,
    version: SHOW_VERSION,
    meta: {
      name: str(meta.name, 'Untitled show', 120),
      created: str(meta.created, base.meta.created, 40),
      modified: str(meta.modified, base.meta.modified, 40),
      notes: str(meta.notes, '', 4000),
    },
    audio: normalizeAudio(input.audio),
    stage: normalizeStage(input.stage),
    // Duplicate ids would break editing; dedupe keeps the first of each.
    profiles: dedupe((Array.isArray(input.profiles) ? input.profiles : []).map(normalizeProfile).filter(Boolean)),
    fixtures: dedupe((Array.isArray(input.fixtures) ? input.fixtures : []).map(normalizeFixture).filter(Boolean)),
    tempo: normalizeTempo(input.tempo),
    analysis: normalizeAnalysis(input.analysis),
    timeline: normalizeTimeline(input.timeline),
    scenes: dedupe((Array.isArray(input.scenes) ? input.scenes : []).map(normalizeScene).filter(Boolean)).slice(0, 200),
    audioReactive: normalizeReactive(input.audioReactive),
    validated: isPlainObject(input.validated) ? sanitizeJson(input.validated) : null,
  };
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
}

/**
 * Build the self-contained event file: every profile the patch uses is embedded, so the file
 * opens on any machine even if its fixture library differs.
 */
export function exportShow(show, validation) {
  const out = structuredClone(show);
  const embedded = new Map(out.profiles.map((p) => [p.id, p]));
  for (const f of out.fixtures) {
    if (!embedded.has(f.profileId)) {
      const p = resolveProfile(show, f.profileId);
      if (p) embedded.set(p.id, structuredClone(p));
    }
  }
  out.profiles = [...embedded.values()];
  out.meta.modified = new Date().toISOString();
  out.validated = validation
    ? { at: out.meta.modified, errors: validation.errors, warnings: validation.warnings }
    : null;
  return out;
}

export function isBuiltinProfileId(id) {
  return BUILTIN_PROFILES.some((p) => p.id === id);
}

export function showSummary(show) {
  return {
    name: show.meta.name,
    fixtures: show.fixtures.length,
    clips: show.timeline.clips.length,
    durationMs: show.timeline.durationMs,
    bpm: show.tempo.bpm,
  };
}
