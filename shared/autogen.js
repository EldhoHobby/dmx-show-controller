// Automatic show generation from the song analysis and the stage layout.
//
// A rules engine, not machine learning. Each detected section (intro, groove, build, drop,
// breakdown, outro) is cut into 8-bar phrases, and each phrase gets the look from
// shared/looks.js for its section, its energy and its drums:
//   - the washes pulse on the real kick drum (every beat, half time, or not at all), and
//     chase where there is no steady kick
//   - off-beat hi-hats flick every other wash; snares on 2 and 4 flare the moving heads
//   - colours, chase directions and movement shapes change every phrase, so a long drop
//     does not repeat one look for a minute
//   - louder phrases run brighter; builds brighten, tighten and turn white toward the drop;
//     drum fills at the end of a phrase get a quick chase
// Every clip it creates is ordinary and editable on the timeline afterwards. Shows analysed
// before the drum pattern existed fall back to section-based rhythms.
//
// Uses the physical layout: chases run in stage order (left to right / centre out) from the
// fixtures' X positions, and moving heads aim at the centre point using their 3D mounting.

import { createTempo } from './tempo.js';
import { fixtureRole, profileCaps, resolveProfile } from './fixture-library.js';
import { DEFAULT_TRACKS } from './show.js';
import { NAMED_COLORS as C } from './color.js';
import { clamp, mod, seededRandom, stringHash, uid } from './util.js';
import { COOL, PALETTES, STYLES, labelName, readGroove, sectionLook } from './looks.js';

export { PALETTES, STYLES };

const TRACK = {
  base: 'trk_base',
  rhythm: 'trk_rhythm',
  hats: 'trk_hats',
  beams: 'trk_beams',
  snare: 'trk_snare',
  move: 'trk_move',
  color: 'trk_color',
  accent: 'trk_accent',
};
const PHRASE_BARS = 8;

export function generateShow(show, options = {}) {
  const analysis = show.analysis;
  if (!analysis?.sections?.length) {
    throw new Error('Analyse a song first: the generator needs its sections and beat grid.');
  }
  if (!show.fixtures.length) throw new Error('Patch some fixtures first: there is nothing to light.');

  const style = STYLES[options.style] || STYLES.balanced;
  const seed = options.seed ?? stringHash(`${show.audio?.hash || show.meta.name}:${options.style || 'balanced'}`);
  const rand = seededRandom(seed);
  const tempo = createTempo(show.tempo);
  const bpb = tempo.beatsPerBar;
  const durationMs = show.timeline.durationMs;
  const at = (ms, beats) => tempo.timeAt(tempo.beatAt(ms) + beats);
  const beatLen = (ms) => at(ms, 1) - ms;
  const speed = (beats) => beats / style.speed; // slower styles stretch rhythmic divisions
  const lvl = (v) => clamp(v * style.intensity, 0, 1);

  // ---- Fixture groups ----------------------------------------------------------------
  const groups = { mover: [], wash: [], strobe: [], dimmer: [], pixel: [] };
  const colorIds = [];
  const xOf = new Map();
  for (const f of show.fixtures) {
    const profile = resolveProfile(show, f.profileId);
    if (!profile) continue;
    groups[fixtureRole(profile)].push(f.id);
    if (profileCaps(profile).color) colorIds.push(f.id);
    xOf.set(f.id, f.position.x);
  }
  const movers = groups.mover;
  const pulsers = [...groups.wash, ...groups.dimmer, ...groups.pixel]; // pixel bars chase cell by cell
  const strobes = groups.strobe;
  const everyLight = [...movers, ...pulsers]; // strobe units stay dark except for accents
  const colorFx = colorIds.filter((id) => !strobes.includes(id));
  const strobeTargets = strobes.length ? strobes : style.strobe ? pulsers : [];
  // Every other wash, in stage order, for the off-beat hi-hat flicks.
  const sparkleIds = pulsers
    .slice()
    .sort((a, b) => xOf.get(a) - xOf.get(b))
    .filter((_, i) => i % 2 === 1);

  const clips = [];
  const add = (track, type, start, end, fixtures, params, extra = {}) => {
    const s = Math.max(0, start);
    const e = Math.min(durationMs, end);
    if (!fixtures.length || e - s < 40) return;
    clips.push({ id: uid('clp'), type, track, start: round(s), end: round(e), fadeIn: 0, fadeOut: 0, fixtures: [...fixtures], params, ...extra });
  };

  // ---- Analysis lookups --------------------------------------------------------------
  const drums = analysis.drums || null;
  const beatIndex = (ms) => Math.round(tempo.beatAt(ms));
  const barPos = (i) => mod(Math.round(i - tempo.downbeat), bpb);
  const beatRange = (from, to) => {
    const out = [];
    for (let i = Math.max(0, beatIndex(from)); i < beatIndex(to); i++) out.push(i);
    return out;
  };
  const meanOf = (arr, idx, fallback) => {
    const vals = idx.map((i) => arr?.[i]).filter((v) => Number.isFinite(v));
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : fallback;
  };
  const energyAtBeat = (ms) => analysis.energy?.[beatIndex(ms)] ?? 0.5;
  // A near-silent beat right before a drop gets a blackout so the hit lands harder.
  const silentBefore = (dropStart) => energyAtBeat(dropStart - beatLen(dropStart) / 2) < 0.25;

  // ---- Palettes: each drop gets its own, a build borrows the palette of the drop it leads into.
  const sections = analysis.sections.filter((s) => s.end > s.start && s.start < durationMs);
  const base = Math.floor(rand() * PALETTES.length);
  let dropCount = 0;
  const paletteIdx = sections.map((s, i) => {
    if (s.label === 'drop') return (base + 2 * dropCount++) % PALETTES.length;
    if (s.label === 'breakdown') return COOL[i % 2];
    if (s.label === 'intro' || s.label === 'outro') return base;
    return (base + i) % PALETTES.length;
  });
  sections.forEach((s, i) => {
    if (s.label === 'build' && sections[i + 1]?.label === 'drop') paletteIdx[i] = paletteIdx[i + 1];
  });

  /** Cut a section into 8-bar phrases; a short remainder joins the phrase before it. */
  const phrasesOf = (S, E) => {
    const b0 = tempo.beatAt(S);
    const total = tempo.beatAt(E) - b0;
    const len = PHRASE_BARS * bpb;
    const count = Math.max(1, Math.floor(total / len + 0.5));
    const out = [];
    for (let k = 0; k < count; k++) {
      out.push({ start: k === 0 ? S : tempo.timeAt(b0 + k * len), end: k === count - 1 ? E : tempo.timeAt(b0 + (k + 1) * len) });
    }
    return out;
  };

  /** A drum fill: snares and hi-hats bunch up in the last two beats of a phrase. */
  const hasFill = (from, to) => {
    if (!drums) return false;
    const idx = beatRange(from, to);
    if (idx.length < 8) return false;
    const tail = idx.slice(-2);
    const busy = (list) => meanOf(drums.snare, list, 0) + meanOf(drums.hat, list, 0);
    return busy(tail) >= 0.6 && busy(tail) - busy(idx) >= 0.35;
  };

  sections.forEach((s, i) => {
    const S = s.start;
    const E = Math.min(s.end, durationMs);
    const len = E - S;
    if (len < 200) return;
    const pal = PALETTES[paletteIdx[i]].colors;
    const isLast = i === sections.length - 1;
    const isFirst = i === 0;
    const next = sections[i + 1];
    const flip = rand() < 0.5;
    const beat = beatLen(S);
    const bar = beat * bpb;
    const sectionFadeOut = isLast ? Math.min(len, 2 * bar) : 0;
    const baseFadeIn = isFirst ? Math.min(len / 2, 2 * bar) : s.label === 'breakdown' ? bar : s.label === 'drop' ? 0 : beat;

    if (s.label === 'build') {
      buildSection(s, S, E, pal, { isFirst, beforeDrop: next?.label === 'drop', baseFadeIn });
    } else {
      const phrases = phrasesOf(S, E);
      phrases.forEach((ph, k) => {
        const idx = beatRange(ph.start, ph.end);
        const look = sectionLook(s.label, {
          energy: meanOf(analysis.energy, idx, s.energy),
          phrase: k,
          palette: pal,
          style,
          groove: readGroove(drums, idx, barPos),
          flip,
        });
        const first = k === 0;
        const last = k === phrases.length - 1;
        const fadeOut = last ? sectionFadeOut : 0;
        const name = phrases.length > 1 ? `${labelName(s.label)} ${k + 1}` : labelName(s.label);
        add(TRACK.base, 'static', ph.start, ph.end, everyLight, look.base.params, { name, fadeIn: first ? baseFadeIn : 0, fadeOut });
        if (look.rhythm) {
          const fadeIn = first && (isFirst || s.label === 'intro') ? Math.min(len / 2, 2 * bar) : first && s.label === 'breakdown' ? bar : 0;
          add(TRACK.rhythm, look.rhythm.type, ph.start, ph.end, pulsers, look.rhythm.params, { fadeIn, fadeOut });
        }
        if (look.sparkle) add(TRACK.hats, 'pulse', ph.start, ph.end, sparkleIds, look.sparkle.params, { name: 'Hi-hat flicks', fadeOut });
        if (movers.length) {
          if (look.beams) {
            const chase = look.beams.type === 'chase';
            add(TRACK.beams, look.beams.type, ph.start, ph.end, movers, look.beams.params, { name: chase ? 'Beam chase' : 'Beams on', fadeIn: first && !chase ? beat : 0, fadeOut });
          }
          if (look.backbeat) add(TRACK.snare, 'pulse', ph.start, ph.end, movers, look.backbeat.params, { name: 'Snare flares', fadeOut });
          if (look.move) {
            // Glide between shapes instead of jumping: out over the phrase's last beat, in over
            // the next one's first. A drop starts its movement at once, on the hit.
            const into = next?.label === 'drop' && last;
            add(TRACK.move, 'movement', ph.start, ph.end, movers, look.move.params, {
              fadeIn: first && s.label === 'drop' ? 0 : beat,
              fadeOut: last && isLast ? sectionFadeOut : into ? 0 : beat,
            });
          }
        } else if (look.backbeat && strobes.length) {
          add(TRACK.snare, 'pulse', ph.start, ph.end, strobes, { ...look.backbeat.params, level: lvl(0.5) }, { name: 'Snare flashes', fadeOut });
        }
        if (look.color && colorFx.length) {
          add(TRACK.color, look.color.type, ph.start, ph.end, colorFx, look.color.params, { fadeIn: first && s.label === 'breakdown' ? bar : 0 });
        }
        // A drum fill closing a phrase gets a quick chase across the rig, unless a drop or
        // the end of the song follows (those have their own treatment).
        const closesIntoDrop = last && next?.label === 'drop';
        if (!closesIntoDrop && !(last && isLast) && hasFill(ph.start, ph.end)) {
          const fillStart = at(ph.end, -1);
          add(TRACK.accent, 'chase', fillStart, ph.end, everyLight, { step: 0.25, direction: flip ? 'backward' : 'forward', width: 1, tail: 1, level: lvl(1), order: 'x', dimmerMode: 'htp' }, { name: 'Fill' });
        }
      });
    }

    // Accents around drops.
    if (s.label === 'drop') {
      add(TRACK.accent, 'static', S, S + 2 * beat, everyLight, { dimmer: 1, dimmerMode: 'htp', color: C.white }, { name: 'Drop hit', fadeOut: 1.5 * beat });
      if (strobes.length) add(TRACK.accent, 'strobe', S, at(S, bpb), strobes, { rate: 0.85, level: 1 }, { name: 'Drop strobe' });
      if (silentBefore(S)) {
        add(TRACK.accent, 'static', S - beat, S, [...everyLight, ...strobes], { dimmer: 0, dimmerMode: 'set' }, { name: 'Pre-drop blackout' });
      }
    }
  });

  /**
   * A build-up: the chase speeds up (every beat, then half and quarter beats), the rig
   * brightens and the beams tighten, the moving heads tilt faster, and when a drop follows,
   * the colour runs to white over the last bar while the strobes come in.
   */
  function buildSection(s, S, E, pal, { isFirst, beforeDrop, baseFadeIn }) {
    const bar = beatLen(S) * bpb;
    const look = sectionLook('build', { energy: s.energy, palette: pal, style, groove: readGroove(drums, beatRange(S, E), barPos) });
    // Keyframe times are relative to the clip as stored (rounded), and must stay inside it.
    const len = Math.floor(round(E) - round(S));
    let color = [{ t: 0, v: pal[0] }];
    if (beforeDrop && len > bar + 1) color = [{ t: 0, v: pal[0] }, { t: Math.round(len - bar), v: pal[0] }, { t: len, v: C.white }];
    else if (beforeDrop) color = [{ t: 0, v: pal[0] }, { t: len, v: C.white }];
    const keys = {
      dimmer: [{ t: 0, v: lvl(0.25) }, { t: len, v: lvl(0.6) }],
      color,
      zoom: [{ t: 0, v: 0.5 }, { t: len, v: 0.2 }],
    };
    add(TRACK.base, 'keyframes', S, E, everyLight, { keys, dimmerMode: 'htp' }, { name: 'Build-up', fadeIn: isFirst ? baseFadeIn : 0 });

    const total = tempo.beatAt(E) - tempo.beatAt(S);
    const m1 = at(S, total * 0.5);
    const m2 = at(S, total * 0.75);
    const chase = (from, to, step, level, extra) => add(TRACK.rhythm, 'chase', from, to, pulsers, { step, direction: 'forward', width: 1, tail: 1, level, order: 'x', dimmerMode: 'htp', ...extra });
    chase(S, m1, speed(1), lvl(0.7));
    chase(m1, m2, speed(0.5), lvl(0.85), { direction: 'bounce' });
    chase(m2, E, speed(0.25), lvl(1), { width: 2, tail: 0, order: 'center' });

    if (movers.length) {
      if (look.beams) add(TRACK.beams, 'static', S, E, movers, look.beams.params, { name: 'Beams on', fadeIn: beatLen(S) });
      const m = style.movement;
      const mid = at(S, total * 0.5);
      add(TRACK.move, 'movement', S, mid, movers, { shape: 'tilt', cycle: speed(4), sizePan: 0, sizeTilt: 15 * m, spread: 0.25, center: 'aim', order: 'x' }, { fadeIn: beatLen(S) });
      add(TRACK.move, 'movement', mid, E, movers, { shape: 'tilt', cycle: speed(2), sizePan: 0, sizeTilt: 25 * m, spread: 0.25, center: 'aim', order: 'x' });
    }

    if (beforeDrop && strobeTargets.length) {
      const lastBar = at(E, -bpb);
      const halfBar = at(E, -bpb / 2);
      // Stop before the pre-drop blackout beat, if there is one, so the two never overlap.
      const strobeEnd = at(E, silentBefore(E) ? -1 : -0.5);
      add(TRACK.accent, 'strobe', lastBar, halfBar, strobeTargets, { rate: 0.55, level: lvl(0.8) }, { name: 'Build strobe' });
      add(TRACK.accent, 'strobe', halfBar, strobeEnd, strobeTargets, { rate: 1, level: lvl(1) }, { name: 'Build strobe' });
    }
  }

  return {
    durationMs,
    tracks: DEFAULT_TRACKS.map((t) => ({ ...t, muted: false })),
    clips,
  };
}

const round = (v) => Math.round(v * 10) / 10;
