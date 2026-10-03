// Live beat clock and song-part tracking, from the hits of the live detector.
//
// The engine feeds it every hit the live-audio input reports (kick, snare, hi-hat), stamped
// on the engine clock, and the band levels. It keeps:
//   - a beat clock. A steady kick gives the tempo from its gaps and pulls the clock onto
//     each kick (a phase-locked loop). Music whose kick does not mark every beat (syncopated
//     Indian dance rhythms, broken beats, half-time) gives its tempo from how all its hits
//     repeat, and its phase from where they gather: kicks and snares vote for the beat,
//     hi-hats for the beat half a beat away. The clock runs on through breakdowns.
//   - bars and phrases: a drop starts bar 1 of an 8-bar phrase; snares landing on 2 and 4
//     settle which beats are 1 and 3 until then
//   - the part of the song, as it happens: groove (kicks), breakdown (no kick for two bars,
//     or for one with the bass gone too), build (a snare roll: 1.5 or more snares a beat),
//     drop (the kick comes back after a build, or after a short break with the bass out, or
//     the roll stops while it plays), high (a drop that has run 16 bars), quiet (no input)
//   - what the drums do right now: kick pattern, backbeat, off-beat hi-hats
// snapshot() is plain data: the engine broadcasts it, and every window works out the same
// beat from it with liveBeat().

const MIN_PERIOD = 60000 / 180;
const MAX_PERIOD = 60000 / 80;
const PHRASE = 32;
// How much a hit in each band says about where the beat is: kick, snare (mid), hi-hat.
const WEIGHT = [1, 0.6, 0.35];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const mod = (n, m) => ((n % m) + m) % m;
const wrap = (beats) => mod(beats + 0.5, 1) - 0.5; // -0.5..0.5
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
// The song analysis' broad preference for tempos around 120 BPM.
const prior = (period) => Math.exp(-0.5 * (Math.log2(60000 / period / 120) / 0.9) ** 2);

/** Beat count at engine time `now` from a tracker snapshot, or null without a tempo. */
export function liveBeat(auto, now) {
  return auto?.period > 0 ? auto.anchorBeat + (now - auto.anchor) / auto.period : null;
}

/** Tempo from kick times: gaps folded into 80-180 BPM; 0 unless nearly all of them agree. */
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
  if (close.length < 0.85 * gaps.length) return 0;
  return close.reduce((s, g) => s + g, 0) / close.length;
}

/**
 * Tempo from how all the hits of the last 8 s repeat, for music whose kick gaps disagree:
 * every pair of hits votes for its gap (weighted by band), and a tempo scores the votes at
 * its beat and at two beats, with the song analysis' preference for 120 BPM. Returns the best
 * period and the scoring (to weigh other tempos against it), or null with too few hits.
 * `hits` are { t, band } in time order.
 */
export function tempoFromHits(hits, now) {
  const recent = hits.filter((h) => h.t > now - 8000 && h.t <= now);
  if (recent.length < 10) return null;
  const BIN = 5;
  const maxLag = 2 * MAX_PERIOD + 20;
  const H = new Float64Array(Math.ceil(maxLag / BIN) + 3);
  for (let i = 0; i < recent.length; i++) {
    for (let j = i + 1; j < recent.length; j++) {
      const d = recent[j].t - recent[i].t;
      if (d > maxLag) break;
      if (d < 0.9 * MIN_PERIOD) continue;
      const w = WEIGHT[recent[i].band] * WEIGHT[recent[j].band];
      const x = d / BIN;
      const k = Math.floor(x);
      H[k] += w * (k + 1 - x);
      H[k + 1] += w * (x - k);
    }
  }
  // A gap counts toward a tempo within ±10 ms: live hits are that ragged.
  const at = (ms) => {
    const c = ms / BIN;
    let s = 0;
    for (let k = Math.floor(c - 2); k <= Math.ceil(c + 2); k++) if (k >= 0 && k < H.length) s += H[k] * Math.max(0, 1 - Math.abs(k - c) / 2);
    return s;
  };
  const score = (p) => (at(p) + 0.5 * at(2 * p)) * prior(p);
  let best = 0;
  let bestScore = 0;
  for (let p = MIN_PERIOD; p <= MAX_PERIOD; p *= 1.002) {
    const v = score(p);
    if (v > bestScore) {
      bestScore = v;
      best = p;
    }
  }
  return best ? { period: best, score } : null;
}

/** Weighted least-squares line through on-beat hits { n: beat number, t: time, w }. */
function fitBeats(points) {
  if (points.length < 8) return null;
  let sw = 0;
  let sn = 0;
  let st = 0;
  let snn = 0;
  let snt = 0;
  for (const p of points) {
    sw += p.w;
    sn += p.w * p.n;
    st += p.w * p.t;
    snn += p.w * p.n * p.n;
    snt += p.w * p.n * p.t;
  }
  const den = sw * snn - sn * sn;
  if (!den) return null;
  const period = (sw * snt - sn * st) / den;
  const intercept = (st - period * sn) / sw;
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
  let hits = []; // every hit { t, band }, for the tempo and phase of syncopated music
  let marks = []; // hits on the clock's beats { t, n, w }: kicks, and snares on the beat
  let lastHit = -Infinity;
  let firstHit = null; // first hit since the input went quiet
  let lastKick = -Infinity;
  let section = 'quiet';
  let sectionSince = 0;
  let sectionBeat = 0;
  let dropAt = null;
  let returnAt = null; // the kick coming back after a breakdown, without a build
  let breakdownFrom = null; // what played before the current breakdown
  let beforeBreakdown = null; // the part the current breakdown interrupted, to resume it
  let gapBassOut = false; // the bass went out since the latest kick
  let drops = 0;
  // Levels: overall (for the looks), and fast/slow followers that tell when the bass or the
  // whole mix drops out and when the input goes silent.
  let energy = 0;
  let energyFast = 0;
  let energySlow = 0;
  let lowFast = 0;
  let lowSlow = 0;
  let levelAt = null;
  // Tempo and phase checks from all hits.
  let tempoAt = -Infinity;
  let phaseAt = -Infinity;
  let candidate = null; // { period, votes }: a new tempo waiting to be confirmed
  let offPhase = null; // { delta, since }: the hits gathering off the clock's beats

  const beatAt = (t) => (period ? anchorBeat + (t - anchor) / period : 0);
  const keep = (list, from) => {
    let i = 0;
    while (i < list.length && (list[i].t ?? list[i]) < from) i++;
    return i ? list.slice(i) : list;
  };
  const setSection = (name, t, beat = Math.round(beatAt(t))) => {
    if (section === name) return;
    if (name === 'breakdown') {
      breakdownFrom = section;
      beforeBreakdown = { section, sectionSince, sectionBeat };
    }
    section = name;
    sectionSince = t;
    sectionBeat = beat;
  };
  // The bass (low band) well below where it has been: a breakdown or a break before a drop.
  const bassOut = () => levelAt != null && lowSlow > 0.05 && lowFast < 0.45 * lowSlow;
  // The whole mix well below where it has been (a kick pausing for a fill leaves the rest).
  const mixOut = () => levelAt != null && energySlow > 0.05 && energyFast < 0.6 * energySlow;
  // No input: no level reports, or levels near zero.
  const silent = (t) => levelAt == null || t - levelAt > 1000 || energyFast < 0.06;
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
  /**
   * A build's roll: 1.5 or more snares a beat over the last 4 beats of this part, on a
   * regular grid, filling most of its 8th-note (or 16th-note) slots. A busy groove's claps
   * and percussion add up to as many hits, but land all over the beat.
   */
  const rolling = (t) => {
    if (roll(t, 4, 0, sectionSince) < 1.5) return false;
    const b1 = beatAt(t);
    const b0 = Math.max(b1 - 4, beatAt(sectionSince));
    const fill = (div) => {
      const slots = new Set();
      for (const s of snares) {
        const b = beatAt(s);
        if (b <= b0 || b > b1) continue;
        const slot = Math.round(b * div);
        if (Math.abs(b - slot / div) < 0.06) slots.add(slot);
      }
      return slots.size / ((b1 - b0) * div);
    };
    return fill(2) >= 0.75 || fill(4) >= 0.6;
  };

  /** A new tempo; this time becomes beat `n`, counting on from the old clock. */
  function setClock(p, t, n = period ? Math.round(beatAt(t)) : anchorBeat) {
    period = clamp(p, MIN_PERIOD, MAX_PERIOD);
    anchor = t;
    anchorBeat = n;
    if (!drops) barOffset = mod(n, 4); // until a drop pins bar 1, guess the lock starts a bar
    // Number the hits again on the new tempo, so the tempo fit never mixes old and new.
    marks = [];
    candidate = null;
    offPhase = null;
  }

  /** Tempo from the latest kicks; this kick becomes a beat, counting on from the old clock. */
  function relock(t) {
    const p = estimatePeriod(kicks.slice(-9).map((k) => k.t));
    if (!p) return false;
    const n = period ? Math.round(beatAt(t)) : anchorBeat;
    setClock(p, t, n);
    for (const k of kicks.slice(-9)) {
      k.matched = true;
      marks.push({ t: k.t, n: n + Math.round((k.t - t) / p), w: 1 });
    }
    return true;
  }

  /** Pin beat number `n` to time `t` and make it bar 1 of a phrase. */
  function startPhraseAt(t, n) {
    anchor = t;
    anchorBeat = n;
    barOffset = mod(n, 4);
  }

  /** A hit on one of the clock's beats tunes the clock: tempo and phase from the latest ones. */
  function mark(t, n, w) {
    marks = keep([...marks, { t, n, w }], t - 16000).slice(-24);
    const fit = fitBeats(marks.slice(-16));
    if (fit) {
      // A straight line through the latest on-beat hits' beat numbers and times: jitter
      // averages out, so the clock stays true through a breakdown with nothing to follow.
      period = clamp(fit.period, MIN_PERIOD, MAX_PERIOD);
      anchor = fit.at(n);
      anchorBeat = n;
    } else {
      // Too few hits to fit yet. Phase: most of the way to the hit; tempo: a little of the
      // error, so a slightly wrong tempo converges in a few beats.
      const err = t - (anchor + (n - anchorBeat) * period);
      anchor = anchor + (n - anchorBeat) * period + 0.6 * w * err;
      anchorBeat = n;
      period = clamp(period + 0.1 * w * err, MIN_PERIOD, MAX_PERIOD);
    }
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
    // While the kick is out (a breakdown, a build, a break with the bass gone), a low thump
    // between the beats (a bass note, the body of a loud snare, a riser) is not the kick
    // coming back: a real return lands on the beat the clock holds. Unless several arrive
    // evenly spaced, which means the tempo itself has moved.
    const kickOut = t - lastKick > 1.5 * period && (['breakdown', 'quiet', 'build'].includes(section) || gapBassOut);
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
    const before = section === 'breakdown' ? breakdownFrom : section;
    // A four-on-the-floor kick up to the break: six on the beat in the two bars before it.
    const steady = kicks.filter((x) => x.matched && x.t > lastKick - 8.5 * period && x.t <= lastKick).length >= 6;
    const breakDrop = gapBassOut && steady && gap >= 3.5 && gap <= 9 && ['groove', 'high', 'drop', 'build'].includes(before);
    lastKick = t;
    gapBassOut = false;
    if (Math.abs(err) > 0.25 * period) n = Math.ceil(beatAt(t));
    const inSection = n - sectionBeat;
    // The drop lands on the beat and starts bar 1 of a new phrase. It is the kick coming back
    //  - after a build (a snare roll), or a build's roll stopping while the kick plays on;
    //  - after a short break (one or two bars) with the bass out too, from a four-on-the-floor
    //    kick: producers cut the kick and bass for a bar to make the drop hit harder. A kick
    //    that only pauses (a fill, a vocal break) over a running bass is no drop, nor is a
    //    gap in a syncopated kick pattern.
    // After a long breakdown with no build, the kick coming back may just as well start a
    // build or a groove: no way to tell live, and a false drop hit is worse than a missed one.
    const rollStopped = section === 'build' && roll(t, 1) < 0.5 && roll(t, 4, 1) >= 1.5;
    const afterBuild = section === 'build' && inSection >= 4 && (gap >= 3.5 || rollStopped);
    if (afterBuild || breakDrop) {
      startPhraseAt(t, n);
      k.matched = true;
      mark(t, n, 1);
      dropAt = t;
      drops++;
      setSection('drop', t, n);
      return;
    }
    if (section === 'breakdown' && t - sectionSince < 2 * period && beforeBreakdown && beforeBreakdown.section !== 'quiet') {
      // The kick is back within two beats of the breakdown being called: it never was one.
      // Carry on with the part it interrupted, as if nothing happened (the looks keep going).
      ({ section, sectionSince, sectionBeat } = beforeBreakdown);
      k.matched = true;
      mark(t, n, 1);
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
      marks.push({ t, n, w: 1 });
      setSection('groove', t, n);
      return;
    }
    if (Math.abs(err) <= 0.2 * period) {
      k.matched = true;
      mark(t, n, 1);
    } else {
      // Off the grid. When most recent kicks are, the tempo has changed: find it again from
      // the kick gaps (steady kicks; syncopated ones are left to the checks in update()).
      const recent = kicks.slice(-8);
      if (recent.length >= 8 && recent.filter((x) => x.matched).length <= 3) relock(t);
    }
  }

  /** A snare on the clock's beat tunes the clock like a kick, at a little over half weight. */
  function onSnare(t) {
    snares = keep([...snares, t], t - 16000);
    if (!period || onKickBeat(t)) return;
    const n = Math.round(beatAt(t));
    const err = t - (anchor + (n - anchorBeat) * period);
    if (Math.abs(err) <= 0.12 * period && t - lastKick < 4 * period) mark(t, n, 0.6);
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
    hits = keep([...hits, { t, band }], t - 10000);
    if (band === 0) onKick(t);
    else if (band === 1) {
      onSnare(t);
      settleBars(t);
    } else if (band === 2) hats = keep([...hats, t], t - 16000);
  }

  function levels(lv, t) {
    const e = Array.isArray(lv) ? clamp(Number(lv[3]) || 0, 0, 1) : 0;
    const low = Array.isArray(lv) ? clamp(Number(lv[0]) || 0, 0, 1) : 0;
    const dt = levelAt == null ? 0 : Math.max(0, t - levelAt);
    if (levelAt == null) {
      energyFast = e;
      energySlow = e;
      lowFast = low;
      lowSlow = low;
    }
    levelAt = t;
    const follow = (v, target, tau) => v + (1 - Math.exp(-dt / tau)) * (target - v);
    energy = follow(energy, e, 1500);
    energyFast = follow(energyFast, e, 300);
    energySlow = follow(energySlow, e, 6000);
    lowFast = follow(lowFast, low, 300);
    lowSlow = follow(lowSlow, low, 6000);
  }

  /**
   * Where the hits of the last 6 s put the beat, against the clock: kicks and snares vote
   * for their own place, hi-hats mostly for half a beat away (off-beat hi-hats are the norm).
   * Returns the offset of the strongest place in beats (-0.5..0.5) and how clearly it stands
   * out (its votes against the average; 1 = no preference).
   */
  function phaseVotes(t) {
    const votes = [];
    for (const h of hits) {
      if (h.t <= t - 6000 || h.t > t) continue;
      const age = Math.exp(-(t - h.t) / 3000);
      const ph = mod(beatAt(h.t), 1);
      if (h.band === 2) votes.push([mod(ph - 0.5, 1), 0.25 * age], [ph, 0.1 * age]);
      else votes.push([ph, WEIGHT[h.band] * age]);
    }
    if (votes.length < 6) return null;
    const N = 48;
    let best = 0;
    let bestScore = -1;
    let total = 0;
    for (let b = 0; b < N; b++) {
      let s = 0;
      for (const [p, w] of votes) s += w * Math.exp(-0.5 * (wrap(p - b / N) / 0.035) ** 2);
      total += s;
      if (s > bestScore) {
        bestScore = s;
        best = b;
      }
    }
    // The votes near the peak say exactly where it is.
    let re = 0;
    let im = 0;
    for (const [p, w] of votes) {
      const d = wrap(p - best / N);
      if (Math.abs(d) < 0.08) {
        re += w * Math.cos(2 * Math.PI * d);
        im += w * Math.sin(2 * Math.PI * d);
      }
    }
    return { delta: wrap(best / N + Math.atan2(im, re) / (2 * Math.PI)), clarity: (bestScore * N) / (total || 1) };
  }

  /** The checks from all hits: the tempo of a beat the kick gaps cannot give, and its phase. */
  function checkClock(t) {
    if (t - tempoAt >= 500) {
      tempoAt = t;
      const est = tempoFromHits(hits, t);
      const p = est?.period || 0;
      // Start from the latest kick or snare; the phase check below moves the clock onto the
      // beat if that was not one.
      const last = () => [...hits].reverse().find((h) => h.band !== 2) || hits[hits.length - 1];
      if (p && !period) {
        // Music, but no steady kick to start the clock from.
        setClock(p, last().t, 0);
        setSection(t - lastKick < 4 * p ? 'groove' : 'breakdown', t);
      } else if (p && period) {
        // A different tempo (not just double or half time) that holds for 1.5 s: take it.
        // While hits land on the clock's beats it must also score clearly better than the
        // clock's own tempo, for 2 s: kicks can agree on the wrong beat (a 3-3-2 pattern locks
        // onto its 3s) while the claps and everything else repeat at the real one, but music
        // in 6/8 or with triplets fits several tempos about as well, and should keep its own.
        const ratio = p / period;
        const same = [0.5, 1, 2].some((r) => Math.abs(Math.log(ratio / r)) < Math.log(1.03));
        const own = Math.max(...[0.5, 1, 2].map((r) => est.score(period * r)));
        const better = !locked(t) || est.score(p) > 1.25 * own;
        if (same || !better) candidate = null;
        else if (candidate && Math.abs(Math.log(p / candidate.period)) < Math.log(1.02)) {
          if (++candidate.votes >= (locked(t) ? 4 : 3)) {
            const h = last();
            setClock(p, h.t, Math.round(beatAt(h.t)));
          }
        } else candidate = { period: p, votes: 1 };
      }
    }
    if (period && t - phaseAt >= 100) {
      phaseAt = t;
      const ph = phaseVotes(t);
      if (ph && ph.clarity >= 1.8 && Math.abs(ph.delta) > 0.12) {
        // The hits gather away from the clock's beats. When that holds for a second, move the
        // clock onto them.
        if (offPhase && Math.abs(wrap(offPhase.delta - ph.delta)) < 0.08) {
          if (t - offPhase.since >= 1000) {
            anchor += ph.delta * period;
            marks = [];
            offPhase = null;
          }
        } else offPhase = { delta: ph.delta, since: t };
      } else offPhase = null;
    }
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
    if (t - lastHit > 3000 && silent(t)) {
      setSection('quiet', t);
      return section !== before;
    }
    checkClock(t);
    if (!period) {
      // Music without a kick yet: wait two seconds before calling it a breakdown.
      if (t - lastKick > 2000 && firstHit != null && t - firstHit >= 2000) setSection('breakdown', t);
      return section !== before;
    }
    const sinceKick = (t - lastKick) / period;
    const inSection = beatAt(t) - sectionBeat;
    if (sinceKick >= 1.5 && bassOut()) gapBassOut = true;
    switch (section) {
      case 'quiet':
        setSection(sinceKick < 2 ? 'groove' : 'breakdown', t);
        break;
      case 'groove':
      case 'high':
      case 'drop':
        // Sparse or undetected kicks under a full mix are still a groove. A breakdown is four
        // bars without a kick, two with the bass gone, or one with the bass and the mix gone.
        if (rolling(t)) setSection('build', t);
        else if (sinceKick >= 16 || (sinceKick >= 8 && bassOut()) || (sinceKick >= 4 && bassOut() && mixOut())) setSection('breakdown', t);
        else if (section === 'drop' && inSection >= 64) setSection('high', t);
        break;
      case 'breakdown':
        if (rolling(t)) setSection('build', t);
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

  /** The clock is confirmed by hits on its beats (kicks, or snares) within the last two bars. */
  function locked(t) {
    if (!period) return false;
    return marks.filter((x) => x.t > t - 8 * period).length >= 3;
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
