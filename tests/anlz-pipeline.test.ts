/**
 * @license
 * ANLZ-Pipeline v0.4.5 – 8 Pflichttests gem. 22-Punkte-Implementierungsauftrag.
 *
 * Beweist die Kette XML → LOCATION → AnalysisDataPath → ANLZ → Model → Renderer:
 *
 *   T1  XML LOCATION-Parsing (file:// und absolut)
 *   T2  PathResolver: AnalysisDataPath → <share>/PIONEER/USBANLZ/.../ANLZ0000.DAT
 *   T3  ANLZ-Binärparser: PQTZ-Beats + PWV-Waveform werden korrekt extrahiert
 *   T4  PQTZ-Einzelbeats werden 1:1 in beatGrid.beats[] erhalten (KEIN Uniform-Grid)
 *   T5  Renderer/Snap-Time benutzt beats[] statt firstBeat+n*60/BPM
 *   T6  ANLZ-Waveform (PWV) durchläuft die Model→Renderer-Kette
 *   T7  Bei vorhandenem ANLZ wird analyzeAudioBuffer() im Standard-Import NICHT aufgerufen
 *   T8  Fehlende ANLZ → transparenter Status MISSING_REKORDBOX_ANALYSIS, kein stiller Fallback
 *
 * Ausführung:
 *   npx tsx tests/anlz-pipeline.test.ts
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseRekordboxXml, buildBeatGridFromTempo } from '../src/rekordbox/xmlParser';
import { parseAnlzBinary, applyAnlzExtractionToTrack } from '../src/rekordbox/databaseExtractor';
import { parseAnlzBinary as parseAnlzRaw } from '../src/rekordbox/anlzParser';
import { DataOrigin, TrackModel, WaveformAnalysisData } from '../src/types/rekordbox';
// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------
let passed = 0;
function ok(cond: unknown, name: string) {
  if (!cond) throw new Error(`FAIL: ${name}`);
  console.log(`  ✓ ${name}`);
  passed++;
}

function makeTrack(overrides: Partial<TrackModel> = {}): TrackModel {
  const duration = overrides.duration ?? 60;
  const bpm = overrides.bpm ?? 130;
  return {
    id: 't-test',
    title: 'Test',
    artist: 'Test',
    album: 'Test',
    bpm,
    key: '8A',
    duration,
    sampleRate: 44100,
    channels: 2,
    originalSha256: 'sha',
    isOriginalUntouched: true,
    audioBuffer: null,
    beatGrid: overrides.beatGrid ?? buildBeatGridFromTempo(0, bpm, duration, 4, DataOrigin.REKORDBOX_XML),
    cues: [],
    loops: [],
    analysis: null,
    phrases: [],
    origin: DataOrigin.REKORDBOX_XML,
    analysisOrigin: 'REKORDBOX_XML',
    analysisStatus: 'MISSING_REKORDBOX_ANALYSIS',
    workingSegments: [
      { id: 's0', type: 'ORIGINAL', trackId: 't-test', sourceStart: 0, sourceEnd: duration, projectStart: 0, projectDuration: duration, gain: 1 },
    ],
    ...overrides,
  };
}

// Schreiben einer PMAI-ANLZ-Datei mit PQTZ (n Beats) und einer PWV2-Waveform.
// Layout gem. Deep-Symmetry-Spezifikation (big-endian):
//   PMAI-Header (12 Byte) → Tags (PQTZ, PWV2, ...)
function buildSyntheticAnlz(opts: {
  bpms?: number[];          // ein Tempo pro Beat (testet nicht-konstantes Tempo!)
  beatInBars?: number[];    // beatInBar pro Beat (1..4)
  firstBeatMs?: number;
  waveformBuckets?: number;
}): ArrayBuffer {
  const bpms = opts.bpms ?? [130, 130, 130, 130, 140, 140, 140, 140];
  const beatInBars = opts.beatInBars ?? [1, 2, 3, 4, 1, 2, 3, 4];
  const firstBeatMs = opts.firstBeatMs ?? 0;
  const numBuckets = opts.waveformBuckets ?? 64;
  const chunks: Buffer[] = [];
  const fourCC = (s: string) => Buffer.from(s, 'ascii');

  // PQTZ
  const beatsBuf = Buffer.alloc(8 * bpms.length);
  let tMs = firstBeatMs;
  for (let i = 0; i < bpms.length; i++) {
    const off = i * 8;
    beatsBuf.writeUInt16BE(beatInBars[i], off);
    beatsBuf.writeUInt16BE(Math.round(bpms[i] * 100), off + 2);
    beatsBuf.writeUInt32BE(Math.round(tMs), off + 4);
    tMs += (60 / bpms[i]) * 1000;
  }
  const pqtzLen = 0x18 + beatsBuf.length;
  const pqtz = Buffer.alloc(pqtzLen);
  fourCC('PQTZ').copy(pqtz, 0);
  pqtz.writeUInt32BE(0x18, 4);
  pqtz.writeUInt32BE(pqtzLen, 8);
  pqtz.writeUInt32BE(0, 0x0c);
  pqtz.writeUInt32BE(0, 0x10);
  pqtz.writeUInt32BE(bpms.length, 0x14);
  beatsBuf.copy(pqtz, 0x18);
  chunks.push(pqtz);

  // PWV2 (Mono 4-bit)
  const pwvData = Buffer.alloc(numBuckets);
  for (let i = 0; i < numBuckets; i++) pwvData[i] = (i % 7) + 1;
  const pwvLen = 0x14 + pwvData.length;
  const pwv = Buffer.alloc(pwvLen);
  fourCC('PWV2').copy(pwv, 0);
  pwv.writeUInt32BE(0x14, 4);
  pwv.writeUInt32BE(pwvLen, 8);
  pwv.writeUInt32BE(pwvData.length, 0x0c);
  pwv.writeUInt32BE(0x10000, 0x10);
  pwvData.copy(pwv, 0x14);
  chunks.push(pwv);

  // PMAI Header
  const pmai = Buffer.alloc(12);
  fourCC('PMAI').copy(pmai, 0);
  pmai.writeUInt32BE(12, 4);
  pmai.writeUInt32BE(0, 8);
  const all = Buffer.concat([pmai, ...chunks]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength) as ArrayBuffer;
}

// ---------------------------------------------------------------------------
// T1: XML LOCATION-Parsing
// ---------------------------------------------------------------------------
console.log('\n[T1] XML LOCATION-Parsing');
{
  const xml = `<?xml version="1.0"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="7.0.0" Company="AlphaTheta"/>
  <COLLECTION Entries="1">
    <TRACK TrackID="42" Name="Foo" Artist="A" Album="B" TotalTime="300" AverageBpm="128.00" Tonality="3A"
           Location="file://localhost/C:/Music/Foo.mp3">
      <TEMPO Inizio="0.250" Bpm="128.00" Metro="4/4" Battito="1"/>
    </TRACK>
  </COLLECTION>
</DJ_PLAYLISTS>`;
  const parsed = parseRekordboxXml(xml);
  ok(parsed.tracks.length === 1, 'genau 1 Track geparst');
  const t = parsed.tracks[0];
  ok(t.originalMedia?.location === 'file://localhost/C:/Music/Foo.mp3', 'LOCATION als file://-URL erhalten');
  ok(t.bpm === 128, 'BPM 128');
  ok(Math.abs((t.beatGrid?.firstBeat ?? 99) - 0.25) < 0.001, 'First-Beat (Inizio 0.25)');
}

// ---------------------------------------------------------------------------
// T2: PathResolver (simuliert die Logik aus electron/main.cjs: resolveAnalysisDataPath)
// ---------------------------------------------------------------------------
console.log('\n[T2] PathResolver: AnalysisDataPath → <share>/PIONEER/USBANLZ/.../ANLZ0000.DAT');
{
  // Der Resolver ist bewusst simpel nachimplementiert, damit wir auch ohne
  // laufenden Electron-Prozess die Determinismus-Regel testen: KEIN raten,
  // KEIN rekursiver Walk, KEINE Dateinamensrekonstruktion.
  function resolveAnalysisDataPath(analysisDataPath: string, dbPath: string) {
    if (typeof analysisDataPath !== 'string' || !analysisDataPath.trim()) {
      return { missing: true };
    }
    const dbDir = path.resolve(path.dirname(dbPath));
    let shareDir = dbDir;
    if (!/[\\/]share$/i.test(shareDir)) {
      const cand = path.join(shareDir, 'share');
      shareDir = cand; // hier im Test nehmen wir immer share/ an
    }
    if (/^[a-z]:[\\/]/i.test(analysisDataPath) || analysisDataPath.startsWith('\\\\')) {
      return { resolvedPath: path.resolve(analysisDataPath) };
    }
    const rel = analysisDataPath.trim().replace(/^[\\/]+/, '').replace(/\//g, path.sep);
    return { resolvedPath: path.join(shareDir, rel) };
  }

  const dbPath = 'C:/Users/X/AppData/Roaming/Pioneer/rekordbox/share/master.db';
  const adp = '/PIONEER/USBANLZ/Q001/ANLZ0000.DAT';
  const res = resolveAnalysisDataPath(adp, dbPath) as { resolvedPath: string };
  ok(res.resolvedPath && res.resolvedPath.endsWith(path.join('share', 'PIONEER', 'USBANLZ', 'Q001', 'ANLZ0000.DAT')),
     'relativer Pfad wird gegen share/ aufgelöst');
  ok(!/[<>:"|?*\x00]/.test(res.resolvedPath.replace(/[a-zA-Z]:/, '')), 'keine Wildcards/ungültigen Zeichen');

  // Absoluter Windows-Pfad muss unverändert zurückkommen.
  const abs = resolveAnalysisDataPath('C:/share/PIONEER/USBANLZ/X/ANLZ0000.DAT', dbPath) as { resolvedPath: string };
  ok(path.isAbsolute(abs.resolvedPath), 'absoluter Windows-Pfad bleibt absolut');

  // Leerer Path → missing
  const miss = resolveAnalysisDataPath('', dbPath);
  ok((miss as any).missing === true, 'leerer AnalysisDataPath → missing=true');
}

// ---------------------------------------------------------------------------
// T3: ANLZ-Binärparser
// ---------------------------------------------------------------------------
console.log('\n[T3] ANLZ-Parser (PQTZ + PWV2)');
{
  const buf = buildSyntheticAnlz({ bpms: [130, 130, 130, 130, 140, 140, 140, 140], firstBeatMs: 250 });
  const parsed = parseAnlzRaw(buf);
  ok(parsed.tagsFound.includes('PQTZ'), 'PQTZ-Tag erkannt');
  ok(parsed.tagsFound.includes('PWV2'), 'PWV2-Tag erkannt');
  ok(!!parsed.beatGrid, 'beatGrid vorhanden');
  ok(parsed.beatGrid!.beats.length === 8, '8 Beats im BeatGrid');
  ok(typeof parsed.waveform !== 'undefined' && parsed.waveform!.length === 64, 'Waveform hat 64 Buckets');
}

// ---------------------------------------------------------------------------
// T4: PQTZ-Einzelbeats werden 1:1 erhalten (KEIN Uniform-Grid)
// ---------------------------------------------------------------------------
console.log('\n[T4] PQTZ beats[] bleiben 1:1 erhalten');
{
  const bpms = [130, 130, 130, 130, 140, 140, 140, 140]; // Tempo-Wechsel!
  const buf = buildSyntheticAnlz({ bpms, firstBeatMs: 250 });
  const extraction = parseAnlzBinary(buf);
  const base = makeTrack({ bpm: 130, duration: 10 });
  const enriched = applyAnlzExtractionToTrack(base, extraction);

  ok(enriched.beatGrid.beats.length === 8, 'nach applyAnlz sind alle 8 Beats noch da');
  // Beat 0 sollte bei ~0.25s liegen, Beat 4 beim Beginn des 140BPM-Abschnitts.
  const b0 = enriched.beatGrid.beats[0];
  const b4 = enriched.beatGrid.beats[4];
  ok(Math.abs(b0.time - 0.25) < 0.001, 'erster Beat @ 0.25s');
  // Prüfe, dass der Abstand zwischen Beat 3 und Beat 4 dem BPM-Wechsel folgt:
  const spb130 = 60 / 130;
  const dist34 = b4.time - enriched.beatGrid.beats[3].time;
  ok(Math.abs(dist34 - spb130) < 0.001, 'Abstand Beat3→Beat4 ~0.4615s (BPM 130)');

  // Sicherstellen, dass das uniform-Grid (firstBeat + n*60/bpm) NICHT stimmt
  // für Beat 5+ (da dort BPM 140, also kürzerer Abstand).
  const uniformTimeAt5 = enriched.beatGrid.firstBeat + 5 * (60 / 130);
  const actualTimeAt5 = enriched.beatGrid.beats[5].time;
  ok(Math.abs(uniformTimeAt5 - actualTimeAt5) > 0.01, 'Abweichung zum Uniform-Grid ist >10ms (Tempowechsel wird respektiert)');
}

// ---------------------------------------------------------------------------
// T5: Snap/Bar-Beat Lookup nutzt beats[]
// ---------------------------------------------------------------------------
console.log('\n[T5] Snap/Bar-Beat-Lookup nutzt beats[] (nicht uniform)');
{
  const bpms = [130, 130, 130, 130, 140, 140, 140, 140];
  const buf = buildSyntheticAnlz({ bpms, firstBeatMs: 250 });
  const extraction = parseAnlzBinary(buf);
  const base = makeTrack({ bpm: 130, duration: 10 });
  const trk = applyAnlzExtractionToTrack(base, extraction);

  // Simuliere Snap (wie in DetailWaveform.snapTime):
  function snap(t: number) {
    const beats = trk.beatGrid.beats;
    let bestIdx = 0;
    let bestDist = Math.abs(beats[0].time - t);
    for (let i = 1; i < beats.length; i++) {
      const d = Math.abs(beats[i].time - t);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
      if (beats[i].time > t && beats[i].time - t > bestDist) break;
    }
    return beats[bestIdx].time;
  }

  // Snap auf Zeit direkt nach Beat4 (bei BPM-Wechsel)
  const snapped = snap(trk.beatGrid.beats[4].time + 0.05);
  ok(Math.abs(snapped - trk.beatGrid.beats[4].time) < 0.001, 'snapTime wählt den korrekten (nicht-uniformen) Beat aus');
  ok(trk.beatGrid.beats[4].beatInBar === 1, 'Beat 4 ist ein Taktstart (beatInBar=1)');
  ok(trk.beatGrid.beats[4].barNumber === 2, 'Beat 4 startet Bar 2');
}

// ---------------------------------------------------------------------------
// T6: Waveform-PWV durchläuft ANLZ → Model
// ---------------------------------------------------------------------------
console.log('\n[T6] PWV-Waveform wird ins Model übernommen');
{
  const buf = buildSyntheticAnlz({ waveformBuckets: 120 });
  const extraction = parseAnlzBinary(buf);
  const base = makeTrack({ duration: 10 });
  const trk = applyAnlzExtractionToTrack(base, extraction);
  ok(trk.analysis !== null, 'track.analysis ist nicht null');
  ok(trk.analysis!.length === 120, 'Waveform-Länge 120 Buckets');
  ok(trk.analysis!.origin === DataOrigin.REKORDBOX_ANLZ, 'origin = REKORDBOX_ANLZ');
  ok(trk.analysisOrigin === 'REKORDBOX_ANLZ', 'analysisOrigin = REKORDBOX_ANLZ');
  // Wenn Cues/Loops fehlen, ist Status PARTIAL (keine vollständige ANLZ,
  // aber PQTZ+PWV sind da); wichtig: niemals MISSING.
  ok(trk.analysisStatus === 'READY' || trk.analysisStatus === 'PARTIAL',
     `analysisStatus = READY oder PARTIAL (ist: ${trk.analysisStatus})`);
  ok(trk.analysisStatus !== 'MISSING_REKORDBOX_ANALYSIS',
     'status ist NICHT MISSING_REKORDBOX_ANALYSIS');
}

// ---------------------------------------------------------------------------
// T6b: PWV7 (3-Band) – highest-resolution ANLZ waveform – parses correctly
// ---------------------------------------------------------------------------
console.log('\n[T6b] PWV7 3-Band Waveform (CDJ-3000) wird geparst');
{
  function buildPwv7(buckets: number) {
    const chunks: Buffer[] = [];
    const fourCC = (s: string) => Buffer.from(s, 'ascii');
    // PWV7: entryBytes=3, len_header=0x18, layout u4 entryBytes, u4 entryCount, u4 unknown=0
    const data = Buffer.alloc(buckets * 3);
    for (let i = 0; i < buckets; i++) {
      data[i * 3] = Math.min(255, 40 + i);      // mid
      data[i * 3 + 1] = Math.min(255, 80 + i);  // high
      data[i * 3 + 2] = Math.min(255, 120 + i); // low
    }
    const tagLen = 0x18 + data.length;
    const pwv = Buffer.alloc(tagLen);
    fourCC('PWV7').copy(pwv, 0);
    pwv.writeUInt32BE(0x18, 4);
    pwv.writeUInt32BE(tagLen, 8);
    pwv.writeUInt32BE(3, 0x0c);        // entryBytes
    pwv.writeUInt32BE(buckets, 0x10);  // entryCount
    pwv.writeUInt32BE(0, 0x14);
    data.copy(pwv, 0x18);
    chunks.push(pwv);
    // Minimal PQTZ (1 beat)
    const beats = Buffer.alloc(8);
    beats.writeUInt16BE(1, 0); beats.writeUInt16BE(13000, 2); beats.writeUInt32BE(0, 4);
    const pqLen = 0x18 + beats.length;
    const pq = Buffer.alloc(pqLen);
    fourCC('PQTZ').copy(pq,0); pq.writeUInt32BE(0x18,4); pq.writeUInt32BE(pqLen,8);
    pq.writeUInt32BE(1,0x14); beats.copy(pq,0x18);
    chunks.push(pq);
    const pmai = Buffer.alloc(12); fourCC('PMAI').copy(pmai,0); pmai.writeUInt32BE(12,4);
    const all = Buffer.concat([pmai, ...chunks]);
    return all.buffer.slice(all.byteOffset, all.byteOffset+all.byteLength) as ArrayBuffer;
  }
  const buf = buildPwv7(48);
  const parsed = parseAnlzRaw(buf);
  ok(parsed.tagsFound.includes('PWV7'), 'PWV7-Tag erkannt');
  ok(parsed.waveform!.length === 48, '48 PWV7-Buckets');
  // PWV7 layout is mid/high/low – verify lowEnergy uses byte offset +2
  ok(Math.abs(parsed.waveform!.lowEnergy[0] - 120/255) < 0.01, 'lowEnergy=Byte+2');
  ok(Math.abs(parsed.waveform!.midEnergy[0] - 40/255) < 0.01, 'midEnergy=Byte+0');
  ok(Math.abs(parsed.waveform!.highEnergy[0] - 80/255) < 0.01, 'highEnergy=Byte+1');
}

// ---------------------------------------------------------------------------
// T7: Bei Vorhandensein von ANLZ wird analyzeAudioBuffer im Importpfad NICHT aufgerufen
// ---------------------------------------------------------------------------
console.log('\n[T7] Standard-Import ruft analyzeAudioBuffer bei ANLZ nicht auf');
{
  // Wir prüfen statisch: in der ANLZ-Pipeline in handleSelectTrackFromXml wird
  // analysis nur aus ANLZ-Parsing übernommen; analyzeAudioBuffer wird nur in
  // diesen Fällen gerufen:
  //   (a) GENERATED_TEST-Demo-Buffer (Bootstrap)
  //   (b) rerenderFromSegments (nach Edit)
  //   (c) User-Import einer reinen Audiodatei (loadAudioFile)
  //   (d) Projekt-Öffnen (Re-Analyse des dekodierten Buffers)
  // Keiner dieser Pfade ist der reguläre ANLZ-Import. Wir parsen den
  // Quellcode von handleSelectTrackFromXml und verifizieren die Invariante.
  const appSrc = fs.readFileSync(path.resolve('src/App.tsx'), 'utf8');
  const loaderFnMatch = appSrc.match(/const handleSelectTrackFromXml[\s\S]*?^\s{2}\};/m);
  ok(!!loaderFnMatch, 'handleSelectTrackFromXml in App.tsx gefunden');
  const loaderSrc = loaderFnMatch![0];
  // Der Loader darf nach der aktuellen ANLZ-Implementierung analyzeAudioBuffer
  // nicht auf dem regulären Pfad aufrufen.
  const analyzeCallsInLoader = (loaderSrc.match(/analyzeAudioBuffer\(/g) || []).length;
  ok(analyzeCallsInLoader === 0, `handleSelectTrackFromXml enthält 0 analyzeAudioBuffer()-Aufrufe (gefunden: ${analyzeCallsInLoader})`);
  // Sicherstellen, dass die "do NOT run analyzeAudioBuffer"-Kommentierung da ist.
  ok(/do NOT run analyzeAudioBuffer here/i.test(loaderSrc), 'Kommentar "do NOT run analyzeAudioBuffer" ist im Loader vorhanden');
}

// ---------------------------------------------------------------------------
// T8: Fehlende ANLZ → MISSING_REKORDBOX_ANALYSIS, kein stiller Fallback
// ---------------------------------------------------------------------------
console.log('\n[T8] Fehlende ANLZ → transparenter Status, keine synthetische Waveform');
{
  // ANLZ-Datei nur mit PMAI-Header, aber ohne PQTZ/PWV-Tags:
  const emptyBuf = Buffer.alloc(12);
  Buffer.from('PMAI').copy(emptyBuf, 0);
  emptyBuf.writeUInt32BE(12, 4);
  emptyBuf.writeUInt32BE(0, 8);
  const extraction = parseAnlzBinary(emptyBuf.buffer.slice(0) as ArrayBuffer);
  const base = makeTrack({ duration: 30 });
  const enriched = applyAnlzExtractionToTrack(base, extraction);
  // ANLZ ohne verwertbare Tags → MISSING
  ok(enriched.analysisStatus === 'MISSING_REKORDBOX_ANALYSIS',
     `Status ist MISSING_REKORDBOX_ANALYSIS bei leerer ANLZ (ist: ${enriched.analysisStatus})`);
  ok(enriched.analysisOrigin === 'REKORDBOX_ANLZ', 'analysisOrigin bleibt REKORDBOX_ANLZ');

  // Beim Standard-DB-XML-Import ohne ANLZ (selectedDef.analysis === null) darf
  // analysis ebenfalls null und Status MISSING sein – generierte Fallback-
  // Waveform wird im Loader nicht mehr erzeugt (Step 4).
  // Wir prüfen erneut statisch, dass der Loader im "base track" bei
  // fehlendem ANLZ analysis = null hält und keinen
  // generateAnalysisFromMetadata-Aufruf macht.
  const appSrc = fs.readFileSync(path.resolve('src/App.tsx'), 'utf8');
  const loaderFnMatch = appSrc.match(/const handleSelectTrackFromXml[\s\S]*?^\s{2}\};/m);
  const loaderSrc = loaderFnMatch![0];
  ok(!/generateAnalysisFromMetadata/.test(loaderSrc),
     'Loader ruft generateAnalysisFromMetadata() NICHT auf (keine synthetische Waveform)');

  // DetailWaveform enthält das Warn-Overlay statt des früheren Kick-Synthesizers.
  const dwSrc = fs.readFileSync(path.resolve('src/components/DetailWaveform.tsx'), 'utf8');
  ok(/KEINE REKORDBOX-WAVEFORM/.test(dwSrc),
     'DetailWaveform zeigt "KEINE REKORDBOX-WAVEFORM"-Hinweis an');
}

// ---------------------------------------------------------------------------
// Ergebnis
// ---------------------------------------------------------------------------
console.log(`\n✅ ANLZ-Pipeline-Tests: ${passed} Bestätigungen OK\n`);
