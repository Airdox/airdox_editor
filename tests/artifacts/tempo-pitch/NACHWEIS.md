# Nachweis: Tempo- und Tonhöhenanpassung von Clips

Ein Clip aus einer 120-BPM-Spur, der in eine 128-BPM-Spur soll, muss schneller werden –
sonst liegen seine Beats nach zwei Takten neben dem Raster. Geprüft wird an Musik-artigem
Material (acht Takte, jeder mit eigener Grundfrequenz, auf jedem Schlag ein Einschwingvorgang):
die Impulse werden im Ergebnis **gemessen** (Hüllkurven-Maxima) und gegen das Zielraster
gerechnet, die Tonhöhe mit Goertzel – beides ohne Kenntnis der Stretch-Logik.

Material: 8 Takte @ 120 BPM, 44100 Hz, 705600 Samples (16.00 s).
Ziel: 128 BPM → Verhältnis 1.066667 (Soll-Länge 661500 Samples = 8 Takte à 1.8750 s).

| # | Prüfung | erwartet | tatsächlich | Ergebnis |
| --- | --- | --- | --- | --- |
| 1 | FFT: Sinuston landet in der erwarteten Tonne | Spitzenbin = nächstgelegene Bin zur Frequenz | Bin 20 (erwartet 20) → 215.3 Hz bei 220 Hz Ton | ✓ |
| 2 | FFT: Hin- und Rückweg sind exakt (Parseval und Identität) | maximale Abweichung < 1e-9 | Abweichung 8.88e-16, Energieverhältnis 1.00000000 | ✓ |
| 3 | Vocoder: Länge stimmt auf unter einen Rahmen | Ziel 661500 Samples ± 2029 | 661500 Samples (erwartet 661500, Δ 0 = 0.00 ms), 2590 Rahmen, Sprungweite 256 | ✓ |
| 4 | Vocoder: Tonhöhe bleibt, wo sie war | Grundfrequenz unverändert, keine Verstärkung bei f·ratio | bei 110 Hz 0.948 × Ausgangsleistung, bei 117.3 Hz nur 0.018 | ✓ |
| 5 | Vocoder: Impulse treffen das Zielraster (der eigentliche Zweck) | jeder Schlag auf dem 128-BPM-Raster, innerhalb des Messrauschens | 32 Impulse, Versatz gegen 128 BPM: Median 9.3 ms, größten 17.4 ms (Toleranz 12.0 ms, Messrauschen am unbearbeiteten Material 5.0 ms); Schlagabstand 468.78 ms (Soll 468.75 ms); gegen 120 BPM wären es 137.8 ms Median | ✓ |
| 6 | Vocoder: Pegel bleibt am Eingang (kein Rand-Ausreißer) | Spitze 0,5–1,5 × Eingang, Sinus-RMS ±1 % | Clip: Spitze 0.7815 → 0.8256; Sinus-RMS-Verhältnis 0.9980 | ✓ |
| 7 | Vocoder: Pegel je Takt hält (keine Löcher) | kein Takt weicht mehr als 8 % ab | Pegelverhältnisse je Takt 0.935 0.963 0.950 0.942 0.958 0.951 0.949 0.957 – größter Fehler 6.5 % (Takt 0) | ✓ |
| 8 | Vocoder: Kanäle bleiben zueinander proportional | rechts = 0,5 × links, exakt | größte Abweichung 0.00e+0 | ✓ |
| 9 | Vocoder: zweiter Lauf liefert bitgleiche Samples | identische Arrays | 661500 Samples, beide Läufe bitgleich | ✓ |
| 10 | Resample: Länge gleich, Tonhöhe wandert mit dem Tempo | Spitze bei 110·1.0667 Hz | 661500 Samples, Spitze 117.30 Hz (erwartet 117.33), 111.7 Cent = 1.12 Halbtöne | ✓ |
| 11 | beide Wege erzeugen dieselbe Dauer | ±1 Sample nach fitLength | 661500 = 661500 = 661500 Samples | ✓ |
| 12 | fitLength: Stutzen und Auffüllen | exakte Samplezahl, Lücken still | 1000 und 706100 Samples, angehängte Stille 500 Samples | ✓ |
| 13 | fitToTempo: meldet jede Entscheidung richtig | aus / kein tempo / praktisch gleich / stumm / zu kurz | fünf Meldungen korrekt; Standard: vocoder, Text „Tempo an Zielspur angepasst (Phasenvocoder): 120.0 → 128.0 BPM (16.000 s → 15.000 s, Tonhöhe bleibt gleich)“ | ✓ |
| 14 | fitToTempo: Key-Lock aus nimmt die Tonhöhe mit | pitchCents = 1200·log2(ratio) | 111.7 Cent vorhergesagt, gemessen 117.30 Hz (erwartet 117.33) | ✓ |
| 15 | planTempoFit: die Oberfläche zeigt, was gleich passiert | ohne zu rechnen: Verhältnis, Prozent, Cent | +6.7 % → 15.0000 s (gerechnet 15.0000 s) | ✓ |
| 16 | Ablage in fremde Spur: Clip wird exakt acht Takte des Zieltempos | 8 · 82688 Samples | 661500 Samples eingefügt (8 Takte à 1.8750 s), Spur danach 992250 Samples | ✓ |
| 17 | Ablage: Pegel und Tempo stehen gemeinsam in der Meldung | ein Satz mit „normalisiert“ und „Tempo an Zielspur“ | Clip vor dem Einfügen normalisiert: Peak 0.781 → 0.890 (+1.1 dB) auf -1.0 dBFS-Ziel; Tempo an Zielspur angepasst (Phasenvocoder): 120.0 → 128.0 BPM (16.000 s → 15.000 s, Tonhöhe bleibt gleich) | ✓ |
| 18 | Ablage ohne Tempoangleichung: Clip behält seine alte Länge | 705600 Samples | 705600 Samples, Clip-Ende 34.13 Beats nach Zielraster (Taktversatz 2.13 Beats) | ✓ |
| 19 | Ersetzen in fremdes Tempo: Taktzahl bleibt, Rest der Spur rückt nicht | Länge der Spur gleich, Inhalt 8 Takte | ersetzt ab 7.5000 s über 661500 Samples, Spur bleibt 1323000 Samples | ✓ |
| 20 | describeClipFit: Text der Oberfläche rechnet wie die Ablage | Plan-Text mit Ziel-BPM und Prozent | 120.0 → 128.0 BPM (+6.7 %, 16.000 s → 15.000 s), Tonhöhe bleibt | ✓ |
| 21 | WSOLA: für kurzes Material brauchbar, Länge stimmt | ±1 Rahmen um 661500 | Fallback-Methode vocoder; WSOLA am langen Clip: 661500 Samples (Δ 0), 651 Rahmen | ✓ |
| 22 | Kosten: acht Takte Material in nützlicher Frist | unter 4 s für 16 s Material in Stereo | 1142 ms für 16.0 s Stereo bei 44100 Hz (71 ms pro Sekunde Audio) | ✓ |

Wege: `phaseVocodeStretch` (Tonhöhe bleibt – Rahmenlänge 46 ms, 75 % Überlappung,
Phasenfortschritt je Tonne auf den Synthesefahrplan gerechnet), `resamplePcm`
(Tonhöhe wandert mit – Key-Lock aus), `wsolaStretch` (Ausweg für sehr kurzes Material).
Reihenfolge in `fitClipForTrack`: erst Pegel (`normalizeClipAudio`), dann Tempo – danach
liegt der Clip samplegenau auf der Taktgrenze der Zielspur.

Erzeugt von `npx tsx tests/tempo-pitch.test.ts`.
