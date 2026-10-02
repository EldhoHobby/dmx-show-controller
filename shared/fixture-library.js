// Fixture profiles: what each DMX channel of a fixture controls.
//
// The engine works in normalized *attributes* (dimmer 0..1, colour, pan/tilt in degrees,
// strobe 0..1, ...). A profile maps those attributes onto the fixture's channel layout.
//
// Channel definition fields:
//   attr     attribute name (see ATTRIBUTES) or 'fixed' for a constant channel
//   fine     true for the low byte of a 16-bit pair (the coarse channel shares the attr)
//   min/max  DMX range used for values above zero (default 0..255)
//   off      DMX value sent when the attribute is 0 (strobe "open", prism "off", ...)
//   on       DMX value for prism "on"
//   invert   reverse the range
//   value    constant DMX value for 'fixed' channels
//   slots    [{ name, dmx, color? }] for colour wheels and gobo wheels
//
// The built-in profiles are deliberately generic. Real fixtures should be imported from
// Open Fixture Library files (see ofl-import.js) so their channel layouts are exact.

export const ATTRIBUTES = [
  'dimmer', 'red', 'green', 'blue', 'white', 'amber', 'uv', 'cyan', 'magenta', 'yellow',
  'pan', 'tilt', 'strobe', 'zoom', 'gobo', 'prism', 'colorWheel', 'fixed',
];

const COLOR_WHEEL = [
  { name: 'White', dmx: 0, color: [1, 1, 1] },
  { name: 'Red', dmx: 10, color: [1, 0, 0] },
  { name: 'Orange', dmx: 20, color: [1, 0.5, 0] },
  { name: 'Yellow', dmx: 30, color: [1, 1, 0] },
  { name: 'Green', dmx: 40, color: [0, 1, 0] },
  { name: 'Cyan', dmx: 50, color: [0, 1, 1] },
  { name: 'Blue', dmx: 60, color: [0, 0, 1] },
  { name: 'Magenta', dmx: 70, color: [1, 0, 1] },
];

const GOBO_WHEEL = [
  { name: 'Open', dmx: 0 },
  { name: 'Gobo 1', dmx: 10 },
  { name: 'Gobo 2', dmx: 20 },
  { name: 'Gobo 3', dmx: 30 },
  { name: 'Gobo 4', dmx: 40 },
  { name: 'Gobo 5', dmx: 50 },
  { name: 'Gobo 6', dmx: 60 },
  { name: 'Gobo 7', dmx: 70 },
];

export const BUILTIN_PROFILES = [
  {
    id: 'generic.dimmer',
    name: 'Dimmer channel (1 ch)',
    manufacturer: 'Generic',
    kind: 'dimmer',
    beamAngle: 30,
    channels: [{ attr: 'dimmer' }],
  },
  {
    id: 'generic.rgb',
    name: 'RGB par (3 ch)',
    manufacturer: 'Generic',
    kind: 'par',
    beamAngle: 25,
    channels: [{ attr: 'red' }, { attr: 'green' }, { attr: 'blue' }],
  },
  {
    id: 'generic.drgb',
    name: 'RGB par with dimmer (4 ch)',
    manufacturer: 'Generic',
    kind: 'par',
    beamAngle: 25,
    channels: [{ attr: 'dimmer' }, { attr: 'red' }, { attr: 'green' }, { attr: 'blue' }],
  },
  {
    id: 'generic.rgbw-7ch',
    name: 'RGBW par (7 ch)',
    manufacturer: 'Generic',
    kind: 'par',
    beamAngle: 25,
    channels: [
      { attr: 'dimmer' },
      { attr: 'red' },
      { attr: 'green' },
      { attr: 'blue' },
      { attr: 'white' },
      { attr: 'strobe', off: 0, min: 16, max: 255 },
      { attr: 'fixed', value: 0, label: 'Program' },
    ],
  },
  {
    id: 'generic.strobe-2ch',
    name: 'Strobe (2 ch)',
    manufacturer: 'Generic',
    kind: 'strobe',
    beamAngle: 90,
    channels: [{ attr: 'dimmer' }, { attr: 'strobe', off: 0, min: 1, max: 255 }],
  },
  {
    id: 'generic.wash-mover-14ch',
    name: 'Moving head wash RGBW (14 ch)',
    manufacturer: 'Generic',
    kind: 'moving-head',
    panRange: 540,
    tiltRange: 270,
    zoomRange: [10, 40],
    channels: [
      { attr: 'pan' },
      { attr: 'pan', fine: true },
      { attr: 'tilt' },
      { attr: 'tilt', fine: true },
      { attr: 'fixed', value: 0, label: 'Pan/tilt speed' },
      { attr: 'dimmer' },
      { attr: 'strobe', off: 255, min: 8, max: 215 },
      { attr: 'red' },
      { attr: 'green' },
      { attr: 'blue' },
      { attr: 'white' },
      { attr: 'zoom' },
      { attr: 'fixed', value: 0, label: 'Control' },
      { attr: 'fixed', value: 0, label: 'Mode' },
    ],
  },
  {
    id: 'generic.spot-mover-12ch',
    name: 'Moving head spot (12 ch)',
    manufacturer: 'Generic',
    kind: 'moving-head',
    panRange: 540,
    tiltRange: 270,
    beamAngle: 15,
    channels: [
      { attr: 'pan' },
      { attr: 'pan', fine: true },
      { attr: 'tilt' },
      { attr: 'tilt', fine: true },
      { attr: 'fixed', value: 0, label: 'Pan/tilt speed' },
      { attr: 'colorWheel', slots: COLOR_WHEEL },
      { attr: 'gobo', slots: GOBO_WHEEL },
      { attr: 'prism', off: 0, on: 128 },
      { attr: 'dimmer' },
      { attr: 'strobe', off: 255, min: 8, max: 215 },
      { attr: 'fixed', value: 0, label: 'Control' },
      { attr: 'fixed', value: 0, label: 'Mode' },
    ],
  },
];

const BUILTIN_BY_ID = new Map(BUILTIN_PROFILES.map((p) => [p.id, p]));

export function getBuiltinProfile(id) {
  return BUILTIN_BY_ID.get(id) || null;
}

/** Profiles embedded in the show win over built-ins, so an exported show is self-contained. */
export function resolveProfile(show, profileId) {
  const own = show?.profiles?.find((p) => p.id === profileId);
  return own || BUILTIN_BY_ID.get(profileId) || null;
}

export function allProfiles(show) {
  const own = show?.profiles || [];
  const ownIds = new Set(own.map((p) => p.id));
  return [...own, ...BUILTIN_PROFILES.filter((p) => !ownIds.has(p.id))];
}

export function footprint(profile) {
  return profile ? profile.channels.length : 0;
}

/** Summarize what a profile can do; the renderer and the auto-sequencer both rely on this. */
export function profileCaps(profile) {
  const attrs = new Set(profile.channels.map((c) => c.attr));
  const fine = new Set(profile.channels.filter((c) => c.fine).map((c) => c.attr));
  const hasRgb = attrs.has('red') && attrs.has('green') && attrs.has('blue');
  const hasCmy = attrs.has('cyan') && attrs.has('magenta') && attrs.has('yellow');
  let color = null;
  if (hasRgb) color = 'rgb';
  else if (hasCmy) color = 'cmy';
  else if (attrs.has('colorWheel')) color = 'wheel';
  else if (attrs.has('white')) color = 'white';
  return {
    dimmer: attrs.has('dimmer'),
    color,
    white: attrs.has('white'),
    panTilt: attrs.has('pan') && attrs.has('tilt'),
    pan16: fine.has('pan'),
    tilt16: fine.has('tilt'),
    strobe: attrs.has('strobe'),
    zoom: attrs.has('zoom'),
    gobo: attrs.has('gobo'),
    prism: attrs.has('prism'),
    emitsLight: attrs.has('dimmer') || hasRgb || hasCmy || attrs.has('white'),
  };
}

export function panRange(profile) {
  return profile?.panRange > 0 ? profile.panRange : 540;
}

export function tiltRange(profile) {
  return profile?.tiltRange > 0 ? profile.tiltRange : 270;
}

/** Beam angle in degrees for a zoom value 0..1 (0 = narrowest). */
export function beamAngle(profile, zoom = 0.5) {
  if (Array.isArray(profile?.zoomRange)) {
    const [a, b] = profile.zoomRange;
    return a + (b - a) * zoom;
  }
  return profile?.beamAngle > 0 ? profile.beamAngle : 20;
}

/** Light-up category used by the auto-sequencer to decide what each fixture is good for. */
export function fixtureRole(profile) {
  const caps = profileCaps(profile);
  if (caps.panTilt) return 'mover';
  if (profile.kind === 'strobe' || (caps.strobe && !caps.color)) return 'strobe';
  if (caps.color) return 'wash';
  return 'dimmer';
}

/** Basic structural check for profiles coming from files or the network. */
export function checkProfile(p) {
  const errors = [];
  if (!p || typeof p !== 'object') return ['Profile is not an object'];
  if (typeof p.id !== 'string' || !p.id) errors.push('Profile needs an id');
  if (typeof p.name !== 'string' || !p.name) errors.push('Profile needs a name');
  if (!Array.isArray(p.channels) || p.channels.length === 0) errors.push('Profile needs at least one channel');
  else if (p.channels.length > 512) errors.push('Profile has more than 512 channels');
  else {
    p.channels.forEach((c, i) => {
      if (!c || !ATTRIBUTES.includes(c.attr)) errors.push(`Channel ${i + 1}: unknown attribute "${c?.attr}"`);
      if ((c?.attr === 'gobo' || c?.attr === 'colorWheel') && (!Array.isArray(c.slots) || !c.slots.length)) {
        errors.push(`Channel ${i + 1}: wheel channels need slots`);
      }
    });
  }
  return errors;
}
