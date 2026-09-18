# `colab/` · Fremde Ausführungsumgebung für das Qualitäts-Gate

`airdox-stem-gate.ipynb` ist das Notebook für die **eine** Messung, die in der
Entwicklungs-Sandbox nicht laufen kann: GitHub-Release-Assets (trainierte
Gewichte) sind dort über `release-assets.githubusercontent.com` /
`objects.githubusercontent.com` nicht erreichbar (`SSL_ERROR_SYSCALL`), während
npm und github.com funktionieren. Ohne trainierte Gewichte bleibt das
Stem-Isolation-Gate (Teil 2) offen und Separation gilt ausdrücklich **nicht**
als produktionsreif.

| Datei | Status |
|---|---|
| `airdox-stem-gate.md` | **Quelle der Wahrheit** – hier ändern |
| `airdox-stem-gate.ipynb` | gebaut, in Colab hochladen: `npm run stems:gate:notebook` |

Der Build ist prüfbar: `npm run stems:gate:notebook -- --check` (läuft in CI)
schlägt fehl, wenn `.ipynb` und `.md` auseinandergedriftet sind. Das Notebook
bewusst **nicht** von Hand editieren – dann verliert man die Unterscheidung
zwischen “gemessen” und “behauptet”.

## Ablauf

1. **Lokal:** `npm run stems:gate:archive` → `stem-gate-colab.tar.gz` (~0,5 MB,
   Quellcode inkl. `src/stems/modelCatalog.json`, ohne `node_modules`, ohne
   Gewichte). Diese Datei nach Google Drive (`My Drive`) legen.
2. **Colab:** `airdox-stem-gate.ipynb` hochladen, Laufzeit → T4 wählen
   (CPU funktioniert auch, nur deutlich langsamer), Zellen der Reihe nach.
3. Das Notebook lädt die Gewichte **über das Setup-Skript aus dem Repo** – es
   stehen keine Modell-URLs im Notebook, die von unserem Katalog abweichen
   könnten. Der sha256 wird gegen `modelCatalog.json` geprüft.
4. Messung: `npm run test:stems:gate` (= `tests/stem-isolation-gate-live.test.ts`
   über den Produktionspfad `StemSeparationEngine → python/bsroformer_inference.py`).
5. `stem-gate-summary.json`, `test_run/` und `model-hash-patch.json` landen im
   Drive-Ordner. `modelHash` in `src/stems/modelCatalog.json` eintragen und den
   Summary-Anhang in den PR – ohne Pin ist der Lauf reproduzierbar, aber nicht
   beweisbar.

## Was das Gate **nicht** kann

- Kein Windows-/Electron-Nachweis, kein Packaging-Build (dafür `windows-build.yml`).
- Kein natives C++-Runtime-Ergebnis (Punkt 6, GGUF/SafeTensors) – dort läuft
  `audiocpp_cli`, und das existsiert noch nicht.
- Kein Urteil über Geschwindigkeit im ausgelieferten Build.
- Und vor allem: ein `TECHNICAL_PASS_QUALITY_FAIL` ist ein **Ergebnis**, kein
  Testfehler. Das Notebook färbt nichts grün – wenn das Modell auf dem
  Goldstandard-Track unter den Schwellen liegt, bleibt Separation Vorschau.
