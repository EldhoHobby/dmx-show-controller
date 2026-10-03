// The house rig the show-building tools patch: three trusses, the deck and a floor package.
//
// Shared by tools/make-demo-show.js and tools/make-show.js so a show built for your own
// song lands on the same fixtures as the demo, and the two can be compared fairly.
//
// Fixtures spread evenly from -spread to +spread in X (stage right is +X as seen from the
// audience), which is also the order chases run in. Rotation follows shared/kinematics.js:
// x 180 hangs straight down, x 0 points up, x 90 faces the audience.

import { footprint, getBuiltinProfile } from '../shared/fixture-library.js';

export const RIG = [
  {
    count: 6, prefix: 'Back par', group: 'Back pars', profile: 'generic.rgbw-7ch',
    universe: 1, address: 1, y: 4.2, z: -2.6, spread: 4.5, rotation: { x: 150, y: 0, z: 0 },
  },
  {
    count: 6, prefix: 'Wash', group: 'Wash movers', profile: 'generic.wash-mover-14ch',
    universe: 1, address: 43, y: 4.6, z: -0.6, spread: 4.2, rotation: { x: 180, y: 0, z: 0 },
  },
  {
    count: 4, prefix: 'Spot', group: 'Spots', profile: 'generic.spot-mover-12ch',
    universe: 1, address: 127, y: 4.6, z: 2.2, spread: 3.3, rotation: { x: 180, y: 0, z: 0 },
  },
  {
    // On the deck at the edges, tilted just above horizontal so they hit the audience.
    count: 2, prefix: 'Strobe', group: 'Strobes', profile: 'generic.strobe-2ch',
    universe: 1, address: 175, y: 1.2, z: -1, spread: 4.6, rotation: { x: 75, y: 0, z: 0 },
  },
  {
    // Floor bars along the back, shooting straight up behind the band.
    count: 4, prefix: 'Bar', group: 'Pixel bars', profile: 'generic.pixelbar-8rgb',
    universe: 2, address: 1, y: 0.12, z: -2.9, spread: 3.75, rotation: { x: 0, y: 0, z: 0 },
  },
];

const round = (v, p) => Math.round(v * 10 ** p) / 10 ** p;

/** Channel footprint, read from the library so addresses stay right if a profile changes. */
function channelsOf(profileId) {
  const profile = getBuiltinProfile(profileId);
  if (!profile) throw new Error(`Unknown profile "${profileId}"`);
  return footprint(profile);
}

export function buildFixtures() {
  const fixtures = [];
  for (const row of RIG) {
    const { count, spread } = row;
    const step = count > 1 ? (2 * spread) / (count - 1) : 0;
    const size = channelsOf(row.profile);
    for (let i = 0; i < count; i++) {
      fixtures.push({
        id: `fx_${row.prefix.toLowerCase().replace(/\W+/g, '')}${i + 1}`,
        name: `${row.prefix} ${i + 1}`,
        profileId: row.profile,
        universe: row.universe,
        address: row.address + i * size,
        position: { x: round(count > 1 ? -spread + i * step : 0, 2), y: row.y, z: row.z },
        rotation: { ...row.rotation },
        group: row.group,
      });
    }
  }
  return fixtures;
}

/** One line describing the rig, for a show's notes. */
export function describeRig() {
  const total = RIG.reduce((n, r) => n + r.count, 0);
  const universes = new Set(RIG.map((r) => r.universe)).size;
  const parts = RIG.map((r) => `${r.count} ${r.group.toLowerCase()}`).join(', ');
  return `A club rig of ${total} fixtures over ${universes} universes: ${parts}.`;
}
