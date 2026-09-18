# Code-Analyse & Visualisierung (airdox_SMART_Editor)

Dieses Verzeichnis enthält die Analyse-Pipeline, die das Repository in zwei
interaktive Sichten übersetzt:

| Ausgabe | Zweck |
|---|---|
| `code_analysis_out/airdox.cc.json` | **CodeCharta**-Datei: 3D-Code-Stadt (Höhe = rloc, Fläche = functions, Farbe = complexity/fanIn/churn) |
| `code_analysis_out/graph.json` | Rohdaten: Knoten, Metriken, Import-, IPC-, API-, Subprozess- und Protokoll-Kanten |
| `visualization.html` (Repo-Root) | **Eigenständige D3-App** – per Doppelklick im Browser öffnen (Daten sind eingebettet) |

## 1) Analyse ausführen

```bash
python3 tools/code_analysis/analyze_repo.py
```

- Nur Python-Standardbibliothek, keine pip-Abhängigkeiten.
- `--repo <pfad>` für ein anderes Repository.
- Die Ausgaben werden bei jedem Lauf neu erzeugt (Churn via `git log`).

## 2) 3D-Code-Stadt (CodeCharta)

Voraussetzungen laut Doku: Node ≥ 20, Java ≥ 11.

```bash
# Optional: Datei vor dem Hochladen validieren
npm i -g codecharta-analysis
ccsh check code_analysis_out/airdox.cc.json

# Optional: mehrere cc.json zusammenführen (z. B. mit Git-Metriken)
ccsh merge airdox.cc.json <weitere>.cc.json -o merged.cc.json
```

**Im Browser:** <https://codecharta.com/visualization/> öffnen → die Datei
`airdox.cc.json` per Drag & Drop hineinziehen (sie bleibt lokal, kein Upload nötig).

Empfohlene Belegung im Studio:
- **Height (Höhe):** `rloc`
- **Area (Grundfläche):** `functions`
- **Color (Farbe):** `complexity` (rot = verzweigt) oder `fanIn` (rot = viel genutzt)
- **Edge-Metrik:** `imports` (Kopplung), Checkbox „Show Edges" aktivieren
- Dateisuche oben links; mit der rechten Maustaste drehen, Scrollen = Zoom

## 3) Netzwerk-Graph (D3)

```bash
# einfach öffnen (kein Server nötig, Daten sind eingebettet):
visualization.html
```

- Knotenfarben: Blau = `src/` · Gelb = `electron/` · Rot = Root-Core (`server.ts`) ·
  Grün = `native/` · Türkis = `python/`+`colab/` · Violett = `scripts/` · Grau = `tests/`
- Kantenarten: Import, IPC (blau, animiert), HTTP-API (rot), Python-Subprozess (grün),
  Bundle-Brücke (orange), geteiltes Protokoll (türkis)
- Interaktion: Zoom/Pan, Knoten ziehen, Doppelklick = anpinnen, Hovern = Nachbarschaft,
  Klick = Detailpanel, Suche, Hotspot-Liste (rloc/Komplexität/Git-Churn/Fan-In),
  Filter über Legende, 🌪️ Shake
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
