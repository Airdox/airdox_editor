# STEM-Abnahme vom 30.10.2026

**Aktueller Status: Der lokale SCNet-Workflow ist mit echter Inferenz, Electron-Bedienung, Abbruch, Wiederholung und Audio-Mixer nachgewiesen. Finale Modellmatrix und Windows-Paketfreigabe sind noch offen.** Eine pauschale Freigabe sämtlicher Modelle oder des externen Colab-Betriebs ist damit nicht ausgesprochen.

Ein separater Gate-Monitor kontrollierte Renderer- und Backend-Agenten, forderte konkrete Evidenz an, prüfte diese unabhängig und meldete fehlschlagende Tests sowie Stillstandsrisiken an den Koordinator. Vertragstests, echte Inferenz und Bedienung werden getrennt bewertet.

## Abnahmematrix

| Gate | Ergebnis | Evidenz und Grenze |
| --- | --- | --- |
| G1 Start ohne Black Screen | PASS Electron-Bedienlauf | Echter Import, SCNet/Schnell/Lokal und Inferenz, sichtbare Waveform, keine pageerrors/Crashes. Finales Paket separat offen. |
| G2 Vorbereitung und früher Cancel | PASS Regression | PCM-Yield/Bytegleichheit, Cancel vor Job-ID, Doppelstart/Start-Race, Preflight-Fehler/Timeout und Ergebnisschutz. WebAudio/IPC hierbei gemockt. |
| G3 Echte Separation | PASS SCNet/PREVIEW/CPU | Frische 12-s- und 2-s-Mischungen, echte Gewichte, vier unterschiedliche decodierbare WAVs, cacheHit=false, Originalhash unverändert. |
| G4 Fortschritt/Cancel/Retry | PASS Electron-Bedienlauf | 45% bei Abschnitt 2/4 sichtbar; Cancel-Klick 675 ms; Konfiguration wieder bereit; Neustart vollständig abgeschlossen. |
| G5 Fehler/Pause/Modellauswahl | Verträge PASS; reale Matrix offen | Worker-Fehlerweitergabe, Pause/Fortsetzen und CPU-Cancel geprüft. Andere Modellarchitekturen brauchen eigene Live-Ergebnisse. |
| G6 Wiedergabe und Ergebnisse | PASS Electron-Bedienlauf | Vier echte AudioBuffers, laufender AudioContext, Solo/Mute/Volume, Acapella/Instrumental/Reset und Vocals-Clip in Palette. Kein separater Dateiexport-Nachweis. |
| G7 Tests/Typecheck/Build | PASS über Erstlauf und Wiederholungen | Alle 37 ursprünglichen Release-Dateien erfolgreich geprüft; ein Fixture-Fehler repariert und unabhängig wiederholt. Neue Tests zusätzlich grün. Koordinator meldet finalen Typecheck/Build Exit 0. |
| G8 Finale Windows-Übergabe | OFFEN | Paket nach sämtlichen Quellkorrekturen bauen, tatsächlichen ASAR-/ORT-/Worker-Pfad prüfen, Übergabepfad und Hash dokumentieren. |

## Echte Electron-Bedienung und Wiedergabe

Der Koordinator importierte die 12-Sekunden-Mischung über die Dateiauswahl, wählte SCNet, Schnell und Lokal und startete echte Inferenz. Der Gate-Monitor sichtete die Screenshots selbst:

- [01-processing.png](../artifacts/stem-desktop-20261030/01-processing.png): Waveform, SCNet-Abschnitt 2/4, 45% und Abbrechen sichtbar.
- [02-cancelled.png](../artifacts/stem-desktop-20261030/02-cancelled.png): Konfiguration erneut bereit und korrekter Hinweis, dass keine Stems übernommen wurden.
- [03-stems-mixer.png](../artifacts/stem-desktop-20261030/03-stems-mixer.png): vier Stem-Kanäle, laufende Audiopegel und mixture [VOCALS] in der Palette.

[Desktop-Evidenz](../artifacts/stem-desktop-20261030/evidence.json): erfolgreicher Neustart, vier Kanäle, Acapella, Instrumental, Reset, Solo, Mute, Volume 0,05 und extrahierter Vocals-Clip. Über beide Läufe: Main 2538 Ticks/maximal 277 ms Verzögerung, Renderer 2690 Ticks/maximal 639 ms, 0 pageerrors und 0 Crashes. Bei 1424×921 bleibt die Seite ohne Overflow; Stem-Center y=135 bis 343,25.

[Playback-Evidenz](../artifacts/stem-desktop-20261030/playback-evidence.json): AudioContext running, vier nicht stumme Stereo-AudioBuffers mit je 576000 Frames bei 48 kHz (12 s), reale Acapella-Gains [1,0,0,0] und Instrumental-Gains [0,1,1,1]. Dies belegt Dekodierung und tatsächliches Audio-Routing, ersetzt aber keinen subjektiven Hörtest.

Der erste Bedienlauf zeigt noch eine irreführende Google-Drive-Warnung trotz lokaler Auswahl. Die Renderer-Korrektur begrenzt diese Warnung auf das Remote-Ziel und wurde gezielt geprüft. Finaler Paketnachweis dieser Korrektur bleibt offen.

Reproduzierbar mit [verify-stems-desktop.cjs](../scripts/verify-stems-desktop.cjs), laut Koordinator Syntaxprüfung Exit 0. Der Harness bedient echte UI ohne IPC-/Modell-/Inferenz-Mocks. Eine zusätzliche Electron-Worker-Probe importierte erfolgreich ein Modul aus einer ASAR-Datei (value 42); das beweist nur die Importmechanik, nicht die vollständige gepackte Engine.

## Echte Modell-Inferenz

[verify-stems-workflow.ts](../scripts/verify-stems-workflow.ts) nutzte gemischtes Audio aus dem AppData-Staging und die Produktions-Bridge ohne injiziertes Backend. 12-s-Auftrag job_mvv0up0d_b4d64391, SCNet/PREVIEW/CPU, cacheHit=false, COMPLETED. Modellmetadaten nennen SHA-256 98228931494151762a1c4ab1ec7899a894b1f81fd4a509921a9d2f9bacc50845.

Der Gate-Monitor las die vier Originalausgaben separat: RIFF, Stereo, 44,1 kHz, je 529200 Frames und 4233644 Bytes, vier unterschiedliche SHA-256-Werte und unveränderter Staging-Eingang: PASS. Die Daten sind endlich und nicht stumm. 146608 ms Gesamtzeit, davon 137536 ms Inferenz. Das ist ein Funktionsnachweis und kein Echtzeitversprechen.

| Stem | RMS | SHA-256 |
| --- | --- | --- |
| drums | 0,193069 | 805e174d1715a53a1edbbc9c79691a10f0ba8ac51a7d44203ac988f7c792cc6b |
| bass | 0,054378 | 4eadbd9e7c7056388309bfe67cef213c43ac1a850908778a99aae639c9a856e2 |
| other | 0,110528 | 73991fff32ec2fe39cfc494f024bf64c611abca194a116cfcd13a603b9314f03 |
| vocals | 0,007059 | 4270a3e8fdaa907d3774c7f824b83b8a98b60fb6f1a9abf25a6d2b0034f7ee2d |

Nachweise: [12-s-Evidenz](../artifacts/stem-workflow-20261030/evidence.json), [Events](../artifacts/stem-workflow-20261030/events.json), [Job](../artifacts/stem-workflow-20261030/Separation/real-mix-acceptance/job.json), [Mischung](../artifacts/stem-workflow-20261030/mixture.wav), [drums](../artifacts/stem-workflow-20261030/drums.wav), [bass](../artifacts/stem-workflow-20261030/bass.wav), [other](../artifacts/stem-workflow-20261030/other.wav), [vocals](../artifacts/stem-workflow-20261030/vocals.wav).

Der zusätzliche finale Worker-Lauf verarbeitete 2 s echten Mix zu vier frischen Stereo-Stems mit je 88200 Frames bei 44,1 kHz, validationPass=true, cacheHit=false und unverändertem Originalhash. [2-s-Evidenz](../artifacts/stem-workflow-final-20261030/evidence.json), [Host-Metrik](../artifacts/stem-workflow-final-20261030/host-metrics.json): 39,327 s gesamt, 298 Host-Ticks, maximal 1496 ms Verzögerung einschließlich Vor-/Nachbereitung und Prüfhost-Last. Der Host läuft während echter Inferenz weiter; vollständig ruckelfreie Bedienung folgt daraus nicht.

## Regressionen und Ergebnisdateien

- [37 Release-Ergebniszeilen](STEM_RELEASE_ERSTLAUF_RESULTATE_2026-10-30.log): Erstlauf 36/37 bestanden, 0 Skips, 1 Fehler, 1066,2 s seriell. Einziger Fehler war das Startup-Zeitbudget der Node-Testfixture in runtime-probe. [Originale Fehlerdatei](STEM_RELEASE_ERSTLAUF_FEHLER_2026-10-30.txt).
- Fixture-Startup jetzt explizit 60 s; dedizierter 1200-ms-Timeout-Test bleibt erhalten. Vollständige Runtime-Probe danach unabhängig PASS. Somit alle 37 ursprünglichen Dateien über Erstlauf und Wiederholung erfolgreich geprüft. Working-copy-Speed PASS nach 144,6 s mit 30-/60-s-Resample-Referenzen, Fortschritt und Abbruch.
- [Aktueller gezielter Rohlog](STEM_GEZIELTE_TESTS_2026-10-30.log): 5/5 bestanden, 0 Skips, 21,0 s — Worker inklusive Pause/Fortsetzen/CPU-Cancel/Fehler, Center, Renderer-Responsiveness, Runtime-Probe, Statuslatenz. Lauf nach dem zusätzlichen Produktionsfix des strengen Torch-Importbudgets auf 60 s; billiger Statuspfad bleibt find_spec, gecacht und asynchron.
- [Ergänzende Ergebniszeilen](STEM_ERGAENZENDE_TESTS_2026-10-30.log): 4/4 bestanden, 0 vom Runner erkannte Skips, 329,8 s — App-SSR, NegativeUnavailable, PreflightDiagnostics, FallbackMatrix.
- Laut Koordinator finaler Typecheck, Produktionsbuild, Renderer-Vite-Build und git diff --check Exit 0. Generierte Verzeichnisse sind aus dem TypeScript-Quellscope ausgeschlossen; echte Quelldateien bleiben enthalten.

Der zentrale Runner speichert erfolgreichen internen Test-stdout nicht. Erstlauf und Ergänzungen enthalten deshalb transparent aus Tool-Ausgaben gesicherte Ergebniszeilen. Der aktuelle gezielte Rohlog wurde direkt mit Tee-Object geschrieben.

## Ursachen, Reparatur und Review

Renderer: garantierter Zustandsreset nach Preflight-Fehler/Timeout, Doppelstart-Sperre, portionierte PCM-Kodierung, Cancel vor Job-ID und während Start/Import, Schutz vor verspätetem Ergebnis nach Trackwechsel/Bearbeitung, geringerer Decode-Speicherbedarf, lokale Statusanzeige von fremden Remote-Jobs getrennt.

Backend: SCNet-STFT/iSTFT liefen synchron als CPU-JavaScript im Main-Host. Der Gate-Monitor beobachtete beim installierten Altprozess Main Responding=False, CPU 1271→1341 s und etwa 2,55 GB Working Set, während der Renderer antwortete. Die CPU-Arbeit liegt jetzt in einem Worker mit übertragbaren Puffern, Fortschritt, Pause an Segmentgrenzen und Terminierung bei Cancel. Codebefund und neue Messungen stützen den Zusammenhang; ein fehlender Logeintrag allein war kein Ursachenbeweis.

Der abschließende Worker-Code-Review fand keinen harten Lifecyclefehler: idempotentes finish, Timer-Cleanup, Result/Error/Exit-Pfade, Pause nur im Worker und Cancel auch aus Atomics.wait. Einschränkung: finish wartet terminate() nicht ab; Job-Cancel bestätigt nicht garantiert das vollständige Ende jeder bereits laufenden nativen ORT-Operation. Keine absolute native Cancel-Latenz wird behauptet.

Der Gate-Monitor untersuchte den bestehenden Altprozess lesend. Der Koordinator änderte zur Entlastung temporär Priorität/Affinität und kündigte die Rücksetzung an. Der Altprozess wurde wegen möglicher ungespeicherter Arbeit nicht beendet.

## Historische Fehlversuche und Grenzen

- Der 12-s-Harness verglich zunächst falsch Eingangsframes bei 48 kHz mit Ausgangsframes bei 44,1 kHz. Die Engine war fertig; Harness korrigiert, fertige Dateien durch separaten Prüfer und Gate-Monitor verifiziert. Deshalb fehlt die Host-Tick-Metrik dieses ersten Laufs; der finale 2-s-Lauf und echte Desktop-Lauf liefern sie.
- Kalter Torch-Import wurde real mit 24,23 s gemessen, über dem alten strengen 20-s-Budget. Backend erhöhte das asynchrone gecachte Jobstart-Budget auf 60 s. Abschließende Live-Modellmatrix steht noch aus.
- SSR führt keine React-Effekte aus. Der ONNX-In-Memory-Test nutzt echte Runtime, aber einen Testgraphen mit festen Gain-Faktoren. Job-/Isolation-/Technical-Gates nutzen Pipeline-Doubles. Diese Tests belegen keine musikalische Separation.
- NegativeUnavailable fängt im Registry-Untertest auch AssertionErrors ab und druckt intern SKIP; fail-on-skip erkennt dies nicht. Dieser Teil zählt nicht als Registry-Verfügbarkeitsbeleg.
- Hash-Unterschiede, endliche Daten und Pegel belegen technische Integrität. SI-SDR-/Bleed-/Qualitätsfreigabe verlangt getrennte Referenzstems und wird hier nicht behauptet.
- Echter Remote-Colab-Betrieb und andere Modellarchitekturen brauchen eigene Live-Ergebnisse. Vorhandene Gewichte oder grüne Mocks gelten dafür nicht als PASS.

## Noch offene Abschlussnachweise

1. Abschließende reale Modellmatrix nach Importfix bewerten, einschließlich Timeouts, Fehlern und auswählbarer Verfügbarkeit.
2. Finales Paket nach allen Quellkorrekturen bauen und echte Electron-/ASAR-/native-ORT-/SCNet-Inferenz darin prüfen.
3. Übergabepfad, Version, SHA-256 und Paketprüfbericht ergänzen; temporäre Prüfhost-Priorität/Affinität zurücksetzen.
