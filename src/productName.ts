/**
 * @license
 * Produktname – eine Quelle für alle Schreibweisen
 *
 * `PRODUCT_NAME` ist der Bezeichner (identisch zu `productName` in package.json,
 * zum Fenstertitel der Desktop-App und zum <title> in index.html). Für Titelleiste
 * und Dialoge wird die lesbare Variante ohne Unterstriche verwendet. Wer den Namen
 * ändern will, ändert hier und `package.json`/`index.html`/`electron/main.cjs` –
 * `tests/desktop-bridge.test.mjs` prüft, dass alle vier zusammenbleiben.
 */

/** Technischer Produktname – so heißt auch die gebaute Datei. */
export const PRODUCT_NAME = 'Airdox_intelligents_Editor';

/** Anzeigename in Titelleiste, Begrüßung und Dialogen. */
export const PRODUCT_DISPLAY_NAME = 'Airdox intelligents Editor';

/** Kurzbeschreibung für Info-Dialoge. */
export const PRODUCT_TAGLINE = 'Rekordbox-Bibliothek nur lesend öffnen, schneiden, speichern';
