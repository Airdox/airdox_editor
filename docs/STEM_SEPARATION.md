# Echte Stem-Separation (Demucs)

> **Neu:** Die modulare, nicht-destruktive Stem-Engine (BS-RoFormer als
> High-Quality-Engine, Modell-Registry, Chunking/Overlap-Add, Validierung,
> Cache, Abbruch) ist in [`STEM_SEPARATION_ENGINE.md`](./STEM_SEPARATION_ENGINE.md)
> beschrieben. Dieser Text dokumentiert weiterhin den heute ausgelieferten
> Demucs-Pfad der Editor-UI.

## Warum ein Modell nötig ist

Vocals, Gitarren, Synthesizer und Snare überlappen sich im Frequenzbereich. Ein
Frequenzfilter kann sie deshalb nicht seriös aus einem fertigen Master trennen.
Der Editor verwendet für die sichtbare Stem-Funktion nun das trainierte
**Demucs `htdemucs_ft`** (Vocals, Drums, Bass, Other). Der frühere Multi-Band-DSP
bleibt nur für deterministische Low-Level-Tests erhalten und wird von der UI
nicht mehr als Stem-Separation angeboten.

## Installation

Linux/macOS:

```bash
npm run stems:setup
```

Windows PowerShell:

```powershell
npm run stems:setup:win
```

Das Windows-Setup wählt bewusst Python 3.12, 3.11, 3.10 oder 3.9 und prüft
anschließend echte Imports von `demucs`, `torch` und `torchaudio`. Ein zufällig
installiertes Python 3.14 wird nicht mehr ungeprüft verwendet. Vor jeder
Separation kontrolliert die Desktop-App außerdem: ausführbare Python-Datei,
unterstützte Version, alle drei Module sowie den Status der vier
`htdemucs_ft`-Gewichte. Erst nach bestandener Vorprüfung wird die Audiodatei an
den Modellprozess übergeben; andernfalls startet direkt der lokale Separator.

Beim ersten Durchlauf lädt Demucs seine Modellgewichte. Danach läuft die
Inference lokal; die Musik wird nicht an einen Cloud-Anbieter geschickt.
Demucs wählt CUDA automatisch, wenn es verfügbar ist, andernfalls CPU.
`DEMUCS_DEVICE=cpu|cuda` kann das Verhalten explizit festlegen.

### Verbindliches Max-Quality-Profil

- `htdemucs_ft`: Ensemble aus vier separat feinabgestimmten Modellen
- `--shifts 10`: Stabilisierung durch zehn zeitverschobene Vorhersagen – die
  Qualitätseinstellung aus dem Demucs-Paper
- `--overlap 0.5`: 50 % überlappende Segmente gegen Übergangsartefakte
- Float32 vom Web-Audio-Buffer bis zu allen vier Ausgabe-WAVs; keine
  zwischenzeitliche 16-Bit-Quantisierung
- `clip-mode=rescale` statt hartem digitalen Clipping
- automatische Hardwarebeschleunigung

Ein Lauf benötigt dadurch ungefähr 40 Modellvorhersagen und ist erheblich
langsamer als die Standardeinstellung. Das ist beabsichtigt: Ausgabequalität
hat Vorrang vor Wartezeit. Für gezielte Benchmarks lassen sich die Defaults mit
`DEMUCS_SHIFTS` und `DEMUCS_OVERLAP` überschreiben; die Anwendung selbst nutzt
standardmäßig das oben beschriebene Qualitätsprofil.

## Reales Abnahmeszenario

1. Eine fertig gemasterte WAV/MP3/FLAC-Datei mit Gesang und vollständiger
   Begleitung in Deck A laden.
2. Wiedergabe an einer Stelle mit Gesang starten.
3. **Stems jetzt trennen** drücken und den ersten Modell-Download/CPU-Lauf
   abwarten.
4. Während der volle Mix läuft **Acapella** drücken. Die Wiedergabe wechselt
   ohne Pause/Play sofort und positionsgetreu auf `vocals`.
5. `vocals`, `drums`, `bass` und `other` jeweils mit **S** solo abhören und über
   **Extract** als getrennte Clips übernehmen.
6. **Instrumental** muss die Stimme stark reduzieren; **Reset** stellt den Mix
   wieder her.

Für eine objektive Benchmark-Auswertung ist MUSDB18-HQ geeignet: Demucs erhält
nur `mixture.wav`; die vier Referenzspuren dürfen ausschließlich nach der
Inference für SI-SDR-Messungen verwendet werden.

```bash
STEM_BENCHMARK_MIX=/pfad/zu/mixture.wav \
STEM_BENCHMARK_REFERENCES=/pfad/zu/referenzordner \
STEM_MIN_SI_SDR=0 \
npm run test:stems:real
```

Ohne `STEM_BENCHMARK_REFERENCES` wird derselbe echte Blind-Workflow ausgeführt,
die vier WAV-Dateien werden nach `stem-test-output/` geschrieben und auf
Gültigkeit, Pegel und unterschiedliche Inhalte geprüft. Mit Referenzen enthält
der Ordner ausschließlich `vocals.wav`, `drums.wav`, `bass.wav` und `other.wav`;
sie werden erst nach dem Modelllauf für SI-SDR geöffnet.

## Wichtige Einschränkung

Source Separation ist eine Schätzung. Auch ein hochwertiges Modell kann Hall,
Backing-Vocals oder stark verzerrte Instrumente teilweise dem falschen Stem
zuordnen. Falls Demucs oder seine Modellgewichte nicht verfügbar sind, bleibt
die Funktion benutzbar: Der Editor verwendet den lokalen, summentreuen
Spektral-Separator und weist ihn im Ergebnis ausdrücklich als
`lokaler Spektral-Fallback` aus. Der reale MUSDB-Test stellt sicher, dass auch
dieser Pfad vier hörbare und unterscheidbare Ausgabedateien erzeugt und Vocal
Solo nicht stumm ist.
