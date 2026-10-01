/**
 * @license
 * Rekordbox-Track-Import-Pipeline (Phase 5) – Vertrags- und Kettentests.
 *
 * Was hier bewiesen wird (Plan A–G):
 *
 *   A  Track-Import läuft ohne jeden XML-Dateidialog (eingebettete XML).
 *   B  Die echte rekordbox_export2.xml ist die Quelle (12.246 Tracks,
 *      TrackID + file://localhost-Locations vorhanden).
 *   C  Die Kette TrackID → master.db ist verbindlich verdrahtet:
 *      preload → main → electron/masterDbGate.cjs (alle 11 Codes).
 *   E  Der Lade-Pfad erzwingt `origin === REKORDBOX_ANLZ` und den
 *      REKORDBOX_WAVEFORM_MISSING-/ORIGINAL_AUDIO_NOT_FOUND-Fehlerpfad.
 *   G  handleSelectTrackFromXml enthält KEINEN analyzeAudioBuffer-/
 *      LOCAL_ANALYSIS-Fallback.
 *      + Windows-Paketierung: die XML steht in den electron-builder
 *        extraResources und wird über readBundledRekordboxXml gelesen.
 *
 * Der echte GUI-Lauf (App öffnen, Button klicken) ist in dieser Node-Suite
 * nicht möglich; diese Datei prüft stattdessen die vollständige Verdrahtung
 * und die Verweigerung der verbotenen Fallback-Pfade im Quelltext.
 *
 * Run with: npx tsx tests/rekordbox-track-import-pipeline.test.ts
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string) => readFile(`${root}${relative}`.replace(/\/+/g, '/'), 'utf8');

const appSource = await read('src/App.tsx');
const menuBarSource = await read('src/components/MenuBar.tsx');
const preloadSource = await read('electron/preload.cjs');
const mainSource = await read('electron/main.cjs');
const desktopTypes = await read('src/types/desktop.d.ts');
const bundledCollectionSource = await read('src/rekordbox/bundledCollection.ts');
const packageJson = JSON.parse(await read('package.json'));

function sliceBetween(source: string, startMarker: string, endMarker: string, label: string): string {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `${label}: start marker not found (${startMarker})`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `${label}: end marker not found (${endMarker})`);
  return source.slice(start, end);
}

const importSlice = sliceBetween(
  appSource,
  'const loadBundledRekordboxCollection',
  'const handleSelectTrackFromXml',
  'handleTrackImport'
);
const selectSlice = sliceBetween(
  appSource,
  'const handleSelectTrackFromXml',
  '// ---- Phase 4',
  'handleSelectTrackFromXml'
);

// ─── Test A – Track-Import ohne XML-Dateidialog ─────────────────────────────
assert.ok(
  !/accept=["'][^"']*\.xml/i.test(appSource),
  'no file input accepts XML files'
);
assert.ok(
  appSource.includes('accept="audio/*,.wav,.mp3,.flac,.aiff"'),
  'the only file input is the standalone audio picker'
);
assert.ok(!appSource.includes('showOpenDialog'), 'the renderer never opens a native file dialog');
assert.ok(importSlice.includes('loadBundledRekordboxCollection'), 'Track-Import loads the bundled collection');
assert.ok(importSlice.includes('setXmlCollectionModalOpen(true)'), 'Track-Import opens the existing track picker');
assert.ok(!importSlice.includes('chooseRekordboxDatabase'), 'Track-Import never asks for a database file');
assert.ok(!importSlice.includes('chooseAnalysisFile'), 'Track-Import never asks for an ANLZ file');
assert.ok(
  appSource.includes("const BUNDLED_REKORDBOX_XML_FILENAME = 'rekordbox_export2.xml'"),
  'the single authoritative collection file is rekordbox_export2.xml'
);
assert.ok(
  appSource.includes('Ein externer XML-Import ist deaktiviert'),
  'drag & drop of external XML files stays refused'
);
assert.ok(
  !/XML importieren/i.test(menuBarSource),
  'the menu offers Track-Import, not a "Rekordbox XML importieren…" file dialog'
);
assert.ok(
  importSlice.includes('readBundledRekordboxXml'),
  'the desktop app reads the XML as an app resource (no dialog)'
);
assert.ok(
  importSlice.includes("import('./rekordbox/bundledCollection')"),
  'the browser/dev fallback uses the compiled-in asset of the same file'
);

// ─── Test B – die echte Sammlung ist die Quelle ─────────────────────────────
const xml = await read('rekordbox_export2.xml');
const firstTrackId = /TrackID="(\d+)"/.exec(xml)?.[1];
assert.ok(firstTrackId && firstTrackId.length > 0, 'the bundled XML contains real TrackIDs');
assert.ok(xml.includes('TrackID="142225026"'), 'the reference track 142225026 exists in the collection');
assert.ok((xml.match(/<TRACK /g) || []).length >= 10_000, 'the full 12k-track collection is present');
assert.ok(xml.includes('Location="file://localhost'), 'collection tracks reference original media');
assert.ok(bundledCollectionSource.includes('rekordbox_export2.xml?raw'), 'dev/browser asset imports the same file');

// ─── Test C – Master-DB-Gate ist durchgehend verdrahtet ─────────────────────
const gateModule = require('../electron/masterDbGate.cjs');
assert.equal(typeof gateModule.resolveTrackFromMasterDb, 'function', 'gate module exports resolveTrackFromMasterDb');
assert.equal(gateModule.GATE_CODES.length, 13, 'the documented state machine has 13 codes');
assert.ok(
  gateModule.GATE_CODES.includes('ANLZ_WAVEFORM_UNREADABLE') &&
    gateModule.GATE_CODES.includes('ANLZ_SOURCE_MISMATCH'),
  'the gate proves the decoded waveform and refuses an ANLZ/original mismatch'
);

assert.ok(preloadSource.includes('resolveTrackFromMasterDb:'), 'preload exposes resolveTrackFromMasterDb');
assert.ok(preloadSource.includes('readBundledRekordboxXml:'), 'preload exposes readBundledRekordboxXml');
assert.ok(mainSource.includes("'rekordbox:resolve-track-gate'"), 'main registers the gate channel');
assert.ok(mainSource.includes("'rekordbox:read-bundled-xml'"), 'main registers the bundled-XML channel');
assert.ok(mainSource.includes("require('./masterDbGate.cjs')"), 'main requires the gate module');
assert.ok(
  mainSource.includes('const afterRead = await stat(localPath)') &&
    mainSource.includes('afterRead.mtimeMs !== details.mtimeMs'),
  'ANLZ and original-audio reads recheck size/mtime after reading the source'
);
assert.ok(
  mainSource.includes("Buffer.byteLength(data, 'utf8') !== details.size"),
  'the embedded XML read also verifies its byte size after reading'
);
assert.ok(
  mainSource.includes("path.join(process.resourcesPath, 'rekordbox', 'rekordbox_export2.xml')"),
  'packaged builds read resources/rekordbox/rekordbox_export2.xml'
);
assert.ok(desktopTypes.includes('resolveTrackFromMasterDb('), 'desktop.d.ts declares the gate');
assert.ok(desktopTypes.includes('readBundledRekordboxXml('), 'desktop.d.ts declares the bundled XML reader');
assert.ok(desktopTypes.includes('RekordboxTrackGateCode'), 'desktop.d.ts declares the gate code union');
assert.ok(selectSlice.includes('resolveTrackFromMasterDb') || selectSlice.includes('rekordbox:resolve-track-gate'), 'the track load path awaits the gate');
assert.ok(selectSlice.includes('if (!gate.ok || gate.code !== \'OK\')'), 'a failed gate aborts the load');
assert.ok(
  selectSlice.includes('areSameMediaPath(gate.original.path, ppthPath)'),
  'the selected original must match the gate/ANLZ PPTH path exactly'
);
assert.ok(
  !importSlice.includes('readRekordboxDatabase') && !importSlice.includes('ensureNativeAnalysisIndex'),
  'opening the collection must not scan or copy the full database before track selection'
);

const dbReaderModule = require('../electron/dbReader.cjs');
assert.equal(typeof dbReaderModule.openContentRow, 'function', 'dbReader provides the targeted djmdContent reader');

// ─── Test E/F – Rekordbox-Waveform ist erzwungen, Audio nur read-only ───────
assert.ok(selectSlice.includes('DataOrigin.REKORDBOX_ANLZ'), 'waveform origin must be REKORDBOX_ANLZ');
assert.ok(
  selectSlice.includes('isNativeRekordboxWaveform'),
  'the native Rekordbox waveform check stays in place'
);
assert.ok(selectSlice.includes('[REKORDBOX_WAVEFORM_MISSING]'), 'missing waveform fails with its gate code');
assert.ok(selectSlice.includes('[ANLZ_NOT_FOUND]'), 'missing ANLZ path fails with its gate code');
assert.ok(selectSlice.includes('[ANLZ_READ_FAILED]'), 'unreadable ANLZ fails with its gate code');
assert.ok(selectSlice.includes('[ANLZ_SOURCE_MISMATCH]'), 'a mismatched ANLZ source fails with its own gate code');
assert.ok(selectSlice.includes('[ANLZ_WAVEFORM_UNREADABLE]'), 'a waveform that differs from the gate result fails hard');
assert.ok(
  selectSlice.includes('resolvedDef.analysis.length !== gateWaveform.buckets'),
  'the renderer must deliver exactly the waveform the gate decoded'
);
assert.ok(selectSlice.includes('[ORIGINAL_AUDIO_NOT_FOUND]'), 'missing original audio fails with its gate code');
assert.ok(selectSlice.includes('readOriginalAudio('), 'original audio is opened through the read-only bridge');
assert.ok(
  selectSlice.includes('originalSource.size !== gate.original.size') &&
    selectSlice.includes('originalSource.modifiedAt !== gate.original.modifiedAt'),
  'the original audio size and mtime must still match the gate snapshot'
);
assert.ok(selectSlice.includes('buildCues('), 'djmdCue rows from the gate are used as last-resort markers');
assert.ok(!selectSlice.includes('fetch(audioUrl)') && !selectSlice.includes('DataTransfer'), 'the selected track is not routed through a synthetic web-audio import');

// ─── Test G – kein lokaler Analyse-Fallback im XML-Ladepfad ─────────────────
// Kommentare werden ignoriert: geprüft wird ausschließlich der ausführbare Code.
const selectCode = selectSlice
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');
assert.ok(
  !selectCode.includes('analyzeAudioBuffer'),
  'handleSelectTrackFromXml must never run a local analysis fallback'
);
assert.ok(
  !selectCode.includes('LOCAL_ANALYSIS'),
  'handleSelectTrackFromXml must never label data as LOCAL_ANALYSIS'
);
assert.ok(
  !selectCode.includes('generateAnalysisFromMetadata'),
  'handleSelectTrackFromXml must never synthesize metadata waveforms'
);

// ─── Windows-Paketierung – die XML ist eine gebündelte App-Ressource ────────
const extraResources: Array<{ from: string; to?: string }> = packageJson.build?.extraResources || [];
const bundledXmlResource = extraResources.find((entry) => entry.from === 'rekordbox_export2.xml');
assert.ok(bundledXmlResource, 'electron-builder ships rekordbox_export2.xml as an extra resource');
assert.equal(
  bundledXmlResource?.to,
  'rekordbox/rekordbox_export2.xml',
  'the resource lands at resources/rekordbox/rekordbox_export2.xml'
);
assert.ok(
  Array.isArray(packageJson.build?.files) && (packageJson.build.files as string[]).includes('dist/**/*'),
  'the built renderer bundle (including the dev fallback asset) is packaged'
);

console.log(
  'rekordbox-track-import-pipeline: no XML dialog, bundled resource, master-db gate wiring and fallback-free load path verified'
);
