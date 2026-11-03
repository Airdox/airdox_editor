import { createRequire } from 'node:module';
import { access, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
const require = createRequire(import.meta.url);
const { readRekordboxDatabase } = require('../electron/dbReader.cjs');
const { resolveTrackFromMasterDb } = require('../electron/masterDbGate.cjs');
const database = path.resolve(process.argv[2] || 'E:\\PIONEER\\Master\\master.db');
const read = readRekordboxDatabase(database);
if (!read.available || !read.rows) throw new Error(read.reason || 'Gewählte Datenbank kann nicht read-only gelesen werden.');
const selected = read.rows.content.slice().sort((left, right) => Number(right.DJPlayCount ?? right.PlayCount ?? 0) - Number(left.DJPlayCount ?? left.PlayCount ?? 0) || (String(left.ID) < String(right.ID) ? -1 : 1)).slice(0, 200);
const entries = [];
await mkdir('reports', { recursive: true });
for (const row of selected) {
  const sourcePath = row.FolderPath && row.FileName && !String(row.FolderPath).endsWith(String(row.FileName)) ? path.join(row.FolderPath, row.FileName) : row.FolderPath || row.FileName;
  const entry = { id: String(row.ID), title: row.Title, playCount: Number(row.DJPlayCount ?? row.PlayCount ?? 0), duration: Number(row.Length ?? row.Duration ?? 0), databasePath: database, sourcePath, bytes: row.FileSize, resolvedPath: null, resolution: null };
  try {
    await access(sourcePath, constants.R_OK);
    if (!(await stat(sourcePath)).isFile() || !path.win32.isAbsolute(sourcePath) || !/^(?:[A-Za-z]:[\\/]|\\\\)/.test(sourcePath)) throw new Error('Pfad hat keine belegte Laufwerkswurzel');
    entry.resolvedPath = sourcePath;
    entry.resolution = 'EXACT_DATABASE_PATH';
  } catch {
    const gate = await resolveTrackFromMasterDb({ trackId: entry.id, mediaPath: sourcePath }, { locateRekordboxDatabases: () => [{ path: database, kind: read.dbType }] });
    if (gate.ok && gate.original?.path) { entry.resolvedPath = gate.original.path; entry.resolution = 'SAME_DATABASE_ANLZ_GATE'; }
    else { entry.resolution = 'UNRESOLVED'; entry.gateCode = gate.code; entry.gateReason = gate.reason; }
  }
  entries.push(entry);
  if (entries.length % 10 === 0) {
    const progress = { source: database, selected: selected.length, checked: entries.length, resolved: entries.filter(item => item.resolvedPath).length, entries };
    await writeFile('reports/top200-selected-database.partial.json', JSON.stringify(progress, null, 2));
    console.log(JSON.stringify({ source: database, checked: progress.checked, selected: progress.selected, resolved: progress.resolved }));
  }
}
const report = { source: database, sourceAuthority: 'EXPLICIT_USER_DATABASE_PATH', capturedAt: new Date().toISOString(), databaseTracks: read.stats.tracks, selected: entries.length, resolved: entries.filter(entry => entry.resolvedPath).length, totalSeconds: entries.reduce((sum, entry) => sum + entry.duration, 0), entries };
await mkdir('reports', { recursive: true });
await writeFile('reports/top200-selected-database.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, entries: undefined }, null, 2));
