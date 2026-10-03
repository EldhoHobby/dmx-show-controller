// The live auto show: the song generator's looks (shared/looks.js), played from the live
// beat clock and song part (shared/analysis/live-tracker.js) instead of a timeline.
//
// livePlan() decides what to show at an instant; evaluate.js draws it with the same effect
// code as timeline clips. Rhythm that has to be tight follows the actual hits (kick pulses,
// snare flares, hi-hat flicks fire on the drum itself); chases, colour steps and movement run
// on the beat clock, so they keep time through breakdowns with no kick to follow.

import { COOL, PALETTES, STYLES, sectionLook } from './looks.js';
import { liveBeat, LIVE_PHRASE_BEATS } from './analysis/live-tracker.js';
import { clamp } from './util.js';

const LABEL = { quiet: 'intro', groove: 'groove', build: 'build', drop: 'drop', high: 'high', breakdown: 'breakdown' };

/**
 * What the auto show plays at engine time `now`.
 * @param auto   tracker snapshot (reactive.auto)
 * @param opts   { style: STYLES key, seed: palette offset for this show }
 */
export function livePlan(auto, { style = 'balanced', seed = 0 } = {}, now) {
  const st = STYLES[style] || STYLES.balanced;
  const section = auto?.section || 'quiet'; // no input yet counts as quiet
  const label = LABEL[section] || 'intro';
  const beatMs = auto?.period > 0 ? auto.period : 500;
  const beat = liveBeat(auto, now) ?? now / beatMs;
  const inSection = Math.max(0, beat - (auto?.sectionBeat ?? 0));
  const phrase = Math.floor(inSection / LIVE_PHRASE_BEATS);
  const drops = auto?.drops || 0;
  // A new palette for every drop; calm ones for breakdowns and while waiting for music.
  const paletteIndex = label === 'breakdown' || label === 'intro'
    ? COOL[drops % 2]
    : (seed + 2 * drops + (label === 'groove' ? 1 : 0)) % PALETTES.length;
  // Quantized so it can go in the cache key below without rebuilding the look every frame.
  // Twelve steps is finer than the eye reads across the 0.8..1.2 brightness lift it drives.
  const energy = Math.round(clamp(auto?.energy ?? 0.6, 0, 1) * 12) / 12;
  const look = sectionLook(label, {
    energy,
    phrase,
    palette: PALETTES[paletteIndex].colors,
    style: st,
    groove: auto?.groove || null,
  });
  if (section === 'quiet') {
    // Waiting for music: a dim base look and nothing moving to the beat.
    look.rhythm = look.sparkle = look.backbeat = null;
    look.base.params = { ...look.base.params, dimmer: look.base.params.dimmer * 0.6 };
  }
  const g = auto?.groove;
  const plan = {
    label,
    phrase,
    paletteIndex,
    look,
    beat,
    beatMs,
    // Cache key for the prepared layers: everything the look depends on. Energy belongs here
    // because sectionLook scales every layer's level by it — leaving it out froze the
    // brightness at whichever energy happened to arrive first in the phrase.
    key: `${style}|${label}|${phrase % 12}|${paletteIndex}|${g ? `${g.kick}${g.backbeat ? 'b' : ''}${g.hats ? 'h' : ''}` : '-'}|${section === 'quiet' ? 'q' : ''}|${energy}`,
    // A new part fades in over a beat; a drop cuts in on the hit.
    alpha: label === 'drop' ? 1 : clamp((now - (auto?.sectionSince ?? -Infinity)) / beatMs, 0, 1),
    // Pulses on the washes follow the real kick when the look pulses on every beat.
    kickPulse: look.rhythm?.type === 'pulse' && look.rhythm.params.division <= 1 && !look.rhythm.params.offset,
    dropHit: 0,
    dropStrobe: false,
    kickBack: 0,
    build: null,
  };
  if (label === 'build') {
    // The chase speeds up with the snare roll, the rig brightens over 8 bars, and the
    // strobes join when the roll reaches 16th notes.
    const roll = auto?.roll || 0;
    plan.build = {
      step: (roll >= 3 ? 0.25 : roll >= 1.5 ? 0.5 : 1) / st.speed,
      level: clamp(0.25 + 0.35 * (inSection / 32), 0.25, 0.6) * st.intensity,
      strobe: roll >= 3 && st.strobe,
    };
  }
  if (auto?.dropAt != null) {
    const since = now - auto.dropAt;
    if (since >= 0 && since < 2 * beatMs) plan.dropHit = (1 - since / (2 * beatMs)) ** 1.5;
    if (since >= 0 && since < 4 * beatMs && st.strobe) plan.dropStrobe = true;
  }
  if (auto?.returnAt != null) {
    const since = now - auto.returnAt;
    if (since >= 0 && since < beatMs) plan.kickBack = 0.7 * (1 - since / beatMs) ** 2;
  }
  return plan;
}

export const LIVE_STYLES = Object.keys(STYLES);
