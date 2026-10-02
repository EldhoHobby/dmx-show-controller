// Live beat clock and song-part tracking, from the hits of the live detector.
//
// The engine feeds it every hit the live-audio input reports (kick, snare, hi-hat), stamped
// on the engine clock, and the band levels. It keeps:
//   - a beat clock: the tempo from the gaps between kicks, its phase pulled toward each kick
//     (a phase-locked loop), running on through breakdowns when the kick stops
//   - bars and phrases: a drop starts bar 1 of an 8-bar phrase; snares landing on 2 and 4
//     settle which beats are 1 and 3 until then
//   - the part of the song, as it happens: groove (a steady kick), breakdown (the kick
//     stops), build (a snare roll: 1.5 or more snares a beat), drop (the kick comes back
//     after a breakdown or build, or the roll stops while it plays), high (a drop that has
//     run 16 bars), quiet (no input)
//   - what the drums do right now: kick pattern, backbeat, off-beat hi-hats
// snapshot() is plain data: the engine broadcasts it, and every window works out the same
// beat from it with liveBeat().

const MIN_PERIOD = 60000 / 180;
const MAX_PERIOD = 60000 / 80;
const PHRASE = 32;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const mod = (n, m) => ((n % m) + m) % m;
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

/** Beat count at engine time `now` from a tracker snapshot, or null without a tempo. */
export function liveBeat(auto, now) {
  return auto?.period > 0 ? auto.anchorBeat + (now - auto.anchor) / auto.period : null;
}

/** Tempo from kick times: gaps folded into 80-180 BPM; 0 unless most of them agree. */
export function estimatePeriod(times) {
  const gaps = [];
  for (let i = 1; i < times.length; i++) {
    let g = times[i] - times[i - 1];
    if (g < 200 || g > 2000) continue;
    while (g > MAX_PERIOD) g /= 2;
    while (g < MIN_PERIOD) g *= 2;
    gaps.push(g);
  }
  if (gaps.length < 4) return 0;
  const sorted = gaps.slice().sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  const close = gaps.filter((g) => Math.abs(g - med) < 0.05 * med);
  if (close.length < 0.7 * gaps.length) return 0;
  return close.reduce((s, g) => s + g, 0) / close.length;
}

/** Least-squares line through kicks { n: beat number, t: time }: the period and t(n). */
function fitBeats(points) {
  if (points.length < 8) return null;
  let sn = 0;
  let st = 0;
  let snn = 0;
  let snt = 0;
  for (const p of points) {
    sn += p.n;
    st += p.t;
    snn += p.n * p.n;
    snt += p.n * p.t;
  }
  const m = points.length;
  const den = m * snn - sn * sn;
  if (!den) return null;
  const period = (m * snt - sn * st) / den;
  const intercept = (st - period * sn) / m;
  return { period, at: (n) => intercept + period * n };
}

export function createLiveTracker() {
  let period = 0; // ms per beat, 0 = no tempo yet
  let anchor = 0; // engine time of beat number `anchorBeat`
  let anchorBeat = 0;
  let barOffset = 0; // beat n starts a bar when (n - barOffset) % 4 === 0
  let kicks = []; // { t, matched }
  let snares = [];
  let hats = [];
  let lastHit = -Infinity;
  let firstHit = null; // first hit since the input went quiet
  let lastKick = -Infinity;
  let section = 'quiet';
  let sectionSince = 0;
  let sectionBeat = 0;
  let dropAt = null;
  let returnAt = null; // the kick coming back after a breakdown, without a build
  let breakdownFrom = null; // what played before the current breakdown
  let drops = 0;
  let energy = 0;
  let levelAt = null;

  const beatAt = (t) => (period ? anchorBeat + (t - anchor) / period : 0);
  const keep = (list, from) => {
    let i = 0;
    while (i < list.length && (list[i].t ?? list[i]) < from) i++;
    return i ? list.slice(i) : list;
  };
  const setSection = (name, t, beat = Math.round(beatAt(t))) => {
    if (section === name) return;
    if (name === 'breakdown') breakdownFrom = section;
    section = name;
    sectionSince = t;
    sectionBeat = beat;
  };
  // A kick drum's click also lands in the snare band; a snare hit within 40 ms of a kick is
  // that click (or a snare on a kick beat) and is no sign of a roll.
  const onKickBeat = (s) => kicks.some((k) => Math.abs(k.t - s) < 40);
  const countIn = (list, from, to) => list.filter((x) => x > from && x <= to && !onKickBeat(x)).length;
  /**
   * Snares per beat over the last `beats` beats, ending `back` beats ago, counting nothing
   * before `since` (so a build's roll does not spill into the drop after it). Needs
   * `minSpan` beats to go on: one beat of claps is not a roll.
   */
  const roll = (t, beats = 4, back = 0, since = -Infinity, minSpan = Math.min(beats, 3)) => {
    if (!period) return 0;
    const to = t - back * period;
    const from = Math.max(to - beats * period, since);
    const span = (to - from) / period;
    return span >= minSpan - 1e-6 ? countIn(snares, from, to) / span : 0;
  };

  /** Tempo from the latest kicks; this kick becomes a beat, counting on from the old clock. */
  function relock(t) {
    const p = estimatePeriod(kicks.slice(-9).map((k) => k.t));
    if (!p) return false;
    const n = period ? Math.round(beatAt(t)) : anchorBeat;
    period = p;
    anchor = t;
    anchorBeat = n;
    if (!drops) barOffset = mod(n, 4); // until a drop pins bar 1, guess the lock starts a bar
    // Number the kicks again on the new tempo, so the tempo fit never mixes old and new.
    for (const k of kicks) k.n = null;
    for (const k of kicks.slice(-9)) {
      k.matched = true;
      k.n = n + Math.round((k.t - t) / p);
    }
    return true;
  }

  /** Pin beat number `n` to time `t` and make it bar 1 of a phrase. */
  function startPhraseAt(t, n) {
    anchor = t;
    anchorBeat = n;
    barOffset = mod(n, 4);
  }

  function onKick(t) {
    const k = { t, matched: false };
    kicks = keep([...kicks, k], t - 16000);
    if (!period) {
      lastKick = t;
      if (relock(t)) setSection('groove', t);
      return;
    }
    let n = Math.round(beatAt(t));
    const err = t - (anchor + (n - anchorBeat) * period);
    // While the kick is out, a low thump between the beats (a bass note, the body of a loud
    // snare) is not the kick coming back: a real return lands on the beat the clock holds.
    // Unless several arrive evenly spaced, which means the tempo itself has moved.
    const kickOut = t - lastKick > 1.5 * period && ['breakdown', 'quiet', 'build'].includes(section);
    if (kickOut && Math.abs(err) > 0.15 * period) {
      const strays = kicks.filter((x) => x.t > lastKick).map((x) => x.t);
      if (strays.length >= 5 && estimatePeriod(strays)) {
        lastKick = t;
        relock(t);
        setSection('groove', t);
      }
      return;
    }
    const gap = (t - lastKick) / period;
    lastKick = t;
    if (Math.abs(err) > 0.25 * period) n = Math.ceil(beatAt(t));
    const inSection = n - sectionBeat;
    // The drop lands on the beat and starts bar 1 of a new phrase. It is the kick coming back
    //  - after a build (a snare roll), or a build's roll stopping while the kick plays on;
    //  - after a short gap (one or two bars) in music that was playing: producers take the
    //    kick out for a bar exactly to make the drop hit harder.
    // After a long breakdown with no build, the kick coming back may just as well start a
    // build or a groove: no way to tell live, and a false drop hit is worse than a missed one.
    const rollStopped = section === 'build' && roll(t, 1) < 0.5 && roll(t, 4, 1) >= 1.5;
    const afterBuild = section === 'build' && inSection >= 4 && (gap >= 3.5 || rollStopped);
    const shortGap = section === 'breakdown' && gap >= 3.5 && gap <= 9 && ['groove', 'high', 'drop', 'build'].includes(breakdownFrom);
    if (afterBuild || shortGap) {
      startPhraseAt(t, n);
      k.matched = true;
      k.n = n;
      dropAt = t;
      drops++;
      setSection('drop', t, n);
      return;
    }
    if (section === 'breakdown' || section === 'quiet') {
      // The kick is back: a new phrase after a real breakdown, else just back on the beat.
      if (section === 'breakdown' && inSection >= 8 && gap >= 3.5) {
        returnAt = t;
        startPhraseAt(t, n);
      } else {
        anchor = t;
        anchorBeat = n;
      }
      k.matched = true;
      k.n = n;
      setSection('groove', t, n);
      return;
    }
    if (Math.abs(err) <= 0.2 * period) {
      k.matched = true;
      k.n = n;
      const fit = fitBeats(kicks.filter((x) => x.n != null).slice(-16));
      if (fit) {
        // A straight line through the last 16 kicks' beat numbers and times: jitter averages
        // out, so the clock stays true through a breakdown with no kick to follow.
        period = clamp(fit.period, MIN_PERIOD, MAX_PERIOD);
        anchor = fit.at(n);
        anchorBeat = n;
      } else {
        // Too few kicks to fit yet. Phase: most of the way to the kick; tempo: a little of
        // the error, so a slightly wrong tempo converges in a few beats.
        anchor = anchor + (n - anchorBeat) * period + 0.6 * err;
        anchorBeat = n;
        period = clamp(period + 0.1 * err, MIN_PERIOD, MAX_PERIOD);
      }
    } else {
      // Off the grid. When most recent kicks are, the tempo has changed: find it again.
      const recent = kicks.slice(-8);
      if (recent.length >= 8 && recent.filter((x) => x.matched).length <= 3) relock(t);
    }
  }

  /** Snares landing on 2 and 4 tell which beats are 1 and 3 (until a drop pins bar 1). */
  function settleBars(t) {
    if (!period || drops) return;
    let odd = 0;
    let even = 0;
    for (const s of snares) {
      if (s < t - 16 * period) continue;
      const b = beatAt(s);
      if (Math.abs(b - Math.round(b)) > 0.15) continue;
      if (mod(Math.round(b) - barOffset, 2) === 1) odd++;
      else even++;
    }
    if (even >= 6 && even >= 3 * odd) barOffset = mod(barOffset + 1, 4);
  }

  function hit(band, t) {
    if (t - lastHit > 3000) firstHit = t;
    lastHit = t;
    if (band === 0) onKick(t);
    else if (band === 1) {
      snares = keep([...snares, t], t - 16000);
      settleBars(t);
    } else if (band === 2) hats = keep([...hats, t], t - 16000);
  }

  function levels(lv, t) {
    const e = Array.isArray(lv) ? Number(lv[3]) || 0 : 0;
    const dt = levelAt == null ? 0 : Math.max(0, t - levelAt);
    levelAt = t;
    const k = 1 - Math.exp(-dt / 1500);
    energy += k * (clamp(e, 0, 1) - energy);
  }

  /** What the drums do over the last two bars. */
  function groove(t) {
    if (!period) return null;
    const from = t - 8 * period;
    const matched = kicks.filter((x) => x.t > from && x.matched);
    let kick = 'none';
    if (matched.length >= 6) kick = 'four';
    else if (matched.length >= 2) {
      const pos = matched.map((x) => mod(Math.round(beatAt(x.t)) - barOffset, 4));
      if (pos.every((p) => p === 0)) kick = 'one';
      else if (pos.every((p) => p === 0 || p === 2)) kick = 'half';
      else kick = 'broken';
    } else if (matched.length === 1 || kicks.some((x) => x.t > from)) kick = 'broken';
    let on = 0;
    let off = 0;
    for (const s of snares) {
      if (s <= t - 16 * period) continue;
      const b = beatAt(s);
      if (Math.abs(b - Math.round(b)) > 0.15) continue;
      if (mod(Math.round(b) - barOffset, 2) === 1) on++;
      else off++;
    }
    const offbeatHats = hats.filter((h) => {
      if (h <= from) return false;
      const f = beatAt(h) - Math.floor(beatAt(h));
      return f > 0.35 && f < 0.65;
    }).length;
    return { kick, backbeat: on >= 4 && on >= 2 * off, hats: offbeatHats >= 4 };
  }

  /** Advance the song-part state; call every frame. True when the part changed. */
  function update(t) {
    const before = section;
    if (t - lastHit > 3000) {
      setSection('quiet', t);
      return section !== before;
    }
    if (!period) {
      // Music without a kick yet: wait two seconds before calling it a breakdown.
      if (t - lastKick > 2000 && firstHit != null && t - firstHit >= 2000) setSection('breakdown', t);
      return section !== before;
    }
    const sinceKick = (t - lastKick) / period;
    const inSection = beatAt(t) - sectionBeat;
    const snareRoll = roll(t, 4, 0, sectionSince);
    switch (section) {
      case 'quiet':
        setSection(sinceKick < 2 ? 'groove' : 'breakdown', t);
        break;
      case 'groove':
      case 'high':
      case 'drop':
        if (snareRoll >= 1.5) setSection('build', t);
        else if (sinceKick >= 4) setSection('breakdown', t);
        else if (section === 'drop' && inSection >= 64) setSection('high', t);
        break;
      case 'breakdown':
        if (snareRoll >= 1.5) setSection('build', t);
        break;
      case 'build':
        // A roll that fizzles out was not a build after all: back to the groove if the kick
        // plays, to the breakdown if it does not.
        if (inSection >= 8 && roll(t, 8) < 1) setSection(sinceKick < 2 ? 'groove' : 'breakdown', t);
        break;
      default:
        break;
    }
    return section !== before;
  }

  function locked(t) {
    if (!period) return false;
    return kicks.filter((x) => x.matched && x.t > t - 8 * period).length >= 3;
  }

  function snapshot(t) {
    return {
      period: r2(period),
      anchor: r1(anchor),
      anchorBeat,
      barOffset,
      bpm: period ? r1(60000 / period) : 0,
      locked: locked(t),
      section,
      sectionSince: r1(sectionSince),
      sectionBeat,
      dropAt: dropAt == null ? null : r1(dropAt),
      returnAt: returnAt == null ? null : r1(returnAt),
      drops,
      groove: groove(t),
      roll: r2(roll(t)),
      energy: r2(energy),
    };
  }

  return { hit, levels, update, snapshot, beatAt, get period() { return period; }, get section() { return section; } };
}

export const LIVE_PHRASE_BEATS = PHRASE;
