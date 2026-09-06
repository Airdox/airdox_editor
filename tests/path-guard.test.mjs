/**
 * @license
 * Phase 4 – Original-source overwrite guard regression suite.
 *
 * Verifies the single hard rule of the desktop write path: a chosen save
 * target must never equal an original Rekordbox source (audio/XML/ANLZ/DB)
 * path. The comparison is case- and separator-insensitive so a Windows export
 * cannot overwrite an original through casing alone.
 *
 * Run with: node tests/path-guard.test.mjs
 */

import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isProtectedTarget, normalizeForCompare } = require('../electron/pathGuard.cjs');

const protectedPaths = [
  'C:\\Music\\Track.wav',
  'D:\\Rekordbox\\collection.xml',
  'E:\\Pioneer\\master.db',
];

// Exact matches are refused.
assert.strictEqual(isProtectedTarget('C:\\Music\\Track.wav', protectedPaths), true);
assert.strictEqual(isProtectedTarget('D:\\Rekordbox\\collection.xml', protectedPaths), true);
assert.strictEqual(isProtectedTarget('E:\\Pioneer\\master.db', protectedPaths), true);

// Case and separator differences still refuse (fail-closed).
assert.strictEqual(isProtectedTarget('c:\\music\\track.WAV', protectedPaths), true);
assert.strictEqual(isProtectedTarget('C:/Music/Track.wav', protectedPaths), true);
assert.strictEqual(isProtectedTarget('d:\\rekordbox\\COLLECTION.XML', protectedPaths), true);

// New, non-original targets are allowed.
assert.strictEqual(isProtectedTarget('C:\\Music\\Track_EDIT_MASTER.wav', protectedPaths), false);
assert.strictEqual(isProtectedTarget('C:\\Exports\\master.wav', protectedPaths), false);
assert.strictEqual(isProtectedTarget('D:\\Rekordbox\\collection_edit.xml', protectedPaths), false);

// Empty / missing protected lists never block.
assert.strictEqual(isProtectedTarget('C:\\Music\\Track.wav', []), false);
assert.strictEqual(isProtectedTarget('C:\\Music\\Track.wav', null), false);
assert.strictEqual(isProtectedTarget('C:\\Music\\Track.wav', ['', '  ']), false);

// Normalization is stable for cross-platform paths.
assert.strictEqual(normalizeForCompare('C:\\Music\\Track.wav'), normalizeForCompare('c:/music/track.wav'));

console.log('path overwrite guard: OK');
