import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { _sha256ForTests as sha256 } from '../client/lib/audio.js';

const hex = (bytes) => Buffer.from(bytes).toString('hex');

test('fallback SHA-256 (used by LAN windows without Web Crypto) matches Node crypto', () => {
  const inputs = [
    new Uint8Array(0),
    new TextEncoder().encode('abc'),
    new Uint8Array(55).fill(7), // padding edge: exactly one block
    new Uint8Array(56).fill(7), // padding edge: spills into a second block
    new Uint8Array(64).fill(255),
    crypto.randomBytes(100000),
  ];
  for (const input of inputs) {
    assert.equal(hex(sha256(input)), crypto.createHash('sha256').update(input).digest('hex'), `length ${input.length}`);
  }
});
