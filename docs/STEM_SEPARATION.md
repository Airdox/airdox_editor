# Echte Stem-Separation (Demucs)

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

Beim ersten Durchlauf lädt Demucs seine Modellgewichte. Danach läuft die
Inference lokal; die Musik wird nicht an einen Cloud-Anbieter geschickt.
Standard ist CPU. Mit `DEMUCS_DEVICE=cuda` kann eine kompatible NVIDIA-Installation
verwendet werden. `DEMUCS_MODEL=htdemucs` ist schneller, `htdemucs_ft` (Standard)
hat Qualitätspriorität.

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
zuordnen. Die UI meldet einen Fehler, falls Demucs nicht installiert ist; sie
fällt absichtlich nicht still auf die qualitativ unzureichende Filterlösung
zurück.
