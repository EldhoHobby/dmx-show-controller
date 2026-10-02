// Import fixture definitions from Open Fixture Library (open-fixture-library.org) JSON files.
// Download a fixture there in "Open Fixture Library JSON" format and load it in the Patch view.
//
// Supported: intensity, RGB/RGBW/RGBAW/UV/CMY colour mixing, pan/tilt (8 and 16 bit),
// shutter/strobe, colour and gobo wheels, prism, zoom. Every other channel is held at its
// default value. Pixel-matrix fixtures (matrix channel inserts) are not supported yet.

const COLOR_ATTR = {
  Red: 'red',
  Green: 'green',
  Blue: 'blue',
  White: 'white',
  'Warm White': 'white',
  'Cold White': 'white',
  Amber: 'amber',
  UV: 'uv',
  Cyan: 'cyan',
  Magenta: 'magenta',
  Yellow: 'yellow',
};

const slug = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'x';

function capsOf(def) {
  if (!def || typeof def !== 'object') return [];
  if (def.capability) return [{ dmxRange: [0, 255], ...def.capability }];
  return Array.isArray(def.capabilities) ? def.capabilities.filter((c) => c && typeof c === 'object') : [];
}

const rangeStart = (c) => (Array.isArray(c.dmxRange) ? c.dmxRange[0] : 0);
const rangeMid = (c) => (Array.isArray(c.dmxRange) ? Math.round((c.dmxRange[0] + c.dmxRange[1]) / 2) : 0);

function parseAngle(v) {
  const m = /^(-?\d+(?:\.\d+)?)deg$/.exec(String(v ?? ''));
  return m ? Number(m[1]) : null;
}

function angleSpan(cap) {
  const a = parseAngle(cap.angleStart ?? cap.angle);
  const b = parseAngle(cap.angleEnd ?? cap.angle);
  return a != null && b != null && b !== a ? Math.abs(b - a) : null;
}

function wheelSlots(ofl, wheelName, caps, kind) {
  const wheel = ofl.wheels?.[wheelName];
  const slots = [];
  for (const c of caps) {
    if (c.type !== 'WheelSlot' || !Number.isInteger(c.slotNumber)) continue;
    const def = wheel?.slots?.[c.slotNumber - 1] || {};
    const name = def.name || (def.type === 'Open' ? 'Open' : `${kind === 'colorWheel' ? 'Colour' : 'Gobo'} ${c.slotNumber}`);
    const slot = { name, dmx: rangeMid(c) };
    if (kind === 'colorWheel') {
      const hex = Array.isArray(def.colors) ? def.colors[0] : null;
      slot.color = hex ? hexToRgb(hex) : [1, 1, 1];
    }
    slots.push(slot);
  }
  return slots;
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex));
  if (!m) return [1, 1, 1];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Classify one OFL channel into a profile channel definition. */
function convertChannel(ofl, key, def, info) {
  const caps = capsOf(def);
  const label = key;
  const fixed = () => ({ attr: 'fixed', value: Number.isFinite(def?.defaultValue) ? def.defaultValue : 0, label });
  if (!caps.length) return fixed();
  const types = new Set(caps.map((c) => c.type));

  if (types.has('Pan') || types.has('Tilt')) {
    const isPan = types.has('Pan');
    const cap = caps.find((c) => c.type === (isPan ? 'Pan' : 'Tilt'));
    const span = angleSpan(cap);
    if (span) info[isPan ? 'panRange' : 'tiltRange'] = span;
    return { attr: isPan ? 'pan' : 'tilt', label };
  }
  if (types.has('ColorIntensity')) {
    const attr = COLOR_ATTR[caps.find((c) => c.type === 'ColorIntensity').color];
    if (attr && !info.usedColors.has(attr)) {
      info.usedColors.add(attr);
      return { attr, label };
    }
    return fixed();
  }
  if (types.has('Intensity') && caps.length <= 2) {
    const cap = caps.find((c) => c.type === 'Intensity');
    const [lo, hi] = Array.isArray(cap.dmxRange) ? cap.dmxRange : [0, 255];
    const ch = { attr: 'dimmer', label };
    if (lo !== 0 || hi !== 255) Object.assign(ch, { min: lo, max: hi });
    return ch;
  }
  if (types.has('ShutterStrobe')) {
    const open = caps.find((c) => c.type === 'ShutterStrobe' && (c.shutterEffect === 'Open' || c.shutterEffect === 'On'));
    const strobe = caps.find((c) => c.type === 'ShutterStrobe' && c.shutterEffect === 'Strobe' && Array.isArray(c.dmxRange));
    const openValue = open ? rangeMid(open) : 0;
    if (!strobe) return { attr: 'fixed', value: openValue, label: `${label} (open)` };
    const [a, b] = strobe.dmxRange;
    const slowFirst = strobe.speedStart !== 'fast';
    return { attr: 'strobe', off: openValue, min: slowFirst ? a : b, max: slowFirst ? b : a, label };
  }
  if (types.has('StrobeSpeed')) {
    const cap = caps.find((c) => c.type === 'StrobeSpeed');
    const [a, b] = Array.isArray(cap.dmxRange) ? cap.dmxRange : [0, 255];
    return { attr: 'strobe', off: 0, min: Math.max(1, a), max: b, label };
  }
  if (types.has('WheelSlot')) {
    const wheelName = caps.find((c) => c.type === 'WheelSlot').wheel || key;
    const wheel = ofl.wheels?.[wheelName];
    const isColor = wheel?.slots?.some((s) => s.type === 'Color');
    const attr = isColor ? 'colorWheel' : 'gobo';
    if (info.usedWheels.has(attr)) return fixed();
    const slots = wheelSlots(ofl, wheelName, caps, attr);
    if (!slots.length) return fixed();
    info.usedWheels.add(attr);
    return { attr, slots, label };
  }
  if (types.has('Prism')) {
    const off = caps.find((c) => c.type === 'NoFunction');
    const on = caps.find((c) => c.type === 'Prism');
    return { attr: 'prism', off: off ? rangeStart(off) : 0, on: rangeMid(on), label };
  }
  if (types.has('Zoom')) return { attr: 'zoom', label };
  if (types.has('Intensity')) return { attr: 'dimmer', label };
  return fixed();
}

export function oflModes(ofl) {
  if (!ofl || !Array.isArray(ofl.modes)) return [];
  return ofl.modes.map((m, index) => ({
    index,
    name: m.name || `Mode ${index + 1}`,
    shortName: m.shortName || m.name || `${index + 1}`,
    channelCount: Array.isArray(m.channels) ? m.channels.length : 0,
  }));
}

/** Convert an OFL fixture (parsed JSON) to a profile for one of its modes. */
export function importOflFixture(ofl, { modeIndex = 0, manufacturer = '' } = {}) {
  if (!ofl || typeof ofl !== 'object' || !ofl.availableChannels || !Array.isArray(ofl.modes)) {
    throw new Error('This is not an Open Fixture Library fixture file (no channels or modes found).');
  }
  const mode = ofl.modes[modeIndex];
  if (!mode || !Array.isArray(mode.channels) || !mode.channels.length) throw new Error('That fixture mode has no channels.');
  if (mode.channels.some((c) => c && typeof c === 'object')) {
    throw new Error('Pixel-matrix fixtures are not supported yet. Choose a non-pixel mode, or patch the cells as separate fixtures.');
  }

  // Fine channel aliases ("Pan fine") point back at their coarse channel.
  const fineOf = new Map();
  for (const [key, def] of Object.entries(ofl.availableChannels)) {
    for (const alias of def?.fineChannelAliases || []) fineOf.set(alias, key);
  }

  const info = { usedColors: new Set(), usedWheels: new Set() };
  const converted = new Map();
  const channels = mode.channels.map((key) => {
    if (key == null) return { attr: 'fixed', value: 0, label: 'Unused' };
    if (fineOf.has(key)) {
      const coarse = fineOf.get(key);
      const base = converted.get(coarse) || convertChannel(ofl, coarse, ofl.availableChannels[coarse], info);
      if (base.attr === 'pan' || base.attr === 'tilt' || base.attr === 'dimmer' || base.attr === 'zoom') {
        return { attr: base.attr, fine: true, label: key };
      }
      return { attr: 'fixed', value: 0, label: key };
    }
    const def = ofl.availableChannels[key];
    if (!def) return { attr: 'fixed', value: 0, label: String(key) };
    const ch = convertChannel(ofl, key, def, info);
    converted.set(key, ch);
    return ch;
  });

  // A fine channel only counts when its coarse partner is in this mode.
  const coarseAttrs = new Set(channels.filter((c) => !c.fine).map((c) => c.attr));
  const finalChannels = channels.map((c) => (c.fine && !coarseAttrs.has(c.attr) ? { attr: 'fixed', value: 0, label: c.label } : c));

  const categories = Array.isArray(ofl.categories) ? ofl.categories : [];
  const kind = categories.includes('Moving Head') || categories.includes('Scanner')
    ? 'moving-head'
    : categories.includes('Strobe')
      ? 'strobe'
      : categories.includes('Dimmer')
        ? 'dimmer'
        : categories.includes('Color Changer')
          ? 'par'
          : 'other';
  const maker = manufacturer || ofl.manufacturer?.name || ofl.manufacturerKey || 'Imported';
  const profile = {
    id: `ofl/${slug(maker)}/${slug(ofl.name)}/${slug(mode.shortName || mode.name)}`,
    name: `${ofl.name} (${mode.shortName || mode.name})`,
    manufacturer: maker,
    kind,
    source: 'Open Fixture Library',
    channels: finalChannels,
  };
  const lens = ofl.physical?.lens?.degreesMinMax;
  if (Array.isArray(lens) && lens.length === 2) {
    if (lens[0] !== lens[1]) profile.zoomRange = [lens[0], lens[1]];
    else profile.beamAngle = lens[0];
  }
  profile.panRange = info.panRange || ofl.physical?.focus?.panMax || undefined;
  profile.tiltRange = info.tiltRange || ofl.physical?.focus?.tiltMax || undefined;
  if (!profile.panRange) delete profile.panRange;
  if (!profile.tiltRange) delete profile.tiltRange;
  return profile;
}
