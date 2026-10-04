# High Quality extern – BS-RoFormer auf einem fremden Rechner

**Nachweis/Google-Einrichtung:** siehe [Schritt-für-Schritt-Nachweiskette](STEM_REMOTE_NACHWEISKETTE.md). Lokale Simulation ist keine Google- oder Qualitätsfreigabe.

Der HQ-Pfad (BS-RoFormer) rechnet lokal in 60–90 Minuten pro Track. Das bleibt
der Qualitätspfad, ist aber für den Alltag zu langsam. „High Quality extern“
gibt genau diesen Lauf an einen **externen Rechner** (Google Colab) ab, ohne
dass der Nutzer Colab bedienen muss: der Editor legt eine Arbeitskopie und einen
Job-Steckbrief in einer **Jobablage** ab, ein Worker beansprucht den Job,
rechnet und schreibt die Stems zurück. Der Editor prüft die Ergebnisse und
importiert sie über **denselben** Pfad wie einen lokalen Lauf.

```
Editor ──Arbeitskopie + manifest.json──▶ Ablage (Google Drive) ──▶ Worker (Colab)
Editor ◀─Stems + result.json + Status─── Ablage ◀─────────────── Worker
```

Google Drive ist dabei reiner **Transport** (§16) – keine Audiodatenbank, keine
zweite Quelle der Wahrheit. Der Editor bleibt die zentrale Anwendung.

## Live-Statusfenster

Beim Start eines externen Jobs öffnet sich ein kompaktes Statusfenster. Es zeigt
Arbeitskopie, Übergabe an den Drive-Sync-Ordner, Wartezeit auf den Worker,
Verarbeitung und geprüften Rückimport. Job-ID, Modell-Phase, vom Worker
**gemeldeter** Fortschritt, Rechenort und Transportzustand bleiben sichtbar.
Nach 120 Sekunden ohne Worker-Claim erscheint eine konkrete Diagnose; nach
90 Sekunden ohne Worker-Lebenszeichen ein eigener Heartbeat-Hinweis. Die Uhr
basiert auf `phaseUpdatedAt`/Worker-Heartbeat und wird von unveränderten
Editor-Polls nicht zurückgesetzt. Der Job bleibt dabei aktiv und wird nicht
vorschnell als fehlgeschlagen markiert. Ein aufklappbares Ablaufprotokoll zeigt
korrelierbare Schritte aus Editor und Worker. Das Fenster lässt sich schließen,
während der Job weiterläuft, und über die schwebende Status-Schaltfläche erneut
öffnen. „Jetzt prüfen“ löst einen neuen Poll aus; „Job abbrechen“ fordert den
Abbruch an.

**Wichtig:** Drive für Desktop bestätigt dem Editor keinen Cloud-Upload und
startet/aktiviert auch keine Colab-Laufzeit. Die Colab-Worker-Zelle muss in einer
aktiven Laufzeit laufen und denselben `JOB_ORDNER` verwenden. Fehlt nach zwei
Minuten ein Claim, prüft die Warnung genau diesen Punkt sowie Sync und Drive-Mount.

**Grenze:** „An Drive-Ordner übergeben“ bedeutet nur, dass die lokale
Arbeitskopie/Jobablage geschrieben wurde; die tatsächliche Cloud-Synchronisierung
wird nicht als bestätigt dargestellt. Das Fenster visualisiert den
Fern-Stem-Workflow, nicht eine allgemeine Dateireparatur.

## 1. Was der Nutzer sieht

In der Deck-Stem-Leiste steht nur noch:

| Element | Bedeutung |
| --- | --- |
| **Schnell** | lokaler In-Process-Pfad (ONNX, GPU wenn vorhanden, sonst CPU) |
| **High Quality** | höchste Trennung – lokal oder extern |
| **Externe Zerlegung (Google Colab)** | der eindeutige Workflow-Button, immer sichtbar: nicht eingerichtet → öffnet den Einrichtungs-Dialog (Drive-Ordner/rclone + Colab-Worker); eingerichtet → startet die Zerlegung sofort; grün markiert = extern gewählt, erneut klicken stellt „lokal“ wieder ein |
| Statuszeile | „Arbeitskopie wird hochgeladen“, „Wartet auf den externen Rechner“, „Verarbeitung läuft – GPU/CPU“, „Stem-Separation abgeschlossen“ |
| **Abbrechen** | legt `cancel.flag` in die Ablage und meldet das Ergebnis des Klicks sofort an der Leiste („Abbruch gemeldet…“ / Grund, wenn Drive nicht erreichbar war). Beide Worker prüfen die Fahne alle 5 s **auch während** der Rechnung, beenden den Adapter und verbrauchen die Fahne; ein späteres Ergebnis wird verworfen |

Es gibt keine Python-, Colab- oder Checkpoint-Bedienung in der UI und keine
Tracebacks. Das Popup zeigt eine begrenzte, lesbare Ablaufspur; ausführlichere
Technikdetails stehen im Log (`STEM-REMOTE`) und in den Jobdateien. Der Nutzer
sieht eine Ursache in einem Satz („Google Drive ist gerade nicht erreichbar …“).
Die übrigen Qualitätsprofile (`Vorschau`, `High`, `Max`) bleiben unter
„Weitere Profile“ erhalten – nichts wurde entfernt.

## 2. Ablage einrichten

**Im Editor (empfohlen):** Button **„Externe Zerlegung (Google Colab)"** in der
Deck-Stem-Leiste → Einrichtungs-Dialog:

1. **Jobablage wählen** – Drive-Sync-Ordner (Empfehlung:
   `My Drive → airdox-stem-jobs`, per Systemdialog wählbar) oder rclone-Remote
   (`gdrive:airdox-stem-jobs`). „Speichern & Verbindung prüfen" schreibt die
   Einstellung nach `RemoteJobs/settings.json` und zeigt sofort, ob die Ablage
   erreichbar ist.
2. **Colab-Worker:** Notebook `colab/airdox-stem-remote-worker.ipynb`
   (Bau: `npm run stems:remote:notebook`) nach Google Drive hochladen, in Colab
   öffnen und `JOB_ORDNER` auf denselben Drive-Ordner setzen. Drive-Mount
   freigeben, Quellcode/Branch passend zur Editor-Version bereitstellen und die
   Worker-Zelle (#5) starten. Sie muss für neue Jobs in einer aktiven Colab-
   Laufzeit laufen; nach Ende/Abbruch der Laufzeit erneut starten. Drive-Sync
   kann Colab nicht automatisch wecken.

Sobald der Worker aktiv ist, laufen Upload, Warten, Rückimport, Speicherung und
Verknüpfung ohne weitere Schritte. Ohne laufende Worker-Zelle bleibt ein Job
korrekt als wartend sichtbar; die UI zeigt nach 120 s, wo geprüft werden muss.

Für Entwickler bleiben Umgebungsvariablen (oder `RemoteJobs/settings.json` im
Engine-Datenordner) als Programmierpfad; die Datei, die der Dialog schreibt,
hat gegenüber Umgebungsvariablen Vorrang:

| Variable | Default | Bedeutung |
| --- | --- | --- |
| `AIRODOX_STEM_REMOTE_DIR` | – | Pfad des Sync-Ordners (Mount) |
| `AIRODOX_STEM_REMOTE_KIND` | `folder` | `folder` oder `rclone` |
| `AIRODOX_STEM_REMOTE_RCLONE` | – | rclone-Ziel, z. B. `gdrive:airdox-stem-jobs` |
| `AIRODOX_STEM_REMOTE_POLL_MS` | `15000` | Poll-Takt des Editors (2 s … 10 min) |
| `AIRODOX_STEM_REMOTE_LEASE_MS` | `1800000` | Kulanz, bevor ein Job ohne Lebenszeichen als verwaist gilt |
| `AIRODOX_STEM_REMOTE_TIMEOUT_MS` | `21600000` | harte Obergrenze eines Fern-Jobs |

**Keine Tokens, keine Zugangsdaten** in Git, Quellcode, Logs oder Manifesten
(§23). Die Ablage enthält nur Pfade, Hashes, Status und Audio.

## 3. Ablage-Layout

```
jobs/<jobId>/manifest.json     Steckbrief: Status, Phase, Input-Hash, Modell, Stems, Worker
jobs/<jobId>/claim.json        Worker-Lease (Claim + Lebenszeichen)
jobs/<jobId>/cancel.flag       Abbruchwunsch des Editors
jobs/<jobId>/error.json        Fehlergrund, falls der Worker scheitert
jobs/<jobId>/input/<track>.wav Arbeitskopie (niemals das Original)
jobs/<jobId>/output/<stem>.wav Stems + result.json
jobs/<jobId>/logs/worker.log   menschenlesbares Worker-Protokoll
jobs/<jobId>/logs/worker.jsonl strukturierte, korrelierbare Schritte (max. 200)
```

Nach einem erfüllten Abbruch **verbraucht** der Worker die `cancel.flag`
(er löscht sie). Grund: der Editor veröffentlicht einen Job mit ungeklärtem
Upload unter derselben `jobId` erneut (§21 B) – bliebe die Fahne liegen, wäre
jeder weitere Lauf in demselben Ordner sofort wieder „CANCELLED“, ohne dass
jemand geklickt hat. Genau das fühlt sich an wie „ich drücke, es passiert
nichts“.

`jobId` ist eine UUID (§18). Status sind die **vorhandenen** `JobStatus`-Werte
(`PENDING`…`COMPLETED`/`FAILED`/`CANCELLED`); der Fernpfad hat zusätzlich
Phasen („Wartet auf den externen Rechner“) und Felder (`device`,
`cpuFallback`, `fallbackReason`, `worker`) – kein zweites Statussystem (§14).

## 4. Idempotenz und Doppelarbeit

* Jeder Job trägt einen **Idempotenzschlüssel** = SHA-256 aus Input-Hash,
  Modell, Profil und Stem-Liste. Ein zweiter Start mit demselben Input findet
  den vorhandenen Job wieder – auch nach einem Editor-Neustart (§19, §32, §33).
* Der Worker beansprucht einen Job über `claim.json` mit Lebenszeichen; solange
  eine fremde Lease frisch ist, überspringt er ihn. Zwei Colab-Instanzen können
  denselben Track also nicht parallel rechnen.
* `terminal`-Jobs (`COMPLETED`/`FAILED`/`CANCELLED`) werden nie erneut gerechnet.

## 5. Fehlerfälle

| Fall | Verhalten |
| --- | --- |
| A · Editor neu gestartet | offene Jobs werden geladen und weiterverfolgt; fertige Ergebnisse automatisch importiert |
| B · Upload abgebrochen | Job bleibt aktiv; der nächste Poll veröffentlicht Arbeitskopie und Steckbrief erneut (gleiche Job-Id) |
| C · Ablage nicht erreichbar | nur `transportDegraded` – kein Job-Fehler; sobald die Ablage zurück ist, läuft es weiter |
| D · Manifest unlesbar | nach drei Polls `REMOTE_MANIFEST_INVALID` (FAILED) mit Klartext |
| E · kein Worker | nach `AIRODOX_STEM_REMOTE_TIMEOUT_MS` FAILED `REMOTE_TIMEOUT` + `error.json` in der Ablage |
| F/G · GPU-Ausfall beim Worker | Worker rechnet auf CPU weiter (`cpuFallback` + Grund im Manifest), der Job bleibt aktiv |
| H · Worker-Neustart | Lease läuft ab, ein anderer Worker darf übernehmen; `attempts` zählt die Versuche |
| I · Stem fehlt | FAILED `REMOTE_OUTPUT_INCOMPLETE` – nichts wird importiert |
| J · Stem leer/kaputt/zu kurz | FAILED `REMOTE_OUTPUT_EMPTY`/`REMOTE_OUTPUT_INVALID` (Hash, Header, Kanäle, Dauer, Stille) |
| K · „COMPLETED“, aber Stems fehlen | Editor prüft die Vollständigkeit gegen den Modell-Deskriptor – kein `COMPLETED` ohne alle Stems |
| L · Abbruch | `cancel.flag` + Status `CANCELLED`; der Worker stoppt die laufende Rechnung (SIGTERM/SIGKILL) statt sie zu Ende zu rechnen. War die Ablage nicht erreichbar, bleibt der Job in Verfolgung und die Fahne wird bei jedem Poll nachgeliefert (`cancelPending`) – ein Abbruch, der nirgends ankam, wird nie als „erledigt“ verbucht. Ein danach eintreffendes Ergebnis wird verworfen und **nie** als `COMPLETED` angezeigt |

## 6. Original-Schutz

Es wird ausschließlich die **Arbeitskopie** hochgeladen. Vom Original liest der
Editor nur SHA-256, Größe und mtime – vor und nach dem Lauf. Ändert der Nutzer
die Datei parallel, wird das vermerkt (`originalUnchanged`), der Lauf aber nicht
verworfen. Jeder Job-Datensatz liegt unter `<Engine-Ordner>/RemoteJobs/<jobId>.json`.

## 7. Worker betreiben

**Auf einem Studio-/Büro-Rechner (Node, ohne Colab):**

```bash
npm run stems:remote:worker -- --root "~/Google Drive/airdox-stem-jobs" --once
# dauerhaft:
npm run stems:remote:worker -- --root "gdrive:airdox-stem-jobs" --kind rclone --poll 15000
```

Optionen: `--root --kind --workdir --worker --once --poll --model --profile
--device --model-dir --max-jobs --allow-pipeline-double --corrupt-output --quiet`.

**In Google Colab:** `colab/airdox-stem-remote-worker.md` (bzw. das daraus
erzeugte `.ipynb`) öffnet Drive, installiert `torch` und ruft denselben
Adapter, den der Editor lokal für HQ nutzt (`python/bsroformer_inference.py`) –
die Modell-/Neustartlogik wird also nicht doppelt gebaut (§42).

```bash
npm run stems:remote:notebook      # .md → .ipynb
npm run stems:remote:selftest      # Protokoll-Selbsttest des Python-Workers
```

Optionen des **Python-Workers** (Colab): `--root --model-dir --adapter
--work-dir --device --worker --poll --cancel-poll --model --profile --verbose
--idle-log-seconds --check-store --once --max-jobs --self-test`.
`--model`/`--profile` sind reine **Filter bzw. Hinweise**: verbindlich ist immer
der Steckbrief im Job (`manifest.json`). Ein Job, dessen Manifest ein anderes
Modell verlangt, wird übersprungen und protokolliert – der Worker rechnet nie
ein anderes Modell als das, das der Editor bestellt hat.

Der Worker ist **im Warten sichtbar**: Er schreibt beim Start und danach in
jedem Durchlauf zwei Dateien in die Wurzel der Ablage – `worker.status.json`
(Lebenszeichen mit Id, Host, Gerät, GPU, Phase und Zähler; der Editor zeigt
daraus das Banner „Colab-Worker online“ bzw. „Warte auf Lebenszeichen“) und
`worker.log` (dasselbe, damit man für die Diagnose nicht in jeden Jobordner
schauen muss). Den Job beansprucht er sofort und trägt den Worker-Eintrag
**vor** der Arbeitskopie ins Manifest ein – die Stufe „Extern verarbeiten“ steht
damit nicht erst nach dem Kopieren von 100 MB+. `--verbose` protokolliert
zusätzlich jede Poll-Runde.

### Wenn „Wartet auf den externen Rechner“ stehen bleibt

Dieser Text bedeutet: der Steckbrief liegt in der Ablage, aber **kein Rechner
hat ihn beansprucht** (`claim.json` fehlt). Die Frage „warum“ beantwortet ein
einziger, veränderungsfreier Befehl – auf dem Windows-Rechner wie in Colab:

```bash
python3 colab/remote_worker.py --root "<Jobablage>" --check-store
```

Er druckt je Job Status, Phase, Arbeitskopie, Lease (mit Lebenszeichen-Alter)
und Abbruchfahne und danach ein Urteil im Klartext. Typische Urteile:

| Urteil | Ursache | Abhilfe |
| --- | --- | --- |
| „offene(r) Job(s) ohne Lease“ | kein Worker läuft | Colab-Notebook Zelle 5 ausführen (sie läuft absichtlich weiter und meldet jede Minute „Warte auf Jobs …“) |
| „Kein einziger Job in der Ablage“ | andere Ordner auf beiden Seiten, oder Drive hat noch nicht synchronisiert | `JOB_ORDNER` im Notebook und die Jobablage im Editor müssen derselbe Ordner desselben Kontos sein |
| „passen nicht zum gestarteten Modell“ | `MODELL_ID` im Notebook-formular ≠ Steckbrief | `MODELL_ID = ""` setzen (dann gilt das Manifest) |
| „frisch beansprucht“ | hier rechnet bereits ein Rechner | im Editor „Jetzt prüfen“; kommt nichts zurück, Drive-Rückrichtung prüfen |
| „abgelaufene Lease“ | Colab-Laufzeit wurde beendet, während der Job lief | neuen Lauf starten (der Job darf übernommen werden) oder im Editor abbrechen und neu starten |

Zwei Fehler in dieser Ecke sind behoben und durch
`tests/stem-remote-worker-cli.test.mjs` festgenagelt: das Notebook startete den
Worker mit `--model`, was argparse stillschweigend als Abkürzung von
`--model-dir` las (falscher Modellordner), und `--profile` ließ den ganzen Lauf
mit Exit 2 enden (nie ein Claim ⇒ Editor wartet bis zum Timeout). Die
Kommandozeile ist jetzt streng: `allow_abbrev=False`, unbekannte Optionen
brechen ab, und der Notizbuch-Vorflug meldet einen sofort beendeten Worker
ausdrücklich.

## 8. Tests

| Test | Was er belegt |
| --- | --- |
| `tests/stem-remote-manifest.test.ts` | Manifest-Vertrag: Schema, Id-Abgleich, Pfad-Ausbruch, Idempotenzschlüssel, Vollständigkeit |
| `tests/stem-remote-job-service.test.ts` | Wartewarnung bleibt trotz Polls sichtbar; Claim-/Heartbeat-Übernahme; echter Weg Editor → Ablage → **Worker** → Import samt Ablaufspur, Neustart, Transportausfall, Timeout, Abbruch und kaputten Ergebnissen |
| `tests/stem-remote-worker-selftest.test.mjs` | Python/Colab-Worker ohne GPU: Protokoll, strukturierte Trace-Schritte, 200-Zeilen-Logbegrenzung, Lease-Heartbeat und Abbruch vor/während der Rechnung |
| `tests/onnx-fast-separation-live.test.ts` | schneller Pfad in-process: Stems, Pegel, Cache, Original unverändert, DirectML→CPU-Fallback |
| `tests/onnx-fixture-python-ort.test.ts` | Testgraph mit echter ORT-Session (Signatur, Werte, Determinismus) |

```bash
npm run test:stems:remote      # nur der Fernpfad
npm run test:stems             # komplette Stem-Suite (inkl. Fernpfad)
```

Ein Lauf mit echten Gewichten (BS-RoFormer + PyTorch) ist zusätzlich über
`npm run stems:setup:bsroformer` und `npm run test:stems:live` erreichbar – auf
Maschinen ohne Checkpoint überspringt die Suite diese Tests sauber.

## 9. Bewusste Grenzen

* Polling statt WebSockets (§20) – bei 15 s Takt und stundenlangen HQ-Läufen
  völlig ausreichend und deutlich robuster gegen Netzwechsel.
* Ein Transport zur Zeit; Jobs werden sequenziell importiert.
* Kein Docker, kein Redis, kein eigener Server (§24): die Ablage ist ein
  Ordner, der Worker ein Skript.
* Der Fernpfad braucht keinen lokal installierten HQ-Checkpoint – der Worker
  lädt genau das Modell aus dem Katalog, das im Steckbrief steht.

## 10. Diagnose: Popup wartet auf den externen Rechner

Die Anzeige `RUNNING` ohne Worker-ID bedeutet: Der Editor hat die Eingabe lokal
veröffentlicht, aber noch keinen Claim aus dem Worker gesehen. Das ist nicht
gleichbedeutend mit „Colab rechnet“. Schritt für Schritt:

1. Job-ID und Ablaufprotokoll im Popup prüfen. Der letzte Editor-Schritt sollte
   `editor.waiting_for_worker` sein; nach 120 s erscheint der Worker-Claim-Hinweis.
2. Im Windows-Drive-Sync-Ordner `jobs/<jobId>/manifest.json` und
   `jobs/<jobId>/input/` prüfen. Danach denselben Ordner in Drive Web ansehen:
   nur dort ist die Cloud-Synchronisierung bestätigt.
3. In Colab muss die Worker-Zelle laufen. Die Ausgabe meldet regelmäßig
   `worker.poll` mit `scanned/pending`. Kein `worker.poll` = Zelle #5 ist noch nicht
   gestartet (z. B. Setup/Modelldownload läuft) oder die Laufzeit steht;
   `scanned: 0` bei offenem Editor-Job = meist falscher `JOB_ORDNER`, Mount oder
   noch nicht synchronisierte Dateien.
4. Nach dem Claim muss `jobs/<jobId>/claim.json` einen Worker und ein
   fortlaufend erneuertes `heartbeatAt` enthalten. Im Popup sollte nun die
   Worker-ID stehen. Die Lease wird unabhängig von Modell-Progress erneuert.
5. `jobs/<jobId>/logs/worker.jsonl` führt `worker.claimed`,
   `worker.input_verified`, `worker.inference_started`, Fortschritts- und
   Ergebnis-/Fehlerschritte; `worker.log` ist die lesbare Ergänzung.
   `error.json` enthält den Maschinenfehlercode. Die App übernimmt diese
   Ereignisse in das Ablaufprotokoll des Statusfensters.
6. Nach `worker.completed` müssen Manifest und Ergebnisdateien `COMPLETED`
   melden; im Editor folgen `editor.output_validated` und
   `editor.result_imported`. Der lokale E2E-Test prüft die gleiche Kette mit
   einem Pipeline-Double und beweist ausdrücklich **keinen** Google-/Colab-Lauf.

Vor dem Teilen Logs auf private Pfade prüfen; nie Audiodaten, Credentials oder
Token-Dateien öffentlich weitergeben.
