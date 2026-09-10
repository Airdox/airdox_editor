#!/usr/bin/env node
/**
 * @license
 * ANLZ-PROBE – Stufe 4 des Pipeline-Stufenplans (read-only Trockenübung)
 *
 * Liest für einen Track (aus der master.db) oder eine direkt angegebene
 * ANLZ-Datei das vollständige Tag-Inventar der Analysecontainer
 * (ANLZnnnn.DAT / .EXT / .2EX) und beweist die Read-Only-Garantie.
 *
 * Ausgabe pro Datei: Dateigröße, PPTH-Pfad + Plausibilitätsvergleich mit
 * FolderPath+FileNameL der Datenbankzeile, alle gefundenen Tags, pro
 * Waveform-Tag len_entry_bytes/len_entries/Stil, Anzahl PQTZ-Beats,
 * Cue-/Loop-Zahl, PSSI (maskiert/unmaskiert, Mood, Bank, End-Beat) sowie
 * vorhandene, aber nicht dekodierte Tags ("keine Daten liegen lassen").
 *
 * Gate (Stufe 4): mindestens PPTH + PQTZ/PQT2 + ein dekodierbarer PWV*-Tag,
 * sonst FAIL – kein "grün" ohne Evidenz.
 *
 * Harte Regeln: nur lesen (SHA-256-Fingerabdruck vor/nach), nichts erfinden
 * (kein Suchen/Raten: Pfade kommen ausschließlich aus analysisResolver),
 * nichts ändern, Herkunft immer sichtbar (DataOrigin aus dem Parser).
 *
 * Wird mit tsx ausgeführt, damit exakt DERSelbe Parser wie in der App läuft:
 *   npm run probe:anlz -- --db "<master.db>" --track 12345
 *   npm run probe:anlz -- --anlz "D:\...\ANLZ0000.DAT"
 *
 * Exit-Code: 0 = Gate erfüllt, 1 = Gate verletzt / Fehler.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { parseAnlzBinary } from '../src/rekordbox/anlzParser.ts';
import {
  resolveAnalysisFilePath,
  deriveSiblingExtension,
  normalizeAudioKey,
} from '../src/rekordbox/analysisResolver.ts';

const require = createRequire(import.meta.url);
const dbReader = require('../electron/dbReader.cjs');

const DECODED_TAGS = new Set([
  'PPTH', 'PQTZ', 'PQT2', 'PCOB', 'PCO2', 'PSSI',
  'PWAV', 'PWV2', 'PWV3', 'PWV4', 'PWV5', 'PWV6', 'PWV7',
]);

// ---------------------------------------------------------------------------
// CLI / Ausgabe
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { db: null, track: null, anlz: null, json: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--db') options.db = argv[++i] ?? null;
    else if (a === '--track') options.track = argv[++i] ?? null;
    else if (a === '--anlz') options.anlz = argv[++i] ?? null;
    else if (a === '--json') options.json = argv[++i] ?? null;
    else if (a === '--help' || a === '-h') options.help = true;
  }
  return options;
}

const HELP = `anlz-probe – ANLZ-Tag-Inventar (Stufe 4, read-only)

  --db <pfad>      master.db angeben, aus der die Track-Zeile gelesen wird
  --track <id|txt> Track-ID oder Titel-Teil (Standard: erste Zeile)
  --anlz <datei>   ANLZ-Datei direkt untersuchen (ohne Datenbank)
  --json <datei>   maschinenlesbaren Bericht schreiben
  --help           diese Hilfe
`;

const LINES = [];
const REPORT = { steps: [], files: [], gate: null, result: null };

function line(text = '') {
  LINES.push(text);
  process.stdout.write(`${text}\n`);
}
function step(index, title, status, detail) {
  line(`${`[${index}] ${title}`.padEnd(38, ' ')} ${status.padEnd(5, ' ')} ${detail}`);
  REPORT.steps.push({ index, title, status, detail });
}
function sub(text) {
  line(`      ${text}`);
}
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function fingerprint(filePath) {
  const data = fs.readFileSync(filePath);
  const stat = fs.statSync(filePath);
  return { size: stat.size, mtimeMs: Math.round(stat.mtimeMs), sha256: crypto.createHash('sha256').update(data).digest('hex') };
}

// ---------------------------------------------------------------------------
// Lauf
// ---------------------------------------------------------------------------

function run(options) {
  line('AIRDOX SMART EDITOR · ANLZ-PROBE (Stufe 4, read-only Trockenuebung)');
  line('='.repeat(76));
  line('Vertrag: nur lesen · nichts erfinden · nichts aendern · Herkunft sichtbar');
  line('');

  step(1, 'Parser-Modul', 'PASS', 'src/rekordbox/anlzParser.ts (identisch zum App-Pfad)');

  // [2] Zielcontainer bestimmen -------------------------------------------------
  let audioPathFromDb = null;
  let resolved = null;
  const candidates = [];

  if (options.anlz) {
    resolved = path.resolve(options.anlz);
    if (!fs.existsSync(resolved)) {
      step(2, 'ANLZ-Quelle bestimmen', 'FAIL', `${resolved} existiert nicht`);
      finish(false);
      return 1;
    }
  } else {
    if (!options.db) {
      step(2, 'ANLZ-Quelle bestimmen', 'FAIL', 'weder --db noch --anlz angegeben');
      sub('Beispiel: npm run probe:anlz -- --db "D:\\rekordbox\\dataSources\\master.db" --track 12345');
      finish(false);
      return 1;
    }
    const opened = dbReader.openRekordboxDb(options.db);
    if (!opened.available || !opened.db) {
      step(2, 'ANLZ-Quelle bestimmen', 'FAIL', `master.db nicht lesbar: ${opened.reason || 'unbekannt'}`);
      finish(false);
      return 1;
    }
    const db = opened.db;
    try {
      let row = null;
      if (options.track) {
        row = db.prepare('SELECT * FROM djmdContent WHERE CAST(ID AS TEXT) = ? LIMIT 1').get(options.track) || null;
        if (!row) {
          row = db.prepare('SELECT * FROM djmdContent WHERE Title LIKE ? LIMIT 1').get(`%${options.track}%`) || null;
        }
      } else {
        row = db.prepare('SELECT * FROM djmdContent ORDER BY ID LIMIT 1').get() || null;
      }
      if (!row) {
        step(2, 'ANLZ-Quelle bestimmen', 'FAIL', 'keine Track-Zeile in djmdContent gefunden');
        finish(false);
        return 1;
      }
      const folderPath = row.FolderPath ?? '';
      const fileName = row.FileNameL ?? '';
      audioPathFromDb = `${folderPath}${fileName}`;
      const adp = row.AnalysisDataPath ?? '';
      sub(`Track ${row.ID} · ${row.Title ?? ''} · Audio: ${audioPathFromDb}`);
      if (!String(adp).trim()) {
        step(2, 'ANLZ-Quelle bestimmen', 'FAIL', 'Track hat keinen AnalysisDataPath (Stufe 2)');
        sub('Rückfall laut Plan: PPTH-Scan der ANLZ-Ordner (App), hier manuell --anlz angeben.');
        finish(false);
        return 1;
      }
      resolved = resolveAnalysisFilePath(path.dirname(path.resolve(options.db)), String(adp));
      if (!resolved) {
        step(2, 'ANLZ-Quelle bestimmen', 'FAIL', `AnalysisDataPath nicht deterministisch auflösbar: ${adp}`);
        sub('Kein Raten: analysisResolver liefert nur absolute Pfade oder <dbDir>/share/PIONEER/…');
        finish(false);
        return 1;
      }
      sub(`AnalysisDataPath: ${adp} → ${resolved}`);
    } finally {
      db.close();
    }
  }

  // Geschwister-Container DAT/EXT/2EX – reine Pfadableitung, kein Suchen.
  const exts = ['DAT', 'EXT', '2EX'];
  const seen = new Set();
  for (const ext of exts) {
    const direct = new RegExp(`\\.${ext}$`, 'i').test(resolved) ? resolved : deriveSiblingExtension(resolved, ext);
    const via = direct ?? (new RegExp(`\\.${ext}$`, 'i').test(resolved) ? resolved : null);
    const p = via || (ext === 'DAT' ? deriveSiblingExtension(resolved, 'DAT') : null);
    if (!p) continue;
    const norm = path.resolve(p);
    if (seen.has(norm)) continue;
    seen.add(norm);
    candidates.push({ path: norm, kind: ext });
  }
  // Falls resolved selbst eine andere Endung trägt, immer mit aufnehmen.
  if (!seen.has(path.resolve(resolved))) {
    candidates.push({ path: path.resolve(resolved), kind: path.extname(resolved).replace('.', '').toUpperCase() || 'DAT' });
  }

  const existing = candidates.filter((c) => fs.existsSync(c.path));
  if (!existing.length) {
    step(2, 'ANLZ-Quelle bestimmen', 'FAIL', `kein Container existiert: ${candidates.map((c) => c.path).join(' | ')}`);
    finish(false);
    return 1;
  }
  step(2, 'ANLZ-Quelle bestimmen', 'PASS', `${existing.length}/${candidates.length} Container vorhanden (DAT/EXT/2EX)`);
  for (const c of candidates) sub(`${c.kind.padEnd(4, ' ')} ${c.path}${fs.existsSync(c.path) ? '' : '  (fehlt)'}`);

  // [3] Fingerabdrücke vorher ----------------------------------------------------
  const before = new Map();
  for (const c of existing) before.set(c.path, fingerprint(c.path));
  step(3, 'Fingerabdruck VORHER', 'PASS', `${existing.length} Datei(en) gehasht (SHA-256)`);

  // [4] Inventar pro Datei ---------------------------------------------------------
  let hasPpth = false;
  let hasPqtz = false;
  let hasPwv = false;
  let ppthMatched = audioPathFromDb === null ? null : false;

  for (const c of existing) {
    const buffer = fs.readFileSync(c.path);
    const parsed = parseAnlzBinary(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    const fileReport = {
      path: c.path,
      kind: c.kind,
      size: buffer.byteLength,
      tagsFound: parsed.tagsFound,
      tagInventory: parsed.tagInventory,
      ppth: parsed.analysisPath ?? null,
      ppthMatch: null,
      beats: parsed.beatGrid?.beats.length ?? 0,
      bpm: parsed.bpm ?? null,
      cues: parsed.cues.length,
      loops: parsed.loops.length,
      phrases: parsed.phrases.length,
      pssi: {
        masked: parsed.pssiMasked ?? null,
        mood: parsed.pssiMood ?? null,
        bank: parsed.pssiBank ?? null,
        endBeat: parsed.pssiEndBeat ?? null,
      },
      warnings: parsed.warnings,
      undecodedTags: parsed.tagInventory.filter((t) => !DECODED_TAGS.has(t.tag)).map((t) => t.tag),
    };

    line('');
    line(`── ${c.kind}: ${c.path} (${formatBytes(buffer.byteLength)})`);
    sub(`Tags: ${parsed.tagsFound.join(', ') || '(keine)'}`);

    if (parsed.analysisPath) {
      hasPpth = true;
      fileReport.ppth = parsed.analysisPath;
      sub(`PPTH: ${parsed.analysisPath}`);
      if (audioPathFromDb !== null) {
        const ok = normalizeAudioKey(parsed.analysisPath) === normalizeAudioKey(audioPathFromDb);
        fileReport.ppthMatch = ok;
        ppthMatched = ppthMatched || ok;
        sub(`PPTH-Plausibilität vs. djmdContent-Pfad: ${ok ? 'PASS (exakter Treffer)' : 'WARN (weicht ab – Zuordnung prüfen)'}`);
      }
    } else {
      sub('PPTH: (nicht vorhanden)');
    }

    if (parsed.beatGrid?.beats.length) {
      hasPqtz = true;
      const beats = parsed.beatGrid.beats;
      sub(`PQTZ: ${beats.length} Beats · BPM ${parsed.bpm} · ${beats[0].time.toFixed(3)} s … ${beats[beats.length - 1].time.toFixed(3)} s`);
    }

    for (const inv of parsed.tagInventory) {
      if (inv.waveform) {
        hasPwv = true;
        sub(`PWV  ${inv.tag} @0x${inv.offset.toString(16)} · len_entry_bytes ${inv.waveform.entryBytes} · len_entries ${inv.waveform.entryCount} · Stil ${inv.waveform.style}`);
      }
    }
    if (parsed.cues.length || parsed.loops.length) {
      sub(`Cues: ${parsed.cues.length} · Loops: ${parsed.loops.length}${parsed.cues.some((q) => q.comment) ? ' · mit Kommentaren' : ''}`);
    }
    if (parsed.phrases.length || parsed.pssiMasked !== undefined) {
      sub(`PSSI: ${parsed.phrases.length} Phrasen · maskiert=${parsed.pssiMasked} · Mood=${parsed.pssiMood ?? '–'} · Bank=${parsed.pssiBank ?? '–'} · EndBeat=${parsed.pssiEndBeat ?? '–'}`);
    }
    if (fileReport.undecodedTags.length) {
      sub(`Vorhanden, nicht dekodiert (berichtet, unangetastet): ${fileReport.undecodedTags.join(', ')}`);
    }
    for (const warning of parsed.warnings) sub(`WARN ${warning}`);

    REPORT.files.push(fileReport);
  }

  // [5] Gate ------------------------------------------------------------------------
  const gatePass = hasPpth && hasPqtz && hasPwv;
  REPORT.gate = { ppth: hasPpth, pqtz: hasPqtz, pwv: hasPwv, ppthMatch: ppthMatched, pass: gatePass };
  step(5, 'Gate PPTH+PQTZ+PWV*', gatePass ? 'PASS' : 'FAIL', `PPTH ${hasPpth ? '✓' : '✗'} · PQTZ ${hasPqtz ? '✓' : '✗'} · PWV* ${hasPwv ? '✓' : '✗'}`);
  if (audioPathFromDb !== null) {
    step(6, 'PPTH ↔ Datenbank-Pfad', ppthMatched ? 'PASS' : 'WARN', ppthMatched ? 'exakter normalisierter Treffer' : 'kein exakter Treffer – Zuordnung prüfen (kein Fuzzy-Matching)');
  }

  // [7] Fingerabdrücke nachher -------------------------------------------------------
  let unchanged = true;
  for (const c of existing) {
    const after = fingerprint(c.path);
    const b = before.get(c.path);
    if (after.sha256 !== b.sha256 || after.size !== b.size || after.mtimeMs !== b.mtimeMs) unchanged = false;
  }
  REPORT.fingerprintUnchanged = unchanged;
  step(7, 'Fingerabdruck NACHHER', unchanged ? 'PASS' : 'FAIL', unchanged ? 'alle ANLZ-Quellen byte-identisch' : 'QUELLE VERÄNDERT!');

  finish(gatePass && unchanged);
  return gatePass && unchanged ? 0 : 1;
}

function finish(ok) {
  line('');
  line('-'.repeat(76));
  REPORT.result = ok ? 'PASS' : 'FAIL';
  line(ok
    ? 'ERGEBNIS: PASS – ANLZ-Inventar vollständig (PPTH+PQTZ+PWV*), Quellen unverändert.'
    : 'ERGEBNIS: FAIL – Gate nicht erfüllt oder Quelle verändert (Details oben).');
}

// ---------------------------------------------------------------------------

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

let exitCode = 1;
try {
  exitCode = run(options);
} catch (error) {
  line('');
  line(`PROBE ABGEBROCHEN: ${error?.message || error}`);
  REPORT.result = 'FAIL';
  exitCode = 1;
}

if (options.json) {
  try {
    fs.writeFileSync(options.json, `${JSON.stringify(REPORT, null, 2)}${os.EOL}`, 'utf-8');
    line(`Bericht geschrieben: ${path.resolve(options.json)}`);
  } catch (error) {
    line(`Bericht konnte nicht geschrieben werden: ${error.message}`);
  }
}

process.exit(exitCode);
