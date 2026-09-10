#!/usr/bin/env node
/**
 * @license
 * MASTER-DB-PROBE – Stufe 0/1 der Pipeline (Trockenübung, read-only)
 *
 * Beantwortet exakt eine Frage: **Haben wir lesenden Zugriff auf die
 * Rekordbox-master.db (SQLCipher)?** und – wenn ja – was steht drin.
 *
 * Garantie (identisch zum Rest der Anwendung):
 *   - Die Datei wird ausschliesslich mit SQLite `readonly` geöffnet.
 *   - Es wird KEINE unverschlüsselte Kopie geschrieben (`sqlcipher_export`
 *     wird bewusst NICHT verwendet): die Entschlüsselung passiert im Speicher
 *     des Prozesses, kein Byte verlässt den RAM.
 *   - Vor und nach dem Lauf wird ein Fingerabdruck (Groesse, mtime, SHA-256)
 *     genommen. Sind beide identisch, ist die Read-Only-Garantie bewiesen.
 *   - Der SQLCipher-Schluessel wird niemals ausgegeben, nur maskiert
 *     referenziert (erste 6 Zeichen + Laenge + SHA-256-Praefix).
 *
 * Benutzung:
 *   npm run probe:masterdb
 *   node scripts/masterdb-probe.mjs --db "D:\rekordbox\dataSources\master.db"
 *   node scripts/masterdb-probe.mjs --root D:\ --limit 5 --json report.json
 *   node scripts/masterdb-probe.mjs --track 12345
 *
 * Exit-Code: 0 = Zugriff moeglich (PASS/WARN), 1 = kein Zugriff (FAIL).
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const dbReader = require('../electron/dbReader.cjs');

// ---------------------------------------------------------------------------
// CLI-Argumente
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    db: null,
    roots: [],
    track: null,
    limit: 3,
    json: null,
    samples: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--db') options.db = argv[++i] ?? null;
    else if (arg === '--root') options.roots.push(argv[++i] ?? '');
    else if (arg === '--track') options.track = argv[++i] ?? null;
    else if (arg === '--limit') options.limit = Math.max(0, Number.parseInt(argv[++i] ?? '3', 10) || 3);
    else if (arg === '--json') options.json = argv[++i] ?? null;
    else if (arg === '--no-samples') options.samples = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
  }
  return options;
}

const HELP = `masterdb-probe – Rekordbox master.db read-only Trockenuebung

  --db <pfad>      master.db / exportLibrary.db explizit angeben (empfohlen fuer D:)
  --root <ordner>  zusaetzliches Suchverzeichnis fuer die Auto-Lokalisierung (mehrfach)
  --track <id|txt> einzelne Zeile aus djmdContent/detailiert zeigen (ID oder Titel-Teil)
  --limit <n>      Anzahl Stichproben-Zeilen (Standard 3, 0 = keine)
  --json <datei>   maschinenlesbaren Bericht schreiben (neue Datei, nie die Quelle)
  --no-samples     keine Zeileninhalte ausgeben
  --help           diese Hilfe

Beispiele (Windows):
  npm run probe:masterdb
  node scripts/masterdb-probe.mjs --db "D:\\rekordbox\\dataSources\\master.db"
  node scripts/masterdb-probe.mjs --root "D:\\" --json masterdb-report.json
`;

// ---------------------------------------------------------------------------
// Ausgabe
// ---------------------------------------------------------------------------

const LINES = [];
const REPORT = { steps: [], candidates: [], target: null, tables: [], columns: [], counts: null, samples: [], fingerprint: null, result: null };

function line(text = '') {
  LINES.push(text);
  process.stdout.write(`${text}\n`);
}

function step(index, title, status, detail) {
  const label = `[${index}] ${title}`;
  line(`${label.padEnd(38, ' ')} ${status.padEnd(5, ' ')} ${detail}`);
  REPORT.steps.push({ index, title, status, detail });
}

function sub(text) {
  line(`      ${text}`);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fingerprint(filePath) {
  const stat = fs.statSync(filePath);
  const data = fs.readFileSync(filePath);
  return {
    size: stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
  };
}

// SYNC mit src/rekordbox/analysisResolver.ts joinAudioPath: Rekordbox 7 kann in
// FolderPath bereits den vollen Dateipfad speichern; FileNameL wiederholt dann
// den Basisnamen. Naive Verkettung ergäbe ".../x.mp3x.mp3".
function joinAudioPath(folder, fileName) {
  const file = String(fileName ?? '').trim();
  const dir = String(folder ?? '').trim();
  if (!file) return dir;
  if (!dir) return file;
  const stripped = dir.replace(/[\\/]+$/, '');
  if (stripped.toLowerCase().endsWith(file.toLowerCase())) return stripped;
  const sep = dir.includes('\\') ? '\\' : '/';
  return `${stripped}${sep}${file}`;
}

function maskKey(key) {
  if (!key) return '(kein Schluessel)';
  return `${key.slice(0, 6)}… (${key.length} Zeichen, sha256 ${crypto.createHash('sha256').update(key).digest('hex').slice(0, 8)})`;
}

// ---------------------------------------------------------------------------
// Zusätzliche, begrenzte Laufwerkssuche (--root, z. B. D:\)
// ---------------------------------------------------------------------------

function scanRoot(root) {
  const found = [];
  const seen = new Set();
  let visited = 0;
  const visit = (dir, depth) => {
    if (depth > 8 || visited > 200000) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      visited += 1;
      const full = path.join(dir, entry.name);
      if (entry.isFile() && /^(master|exportlibrary)\.db$/i.test(entry.name)) {
        const resolved = path.resolve(full);
        if (seen.has(resolved)) continue;
        seen.add(resolved);
        found.push({
          path: resolved,
          kind: entry.name.toLowerCase() === 'exportlibrary.db' ? 'ONE_LIBRARY' : 'MASTER_DB',
          label: `${entry.name} (--root ${root})`,
        });
      } else if (entry.isDirectory()) {
        visit(full, depth + 1);
      }
    }
  };
  visit(root, 0);
  return found;
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

function run(options) {
  const version = (() => {
    try {
      return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8')).version;
    } catch {
      return '?';
    }
  })();

  line('AIRDOX SMART EDITOR · MASTER-DB-PROBE (read-only Trockenuebung)');
  line('='.repeat(72));
  line(`Version ${version} · Node ${process.version} · Plattform ${process.platform}`);
  line('Vertrag: nur lesen · keine Kopie · keine Aenderung · keine Berechnung');
  line('');

  // [1] natives SQLCipher-Modul
  let sqliteVersion = '?';
  if (!dbReader.isCipherAvailable()) {
    step(1, 'SQLCipher-Modul', 'FAIL', 'better-sqlite3-multiple-ciphers nicht ladbar');
    sub('Installation: npm install  ·  fuer die Desktop-App: npm run rebuild:electron');
    line('');
    line('ERGEBNIS: FAIL – ohne SQLCipher-Bindung ist die master.db nicht lesbar.');
    REPORT.result = 'FAIL';
    return 1;
  }
  try {
    const D = require('better-sqlite3-multiple-ciphers');
    const probeDb = new D(':memory:');
    sqliteVersion = probeDb.prepare('SELECT sqlite_version() AS v').get().v;
    probeDb.close();
  } catch {
    /* Versionsanzeige ist optional */
  }
  step(1, 'SQLCipher-Modul', 'PASS', `better-sqlite3-multiple-ciphers (SQLite ${sqliteVersion})`);

  // [2] Lokalisieren
  const candidates = [];
  if (options.db) {
    const exists = fs.existsSync(options.db) && fs.statSync(options.db).isFile();
    const base = path.basename(options.db).toLowerCase();
    candidates.push({
      path: path.resolve(options.db),
      kind: base === 'exportlibrary.db' ? 'ONE_LIBRARY' : base === 'master.db' ? 'MASTER_DB' : null,
      label: 'explizit angegeben (--db)',
      exists,
    });
  }
  try {
    candidates.push(...dbReader.locateRekordboxDatabases());
  } catch (error) {
    sub(`Auto-Lokalisierung fehlgeschlagen: ${error.message}`);
  }
  for (const root of options.roots) {
    if (root) candidates.push(...scanRoot(root));
  }

  const seen = new Set();
  const unique = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = path.resolve(candidate.path);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ ...candidate, path: key });
  }

  if (!unique.length) {
    step(2, 'Datenbank lokalisieren', 'FAIL', 'keine master.db / exportLibrary.db gefunden');
    sub('Windows-Standard: %APPDATA%\\Pioneer\\rekordbox7|rekordbox6\\… sowie rekordboxAgent\\storage\\options.json (db-path)');
    sub('Datenpartition: node scripts/masterdb-probe.mjs --root "D:\\"');
    line('');
    line('ERGEBNIS: FAIL – keine Datenbank gefunden.');
    REPORT.result = 'FAIL';
    return 1;
  }

  REPORT.candidates = unique.map((c) => ({ path: c.path, kind: c.kind, label: c.label }));
  const missing = unique.filter((c) => c.exists === false);
  for (const entry of missing) sub(`nicht vorhanden: ${entry.path}`);
  const usable = unique.filter((c) => c.exists !== false && c.kind);
  if (!usable.length) {
    step(2, 'Datenbank lokalisieren', 'FAIL', `${unique.length} Kandidat(en), aber keine lesbare Datei`);
    line('');
    line('ERGEBNIS: FAIL – angegebener Pfad existiert nicht.');
    REPORT.result = 'FAIL';
    return 1;
  }
  const target = usable[0];
  const stat = fs.statSync(target.path);
  step(2, 'Datenbank lokalisieren', 'PASS', `${target.path} (${formatBytes(stat.size)}, ${new Date(stat.mtimeMs).toISOString()})`);
  sub(`Typ: ${target.kind} · Herkunft: ${target.label} · Kandidaten gesamt: ${unique.length}`);
  REPORT.target = { path: target.path, kind: target.kind, size: stat.size };

  // [3] Fingerabdruck vorher
  const before = fingerprint(target.path);
  step(3, 'Fingerabdruck VORHER', 'PASS', `sha256 ${before.sha256.slice(0, 16)}… · ${formatBytes(before.size)}`);

  // [4] Entschlüsselung (in-memory, read-only)
  const key = target.kind === 'MASTER_DB' ? dbReader.getMasterDbKey() : dbReader.getOneLibraryKey();
  const opened = dbReader.openRekordboxDb(target.path);
  if (!opened.available || !opened.db) {
    step(4, 'Entschluesselung (in-memory)', 'FAIL', opened.reason || 'unbekannter Fehler');
    sub('Moegliche Ursachen: Datei ist keine Rekordbox-Datenbank, Rekordbox-Version abweichend,');
    sub('oder die Datei ist durch einen laufenden Rekordbox-Prozess blockiert.');
    line('');
    line('ERGEBNIS: FAIL – Zugriff auf die master.db nicht moeglich.');
    REPORT.result = 'FAIL';
    return 1;
  }
  const db = opened.db;
  // Beweis, dass die Quelle wirklich verschlüsselt ist: eine Klartext-SQLite-
  // Datei beginnt mit "SQLite format 3\0", eine SQLCipher-Datei mit Salz.
  const headerBuf = Buffer.alloc(16);
  const fh = fs.openSync(target.path, 'r');
  try {
    fs.readSync(fh, headerBuf, 0, 16, 0);
  } finally {
    fs.closeSync(fh);
  }
  const isPlainSqlite = headerBuf.toString('latin1').startsWith('SQLite format 3');
  REPORT.target.header = headerBuf.toString('hex');
  step(4, 'Entschluesselung (in-memory)', 'PASS', `Schluessel ${maskKey(key)}`);
  sub(`Datei-Header: ${isPlainSqlite ? 'KLARTEXT (SQLite format 3) – Datei ist nicht verschlüsselt' : 'kein Klartext-Header → SQLCipher-verschlüsselt'}`);
  sub('SQLCipher-Modus: cipher=sqlcipher, legacy=4, readonly=true');
  sub('Es wurde keine unverschlüsselte Kopie erzeugt (kein sqlcipher_export).');

  try {
    // [5] Schema-Scan
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name);
    const tableRows = [];
    for (const name of tables) {
      let count = -1;
      try {
        count = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n;
      } catch {
        /* Tabelle nicht zaehlbar */
      }
      tableRows.push({ name, count });
    }
    REPORT.tables = tableRows;
    step(5, 'Schema-Scan', tables.length ? 'PASS' : 'FAIL', `${tables.length} Tabellen entschlüsselt lesbar`);
    for (const entry of tableRows.filter((t) => t.count > 0 || t.name.startsWith('djmd'))) {
      sub(`${entry.name.padEnd(26, ' ')} ${entry.count} Zeilen`);
    }
    if (!tables.length) {
      line('');
      line('ERGEBNIS: FAIL – Datei öffnet sich, enthält aber kein Rekordbox-Schema.');
      REPORT.result = 'FAIL';
      return 1;
    }

    const contentTable = tables.includes('djmdContent') ? 'djmdContent' : tables.includes('content') ? 'content' : null;
    if (!contentTable) {
      step(6, 'Track-Tabelle', 'FAIL', 'weder djmdContent noch content vorhanden');
      line('');
      line('ERGEBNIS: FAIL – keine Track-Tabelle.');
      REPORT.result = 'FAIL';
      return 1;
    }

    // [6] Spalten der Track-Tabelle
    const columns = db.prepare(`PRAGMA table_info("${contentTable}")`).all().map((c) => c.name);
    REPORT.columns = columns;
    const analysisColumn = columns.find((c) => /^(AnalysisDataPath|analysis_data_path)$/i.test(c)) || null;
    step(6, `${contentTable}-Spalten`, 'PASS', `${columns.length} Spalten${analysisColumn ? `, Analysepfad-Spalte: ${analysisColumn}` : ''}`);
    const relevant = columns.filter((c) =>
      ['ID', 'id', 'Title', 'ArtistID', 'BPM', 'Length', 'FolderPath', 'FileNameL', 'FileType', 'AnalysisDataPath', 'FileSize', 'SampleRate'].includes(c)
    );
    sub(`relevant: ${relevant.join(', ') || '(keine der erwarteten Spalten)'}`);
    if (!analysisColumn) {
      sub('WARN: keine AnalysisDataPath-Spalte – ANLZ-Zuordnung läuft dann nur über den PPTH-Scan.');
    }

    // [7] Kern-Zählwerte
    const countOf = (sql, params = []) => {
      try {
        return db.prepare(sql).get(...params).n;
      } catch {
        return null;
      }
    };
    const tracks = countOf(`SELECT COUNT(*) AS n FROM "${contentTable}"`);
    const withAnalysis = analysisColumn
      ? countOf(`SELECT COUNT(*) AS n FROM "${contentTable}" WHERE "${analysisColumn}" IS NOT NULL AND LENGTH(TRIM("${analysisColumn}")) > 0`)
      : null;
    const cueTable = tables.includes('djmdCue') ? 'djmdCue' : tables.includes('cue') ? 'cue' : null;
    // master.db nennt die Spalte ContentID, die OneLibrary content_id.
    const cueColumns = cueTable ? db.prepare(`PRAGMA table_info("${cueTable}")`).all().map((c) => c.name) : [];
    const cueContentColumn =
      cueColumns.find((c) => c.toLowerCase() === 'contentid') ||
      cueColumns.find((c) => c.toLowerCase() === 'content_id') ||
      null;
    const cues = cueTable ? countOf(`SELECT COUNT(*) AS n FROM "${cueTable}"`) : null;
    const artistTable = tables.includes('djmdArtist') ? 'djmdArtist' : tables.includes('artist') ? 'artist' : null;
    const artists = artistTable ? countOf(`SELECT COUNT(*) AS n FROM "${artistTable}"`) : null;
    const playlistTable = tables.includes('djmdPlaylist') ? 'djmdPlaylist' : tables.includes('playlist') ? 'playlist' : null;
    const playlists = playlistTable ? countOf(`SELECT COUNT(*) AS n FROM "${playlistTable}"`) : null;
    REPORT.counts = { tracks, withAnalysis, cues, artists, playlists, contentTable, cueTable, cueContentColumn };
    const ratio = tracks && withAnalysis !== null ? `${Math.round((withAnalysis / tracks) * 100)} %` : '–';
    step(7, 'Kern-Zählwerte', tracks === null ? 'FAIL' : 'PASS', `Tracks ${tracks} · mit Analysepfad ${withAnalysis ?? '–'} (${ratio}) · Cues ${cues ?? '–'} · Artists ${artists ?? '–'} · Playlists ${playlists ?? '–'}`);
    if (withAnalysis === 0) {
      sub('WARN: 0 Tracks mit AnalysisDataPath – die Wellenform-Zuordnung braucht dann den ANLZ-PPTH-Scan.');
    }

    // [8] Stichprobe / einzelner Track
    if (options.samples) {
      let rows = [];
      let mode = `erste ${options.limit}`;
      if (options.track) {
        mode = `Track "${options.track}"`;
        const byId = db
          .prepare(`SELECT * FROM "${contentTable}" WHERE CAST(id AS TEXT) = ? LIMIT 5`)
          .all(options.track);
        if (byId.length) {
          rows = byId;
        } else if (columns.some((c) => /^(Title|title)$/i.test(c))) {
          const titleColumn = columns.find((c) => /^(Title|title)$/i.test(c));
          rows = db
            .prepare(`SELECT * FROM "${contentTable}" WHERE "${titleColumn}" LIKE ? LIMIT 5`)
            .all(`%${options.track}%`);
        }
      } else if (options.limit > 0) {
        rows = db.prepare(`SELECT * FROM "${contentTable}" ORDER BY id LIMIT ?`).all(options.limit);
      }

      if (!rows.length) {
        step(8, `Stichprobe (${mode})`, 'WARN', 'keine Zeile gefunden');
      } else {
        step(8, `Stichprobe (${mode})`, 'PASS', `${rows.length} Zeile(n)`);
        for (const row of rows) {
          const get = (...names) => {
            for (const name of names) if (row[name] !== undefined && row[name] !== null) return row[name];
            return '';
          };
          const id = get('ID', 'id');
          const title = get('Title', 'title') || '(ohne Titel)';
          const bpm = get('BPM', 'bpm');
          const length = get('Length', 'length');
          const folder = get('FolderPath', 'folderPath');
          const file = get('FileNameL', 'fileName');
          const analysis = analysisColumn ? get(analysisColumn) : '';
          sub(`ID ${id} · ${title}`);
          const audioPath = joinAudioPath(folder, file);
          sub(`   BPM ${(Number(bpm) / 100).toFixed(2)} · Länge ${length} s · ${audioPath}`);
          sub(`   AnalysisDataPath: ${analysis || '(leer)'}`);
          const cueCount =
            cueTable && cueContentColumn
              ? countOf(`SELECT COUNT(*) AS n FROM "${cueTable}" WHERE CAST("${cueContentColumn}" AS TEXT) = ?`, [String(id)])
              : null;
          if (cueCount !== null) sub(`   Cues in ${cueTable}: ${cueCount}`);
          REPORT.samples.push({
            id: String(id),
            title: String(title),
            bpm: Number(bpm) / 100,
            lengthSeconds: Number(length),
            audioPath: joinAudioPath(folder, file),
            analysisDataPath: String(analysis || ''),
            cues: cueCount,
          });
        }
      }
    }

    // [9] ANLZ-Verfügbarkeit für die Stichprobe
    if (REPORT.samples.length) {
      let existing = 0;
      for (const sample of REPORT.samples) {
        const raw = sample.analysisDataPath;
        if (!raw) continue;
        const absolute = /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\');
        if (absolute && fs.existsSync(raw)) {
          existing += 1;
          sub(`ANLZ vorhanden: ${raw}`);
        } else if (absolute) {
          sub(`ANLZ fehlt: ${raw}`);
        } else {
          sub(`ANLZ-Pfad ist relativ (${raw}) – die App löst ihn über <datenbankordner>/share/ auf (analysisResolver.ts).`);
        }
      }
      step(9, 'ANLZ-Verfügbarkeit', existing ? 'PASS' : 'WARN', `${existing}/${REPORT.samples.length} ANLZ-Datei(en) der Stichprobe direkt auffindbar`);
      sub('Nächste Stufe der Pipeline: ANLZ-Tag-Inventar (PPTH, PQTZ, PWV2…PWV7, PCO2, PSSI).');
    }

    // [10] Fingerabdruck nachher → Read-Only-Beweis
    const after = fingerprint(target.path);
    const unchanged = after.sha256 === before.sha256 && after.size === before.size && after.mtimeMs === before.mtimeMs;
    REPORT.fingerprint = { before, after, unchanged };
    step(10, 'Fingerabdruck NACHHER', unchanged ? 'PASS' : 'FAIL', unchanged ? `identisch (sha256 ${after.sha256.slice(0, 16)}…)` : 'QUELLE VERÄNDERT!');
  } finally {
    db.close();
  }

  const failed = REPORT.steps.some((s) => s.status === 'FAIL');
  const warned = REPORT.steps.some((s) => s.status === 'WARN');
  line('');
  line('-'.repeat(72));
  REPORT.result = failed ? 'FAIL' : 'PASS';
  line(
    failed
      ? 'ERGEBNIS: FAIL – Master-DB-Zugriff nicht hergestellt (Details oben).'
      : `ERGEBNIS: PASS – master.db lesbar, Schema entschlüsselt, Quelle unverändert.${warned ? ' (mit Warnungen)' : ''}`
  );
  if (failed) {
    line('Nächster Schritt: Fehler oben beheben (Pfad/Modul/Version), dann Probe erneut ausführen.');
  } else {
    // Kopierbarer Folgebefehl OHNE Platzhalter: Pfad und erste Track-ID sind
    // bereits eingesetzt (verhindert <…>-Syntaxfallen in der PowerShell).
    const firstId = REPORT.samples[0]?.id;
    const next = `npm run probe:anlz -- --db "${target.path}"${firstId ? ` --track ${firstId}` : ''}`;
    line('Nächster Befehl (Werte eingesetzt – Zeile kopieren und einfügen):');
    line(`  ${next}`);
  }
  return failed ? 1 : 0;
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
