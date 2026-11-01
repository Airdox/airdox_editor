import { createRequire } from 'node:module';
import { access, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
const reader = require('../electron/dbReader.cjs');
const libraries = [];
for (const database of reader.locateRekordboxDatabases()) {
  const result = reader.readRekordboxDatabase(database.path);
  if (!result.available) { libraries.push({ path: database.path, error: result.reason }); continue; }
  const rows = result.rows.content.slice().sort((left, right) => Number(right.DJPlayCount ?? right.PlayCount ?? 0) - Number(left.DJPlayCount ?? left.PlayCount ?? 0) || String(left.ID).localeCompare(String(right.ID))).slice(0, 200);
  const tracks = [];
  for (const row of rows) {
    const inputPath = row.FolderPath && row.FileName && !String(row.FolderPath).endsWith(String(row.FileName)) ? path.join(row.FolderPath, row.FileName) : row.FolderPath || row.FileName;
    let reachable = false;
    try { await access(inputPath); reachable = (await stat(inputPath)).isFile(); } catch {}
    tracks.push({ id: String(row.ID), title: row.Title, playCount: row.DJPlayCount ?? row.PlayCount ?? 0, seconds: Number(row.Length ?? row.Duration ?? 0), inputPath, reachable });
  }
  libraries.push({ path: database.path, count: result.stats.tracks, selected: tracks.length, reachable: tracks.filter(track => track.reachable).length, totalSeconds: tracks.reduce((sum, track) => sum + track.seconds, 0), tracks });
}
await mkdir('reports', { recursive: true });
await writeFile('reports/top200-preflight.json', JSON.stringify({ at: new Date().toISOString(), libraries }, null, 2));
console.log(JSON.stringify(libraries.map(({ tracks, ...summary }) => summary), null, 2));
