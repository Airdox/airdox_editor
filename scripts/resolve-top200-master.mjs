import { createRequire } from 'node:module';
import { stat, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
const reader = require('../electron/dbReader.cjs');
const source = 'E:\\PIONEER\\Master\\master.db';
const primary = reader.readRekordboxDatabase(source);
if (!primary.available) throw new Error(primary.reason);
const other = reader.readRekordboxDatabase('G:\\PIONEER\\Master\\master.db');
const secondary = other.available ? other.rows.content : [];
const known = JSON.parse(await readFile('reports/top200-file-resolution.json', 'utf8')).resolutions ?? [];
const location = row => row.FolderPath && row.FileName && !String(row.FolderPath).endsWith(String(row.FileName)) ? path.join(row.FolderPath, row.FileName) : row.FolderPath || row.FileName;
const absolute = value => typeof value === 'string' && /^(?:[A-Za-z]:[\\/]|\\\\)/.test(value);
const reachable = async filename => { if (!absolute(filename)) return false; try { return (await stat(filename)).isFile(); } catch { return false; } };
const selected = primary.rows.content.slice().sort((left, right) => Number(right.DJPlayCount ?? right.PlayCount ?? 0) - Number(left.DJPlayCount ?? left.PlayCount ?? 0) || String(left.ID).localeCompare(String(right.ID))).slice(0, 200);
const tracks = [];
for (const row of selected) {
  const originalPath = location(row);
  let resolvedPath = await reachable(originalPath) ? originalPath : null;
  let evidence = resolvedPath ? 'SOURCE_DATABASE_PATH' : null;
  if (!resolvedPath) {
    const matches = secondary.filter(candidate => String(candidate.ID) === String(row.ID) && candidate.Title === row.Title && candidate.FileName === row.FileName);
    for (const candidate of matches) {
      const filename = location(candidate);
      if (await reachable(filename)) { resolvedPath = filename; evidence = 'MATCHING_ID_TITLE_FILENAME_IN_G_DATABASE'; break; }
    }
  }
  if (!resolvedPath) {
    const candidate = known.find(item => item.id === String(row.ID) && item.title === row.Title && item.resolvedPath);
    if (candidate && await reachable(candidate.resolvedPath)) { resolvedPath = candidate.resolvedPath; evidence = 'PREVIOUSLY_IDENTIFIED_TRACK_PATH_RECHECKED'; }
  }
  tracks.push({ id: String(row.ID), title: row.Title, playCount: Number(row.DJPlayCount ?? row.PlayCount ?? 0), originalPath, resolvedPath, evidence, status: resolvedPath ? 'READY' : 'MISSING', originalMedia: resolvedPath ? { location: resolvedPath } : undefined });
}
const result = { source, generatedAt: new Date().toISOString(), selected: tracks.length, ready: tracks.filter(track => track.status === 'READY').length, missing: tracks.filter(track => track.status === 'MISSING').length, tracks };
await mkdir('reports', { recursive: true });
await writeFile('reports/top200-master-execution.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify({ source, selected: result.selected, ready: result.ready, missing: result.missing, manifest: 'reports/top200-master-execution.json' }));
