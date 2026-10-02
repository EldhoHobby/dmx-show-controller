// Automatic show generation from the song analysis and the stage layout.
//
// This is a rules engine, not machine learning: each detected section (intro, groove, build,
// drop, breakdown, outro) gets a look, a rhythm, a movement and colour treatment scaled by its
// energy, laid out on five layer tracks. It is meant to produce a strong first draft quickly;
// every clip it creates is ordinary and editable on the timeline afterwards.
//
// Uses the physical layout: chases run in stage order (left to right / centre out) from the
// fixtures' X positions, and moving heads aim at the audience point using their 3D mounting.

import { createTempo } from './tempo.js';
import { fixtureRole, profileCaps, resolveProfile } from './fixture-library.js';
import { DEFAULT_TRACKS } from './show.js';
import { NAMED_COLORS as C } from './color.js';
import { clamp, seededRandom, stringHash, uid } from './util.js';

export const PALETTES = [
  { name: 'Ocean', colors: [C.blue, C.cyan, C.white] },
  { name: 'Sunset', colors: [C.red, C.orange, C.amber] },
  { name: 'Neon', colors: [C.magenta, C.cyan, C.violet] },
  { name: 'Forest', colors: [C.green, C.lime, C.cyan] },
  { name: 'Royal', colors: [C.violet, C.blue, C.pink] },
  { name: 'Fire', colors: [C.red, C.amber, C.white] },
];
const COOL = [0, 4];

export const STYLES = {
  calm: { label: 'Calm', intensity: 0.75, speed: 0.5, movement: 0.6, strobe: false, rainbow: false },
  balanced: { label: 'Balanced', intensity: 0.9, speed: 1, movement: 1, strobe: true, rainbow: false },
  energetic: { label: 'Energetic', intensity: 1, speed: 1, movement: 1.3, strobe: true, rainbow: true },
};

const TRACK = { base: 'trk_base', rhythm: 'trk_rhythm', beams: 'trk_beams', move: 'trk_move', color: 'trk_color', accent: 'trk_accent' };

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
  const durationMs = show.timeline.durationMs;
  const at = (ms, beats) => tempo.timeAt(tempo.beatAt(ms) + beats);
  const beatLen = (ms) => at(ms, 1) - ms;
  const speed = (beats) => beats / style.speed; // slower styles stretch rhythmic divisions

  // ---- Fixture groups ----------------------------------------------------------------
  const groups = { mover: [], wash: [], strobe: [], dimmer: [] };
  const colorIds = [];
  for (const f of show.fixtures) {
    const profile = resolveProfile(show, f.profileId);
    if (!profile) continue;
    groups[fixtureRole(profile)].push(f.id);
    if (profileCaps(profile).color) colorIds.push(f.id);
  }
  const movers = groups.mover;
  const pulsers = [...groups.wash, ...groups.dimmer];
  const strobes = groups.strobe;
  const everyLight = [...movers, ...pulsers]; // strobe units stay dark except for accents
  const colorFx = colorIds.filter((id) => !strobes.includes(id));
  const strobeTargets = strobes.length ? strobes : style.strobe ? pulsers : [];

  const clips = [];
  const add = (track, type, start, end, fixtures, params, extra = {}) => {
    const s = Math.max(0, start);
    const e = Math.min(durationMs, end);
    if (!fixtures.length || e - s < 40) return;
    clips.push({ id: uid('clp'), type, track, start: round(s), end: round(e), fadeIn: 0, fadeOut: 0, fixtures: [...fixtures], params, ...extra });
  };

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

  const energyAtBeat = (ms) => {
    const idx = Math.round(tempo.beatAt(ms));
    return analysis.energy?.[idx] ?? 0.5;
  };
  // A near-silent beat right before a drop gets a blackout so the hit lands harder.
  const silentBefore = (dropStart) => energyAtBeat(dropStart - beatLen(dropStart) / 2) < 0.25;

  sections.forEach((s, i) => {
    const S = s.start;
    const E = Math.min(s.end, durationMs);
    const len = E - S;
    if (len < 200) return;
    const pal = PALETTES[paletteIdx[i]].colors;
    const e = clamp(s.energy, 0, 1);
    const lvl = (v) => clamp(v * style.intensity, 0, 1);
    const isLast = i === sections.length - 1;
    const isFirst = i === 0;
    const flip = rand() < 0.5;
    const bar = beatLen(S) * tempo.beatsPerBar;
    const sectionFadeOut = isLast ? Math.min(len, 2 * bar) : 0;

    // 1. Base look: the colour and an intensity floor everything else plays on top of.
    const baseDim = { intro: 0.3, groove: 0.3, build: 0.25, drop: 0.2, high: 0.3, breakdown: 0.5, low: 0.35, outro: 0.3 }[s.label] ?? 0.3;
    const zoom = { drop: 0.15, high: 0.3, breakdown: 0.85, intro: 0.7 }[s.label] ?? 0.5;
    add(TRACK.base, 'static', S, E, everyLight, {
      dimmer: lvl(baseDim),
      dimmerMode: 'htp',
      color: pal[0],
      position: 'aim',
      zoom,
    }, {
      name: labelName(s.label),
      fadeIn: isFirst ? Math.min(len / 2, 2 * bar) : s.label === 'breakdown' ? bar : s.label === 'drop' ? 0 : beatLen(S),
      fadeOut: sectionFadeOut,
    });

    // 2. Rhythm: how the intensity moves with the beat.
    const rhythm = (fixtures) => {
      switch (s.label) {
        case 'intro':
          add(TRACK.rhythm, 'pulse', S, E, fixtures, { division: 4, decay: 0.9, level: lvl(0.5), spread: 0.5, order: 'x', dimmerMode: 'htp' }, { fadeIn: Math.min(len / 2, 2 * bar), fadeOut: sectionFadeOut });
          break;
        case 'groove':
        case 'low':
          add(TRACK.rhythm, 'chase', S, E, fixtures, {
            step: speed(1), direction: flip ? 'forward' : 'backward', width: 1, tail: 1, level: lvl(s.label === 'low' ? 0.6 : 0.9), order: 'x', dimmerMode: 'htp',
          }, { fadeOut: sectionFadeOut });
          break;
        case 'build': {
          // Accelerate: 1 beat, then 1/2, then 1/4 for the final stretch.
          const m1 = at(S, (tempo.beatAt(E) - tempo.beatAt(S)) * 0.5);
          const m2 = at(S, (tempo.beatAt(E) - tempo.beatAt(S)) * 0.75);
          add(TRACK.rhythm, 'chase', S, m1, fixtures, { step: speed(1), direction: 'forward', width: 1, tail: 1, level: lvl(0.7), order: 'x', dimmerMode: 'htp' });
          add(TRACK.rhythm, 'chase', m1, m2, fixtures, { step: speed(0.5), direction: 'bounce', width: 1, tail: 1, level: lvl(0.85), order: 'x', dimmerMode: 'htp' });
          add(TRACK.rhythm, 'chase', m2, E, fixtures, { step: speed(0.25), direction: 'forward', width: 2, tail: 0, level: lvl(1), order: 'center', dimmerMode: 'htp' });
          break;
        }
        case 'drop':
        case 'high':
          add(TRACK.rhythm, 'pulse', S, E, fixtures, { division: speed(1), decay: s.label === 'drop' ? 0.5 : 0.7, level: lvl(1), spread: 0, order: 'x', dimmerMode: 'htp' }, { fadeOut: sectionFadeOut });
          break;
        case 'breakdown':
          add(TRACK.rhythm, 'pulse', S, E, fixtures, { division: 8, decay: 1, level: lvl(0.6), spread: 1, order: 'x', dimmerMode: 'htp' }, { fadeIn: bar });
          break;
        case 'outro':
          add(TRACK.rhythm, 'chase', S, E, fixtures, { step: speed(2), direction: 'forward', width: 1, tail: 2, level: lvl(0.7), order: 'x', dimmerMode: 'htp' }, { fadeOut: sectionFadeOut });
          break;
        default:
          break;
      }
    };
    rhythm(pulsers);

    // Moving heads: beams on for the musical sections, chasing in the big moments.
    if (movers.length) {
      if (s.label === 'drop' || s.label === 'high') {
        add(TRACK.beams, 'chase', S, E, movers, { step: speed(0.5), direction: 'bounce', width: 1, tail: 2, level: lvl(1), order: 'x', dimmerMode: 'htp' }, { name: 'Beam chase', fadeOut: sectionFadeOut });
      } else if (s.label !== 'intro') {
        const moverDim = { groove: 0.7, build: 0.6, breakdown: 0.5, low: 0.5, outro: 0.5 }[s.label] ?? 0.6;
        add(TRACK.beams, 'static', S, E, movers, { dimmer: lvl(moverDim), dimmerMode: 'htp' }, { name: 'Beams on', fadeIn: beatLen(S), fadeOut: sectionFadeOut });
      }

      // 3. Movement around the audience point.
      const m = style.movement;
      const moves = {
        intro: { shape: 'sweep', cycle: 32, sizePan: 20, sizeTilt: 0, spread: 0.5 },
        groove: { shape: 'circle', cycle: speed(8), sizePan: 25, sizeTilt: 15, spread: 0.25 },
        low: { shape: 'circle', cycle: speed(16), sizePan: 15, sizeTilt: 10, spread: 0.25 },
        drop: { shape: 'figure8', cycle: speed(4), sizePan: 40, sizeTilt: 20, spread: 0.5 },
        high: { shape: 'ballyhoo', cycle: speed(8), sizePan: 35, sizeTilt: 20, spread: 0.33 },
        breakdown: { shape: 'sweep', cycle: 16, sizePan: 30, sizeTilt: 5, spread: 1 },
        outro: { shape: 'sweep', cycle: 16, sizePan: 20, sizeTilt: 5, spread: 0.5 },
      };
      if (s.label === 'build') {
        const mid = at(S, (tempo.beatAt(E) - tempo.beatAt(S)) * 0.5);
        add(TRACK.move, 'movement', S, mid, movers, { shape: 'tilt', cycle: speed(4), sizePan: 0, sizeTilt: 15 * m, spread: 0.25, center: 'aim', order: 'x' });
        add(TRACK.move, 'movement', mid, E, movers, { shape: 'tilt', cycle: speed(2), sizePan: 0, sizeTilt: 25 * m, spread: 0.25, center: 'aim', order: 'x' });
      } else if (moves[s.label]) {
        const mv = moves[s.label];
        add(TRACK.move, 'movement', S, E, movers, { ...mv, sizePan: mv.sizePan * m, sizeTilt: mv.sizeTilt * m, center: 'aim', order: 'x' }, { fadeIn: s.label === 'drop' ? 0 : beatLen(S) });
      }
    }

    // 4. Colour effects.
    if (colorFx.length) {
      if (s.label === 'drop') {
        const half = style.rainbow && len > 16 * beatLen(S) ? at(S, (tempo.beatAt(E) - tempo.beatAt(S)) / 2) : E;
        add(TRACK.color, 'colorStep', S, half, colorFx, { colors: [pal[0], pal[1]], step: speed(4), alternate: 1, order: 'x' });
        if (half < E) add(TRACK.color, 'colorCycle', half, E, colorFx, { cycle: speed(16), spread: 0.5, saturation: 1, order: 'x' });
      } else if (s.label === 'high') {
        add(TRACK.color, 'colorStep', S, E, colorFx, { colors: [pal[0], pal[2]], step: speed(2), alternate: 1, order: 'x' });
      } else if (s.label === 'groove') {
        add(TRACK.color, 'colorStep', S, E, colorFx, { colors: [pal[0], pal[1]], step: speed(8), alternate: 0, order: 'x' });
      } else if (s.label === 'breakdown') {
        add(TRACK.color, 'colorCycle', S, E, colorFx, { cycle: 32, spread: 0.3, saturation: 0.8, order: 'x' }, { fadeIn: bar });
      }
    }

    // 5. Accents around drops.
    if (s.label === 'drop') {
      const b = beatLen(S);
      add(TRACK.accent, 'static', S, S + 2 * b, everyLight, { dimmer: 1, dimmerMode: 'htp', color: C.white }, { name: 'Drop hit', fadeOut: 1.5 * b });
      if (strobes.length) add(TRACK.accent, 'strobe', S, at(S, tempo.beatsPerBar), strobes, { rate: 0.85, level: 1 }, { name: 'Drop strobe' });
      if (silentBefore(S)) {
        add(TRACK.accent, 'static', S - b, S, [...everyLight, ...strobes], { dimmer: 0, dimmerMode: 'set' }, { name: 'Pre-drop blackout' });
      }
    }
    if (s.label === 'build' && strobeTargets.length && sections[i + 1]?.label === 'drop') {
      const lastBar = at(E, -tempo.beatsPerBar);
      const halfBar = at(E, -tempo.beatsPerBar / 2);
      // Stop before the pre-drop blackout beat, if there is one, so the two never overlap.
      const strobeEnd = at(E, silentBefore(E) ? -1 : -0.5);
      add(TRACK.accent, 'strobe', lastBar, halfBar, strobeTargets, { rate: 0.55, level: lvl(0.8) }, { name: 'Build strobe' });
      add(TRACK.accent, 'strobe', halfBar, strobeEnd, strobeTargets, { rate: 1, level: lvl(1) }, { name: 'Build strobe' });
    }
  });

  return {
    durationMs,
    tracks: DEFAULT_TRACKS.map((t) => ({ ...t, muted: false })),
    clips,
  };
}

function labelName(label) {
  return { intro: 'Intro', groove: 'Groove', build: 'Build-up', drop: 'Drop', high: 'High', breakdown: 'Breakdown', low: 'Low', outro: 'Outro' }[label] || label;
}

const round = (v) => Math.round(v * 10) / 10;
