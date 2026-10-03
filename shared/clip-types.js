// Timeline clip types and their parameters. The inspector UI is generated from these
// definitions, the evaluator reads the same parameter names, and validation uses the ranges.
//
// A clip that leaves an optional parameter unset does not touch that attribute, which is
// what lets a "colour only" clip on a higher track sit on top of a "dimmer only" clip below.
//
// Times in params are in beats (musical), clip start/end/fades are in milliseconds.

export const ORDER_OPTIONS = [
  ['x', 'Left to right'],
  ['list', 'Patch order'],
  ['center', 'Centre outward'],
];

const DIVISIONS = [
  [0.25, '1/16 (quarter beat)'],
  [1 / 3, '1/8 triplet (third of a beat)'],
  [0.5, '1/8 (half beat)'],
  [2 / 3, 'two triplets (2/3 beat)'],
  [1, '1/4 (one beat)'],
  [2, '1/2 (two beats)'],
  [4, '1 bar'],
  [8, '2 bars'],
];

const CYCLES = [
  [1, '1 beat'],
  [2, '2 beats'],
  [4, '1 bar'],
  [8, '2 bars'],
  [16, '4 bars'],
  [32, '8 bars'],
];

const intensity = { key: 'level', label: 'Intensity', type: 'range', min: 0, max: 1, step: 0.01, default: 1 };
const order = { key: 'order', label: 'Fixture order', type: 'select', options: ORDER_OPTIONS, default: 'x' };
const dimmerMode = {
  key: 'dimmerMode',
  label: 'Intensity mixing',
  type: 'select',
  options: [['htp', 'Highest wins (HTP)'], ['set', 'Override layers below']],
  default: 'htp',
};
const optionalColor = { key: 'color', label: 'Colour', type: 'color', default: [1, 1, 1], optional: true };

export const CLIP_TYPES = {
  static: {
    label: 'Look',
    hint: 'Holds intensity, colour, position and beam settings for the length of the clip.',
    color: '#4f8fe8',
    params: [
      { key: 'dimmer', label: 'Intensity', type: 'range', min: 0, max: 1, step: 0.01, default: 1, optional: true },
      dimmerMode,
      { ...optionalColor },
      {
        key: 'position',
        label: 'Position',
        type: 'select',
        options: [['', 'Leave as is'], ['aim', 'Aim at audience'], ['manual', 'Manual pan/tilt']],
        default: '',
      },
      { key: 'pan', label: 'Pan (deg)', type: 'number', min: -360, max: 360, step: 1, default: 0, showIf: (p) => p.position === 'manual' },
      { key: 'tilt', label: 'Tilt (deg)', type: 'number', min: -180, max: 180, step: 1, default: 0, showIf: (p) => p.position === 'manual' },
      { key: 'zoom', label: 'Zoom', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5, optional: true },
      { key: 'strobe', label: 'Strobe', type: 'range', min: 0, max: 1, step: 0.01, default: 0, optional: true },
      { key: 'gobo', label: 'Gobo slot', type: 'int', min: 0, max: 20, default: 0, optional: true },
      { key: 'prism', label: 'Prism', type: 'toggle', default: 1, optional: true },
    ],
  },
  pulse: {
    label: 'Pulse',
    hint: 'Intensity hits on a beat division with a decaying tail.',
    color: '#e8a33d',
    params: [
      { key: 'division', label: 'Every', type: 'select', options: DIVISIONS, default: 1, numeric: true },
      // 1 with "every 2 beats" = beats 2 and 4 (a backbeat); 0.5 = the off-beats.
      { key: 'offset', label: 'Offset (beats)', type: 'number', min: 0, max: 8, step: 0.25, default: 0 },
      { key: 'decay', label: 'Decay', type: 'range', min: 0.05, max: 1, step: 0.01, default: 0.6 },
      intensity,
      { key: 'spread', label: 'Phase spread', type: 'range', min: 0, max: 1, step: 0.01, default: 0 },
      order,
      dimmerMode,
      { ...optionalColor },
    ],
  },
  chase: {
    label: 'Chase',
    hint: 'Steps a lit group across the fixtures in time with the beat.',
    color: '#d9534f',
    params: [
      { key: 'step', label: 'Step every', type: 'select', options: DIVISIONS, default: 1, numeric: true },
      {
        key: 'direction',
        label: 'Direction',
        type: 'select',
        options: [['forward', 'Forward'], ['backward', 'Backward'], ['bounce', 'Bounce'], ['random', 'Random']],
        default: 'forward',
      },
      { key: 'width', label: 'Lit at once', type: 'int', min: 1, max: 64, default: 1 },
      { key: 'tail', label: 'Tail length', type: 'int', min: 0, max: 16, default: 0 },
      intensity,
      order,
      dimmerMode,
      { ...optionalColor },
    ],
  },
  strobe: {
    label: 'Strobe',
    hint: 'Strobes at the given speed; fixtures without a strobe channel are flashed in software.',
    color: '#f0f0f0',
    params: [
      { key: 'rate', label: 'Speed', type: 'range', min: 0.05, max: 1, step: 0.01, default: 0.7 },
      intensity,
      { ...optionalColor },
    ],
  },
  colorCycle: {
    label: 'Rainbow',
    hint: 'Rotates hue over time, spread across the fixtures.',
    color: '#a35be8',
    params: [
      { key: 'cycle', label: 'Cycle length', type: 'select', options: CYCLES, default: 16, numeric: true },
      { key: 'spread', label: 'Spread', type: 'range', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'saturation', label: 'Saturation', type: 'range', min: 0, max: 1, step: 0.01, default: 1 },
      order,
    ],
  },
  colorStep: {
    label: 'Colour steps',
    hint: 'Steps through a palette on the beat; alternate fixtures can be offset.',
    color: '#5bc0de',
    params: [
      { key: 'colors', label: 'Palette', type: 'colors', default: [[1, 0, 0], [0, 0.15, 1]] },
      { key: 'step', label: 'Change every', type: 'select', options: DIVISIONS, default: 4, numeric: true },
      { key: 'alternate', label: 'Alternate fixtures', type: 'toggle', default: 1 },
      order,
    ],
  },
  movement: {
    label: 'Movement',
    hint: 'Moving-head pattern around a centre point, phase-spread across the fixtures.',
    color: '#5cb85c',
    params: [
      {
        key: 'shape',
        label: 'Shape',
        type: 'select',
        options: [['circle', 'Circle'], ['figure8', 'Figure 8'], ['sweep', 'Pan sweep'], ['tilt', 'Tilt sweep'], ['ballyhoo', 'Ballyhoo']],
        default: 'circle',
      },
      { key: 'cycle', label: 'Cycle length', type: 'select', options: CYCLES, default: 8, numeric: true },
      { key: 'sizePan', label: 'Pan size (deg)', type: 'number', min: 0, max: 180, step: 1, default: 30 },
      { key: 'sizeTilt', label: 'Tilt size (deg)', type: 'number', min: 0, max: 90, step: 1, default: 20 },
      { key: 'spread', label: 'Phase spread', type: 'range', min: 0, max: 1, step: 0.01, default: 0.25 },
      {
        key: 'center',
        label: 'Centre',
        type: 'select',
        options: [['aim', 'Audience'], ['manual', 'Manual pan/tilt']],
        default: 'aim',
      },
      { key: 'pan', label: 'Centre pan (deg)', type: 'number', min: -360, max: 360, step: 1, default: 0, showIf: (p) => p.center === 'manual' },
      { key: 'tilt', label: 'Centre tilt (deg)', type: 'number', min: -180, max: 180, step: 1, default: 45, showIf: (p) => p.center === 'manual' },
      order,
    ],
  },
  keyframes: {
    label: 'Keyframes',
    hint: 'Hand-placed keyframes for intensity, colour, pan, tilt, zoom and strobe.',
    color: '#c7c7c7',
    params: [],
  },
};

export const KEYFRAME_PARAMS = {
  dimmer: { label: 'Intensity', kind: 'number', min: 0, max: 1, default: 1 },
  color: { label: 'Colour', kind: 'color', default: [1, 1, 1] },
  pan: { label: 'Pan (deg)', kind: 'number', min: -360, max: 360, default: 0 },
  tilt: { label: 'Tilt (deg)', kind: 'number', min: -180, max: 180, default: 0 },
  zoom: { label: 'Zoom', kind: 'number', min: 0, max: 1, default: 0.5 },
  strobe: { label: 'Strobe', kind: 'number', min: 0, max: 1, default: 0 },
};

export const EASINGS = [
  ['linear', 'Linear'],
  ['smooth', 'Smooth'],
  ['step', 'Step (hold)'],
];

/** Default params for a new clip of a type: required params only; optionals stay unset. */
export function defaultParams(type) {
  const def = CLIP_TYPES[type];
  const params = {};
  if (!def) return params;
  for (const p of def.params) {
    if (p.optional || p.showIf) continue;
    params[p.key] = structuredClone(p.default);
  }
  if (type === 'static') {
    params.dimmer = 1;
    params.color = [1, 1, 1];
  }
  if (type === 'keyframes') params.keys = { dimmer: [] };
  return params;
}
