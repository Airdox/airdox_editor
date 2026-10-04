/**
 * @license
 * Test suite für die einklappbaren Paletten und die Arbeitsflächen-Maximierung.
 *
 * Vor UI v2.0 prüfte diese Suite eine *nachgebaute* Kopie der Umschaltlogik
 * (lokale Variablen und eine handgeschriebene `toggleMaxWaveform`). Ein solcher
 * Test kann grün bleiben, während die App etwas anderes tut – er beweist nur
 * sich selbst.
 *
 * Jetzt prüft er den echten Reducer (`src/ui/workspaceLayout.ts`), also genau
 * den Code, den Zone 1, der Menüpunkt „Betrachten" und die Taste M auslösen.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  INITIAL_WORKSPACE_PANELS,
  RESTORED_WORKSPACE_PANELS,
  workspaceReducer,
  zone3Visible,
  type WorkspacePanels,
} from '../src/ui/workspaceLayout';

describe('Einklappbare Paletten & Arbeitsflächen-Maximierung (UI v2.0)', () => {
  it('startet mit eingeklappter unterer Zone und offener Clip-Palette', () => {
    assert.equal(INITIAL_WORKSPACE_PANELS.zone3Section, null, 'Zone 3 ist standardmäßig eingeklappt');
    assert.equal(INITIAL_WORKSPACE_PANELS.paletteOpen, true, 'die Clip-Palette ist sichtbar');
    assert.equal(INITIAL_WORKSPACE_PANELS.focusMode, false, 'kein Fokus-Modus beim Start');
    assert.equal(zone3Visible(INITIAL_WORKSPACE_PANELS), true, 'Zone 3 ist sichtbar (als Reiter-Leiste)');
  });

  it('klappt eine Zone-3-Sektion auf und beim zweiten Klick wieder ein', () => {
    const open = workspaceReducer(INITIAL_WORKSPACE_PANELS, {
      type: 'TOGGLE_ZONE3_SECTION',
      section: 'BEAT_SELECT',
    });
    assert.equal(open.zone3Section, 'BEAT_SELECT', 'Sektion ist aufgeklappt');

    const closed = workspaceReducer(open, { type: 'TOGGLE_ZONE3_SECTION', section: 'BEAT_SELECT' });
    assert.equal(closed.zone3Section, null, 'zweiter Klick klappt sie wieder ein');
  });

  it('„Max. Platz / Alles einklappen" schließt alle Panels und stellt sie wieder her', () => {
    const standard: WorkspacePanels = {
      ...INITIAL_WORKSPACE_PANELS,
      zone3Section: 'EDIT',
      stemConfigOpen: true,
      chatbotOpen: true,
      deckViewOpen: true,
      browserOpen: true,
    };

    const focused = workspaceReducer(standard, { type: 'TOGGLE_FOCUS_MODE' });
    assert.equal(focused.focusMode, true, 'Fokus-Modus aktiv');
    assert.equal(focused.zone3Section, null, 'untere Palette geschlossen');
    assert.equal(focused.stemConfigOpen, false, 'Stem-Konfiguration geschlossen');
    assert.equal(focused.chatbotOpen, false, 'Copilot-Palette geschlossen');
    assert.equal(focused.deckViewOpen, false, 'Clip-Deck geschlossen');
    assert.equal(focused.browserOpen, false, 'Browserleiste geschlossen');
    assert.equal(focused.paletteOpen, false, 'Clip-Palette geschlossen');
    assert.equal(zone3Visible(focused), false, 'Zone 3 ist vollständig ausgeblendet');

    const restored = workspaceReducer(focused, { type: 'TOGGLE_FOCUS_MODE' });
    assert.deepEqual(restored, RESTORED_WORKSPACE_PANELS, 'Standard-Layout kehrt zurück');
    assert.equal(zone3Visible(restored), true, 'Zone 3 ist wieder da');
  });

  it('das Aufklappen einer Palette beendet den Fokus-Modus', () => {
    const focused = workspaceReducer(INITIAL_WORKSPACE_PANELS, { type: 'TOGGLE_FOCUS_MODE' });
    const opened = workspaceReducer(focused, { type: 'SET_PALETTE', open: true });
    assert.equal(opened.focusMode, false, 'eine sichtbare Palette und Fokus-Modus schließen sich aus');

    const withTab = workspaceReducer(focused, { type: 'TOGGLE_ZONE3_SECTION', section: 'EDIT' });
    assert.equal(withTab.focusMode, false, 'ein aufgeklappter Reiter beendet den Fokus-Modus');
    assert.equal(withTab.zone3Section, 'EDIT', 'und der Reiter ist offen');
  });
});
