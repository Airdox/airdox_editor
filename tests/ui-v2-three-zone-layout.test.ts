/**
 * @license
 * airdox_SMART_Editor – UI v2.0: Verträge der Drei-Zonen-Architektur.
 *
 * Der Master-Plan ist kein Vorschlag, sondern eine Reihe harter Regeln. Diese
 * Suite prüft sie zweifach:
 *
 *   A) Am echten Modell (`src/ui/workspaceLayout.ts`) – Fokus-Modus, Reiter,
 *      Stem-Center-Zustände. Reine Logik, ohne DOM.
 *   B) Am Quelltext der Bauteile – weil sich Regeln wie „Zone 1 enthält keinen
 *      Prozessstatus" und „im Konfigurations-Panel existiert nur das aktive
 *      Modell" nicht über Props prüfen lassen, sondern nur über das, was
 *      tatsächlich dort steht.
 *
 * Run with: npx tsx tests/ui-v2-three-zone-layout.test.ts
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  INITIAL_WORKSPACE_PANELS,
  FOCUS_MODE_CLOSES,
  RESTORED_WORKSPACE_PANELS,
  ZONE3_SECTIONS,
  collapsedForFocusMode,
  deriveStemCenterPhase,
  activeStemModelLabel,
  workspaceReducer,
  zone3Visible,
  type WorkspacePanels,
} from '../src/ui/workspaceLayout';
import { UI_ACTION, UI_ACCENT, segmentClass } from '../src/ui/theme';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (relative: string) =>
  readFile(`${root}${relative}`.replace(/\/+/g, '/'), 'utf8');

const appSource = await read('src/App.tsx');
const zone1BarSource = await read('src/components/zones/Zone1TopBar.tsx');
const zone1TransportSource = await read('src/components/zones/Zone1Transport.tsx');
/** Alle Bauteile, die Zone 1 tatsächlich zeichnen (Bar + Transport-Cluster). */
const zone1Source = `${zone1BarSource}\n${zone1TransportSource}`;
const stemCenterSource = await read('src/components/zones/StemCenter.tsx');
const pickerSource = await read('src/components/zones/StemModelPicker.tsx');
const zone3Source = await read('src/components/zones/Zone3Footer.tsx');
const deckMixerSource = await read('src/components/DeckStemsControl.tsx');
const toastSource = await read('src/components/zones/TransientStatusToast.tsx');
const menuSource = await read('src/components/MenuBar.tsx');
const themeSource = await read('src/ui/theme.ts');
const stylesSource = await read('src/index.css');

/**
 * Entfernt Kommentare: geprüft wird der CODE – die Regel-Dokumentation darf
 * verbotene Wörter nennen (sie erklärt sie ja), der Code darf es nicht.
 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * Entfernt `title="…"`-Attribute. Sie sind Bedienhilfe beim Zeigen mit der
 * Maus, kein sichtbarer Inhalt: der Ruhezustand muss keine *sichtbaren*
 * Qualitätsstufen, Erklärtexte oder Fortschritte zeigen.
 */
const stripHoverTitles = (source: string) => source.replace(/title="[^"]*"/g, '');

/** Schneidet einen Quelltextabschnitt zwischen zwei Markern heraus. */
function slice(source: string, startMarker: string, endMarker: string, label: string): string {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `${label}: Startmarker fehlt (${startMarker})`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `${label}: Endmarker fehlt (${endMarker})`);
  return source.slice(start, end);
}

console.log('\n[ TEST ] A1 – Zone 1 ist permanent und statusfrei');
{
  // Werkzeuge, Menüs, Transport, aktiver Track, Systemzeit, Fokus-Umschalter.
  for (const marker of [
    'Datei',
    'Bearbeiten',
    'Betrachten',
    'Hilfe',
    'data-zone1-cluster="transport"',
    'data-zone1-cluster="active-track"',
    'data-zone1-focus-toggle="true"',
    'Max. Platz / Alles einklappen',
    'useSystemClock',
  ]) {
    assert.ok(zone1Source.includes(marker), `Zone 1 muss "${marker}" enthalten`);
  }
  // Der Fokus-Umschalter ist ein Schalter, kein Link – aria-pressed gehört dazu.
  assert.match(zone1BarSource, /aria-pressed=\{focusMode\}/, 'Fokus-Umschalter meldet seinen Zustand');

  // Ausschlusskriterium: kein Prozessstatus, kein Fortschritt, keine
  // Import-Schaltfläche in Zone 1.
  const zone1Code = stripComments(zone1Source);
  for (const forbidden of [
    'Fortschritt',
    'percent',
    'Progress',
    'TRACK-IMPORT',
    'Sammlung wird geladen',
    'separationProgress',
    'trackImportLoading',
    'progress',
  ]) {
    assert.ok(
      !zone1Code.includes(forbidden),
      `Zone 1 darf "${forbidden}" nicht enthalten (Ausschlusskriterium)`
    );
  }
  // Eine Import-Schaltfläche gibt es dort auch nicht: der Track-Import liegt
  // ausschließlich im Datei-Menü.
  assert.ok(
    /Import-Tracks|onImportTracks/.test(menuSource) && !/onImportTracks/.test(zone1Source),
    'Track-Import liegt im Datei-Menü, nicht in der Top-Bar'
  );
  console.log('  ✓ Zone 1: Menüs, Transport, aktiver Track, Zeit, Fokus-Umschalter – ohne Status');
}

console.log('\n[ TEST ] A2 – Es gibt genau drei Zonen, in der richtigen Reihenfolge');
{
  const zone1Pos = appSource.indexOf('<Zone1TopBar');
  const zone2Pos = appSource.indexOf('data-zone="2"');
  const zone3Pos = appSource.indexOf('zone3Visible'.length > 0 ? 'data-zone3-shell="true"' : '');
  assert.ok(zone1Pos > 0 && zone2Pos > zone1Pos && zone3Pos > zone2Pos, 'Zone 1 → 2 → 3 im Baum');
  // Die früheren Zeilen existieren nicht mehr: eine Leiste, nicht drei.
  assert.ok(
    !appSource.includes('<TitleBar') && !appSource.includes('<EditModeBar'),
    'keine zusätzlichen Leisten zwischen Zone 1 und Zone 2'
  );
  // Prozessmeldungen liegen außerhalb aller Zonen.
  assert.ok(appSource.includes('<TransientStatusToast'), 'flüchtige Meldungen werden außerhalb der Zonen gerendert');
  assert.ok(
    /fixed bottom-\d+ right-\d+/.test(toastSource) && !toastSource.includes('data-zone="1"') && !toastSource.includes('data-zone="2"'),
    'die Statuskarte schwebt außerhalb aller Zonen (kein data-zone)'
  );
  console.log('  ✓ Zonenfolge und Ablage der Prozessmeldungen stimmen');
}

console.log('\n[ TEST ] A3 – Fokus-Modus schließt ALLES synchron');
{
  const openEverything: WorkspacePanels = {
    focusMode: false,
    zone3Section: 'EDIT',
    stemConfigOpen: true,
    stemModelPickerOpen: true,
    paletteOpen: true,
    deckViewOpen: true,
    chatbotOpen: true,
    browserOpen: true,
  };
  const focused = workspaceReducer(openEverything, { type: 'TOGGLE_FOCUS_MODE' });
  assert.equal(focused.focusMode, true, 'Fokus-Modus ist an');
  for (const key of FOCUS_MODE_CLOSES) {
    const value = focused[key];
    assert.equal(
      value === null || value === false,
      true,
      `Fokus-Modus muss „${key}" schließen (war: ${JSON.stringify(value)})`
    );
  }
  assert.equal(zone3Visible(focused), false, 'Zone 3 ist im Fokus-Modus vollständig ausgeblendet');
  assert.deepEqual(
    collapsedForFocusMode(openEverything),
    focused,
    '„Alles einklappen" ist genau ein Übergang – auch als reine Funktion'
  );

  // Und wieder zurück: Standard-Layout, nicht der Zufallszustand von vorhin.
  const restored = workspaceReducer(focused, { type: 'TOGGLE_FOCUS_MODE' });
  assert.deepEqual(restored, RESTORED_WORKSPACE_PANELS, 'Verlassen stellt das Standard-Layout her');
  assert.equal(restored.focusMode, false);

  // SET_FOCUS_MODE(true) ist derselbe Übergang (Taste M, Menü, Button).
  assert.deepEqual(
    workspaceReducer(openEverything, { type: 'SET_FOCUS_MODE', value: true }),
    focused,
    'Button und Menü lösen denselben Übergang aus'
  );
  console.log('  ✓ Ein Übergang schließt alle Panels – und der laufende Job bleibt sichtbar:');

  // Ein laufender Job ist KEIN Panel: der Fortschritt überlebt den Fokus-Modus.
  const runningInFocus = deriveStemCenterPhase({
    hasStems: false,
    isSeparating: true,
    configOpen: false,
  });
  assert.equal(runningInFocus, 'PROCESSING', 'Fortschritt bleibt im Fokus-Modus sichtbar');
}

console.log('\n[ TEST ] A4 – Zone 3: standardmäßig eingeklappt, genau ein Reiter offen');
{
  assert.equal(INITIAL_WORKSPACE_PANELS.zone3Section, null, 'Standard: alles eingeklappt');
  assert.equal(INITIAL_WORKSPACE_PANELS.focusMode, false, 'Standard: kein Fokus-Modus');
  assert.equal(INITIAL_WORKSPACE_PANELS.browserOpen, false, 'Standard: Browserleiste eingeklappt');

  for (const section of ZONE3_SECTIONS.map((entry) => entry.id)) {
    const open = workspaceReducer(INITIAL_WORKSPACE_PANELS, { type: 'TOGGLE_ZONE3_SECTION', section });
    assert.equal(open.zone3Section, section, `${section} klappt auf`);
    assert.equal(open.stemConfigOpen, false, 'Zone 2 konkurriert nicht mit Zone 3');
    const closed = workspaceReducer(open, { type: 'TOGGLE_ZONE3_SECTION', section });
    assert.equal(closed.zone3Section, null, `${section} klappt beim zweiten Klick wieder zu`);
  }

  // Ein anderer Reiter ersetzt den offenen – nie zwei Panels gleichzeitig.
  const beat = workspaceReducer(INITIAL_WORKSPACE_PANELS, { type: 'TOGGLE_ZONE3_SECTION', section: 'BEAT_SELECT' });
  const edit = workspaceReducer(beat, { type: 'TOGGLE_ZONE3_SECTION', section: 'EDIT' });
  assert.equal(edit.zone3Section, 'EDIT', 'nur eine Sektion ist offen');

  // Drei Reiter sind es, in der dokumentierten Reihenfolge.
  assert.deepEqual(
    ZONE3_SECTIONS.map((entry) => entry.id),
    ['BEAT_SELECT', 'SELECT', 'EDIT'],
    'BEAT SELECT, SELECT und EDIT sind die Sektionen der unteren Zone'
  );
  assert.ok(zone3Source.includes("role=\"tablist\""), 'die Reiter-Leiste ist eine Tabliste');
  assert.ok(zone3Source.includes('data-zone3-tab='), 'jeder Reiter ist adressierbar');
  console.log('  ✓ Standard eingeklappt, Akkordeon mit genau einer offenen Sektion');
}

console.log('\n[ TEST ] A5 – Stem-Center: drei Zustände, harte Reihenfolge');
{
  assert.equal(
    deriveStemCenterPhase({ hasStems: false, isSeparating: false, configOpen: false }),
    'IDLE',
    'Ruhezustand'
  );
  assert.equal(
    deriveStemCenterPhase({ hasStems: false, isSeparating: false, configOpen: true }),
    'CONFIGURE',
    'Klick öffnet die Konfiguration'
  );
  assert.equal(
    deriveStemCenterPhase({ hasStems: true, isSeparating: false, configOpen: false }),
    'STEMS',
    'fertige Stems'
  );
  assert.equal(
    deriveStemCenterPhase({ hasStems: true, isSeparating: false, configOpen: true }),
    'CONFIGURE',
    '„Separation erneut ausführen" öffnet das Panel auch bei fertigen Stems'
  );
  assert.equal(
    deriveStemCenterPhase({ hasStems: true, isSeparating: true, configOpen: true }),
    'PROCESSING',
    'ein laufender Job hat Vorrang vor allem anderen'
  );

  // Das Panel schließt sich beim Start – der Zustand kommt dann aus dem Job.
  const started = workspaceReducer(
    { ...INITIAL_WORKSPACE_PANELS, stemConfigOpen: true },
    { type: 'CLOSE_STEM_CONFIG' }
  );
  assert.equal(started.stemConfigOpen, false, 'Konfigurations-Panel schließt beim Jobstart');

  // Modell-Beschriftung: niemals leer, immer das aktive Modell.
  assert.equal(activeStemModelLabel(undefined), 'Automatisch (Profil entscheidet)');
  assert.equal(activeStemModelLabel('BS-RoFormer (Studio Master)'), 'BS-RoFormer (Studio Master)');
  console.log('  ✓ IDLE → CONFIGURE → PROCESSING → STEMS ohne Zwischenzustand');
}

console.log('\n[ TEST ] B1 – Zustand A zeigt nur den Start-Button');
{
  const idle = stripHoverTitles(
    slice(stemCenterSource, "{phase === 'IDLE' && (", "{/* ── ZUSTAND B", 'Ruhezustand')
  );
  const buttonCount = (idle.match(/<button/g) || []).length;
  assert.equal(buttonCount, 1, `Ruhezustand darf genau eine Schaltfläche haben (gefunden: ${buttonCount})`);
  assert.ok(idle.includes('data-stem-action="start-config"'), 'die Schaltfläche startet die Konfiguration');
  assert.ok(idle.includes('Stem-Separation starten'), 'Beschriftung „Stem-Separation starten"');
  for (const forbidden of ['Qualität', 'Schnell', 'High Quality', 'Fortschritt', '<select', 'Modell']) {
    assert.ok(
      !idle.includes(forbidden),
      `Ruhezustand darf "${forbidden}" nicht zeigen (keine Erklärtexte, keine Fortschritte)`
    );
  }
  console.log('  ✓ Ruhezustand: eine Zeile, eine Schaltfläche, kein Text');
}

console.log('\n[ TEST ] B2 – Modell-Isolation im Konfigurations-Panel');
{
  const configure = slice(
    stemCenterSource,
    '{/* ── ZUSTAND B',
    '{/* ── ZUSTAND C',
    'Konfigurations-Panel'
  );
  assert.ok(configure.includes('Aktives Modell:'), 'das aktive Modell wird benannt');
  assert.ok(configure.includes('activeModelLabel'), 'gezeigt wird ausschließlich `activeModelLabel`');
  assert.ok(
    !configure.includes('modelOptions'),
    'die Alternativen (`modelOptions`) existieren im Panel nicht – weder ausgegraut noch ausgeblendet'
  );
  assert.ok(configure.includes('data-stem-action="open-model-picker"'), 'der Modellwechsel läuft über das Zahnrad');
  assert.ok(
    !configure.includes('StemModelPicker'),
    'die ausgelagerte Auswahl wird nicht im Panel gerendert, sondern daneben'
  );

  // Die Modell-Auswahl selbst lebt in einer eigenen Datei und wird aus dem
  // Zahnrad geöffnet; nur dort werden Alternativen aufgelistet.
  assert.ok(pickerSource.includes('data-model-option='), 'die ausgelagerte Auswahl listet Modelle auf');
  assert.ok(pickerSource.includes('data-stem-panel="model-picker"'), 'sie ist als eigene Fläche markiert');
  assert.ok(
    stemCenterSource.includes('<StemModelPicker'),
    'das Panel bindet die ausgelagerte Auswahl ein'
  );
  console.log('  ✓ Im Panel existiert genau ein Modell; Alternativen nur hinter dem Zahnrad');
}

console.log('\n[ TEST ] B3 – Parameter-Zeile und genau eine Primäraktion');
{
  const configure = slice(stemCenterSource, '{/* ── ZUSTAND B', '{/* ── ZUSTAND C', 'Parameter');
  for (const marker of [
    'data-stem-param="quality-fast"',
    'data-stem-param="quality-hq"',
    'Schnell',
    'High Quality',
    'data-stem-param="target-local"',
    'Lokal (GPU/CPU)',
    'data-stem-param="target-remote"',
    'Google Colab',
    'data-stem-action="run-job"',
    'Job jetzt ausführen',
  ]) {
    assert.ok(configure.includes(marker), `Parameter-Zeile muss "${marker}" enthalten`);
  }
  const primaryActions = (configure.match(/UI_ACTION\.primary/g) || []).length;
  assert.equal(primaryActions, 1, `genau eine Primäraktion im Panel (gefunden: ${primaryActions})`);

  // Der Colab-Schalter öffnet ohne Einrichtung die Einrichtung, statt zu lügen.
  assert.match(
    configure,
    /remoteConfigured \? onTargetModeChange\('remote'\) : onOpenRemoteSetup\(\)/,
    'ohne eingerichteten Transport öffnet der Colab-Schalter die Einrichtung'
  );
  console.log('  ✓ Qualität, Ziel und eine Primäraktion – linear und ohne Untermenü');
}

console.log('\n[ TEST ] B4 – Fortschritt ist eine Zeile, keine Fläche');
{
  const processing = slice(
    stemCenterSource,
    '{/* ── ZUSTAND C',
    '{/* ── Fertige Stems',
    'Job-Monitor'
  );
  assert.ok(processing.includes('Status:'), 'Statuszeile vorhanden');
  assert.ok(processing.includes('Fortschritt:'), 'Fortschritt in Prozent vorhanden');
  assert.ok(processing.includes('data-stem-action="cancel-job"'), 'Abbrechen in derselben Zeile');
  // Kein schwebendes Fenster, keine vollflächige Box in der Fortschrittszeile.
  assert.ok(!/\babsolute\b/.test(processing), 'kein absolut positioniertes Overlay im Job-Monitor');
  assert.ok(!/bg-\[#0{1,2}88ff\]/.test(processing), 'keine deckende blaue Fläche im Job-Monitor');
  const rowHeight = /h-8|h-\d+/.exec(processing)?.[0];
  assert.ok(rowHeight, 'die Zeile hat eine feste, flache Höhe');
  // Der definierte Wartetext ist wörtlich vorhanden.
  assert.ok(
    stemCenterSource.includes('Wartet auf externen Rechner ('),
    'der Status benennt den externen Rechner wörtlich'
  );
  console.log('  ✓ Job-Monitor: Status | Fortschritt | Abbrechen in einer flachen Zeile');
}

console.log('\n[ TEST ] B5 – Farb- und Button-Hierarchie ist zentral definiert');
{
  for (const token of [
    'primary:',
    'secondary:',
    'secondarySelected:',
    'ghost:',
    'toggleOn:',
    'danger:',
    'warning:',
    'successActive:',
    'record:',
    'recordActive:',
  ]) {
    assert.ok(themeSource.includes(token), `Token "${token}" fehlt in der Hierarchie`);
  }
  // Primär ist der Rekordbox-Verlauf, Warnung ist Amber, Zerstörend ist Rot.
  assert.ok(UI_ACTION.primary.includes('#0088ff') && UI_ACTION.primary.includes('#00c8ff'), 'Primäraktion trägt den Markenverlauf');
  assert.equal(UI_ACCENT.warning, '#f0b429', 'Warnung ist Amber');
  assert.equal(UI_ACCENT.danger, '#ff453a', 'Zerstörend ist Rot');
  assert.ok(segmentClass(true).includes('#00a2ff'), 'gewählte Segmente sind cyan-getönt');
  assert.ok(segmentClass(false).includes('#161922'), 'nicht gewählte Segmente sind neutral');
  assert.ok(segmentClass(true, true).includes('cursor-not-allowed'), 'deaktivierte Segmente sind sichtbar gesperrt');

  // Hierarchie wird auch tatsächlich an den drei Zonen-Controls angewendet,
  // nicht bloß als ungenutzter Token-Satz dokumentiert.
  for (const token of ['UI_ACTION.secondary', 'UI_ACTION.secondarySelected', 'UI_ACTION.ghost', 'UI_ACTION.warning', 'UI_ACTION.danger']) {
    assert.ok(zone3Source.includes(token), `Zone 3 muss den Token "${token}" verwenden`);
  }
  assert.ok(!zone3Source.includes('rb-button-grid'), 'Zone 3 darf keine legacy-Button-Farbklasse verwenden');
  assert.ok(!stylesSource.includes('.rb-button-grid'), 'alte globale Grid-Button-Farben sind entfernt');
  assert.ok(zone1TransportSource.includes('UI_ACTION.primary'), 'Play ist die Primäraktion des Transport-Kontexts');
  assert.ok(zone1TransportSource.includes('UI_ACTION.successActive'), 'aktive Wiedergabe nutzt den Erfolgszustand');
  assert.ok(zone1TransportSource.includes('UI_ACTION.ghost'), 'sekundäre Transportbefehle bleiben dezent');
  assert.ok(zone1BarSource.includes('UI_ACTION.record') && zone1BarSource.includes('UI_ACTION.recordActive'), 'REC verwendet nur die dedizierten Aufnahme-Tokens');
  assert.ok(menuSource.includes('UI_ACTION.ghost') && menuSource.includes('UI_ACTION.toggleOn'), 'Menüs nutzen Ghost- und Toggle-Ränge');
  assert.ok(menuSource.includes('MENU_ITEM_DANGER') && menuSource.includes('aria-pressed={waveformMode === mode}'), 'Menüs markieren Gefahr und Auswahl semantisch');
  assert.ok(menuSource.includes('aria-pressed={focusMode}') && menuSource.includes('aria-pressed={chatbotOpen}'), 'Menü-Toggles geben den aktiven Zustand barrierefrei aus');
  assert.ok(!menuSource.includes('hover:bg-[#0088ff]'), 'Menüs verwenden keine deckende Markenfarbe als Standard-Hover');
  assert.ok(!zone1BarSource.includes('#7c3aed'), 'der Copilot-Toggle erfindet keinen zweiten Markenverlauf');
  console.log('  ✓ Farb-Ränge werden in Zone 1/3 angewandt; Legacy-Grid-Farben sind entfernt');
}

console.log('\n[ TEST ] B6 – Der Deck-Mixer zeigt nur Ergebnisse');
{
  /*
   * Der Mixer unterhalb des Stem-Centers hat in UI v2.0 genau eine Aufgabe:
   * fertige Stems mischen. Früher trug er zusätzlich Qualitätsprofile, einen
   * Colab-Button, Expertenprofile und eine Fortschrittsbox. Diese Vorstufen
   * liegen heute im Stem-Center (A/B/C) und im Live-Datenfluss-Fenster. Ein
   * Merge hat genau diese Altlasten schon einmal zurück in die neue Datei
   * geholt – der TypeScript-Bau ist daran gescheitert. Deshalb prüft der
   * Vertrag die Trennung am Quelltext.
   */
  const mixer = stripComments(stripHoverTitles(deckMixerSource));
  for (const forbidden of [
    'Qualität',
    'Fortschritt',
    'STEM_MODES',
    'PROFILE_LABELS',
    'onRemoteEnabledChange',
    'remoteStatus',
    'separationProgress',
  ]) {
    assert.ok(
      !mixer.includes(forbidden),
      `Der Deck-Mixer darf "${forbidden}" nicht enthalten – das gehört in Stem-Center/StemModelPicker`
    );
  }
  // Gegenprobe: die Ergebnis-Bedienung ist vollständig vorhanden.
  for (const marker of [
    'Acapella',
    'Instrumental',
    'Reset',
    'onToggleStemSolo',
    'onToggleStemMute',
    'onExtractStemToClip',
    'PAD {',
  ]) {
    assert.ok(mixer.includes(marker), `Der Deck-Mixer muss "${marker}" enthalten`);
  }
  console.log('  ✓ Deck-Mixer: Mischen und Export – Qualität, Ziel und Fortschritt bleiben draußen');
}

console.log('\n✔ UI v2.0: Drei-Zonen-Architektur hält');
