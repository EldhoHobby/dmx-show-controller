// Edit operations. Every change to a show is an op: the engine applies it to the master copy
// and broadcasts it, and every client applies the same op to its own copy with this same code,
// so all windows stay identical. applyOp returns the inverse op, which is how undo works.
//
// Ops are validated and normalized here because they arrive from the network.

import {
  normalizeAnalysis,
  normalizeAudio,
  normalizeClip,
  normalizeFixture,
  normalizeProfile,
  normalizeReactive,
  normalizeScene,
  normalizeShow,
  normalizeStage,
  normalizeTempo,
  normalizeTimeline,
  normalizeTrack,
  sanitizeJson,
} from './show.js';
import { isPlainObject } from './util.js';

export class OpError extends Error {}

export const OP_TYPES = new Set([
  'batch',
  'show.replace',
  'meta.set',
  'stage.set',
  'tempo.set',
  'audio.set',
  'analysis.set',
  'timeline.set',
  'timeline.setDuration',
  'profile.add',
  'profile.remove',
  'fixture.add',
  'fixture.update',
  'fixture.remove',
  'track.add',
  'track.update',
  'track.remove',
  'clip.add',
  'clip.update',
  'clip.remove',
  'scene.add',
  'scene.update',
  'scene.remove',
  'reactive.set',
]);

const fail = (msg) => {
  throw new OpError(msg);
};

function changesOf(op) {
  if (!isPlainObject(op.changes)) fail(`${op.type}: "changes" must be an object`);
  return sanitizeJson(op.changes);
}

function indexById(list, id, what) {
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) fail(`${what} "${id}" not found`);
  return i;
}

/** Replace the fields of target with those of next, returning the previous values. */
function assignWithInverse(target, next) {
  const old = {};
  for (const key of Object.keys(next)) {
    if (JSON.stringify(target[key]) !== JSON.stringify(next[key])) {
      old[key] = structuredClone(target[key]);
      target[key] = next[key];
    }
  }
  return old;
}

function replaceContents(target, next) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, next);
}

export function applyOp(show, op) {
  if (!isPlainObject(op) || !OP_TYPES.has(op.type)) fail(`Unknown operation "${op?.type}"`);

  switch (op.type) {
    case 'batch': {
      if (!Array.isArray(op.ops)) fail('batch: "ops" must be an array');
      if (op.ops.length > 5000) fail('batch: too many operations');
      const inverses = [];
      try {
        for (const sub of op.ops) {
          if (sub?.type === 'batch' || sub?.type === 'show.replace') fail('batch: cannot nest this operation');
          inverses.push(applyOp(show, sub));
        }
      } catch (err) {
        for (let i = inverses.length - 1; i >= 0; i--) applyOp(show, inverses[i]);
        throw err;
      }
      return { type: 'batch', ops: inverses.reverse() };
    }

    case 'show.replace': {
      const next = normalizeShow(op.show);
      const prev = structuredClone(show);
      replaceContents(show, next);
      return { type: 'show.replace', show: prev };
    }

    case 'meta.set': {
      const c = changesOf(op);
      const next = {};
      if (typeof c.name === 'string') next.name = c.name.slice(0, 120) || 'Untitled show';
      if (typeof c.notes === 'string') next.notes = c.notes.slice(0, 4000);
      return { type: 'meta.set', changes: assignWithInverse(show.meta, next) };
    }

    case 'stage.set': {
      const next = normalizeStage({ ...show.stage, ...changesOf(op) });
      return { type: 'stage.set', changes: assignWithInverse(show.stage, next) };
    }

    case 'tempo.set': {
      const next = normalizeTempo({ ...show.tempo, ...changesOf(op) });
      return { type: 'tempo.set', changes: assignWithInverse(show.tempo, next) };
    }

    case 'audio.set': {
      const prev = structuredClone(show.audio);
      show.audio = op.audio == null ? null : normalizeAudio(op.audio);
      return { type: 'audio.set', audio: prev };
    }

    case 'analysis.set': {
      const prev = structuredClone(show.analysis);
      show.analysis = op.analysis == null ? null : normalizeAnalysis(op.analysis);
      return { type: 'analysis.set', analysis: prev };
    }

    case 'timeline.set': {
      const prev = structuredClone(show.timeline);
      show.timeline = normalizeTimeline(op.timeline);
      return { type: 'timeline.set', timeline: prev };
    }

    case 'timeline.setDuration': {
      const d = Number(op.durationMs);
      if (!Number.isFinite(d) || d < 1000 || d > 6 * 3600 * 1000) fail('Duration must be between 1 s and 6 h');
      const prev = show.timeline.durationMs;
      show.timeline.durationMs = Math.round(d);
      return { type: 'timeline.setDuration', durationMs: prev };
    }

    case 'profile.add': {
      const p = normalizeProfile(op.profile);
      if (!p) fail('profile.add: invalid fixture profile');
      const i = show.profiles.findIndex((x) => x.id === p.id);
      if (i >= 0) {
        const prev = show.profiles[i];
        show.profiles[i] = p;
        return { type: 'profile.add', profile: prev };
      }
      show.profiles.push(p);
      return { type: 'profile.remove', id: p.id };
    }

    case 'profile.remove': {
      const i = indexById(show.profiles, op.id, 'Profile');
      const [prev] = show.profiles.splice(i, 1);
      return { type: 'profile.add', profile: prev };
    }

    case 'fixture.add': {
      const f = normalizeFixture(op.fixture);
      if (!f) fail('fixture.add: invalid fixture');
      if (show.fixtures.some((x) => x.id === f.id)) fail(`Fixture id "${f.id}" already exists`);
      const index = Number.isInteger(op.index) ? Math.max(0, Math.min(op.index, show.fixtures.length)) : show.fixtures.length;
      show.fixtures.splice(index, 0, f);
      return { type: 'fixture.remove', id: f.id };
    }

    case 'fixture.update': {
      const i = indexById(show.fixtures, op.id, 'Fixture');
      const merged = normalizeFixture({ ...show.fixtures[i], ...changesOf(op), id: op.id });
      if (!merged) fail('fixture.update: invalid values');
      return { type: 'fixture.update', id: op.id, changes: assignWithInverse(show.fixtures[i], merged) };
    }

    case 'fixture.remove': {
      // Also take the fixture out of every clip, so nothing dangles; the inverse puts it back.
      const i = indexById(show.fixtures, op.id, 'Fixture');
      const [prev] = show.fixtures.splice(i, 1);
      const restores = [];
      for (const c of show.timeline.clips) {
        if (c.fixtures.includes(op.id)) {
          restores.push({ type: 'clip.update', id: c.id, changes: { fixtures: c.fixtures.slice() } });
          c.fixtures = c.fixtures.filter((id) => id !== op.id);
        }
      }
      return { type: 'batch', ops: [{ type: 'fixture.add', fixture: prev, index: i }, ...restores] };
    }

    case 'track.add': {
      const t = normalizeTrack(op.track);
      if (!t) fail('track.add: invalid track');
      if (show.timeline.tracks.some((x) => x.id === t.id)) fail(`Track id "${t.id}" already exists`);
      const tracks = show.timeline.tracks;
      const index = Number.isInteger(op.index) ? Math.max(0, Math.min(op.index, tracks.length)) : tracks.length;
      tracks.splice(index, 0, t);
      return { type: 'track.remove', id: t.id };
    }

    case 'track.update': {
      const tracks = show.timeline.tracks;
      const i = indexById(tracks, op.id, 'Track');
      const merged = normalizeTrack({ ...tracks[i], ...changesOf(op), id: op.id });
      return { type: 'track.update', id: op.id, changes: assignWithInverse(tracks[i], merged) };
    }

    case 'track.remove': {
      const tracks = show.timeline.tracks;
      if (tracks.length <= 1) fail('The timeline needs at least one track');
      const i = indexById(tracks, op.id, 'Track');
      const [prev] = tracks.splice(i, 1);
      const removed = [];
      show.timeline.clips = show.timeline.clips.filter((c) => {
        if (c.track !== op.id) return true;
        removed.push(c);
        return false;
      });
      return {
        type: 'batch',
        ops: [{ type: 'track.add', track: prev, index: i }, ...removed.map((c) => ({ type: 'clip.add', clip: c }))],
      };
    }

    case 'clip.add': {
      const trackIds = new Set(show.timeline.tracks.map((t) => t.id));
      if (!trackIds.has(op.clip?.track)) fail('clip.add: unknown track');
      const c = normalizeClip(op.clip, trackIds);
      if (!c) fail('clip.add: invalid clip');
      if (show.timeline.clips.some((x) => x.id === c.id)) fail(`Clip id "${c.id}" already exists`);
      const clips = show.timeline.clips;
      const index = Number.isInteger(op.index) ? Math.max(0, Math.min(op.index, clips.length)) : clips.length;
      clips.splice(index, 0, c);
      return { type: 'clip.remove', id: c.id };
    }

    case 'clip.update': {
      const clips = show.timeline.clips;
      const i = indexById(clips, op.id, 'Clip');
      const changes = changesOf(op);
      const trackIds = new Set(show.timeline.tracks.map((t) => t.id));
      if ('track' in changes && !trackIds.has(changes.track)) fail('clip.update: unknown track');
      const merged = normalizeClip({ ...clips[i], ...changes, id: op.id }, trackIds);
      if (!merged) fail('clip.update: invalid values');
      return { type: 'clip.update', id: op.id, changes: assignWithInverse(clips[i], merged) };
    }

    case 'clip.remove': {
      const clips = show.timeline.clips;
      const i = indexById(clips, op.id, 'Clip');
      const [prev] = clips.splice(i, 1);
      return { type: 'clip.add', clip: prev, index: i };
    }

    case 'scene.add': {
      const s = normalizeScene(op.scene);
      if (!s) fail('scene.add: invalid scene');
      if (show.scenes.some((x) => x.id === s.id)) fail(`Scene id "${s.id}" already exists`);
      if (show.scenes.length >= 200) fail('A show can hold at most 200 scenes');
      const index = Number.isInteger(op.index) ? Math.max(0, Math.min(op.index, show.scenes.length)) : show.scenes.length;
      show.scenes.splice(index, 0, s);
      return { type: 'scene.remove', id: s.id };
    }

    case 'scene.update': {
      const i = indexById(show.scenes, op.id, 'Scene');
      const merged = normalizeScene({ ...show.scenes[i], ...changesOf(op), id: op.id });
      return { type: 'scene.update', id: op.id, changes: assignWithInverse(show.scenes[i], merged) };
    }

    case 'scene.remove': {
      const i = indexById(show.scenes, op.id, 'Scene');
      const [prev] = show.scenes.splice(i, 1);
      return { type: 'scene.add', scene: prev, index: i };
    }

    case 'reactive.set': {
      const next = normalizeReactive({ ...show.audioReactive, ...changesOf(op) });
      return { type: 'reactive.set', changes: assignWithInverse(show.audioReactive, next) };
    }

    default:
      return fail(`Unhandled operation "${op.type}"`);
  }
}

/** True when an op changes nothing (e.g. an update whose values already match). */
export function isNoop(inverse) {
  if (!inverse) return true;
  if (inverse.type === 'batch') return inverse.ops.every(isNoop);
  if ('changes' in inverse) return Object.keys(inverse.changes).length === 0;
  return false;
}
