import test from 'node:test';
import assert from 'node:assert/strict';
import { importOflFixture, oflModes } from '../shared/ofl-import.js';
import { checkProfile, profileCaps } from '../shared/fixture-library.js';

// A representative Open Fixture Library definition (schema-shaped, hand-written for the test).
const SPOT = {
  name: 'Test Spot 150',
  categories: ['Moving Head'],
  physical: { lens: { degreesMinMax: [12, 12] }, focus: { type: 'Head', panMax: 540, tiltMax: 270 } },
  wheels: {
    'Color Wheel': { slots: [{ type: 'Open' }, { type: 'Color', name: 'Red', colors: ['#ff0000'] }, { type: 'Color', name: 'Blue', colors: ['#0000ff'] }] },
    'Gobo Wheel': { slots: [{ type: 'Open' }, { type: 'Gobo', name: 'Dots' }, { type: 'Gobo', name: 'Star' }] },
  },
  availableChannels: {
    Pan: { fineChannelAliases: ['Pan fine'], capability: { type: 'Pan', angleStart: '0deg', angleEnd: '540deg' } },
    Tilt: { fineChannelAliases: ['Tilt fine'], capability: { type: 'Tilt', angleStart: '0deg', angleEnd: '270deg' } },
    'Pan/Tilt Speed': { capability: { type: 'PanTiltSpeed', speedStart: 'fast', speedEnd: 'slow' } },
    'Color Wheel': {
      capabilities: [
        { dmxRange: [0, 15], type: 'WheelSlot', slotNumber: 1 },
        { dmxRange: [16, 31], type: 'WheelSlot', slotNumber: 2 },
        { dmxRange: [32, 47], type: 'WheelSlot', slotNumber: 3 },
        { dmxRange: [48, 255], type: 'WheelRotation', speedStart: 'slow CW', speedEnd: 'fast CW' },
      ],
    },
    'Gobo Wheel': {
      capabilities: [
        { dmxRange: [0, 9], type: 'WheelSlot', slotNumber: 1 },
        { dmxRange: [10, 19], type: 'WheelSlot', slotNumber: 2 },
        { dmxRange: [20, 29], type: 'WheelSlot', slotNumber: 3 },
        { dmxRange: [30, 255], type: 'WheelShake', slotNumber: 2 },
      ],
    },
    Shutter: {
      capabilities: [
        { dmxRange: [0, 7], type: 'ShutterStrobe', shutterEffect: 'Closed' },
        { dmxRange: [8, 15], type: 'ShutterStrobe', shutterEffect: 'Open' },
        { dmxRange: [16, 131], type: 'ShutterStrobe', shutterEffect: 'Strobe', speedStart: 'slow', speedEnd: 'fast' },
        { dmxRange: [132, 255], type: 'ShutterStrobe', shutterEffect: 'Open' },
      ],
    },
    Dimmer: { capability: { type: 'Intensity' } },
    Prism: { capabilities: [{ dmxRange: [0, 127], type: 'NoFunction' }, { dmxRange: [128, 255], type: 'Prism' }] },
  },
  modes: [
    { name: '11-channel', shortName: '11ch', channels: ['Pan', 'Pan fine', 'Tilt', 'Tilt fine', 'Pan/Tilt Speed', 'Color Wheel', 'Gobo Wheel', 'Shutter', 'Dimmer', 'Prism', null] },
    { name: '8-channel', shortName: '8ch', channels: ['Pan', 'Tilt', 'Color Wheel', 'Gobo Wheel', 'Shutter', 'Dimmer', 'Prism', 'Pan/Tilt Speed'] },
  ],
};

const PAR = {
  name: 'Test Par RGBWA+UV',
  categories: ['Color Changer'],
  availableChannels: {
    Dimmer: { capability: { type: 'Intensity' } },
    Red: { capability: { type: 'ColorIntensity', color: 'Red' } },
    Green: { capability: { type: 'ColorIntensity', color: 'Green' } },
    Blue: { capability: { type: 'ColorIntensity', color: 'Blue' } },
    White: { capability: { type: 'ColorIntensity', color: 'White' } },
    Amber: { capability: { type: 'ColorIntensity', color: 'Amber' } },
    UV: { capability: { type: 'ColorIntensity', color: 'UV' } },
    Strobe: { capabilities: [{ dmxRange: [0, 10], type: 'ShutterStrobe', shutterEffect: 'Open' }, { dmxRange: [11, 255], type: 'ShutterStrobe', shutterEffect: 'Strobe', speedStart: 'slow', speedEnd: 'fast' }] },
  },
  modes: [{ name: '8-channel', shortName: '8ch', channels: ['Dimmer', 'Red', 'Green', 'Blue', 'White', 'Amber', 'UV', 'Strobe'] }],
};

test('OFL moving head: 16-bit pan/tilt, wheels, shutter, prism', () => {
  assert.deepEqual(oflModes(SPOT).map((m) => m.channelCount), [11, 8]);
  const p = importOflFixture(SPOT, { modeIndex: 0, manufacturer: 'Acme' });
  assert.deepEqual(checkProfile(p), []);
  assert.equal(p.id, 'ofl/acme/test-spot-150/11ch');
  assert.equal(p.kind, 'moving-head');
  assert.equal(p.panRange, 540);
  assert.equal(p.tiltRange, 270);
  assert.equal(p.beamAngle, 12);
  const attrs = p.channels.map((c) => (c.fine ? `${c.attr}+` : c.attr));
  assert.deepEqual(attrs, ['pan', 'pan+', 'tilt', 'tilt+', 'fixed', 'colorWheel', 'gobo', 'strobe', 'dimmer', 'prism', 'fixed']);
  const wheel = p.channels[5];
  assert.deepEqual(wheel.slots.map((s) => s.name), ['Open', 'Red', 'Blue']);
  assert.deepEqual(wheel.slots[1].color, [1, 0, 0]);
  const shutter = p.channels[7];
  assert.equal(shutter.off, 12, 'open value used when not strobing');
  assert.equal(shutter.min, 16);
  assert.equal(shutter.max, 131);
  assert.equal(p.channels[9].on, 192);
  const caps = profileCaps(p);
  assert.ok(caps.panTilt && caps.pan16 && caps.strobe && caps.gobo && caps.prism);
  assert.equal(caps.color, 'wheel');
});

test('OFL 8-bit mode drops fine channels', () => {
  const p = importOflFixture(SPOT, { modeIndex: 1 });
  assert.equal(p.channels.filter((c) => c.fine).length, 0);
  assert.equal(p.channels.length, 8);
});

test('OFL colour mixing par maps every LED colour', () => {
  const p = importOflFixture(PAR);
  assert.deepEqual(p.channels.map((c) => c.attr), ['dimmer', 'red', 'green', 'blue', 'white', 'amber', 'uv', 'strobe']);
  assert.equal(profileCaps(p).color, 'rgb');
  assert.equal(p.kind, 'par');
});

test('OFL import rejects non-fixture JSON and a matrix insert without a matrix', () => {
  assert.throws(() => importOflFixture({ hello: 1 }), /not an Open Fixture Library/);
  const matrix = { ...PAR, modes: [{ name: 'Pixel', channels: [{ insert: 'matrixChannels' }] }] };
  assert.throws(() => importOflFixture(matrix), /unsupported channel insert/);
});

// A pixel bar the way Open Fixture Library describes one: a matrix of pixels and template
// channels that a mode repeats for every pixel.
const RGB_TEMPLATES = ['Red $pixelKey', 'Green $pixelKey', 'Blue $pixelKey'];
const BAR = {
  name: 'Test Pixel Bar',
  categories: ['Pixel Bar', 'Color Changer'],
  physical: { dimensions: [1000, 60, 80], lens: { degreesMinMax: [30, 30] } },
  matrix: { pixelCount: [12, 1, 1] },
  availableChannels: {
    Dimmer: { capability: { type: 'Intensity' } },
    Strobe: {
      capabilities: [
        { dmxRange: [0, 9], type: 'ShutterStrobe', shutterEffect: 'Open' },
        { dmxRange: [10, 255], type: 'ShutterStrobe', shutterEffect: 'Strobe', speedStart: 'slow', speedEnd: 'fast' },
      ],
    },
  },
  templateChannels: {
    'Red $pixelKey': { capability: { type: 'ColorIntensity', color: 'Red' } },
    'Green $pixelKey': { capability: { type: 'ColorIntensity', color: 'Green' } },
    'Blue $pixelKey': { capability: { type: 'ColorIntensity', color: 'Blue' } },
  },
  modes: [
    { name: '38-channel', shortName: '38ch', channels: ['Dimmer', 'Strobe', { insert: 'matrixChannels', repeatFor: 'eachPixelABC', channelOrder: 'perPixel', templateChannels: RGB_TEMPLATES }] },
    { name: 'By colour', shortName: '36ch', channels: [{ insert: 'matrixChannels', repeatFor: 'eachPixelXYZ', channelOrder: 'perChannel', templateChannels: RGB_TEMPLATES }] },
    { name: 'Single pixel', shortName: '3ch', channels: ['Red 1', 'Green 1', 'Blue 1'] },
  ],
};

test('OFL pixel bars import as cells: one RGB triple per pixel, in pixel order', () => {
  const p = importOflFixture(BAR, { modeIndex: 0 });
  assert.deepEqual(checkProfile(p), []);
  assert.equal(p.kind, 'pixel');
  assert.equal(p.channels.length, 38);
  assert.equal(profileCaps(p).cells, 12);
  assert.equal(p.length, 1, 'bar length from the physical width');
  assert.deepEqual(p.channels.slice(0, 2).map((c) => [c.attr, c.cell]), [['dimmer', undefined], ['strobe', undefined]]);
  // Pixels 1..12 in natural order (not 1, 10, 11, 12, 2...), each R, G, B.
  assert.deepEqual(p.channels.slice(2, 8).map((c) => [c.attr, c.cell]), [['red', 0], ['green', 0], ['blue', 0], ['red', 1], ['green', 1], ['blue', 1]]);
  assert.deepEqual(p.channels.slice(-3).map((c) => [c.attr, c.cell]), [['red', 11], ['green', 11], ['blue', 11]]);
});

test('OFL pixel modes ordered by colour, 2D panels, and single-pixel modes', () => {
  const byColour = importOflFixture(BAR, { modeIndex: 1 });
  assert.deepEqual(byColour.channels.slice(0, 3).map((c) => [c.attr, c.cell]), [['red', 0], ['red', 1], ['red', 2]]);
  assert.deepEqual([byColour.channels[12].attr, byColour.channels[12].cell], ['green', 0]);
  const single = importOflFixture(BAR, { modeIndex: 2 });
  assert.deepEqual(single.channels.map((c) => [c.attr, c.cell]), [['red', 0], ['green', 0], ['blue', 0]]);
  const panel = importOflFixture({ ...BAR, matrix: { pixelCount: [4, 2, 1] }, modes: [{ name: 'Panel', channels: [{ insert: 'matrixChannels', repeatFor: 'eachPixelXYZ', channelOrder: 'perPixel', templateChannels: RGB_TEMPLATES }] }] });
  assert.equal(profileCaps(panel).cells, 8);
  assert.deepEqual(panel.cellGrid, [4, 2]);
  assert.equal(panel.channels[3 * 4].cell, 4, 'the second row starts at the fifth pixel');
});
