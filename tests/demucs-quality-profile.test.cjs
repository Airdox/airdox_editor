'use strict';

const assert = require('node:assert/strict');
const { buildDemucsArgs } = require('../electron/demucsRunner.cjs');

const previous = {
  shifts: process.env.DEMUCS_SHIFTS,
  overlap: process.env.DEMUCS_OVERLAP,
  device: process.env.DEMUCS_DEVICE,
};
delete process.env.DEMUCS_SHIFTS;
delete process.env.DEMUCS_OVERLAP;
delete process.env.DEMUCS_DEVICE;

const args = buildDemucsArgs('/tmp/finished-mix.wav', '/tmp/stems', 'htdemucs_ft');
const valueAfter = (flag) => args[args.indexOf(flag) + 1];
assert.equal(valueAfter('--name'), 'htdemucs_ft', 'fine-tuned four-model ensemble is mandatory by default');
assert.equal(valueAfter('--shifts'), '10', 'paper-grade equivariant stabilization must be enabled');
assert.equal(valueAfter('--overlap'), '0.5', 'split overlap must suppress boundary artefacts');
assert.ok(args.includes('--float32'), 'stem output must retain float32 precision');
assert.equal(valueAfter('--clip-mode'), 'rescale', 'hard digital clipping must not be used');
assert.equal(args.includes('--device'), false, 'hardware acceleration must be auto-detected');
assert.equal(args.at(-1), '/tmp/finished-mix.wav', 'only the finished song mix is supplied as model input');

process.env.DEMUCS_SHIFTS = '12';
process.env.DEMUCS_OVERLAP = '0.75';
process.env.DEMUCS_DEVICE = 'cuda';
const tuned = buildDemucsArgs('mix.wav', 'out', 'htdemucs_ft');
assert.equal(tuned[tuned.indexOf('--shifts') + 1], '12');
assert.equal(tuned[tuned.indexOf('--overlap') + 1], '0.75');
assert.equal(tuned[tuned.indexOf('--device') + 1], 'cuda');

for (const [key, value] of Object.entries({
  DEMUCS_SHIFTS: previous.shifts,
  DEMUCS_OVERLAP: previous.overlap,
  DEMUCS_DEVICE: previous.device,
})) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

console.log('Demucs maximum-quality profile: htdemucs_ft × 10 shifts, 50% overlap, float32 OK');
