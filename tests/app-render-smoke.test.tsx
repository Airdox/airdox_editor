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

// 1. Grundgerüst der Oberfläche ist vorhanden.
for (const marker of [
  'airdox',
  'New Project',
  'AI COPILOT',
  'TRACK-IMPORT',
  'DB-Extraktor',
  'MEM CUE',
  'GRID',
]) {
  assert.ok(html.includes(marker), `Oberfläche muss "${marker}" enthalten`);
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
