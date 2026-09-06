# Nachweis: realer Schneide-Workflow

Durchlauf wie in der App: 8 Takte ausschneiden (vorher als Clip in die Bibliothek) →
an einer beliebigen Stelle wieder einfügen (mit Pegelangleichung) → darüberlegen (mit
Übersteuerungsschutz) → zwei Takte ersetzen → denselben Clip in eine 128-BPM-Spur
(Tempo angleichen, Taktzahl halten, Tonhöhe halten bzw. mitlaufen lassen) → Bibliothek pflegen → die letzten beiden
Takte nach vorne → Schritt zurück/wiederherstellen → Projekt speichern und öffnen →
Quelldatei unverändert.

Material: 16 Takte @ 120 BPM, 8000 Hz, ein Takt = 2 s = 16000 Samples.

## Wie geprüft wird

Jeder Takt trägt eine eigene Tonhöhe (220 + 100·k Hz) und einen eigenen Pegel
(0,30 + 0,02·k) mit fallender Hüllkurve. Die Taktfolge wird deshalb **unabhängig** von der
Schnitt-Logik bestimmt: Goertzel-Frequenzanalyse je Takt (der beste Treffer muss sich vom
zweitbesten um Faktor 1,35 abheben) plus Hüllkurvenprüfung – ist der Taktanfang nicht lauter
als sein Ende, gilt der Takt als nicht bestimmbar (das erkennt auch rückwärts gelesenes Material).

## Schritte

| # | Schritt | erwartet | tatsächlich | Prüfung |
| --- | --- | --- | --- | --- |
| 1 | Ausgangsmaterial: 16 eindeutige Takte | Taktfolge 0…15, Peak je Takt 0,30…0,60, Beatgrid mit 65 Beats | 16 Takte, 256000 Samples, Peaks je Takt 0,30…0,60 (gemessen 0.300…0.599) | ✓ |
| 2 | Auswahl Takte 5–12: Rasterung – Einfügen eine Takt hoch, Ersetzen an den nächsten Rand | Einfügen: 10.000 s (aufwärts), Ersetzen: 8.000 s (nächster Rand), ohne Raster: frei · Auswahl selbst liegt samplegenau auf Takträndern | Einfügen → 10.000 s (auf Taktanfang gerastet), Ersetzen → 8.000 s, ohne Raster → 8.130 s | ✓ |
| 3 | Auswahl als Clip in die Bibliothek (wie CLONE in der App) | Clip über 8 Takte, Peak = lautester Takt des Clips (0.520 ± 0.02), 48 Vorschau-Buckets | Acht Takte Mitte: 16.000 s, 32 Beats (8 Takte) @ 120.0 BPM, 2A, 128000 Samples @ 8000 Hz, Peak 0.519 (-5.7 dBFS) | ✓ |
| 4 | Ausschneiden: 8 Takte raus, Marker und Schleifen ziehen mit | 128000 Samples weniger, Takt-7-Marker entfällt, Takt-15-Marker rückt auf Takt 7, Intro-Schleife bleibt, Takte-9/10-Schleife entfällt | 128000 Samples entfernt, 0 1 2 3 12 13 14 15, Marker in Takt 1+6, 1 Schleife | ✓ |
| 5 | Clip an beliebiger Stelle einfügen: rastet auf Takt 3, Pegel wird angeglichen | Zielzeit 4.000 s · Taktfolge 0 1 [4…11] 2 3 12 13 14 15 · lautester eingefügter Takt 0.890, nichts über 0.999 | Ziel 4.000 s · gain 1.715 (4.7 dB) · Peak 0.519→0.890 · 0 1 4 5 6 7 8 9 10 11 2 3 12 13 14 15 | ✓ |
| 6 | Darüberlegen: clippt nicht, trockenes Material bleibt unangetastet | kein Sample über 0.999 · Clip wird bei Bedarf leiser gemischt · außerhalb bitgenau gleich | Trocken-Peak 0.890 · Clip 0.890 · Mischartigkeit 0.122 · Ergebnis-Peak 0.987 | ✓ |
| 7 | Zwei Takte ersetzen: Länge gleich, Inhalt ausgetauscht, Rest unverändert | gerastert auf Takt 14 (26,000 s) · Taktfolge 0 1 4 5 6 7 8 9 10 11 2 3 12 4 5 15 | ersetzt ab 26.000 s (32000 Samples), Länge bleibt 32.000 s, 0 1 4 5 6 7 8 9 10 11 2 3 12 4 5 15 | ✓ |
| 8 | Tempowechsel: Clip aus der 120-BPM-Spur in eine 128-BPM-Spur einfügen | genau 8 Takte des Zielrasters (8 · 15000 Samples) · Taktfolge 4…11 auf dem Zielraster erkennbar · Einschwingvorgang bleibt am Taktanfang · Grundfrequenz hält, mit Key-Lock auf wandert sie mit | Länge 128000 → 120000 Samples (8 Takte à 1.875 s), Drift des Taktanfangs 337 Samples (Material selbst 50), Grundfrequenz hält 2.05 gegen 0.00 für f·1.067, Key-Lock auf: 2.07 > 0.00 · Clip vor dem Einfügen normalisiert: Peak 0.519 → 0.890 (+4.7 dB) auf -1.0 dBFS-Ziel; Tempo an Zielspur angepasst (Phasenvocoder): 120.0 → 128.0 BPM (16.000 s → 15.000 s, Tonhöhe bleibt gleich) | ✓ |
| 9 | Bibliothek: duplizieren, umbenennen, sortieren, entfernen · Strg = Deck-Spieler | ein Eintrag mehr nach dem Duplizieren, einer weniger nach dem Entfernen, eindeutige Namen, Reihenfolge zurücksetzbar, Deck lädt Originalsamples | 3 Einträge nach dem Duplikat, 2 nach dem Entfernen, Deck-Modus deck, Export 01_Acht_Takte_Mitte.wav | ✓ |
| 10 | Die letzten beiden Takte nach vorne ziehen | Taktfolge 5 15 0 1 4 5 6 7 8 9 10 11 2 3 12 4 · gleiche Länge · Marker bleiben gültig | 5 15 0 1 4 5 6 7 8 9 10 11 2 3 12 4 bei gleicher Länge (256000 Samples) | ✓ |
| 11 | Schritt zurück und wiederherstellen: samplegenau | Undo liefert exakt den Stand vor dem Umziehen, Redo exakt den danach | undo → 0 1 4 5 6 7…, redo identisch zum Stand nach dem Umziehen (2 Marker, 1 Schleifen) | ✓ |
| 12 | Projektdatei: Endstand und Bibliothek überleben Speichern und Öffnen | Samples innerhalb eines 16-Bit-Schritts (≤ 1/32768), Clipzahl/-taktzahl/-peak erhalten, originalsModified false | 2 Clips, Abweichung 0.500×1/32768, originalsModified=false | ✓ |
| 13 | Quelldatei unverändert (Read-Only-Zusage) | SHA-256 von quelle.wav vor und nach dem Durchlauf gleich | sha256 248ac3dec74929a0… unverändert (1000 kB) | ✓ |
| 14 | Beweisdateien: Endstand als WAV | eine WAV mit dem Ergebnis, alle Takte identifizierbar | endstand.wav: 256000 Samples, 5 15 0 1 4 5 6 7 8 9 10 11 2 3 12 4 | ✓ |

Pegelziele: Normalisierung auf 0.890 (-1.0 dBFS), Obergrenze für jede Summe 0.999.

Dateien: `quelle.wav` (unverändertes Material, 16-Bit), `endstand.wav` (Ergebnis des Durchlaufs).
Erzeugt von `npx tsx tests/workflow-real.test.ts`.
