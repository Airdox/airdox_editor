#!/usr/bin/env node
/**
 * @license
 * XML↔MASTER.DB-IDENTITÄTSPROBE (read-only, Stufe „Entscheidungstor" aus
 * REKORDBOX_PIPELINE_ARCHITECTURE.md §5)
 *
 * Beantwortet exakt eine Frage: **Ist XML-TrackID == djmdContent.ID auf
 * DIESER Installation?** — also die Zuordnung, die Rekordbox selbst beim
 * XML-Export aus der master.db erzeugt.
 *
 * Verfahren (§5.1, unverändert):
 *   1. XML einlesen: alle COLLECTION/TRACK (TrackID, Location).
 *   2. master.db read-only entschlüsseln, djmdContent laden
 *      (ID, FolderPath, FileNameL, AnalysisDataPath).
 *   3. Für jede XML-Spur klassifizieren:
 *        ID_MATCH        – genau eine djmdContent-Zeile mit dieser ID UND
 *                          identischer kanonischer Dateipfad → Vertrag bestätigt.
 *        ID_PATH_CONFLICT– ID existiert, aber der Pfad ist ein anderer
 *                          → Vertrag widerlegt (falsche DB oder fremde XML).
 *        ID_MISSING      – ID existiert nicht in djmdContent.
 *        NO_LOCATION     – XML-Spur ohne Location (nicht bewertbar).
 *   4. Invarianten: 100 % ID_MATCH ⇒ PASS — der ID-Vertrag ist für diese
 *      Bibliothek empirisch bestätigt; die App nutzt dann ausschließlich
 *      die Rekordbox-eigene Zuordnung.
 *
 * Garantien:
 *   - master.db wird ausschließlich SQLite-readonly geöffnet (dbReader.cjs).
 *   - Es wird nichts geschrieben, nichts berechnet, nichts angepasst.
 *   - Der SQLCipher-Schlüssel wird niemals ausgegeben.
 *
 * Benutzung (Windows, im Repo-Ordner):
 *   node scripts/xml-db-identity-probe.mjs --xml "C:\Pfad\zur\collection.xml"
 *   node scripts/xml-db-identity-probe.mjs --xml collection.xml --db "D:\PIONEER\Master\master.db"
 *   node scripts/xml-db-identity-probe.mjs --xml collection.xml --json report.json
 *
 * Ohne --db werden die Standard-Rekordbox-Orte automatisch durchsucht
 * (locateRekordboxDatabases, identisch zur App).
 *
 * Exit-Code: 0 = ID-Vertrag bestätigt (PASS), 1 = widerlegt/nicht prüfbar.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Kanonisierung — bewusst identisch zu src/rekordbox/analysisResolver.ts
// (normalizeAudioKey): URI-Decode, file://-Abwurf, \\?\-Präfix, Separatoren,
// Kleinschreibung. Keine weiteren Operationen (kein Fuzzy, kein Basename).
// ---------------------------------------------------------------------------
export function normalizeAudioKey(input) {
  if (!input) return '';
  let s = String(input).trim();
  const fileMatch = s.match(/^file:\/\/(localhost)?\/?/i);
  if (fileMatch) s = s.slice(fileMatch[0].length);
  s = s.replace(/^\\\\\?\\([a-zA-Z]:)/, '$1');
  if (s.includes('%')) {
    try {
      s = decodeURIComponent(s);
    } catch {
      /* Rohwert behalten */
    }
  }
  s = s.replace(/\\/g, '/');
  s = s.replace(/^\/([a-zA-Z]:\/)/, '$1');
  s = s.replace(/\/{2,}/g, '/');
  return s.toLowerCase();
}

/** FolderPath+FileNameL → exakte DB-Adresse (identisch zu joinAudioPath). */
export function joinAudioPath(folder, fileName) {
  const file = (fileName ?? '').trim();
  const dir = (folder ?? '').trim();
  if (!file) return dir;
  if (!dir) return file;
  const stripped = dir.replace(/[\\/]+$/, '');
  const base = stripped.split(/[\\/]/).pop() ?? '';
  if (base.toLowerCase() === file.toLowerCase()) return stripped;
  const sep = dir.includes('\\') ? '\\' : '/';
  return `${stripped}${sep}${file}`;
}

// ---------------------------------------------------------------------------
// XML: nur COLLECTION/TRACK-Attribute TrackID + Location (regex-basiert,
// ausreichend für Rekordbox-Export-XML; es wird nichts interpretiert).
// ---------------------------------------------------------------------------
export function extractXmlTracks(xmlText) {
  const tracks = [];
  const collMatch = xmlText.match(/<COLLECTION[\s\S]*?<\/COLLECTION>/i);
  const scope = collMatch ? collMatch[0] : xmlText;
  const re = /<TRACK\b([^>]*)\/?>(?:)/gi;
  let m;
  while ((m = re.exec(scope)) !== null) {
    const attrs = m[1];
    const id = /\bTrackID="([^"]*)"/i.exec(attrs)?.[1];
    const location = /\bLocation="([^"]*)"/i.exec(attrs)?.[1];
    const name = /\bName="([^"]*)"/i.exec(attrs)?.[1];
    if (id !== undefined) tracks.push({ trackId: id.trim(), location: location ?? '', name: name ?? '' });
  }
  return tracks;
}

// ---------------------------------------------------------------------------
// Klassifikation (pure Funktion, unit-testbar): XML-Spuren gegen die
// djmdContent-Zeilen. dbDirKey erlaubt die dokumentierte contents_-Relativform
// (§5.2) — dieselbe Datei-Adresse in zwei exakten Schreibweisen.
// ---------------------------------------------------------------------------
export function classifyIdentity(xmlTracks, contentRows, dbDir) {
  const byId = new Map();
  for (const row of contentRows) {
    const id = String(row.ID ?? '');
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(row);
  }
  const dbDirKey = normalizeAudioKey(dbDir);

  const results = [];
  for (const t of xmlTracks) {
    const rows = byId.get(String(t.trackId)) ?? [];
    if (!t.location) {
      results.push({ ...t, verdict: 'NO_LOCATION' });
      continue;
    }
    if (rows.length === 0) {
      results.push({ ...t, verdict: 'ID_MISSING' });
      continue;
    }
    if (rows.length > 1) {
      results.push({ ...t, verdict: 'ID_DUPLICATE', dbRows: rows.length });
      continue;
    }
    const row = rows[0];
    const dbPath = joinAudioPath(row.FolderPath, row.FileNameL);
    const dbKey = normalizeAudioKey(dbPath);
    const xmlKey = normalizeAudioKey(t.location);
    const candidates = [dbKey];
    if (dbDirKey && dbKey.startsWith(`${dbDirKey}/`)) {
      const rel = dbKey.slice(dbDirKey.length + 1);
      if (rel) candidates.push(rel, `/${rel}`);
    }
    if (candidates.includes(xmlKey)) {
      results.push({
        ...t,
        verdict: 'ID_MATCH',
        dbId: String(row.ID),
        analysisDataPath: String(row.AnalysisDataPath ?? ''),
      });
    } else {
      results.push({ ...t, verdict: 'ID_PATH_CONFLICT', dbPath, xmlKey, dbKey });
    }
  }
  return results;
}

export function summarize(results) {
  const counts = { ID_MATCH: 0, ID_PATH_CONFLICT: 0, ID_MISSING: 0, ID_DUPLICATE: 0, NO_LOCATION: 0 };
  for (const r of results) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  const evaluable = results.length - counts.NO_LOCATION;
  const pass = evaluable > 0 && counts.ID_MATCH === evaluable;
  const emptyAnalysis = results.filter((r) => r.verdict === 'ID_MATCH' && !r.analysisDataPath).length;
  return { counts, evaluable, pass, emptyAnalysis };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const o = { xml: null, db: null, json: null, limit: 10, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--xml') o.xml = argv[++i] ?? null;
    else if (a === '--db') o.db = argv[++i] ?? null;
    else if (a === '--json') o.json = argv[++i] ?? null;
    else if (a === '--limit') o.limit = Math.max(0, Number.parseInt(argv[++i] ?? '10', 10) || 10);
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.xml) {
    console.log('Benutzung: node scripts/xml-db-identity-probe.mjs --xml <export.xml> [--db <master.db>] [--json <report.json>] [--limit N]');
    process.exit(opts.help ? 0 : 1);
  }

  const dbReader = require('../electron/dbReader.cjs');

  const xmlText = fs.readFileSync(opts.xml, 'utf8');
  const xmlTracks = extractXmlTracks(xmlText);
  console.log(`XML: ${opts.xml} — ${xmlTracks.length} TRACK-Einträge in COLLECTION.`);
  if (xmlTracks.length === 0) {
    console.error('FAIL: Keine Tracks in der XML gefunden.');
    process.exit(1);
  }

  let dbPath = opts.db;
  if (!dbPath) {
    const candidates = dbReader.locateRekordboxDatabases().filter((c) => c.kind === 'MASTER_DB');
    if (candidates.length === 0) {
      console.error('FAIL: Keine master.db gefunden. Bitte mit --db "<Pfad>\\master.db" angeben.');
      process.exit(1);
    }
    dbPath = candidates[0].path;
    console.log(`master.db automatisch gefunden: ${dbPath} (${candidates[0].label})`);
  }

  const before = fs.statSync(dbPath);
  const result = dbReader.readRekordboxDatabase(dbPath);
  if (!result.available || !result.rows) {
    console.error(`FAIL: master.db nicht lesbar: ${result.reason ?? 'unbekannt'}`);
    process.exit(1);
  }
  if (result.dbType !== 'MASTER_DB') {
    console.error(`FAIL: ${dbPath} ist keine master.db (erkannt: ${result.dbType}).`);
    process.exit(1);
  }
  const after = fs.statSync(dbPath);
  const untouched = before.size === after.size && before.mtimeMs === after.mtimeMs;
  console.log(`master.db read-only gelesen: ${result.rows.content.length} djmdContent-Zeilen. Datei unverändert: ${untouched ? 'JA' : 'NEIN (!)'}`);

  const dbDir = path.dirname(dbPath);
  const results = classifyIdentity(xmlTracks, result.rows.content, dbDir);
  const summary = summarize(results);

  console.log('\n=== ERGEBNIS (Verfahren §5.1) ===');
  console.log(`  ID_MATCH         : ${summary.counts.ID_MATCH} (ID existiert genau einmal + exakter Pfad identisch)`);
  console.log(`  ID_PATH_CONFLICT : ${summary.counts.ID_PATH_CONFLICT} (ID existiert, Pfad weicht ab)`);
  console.log(`  ID_MISSING       : ${summary.counts.ID_MISSING} (ID nicht in djmdContent)`);
  console.log(`  ID_DUPLICATE     : ${summary.counts.ID_DUPLICATE} (ID mehrfach — Schemafehler)`);
  console.log(`  NO_LOCATION      : ${summary.counts.NO_LOCATION} (nicht bewertbar)`);
  if (summary.emptyAnalysis > 0) {
    console.log(`  HINWEIS: ${summary.emptyAnalysis} ID_MATCH-Zeilen ohne AnalysisDataPath (Track in RB nie analysiert).`);
  }

  const problems = results.filter((r) => r.verdict !== 'ID_MATCH' && r.verdict !== 'NO_LOCATION');
  if (problems.length > 0 && opts.limit > 0) {
    console.log(`\nErste ${Math.min(opts.limit, problems.length)} Abweichungen:`);
    for (const p of problems.slice(0, opts.limit)) {
      console.log(`  [${p.verdict}] TrackID ${p.trackId} „${p.name}"`);
      if (p.verdict === 'ID_PATH_CONFLICT') {
        console.log(`      XML: ${p.xmlKey}`);
        console.log(`      DB : ${p.dbKey}`);
      }
    }
  }

  if (opts.json) {
    fs.writeFileSync(opts.json, JSON.stringify({ dbPath, xml: opts.xml, summary, results }, null, 2));
    console.log(`\nVollständiger Bericht: ${opts.json}`);
  }

  if (summary.pass) {
    console.log('\nPASS: XML-TrackID == djmdContent.ID ist für diese Bibliothek zu 100 % bestätigt.');
    console.log('Die App nutzt damit exakt die Zuordnung, die Rekordbox selbst beim Export verwendet.');
    process.exit(0);
  }
  console.log('\nFAIL/WARN: Der ID-Vertrag ist für diese XML/DB-Kombination NICHT vollständig bestätigt.');
  console.log('Mögliche Ursachen: XML stammt aus anderer Bibliothek/Drittprogramm, falsche master.db, verschobene Dateien.');
  process.exit(1);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isDirectRun) {
  main().catch((e) => {
    console.error('FAIL:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
