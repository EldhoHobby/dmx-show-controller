// Import fixture definitions from Open Fixture Library (open-fixture-library.org) JSON files.
// Download a fixture there in "Open Fixture Library JSON" format and load it in the Patch view.
//
// Supported: intensity, RGB/RGBW/RGBAW/UV/CMY colour mixing, pan/tilt (8 and 16 bit),
// shutter/strobe, colour and gobo wheels, prism, zoom. Every other channel is held at its
// default value. Pixel fixtures (OFL "matrix" with template channels) become cells: every
// pixel's channels get a cell number, so effects run across the pixels.

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
    // Span every Intensity capability rather than just the first. A dimmer written as an
    // "off" range plus a fade range (0-9 off, 10-255 fade) would otherwise take 0-9 as the
    // whole channel, so full intensity sent DMX 9 and the light never came on at any level.
    const intensity = caps.filter((c) => c.type === 'Intensity');
    const isOff = (c) => c.brightness === 'off' || (c.brightnessStart === 'off' && c.brightnessEnd === 'off');
    const span = intensity.filter((c) => !isOff(c));
    const ranges = (span.length ? span : intensity).map((c) => (Array.isArray(c.dmxRange) ? c.dmxRange : [0, 255]));
    const lo = Math.min(...ranges.map((r) => r[0]));
    const hi = Math.max(...ranges.map((r) => r[1]));
    const ch = { attr: 'dimmer', label };
    if (lo !== 0 || hi !== 255) Object.assign(ch, { min: lo, max: hi });
    // Where the file declares an explicit off band, intensity 0 goes there instead of to the
    // bottom of the fade range, which on these fixtures is a faint glow rather than dark.
    const offCap = intensity.find((c) => isOff(c) && Array.isArray(c.dmxRange));
    if (offCap && span.length) ch.off = offCap.dmxRange[0];
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

// ---- Pixel matrices --------------------------------------------------------------------

/**
 * The pixels of an OFL matrix with their grid positions, x fastest (row by row). Keys are the
 * matrix's own, or generated from pixelCount the way OFL does: "1", "2"... for a line,
 * "(x, y)" for a grid, "(x, y, z)" for a cube.
 */
export function matrixPixels(ofl) {
  const m = ofl?.matrix;
  if (!m || typeof m !== 'object') return [];
  const out = [];
  if (Array.isArray(m.pixelKeys)) {
    m.pixelKeys.forEach((plane, z) => (Array.isArray(plane) ? plane : []).forEach((row, y) => (Array.isArray(row) ? row : []).forEach((key, x) => {
      if (key != null) out.push({ key: String(key), x, y, z });
    })));
    return out;
  }
  if (!Array.isArray(m.pixelCount)) return [];
  const [nx = 1, ny = 1, nz = 1] = m.pixelCount.map((n) => Math.max(1, Math.round(n) || 1));
  const axes = [nx, ny, nz].filter((n) => n > 1).length;
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const used = [[nx, x], [ny, y], [nz, z]].filter(([n]) => n > 1).map(([, i]) => i + 1);
        const key = axes <= 1 ? String(x + y + z + 1) : axes === 2 ? `(${used[0]}, ${used[1]})` : `(${x + 1}, ${y + 1}, ${z + 1})`;
        out.push({ key, x, y, z });
      }
    }
  }
  return out;
}

/** Pixel (or pixel group) keys in the order a matrix channel insert repeats its channels. */
function repeatOrder(repeatFor, pixels, matrix) {
  if (Array.isArray(repeatFor)) return repeatFor.map(String);
  if (repeatFor === 'eachPixelGroup') return Object.keys(matrix?.pixelGroups || {});
  if (repeatFor === 'eachPixelABC') return pixels.map((p) => p.key).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const axes = /^eachPixel([XYZ]{3})$/.exec(repeatFor || '');
  if (axes) {
    // "XYZ": x changes fastest, then y, then z.
    const order = axes[1].toLowerCase().split('').reverse();
    return pixels
      .slice()
      .sort((a, b) => order.reduce((d, axis) => d || a[axis] - b[axis], 0))
      .map((p) => p.key);
  }
  return pixels.map((p) => p.key);
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
  // Fine channel aliases ("Pan fine") point back at their coarse channel.
  const fineOf = new Map();
  for (const [key, def] of Object.entries(ofl.availableChannels)) {
    for (const alias of def?.fineChannelAliases || []) fineOf.set(alias, key);
  }

  // Pixel fixtures: every template channel ("Red $pixelKey") resolved for every pixel ("Red 1").
  const pixels = matrixPixels(ofl);
  const cellOf = new Map(pixels.map((p, i) => [p.key, i]));
  const resolved = new Map();
  for (const [tkey, def] of Object.entries(ofl.templateChannels || {})) {
    const keys = [...pixels.map((p) => p.key), ...Object.keys(ofl.matrix?.pixelGroups || {})];
    for (const pk of keys) {
      const key = tkey.replace(/\$pixelKey/g, pk);
      resolved.set(key, { def, cell: cellOf.get(pk) });
      for (const alias of def?.fineChannelAliases || []) fineOf.set(alias.replace(/\$pixelKey/g, pk), key);
    }
  }
  const defOf = (key) => ofl.availableChannels[key] || resolved.get(key)?.def;

  // The mode's channel list, with matrix inserts expanded pixel by pixel (or channel by channel).
  const modeKeys = [];
  for (const entry of mode.channels) {
    if (entry && typeof entry === 'object') {
      if (entry.insert !== 'matrixChannels' || !pixels.length) throw new Error(`This fixture mode uses an unsupported channel insert ("${entry.insert}").`);
      const order = repeatOrder(entry.repeatFor, pixels, ofl.matrix);
      const templates = Array.isArray(entry.templateChannels) ? entry.templateChannels : [];
      const name = (t, pk) => (t == null ? null : String(t).replace(/\$pixelKey/g, pk));
      if (entry.channelOrder === 'perChannel') for (const t of templates) for (const pk of order) modeKeys.push(name(t, pk));
      else for (const pk of order) for (const t of templates) modeKeys.push(name(t, pk));
    } else {
      modeKeys.push(entry);
    }
  }
  if (modeKeys.length > 512) throw new Error(`That fixture mode has ${modeKeys.length} channels; a universe holds 512.`);

  // Colours are claimed once per fixture, or once per pixel for pixel channels.
  const info = { usedColors: new Set(), usedWheels: new Set() };
  const cellInfo = new Map();
  const infoFor = (cell) => {
    if (cell == null) return info;
    // Each cell gets its own sets. Spreading `info` shared its usedWheels by reference, so
    // one pixel claiming a wheel slot blocked every other pixel from claiming its own. It
    // also snapshotted panRange/tiltRange before they were necessarily written.
    if (!cellInfo.has(cell)) cellInfo.set(cell, { usedColors: new Set(), usedWheels: new Set() });
    return cellInfo.get(cell);
  };
  const converted = new Map();
  const channels = modeKeys.map((key) => {
    if (key == null) return { attr: 'fixed', value: 0, label: 'Unused' };
    const cell = resolved.get(key)?.cell ?? resolved.get(fineOf.get(key))?.cell;
    const withCell = (ch) => (cell == null || ch.attr === 'fixed' ? ch : { ...ch, cell });
    if (fineOf.has(key)) {
      const coarse = fineOf.get(key);
      const base = converted.get(coarse) || convertChannel(ofl, coarse, defOf(coarse), infoFor(cell));
      if (base.attr === 'pan' || base.attr === 'tilt' || base.attr === 'dimmer' || base.attr === 'zoom') {
        return withCell({ attr: base.attr, fine: true, label: key });
      }
      return { attr: 'fixed', value: 0, label: key };
    }
    const def = defOf(key);
    if (!def) return { attr: 'fixed', value: 0, label: String(key) };
    const ch = withCell(convertChannel(ofl, key, def, infoFor(cell)));
    converted.set(key, ch);
    return ch;
  });

  // A fine channel only counts when its coarse partner is in this mode.
  const coarseAttrs = new Set(channels.filter((c) => !c.fine).map((c) => c.attr));
  const finalChannels = channels.map((c) => (c.fine && !coarseAttrs.has(c.attr) ? { attr: 'fixed', value: 0, label: c.label } : c));

  const categories = Array.isArray(ofl.categories) ? ofl.categories : [];
  const kind = pixels.length >= 2 && channels.some((c) => c.cell != null)
    ? 'pixel'
    : categories.includes('Moving Head') || categories.includes('Scanner')
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
  if (kind === 'pixel') {
    const xs = new Set(pixels.map((p) => p.x)).size;
    if (xs < pixels.length) profile.cellGrid = [xs, Math.ceil(pixels.length / xs)];
    const width = ofl.physical?.dimensions?.[0];
    if (width > 0) profile.length = width / 1000;
  }
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
