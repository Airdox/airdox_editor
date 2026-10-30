# SCNet DJ-Pfad

## Warum SCNet

Die App hatte bereits einen schnellen HT-Demucs-ONNX-Backendpfad. SCNet ergänzt diesen als kleinere Vier-Stem-Option: ein checksum-gepinntes ONNX-Modell mit 12.900.277 Bytes, kein Python und keine externe Analyse-Cloud. Der JS-Adapter [`@audio/neural-separate`](https://www.npmjs.com/package/@audio/neural-separate) übernimmt das zu SCNet passende STFT/iSTFT, Padding, Normalisierung und überlappende Fenster. Dadurch verwenden wir die publizierte Implementierung statt das empfindliche Audio-Frontend nachzubauen.

Die App verwendet die kompakte SCNet-Variante für PREVIEW und BALANCED. `PREVIEW` wird in der Architektur-Auswahl vor HT-Demucs gereiht. Die Referenzimplementierung nutzt standardmäßig einen 2,75-s-Schritt; auf dem i3 war das mit 26:15 Minuten hochgerechneter Dauer zu langsam. Deshalb nutzt die App 5,5 s (50 % der Fensterlänge) für PREVIEW und 4,4 s (40 %) für BALANCED. Das Modell wird einmal geladen und der originale Mix bleibt während der Separation unverändert. Der bestehende Jobdienst übernimmt Abbruch, Fortschritt, Integritätsprüfung, Cache und Ausgabe.

## Hardware und Dauer

Der ermittelte Rechner ist ein Lenovo V130-15IKB mit Intel Core i3-7020U (2 Kerne, 4 Threads), Intel HD Graphics 620 und 20 GB RAM. Der SCNet-Adapter wählt derzeit ausdrücklich die ONNX-Node-CPU. Für diese integrierte GPU ist kein schneller ONNX-Provider zugesichert. Das 12,9-MB-Modell passt in den Arbeitsspeicher; RAM ist nicht der erwartete Engpass, sondern die CPU-Rechenzeit.

Auf dem Zielgerät wurden zwei 60-s-Synthetikläufe ausgeführt: PREVIEW (50 % Schrittweite) 126,05 s, BALANCED (40 %) 181,31 s. Zusätzlich wurde ein vollständiger 300-s-Lauf im PREVIEW-Modus beendet: **608,87 s (10:09)**, 56 Fenster, CPU. Der lange Lauf schließt Modellstart und Inferenz ein und bestätigt das 15-min-Zeitgate für PREVIEW auf synthetischem Audio. BALANCED ist anhand des 60-s-Laufs auf 15:07 hochgerechnet und bleibt unter 20 min, aber noch nicht durch einen vollständigen Lauf bestätigt. Diese Messungen sind keine echte Musikwiedergabe und prüfen nicht die SDR-/Nahtqualität der reduzierten Überlappung. Benchmarks: `node scripts/bench-scnet.mjs --seconds=300 --step=0.5` (BALANCED 60 s: `--seconds=60 --step=0.4`). Ein Release-Gate sollte zusätzlich eine echte 5-min-Musikdatei und einen SDR-/Nahtvergleich für beide Schrittweiten messen.

## Qualität und Lizenz

Die Modellkarte meldet auf 50 MUSDB18-Testvorschauen Median-BSSEval-v4-SDR von 9,88 dB Vocals, 9,44 dB Drums, 8,35 dB Bass und 6,14 dB Other. Das ist mit der Standard-Schrittweite 2,75 s gemessen und daher nicht als Gütenachweis für die schnelleren DJ-Schrittweiten zu verstehen. Code und konvertierte Gewichte werden vom Modellautor als MIT lizenziert beschrieben; die Trainingsdaten MUSDB18-HQ sind für Bildungszwecke lizenziert. Vor kommerzieller Distribution der Gewichte bleibt die Reichweite dieser Datensatzlizenz zu prüfen.

## Quellen

- [SCNet-Modellkarte, Graphform, SHA-256, Messwerte und Lizenzhinweis](https://huggingface.co/audiojs/scnet)
- [SCNet-Paper](https://arxiv.org/abs/2401.13276)
- [SCNet-ONNX-Integration mit STFT/iSTFT und Chunking](https://www.npmjs.com/package/@audio/neural-separate)
- [Browser-WASM-Referenz und Hardwaremessungen](https://github.com/elicwhite/scnet-web-wasm)
- [Vorhandener HT-Demucs-ONNX-Pfad der App](./STEM_ONNX_FASTPATH.md)
