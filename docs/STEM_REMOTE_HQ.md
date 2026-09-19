# High Quality extern – BS-RoFormer auf einem fremden Rechner

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

## 1. Was der Nutzer sieht

In der Deck-Stem-Leiste steht nur noch:

| Element | Bedeutung |
| --- | --- |
| **Schnell** | lokaler In-Process-Pfad (ONNX, GPU wenn vorhanden, sonst CPU) |
| **High Quality** | höchste Trennung – lokal oder extern |
| **Externe Zerlegung (Google Colab)** | der eindeutige Workflow-Button, immer sichtbar: nicht eingerichtet → öffnet den Einrichtungs-Dialog (Drive-Ordner/rclone + Colab-Worker); eingerichtet → startet die Zerlegung sofort; grün markiert = extern gewählt, erneut klicken stellt „lokal“ wieder ein |
| Statuszeile | „Arbeitskopie wird hochgeladen“, „Wartet auf den externen Rechner“, „Verarbeitung läuft – GPU/CPU“, „Stem-Separation abgeschlossen“ |
| **Abbrechen** | setzt `cancel.flag`; der Worker hört auf, ein späteres Ergebnis wird verworfen |

Es gibt keine Python-, Colab- oder Checkpoint-Bedienung in der UI und keine
Tracebacks: technische Details stehen im Log (`STEM-REMOTE`), der Nutzer sieht
eine Ursache in einem Satz („Google Drive ist gerade nicht erreichbar …“).
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
2. **Colab-Worker (einmalig):** Notebook `colab/airdox-stem-remote-worker.ipynb`
   (Bau: `npm run stems:remote:notebook`) nach Google Drive hochladen, in Colab
   öffnen, Laufzeit T4/CPU wählen, „Alles ausführen". `JOB_ORDNER` in der
   ersten Code-Zelle muss den gewählten Drive-Ordner benennen.

Danach genügt ein Klick auf den Button – Upload, Warten, Rückimport,
Speicherung und Verknüpfung mit dem Original-Track laufen ohne Bedienung.

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
logs/worker.log                Worker-Protokoll (ohne Geheimnisse)
```

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
| L · Abbruch | `cancel.flag` + lokaler Status `CANCELLED`; ein danach eintreffendes Ergebnis wird verworfen und **nie** als `COMPLETED` angezeigt |

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

## 8. Tests

| Test | Was er belegt |
| --- | --- |
| `tests/stem-remote-manifest.test.ts` | Manifest-Vertrag: Schema, Id-Abgleich, Pfad-Ausbruch, Idempotenzschlüssel, Vollständigkeit |
| `tests/stem-remote-job-service.test.ts` | echter Weg Editor → Ablage → **echter Worker** → Import; Neustart, Transportausfall, Timeout, Abbruch, kaputte Ergebnisse |
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
