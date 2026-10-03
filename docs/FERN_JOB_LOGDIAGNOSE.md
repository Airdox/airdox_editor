# Einordnung des Nutzerlogs: Fern-Job 915db325…

Die protokollierten Zeitstempel enthalten mehrere Sitzungen ohne Datum. Daraus lässt sich **keine** durchgehende Zeitachse über alle Blöcke ableiten.

- Frühere Fehler `INFERENCE_FAILED` (DirectML-Treiber), `STEM_CONFIG_INVALID` (lokales BS-RoFormer-Backend) und `ANLZ_NOT_FOUND`/`ANLZ_SOURCE_MISMATCH` (Rekordbox-Dateiquellen) sind **andere Pfade**. Später ist für Track 87868672 `REKORDBOX_ANLZ geladen` protokolliert; die lokalen ONNX-Jobs wurden teils erfolgreich abgeschlossen. Das beweist nicht, dass der Fernworker läuft.
- `00:17:08` ist lediglich „Fern-Job … angelegt“. Im Ausschnitt fehlen Worker-Claim, Worker-Heartbeat, Modelllauf, Ergebnisse und Import. Die App hat damit **keinen Nachweis**, dass Drive für Desktop die Datei hochgeladen oder Colab sie erhalten hat. Drive-Desktop-Installation allein startet keinen Colab-Worker: Notebook öffnen, `JOB_ORDNER` auf denselben My-Drive-Ordner setzen, Drive-Mount freigeben und Worker-Zelle laufen lassen.
- `00:45:43` bis `00:45:48`: wiederholte Abbruchanforderungen in < 5 Sekunden. Das Log belegt Anforderungen, aber keine bestätigte Statusänderung. `00:46:52` meldet dieselbe Job-ID erneut: das kann beabsichtigte Idempotenz eines noch aktiven Jobs sein; aus diesen Zeilen allein lässt sich nicht beweisen, ob ein Abbruch serverseitig erfolgreich war. In der UI wird ein bestätigter Abbruch nun nur nach `accepted` protokolliert und Doppelklicks werden blockiert. Abgebrochene Jobs bleiben auch bei veraltetem Drive-Manifest terminal.

## Sichere Schritte auf dem betroffenen Rechner

1. In der App Statusfenster für den Job öffnen, „Jetzt prüfen“ betätigen. Ist der Status **CANCELLED**, keinen alten Job wiederverwenden; bei neuem Versuch neue Job-ID erwarten. Ist er **RUNNING** ohne Worker-ID, das Notebook und dessen `JOB_ORDNER` prüfen.
2. Im Drive-Desktop-Sync-Ordner `airdox-stem-jobs/jobs/915db325-a297-40a8-94e8-fa7137f14f94/` prüfen: `manifest.json` und `input/*.wav` vollständig vorhanden? `claim.json` oder `cancel.flag` vorhanden? In der Google-Drive-Webansicht denselben Ordner prüfen, um echte Synchronisierung zu bestätigen. Dateien nicht manuell überschreiben.
3. Im Colab-Notebook `drive.mount` und Worker-Ausgabe prüfen; **nicht** Tokens oder private Audiodateien in öffentliche Logs/Issues kopieren. Wenn ein Abbruch bestätigt ist, Job nicht durch Löschen der Flagge erneut starten. Einen neuen Job erzeugen.
4. Für eine genaue Ursachenanalyse nur redigierte Angaben weitergeben: Status, Phase, Job-ID, Zeit des letzten Worker-Lebenszeichens, Existenz der vier Dateien (keine Inhalte), und anonymisierte Colab-Fehlermeldung. Ohne diese Informationen ist „Reparatur erfolgreich“ nicht belegbar.
