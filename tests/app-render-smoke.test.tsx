/**
 * Rauchtest für den vollständigen Komponentenbaum.
 *
 * Warum dieser Test existiert:
 *   Es gab bislang keinen einzigen Test, der die Anwendung als Ganzes rendert –
 *   35 der 36 Komponenten waren vom Testgraphen aus unerreichbar. Genau dort
 *   versteckten sich Fehler wie ein Effekt ohne Dependency-Array oder ein
 *   Zustandsumbau, der nur im Browser auffällt.
 *
 *   Der Test rendert `App` serverseitig (`react-dom/server`). Das führt keine
 *   Effekte aus, deckt aber alles ab, was beim Rendern passiert:
 *     - Import-/Modulfehler und Hook-Reihenfolge,
 *     - Zugriffe auf `window`/`AudioContext` außerhalb von Effekten,
 *     - Abstürze in abgeleiteten Werten (Store, Analyse, Segmente).
 *
 *   Für echte Interaktionen und Canvas-Ausgaben bleibt der Browser-/Electron-
 *   Harness zuständig (siehe docs/REFACTORING_PLAN.md, WP-14).
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToString } from 'react-dom/server';
import App from '../src/App';

const html = renderToString(React.createElement(App));
const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
const menuSource = await readFile(`${sourceRoot}/src/components/MenuBar.tsx`, 'utf8');
const setupSource = await readFile(`${sourceRoot}/src/components/Modals/InitialSetupModal.tsx`, 'utf8');
const appSource = await readFile(`${sourceRoot}/src/App.tsx`, 'utf8');

/*
 * 1. Grundgerüst der Oberfläche ist vorhanden – geprüft wird die
 *    Drei-Zonen-Architektur (UI v2.0, docs/UI_V2_DREI_ZONEN.md):
 *      Zone 1: Menüs, Werkzeuge, aktiver Track, Fokus-Umschalter.
 *      Zone 2: Wellenform + Stem-Center im Ruhezustand (nur die Start-Zeile).
 *      Zone 3: eingeklappte Reiter (BEAT SELECT / SELECT / EDIT).
 */
for (const marker of [
  'airdox',
  'New Project',
  'AI COPILOT',
  'DB-Extraktor',
  'Max. Platz / Alles einklappen',
  'Stems erzeugen',
  'BEAT SELECT',
  'MEM CUE',
  'GRID',
]) {
  assert.ok(html.includes(marker), `Oberfläche muss "${marker}" enthalten`);
}

/*
 * 1b. Das Ausschlusskriterium von Zone 1: dort steht kein Prozessstatus und
 *     keine redundante Import-Schaltfläche. „TRACK-IMPORT" war genau das und
 *     ist im Erstrendering nicht mehr enthalten (Import liegt im Datei-Menü).
 */
assert.ok(
  !html.includes('TRACK-IMPORT'),
  'Zone 1 darf keine redundante Import-Schaltfläche mehr zeigen'
);

/*
 * 1c. Die drei Zonen sind im gerenderten DOM unterscheidbar und liegen in der
 *     richtigen Reihenfolge. Das ist die Grundlage jeder Layout-Prüfung von
 *     außen (und der Grund, warum die Zonen Datenattribute tragen).
 */
{
  const zone1 = html.indexOf('data-zone="1"');
  const zone2 = html.indexOf('data-zone="2"');
  const zone3Shell = html.indexOf('data-zone3-shell="true"');
  const zone3 = html.indexOf('data-zone="3"');
  assert.ok(zone1 >= 0, 'Zone 1 ist im Erstrendering markiert');
  assert.ok(zone2 > zone1, 'Zone 2 folgt auf Zone 1');
  assert.ok(zone3Shell > zone2, 'Zone 3 folgt auf Zone 2');
  assert.ok(zone3 > zone3Shell, 'die untere Palette liegt innerhalb der Zone-3 Hülle');
  assert.ok(
    html.includes('data-zone1-focus-toggle="true"'),
    'der Fokus-Umschalter ist im DOM adressierbar'
  );
  assert.ok(
    html.includes('data-stem-action="start-config"'),
    'das Stem-Center hat im Ruhezustand einen direkten Einstieg zum Stem-Workflow'
  );
  assert.ok(html.includes('Stems erzeugen'), 'der Stem-Start ist in der Oberfläche klar beschriftet');
}

// 1d. Der erste Start bietet den kompakten DJ-Schnellpfad, und Dialoge können
//     keine Menü-Dropdowns im Hintergrund öffnen.
assert.ok(setupSource.includes("const quickModelId = 'scnet-onnx-4stem-int8'"), 'Ersteinrichtung installiert gezielt das kompakte SCNet-Modell');
assert.ok(setupSource.includes('onComplete(updated, installedModelId)'), 'nach Setup-Abschluss wird das installierte Modell an die App übergeben');
assert.ok(appSource.includes("dispatchWorkspace({ type: 'OPEN_STEM_CONFIG' })"), 'erfolgreiche Installation öffnet die Stem-Konfiguration');
assert.ok(appSource.includes("handleStemQualityModeChange('fast')"), 'das Stem-Center öffnet standardmäßig mit Schnellmodus');
assert.ok(appSource.includes('stemInstallOpen || stemModelPickerOpen || settingsModalOpen'), 'alle Dialoge sperren die Menüs');
for (const menu of ['datei', 'bearbeiten', 'betrachten', 'hilfe']) {
  assert.ok(menuSource.includes(`disabled={modalOpen} onClick={() => toggleMenu('${menu}')}`), `${menu}-Menü ist während eines Dialogs gesperrt`);
}

// 2. Kein Platzhalter eines nachzuladenden Dialogs darf im Erstrendering stehen.
for (const forbidden of ['Suspense-Fallback', 'undefined']) {
  assert.ok(!html.includes(forbidden), `Erstrendering darf "${forbidden}" nicht zeigen`);
}

// 3. Das Erstrendering bleibt in einer plausiblen Größenordnung. Ein plötzlicher
//    Einbruch bedeutet meist, dass ein Teilbaum still verschwunden ist.
assert.ok(html.length > 20000, `Erstrendering zu klein (${html.length} Zeichen) – fehlt ein Baumteil?`);

console.log(`  ✓ App rendert vollständig (${html.length} Zeichen HTML, ${(html.match(/</g) || []).length} Tags)`);
console.log('  ✓ Komponentenbaum ist frei von Render-Zeit-Abstürzen');
