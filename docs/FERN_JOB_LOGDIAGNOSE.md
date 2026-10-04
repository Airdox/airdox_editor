# Einordnung des Nutzerlogs: Fern-Job 915db325…

Die protokollierten Zeitstempel enthalten mehrere Sitzungen ohne Datum. Daraus lässt sich **keine** durchgehende Zeitachse über alle Blöcke ableiten.

- Frühere Fehler `INFERENCE_FAILED` (DirectML-Treiber), `STEM_CONFIG_INVALID` (lokales BS-RoFormer-Backend) und `ANLZ_NOT_FOUND`/`ANLZ_SOURCE_MISMATCH` (Rekordbox-Dateiquellen) sind **andere Pfade**. Später ist für Track 87868672 `REKORDBOX_ANLZ geladen` protokolliert; die lokalen ONNX-Jobs wurden teils erfolgreich abgeschlossen. Das beweist nicht, dass der Fernworker läuft.
- `00:17:08` ist lediglich „Fern-Job … angelegt“. Im Ausschnitt fehlen Worker-Claim, Worker-Heartbeat, Modelllauf, Ergebnisse und Import. Die App hat damit **keinen Nachweis**, dass Drive für Desktop die Datei hochgeladen oder Colab sie erhalten hat. Drive-Desktop-Installation allein startet keinen Colab-Worker: Notebook öffnen, `JOB_ORDNER` auf denselben My-Drive-Ordner setzen, Drive-Mount freigeben und Worker-Zelle laufen lassen.
- `00:45:43` bis `00:45:48`: wiederholte Abbruchanforderungen in < 5 Sekunden – das Muster „Knopf gedrückt, keine Reaktion, also noch einmal“ in 13 Klicks. Das Log belegt Anforderungen, aber keine bestätigte Statusänderung; `00:46:52` meldet dieselbe Job-ID erneut. Beide Worker prüfen `cancel.flag` alle 5 Sekunden **während** der Rechnung und beenden den Adapter, sobald die Fahne bei ihnen angekommen ist (SIGTERM, nach 10 s SIGKILL). **Wichtig:** Im `folder`-Transport bestätigt „Abbruchflag geschrieben“ nur den lokalen Schreibvorgang in den Drive-Sync-Ordner – weder Google-Cloud-Sync noch Colab-Empfang. Erst ein Worker-Ereignis `worker.cancelled` bestätigt, dass Colab den Abbruch verarbeitet hat. Die Oberfläche unterscheidet diese Fälle jetzt und stellt einen Abbruch vor einem Worker-Claim nicht mehr als technischen Fehler dar. Der Verbrauch der Fahne verhindert außerdem, dass ein unter derselben Job-ID neu ausgeschriebener Lauf (§21 B) sofort wieder erstickt wird.

## Sichere Schritte auf dem betroffenen Rechner

1. In der App das Live-Datenfluss-Fenster für den Job öffnen, „Jetzt prüfen“ betätigen. Ist der Status **CANCELLED**, keinen alten Job wiederverwenden; bei neuem Versuch neue Job-ID erwarten. Ist er **RUNNING** ohne Worker-ID, das Notebook und dessen `JOB_ORDNER` prüfen.
2. Im Drive-Desktop-Sync-Ordner `airdox-stem-jobs/jobs/915db325-a297-40a8-94e8-fa7137f14f94/` prüfen: `manifest.json` und `input/*.wav` vollständig vorhanden? `claim.json` oder `cancel.flag` vorhanden? In der Google-Drive-Webansicht denselben Ordner prüfen, um echte Synchronisierung zu bestätigen. Dateien nicht manuell überschreiben.
3. Im Colab-Notebook `drive.mount` und Worker-Ausgabe prüfen; **nicht** Tokens oder private Audiodateien in öffentliche Logs/Issues kopieren. Der Worker löscht `cancel.flag` nach der Erfüllung selbst – an der Fahne ist also nichts von Hand zu drehen. Kein Abbruch eingetreten, obwohl die Fahne im Ordner liegt? Dann ist der Worker-Zyklus stehengeblieben (`--poll`, Laufzeit des Notebooks prüfen).
4. Für eine genaue Ursachenanalyse nur redigierte Angaben weitergeben: Status, Phase, Job-ID, Zeit des letzten Worker-Lebenszeichens, Existenz der vier Dateien (keine Inhalte), und anonymisierte Colab-Fehlermeldung. Ohne diese Informationen ist „Reparatur erfolgreich“ nicht belegbar.

## Umsetzung nach dieser Einordnung (2026-10-04)

| Befund aus dem Log | Verhalten jetzt | Beleg |
| --- | --- | --- |
| Abbruch wurde nur vor dem Start eines Jobs geprüft | beide Worker prüfen `cancel.flag` während der Rechnung und beenden die Inferenz | `python3 colab/remote_worker.py --self-test` (Schritte 5–8), `npm run test:stems:remote` #11 |
| Abbruch galt als erledigt, obwohl die Ablage (Drive-Sync) nicht erreichbar war | `cancel()` meldet `deferred` + Grund, Job bleibt in Verfolgung, Fahne wird bei jedem Poll nachgeliefert | `tests/stem-remote-job-service.test.ts` #10 |
| Klick ohne sichtbare Reaktion | Die Fortschrittszeile im Stem-Center zeigt „Abbruch läuft…“, blockiert Doppelklicks und meldet Misserfolg mit Grund (Live-Datenfluss-Fenster öffnet sich); während der Vorbereitung wird der Abbruch vorgemerkt | `src/components/zones/StemCenter.tsx`, `src/components/Modals/RemoteFlowModal.tsx`, `cancelRemoteFlowJob` in `src/App.tsx` |
| Liegen gelassene `cancel.flag` erstickt künftige Läufe | Fahne wird nach Erfüllung verbraucht; `republish()` räumt alte Marker ab | Test #11 |

Wichtig für die Einordnung künftiger Logs: Das gepostete Protokoll enthält Meldungen
(`STEM_CONFIG_INVALID: … ([object Object])`, „Abbruch … angefordert“), die es in dieser
Form im aktuellen Stand nicht mehr gibt – `src/stems/errors.ts` rendert die Ursache
aus, der Abbruch protokolliert `cancel_flag=written` mit ausstehender Worker-Bestätigung
oder den Schreibfehler getrennt. Ein Abbruch vor dem Claim wird im Live-Monitor als
„abgebrochen“ statt „Problem“ markiert. **Vor der nächsten Diagnose also prüfen, welches Build läuft**
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
   Ablage. Das Live-Datenfluss-Fenster des Editors zeigt daraus „Colab-Worker online“
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

## Ergänzung: Popup wartet auf den externen Rechner (2026-10-04)

Bei einem Status, der dauerhaft „Wartet auf den externen Rechner“ anzeigt, sind
zwei Ursachen zu unterscheiden:

1. **Editor-Diagnosefehler (behoben):** Die bisherige Warteuhr konnte durch
   `updatedAt`-Schreibvorgänge bei jedem Editor-Poll zurückgesetzt werden. Ohne
   Worker-Claim erschien dadurch keine Stallwarnung. Die Uhr nutzt jetzt den
   stabilen Phasenzeitpunkt `phaseUpdatedAt`; ein Test mit kontrollierter Zeit
   beweist: bei 119 Sekunden noch keine Warnung, bei 121 Sekunden Warnung trotz
   Polls. Der aktive Job wird dabei nicht fälschlich als fehlgeschlagen markiert.
2. **Worker nicht aktiv/Datei nicht synchronisiert:** Ein lokaler Editor kann
   Colab nicht starten. Die Colab-Worker-Zelle muss laufen, denselben
   `JOB_ORDNER`/Drive-Mount verwenden und im Leerlauf `worker.poll`-Ereignisse
   ausgeben. Das Popup weist nach 120 Sekunden auf Laufzeit, Mount und Sync hin.
3. **Worker hat übernommen:** `claim.json` enthält `workerId` und ein regelmäßig
   erneuertes `heartbeatAt`. Die Statusanzeige liest den Claim auch ohne
   Manifest-Änderung ein; dadurch bleiben Lease und tatsächliche Modellphase
   unterscheidbar.
4. **Schrittweise Ablaufspur:** Editor- und Worker-Ereignisse tragen dieselbe
   Job-ID und stehen im Popup sowie unter
   `jobs/<jobId>/logs/worker.jsonl` (strukturierte Spur) und `worker.log`
   (lesbares Protokoll). Beide Worker-Logs behalten höchstens 200 Zeilen; Fehler
   erscheinen zusätzlich in `error.json`. Pfade/Fehlermeldungen vor dem Teilen
   redigieren.

**Lokaler Beleg:** `npm run test:stems:remote` führt Regression, Ablaufspur,
Claim/Heartbeat und Worker-Selbsttest aus; `npm run stems:remote:evidence`
erzeugt die versionierte Prüfliste und Datei-Hashes. `npx tsc --noEmit` wurde
ebenfalls lokal erfolgreich ausgeführt. **Nicht belegt:** echte Synchronisierung
von Windows/Drive zu Google, Colab-GPU, trainierte Gewichte oder echter
Audio-Rückimport. Dafür siehe die externe Abnahme in
`docs/STEM_REMOTE_NACHWEISKETTE.md`.
