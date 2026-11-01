# Set-Aufnahmen

Mit F9 oder der Record-Aktion den Recorder öffnen. Für Rekordbox **System Loopback** wählen. Der Desktop fragt vor dem Systemmitschnitt ausdrücklich nach. Erfasst wird der Windows-Systemmix; auch Benachrichtigungen und andere Anwendungen können enthalten sein. ASIO/exklusive DJ-Ausgänge sind darin häufig nicht enthalten. Dafür einen vom Treiber angebotenen Loopback-Eingang oder einen physisch angeschlossenen Line-Eingang wählen. Unter **Audioeingänge erkennen** das gewünschte Gerät auswählen. Ein virtuelles Routing oder ein Kabel wird durch AirDox nicht ersetzt.

Nach Start erscheint ein kleines Fenster rechts unten. Laufzeit, RMS-Pegel, Sample-Peak in dBFS, Stille/Übersteuerung und die laufende Sicherungsdatei bleiben sichtbar. Der Editor bleibt bedienbar. Stop beendet und speichert die Aufnahme automatisch. Danach lässt sie sich über **Aufnahme öffnen / abspielen** mit dem Systemplayer öffnen. Der Vorlauf lässt sich abbrechen. Bei Systemaudio beginnt die Aufnahme nach der Freigabe ohne zusätzlichen Vorlauf.

## Speicherung und Formate

Die Desktop-App schreibt jede Sekunde in eine neue Datei unter `Musik/AirDox Recordings` und synchronisiert jeden geschriebenen Block. UUID und Zeitstempel verhindern das Überschreiben bestehender Aufnahmen. Der frei wählbare Dateiname wird bereinigt. Die Schreibwarteschlange ist auf 32 MiB begrenzt; ein zu langsamer Datenträger beendet den Mitschnitt sichtbar. Ein Renderer-Abbruch schließt die vorhandene Sicherung. Während einer Aufnahme wird der automatische Anwendungs-Ruhezustand verhindert.

**WebM/Opus** benötigt den integrierten Chromium-Encoder, etwa 144 MB/Stunde bei angeforderten 320 kbit/s. Die reale Bitrate kann abweichen. Es findet keine vollständige RAM-Pufferung oder nachträgliche Lautheitsanpassung statt. Samplerate und Kanäle kommen aus dem Capture-Stream.

**WAV, MP3 und FLAC** sind in der Desktop-App zusätzlich verfügbar, wenn `ffmpeg` im Anwendungssuchpfad mit den benötigten Encodern vorhanden ist. Nach Stop wird die Opus-Sicherung dateibasiert konvertiert. Die Sicherung bleibt auch bei Konvertierungsfehlern erhalten; die Fehlermeldung nennt ihren Pfad. WAV und FLAC sind deshalb keine verlustfreien Mitschnitte des ursprünglichen PCM-Signals: die vorherige Opus-Kompression bleibt bestehen. WAV wird mit 24 Bit und RF64-Unterstützung geschrieben; MP3 mit 320 kbit/s. Der bisherige Browser-WAV-Export verwendet weiterhin den Arbeitsspeicher und eignet sich nicht für lange Sets.

Der Eingangs-Limiter ist ein Dynamikkompressor, kein garantierter True-Peak-Limiter. Eine LUFS-Normalisierung wird im Desktop-Streaming nicht angewendet. Ein Netz-/Systemausfall kann den letzten noch nicht geschriebenen Block verlieren; eine Garantie gegen Hardwareausfälle besteht nicht.

## Reproduzierbare Prüfungen

- `node --experimental-test-coverage --test tests/recorder-stream.test.cjs`: persistente geordnete Blöcke, ungültige Aufrufe, Renderer-Verlust, synthetischer 440-Hz-Ton, alle verfügbaren Container und FFmpeg-Dekodierung, Fehler bei ungültigem Audio.
- Electron mit `scripts/recorder-runtime-smoke.cjs` starten: tatsächlicher Chromium-MediaRecorder, Preload, IPC, Dateischreiben, Stop und Dekodierung; unter Windows zusätzlich System-Loopback. Das Skript verwendet ausschließlich temporäre Testdateien.
- `npm run lint`, `npm run build`, `npm test`: Projektchecks.

Diese Tests ersetzen keinen mehrstündigen Mitschnitt mit dem tatsächlich verwendeten Rekordbox-Ausgang und Audiointerface. Vor einem wichtigen Set auf Signalpegel achten und eine kurze Probeaufnahme anhören.
