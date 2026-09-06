/**
 * @license
 * Umrechnung der `Location`-Werte aus der Rekordbox-XML in lokale Pfade.
 *
 * Der Tonträger wird ausschließlich gelesen; diese Datei entscheidet nur, ob aus
 * dem in der XML stehenden Wert überhaupt ein Pfad wird. Was die XML nicht hergibt
 * (etwa die Wurzel einer in die Cloud verschobenen Sammlung), wird nicht geraten –
 * `locationIssue` sagt dann in Klartext, woran es liegt.
 */
'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');

/**
 * true bei `file://localhost//contents_…/unknownartist/…`: verschobene oder aus der
 * Cloud übernommene Sammlungen nennen in der XML keinen Laufwerk- bzw. Wurzelanteil.
 */
function relativeLibraryLocation(location) {
  return typeof location === 'string' && /^file:\/\/localhost\/{2,}[^/]/i.test(location.trim());
}

/** Umkehrung von `toLocalPath`: null, wenn keine lokale Datei daraus wird. */
function toLocalPath(location, { allowRelativeLibrary = false } = {}) {
  if (typeof location !== 'string' || !location.trim()) return null;
  if (!allowRelativeLibrary && relativeLibraryLocation(location)) return null;

  try {
    // Windows drive paths must be handled before generic URL detection because
    // "C:\\Music" otherwise looks like a URL with the scheme "c:".
    if (/^[a-z]:[\\/]/i.test(location) || path.isAbsolute(location)) {
      return path.resolve(location);
    }

    // Rekordbox exports file:// URLs. Reject all non-file URL schemes.
    if (/^[a-z][a-z\d+.-]*:/i.test(location)) {
      const url = new URL(location);
      return url.protocol === 'file:' ? fileURLToPath(url) : null;
    }

    return path.resolve(location);
  } catch {
    return null;
  }
}

/**
 * Grund, warum ein Pfad nicht gelesen werden kann – für Statuszeile und Dialog.
 * `null` heißt: der Wert sieht auflösbar aus, die Prüfung der Datei folgt anderswo.
 */
function locationIssue(location) {
  if (relativeLibraryLocation(location)) {
    return 'Die Rekordbox-XML nennt für diese Datei nur einen Pfad innerhalb der Sammlung (verschoben oder in der Cloud). Ohne den Ordner der Mediathek ist er nicht auflösbar – ein Ratepfad wird nicht eingetragen.';
  }
  if (typeof location !== 'string' || !location.trim()) {
    return 'Die XML-Zeile enthält keinen Location-Wert.';
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(location.trim()) && !/^file:/i.test(location.trim())) {
    return 'Die Location ist kein localer Dateipfad (anderes Protokoll).';
  }
  return null;
}

module.exports = { relativeLibraryLocation, toLocalPath, locationIssue };
