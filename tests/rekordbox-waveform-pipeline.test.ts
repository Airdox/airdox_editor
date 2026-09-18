/**
 * @license
 * Integrationstest der kompletten Rekordbox-Kette nach dem DB-Gate:
 *
 *   Master DB → SQLCipher → DB Query → Track gefunden → Trackdaten →
 *   ANLZ vorhanden? → Analysis → Waveform
 *
 * Kernpunkt (Regression aus 4.2.0): Liegt KEINE ANLZ-Analyse vor, muss die
 * Waveform trotzdem automatisch aus den tatsächlich geladenen Master-DB-Daten
 * (BPM / Cues / Duration / First Beat) erzeugt werden. Ein fehlgeschlagenes
 * DB-Gate darf dagegen NIEMALS still durch XML oder Defaults ersetzt werden.
 *
 * Run with: npx tsx tests/rekordbox-waveform-pipeline.test.ts
 */

import { buildDeckTrackAfterGate } from '../src/rekordbox/deckTrackPipeline';
import {
  MasterDbGateResult,
  MasterDbTrackRecord,
  normalizeMasterDbTrack,
  mergeRekordboxSources,
  TrackRequestGuard,
} from '../src/rekordbox/masterDbPipeline';
import { generateAnalysisFromMetadata } from '../src/waveform/metadataAnalysis';
import { DataOrigin, TrackModel, WaveformAnalysisData } from '../src/types/rekordbox';

const results: { name: string; passed: boolean; error?: string }[] = [];

function test(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, passed: true });
    console.log(`  ✓ ${name}`);
  } catch (error: any) {
    results.push({ name, passed: false, error: error?.message || String(error) });
    console.log(`  ✗ ${name}\n      ${error?.message || error}`);
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion Failed: ${message}`);
}

function dbRecord(overrides: Partial<MasterDbTrackRecord> = {}): MasterDbTrackRecord {
  return {
    trackId: '101',
    title: 'Obsidian Voltage (Club Mix)',
    artist: 'Klangfeld',
    album: 'Subterranean Records',
    genre: 'Techno',
    key: '6A',
    label: 'Subterranean',
    bpm: 128,
    duration: 240,
    sampleRate: 44100,
    fileSize: 9876543,
    comment: 'Peak hour',
    rating: 255,
    playCount: 18,
    year: 2025,
    analysisDataPath: '/PIONEER/USBANLZ/0e8/abc/ANLZ0000.DAT',
    folderPath: 'C:\\Music',
    fileName: 'Obsidian Voltage.wav',
    audioPath: 'C:\\Music\\Obsidian Voltage.wav',
    dbDir: 'C:\\Pioneer\\rekordbox7',
    cues: [
      { id: '1', kind: 0, inMsec: 0, outMsec: null, comment: 'Intro Start', color: null, activeLoop: false },
      { id: '2', kind: 0, inMsec: 15000, outMsec: null, comment: 'Kick In', color: null, activeLoop: false },
      { id: '3', kind: 1, inMsec: 30000, outMsec: null, comment: 'Hot A', color: null, activeLoop: false },
      { id: '4', kind: 0, inMsec: 75000, outMsec: 90000, comment: '8-Bar Loop', color: null, activeLoop: true },
    ],
    ...overrides,
  };
}

function okGate(record: MasterDbTrackRecord = dbRecord()): MasterDbGateResult {
  return {
    ok: true,
    source: 'rekordbox-master-db',
    sqlcipher: true,
    masterDbFound: true,
    sqlcipherAvailable: true,
    databaseOpened: true,
    schemaValidated: true,
    trackQueryExecuted: true,
    trackFound: true,
    dbPath: 'C:\\Pioneer\\rekordbox7\\master.db',
    dbType: 'MASTER_DB',
    matchedBy: 'TRACK_ID',
    trackId: record.trackId,
    track: record,
  };
}

function failedGate(errorCode: any): MasterDbGateResult {
  return {
    ok: false,
    source: 'rekordbox-master-db',
    errorCode,
    reason: `Gate fehlgeschlagen: ${errorCode}`,
    masterDbFound: false,
    sqlcipherAvailable: false,
    databaseOpened: false,
    schemaValidated: false,
    trackQueryExecuted: false,
    trackFound: false,
  };
}

function fakeAnlzAnalysis(): WaveformAnalysisData {
  const n = 400;
  const f = () => new Float32Array(n).fill(0.5);
  return {
    length: n,
    peaks: f(),
    peaksL: f(),
    peaksR: f(),
    lowEnergy: f(),
    midEnergy: f(),
    highEnergy: f(),
    origin: DataOrigin.REKORDBOX_ANLZ,
    sourceTag: 'PWV5',
  };
}

function xmlSupplement(): Partial<TrackModel> {
  return {
    id: 'xml-1',
    title: 'XML-Titel (veraltet)',
    artist: 'XML Artist',
    bpm: 111,
    duration: 999,
    comments: 'nur im XML vorhanden',
    origin: DataOrigin.REKORDBOX_XML,
  };
}

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  REKORDBOX MASTER-DB → ANALYSIS → WAVEFORM PIPELINE TEST SUITE');
console.log('═══════════════════════════════════════════════════════════════════\n');

// ─── 1. Vollständige Kette mit ANLZ ─────────────────────────────────────────
test('Master DB + ANLZ → echte ANLZ-Analysis hat Vorrang', () => {
  const res = buildDeckTrackAfterGate({ gate: okGate(), anlzAnalysis: fakeAnlzAnalysis() });
  assert(res.ok === true, 'Pipeline muss erfolgreich sein');
  if (res.ok !== true) return;
  assert(res.analysisSource === 'ANLZ', `erwartet ANLZ, war ${res.analysisSource}`);
  assert(res.track.analysis?.origin === DataOrigin.REKORDBOX_ANLZ, 'ANLZ-Origin muss erhalten bleiben');
  assert(res.provenance.databaseOpened && res.provenance.trackFound, 'Beweiskette unvollständig');
});

// ─── 2. REGRESSIONSTEST 4.2.0: kein ANLZ → Metadata-Analysis ───────────────
test('Master DB ohne ANLZ → Waveform wird aus DB-Metadaten erzeugt (4.2.0-Regression)', () => {
  const res = buildDeckTrackAfterGate({ gate: okGate() });
  assert(res.ok === true, 'Pipeline muss erfolgreich sein');
  if (res.ok !== true) return;
  assert(res.analysisSource === 'METADATA_FALLBACK', `erwartet METADATA_FALLBACK, war ${res.analysisSource}`);
  const analysis = res.track.analysis;
  assert(!!analysis, 'Es MUSS eine Waveform-Analyse vorliegen');
  assert(analysis!.length > 0 && analysis!.peaks.length === analysis!.length, 'Peaks fehlen');
  assert(analysis!.origin === DataOrigin.GENERATED_FALLBACK, 'Fallback muss als solcher gekennzeichnet sein');
  assert(analysis!.peaks.some((p) => p > 0), 'Waveform darf nicht leer sein');
});

test('Metadata-Analysis nutzt die tatsächlichen DB-Werte (BPM/Duration/Cues)', () => {
  const withBeats = generateAnalysisFromMetadata(240, 128, [], 0)!;
  const withoutBpm = generateAnalysisFromMetadata(240, null, [], 0)!;
  assert(withBeats.length === withoutBpm.length, 'Bucketzahl folgt der Dauer');
  // Beat-Modulation nur bei vorhandener BPM – ohne BPM wird kein Tempo erfunden.
  const varA = Math.max(...withBeats.peaks) - Math.min(...withBeats.peaks);
  const varB = Math.max(...withoutBpm.peaks) - Math.min(...withoutBpm.peaks);
  assert(varA > varB, 'Mit BPM muss eine Beat-Struktur sichtbar sein');
  assert(varB === 0, 'Ohne BPM darf kein Beatraster erfunden werden');
});

test('Cues aus der DB strukturieren die Fallback-Waveform', () => {
  const cues = normalizeMasterDbTrack(dbRecord()).cues!;
  const withCues = generateAnalysisFromMetadata(240, 128, cues, 0)!;
  const withoutCues = generateAnalysisFromMetadata(240, 128, [], 0)!;
  const mean = (a: Float32Array, from: number, to: number) => {
    let sum = 0;
    for (let i = from; i < to; i++) sum += a[i];
    return sum / (to - from);
  };
  const early = mean(withCues.peaks, 0, 2000);
  const late = mean(withCues.peaks, withCues.length - 2000, withCues.length);
  assert(late > early, 'Cue-Abschnitte müssen die Energie strukturieren');
  // Ohne Cues gibt es keine Abschnittsstufen: die Spitzenamplitude ist über
  // den ganzen Track identisch (nur die Beat-Hülle moduliert).
  const peakEarly = Math.max(...Array.from(withoutCues.peaks.slice(0, 2000)));
  const peakLate = Math.max(...Array.from(withoutCues.peaks.slice(withoutCues.length - 2000)));
  assert(Math.abs(peakLate - peakEarly) < 1e-6, 'Ohne Cues gleichmäßige Grundenergie');
});

test('Ohne gültige Dauer wird nichts erfunden (null statt Fantasiewaveform)', () => {
  assert(generateAnalysisFromMetadata(0, 128, [], 0) === null, '0 s muss null ergeben');
  assert(generateAnalysisFromMetadata(Number.NaN, 128, [], 0) === null, 'NaN muss null ergeben');
});

// ─── 3. DB-Gate-Fehler dürfen nicht verschleiert werden ────────────────────
for (const code of [
  'MASTER_DB_NOT_FOUND',
  'SQLCIPHER_UNAVAILABLE',
  'MASTER_DB_OPEN_FAILED',
  'MASTER_DB_SCHEMA_INVALID',
  'TRACK_NOT_FOUND_IN_MASTER_DB',
]) {
  test(`Gate-Fehler ${code} → keine Waveform, kein stiller Fallback`, () => {
    const res = buildDeckTrackAfterGate({
      gate: failedGate(code),
      supplementary: xmlSupplement(),
      anlzAnalysis: fakeAnlzAnalysis(),
    });
    assert(res.ok === false, 'Pipeline darf NICHT erfolgreich sein');
    if (res.ok !== false) return;
    assert(res.errorCode === code, `Fehlercode muss durchgereicht werden (${res.errorCode})`);
    assert(!('track' in res), 'Es darf kein Track geliefert werden');
  });
}

// ─── 4. Datenpriorität: DB schlägt XML ─────────────────────────────────────
test('DB-Daten + XML ergänzend: DB gewinnt, XML ergänzt nur Lücken', () => {
  const res = buildDeckTrackAfterGate({ gate: okGate(), supplementary: xmlSupplement() as TrackModel });
  assert(res.ok === true, 'Pipeline muss erfolgreich sein');
  if (res.ok !== true) return;
  assert(res.track.title === 'Obsidian Voltage (Club Mix)', 'DB-Titel muss gewinnen');
  assert(res.track.bpm === 128, 'DB-BPM muss gewinnen');
  assert(res.track.duration === 240, 'DB-Dauer muss gewinnen');
  assert(res.track.comments === 'Peak hour', 'DB-Kommentar muss gewinnen');
  assert(res.track.id === '101', 'Trackidentität kommt aus der DB');
  assert(res.track.origin === DataOrigin.REKORDBOX_DB, 'Origin muss REKORDBOX_DB sein');
});

test('DB-Daten + XML widersprüchlich: kein Mischwert, DB ist Single Source of Truth', () => {
  const merged = mergeRekordboxSources(normalizeMasterDbTrack(dbRecord()), xmlSupplement());
  assert(merged.bpm === 128, 'BPM aus der DB');
  assert(merged.title === 'Obsidian Voltage (Club Mix)', 'Titel aus der DB');
  assert(merged.artist === 'Klangfeld', 'Artist aus der DB');
});

test('Fehlt ein Feld in der DB, darf XML ergänzen (ohne DB zu überschreiben)', () => {
  const merged = mergeRekordboxSources(
    normalizeMasterDbTrack(dbRecord({ genre: null })),
    { genre: 'Tech House' } as TrackModel
  );
  assert(merged.genre === 'Tech House', 'XML darf eine echte DB-Lücke füllen');
});

// ─── 5. Audio-Varianten ────────────────────────────────────────────────────
test('Master DB + Audio: Audiodauer/-analyse hat Vorrang vor DB-Dauer', () => {
  const res = buildDeckTrackAfterGate({
    gate: okGate(),
    audioDuration: 238.5,
    audioAnalysis: { ...fakeAnlzAnalysis(), origin: DataOrigin.LOCAL_ANALYSIS, sourceTag: undefined },
  });
  assert(res.ok === true, 'Pipeline muss erfolgreich sein');
  if (res.ok !== true) return;
  assert(res.track.duration === 238.5, 'Dauer aus dem Originalaudio');
  assert(res.analysisSource === 'AUDIO_ANALYSIS', 'Audioanalyse verwenden');
});

test('Master DB ohne Audio: Waveform entsteht trotzdem (kein synthetischer Track)', () => {
  const res = buildDeckTrackAfterGate({ gate: okGate() });
  assert(res.ok === true, 'Pipeline muss erfolgreich sein');
  if (res.ok !== true) return;
  assert(res.track.audioBuffer === null, 'Es darf KEIN künstliches Audio erzeugt werden');
  assert(!!res.track.analysis, 'Waveform-Analyse muss dennoch vorliegen');
});

test('Master DB + ANLZ + Audio: ANLZ bleibt vorrangig', () => {
  const res = buildDeckTrackAfterGate({
    gate: okGate(),
    anlzAnalysis: fakeAnlzAnalysis(),
    audioAnalysis: { ...fakeAnlzAnalysis(), origin: DataOrigin.LOCAL_ANALYSIS },
    audioDuration: 240,
  });
  assert(res.ok === true, '');
  if (res.ok !== true) return;
  assert(res.analysisSource === 'ANLZ', 'ANLZ hat Vorrang vor der eigenen Audioanalyse');
});

// ─── 6. Metadatenlücken ────────────────────────────────────────────────────
test('BPM fehlt in der DB → kein erfundenes Tempo, Waveform trotzdem vorhanden', () => {
  const res = buildDeckTrackAfterGate({ gate: okGate(dbRecord({ bpm: null })) });
  assert(res.ok === true, '');
  if (res.ok !== true) return;
  assert(res.track.bpm === 0, 'Kein Default-BPM erfinden');
  assert(res.track.beatGrid.beats.length === 0, 'Ohne BPM kein erfundenes Beatgrid');
  assert(!!res.track.analysis, 'Waveform muss dennoch erzeugt werden');
});

test('Cues fehlen → Waveform ohne Cue-Struktur, keine Fantasie-Cues', () => {
  const res = buildDeckTrackAfterGate({ gate: okGate(dbRecord({ cues: [] })) });
  assert(res.ok === true, '');
  if (res.ok !== true) return;
  assert(res.track.cues.length === 0, 'Es dürfen keine Cues erfunden werden');
  assert(!!res.track.analysis, 'Waveform muss vorliegen');
});

test('First Beat fehlt → Anker 0, kein geratener Offset', () => {
  const res = buildDeckTrackAfterGate({ gate: okGate() });
  assert(res.ok === true, '');
  if (res.ok !== true) return;
  assert(res.track.beatGrid.firstBeat === 0, 'First Beat bleibt 0');
});

test('First Beat vorhanden (ANLZ/XML) → wird übernommen', () => {
  const res = buildDeckTrackAfterGate({ gate: okGate(), firstBeat: 0.184 });
  assert(res.ok === true, '');
  if (res.ok !== true) return;
  assert(Math.abs(res.track.beatGrid.firstBeat - 0.184) < 1e-9, 'First Beat aus der Analyse');
});

test('Dauer fehlt in der DB und kein Audio → harter Fehler statt Default-Dauer', () => {
  const res = buildDeckTrackAfterGate({ gate: okGate(dbRecord({ duration: null })) });
  assert(res.ok === false, 'Es darf keine erfundene Dauer verwendet werden');
});

// ─── 7. Cue-Normalisierung aus der DB ──────────────────────────────────────
test('DB-Cues werden korrekt in Memory-Cues, Hot Cues und Loops überführt', () => {
  const normalized = normalizeMasterDbTrack(dbRecord());
  const memory = normalized.cues!.filter((c) => c.type === 'MEMORY');
  const hot = normalized.cues!.filter((c) => c.type === 'HOT_CUE');
  assert(memory.length === 2, `2 Memory Cues erwartet, ${memory.length} erhalten`);
  assert(hot.length === 1, `1 Hot Cue erwartet, ${hot.length} erhalten`);
  assert(normalized.loops!.length === 1, '1 Loop erwartet');
  assert(Math.abs(normalized.loops![0].start - 75) < 1e-9, 'Loop-Start aus InMsec');
  assert(Math.abs(normalized.loops![0].end - 90) < 1e-9, 'Loop-Ende aus OutMsec');
  assert(normalized.cues!.every((c) => c.origin === DataOrigin.REKORDBOX_DB), 'Origin muss REKORDBOX_DB sein');
});

test('Rating 255 wird auf die 0..5-Skala normalisiert, nicht erfunden', () => {
  assert(normalizeMasterDbTrack(dbRecord()).rating === 5, 'Rating 255 → 5');
  assert(normalizeMasterDbTrack(dbRecord({ rating: null })).rating === undefined, 'Ohne Rating kein Default');
});

// ─── 8. Asynchrone Pipeline / Race Conditions ──────────────────────────────
test('Request-Guard: spätes Ergebnis von Track A überschreibt Track B nicht', () => {
  const guard = new TrackRequestGuard();
  const genA = guard.begin();
  const genB = guard.begin();
  assert(guard.isCurrent(genB), 'B ist die aktuelle Anfrage');
  assert(!guard.isCurrent(genA), 'A darf nicht mehr angewendet werden');
});

test('Request-Guard: erneutes Laden desselben Tracks ergibt eine neue Generation', () => {
  const guard = new TrackRequestGuard();
  const first = guard.begin();
  const second = guard.begin();
  assert(first !== second, 'Jede Auswahl bekommt eine eigene Generation');
  assert(guard.isCurrent(second), 'Nur die letzte Anfrage gilt');
});

test('Mehrere Trackauswahlen hintereinander liefern jeweils konsistente Tracks', () => {
  const a = buildDeckTrackAfterGate({ gate: okGate(dbRecord({ trackId: '1', title: 'A', bpm: 124 })) });
  const b = buildDeckTrackAfterGate({ gate: okGate(dbRecord({ trackId: '2', title: 'B', bpm: 132 })) });
  assert(a.ok === true && b.ok === true, '');
  if (a.ok !== true || b.ok !== true) return;
  assert(a.track.id === '1' && a.track.bpm === 124, 'Track A bleibt Track A');
  assert(b.track.id === '2' && b.track.bpm === 132, 'Track B bleibt Track B');
  assert(a.track.analysis !== b.track.analysis, 'Analysen dürfen nicht geteilt werden');
});

// ─── 9. Read-Only ──────────────────────────────────────────────────────────
test('Der Deck-Track markiert die Quelle als unberührt/read-only', () => {
  const res = buildDeckTrackAfterGate({ gate: okGate() });
  assert(res.ok === true, '');
  if (res.ok !== true) return;
  assert(res.track.isOriginalUntouched === true, 'Original muss als unberührt markiert sein');
  assert(res.track.originalMedia?.accessMode === 'READ_ONLY', 'Originalmedium ist read-only');
});

const failed = results.filter((r) => !r.passed);
console.log(`\n  ${results.length - failed.length}/${results.length} Tests bestanden.`);
if (failed.length > 0) {
  console.error('WAVEFORM-PIPELINE TESTS: FAIL');
  process.exit(1);
}
console.log('WAVEFORM-PIPELINE TESTS: PASS');
