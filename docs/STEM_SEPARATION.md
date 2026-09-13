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
zuordnen.

## Lokaler Fallback: STFT-HPSS statt Ein-Pol-Splitter

Der frühere Ein-Pol-Filter-Fallback hatte auf realem Material (MUSDB
Falcon 69) eine gemessene Qualität von SI-SDR **-6,6 dB (Vocals) bis
-10,8 dB (Drums)** — der Fehler war lauter als das Nutzsignal. Er wurde
durch einen STFT-Separator ersetzt (Hann 4096/Hop 1024, Median-Filter-HPSS
nach Fitzgerald 2010, weiche Mid/Side-Spektralmasken, exakter
Zeitbereichs-Rest für OTHER). Gemessene Qualität auf demselben Material:
Vocals **-4,5 dB**, Drums **+1,7 dB**, Bass **-2,6 dB**, Other **-5,1 dB**.
Diese Werte sind als SI-SDR-Mindestgrenzen im Test
`stem-real-mixed-track.test.ts` festgeschrieben — eine Qualitätsregression
kann CI nicht mehr passieren. Da alle Masken pro Bin in [0,1] liegen und
auf 1 summieren, ist der frühere Normalisierungs-Blowup (Knacksen bei
Solo/Mute) konstruktiv ausgeschlossen.

## Kein stiller Qualitäts-Downgrade

Auch der verbesserte STFT-Fallback bleibt deutlich unter Demucs-Qualität
und ist **nicht für Club-/Performance-Einsatz geeignet**. Deshalb gilt:

1. Vor jeder Separation prüft der Editor die Demucs-Verfügbarkeit
   (Desktop-IPC-Preflight bzw. `GET /api/stems/status` im Browser).
2. Fehlt Demucs, wird die Trennung **nicht still** mit dem Fallback
   ausgeführt. Stattdessen erscheint ein Warn-Dialog mit der genauen
   Diagnose (fehlendes Python, fehlendes Modul, fehlende Gewichte) und der
   Installationsanleitung.
3. Nur wenn der Nutzer den Fallback ausdrücklich bestätigt
   (`allowFallback: true` in der Engine-API), läuft der lokale Separator.
   Das Ergebnis trägt dann dauerhaft das Badge **„⚠ FALLBACK-QUALITÄT“** in
   der Stems-Leiste und der Abschluss-Dialog spricht von
   „NUR VORSCHAU-QUALITÄT“, nie von Erfolg in Performance-Qualität.

Der reale MUSDB-Test stellt alles zusammen sicher: Der Standardpfad lehnt bei
fehlendem Demucs mit einer erklärenden Fehlermeldung ab; der ausdrücklich
angeforderte Fallback erzeugt vier hörbare, unterscheidbare Ausgabedateien,
Vocal Solo ist nicht stumm, und jede Stem-Ausgabe muss ihre
SI-SDR-Mindestgrenze gegen die echten Referenzspuren erreichen.
