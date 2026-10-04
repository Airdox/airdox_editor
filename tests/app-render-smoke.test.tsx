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
import React from 'react';
import { renderToString } from 'react-dom/server';
import App from '../src/App';

const html = renderToString(React.createElement(App));

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
  'Stem-Separation starten',
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
    'das Stem-Center startet im Ruhezustand (nur die Start-Zeile)'
  );
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
