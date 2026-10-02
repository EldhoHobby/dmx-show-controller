// Section looks: what each part of a song looks like. Shared by the song-file generator
// (shared/autogen.js), which lays them out as timeline clips, and the live auto show
// (shared/live-show.js), which plays them straight from the live beat clock, so a drop, a
// build or a breakdown is lit the same way in both.
//
// A look is a set of layers, each one ordinary clip parameters (see clip-types.js) or null:
//   base      static look on every light: colour, intensity floor, beam size, aim
//   rhythm    intensity movement of the colour washes (pulse on the kick, chase...)
//   sparkle   off-beat flicks on every other wash, where the music has off-beat hi-hats
//   beams     moving-head intensity (static or a beam chase)
//   backbeat  moving-head flares on beats 2 and 4, where the music has a backbeat
//   move      moving-head movement around the centre point
//   color     colour effect on the colour-capable fixtures
// Times inside params are in beats.

import { NAMED_COLORS as C } from './color.js';
import { clamp } from './util.js';

export const PALETTES = [
  { name: 'Ocean', colors: [C.blue, C.cyan, C.white] },
  { name: 'Sunset', colors: [C.red, C.orange, C.amber] },
  { name: 'Neon', colors: [C.magenta, C.cyan, C.violet] },
  { name: 'Forest', colors: [C.green, C.lime, C.cyan] },
  { name: 'Royal', colors: [C.violet, C.blue, C.pink] },
  { name: 'Fire', colors: [C.red, C.amber, C.white] },
];
/** Calm palettes for breakdowns. */
export const COOL = [0, 4];

export const STYLES = {
  calm: { label: 'Calm', intensity: 0.75, speed: 0.5, movement: 0.6, strobe: false, rainbow: false, sparkle: false },
  balanced: { label: 'Balanced', intensity: 0.9, speed: 1, movement: 1, strobe: true, rainbow: false, sparkle: true },
  energetic: { label: 'Energetic', intensity: 1, speed: 1, movement: 1.3, strobe: true, rainbow: true, sparkle: true },
};

export const LABELS = ['intro', 'groove', 'build', 'drop', 'high', 'breakdown', 'low', 'outro'];

export function labelName(label) {
  return { intro: 'Intro', groove: 'Groove', build: 'Build-up', drop: 'Drop', high: 'High', breakdown: 'Breakdown', low: 'Low', outro: 'Outro' }[label] || label;
}

// ---- Reading the groove ----------------------------------------------------------------

/**
 * What the drums do over a stretch of beats, from the analysis' per-beat drum pattern.
 *   kick      'four' (every beat), 'half' (beats 1 and 3), 'one' (bar downbeats), 'broken'
 *             (kicks, but not on a steady grid) or 'none'
 *   backbeat  snares or claps on beats 2 and 4
 *   hats      hi-hats on the off-beats
 * Returns null when the analysis has no drum pattern (shows analysed before version 2).
 * @param drums    { kick, snare, hat } arrays, one value 0..1 per beat
 * @param beats    beat indexes to look at
 * @param barPos   beat index -> position in the bar, 0..3
 */
export function readGroove(drums, beats, barPos) {
  if (!drums?.kick?.length || !beats.length) return null;
  const at = (arr, i) => arr?.[i] ?? 0;
  const byPos = [[], [], [], []];
  let kicks = 0;
  for (const i of beats) {
    const hit = at(drums.kick, i) >= 0.3;
    if (hit) kicks++;
    byPos[barPos(i)].push(hit ? 1 : 0);
  }
  const rate = kicks / beats.length;
  const posRate = byPos.map((list) => (list.length ? list.reduce((s, v) => s + v, 0) / list.length : 0));
  let kick = 'broken';
  if (rate < 0.15) kick = 'none';
  else if (rate >= 0.75) kick = 'four';
  else if (posRate[0] >= 0.6 && posRate[2] >= 0.6 && posRate[1] < 0.3 && posRate[3] < 0.3) kick = 'half';
  else if (posRate[0] >= 0.6 && posRate[1] < 0.3 && posRate[2] < 0.3 && posRate[3] < 0.3) kick = 'one';
  const mean = (list) => (list.length ? list.reduce((s, v) => s + v, 0) / list.length : 0);
  const snareOn = mean(beats.filter((i) => barPos(i) % 2 === 1).map((i) => at(drums.snare, i)));
  const snareOff = mean(beats.filter((i) => barPos(i) % 2 === 0).map((i) => at(drums.snare, i)));
  const backbeat = snareOn >= 0.25 && snareOn >= 2.5 * snareOff + 0.02;
  const hats = mean(beats.map((i) => at(drums.hat, i))) >= 0.25;
  return { kick, backbeat, hats, kickRate: rate };
}

// ---- The looks ---------------------------------------------------------------------------

const BASE_DIM = { intro: 0.3, groove: 0.3, build: 0.25, drop: 0.2, high: 0.3, breakdown: 0.5, low: 0.35, outro: 0.3 };
const ZOOM = { drop: 0.15, high: 0.3, breakdown: 0.85, intro: 0.7 };
const MOVER_DIM = { groove: 0.7, build: 0.6, breakdown: 0.5, low: 0.5, outro: 0.5 };
const MOVES = {
  intro: [{ shape: 'sweep', cycle: 32, sizePan: 20, sizeTilt: 0, spread: 0.5 }],
  groove: [
    { shape: 'circle', cycle: 8, sizePan: 25, sizeTilt: 15, spread: 0.25 },
    { shape: 'figure8', cycle: 8, sizePan: 25, sizeTilt: 12, spread: 0.5 },
  ],
  low: [{ shape: 'circle', cycle: 16, sizePan: 15, sizeTilt: 10, spread: 0.25 }],
  drop: [
    { shape: 'figure8', cycle: 4, sizePan: 40, sizeTilt: 20, spread: 0.5 },
    { shape: 'ballyhoo', cycle: 8, sizePan: 35, sizeTilt: 20, spread: 0.33 },
    { shape: 'circle', cycle: 4, sizePan: 35, sizeTilt: 25, spread: 0.25 },
  ],
  high: [
    { shape: 'ballyhoo', cycle: 8, sizePan: 35, sizeTilt: 20, spread: 0.33 },
    { shape: 'figure8', cycle: 8, sizePan: 35, sizeTilt: 15, spread: 0.5 },
  ],
  breakdown: [
    { shape: 'sweep', cycle: 16, sizePan: 30, sizeTilt: 5, spread: 1 },
    { shape: 'sweep', cycle: 16, sizePan: 30, sizeTilt: 5, spread: 0 },
  ],
  outro: [{ shape: 'sweep', cycle: 16, sizePan: 20, sizeTilt: 5, spread: 0.5 }],
  build: [{ shape: 'tilt', cycle: 4, sizePan: 0, sizeTilt: 15, spread: 0.25 }],
};
const CHASE_DIRECTIONS = ['forward', 'backward', 'bounce', 'forward'];
const pick = (list, i) => list[((i % list.length) + list.length) % list.length];

/**
 * The look for one phrase (8 bars) of a section.
 * @param label  section label
 * @param o      { energy 0..1, phrase index, palette [3 colours], style (STYLES entry),
 *                 groove (readGroove result or null), flip (bool, mirrors chase directions) }
 */
export function sectionLook(label, o = {}) {
  const style = o.style || STYLES.balanced;
  const pal = o.palette || PALETTES[0].colors;
  const p = o.phrase || 0;
  const g = o.groove || null;
  const speed = (beats) => beats / style.speed;
  // Louder phrases of a section run a little brighter, quieter ones a little dimmer.
  const lift = clamp(0.8 + 0.4 * clamp(o.energy ?? 0.5, 0, 1), 0.75, 1.1);
  const lvl = (v) => clamp(v * style.intensity, 0, 1);
  const lvlE = (v) => clamp(v * style.intensity * lift, 0, 1);
  const energetic = label === 'drop' || label === 'high';
  const look = { base: null, rhythm: null, sparkle: null, beams: null, backbeat: null, move: null, color: null };

  // Base: colour and an intensity floor. Energetic sections swap colours every phrase.
  const baseColor = label === 'groove' || energetic ? pick(pal, p) : pal[0];
  look.base = { type: 'static', params: { dimmer: lvl(BASE_DIM[label] ?? 0.3), dimmerMode: 'htp', color: baseColor, position: 'aim', zoom: ZOOM[label] ?? 0.5 } };

  // Rhythm on the washes: follow the kick drum where there is one.
  const kick = g?.kick ?? null;
  const dir = pick(CHASE_DIRECTIONS, p + (o.flip ? 1 : 0));
  const pulse = (division, decay, level, extra = {}) => ({ type: 'pulse', params: { division, decay, level, spread: 0, order: 'x', dimmerMode: 'htp', ...extra } });
  const chase = (step, level, extra = {}) => ({ type: 'chase', params: { step, direction: dir, width: 1, tail: 1, level, order: 'x', dimmerMode: 'htp', ...extra } });
  const breathe = (level) => pulse(8, 1, level, { spread: 1 });
  switch (label) {
    case 'intro':
      look.rhythm = kick === 'four' ? pulse(1, 0.6, lvlE(0.5)) : pulse(4, 0.9, lvlE(0.5), { spread: 0.5 });
      break;
    case 'groove':
    case 'low': {
      const level = lvlE(label === 'low' ? 0.6 : 0.9);
      if (kick === null) look.rhythm = chase(speed(1), level);
      else if (kick === 'four') look.rhythm = p % 2 ? pulse(1, 0.7, level, { spread: p % 4 === 3 ? 0.5 : 0 }) : chase(speed(1), level);
      else if (kick === 'half') look.rhythm = pulse(2, 0.6, level);
      else if (kick === 'one') look.rhythm = pulse(4, 0.6, level);
      else if (kick === 'broken') look.rhythm = chase(speed(1), level);
      else look.rhythm = chase(speed(2), lvlE(0.6));
      break;
    }
    case 'drop':
    case 'high': {
      const decay = label === 'drop' ? 0.5 : 0.7;
      if (kick === 'half') look.rhythm = pulse(2, 0.6, lvlE(1));
      else if (kick === 'one') look.rhythm = pulse(4, 0.6, lvlE(1));
      else if (kick === 'none' || kick === 'broken') look.rhythm = chase(speed(0.5), lvlE(1), { tail: 2 });
      else look.rhythm = pulse(speed(1), decay, lvlE(1), { spread: pick([0, 0, 0.5, 0.25], p) });
      break;
    }
    case 'breakdown':
      look.rhythm = kick === 'four' ? pulse(2, 0.8, lvlE(0.6)) : breathe(lvlE(0.6));
      break;
    case 'outro':
      look.rhythm = kick === 'four' ? pulse(1, 0.7, lvlE(0.7)) : chase(speed(2), lvlE(0.7), { tail: 2 });
      break;
    case 'build':
      look.rhythm = chase(speed(1), lvlE(0.7), { direction: 'forward' });
      break;
    default:
      break;
  }

  // Off-beat hi-hats: quick flicks on every other wash, between the kick pulses.
  if (g?.hats && style.sparkle && (label === 'groove' || energetic)) {
    look.sparkle = pulse(1, 0.25, lvlE(energetic ? 0.45 : 0.35), { offset: 0.5 });
  }

  // Moving heads.
  if (energetic) {
    look.beams = p % 2
      ? { type: 'chase', params: { step: speed(0.25), direction: 'forward', width: 1, tail: 1, level: lvlE(1), order: 'center', dimmerMode: 'htp' } }
      : { type: 'chase', params: { step: speed(0.5), direction: 'bounce', width: 1, tail: 2, level: lvlE(1), order: 'x', dimmerMode: 'htp' } };
  } else if (label !== 'intro') {
    look.beams = { type: 'static', params: { dimmer: lvlE(MOVER_DIM[label] ?? 0.6), dimmerMode: 'htp' } };
  }
  if (g?.backbeat && (label === 'groove' || energetic)) {
    look.backbeat = pulse(2, 0.35, lvlE(1), { offset: 1 });
  }
  const mv = MOVES[label] ? pick(MOVES[label], p) : null;
  if (mv) {
    const cycle = label === 'intro' || label === 'breakdown' || label === 'outro' ? mv.cycle : speed(mv.cycle);
    look.move = { type: 'movement', params: { ...mv, cycle, sizePan: mv.sizePan * style.movement, sizeTilt: mv.sizeTilt * style.movement, center: 'aim', order: 'x' } };
  }

  // Colour effects.
  if (label === 'drop') {
    look.color = style.rainbow && p % 2 === 1
      ? { type: 'colorCycle', params: { cycle: speed(16), spread: 0.5, saturation: 1, order: 'x' } }
      : { type: 'colorStep', params: { colors: [pick(pal, p), pick(pal, p + 1)], step: speed(p % 2 ? 2 : 4), alternate: 1, order: 'x' } };
  } else if (label === 'high') {
    look.color = { type: 'colorStep', params: { colors: [pal[0], pal[2]], step: speed(2), alternate: 1, order: 'x' } };
  } else if (label === 'groove') {
    look.color = { type: 'colorStep', params: { colors: [pick(pal, p), pick(pal, p + 1)], step: speed(8), alternate: 0, order: 'x' } };
  } else if (label === 'breakdown') {
    look.color = { type: 'colorCycle', params: { cycle: 32, spread: 0.3, saturation: 0.8, order: 'x' } };
  }
  return look;
}
