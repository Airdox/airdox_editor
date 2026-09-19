# Code-Analyse & Visualisierung (airdox_SMART_Editor)

Dieses Verzeichnis enthält die Analyse-Pipeline, die das Repository in zwei
interaktive Sichten übersetzt:

| Ausgabe | Zweck |
|---|---|
| `code_analysis_out/airdox.cc.json` | **CodeCharta**-Datei: 3D-Code-Stadt inkl. Git-Risiko-Metriken und kombiniertem `riskScore` |
| `code_analysis_out/graph.json` | Rohdaten: Knoten, Metriken, Import-, IPC-, API-, Subprozess- und Protokoll-Kanten |
| `visualization.html` (Repo-Root) | **Eigenständige D3-App** – per Doppelklick im Browser öffnen (Daten sind eingebettet) |

## 1) Analyse ausführen

```bash
python3 tools/code_analysis/analyze_repo.py
```

- Nur Python-Standardbibliothek, keine pip-Abhängigkeiten. Keine Installation nötig.
- `--repo <pfad>` für ein anderes Repository.
- Die Ausgaben werden bei jedem Lauf neu erzeugt (Git-Historie via `git log`).

## 2) Change-Risk: Berechnung & Farbskala

### 2.1 Metriken pro Datei

| Metrik | Quelle | Bedeutung |
|---|---|---|
| `commitsCount` | `git log --name-only` (volle Historie) | Wie oft wurde die Datei geändert? („Churn" auf Datei-Ebene, **nicht** Zeilen-Churn) |
| `authorCount` | `git log %an` | Anzahl verschiedener Autoren (Wissens-Streu-Risiko) |
| `ageInDays` | `git log %ct` | Tage seit letzter Änderung (0 = heute) – nur Inspektionsmetrik, **nicht** im Score |
| `riskScore` | Formel s. u. | **Kombinierter Score 0–100** – empfohlen für die Stadtfarbe |

### 2.2 Der kombinierte `riskScore` (0–100)

Klassische Hotspot-These: **Risiko = Komplexität × Änderungshäufigkeit × Autorenbeteiligung**.
Jede Komponente wird dafür auf ihr Maximum im Projekt normiert (0–1), dann gewichtet summiert:

```
riskScore = round( 100 · ( 0.35 · complexity/maxComplexity
                         + 0.35 · commitsCount/maxCommits
                         + 0.20 · authorCount/maxAuthors
                         + 0.10 · rloc/maxRloc ) )
```

Die Gewichte sind bewusst einfach und in `analyze_repo.py`
(Abschnitt „Kombinierter Risiko-Score") direkt anpassbar. Normiert wird immer
innerhalb des aktuellen Snapshots – der Score ist also ein **relativer Vergleich
innerhalb des Projekts**, nicht über Projekte hinweg.

### 2.3 Farbskala (Grün → Gelb → Rot)

CodeCharta bildet die gewählte Farb-Metrik **linear** auf die Ampelskala ab:
der kleinste Wert (0) der geladenen Map wird grün, der **Maximalwert rot**, die
Mitte gelb (im Color-Panel per Schieberegler „Max Color Value" justierbar –
sinnvoll, wenn ein Ausreißer die Skala flachdrückt).

Da `riskScore` bereits auf 0–100 skaliert, gilt als Orientierung:

| Risk-Score | Farbe | Lesart |
|---|---|---|
| 0–39 | 🟢 grün | unauffällig |
| 40–69 | 🟡 gelb | beobachten (Kandidaten für Tests/Refactoring) |
| 70–100 | 🔴 rot | Hotspot –Refactoring priorisieren |

Aktueller Stand (Snapshot dieser Ausgabe): **1 rote Datei** (`src/App.tsx`,
96/100), **6 gelbe** (u. a. `electron/main.cjs`, `DetailWaveform.tsx`,
`anlzParser.ts`), Rest grün.

### 2.4 Zwei Wege zu Git-Metriken

**Weg A – ohne Java (eingebaut, Standard):** `analyze_repo.py` berechnet
`commitsCount`, `authorCount`, `ageInDays` und `riskScore` selbst aus `git log`
und schreibt sie in `airdox.cc.json`. Voraussetzung: nur `git` (und Python 3).
*Hinweis: Werte decken die Historie des lokalen Klons ab – nach einem frischen
`git clone` sind das alle Commits auf dem gewählten Branch.*

**Weg B – offizieller gitlogparser (mit Java):** zusätzliche Parser-Metriken
(u. a. `numberOfAuthors`, Co-Change-Kopplungen) und Merge in eine Datei:

```bash
npm i -g codecharta-analysis          # Node >= 20, Java >= 11
bash tools/code_analysis/run_gitlog_analysis.sh
# → code_analysis_out/airdox_risk.cc.json  (Farbe = riskScore oder numberOfAuthors)
```

## 3) 3D-Code-Stadt bedienen (CodeCharta Web Studio)

1. <https://codecharta.com/visualization/> öffnen (Dateien bleiben lokal im Browser).
2. `code_analysis_out/airdox.cc.json` per Drag & Drop hineinziehen.
3. Belegung:
   - **Height (Höhe):** `rloc`
   - **Area (Grundfläche):** `functions`
   - **Color (Farbe):** `riskScore` (Risk-Stadt, s. Abschnitt 2.3) oder
     `complexity` / `fanIn`
   - **Edges:** Metrik `imports`, Checkbox „Show Edges" → IPC-/API-Brücken leuchten
4. Navigation: Mausrad = Zoom, rechte Maustaste = drehen, Klick = Metriken,
   Suche oben links.

Optional vorab validieren: `ccsh check code_analysis_out/airdox.cc.json`.

## 4) Netzwerk-Graph (D3)

```bash
# einfach öffnen (kein Server nötig, Daten sind eingebettet):
visualization.html
```

- Knotenfarben: Blau = `src/` · Gelb = `electron/` · Rot = Root-Core (`server.ts`) ·
  Grün = `native/` · Türkis = `python/`+`colab/` · Violett = `scripts/` · Grau = `tests/`
- **Goldener Halo** = Top-10 nach `riskScore`
- Kantenarten: Import, IPC (blau, animiert), HTTP-API (rot), Python-Subprozess (grün),
  Bundle-Brücke (orange), geteiltes Protokoll (türkis)
- Interaktion: Zoom/Pan, Knoten ziehen, Doppelklick = anpinnen, Hovern = Nachbarschaft,
  Klick = Detailpanel, Suche, Hotspot-Liste (**Risk-Score / Zeilen / Komplexität /
  Commits / Fan-In / Autoren / Alter**), Filter über Legende, 🌪️ Shake
- Tooltips zeigen den Risk-Score prominent an, plus Commits, Autoren,
  Tage seit letzter Änderung
- Beim ersten Öffnen wird Internet für das D3-CDN benötigt (danach optional
  `d3.min.js` lokal ablegen)

## 5) Abhängigkeiten (Übersicht)

| Komponente | Benötigt | Installiert? |
|---|---|---|
| `analyze_repo.py` (Weg A) | Python ≥ 3.9 (stdlib), `git` | nichts zu installieren |
| `visualization.html` | Browser (einmalig Internet für D3-CDN) | nichts zu installieren |
| CodeCharta Web Studio | nur der Browser | nichts zu installieren |
| Weg B: `run_gitlog_analysis.sh` | `npm i -g codecharta-analysis` (Node ≥ 20) **und Java ≥ 11** | nur für die Parser-Extras nötig |

Am Projekt selbst (`package.json`, Laufzeit-Abhängigkeiten) ändert sich nichts –
alles liegt unter `tools/code_analysis/` und ist für den App-Betrieb irrelevant.

## 6) Wie die Cross-World-Kanten erkannt werden

- **IPC:** `preload.cjs` wird geparst (inkl. verschachtelter Objekte wie
  `stemEngine.*`) und die Kanalnamen werden den `ipcMain.handle(...)`-Registrierungen
  in `electron/*.cjs` zugeordnet – auch bei Registrierung über `CHANNELS.<key>`.
- **HTTP:** `fetch('/api/...')` im Renderer → `server.ts`.
- **Subprozess/Protokoll:** kuratierte Kanten, jeweils durch Codekommentare
  verifiziert (`roformerSeparator → bsroformer_inference.py` usw.).
- **Bundle-Brücke:** `stemEngineBridge.cjs` lädt `dist/stems/node-bridge.cjs`,
  das Build-Produkt von `src/stems/nodeBridge.ts`.

Alle Heuristiken sind approximativ (regex-basiert) – sie ersetzen keine
Compiler-Analyse, liefern aber ein robustes, regenerierbares Architekturbild.
