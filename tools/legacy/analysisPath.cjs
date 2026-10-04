'use strict';
/**
 * Loest den ANLZ-Pfad eines Tracks auf. Nur Pfadlogik, kein Dateizugriff, keine Schreibzugriffe.
 *
 * Eingaben:
 *   analysisRoot     = "analysis-data-root-path" aus rekordboxAgent\storage\options.json
 *                      (bei dir: D:\PIONEER\Master\share)
 *   analysisDataPath = djmdContent.AnalysisDataPath (z. B. "/PIONEER/USBANLZ/ab1/23456/ANLZ0000.DAT")
 *
 * Ergebnis:  { ok:true, dat, ext, ex2 }  oder  { ok:false, code }
 * Bewusst KEIN Fallback: fehlt etwas, kommt ein Fehlercode (kein Berechnen eigener Wellenformen).
 */
const nodePath = require('node:path');

function resolveAnalysisFiles(analysisRoot, analysisDataPath, pathImpl = nodePath) {
  if (!analysisRoot || typeof analysisRoot !== 'string') return { ok: false, code: 'ANALYSIS_ROOT_MISSING' };
  if (!analysisDataPath || typeof analysisDataPath !== 'string') return { ok: false, code: 'ANALYSIS_DATA_PATH_MISSING' };

  const parts = analysisDataPath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length === 0 || parts.includes('..')) return { ok: false, code: 'ANALYSIS_DATA_PATH_UNSAFE' };

  const dat = pathImpl.join(analysisRoot, ...parts);
  const rel = pathImpl.relative(analysisRoot, dat);
  if (rel.startsWith('..') || pathImpl.isAbsolute(rel)) return { ok: false, code: 'ANALYSIS_DATA_PATH_UNSAFE' };

  const base = dat.replace(/\.(dat|ext|2ex)$/i, '');
  return { ok: true, dat: `${base}.DAT`, ext: `${base}.EXT`, ex2: `${base}.2EX` };
}

module.exports = { resolveAnalysisFiles };
