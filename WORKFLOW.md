# Edit-Workflow in airdox_SMART_Editor v0.4.3

Der Bearbeitungs-Workflow folgt jetzt einem konsistenten **"Quelle → Ziel → Operation"**-Modell:

## Der runde Ablauf

```
┌─────────────────────────────────────────────────────────────┐
│  SCHRITT 1: QUELLE WÄHLEN                                   │
│  ──────────────────────────                                 │
│  • Entweder: Bereich in der Wellenform auswählen (1-128     │
│    BEAT-Buttons, Ziehen mit Maus, Shift-Klick)              │
│    → dann COPY  (in Zwischenablage)                         │
│    → oder CLONE (in Palette)                                │
│  • Oder: Einen Clip in der Palette anklicken                │
│    (Sidebar oder Full-Deck-Ansicht)                         │
│                                                             │
│  Statusleiste zeigt die aktive Quelle an:                   │
│    • "Zwischenablage"  (nach COPY)                          │
│    • "Palette: <Name>" (wenn Clip ausgewählt)               │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│  SCHRITT 2: ZIEL BESTIMMEN                                  │
│  ────────────────────                                       │
│  • Cursor (Playhead) an die gewünschte Position klicken     │
│    → für PASTE / INSERT / Palette-Insert                    │
│  • ODER: Bereich markieren                                  │
│    → für REPLACE / OVERDUB / CLEAR / DELETE                 │
│                                                             │
│  Rechtsklick auf die Wellenform zeigt alle verfügbaren      │
│  Aktionen für die aktuelle Position/Auswahl.                │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│  SCHRITT 3: OPERATION AUSFÜHREN                             │
│  ──────────────────────────                                 │
│  Mit Auswahl (blau markierter Bereich):                     │
│    🟦 CLONE   → Auswahl als Palette-Clip sichern            │
│    ⬜ COPY    → Auswahl in Zwischenablage                   │
│    🟧 REPLACE → Bereich durch Quelle ersetzen (Längenänderung│
│                möglich, Cues werden nachgezogen)            │
│    🟦 OVERDUB → Quelle über Auswahl mischen (Länge bleibt,  │
│                Original bleibt hörbar)                      │
│    🧹 CLEAR   → Bereich stummschalten (Länge bleibt)        │
│    🗑  DELETE  → Bereich entfernen (Zeit schrumpft, Folgemate│
│                rial rückt nach vorne)                       │
│                                                             │
│  Ohne Auswahl (nur Cursor):                                 │
│    📋 PASTE  → Quelle an Cursor einfügen (Zeit öffnet sich) │
│    ➡️ INSERT → Wie PASTE, mit explizitem Cue-Shift-Feedback │
│    📎 INSERT PALETTE CLIP (Rechtsklick) → ausgewählter      │
│       Palette-Clip an dieser Position (mit Tempo/Key-Sync)  │
│                                                             │
│  Jede Operation erstellt einen Undo-Snapshot.              │
│    ↶ UNDO  (Ctrl+Z) macht den letzten Schritt rückgängig    │
│    ↷ REDO  (Ctrl+Y) stellt ihn wieder her                  │
└─────────────────────────────────────────────────────────────┘
```

## Die 8 Edit-Funktionen im Überblick

| Funktion | Tastenkürzel | Was sie tut | Benötigt |
|----------|-------------|-------------|----------|
| **CLONE** | — | Kopiert den ausgewählten Bereich als neuen Clip in die Palette | Auswahl |
| **COPY** | Ctrl+C | Kopiert Auswahl in die Zwischenablage | Auswahl |
| **CLEAR** | — | Schaltet Auswahl stumm (Länge & Beatgrid bleiben) | Auswahl |
| **DELETE** | Entf | Entfernt Auswahl, rückt nachfolgendes Material + Cues nach vorne | Auswahl |
| **PASTE** | Ctrl+V | Fügt Quelle (Clipboard → Palette-Fallback) am Playhead ein | Quelle (Clipboard oder Palette-Clip) |
| **INSERT** | — | Wie PASTE, schiebt Cues explizit nach hinten | Quelle |
| **REPLACE** | — | Ersetzt Auswahl durch Quelle | Auswahl + Quelle |
| **OVERDUB** | — | Mischt Quelle über Auswahl (Original bleibt) | Auswahl + Quelle |
| **UNDO** | Ctrl+Z | Macht letzte Aktion rückgängig | History-Eintrag |
| **REDO** | Ctrl+Y / Ctrl+Shift+Z | Stellt UNDO wieder her | Redo-Eintrag |

## Drei Wege, einen Palette-Clip einzufügen (der Bugfix!)

1. **Sidebar (PALETTE-Panel rechts):** Jeder Clip hat drei Aktions-Buttons:
   - `INSERT @ ▶` (grün) – Clip an Playhead-Position einfügen
   - `REPLACE` (orange) – Auswahl ersetzen (nur aktiv bei Auswahl)
   - `OVERDUB` (blau) – Clip über Auswahl mischen (nur aktiv bei Auswahl)

2. **Full-Deck-Ansicht (obere rechte Ecke "Deck-Ansicht"):** Pro Clip die gleichen drei Buttons in groß.

3. **Rechtsklick auf Wellenform → "Insert Palette Clip @ Cursor":** Setzt die Position direkt per Rechtsklick und fügt dort ein.

Zusätzlich: Die **PASTE- und INSERT-Buttons im unteren EDIT-Block** greifen automatisch auf den aktuell ausgewählten Palette-Clip zurück, wenn die Zwischenablage leer ist. Ein kleines blaues "P"-Badge auf den Buttons zeigt das an, und ein Tooltip nennt die Quelle (`Palette: <Clip-Name>`).

## Tastenkürzel

| Tasten | Aktion |
|--------|--------|
| **Leertaste** | Play/Pause |
| **Esc** | Auswahl aufheben |
| **Ctrl+C** | Copy |
| **Ctrl+V** | Paste |
| **Ctrl+Z** | Undo |
| **Ctrl+Y / Ctrl+Shift+Z** | Redo |
| **Entf / Backspace** | Delete |

## Beweis-Screenshots (Unit-Tests)

Automatisierter Komponenten-Test (`node tests/edit-functions.test.mjs`) erzeugt 12 PNG-Waveform-Screenshots in `tests/screenshots/`:

- `unit-01-initial.png` – Original (10s Beat-Muster)
- `unit-02-copy.png` – Kopierter 2s-Bereich
- `unit-03-clear.png` – Clear: Stille bei Sek. 3-5 (Länge bleibt 10s)
- `unit-04-undo.png` – Undo: Clear rückgängig
- `unit-05-delete.png` – Delete: Bereich entfernt, Dauer → 8s
- `unit-06-paste.png` – Paste: 2s Clip an Pos. 2 eingefügt, Dauer → 10s
- `unit-07-insert.png` – **Palette-Insert: Clip an Pos. 5 eingefügt, Dauer → 11.5s**
- `unit-08-undo-after-insert.png` – Undo des Inserts, Dauer → 10s
- `unit-09-redo.png` – Redo, Insert wieder da, Dauer → 11.5s
- `unit-10-replace.png` – Replace: 1.5s-Bereich durch neuen Clip ersetzt
- `unit-11-overdub.png` – Overdub: Clip über Bereich gemischt
- `unit-12-final-after-all-actions.png` – Endzustand nach allen 8+ Aktionen

Alle 17 Assertions sind grün (siehe Test-Ausgabe oben).
