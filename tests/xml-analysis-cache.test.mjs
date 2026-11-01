import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AnalysisPathRegistry } from '../electron/analysisRegistry.cjs';

const directory = await mkdtemp(path.join(os.tmpdir(), 'xml-library-cache-'));
try {
  const filename = path.join(directory, 'index.json');
  const registry = new AnalysisPathRegistry(filename);
  registry.registerMany([{ trackId: 'reused-id', mediaPath: 'E:/old.mp3', analysisPath: 'E:/ANLZ0000.DAT', source: 'MASTER_DB' }]);
  assert.ok(registry.find({ trackId: 'reused-id' }));
  assert.equal(registry.clear().entries, 0);
  assert.equal(registry.find({ trackId: 'reused-id' }), null);
  assert.equal(new AnalysisPathRegistry(filename).find({ trackId: 'reused-id' }), null);
  registry.registerMany([{ trackId: 'reused-id', mediaPath: 'E:/new.mp3', analysisPath: 'E:/ANLZ0001.DAT', source: 'MASTER_DB' }]);
  assert.equal(registry.find({ mediaPath: 'E:/old.mp3', requireExactMediaPath: true }), null);
  assert.equal(registry.find({ mediaPath: 'E:/new.mp3', requireExactMediaPath: true })?.analysisPath, 'E:/ANLZ0001.DAT');
  console.log('XML collection replacement invalidates persisted paths; reused IDs cannot restore the removed source');
} finally { await rm(directory, { recursive: true, force: true }); }
