// Automatic fixture groups. Nothing to maintain: groups are derived from the patch every time.
//
//   all          every patched fixture
//   role:<role>  similar fixtures by what they can do: moving heads, colour washes, strobes, dimmers
//   type:<id>    identical fixtures (same profile), when that differs from its role group
//
// Members are listed left to right by stage position, the order chases and faders use.

import { fixtureRole, profileCaps, resolveProfile } from './fixture-library.js';

export const ROLE_NAMES = {
  mover: 'Moving heads',
  wash: 'Colour washes',
  strobe: 'Strobes',
  dimmer: 'Dimmers',
};

function mergeCaps(members) {
  const caps = { intensity: false, color: false, rgb: false, white: false, panTilt: false, zoom: false, strobe: false, gobo: false, prism: false };
  for (const { profile } of members) {
    const c = profileCaps(profile);
    caps.intensity ||= c.emitsLight;
    caps.color ||= !!c.color && c.color !== 'white';
    caps.rgb ||= c.color === 'rgb' || c.color === 'cmy';
    caps.white ||= c.white;
    caps.panTilt ||= c.panTilt;
    caps.zoom ||= c.zoom;
    caps.strobe ||= c.strobe;
    caps.gobo ||= c.gobo;
    caps.prism ||= c.prism;
  }
  return caps;
}

export function fixtureGroups(show) {
  const recs = show.fixtures
    .map((f) => ({ f, profile: resolveProfile(show, f.profileId) }))
    .filter((r) => r.profile)
    .sort((a, b) => a.f.position.x - b.f.position.x || a.f.position.z - b.f.position.z);
  if (!recs.length) return [];
  const make = (key, name, kind, members) => ({
    key,
    name,
    kind,
    fixtures: members.map((m) => m.f.id),
    caps: mergeCaps(members),
  });
  const groups = [make('all', 'All fixtures', 'all', recs)];

  const byRole = new Map();
  for (const r of recs) {
    const role = fixtureRole(r.profile);
    if (!byRole.has(role)) byRole.set(role, []);
    byRole.get(role).push(r);
  }
  for (const role of Object.keys(ROLE_NAMES)) {
    const members = byRole.get(role);
    if (members?.length) groups.push(make(`role:${role}`, ROLE_NAMES[role], 'role', members));
  }

  const byType = new Map();
  for (const r of recs) {
    if (!byType.has(r.profile.id)) byType.set(r.profile.id, []);
    byType.get(r.profile.id).push(r);
  }
  for (const [profileId, members] of byType) {
    const sameAsRole = byRole.get(fixtureRole(members[0].profile))?.length === members.length;
    if (!sameAsRole) groups.push(make(`type:${profileId}`, members[0].profile.name, 'type', members));
  }
  return groups;
}

/** Fixture ids of a group key, or [] when it does not exist (anymore). */
export function groupMembers(show, key) {
  return fixtureGroups(show).find((g) => g.key === key)?.fixtures || [];
}
