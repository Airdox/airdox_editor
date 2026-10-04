# Einordnung des Nutzerlogs: Fern-Job 915db325…

Die protokollierten Zeitstempel enthalten mehrere Sitzungen ohne Datum. Daraus lässt sich **keine** durchgehende Zeitachse über alle Blöcke ableiten.

- Frühere Fehler `INFERENCE_FAILED` (DirectML-Treiber), `STEM_CONFIG_INVALID` (lokales BS-RoFormer-Backend) und `ANLZ_NOT_FOUND`/`ANLZ_SOURCE_MISMATCH` (Rekordbox-Dateiquellen) sind **andere Pfade**. Später ist für Track 87868672 `REKORDBOX_ANLZ geladen` protokolliert; die lokalen ONNX-Jobs wurden teils erfolgreich abgeschlossen. Das beweist nicht, dass der Fernworker läuft.
- `00:17:08` ist lediglich „Fern-Job … angelegt“. Im Ausschnitt fehlen Worker-Claim, Worker-Heartbeat, Modelllauf, Ergebnisse und Import. Die App hat damit **keinen Nachweis**, dass Drive für Desktop die Datei hochgeladen oder Colab sie erhalten hat. Drive-Desktop-Installation allein startet keinen Colab-Worker: Notebook öffnen, `JOB_ORDNER` auf denselben My-Drive-Ordner setzen, Drive-Mount freigeben und Worker-Zelle laufen lassen.
- `00:45:43` bis `00:45:48`: wiederholte Abbruchanforderungen in < 5 Sekunden – das Muster „Knopf gedrückt, keine Reaktion, also noch einmal“ in 13 Klicks. Das Log belegt Anforderungen, aber keine bestätigte Statusänderung; `00:46:52` meldet dieselbe Job-ID erneut. Aus den Zeilen allein war nicht beweisbar, ob der Abbruch serverseitig ankam. **Inzwischen ist er es:** Der Colab-Worker (`colab/remote_worker.py`) und der Node-Worker (`scripts/stem-remote-worker.ts`) prüfen `cancel.flag` jetzt alle 5 Sekunden **während** der Rechnung und beenden den rechnerischen Adapter (SIGTERM, nach 10 s SIGKILL) – der Abbruch ist nicht mehr eine Bitte für den nächsten Job. Der Verbrauch der Fahne verhindert außerdem, dass ein unter derselben Job-ID neu ausgeschriebener Lauf (§21 B) sofort wieder erstickt wird.

## Sichere Schritte auf dem betroffenen Rechner

1. In der App Statusfenster für den Job öffnen, „Jetzt prüfen“ betätigen. Ist der Status **CANCELLED**, keinen alten Job wiederverwenden; bei neuem Versuch neue Job-ID erwarten. Ist er **RUNNING** ohne Worker-ID, das Notebook und dessen `JOB_ORDNER` prüfen.
2. Im Drive-Desktop-Sync-Ordner `airdox-stem-jobs/jobs/915db325-a297-40a8-94e8-fa7137f14f94/` prüfen: `manifest.json` und `input/*.wav` vollständig vorhanden? `claim.json` oder `cancel.flag` vorhanden? In der Google-Drive-Webansicht denselben Ordner prüfen, um echte Synchronisierung zu bestätigen. Dateien nicht manuell überschreiben.
3. Im Colab-Notebook `drive.mount` und Worker-Ausgabe prüfen; **nicht** Tokens oder private Audiodateien in öffentliche Logs/Issues kopieren. Der Worker löscht `cancel.flag` nach der Erfüllung selbst – an der Fahne ist also nichts von Hand zu drehen. Kein Abbruch eingetreten, obwohl die Fahne im Ordner liegt? Dann ist der Worker-Zyklus stehengeblieben (`--poll`, Laufzeit des Notebooks prüfen).
4. Für eine genaue Ursachenanalyse nur redigierte Angaben weitergeben: Status, Phase, Job-ID, Zeit des letzten Worker-Lebenszeichens, Existenz der vier Dateien (keine Inhalte), und anonymisierte Colab-Fehlermeldung. Ohne diese Informationen ist „Reparatur erfolgreich“ nicht belegbar.

## Umsetzung nach dieser Einordnung (2026-10-04)

| Befund aus dem Log | Verhalten jetzt | Beleg |
| --- | --- | --- |
| Abbruch wurde nur vor dem Start eines Jobs geprüft | beide Worker prüfen `cancel.flag` während der Rechnung und beenden die Inferenz | `python3 colab/remote_worker.py --self-test` (Schritte 5–8), `npm run test:stems:remote` #11 |
| Abbruch galt als erledigt, obwohl die Ablage (Drive-Sync) nicht erreichbar war | `cancel()` meldet `deferred` + Grund, Job bleibt in Verfolgung, Fahne wird bei jedem Poll nachgeliefert | `tests/stem-remote-job-service.test.ts` #10 |
| Klick ohne sichtbare Reaktion | Stem-Leiste zeigt „Abbruch wird gemeldet…“, blockiert Doppelklicks und meldet Misserfolg mit Grund (Statusfenster öffnet sich) | `src/components/DeckStemsControl.tsx`, `cancelRemoteFlowJob` in `src/App.tsx` |
| Liegen gelassene `cancel.flag` erstickt künftige Läufe | Fahne wird nach Erfüllung verbraucht; `republish()` räumt alte Marker ab | Test #11 |

Wichtig für die Einordnung künftiger Logs: Das gepostete Protokoll enthält Meldungen
(`STEM_CONFIG_INVALID: … ([object Object])`, „Abbruch … angefordert“), die es in dieser
Form im aktuellen Stand nicht mehr gibt – `src/stems/errors.ts` rendert die Ursache
aus, der Abbruch protokolliert nur noch bestätigte (`accepted`) und abgelehnte Fälle
getrennt. **Vor der nächsten Diagnose also prüfen, welches Build läuft**
(Einstellungen → Systemprotokoll, bzw. neu bauen: `npm run build && npm run desktop`).

## Nachtrag 2026-10-04: „Wartet auf den externen Rechner“ – zwei echte Ursachen gefunden

Der Editor zeigt diese Zeile, solange **kein** Rechner den Job beansprucht hat
(`jobs/<jobId>/claim.json` fehlt). Die Colab-Zelle 5 startet dafür den Worker –
und tat es in zwei Fällen nicht wirksam. Beide Fehler sind behoben und durch
`tests/stem-remote-worker-cli.test.mjs` sowie den Selbsttest des Workers
(`npm run stems:remote:selftest`) abgesichert:

1. **`--model` wurde stillschweigend zu `--model-dir`.** Das Notebook hängt
   `--model <id>` an, sobald ein offener Job in der Ablage liegt. Der
   Python-Worker kannte die Option nicht; `argparse` akzeptierte sie als
   eindeutige **Abkürzung** von `--model-dir` und überschrieb damit den
   Modellordner mit der Modell-Id. Folge: der Job wurde beansprucht und
   scheiterte am fehlenden Checkpoint – bzw. wirkte im Statusbild wie „nichts
   passiert“, weil der Editor nur den Steckbrief kennt. Jetzt ist die
   Kommandozeile streng (`allow_abbrev=False`), `--model` ist ein dokumentierter
   Filter (verbindlich bleibt das Manifest), und unbekannte Optionen brechen ab.
2. **`--profile HIGH_QUALITY` beendete den ganzen Lauf mit Exit 2**
   („unrecognized arguments“). Die Zelle war damit nach Sekunden vorbei; kein
   Worker beanspruchte je einen Job, der Editor wartete bis zum Timeout
   (`AIRODOX_STEM_REMOTE_TIMEOUT_MS`, Default 6 h) und meldete erst dann
   `REMOTE_TIMEOUT`. `--profile` existiert jetzt (als Hinweis – gerechnet wird
   nach dem Manifest), und Zelle 5 meldet einen sofort beendeten Worker
   ausdrücklich samt Exit-Code.

**Sofortdiagnose ohne Log-Raten** (verändert nichts, auch auf dem Windows-PC):

```bash
python3 colab/remote_worker.py --root "<Jobablage>" --check-store
```

Ausgabe je Job: Status, Phase, Arbeitskopie, Lease mit Lebenszeichen-Alter,
Abbruchfahne – danach ein Urteil („offene(r) Job(s) ohne Lease“, „Kein einziger
Job in der Ablage“, „passen nicht zum gestarteten Modell“, „frisch
beansprucht“, „abgelaufene Lease“). Das Notebook führt denselben Befehl als
Vorflug aus, bevor es den Worker startet, und wiederholt ihn danach.

Der Worker selbst ist jetzt auch **im Warten sichtbar**: er meldet jede
`--idle-log-seconds` (Default 60) „Warte auf Jobs – N in der Ablage“, und ein
Wechsel der Jobliste wird sofort protokolliert. Eine weiterlaufende Colab-Zelle
ist damit kein Rätsel mehr, sondern der erwartete Zustand.

Drei Punkte kamen aus derselben Untersuchung auf der Editor-Seite hinzu und
ergänzen die Diagnose:

3. **Kein Lebenszeichen vor dem ersten Job.** Der Worker schreibt jetzt schon
   beim Start `worker.status.json` (Id, Host, Gerät, GPU, Phase, Zähler) und
   aktualisiert sie in jedem Durchlauf; dazu ein zentrales `worker.log` in der
   Ablage. Das Statusfenster des Editors zeigt daraus „Colab-Worker online“
   bzw. „Warte auf Lebenszeichen“ – die Frage „sieht Colab meinen Drive-Ordner
   überhaupt?“ ist damit beantwortet, **bevor** der erste Job beansprucht wird.
4. **Manifest-Race beim Beanspruchen.** Der Worker trug den Worker-Eintrag erst
   nach dem Kopieren der Arbeitskopie (teils 100 MB+) ins Manifest ein; die
   Anzeige blieb so minutenlang auf Stufe 2 („Auf Worker warten“). Jetzt steht
   der Eintrag mit dem Claim sofort im Manifest (Phase „Job beansprucht –
   Arbeitskopie wird geladen“), und der Editor pollt 2 s nach dem Start
   zusätzlich sofort statt erst nach dem vollen Intervall.
5. **Fehler nur in der Colab-Konsole.** Startfehler (fehlender Adapter, falscher
   Modellordner) landen jetzt in `worker.log` **und** in der Ausgabe der Zelle;
   Zelle 5 druckt vorher und nachher `--check-store` und meldet einen sofort
   beendeten Lauf samt Exit-Code ausdrücklich.
