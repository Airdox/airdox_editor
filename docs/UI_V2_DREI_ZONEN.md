# UI v2.0 – Drei-Zonen-Architektur (Master-Layout & Workflow)

**Stand:** 04.10.2026 · **Umsetzung:** `src/ui/`, `src/components/zones/`, `src/App.tsx`
**Durchsetzung:** `tests/ui-v2-three-zone-layout.test.ts`, `tests/collapsible-palette.test.ts`,
`tests/app-render-smoke.test.tsx`, `tests/stem-engine-ipc-contract.test.ts`

Dieses Dokument ist die verbindliche Spezifikation. Es beschreibt nicht, was man tun *könnte*,
sondern was der Code *tut* – und wie er daran gehindert wird, es anders zu tun.

---

## 1. Makro-Architektur: drei Zonen, keine vierte

```
+---------------------------------------------------------------------------------+
| ZONE 1: Globale System-, Transport- & Fokus-Leiste (permanent, h-11)            |
|   [app][fensterknöpfe] | Datei Bearbeiten Betrachten Hilfe | ⏮ ▶ ⏹ ↺ Q [pegel]  |
|   [♪ La Roux – Quicksand  128.00 BPM  8A]        [AI COPILOT][DB][REC][15:21]   |
|                                              [⇥⇤ Max. Platz / Alles einklappen] |
+---------------------------------------------------------------------------------+
| ZONE 2: Primärer Viewport                                                       |
|   TrackHeader (Artwork · Metadaten · Overview-Waveform)                          |
|   Stem-Center  → Zustand A: [+ Stem-Separation starten]                          |
|                → Zustand B: Konfigurations-Panel (GENAU EIN Modell)              |
|                → Zustand C: [Status: …] [Fortschritt: n%] [Abbrechen]            |
|                → fertige Stems: Deck-Mixer (Vocals/Drums/Bass/Other)             |
|   DetailWaveform  (+ Clip-Palette rechts, + Copilot-Palette rechts)              |
+---------------------------------------------------------------------------------+
| ZONE 3: Sekundäre Bearbeitungs- und Selektions-Paletten (Standard: eingeklappt)   |
|   [BEAT SELECT ▸] [SELECT ▸] [EDIT ▸]        Auswahl: 4.0 Takte · Zwischenablage  |
|   (aufgeklappt: genau eine Sektion – Akkordeon)                                  |
|   Browser- & Sammlungsleiste                                                     |
+---------------------------------------------------------------------------------+
```

Es gibt genau **drei** Zonen. Die früheren Leisten `TitleBar`, `MenuBar` und `EditModeBar` waren drei
Zeilen übereinander; sie sind in **Zone 1** aufgegangen (`TitleBar` und `EditModeBar` sind gelöscht,
`MenuBar` lebt unverändert als Menü-Cluster innerhalb der Leiste). Schwebende Infoboxen und
vollflächige Statusboxen gibt es in keiner Zone mehr.

---

## 2. Zone 1 – die permanente Leiste

### 2.1 Inhalt (abschließend)

| Position | Element | Bauteil |
|---|---|---|
| links | App-Marke + native Fensterknöpfe | `Zone1TopBar` |
| links | Menüleiste: **Datei**, **Bearbeiten**, **Betrachten**, **Hilfe** | `MenuBar` (Cluster) |
| links | kompakter Transport: `\|<`, **Play/Pause**, **Stop**, Loop, Quantize, Master-Pegel + Lautstärke | `Zone1Transport` |
| Mitte | persistente Anzeige des aktiven Tracks (`Interpret – Titel`, BPM, Tonart) + Projektname | `Zone1TopBar` |
| rechts | globale Werkzeuge: **AI COPILOT**, **DB-Extraktor**, **REC**, Einstellungen, Hilfe | `Zone1TopBar` |
| rechts | Systemzeit | `useSystemClock` |
| rechts | **„Max. Platz / Alles einklappen"** (Fokus-Umschalter, permanent) | `Zone1TopBar` |

### 2.2 Ausschlusskriterium (hart)

> In Zone 1 befinden sich **niemals** temporäre Prozessstatus, Fortschrittsbalken oder redundante
> Import-Schaltflächen.

Umgesetzt ist das nicht als Konvention, sondern strukturell:

1. **Signatur-Verbot.** `Zone1TopBarProps` enthält keine Eigenschaft für Fortschritt, Ladezustand
   oder Import. Wer einen Status an Zone 1 geben will, muss die Datei ändern – und der Vertragstest
   (`tests/ui-v2-three-zone-layout.test.ts`, A1) schlägt dann fehl.
2. **Der Menüpunkt Track-Import** bleibt ein Menüpunkt. Er zeigt **keinen** Ladezustand
   („Sammlung wird geladen…" ist entfernt); während des Ladens ist er lediglich deaktiviert.
3. **Die frühere Schaltfläche „TRACK-IMPORT"** am rechten Rand der alten Menüleiste ist gestrichen.
   Der `app-render-smoke`-Test prüft aktiv, dass sie im Erstrendering **nicht** mehr existiert.
4. **Prozessmeldungen** (Sammlung lädt, externe Zerlegung meldet etwas) erscheinen in einer
   flüchtigen Statuskarte unten rechts – `TransientStatusToast`, ausdrücklich **außerhalb** aller
   Zonen. Fortschritt erscheint dort als 2-px-Linie, nie als Fläche.

### 2.3 Der Fokus-Umschalter (Workspace-Anker)

* Immer sichtbar, optisch hervorgehoben, Icon zweier aufeinander zubewegender Pfeile
  (`ChevronsRightLeft`), Beschriftung **„Max. Platz / Alles einklappen"**, `aria-pressed`.
* **Ein** Klick löst **einen** Zustandsübergang aus (`workspaceReducer`, Aktion `TOGGLE_FOCUS_MODE`),
  der *synchron* schließt: Zone-3-Sektion, Stem-Konfiguration, Modell-Auswahl, Clip-Palette,
  Clip-Deck, Copilot-Palette, Browserleiste.
  Die vollständige Liste steht als `FOCUS_MODE_CLOSES` im Code – kommt ein Panel hinzu, muss es dort
  auftauchen, sonst kann es der Fokus-Modus nicht schließen.
* Zone 3 wird **vollständig ausgeblendet** (`zone3Visible(state) === false`).
* Die Wellenform wächst über die freie Höhe und skaliert zusätzlich mit `verticalScale = 1,25`
  (Prop von `DetailWaveform`).
* **Ausnahme mit Absicht:** Ein *laufender Job* ist kein Panel. Der Fortschrittsbalken in Zone 2
  bleibt sichtbar – sonst würde das Aufräumen eine Rechnung unsichtbar machen, die weiterläuft.
* Beim Verlassen wird das **Standard-Layout** wiederhergestellt (`RESTORED_WORKSPACE_PANELS`), nicht
  der Zufallszustand von vorhin.
* Erreichbar über: Button (Zone 1), Menü *Betrachten*, Taste **M**.

---

## 3. Zone 2 – das dynamische Stem-Center

### 3.1 Zustand A – Ruhezustand (Clean State)

Sichtbar ist genau **eine** Zeile, 28 px hoch, unaufdringlich:

```
[ + Stem-Separation starten ]
```

Keine Qualitätsstufen, keine Modell-Listen, keine Erklärtexte, kein Fortschritt. Der Test B1 zählt
im Abschnitt A genau **eine** `<button>` und verbietet die Wörter „Qualität", „Schnell",
„High Quality", „Fortschritt", „Modell" sowie jedes `<select>` im sichtbaren Markup.

### 3.2 Zustand B – Konfigurations-Modus (nach Klick)

```
┌ Aktives Modell: Automatisch (Profil entscheidet)      [⚙ Modell wechseln] [✕] ┐
│ Qualität           [Schnell][High Quality]                                     │
│ Verarbeitungsziel  [Lokal (GPU/CPU)][Google Colab]        [Job jetzt ausführen] │
└ (höchstens eine Zeile Hinweis: „nicht installiert" / „nicht erreichbar") ──────┘
```

**Modell-Isolation (Kernanforderung).** Im Panel ist ausschließlich das aktive Modell sichtbar.
Alternative Engines existieren hier *optisch nicht*: sie sind nicht ausgegraut und nicht
ausgeblendet, sie sind nicht vorhanden. Der Test B2 prüft, dass im Panel-Code kein `modelOptions`
und keine Iteration über Alternativen vorkommt.

**Modellwechsel.** Nur über das Zahnrad. Es öffnet die dedizierte, ausgelagerte Auswahl
(`StemModelPicker`, eigene Karte über Zone 2, Escape/Klick daneben schließt) – dort – und nur dort –
sind alle Architekturen mit Installationsstand, In-Process-Kennzeichnung und Grund aufgelistet.

**Parameter (linear, fehlerfrei):**

| Parameter | Werte | Wirkung |
|---|---|---|
| Qualität | `Schnell` \| `High Quality` | wählt das beste verfügbare Profil (BALANCED/PREVIEW/HIGH bzw. HIGH_QUALITY/MAXIMUM_QUALITY); `Schnell` stellt das Ziel auf lokal |
| Verarbeitungsziel | `Lokal (GPU/CPU)` \| `Google Colab` | schaltet `stemRemoteEnabled`; ist kein Transport eingerichtet, öffnet der Colab-Schalter die **Einrichtung**, statt eine falsche Auswahl zu setzen |
| Aktion | `Job jetzt ausführen` | **genau eine** Primäraktion (Test B3 zählt `UI_ACTION.primary` = 1) |
| Voraussetzung | `Modell installieren` | erscheint nur, wenn das aktive Modell fehlt; `Job jetzt ausführen` ist dann deaktiviert |

### 3.3 Zustand C – Verarbeitungs- und Job-Monitor

Nach dem Start schließt sich das Panel in derselben Aktion. An seiner Stelle steht **ein flacher,
in die Zeile integrierter** Balken:

```
[● Status: Wartet auf externen Rechner (Google Drive)]  [Fortschritt: 2%] [▓▓░░░]  [✕ Abbrechen]
```

* keine vollflächigen blauen Boxen, keine schwebenden Infofenster, kein `absolute`-Overlay
  (Test B4),
* Statustext wörtlich aus der Spezifikation: `Wartet auf externen Rechner (<Transportname>)` für
  `PENDING`/`PREPARING`, sonst `Externer Rechner rechnet (<GPU|CPU-Fallback>) – <Phase>`,
  lokal der Phasentext der Engine,
* Abbrechen liegt **in derselben Zeile**, inklusive der bestehenden Sperren („Abbruch läuft…",
  „Kurz warten…").

### 3.4 Nach dem Abschluss

Der Fortschritt geht nahtlos in die Ansicht der fertigen Stems über: der Deck-Mixer
(`DeckStemsControl`) mit den Kanalzügen des Deskriptors (`stems.stemIds`), Solo/Mute/Volume,
Pad-Zuordnungen, Acapella-/Instrumental-Preset und Clip-Export. Darunter bleibt eine 20-px-Zeile
`Separation erneut ausführen…`, die zurück in Zustand B führt.

---

## 4. Zone 3 – untere Bearbeitungs-Paletten

* **Standard: eingeklappt.** Sichtbar ist eine 28-px-Reiter-Leiste: `BEAT SELECT`, `SELECT`, `EDIT`,
  dazu die Auswahl-Zusammenfassung (Takte, Beats, Sekunden) und die Zwischenablage-Anzeige.
* **Ein Klick klappt auf** – und zwar **genau eine** Sektion (Akkordeon, `TOGGLE_ZONE3_SECTION`).
  Ein zweiter Klick auf denselben Reiter schließt ihn; ein anderer Reiter ersetzt ihn.
* **Inhalt:** `BEAT SELECT` (1–128 Beats), `SELECT` (1/2 HALF, ×2 DOUBLE, ⊗ CANCEL),
  `EDIT` (CLONE, COPY, CUT, PASTE, INSERT, DELETE, CLEAR, UNDO, REDO) plus Kopfzeile mit
  **Tonhöhen-Anpassung** (Pitch), REPLACE, OVERDUB, ASSISTANT und CLEAR HIST.
* Das Aufklappen beendet den Fokus-Modus (man will ja etwas sehen) und schließt die Stem-Konfiguration
  in Zone 2: nie zwei konkurrierende Panel-Stapel.
* Der Fokus-Modus blendet Zone 3 **vollständig** aus.

---

## 5. Farb- und Button-Hierarchie (verbindlich)

Die Hierarchie liegt in `src/ui/theme.ts` (`UI_SURFACE`, `UI_TEXT`, `UI_ACCENT`, `UI_ACTION`,
`segmentClass`). Bauteile erfinden keine Farben mehr; sie wählen einen Rang.

### 5.1 Ränge

| Rang | Rolle | Farbe | Klassenquelle | Beispiele |
|---|---|---|---|---|
| 1 | **Primäraktion** | Verlauf `#0088ff → #00c8ff`, schwarze Schrift | `UI_ACTION.primary` | „Job jetzt ausführen", „Stems jetzt trennen" |
| 2 | **Sekundäraktion** | Fläche `#161922`, Linie `#232738`, Text `#c8c9ce` | `UI_ACTION.secondary` | „Schnell", „High Quality", „Lokal (GPU/CPU)", „Google Colab" |
| 2′ | Sekundäraktion **gewählt** | Fläche `#00284a`, Linie `#00a2ff`, Text `#00e5ff` | `UI_ACTION.secondarySelected` | aktives Segment, gewählter Reiter |
| 3 | **Tertiär / Geist** | transparent, Text `#7c828f → weiß` | `UI_ACTION.ghost` | Menüpunkte, „Modell wechseln", „Einklappen", Fensterknöpfe |
| 4 | **Umschalter aktiv** | Fläche `#0a1a26`, Linie `#00a2ff`, Text `#00e5ff` | `UI_ACTION.toggleOn` | Fokus-Modus AN, Loop, Quantize |
| 5 | **Warnung** | `#f0b429` | `UI_ACCENT.warning` / `UI_ACTION.warning` | „nicht erreichbar", „keine Gewichte", HQ ohne GPU |
| 6 | **Zerstörend** | `#ff453a` auf `#1f1214`, Linie `#402024` | `UI_ACTION.danger` | „Abbrechen", DELETE, „Bearbeitungsverlauf leeren" |
| 7 | **Erfolg / bereit** | `#00c853` / `#00e676` | `UI_ACCENT.success` | „installiert", „MIDI verbunden", Play aktiv |

### 5.2 Regeln

1. **Genau eine Primäraktion pro Kontext.** Nie zwei Cyan-Verläufe nebeneinander. Im
   Stem-Center-Panel ist es `Job jetzt ausführen`; ist das Modell nicht installiert, wird die
   Installation zur Sekundäraktion und die Primäraktion ist deaktiviert (nicht umgefärbt).
2. **Farbe ist Bedeutung, nicht Dekoration.** Rot heißt immer „zerstörend oder Fehler", Amber immer
   „Vorsicht/Voraussetzung", Grün immer „bereit/aktiv". Marken-Cyan ist Aktion.
3. **Neutral ist der Normalfall.** Die Grundfläche bleibt dunkel (`#0a0b0d` / `#0e1015`); Farbe
   erscheint nur an der Stelle, an der eine Entscheidung ansteht.
4. **Umschalter statt Dropdown für Parameter.** Qualität und Verarbeitungsziel sind Segmente –
   der aktuelle Wert ist ohne Klick ablesbar (`aria-pressed`).
5. **Fortschritt ist eine Linie.** 2 px, in einer Zeile, nie eine Fläche. Ausnahme: keiner.
6. **Zustände sind sichtbar.** `hover` hebt die Linie, `disabled` senkt die Deckkraft auf ~40 % und
   setzt `cursor-not-allowed` (nicht „unsichtbar machen"), `aria-pressed`/`aria-selected` markieren
   den aktiven Umschalter.

### 5.3 Maße und Abstände

| Element | Höhe | Anmerkung |
|---|---|---|
| Zone-1-Leiste | 44 px (`h-11`) | eine Leiste, keine zweite |
| Reiter-Leiste Zone 3 | 28 px (`h-7`) | nur im eingeklappten Zustand sichtbar |
| Stem-Center Zustand A | 28 px (`h-7`) | eine Zeile, ruhig |
| Stem-Center Zustand C | 32 px (`h-8`) | flach, Status/Prozent/Abbrechen in einer Zeile |
| Bedienelemente | 24–32 px | gleiche Höhe innerhalb einer Gruppe |
| Radius | 2 px (`rounded-xs`/`rounded-sm`) | Werkzeug-Charakter, kein „App-Karten"-Look |
| Segment-Abstand | 4 px (`gap-1`) | Gruppe bleibt als Gruppe erkennbar |

---

## 6. Prozessmeldungen: wo sie *dürfen*

| Meldungsart | Ort | Warum |
|---|---|---|
| Sammlung lädt, externe Zerlegung meldet etwas | `TransientStatusToast` unten rechts, außerhalb der Zonen | Zone 1 ist statusfrei, Zone 2 soll die Wellenform zeigen |
| Stem-Job läuft | Fortschrittszeile in Zone 2 (Zustand C) | gehört unmittelbar zum Job, den man dort gestartet hat |
| Rekordbox-Metadaten/Importstatus | Dialog, den man selbst geöffnet hat | „was ich öffne, darf Status zeigen" |

---

## 7. Wie die Regeln durchgesetzt werden

| Regel | Mechanismus | Nachweis |
|---|---|---|
| Ein Klick schließt alles synchron | `workspaceReducer` + `FOCUS_MODE_CLOSES` | `tests/ui-v2-three-zone-layout.test.ts` A3, `tests/collapsible-palette.test.ts` |
| Zone 1 bleibt statusfrei | Signatur ohne Status-Props + Quelltextprüfung | A1, `tests/app-render-smoke.test.tsx` |
| Zone 3 standardmäßig eingeklappt, ein Akkordeon | `INITIAL_WORKSPACE_PANELS`, `TOGGLE_ZONE3_SECTION` | A4 |
| Drei Zustände A/B/C | `deriveStemCenterPhase` | A5, B1, B3, B4 |
| Modell-Isolation | Panel ohne `modelOptions`; Alternativen nur im `StemModelPicker` | B2 |
| Abbruch bleibt verdrahtet | `onCancelSeparation` in der Fortschrittszeile | `tests/stem-engine-ipc-contract.test.ts` #8 |
| Farbhierarchie zentral | `src/ui/theme.ts`, `UI_ACTION.*` | B5 |

`npm run verify` (lint → Tests → Build → Budgets) ist der vollständige Nachweis.

---

## 8. Was sich gegenüber der Vorgängeroberfläche geändert hat

| vorher | jetzt |
|---|---|
| `TitleBar` + `MenuBar` + `EditModeBar` (drei Zeilen) | **Zone 1**: eine Leiste (`Zone1TopBar`) mit `MenuBar`-Cluster und `Zone1Transport` |
| „TRACK-IMPORT"-Schnellbutton in der Kopfzeile | nur noch im Menü *Datei*; kein Prozessstatus in Zone 1 |
| `DeckStemsControl` mit Start-Button, Profil-Chips, Expertenprofilen, Remote-Button, Fortschrittsbox | **Stem-Center** (A/B/C) + separater Deck-Mixer; Alternativen nur im `StemModelPicker` |
| zwei Start-Buttons („Stems jetzt trennen" / „Externe Zerlegung") | ein Zielumschalter (`Lokal` \| `Google Colab`) und eine Primäraktion |
| `BottomControlBlock`, standardmäßig aufgeklappt, 176 px hoch | **Zone 3**: eingeklappte Reiter, Akkordeon, max. 128 px aufgeklappt |
| „Zen-Modus" (M) als Sonderfall mit drei Settern | Fokus-Modus als **ein** Reducer-Übergang, Wellenform skaliert 1,25× |
| Fortschritt als farbige Box im Stem-Bereich | flache Zeile `Status · Fortschritt · Abbrechen` |
