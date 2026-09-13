/**
 * Persistent Track ↔ Rekordbox ANLZ path index regression tests.
 *
 * The index is deliberately independent of Electron and SQLCipher so it can be
 * verified in Node. It stores only paths/compact IDs, never audio data or a
 * copy of master.db.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AnalysisPathRegistry, normalizePath } from '../electron/analysisRegistry.cjs';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airdox-analysis-index-'));
const indexPath = path.join(tempDir, 'rekordbox-analysis-path-index.json');

try {
  const index = new AnalysisPathRegistry(indexPath, { maxEntries: 20 });

  const registered = index.registerMany([
    {
      trackId: '101',
      mediaPath: 'C:\\Music\\Sets\\Voltage.wav',
      analysisPath: 'C:\\Users\\DJ\\AppData\\Roaming\\Pioneer\\rekordbox\\share\\ANLZ0000.DAT',
      sourceMediaPath: 'C:\\Music\\Sets\\Voltage.wav',
      title: 'Obsidian Voltage',
      artist: 'Klangfeld',
      sourceDuration: 376.25,
      source: 'MASTER_DB',
    },
    {
      // Same content ID on another device. The media path must keep these two
      // records separate and a media lookup must choose the right one.
      trackId: '101',
      mediaPath: '/Volumes/USB/Music/Voltage.wav',
      analysisPath: '/Volumes/USB/PIONEER/USBANLZ/ANLZ0001.EXT',
      title: 'Obsidian Voltage',
      artist: 'Klangfeld',
      source: 'ONE_LIBRARY',
    },
    { trackId: 'bad', mediaPath: '/music/a.wav', analysisPath: '/not/an-analysis.txt' },
  ]);

  assert.equal(registered.accepted, 2, 'two valid ANLZ paths are stored');
  assert.equal(registered.rejected, 1, 'non-ANLZ extension is rejected');
  assert.equal(registered.total, 2, 'index remains compact');
  assert.ok(fs.existsSync(indexPath), 'index is persisted atomically');

  const windowsMatch = index.find({ mediaPath: 'c:/music/sets/voltage.wav', trackId: '101' });
  assert.ok(windowsMatch, 'Windows media path resolves case/slash independently');
  assert.equal(windowsMatch.analysisPath.endsWith('.DAT'), true, 'exact media path wins');
  assert.equal(windowsMatch.matchScore, 125, 'media path and content ID contribute to confidence');

  const usbMatch = index.find({ mediaPath: '/Volumes/USB/Music/Voltage.wav', trackId: '101' });
  assert.ok(usbMatch, 'USB media path resolves');
  assert.equal(usbMatch.analysisPath.endsWith('.EXT'), true, 'USB mapping is not confused with local library');

  // Reload from disk: the second session does not have to read master.db.
  const reopened = new AnalysisPathRegistry(indexPath, { maxEntries: 20 });
  const recovered = reopened.find({
    trackId: '101',
    mediaPath: 'C:\\MUSIC\\SETS\\VOLTAGE.WAV',
    title: 'Obsidian Voltage',
    artist: 'Klangfeld',
  });
  assert.ok(recovered, 'persistent mapping is available after restart');
  assert.equal(recovered.analysisPath, windowsMatch.analysisPath, 'same native analysis path is recovered');
  assert.equal(recovered.sourceDuration, 376.25, 'native source duration survives a cache reopen');
  assert.equal(reopened.stats().entries, 2, 'reopened index has two compact entries');

  const replacement = reopened.registerMany([{
    trackId: '101',
    mediaPath: 'C:\\Music\\Sets\\Voltage.wav',
    analysisPath: 'C:\\Users\\DJ\\AppData\\Roaming\\Pioneer\\rekordbox\\share\\ANLZ0000.DAT',
    title: 'Obsidian Voltage (Remastered)',
    artist: 'Klangfeld',
    source: 'MANUAL_ANLZ',
  }]);
  assert.equal(replacement.updated, 1, 'the same path association updates instead of duplicating');
  assert.equal(replacement.total, 2, 'update does not grow the index');

  assert.equal(normalizePath('C:\\MUSIC\\x\\'), 'c:/music/x', 'normalizer handles Windows paths on every platform');
  console.log('analysis-path registry: 15 checks OK');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
