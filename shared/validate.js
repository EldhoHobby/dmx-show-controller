// Pre-export validation. Errors block exporting a show for an event; warnings do not.

import { footprint, panRange, resolveProfile, tiltRange, profileCaps } from './fixture-library.js';
import { CLIP_TYPES } from './clip-types.js';
import { aimAt } from './kinematics.js';
import { formatTime } from './util.js';

export function validateShow(show, { routedUniverses = null } = {}) {
  const issues = [];
  const add = (level, code, message, refs = {}) =>
    issues.push({ level, code, message, fixtures: refs.fixtures || [], clips: refs.clips || [] });

  // ---- Patch -------------------------------------------------------------------------
  const fixturesById = new Map();
  const occupancy = new Map(); // universe -> Array(513) of fixture ids (1-based slots)
  const overlaps = new Map(); // "a|b" -> { a, b, universe }
  const usedUniverses = new Set();
  for (const f of show.fixtures) {
    const profile = resolveProfile(show, f.profileId);
    fixturesById.set(f.id, { f, profile });
    if (!profile) {
      add('error', 'missing-profile', `${f.name}: fixture profile "${f.profileId}" is missing.`, { fixtures: [f.id] });
      continue;
    }
    const n = footprint(profile);
    if (!Number.isInteger(f.universe) || f.universe < 1 || f.universe > 63999) {
      add('error', 'bad-universe', `${f.name}: universe ${f.universe} is outside 1–63999.`, { fixtures: [f.id] });
      continue;
    }
    usedUniverses.add(f.universe);
    const last = f.address + n - 1;
    if (!Number.isInteger(f.address) || f.address < 1 || last > 512) {
      add('error', 'address-range', `${f.name}: channels ${f.address}–${last} do not fit in a 512-channel universe.`, {
        fixtures: [f.id],
      });
      continue;
    }
    let slots = occupancy.get(f.universe);
    if (!slots) occupancy.set(f.universe, (slots = new Array(513).fill(null)));
    for (let ch = f.address; ch <= last; ch++) {
      const other = slots[ch];
      if (other) {
        const key = [other, f.id].sort().join('|');
        if (!overlaps.has(key)) overlaps.set(key, { a: other, b: f.id, universe: f.universe, channel: ch });
      } else {
        slots[ch] = f.id;
      }
    }
  }
  for (const { a, b, universe, channel } of overlaps.values()) {
    const fa = fixturesById.get(a).f;
    const fb = fixturesById.get(b).f;
    add('error', 'address-overlap', `${fa.name} and ${fb.name} share DMX channels on universe ${universe} (from channel ${channel}).`, {
      fixtures: [a, b],
    });
  }

  // Movers that cannot reach the centre point are almost always mounted the wrong way round.
  const audience = show.stage?.audience;
  if (audience) {
    for (const { f, profile } of fixturesById.values()) {
      if (!profile || !profileCaps(profile).panTilt) continue;
      const aim = aimAt(f, audience, profile);
      if (!aim.reachable) {
        add('warning', 'aim-unreachable', `${f.name} cannot point at the centre point from its position — check its mounting rotation.`, {
          fixtures: [f.id],
        });
      } else if (
        Math.abs(aim.pan + (f.calibration?.pan || 0)) > panRange(profile) / 2 ||
        Math.abs(aim.tilt + (f.calibration?.tilt || 0)) > tiltRange(profile) / 2
      ) {
        add('warning', 'calibration-range', `${f.name}: its calibration offset points past its pan/tilt range.`, { fixtures: [f.id] });
      }
    }
  }

  // Scenes keep working with fixtures removed, but say so.
  for (const scene of show.scenes || []) {
    const ids = new Set([...Object.keys(scene.attrs || {}), ...Object.keys(scene.raw || {})]);
    const missing = [...ids].filter((id) => !fixturesById.has(id));
    if (missing.length) {
      add('warning', 'scene-missing-fixtures', `Scene "${scene.name}" sets ${missing.length} fixture(s) that are no longer patched.`);
    }
    for (const [fx, chans] of Object.entries(scene.raw || {})) {
      const profile = fixturesById.get(fx)?.profile;
      if (profile && Object.keys(chans).some((ch) => Number(ch) >= profile.channels.length)) {
        add('warning', 'scene-channel-range', `Scene "${scene.name}" sets channels ${fixturesById.get(fx).f.name} does not have.`, { fixtures: [fx] });
      }
    }
  }

  // ---- Timeline ----------------------------------------------------------------------
  const duration = show.timeline.durationMs;
  const trackIds = new Set(show.timeline.tracks.map((t) => t.id));
  const trackNames = new Map(show.timeline.tracks.map((t) => [t.id, t.name]));
  for (const c of show.timeline.clips) {
    const label = `${CLIP_TYPES[c.type]?.label || c.type} clip at ${formatTime(c.start, false)}`;
    const refs = { clips: [c.id] };
    if (!CLIP_TYPES[c.type]) add('error', 'clip-type', `${label}: unknown clip type "${c.type}".`, refs);
    if (!trackIds.has(c.track)) add('error', 'clip-track', `${label}: its track no longer exists.`, refs);
    if (!(c.end > c.start)) add('error', 'clip-length', `${label}: ends before it starts.`, refs);
    if (c.start >= duration) add('warning', 'clip-after-end', `${label}: starts after the show ends.`, refs);
    else if (c.end > duration + 1) add('warning', 'clip-past-end', `${label}: runs past the end of the show.`, refs);
    const missing = c.fixtures.filter((id) => !fixturesById.has(id));
    if (missing.length) {
      add('error', 'clip-missing-fixtures', `${label}: uses ${missing.length} fixture(s) that are no longer patched.`, refs);
    }
    if (!c.fixtures.length) add('warning', 'clip-no-fixtures', `${label}: has no fixtures assigned.`, refs);
    if (c.fadeIn + c.fadeOut > c.end - c.start + 1) {
      add('warning', 'clip-fades', `${label}: fade in + fade out are longer than the clip.`, refs);
    }
    checkPositions(c, label, fixturesById, audience, add);
    if (c.type === 'keyframes') checkKeyframes(c, label, add);
  }

  // Overlapping clips on one track fight over the same fixtures.
  const byTrack = new Map();
  for (const c of show.timeline.clips) {
    if (!byTrack.has(c.track)) byTrack.set(c.track, []);
    byTrack.get(c.track).push(c);
  }
  for (const [trackId, clips] of byTrack) {
    clips.sort((a, b) => a.start - b.start);
    for (let i = 0; i < clips.length; i++) {
      for (let j = i + 1; j < clips.length && clips[j].start < clips[i].end; j++) {
        const shared = clips[i].fixtures.filter((id) => clips[j].fixtures.includes(id));
        if (shared.length && clips[j].start < clips[i].end - 1) {
          add('warning', 'clip-overlap', `Overlapping clips on track "${trackNames.get(trackId) || trackId}" at ${formatTime(clips[j].start, false)} control the same fixtures.`, {
            clips: [clips[i].id, clips[j].id],
          });
        }
      }
    }
  }

  // ---- Tempo, audio, outputs ---------------------------------------------------------
  const bpm = show.tempo?.bpm;
  if (!(bpm >= 40 && bpm <= 250)) add('warning', 'tempo-range', `Tempo ${bpm} BPM looks wrong; check the beat grid.`);
  if (show.audio?.durationMs && Math.abs(show.audio.durationMs - duration) > 2000) {
    add('warning', 'duration-mismatch', `Timeline length (${formatTime(duration, false)}) differs from the song (${formatTime(show.audio.durationMs, false)}).`);
  }
  if (routedUniverses) {
    for (const u of usedUniverses) {
      if (!routedUniverses.has(u)) add('warning', 'universe-unrouted', `Universe ${u} has fixtures but no DMX output is sending it.`);
    }
  }
  if (!show.fixtures.length) add('warning', 'no-fixtures', 'No fixtures are patched.');
  if (!show.timeline.clips.length) add('warning', 'no-clips', 'The timeline is empty.');

  const errors = issues.filter((i) => i.level === 'error').length;
  return { issues, errors, warnings: issues.length - errors, ok: errors === 0 };
}

function checkPositions(c, label, fixturesById, audience, add) {
  const p = c.params || {};
  const movers = c.fixtures
    .map((id) => fixturesById.get(id))
    .filter((x) => x?.profile && profileCaps(x.profile).panTilt);
  if (!movers.length) return;
  let outOfRange = 0;
  for (const { f, profile } of movers) {
    const halfPan = panRange(profile) / 2;
    const halfTilt = tiltRange(profile) / 2;
    if (c.type === 'static' && p.position === 'manual') {
      if (Math.abs(p.pan || 0) > halfPan || Math.abs(p.tilt || 0) > halfTilt) outOfRange++;
    } else if (c.type === 'movement') {
      const base = p.center === 'manual' || !audience ? null : aimAt(f, audience, profile);
      const center = base
        ? { pan: base.pan + (f.calibration?.pan || 0), tilt: base.tilt + (f.calibration?.tilt || 0) }
        : { pan: p.pan || 0, tilt: p.tilt || 0 };
      if (Math.abs(center.pan) + (p.sizePan || 0) > halfPan || Math.abs(center.tilt) + (p.sizeTilt || 0) > halfTilt) outOfRange++;
    } else if (c.type === 'keyframes') {
      const keys = p.keys || {};
      const bad = (keys.pan || []).some((k) => Math.abs(k.v) > halfPan) || (keys.tilt || []).some((k) => Math.abs(k.v) > halfTilt);
      if (bad) outOfRange++;
    }
  }
  if (outOfRange) {
    add('warning', 'pan-tilt-range', `${label}: pan/tilt goes beyond the range of ${outOfRange} moving head(s) and will be clipped.`, {
      clips: [c.id],
    });
  }
}

function checkKeyframes(c, label, add) {
  const keys = c.params?.keys || {};
  const length = c.end - c.start;
  for (const [param, list] of Object.entries(keys)) {
    if (!Array.isArray(list)) continue;
    const times = list.map((k) => k?.t).filter(Number.isFinite);
    if (new Set(times).size !== times.length) {
      add('warning', 'keyframe-duplicate', `${label}: two ${param} keyframes share the same time.`, { clips: [c.id] });
    }
    if (times.some((t) => t < 0 || t > length)) {
      add('warning', 'keyframe-outside', `${label}: some ${param} keyframes fall outside the clip.`, { clips: [c.id] });
    }
  }
}
