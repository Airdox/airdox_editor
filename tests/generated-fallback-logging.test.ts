/** Generated waveform metadata fallbacks must remain visibly distinct from
 * decoded Rekordbox ANLZ waveform data. */
import assert from 'node:assert/strict';
import { generateAnalysisFromMetadata } from '../src/rekordbox/databaseExtractor';
import { DataOrigin } from '../src/types/rekordbox';
import { logger } from '../src/utils/logger';

const before = logger.getEntries().length;
const fallback = generateAnalysisFromMetadata(180, 128, [], 0, {
  reason: 'ANLZ DAT/EXT unavailable after a passed gate.',
  contentId: '4242',
  trackId: '4242',
  anlzWaveformAvailable: false,
});
const event = logger.getEntries().at(-1);

assert.equal(fallback.origin, DataOrigin.GENERATED_FALLBACK);
assert.equal(event?.level, 'WARN');
assert.equal(event?.category, 'DATABASE');
assert.equal(event?.message, '[WAVEFORM] Generated waveform fallback activated.');
assert.deepEqual(event?.details, {
  origin: DataOrigin.GENERATED_FALLBACK,
  reason: 'ANLZ DAT/EXT unavailable after a passed gate.',
  contentId: '4242',
  trackId: '4242',
  duration: 180,
  bpm: 128,
  cueCount: 0,
  anlzWaveformAvailable: false,
});
assert.equal(logger.getEntries().length, before + 1);

console.log('generated waveform fallback logging: OK');
