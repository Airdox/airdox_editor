/**
 * @license
 * 1:1-INTEGRITÄT – XML-Eintrag → Datenbankzeile (dieselbe ID) → dessen ANLZ
 * → dessen Original-Audio.
 *
 * Die Regel ist verbindlich und wird hier festgenagelt, damit sie niemand
 * „aus Bequemlichkeit“ wieder aufweicht:
 *
 *   1. Es wird NIE eine andere Datei, Zeile, Waveform oder Analyse genommen,
 *      nur weil etwas fehlt, gelöscht ist oder gerade nicht erreichbar ist.
 *   2. Es wird NIE selbst gerechnet (keine lokale FFT, keine Synthese), um
 *      fehlende Rekordbox-Analyse zu ersetzen.
 *   3. Es wird NIE nach Titel, Künstler oder Dateiname „ähnlich“ zugeordnet.
 *      Die einzige Verbindung ist die Rekordbox-TrackID (= djmdContent.ID).
 *   4. Eine selbst berechnete Wellenform darf sich NIE als Rekordbox-Daten
 *      ausgeben (keine erfundenen ANLZ-Tags, kein Validierungsvermerk).
 *
 * Run with: npx tsx tests/rekordbox-one-to-one-integrity.test.ts
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { DataOrigin } from '../src/types/rekordbox';
import {
  extractTrackFromRekordboxXml,
  generateAnalysisFromMetadata,
  parseAnlzBinary,
} from '../src/rekordbox/databaseExtractor';
import { SCENARIO_TECHNO_XML, generateSyntheticAnlzBuffer } from '../src/rekordbox/testDatasets';

const require = createRequire(import.meta.url);
const root = new URL('..', import.meta.url).pathname;
const gate = require('../electron/masterDbGate.cjs');

const checks: string[] = [];
const ok = (label: string) => checks.push(label);

const TRACK_ID = '101'; // TrackID aus SCENARIO_TECHNO_XML

// ─── 1. Ohne echte ANLZ-Datei darf nichts Rekordbox-Analytisches behauptet werden ──
{
  const { track, record } = extractTrackFromRekordboxXml(SCENARIO_TECHNO_XML, 0);

  assert.equal(
    record.anlzTagsFound.length,
    0,
    'ohne gelesene ANLZ-Datei werden keine ANLZ-Sektionen behauptet'
  );
  assert.equal(
    record.waveformOrigin,
    DataOrigin.GENERATED_FALLBACK,
    'eine selbst berechnete Wellenform ist als GENERATED_FALLBACK gekennzeichnet'
  );
  assert.equal(
    track.analysis?.origin,
    DataOrigin.GENERATED_FALLBACK,
    'die Analyse trägt ihre echte Herkunft, nicht REKORDBOX_*'
  );
  assert.equal(record.databaseSource, 'REKORDBOX_XML', 'Quelle bleibt ehrlich „nur XML-Metadaten“');
  assert.notEqual(record.checksum, 'REKORDBOX-XML-VALIDATED', 'kein erfundener Validierungsvermerk');
  assert.equal(record.waveformModeSupported.length, 0, 'ohne ANLZ werden keine Rekordbox-Modi behauptet');
  ok('Keine Rekordbox-Analyse behauptet, wenn keine ANLZ gelesen wurde');
}

// ─── 2. Mit echter ANLZ-Datei stammt die Wellenform 1:1 daraus ──────────────
{
  const anlzExtraction = parseAnlzBinary(generateSyntheticAnlzBuffer(128.0));
  const { track, record } = extractTrackFromRekordboxXml(SCENARIO_TECHNO_XML, 0, undefined, anlzExtraction);

  assert.ok(anlzExtraction.tagsFound.length > 0, 'Fixture liefert echte Sektionen');
  assert.deepEqual(
    record.anlzTagsFound,
    anlzExtraction.tagsFound,
    'nur real dekodierte Sektionen werden ausgewiesen'
  );
  assert.equal(record.databaseSource, 'REKORDBOX_ANLZ', 'Herkunft ist die ANLZ-Datei');
  assert.equal(record.waveformOrigin, DataOrigin.REKORDBOX_ANLZ, 'Wellenform-Herkunft ist REKORDBOX_ANLZ');
  assert.equal(track.analysis?.origin, DataOrigin.REKORDBOX_ANLZ, 'Buckets stammen aus der ANLZ');
  ok('Echte ANLZ wird 1:1 übernommen und korrekt ausgewiesen');
}

// ─── 3. Eigene Berechnung gibt sich nie als Rekordbox aus ───────────────────
{
  const analysis = generateAnalysisFromMetadata(240, 128, [], 0);
  assert.equal(analysis.origin, DataOrigin.GENERATED_FALLBACK, 'eigene Berechnung ist GENERATED_FALLBACK');
  for (const forbidden of [DataOrigin.REKORDBOX_ANLZ, DataOrigin.REKORDBOX_DB, DataOrigin.REKORDBOX_XML]) {
    assert.notEqual(analysis.origin, forbidden, 'eigene Berechnung behauptet keine Rekordbox-Herkunft');
  }
  ok('Selbst berechnete Kurve ist immer als GENERATED_FALLBACK markiert');
}

// ─── 4. Der Gate akzeptiert ausschließlich die Zeile zur angefragten ID ─────
{
  const requestedIds: Array<string | number>[] = [];
  const foreignRow = {
    ID: '999999',
    Title: 'Obsidian Voltage (Club Mix)',
    Artist: 'Klangfeld',
    FolderPath: 'C:\\Music\\',
    FileNameL: 'Reference.wav',
    AnalysisDataPath: '/PIONEER/USBANLZ/OTHER.DAT',
  };

  const result = await gate.resolveTrackFromMasterDb(
    { trackId: TRACK_ID },
    {
      locateRekordboxDatabases: () => [{ path: 'C:\\master.db', kind: 'MASTER_DB' }],
      isCipherAvailable: () => true,
      // Die Datenbank liefert absichtlich eine ZEILE EINES ANDEREN TRACKS
      // (gleicher Titel, gleicher Künstler, gleiche Datei – andere ID).
      openContentRow: (filePath: string, requestedId: string | number) => {
        requestedIds.push([requestedId]);
        return { available: true, dbType: 'MASTER_DB', row: foreignRow, cues: [] };
      },
    }
  );

  assert.equal(result.ok, false, 'eine fremde Zeile ist kein Treffer');
  assert.equal(result.code, 'TRACK_NOT_FOUND_IN_MASTER_DB', 'Ablehnung ist ehrlich begründet');
  assert.match(result.reason, /kein.*Ersatz|keine Zeile eines anderen Tracks/i, 'Grund nennt die Ersatz-Regel');
  assert.deepEqual(
    requestedIds,
    [[TRACK_ID]],
    'gesucht wird ausschließlich nach der Rekordbox-TrackID – nie nach Titel/Dateiname'
  );
  ok('Fremde Zeile (gleicher Titel, andere ID) wird abgelehnt, nie als Ersatz genommen');
}

// ─── 5. Nur die exakte ID ergibt einen Treffer ─────────────────────────────
{
  const ownRow = {
    ID: TRACK_ID,
    Title: 'Obsidian Voltage (Club Mix)',
    Artist: 'Klangfeld',
    FolderPath: '',
    FileNameL: '',
    AnalysisDataPath: '',
  };
  const result = await gate.resolveTrackFromMasterDb(
    { trackId: TRACK_ID },
    {
      locateRekordboxDatabases: () => [{ path: 'C:\\master.db', kind: 'MASTER_DB' }],
      isCipherAvailable: () => true,
      openContentRow: () => ({ available: true, dbType: 'MASTER_DB', row: ownRow, cues: [] }),
    }
  );
  // Der Track hat keinen AnalysisDataPath: harter Fehler ANLZ_NOT_FOUND –
  // ausdrücklich KEINE eigene Ersatz-Waveform.
  assert.equal(result.ok, false, 'fehlende ANLZ ist ein Fehler, kein Anlass zum Selberrechnen');
  assert.equal(result.code, 'ANLZ_NOT_FOUND', 'Gate bricht mit ANLZ_NOT_FOUND ab');
  assert.equal(result.content?.id, TRACK_ID, 'die Zeile gehört exakt zur angefragten TrackID');
  ok('Fehlende Analyse bricht hart ab – es wird nichts selbst berechnet');
}

// ─── 6. Renderer: kein Ersatz-Audio unter einen Rekordbox-Track hängen ──────
{
  const appSource = await readFile(`${root}src/App.tsx`.replace(/\/+/g, '/'), 'utf8');
  const loadAudio = appSource.slice(appSource.indexOf('const loadAudioFile'), appSource.indexOf("const loadAudioFile") + 9000);

  assert.match(loadAudio, /rekordboxProvenance/, 'Rekordbox-Herkunft wird geprüft');
  assert.match(loadAudio, /isExactOriginalFile/, 'nur die exakte Originaldatei darf verknüpft werden');
  assert.match(
    loadAudio,
    /linkAllowed = rekordboxProvenance\s*\?\s*isExactOriginalFile && durationMatchesOriginal/,
    'bei Rekordbox-Herkunft entscheidet ausschließlich die exakte Datei, keine Namensähnlichkeit'
  );
  assert.match(loadAudio, /Keine Ersatzdatei übernommen/, 'der Nutzer sieht die Ablehnung');
  assert.match(loadAudio, /hasProvenAnlzAnalysis/, 'nachgeladenes Audio ersetzt keine ANLZ-Analyse');
  ok('Renderer: Namensähnlichkeit verknüpft nie eine Ersatzdatei mit einem Rekordbox-Track');
}

// ─── 7. Auswahl-Pfad ohne jede Ersatz-Analyse ─────────────────────────────
{
  const appSource = await readFile(`${root}src/App.tsx`.replace(/\/+/g, '/'), 'utf8');
  const selectStart = appSource.indexOf('const handleSelectTrackFromXml');
  const selectCode = appSource.slice(selectStart, selectStart + 5000);
  assert.ok(!selectCode.includes('generateAnalysisFromMetadata'), 'Auswahlpfad erzeugt keine Ersatz-Waveform');
  assert.ok(!selectCode.includes('analyzeAudioBuffer'), 'Auswahlpfad rechnet keine lokale Analyse');
  assert.match(selectCode, /resolveTrackFromMasterDb|rekordbox:resolve-track-gate/, 'Auswahl läuft über den Gate');
  ok('Auswahlpfad läuft ausschließlich über den Master-DB-Gate');
}

console.log(`rekordbox-one-to-one-integrity: ${checks.length} Regeln geprüft`);
for (const line of checks) console.log(`  ✓ ${line}`);
