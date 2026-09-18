# Code-Analyse & Visualisierung (airdox_SMART_Editor)

Dieses Verzeichnis enthält die Analyse-Pipeline, die das Repository in zwei
interaktive Sichten übersetzt:

| Ausgabe | Zweck |
|---|---|
| `code_analysis_out/airdox.cc.json` | **CodeCharta**-Datei: 3D-Code-Stadt inkl. Git-Risiko-Metriken (`commitsCount`, `authorCount`, `ageInDays`) |
| `code_analysis_out/graph.json` | Rohdaten: Knoten, Metriken, Import-, IPC-, API-, Subprozess- und Protokoll-Kanten |
| `visualization.html` (Repo-Root) | **Eigenständige D3-App** – per Doppelklick im Browser öffnen (Daten sind eingebettet) |

## 1) Analyse ausführen

```bash
python3 tools/code_analysis/analyze_repo.py
```

- Nur Python-Standardbibliothek, keine pip-Abhängigkeiten.
- `--repo <pfad>` für ein anderes Repository.
- Die Ausgaben werden bei jedem Lauf neu erzeugt (Git-Historie via `git log`).

## 2) 3D-Code-Stadt (CodeCharta)

Voraussetzungen laut Doku: Node ≥ 20, Java ≥ 11.

```bash
# Optional: Datei vor dem Hochladen validieren
npm i -g codecharta-analysis
ccsh check code_analysis_out/airdox.cc.json
```

**Im Browser:** <https://codecharta.com/visualization/> öffnen → die Datei
`airdox.cc.json` per Drag & Drop hineinziehen (sie bleibt lokal, kein Upload nötig).

Empfohlene Belegung im Studio:
- **Height (Höhe):** `rloc`
- **Area (Grundfläche):** `functions`
- **Color (Farbe):** `complexity` (rot = verzweigt), `fanIn` (rot = viel genutzt)
  oder **`authorCount` / `commitsCount` (rot = Change-Risk)**
- **Edge-Metrik:** `imports` (Kopplung), Checkbox „Show Edges" aktivieren
- Dateisuche oben links; mit der rechten Maustaste drehen, Scrollen = Zoom

## 3) Change-Risk: zwei Wege

**Weg A – ohne Java (eingebaut):** `analyze_repo.py` berechnet pro Datei
`commitsCount` (Commits), `authorCount` (beteiligte Autoren) und `ageInDays`
(Tage seit letzter Änderung) direkt aus `git log` und schreibt sie in
`airdox.cc.json`. Farbe = `authorCount` genügt für die Risk-Stadt.

**Weg B – offizieller gitlogparser (mit Java):** zusätzliche Metriken wie
Datei-Kopplung aus Co-Changes und exakte Alters-Ranges:

```bash
npm i -g codecharta-analysis          # Node >= 20, Java >= 11
bash tools/code_analysis/run_gitlog_analysis.sh
```

Das Skript führt aus:
1. `ccsh gitlogparser repo-scan --repo-path . -o code_analysis_out/gitmetrics.cc.json -nc`
2. `ccsh merge code_analysis_out/airdox.cc.json code_analysis_out/gitmetrics.cc.json -o code_analysis_out/airdox_risk.cc.json`

→ `airdox_risk.cc.json` im Studio laden, Farbe = `numberOfAuthors`.

## 4) Netzwerk-Graph (D3)

```bash
# einfach öffnen (kein Server nötig, Daten sind eingebettet):
visualization.html
```

- Knotenfarben: Blau = `src/` · Gelb = `electron/` · Rot = Root-Core (`server.ts`) ·
  Grün = `native/` · Türkis = `python/`+`colab/` · Violett = `scripts/` · Grau = `tests/`
- Kantenarten: Import, IPC (blau, animiert), HTTP-API (rot), Python-Subprozess (grün),
  Bundle-Brücke (orange), geteiltes Protokoll (türkis)
- Interaktion: Zoom/Pan, Knoten ziehen, Doppelklick = anpinnen, Hovern = Nachbarschaft,
  Klick = Detailpanel, Suche, Hotspot-Liste (**rloc / Komplexität / Commits / Fan-In /
  Autoren / Alter**), Filter über Legende, 🌪️ Shake
- Tooltips zeigen u. a. Commits, Autoren und Tage seit letzter Änderung
- Hinweis: Beim ersten Öffnen wird Internet für das D3-CDN benötigt; danach kann
  `d3.min.js` lokal abgelegt werden, um offline zu arbeiten.

## Wie die Cross-World-Kanten erkannt werden

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
