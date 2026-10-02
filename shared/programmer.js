// Manual control (the "programmer"): fader and channel values that override the show on the
// real lights until released. The engine and the browser apply updates with this same code,
// so a window can show its own fader moves immediately and still end up exactly where the
// engine is once the engine confirms them.

import { normalizeAttrMap, normalizeRawMap } from './show.js';

export const emptyProgrammer = () => ({ attrs: {}, raw: {} });

/**
 * Apply one update to a programmer and return the new one (the input is not changed).
 *   { clear: 'all' | { fixtures: [ids] }, set: { attrs: { fx: { dimmer: 0.5, pan: null } }, raw: { fx: { 3: 255 } } } }
 * The clear happens first. null in `set` releases that value. Values are range-checked; with
 * `known` (a Set of fixture ids) values for fixtures that are not in the show are dropped.
 */
export function applyProgrammer(p, msg, known = null) {
  let attrs = { ...p.attrs };
  let raw = { ...p.raw };
  if (msg.clear === 'all') {
    attrs = {};
    raw = {};
  } else if (Array.isArray(msg.clear?.fixtures)) {
    for (const id of msg.clear.fixtures) {
      if (typeof id !== 'string') continue;
      delete attrs[id];
      delete raw[id];
    }
  }
  if (msg.set && typeof msg.set === 'object') {
    merge(attrs, normalizeAttrMap(msg.set.attrs, { keepNull: true }), known);
    merge(raw, normalizeRawMap(msg.set.raw, { keepNull: true }), known);
  }
  return { attrs, raw };
}

function merge(target, incoming, known) {
  for (const fx of Object.keys(incoming)) {
    if (known && !known.has(fx)) continue;
    const cur = { ...(Object.hasOwn(target, fx) ? target[fx] : {}) };
    for (const [k, v] of Object.entries(incoming[fx])) {
      if (v === null) delete cur[k];
      else cur[k] = v;
    }
    if (Object.keys(cur).length) target[fx] = cur;
    else delete target[fx];
  }
}

/** Combine two `set` payloads; later values (including null releases) win. */
export function mergeSets(a, b) {
  const out = { attrs: { ...a?.attrs }, raw: { ...a?.raw } };
  for (const part of ['attrs', 'raw']) {
    for (const [fx, values] of Object.entries(b?.[part] || {})) {
      out[part][fx] = { ...(Object.hasOwn(out[part], fx) ? out[part][fx] : {}), ...values };
    }
  }
  return out;
}

/** Does manual control hold anything at all (or anything for one fixture)? */
export function programmerHolds(p, fixtureId = null) {
  if (!p) return false;
  if (fixtureId) return Object.hasOwn(p.attrs, fixtureId) || Object.hasOwn(p.raw, fixtureId);
  return Object.keys(p.attrs).length > 0 || Object.keys(p.raw).length > 0;
}
