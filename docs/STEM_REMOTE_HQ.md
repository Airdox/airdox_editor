# High Quality extern – Colab-Worker v2 (AirDox 0.4.4)

## Aufbau

```
Editor → WAV-Arbeitskopie + Manifest → Drive-Jobordner → Python-Worker
Editor ← geprüfter lokaler Import ← vier WAV-Stems + Ergebnis ← BS-RoFormer
```

Der Fernpfad benutzt das Modell `bsroformer-musdb18hq-4stem-zfturbo` aus dem
Modellkatalog. Original-Audio, XML, ANLZ und Rekordbox-Datenbanken werden nicht
verändert. Die App braucht für diesen Pfad keine lokale Python-Installation
oder Modellgewichte. Google Drive für Desktop (oder konfiguriertes rclone)
ist weiterhin erforderlich.

**Einrichtung und Windows/Colab-Abnahme:** [COLAB_ABNAHME.md](COLAB_ABNAHME.md).
Die EXE enthält unter `resources/colab` das zur App gehörende Worker-ZIP und
Notebook, erreichbar über „Colab-Paket öffnen“. Das Notebook klont nicht mehr
ungeprüft den aktuellen main-Branch. Der Paketinhalt wird durch SHA256-Dateihashes
und einen Quellstand dokumentiert; das ist ein Integritätsnachweis, keine digitale
Signatur. Nur Pakete aus vertrauenswürdiger Quelle ausführen.

## Tatsächliche Bereitschaft

- `reachable`: Ablage erreichbar. Ein lokaler Ordner ist noch kein Cloud-Nachweis.
- `workerReady`: kompatibles `colab-worker/2`-Lebenszeichen jünger als drei Minuten.
- `connectionProof`: neue Nonce via `connection/request.json` → Python-Heartbeat
  → `connection/response.json`; `PASS` nur bei passender frischer Antwort.
  Belegt den Transport, nicht unabhängig Googles Identität.
- Übernahme des konkreten Jobs: `manifest.worker.id` und `claim.json`.
- Fertig: erst nach vollständiger lokaler Prüfung und Registrierung der Stems.

Colab muss vom Nutzer angemeldet und pro Sitzung gestartet werden. Laufzeitende,
GPU-Verfügbarkeit und Google-Drive-Synchronisierung bleiben externe Abhängigkeiten.
Nur **ein Worker und ein Editor pro Jobordner** sind unterstützt: atomare lokale
Dateiumbenennungen garantieren keine verteilten Sperren über mehrere Drive-Clients.

## Dateien

```
worker.json                        Bereitschaft, Gerät, Modellhash, Lebenszeichen
jobs/<jobId>/manifest.json          Jobbeschreibung und Worker-Status
jobs/<jobId>/input/<track>.wav      Arbeitskopie
jobs/<jobId>/claim.json             Besitzanspruch und unabhängiges Lebenszeichen
jobs/<jobId>/cancel.flag            Abbruchanforderung
jobs/<jobId>/error.json             Fehler mit Code und Klartext
jobs/<jobId>/logs/worker.log        Worker-Protokoll
jobs/<jobId>/output/<stem>.wav      drums, bass, other, vocals (FLOAT-WAV)
jobs/<jobId>/output/result.json     Worker-Ergebnis und Adapterbericht
jobs/<jobId>/output/import-receipt.json  Importbestätigung des Editors
```

Lokal liegen Zustand und Einstellungen unter `<Engine-Ordner>/RemoteJobs/`.
Fertige Ergebnisse liegen unter `Separation/`. Sie werden nach einem App-Neustart
hashgeprüft erneut im lokalen Stem-Service registriert, auch ohne Drive-Verbindung.

## Überarbeitete Fehlerbehandlung

- Keine mehrdeutigen CLI-Abkürzungen; Modell und Profil stammen aus dem Manifest.
- Vor Jobannahme: Runtime-Imports, Katalog/Checkpoint-Hash, Konfiguration,
  Modellarchitektur und CUDA-Verfügbarkeit prüfen. Nur der kataloggebundene
  4-Stem-Worker ist im Notebook freigegeben; andere Modelle werden klar abgelehnt.
- Inferenz lokal statt direkt auf dem Drive-Mount. Fehlende/teilweise Eingaben
  werden während einer begrenzten Synchronisierungsfrist erneut geprüft.
- 48-kHz-Eingaben werden für das 44,1-kHz-Modell resampelt. Outputs erhalten wieder
  die ursprüngliche Samplerate und Framezahl. Der Editor prüft Dauer/Kanäle/Hashes.
- stdout/stderr werden gleichzeitig gelesen; Timeout/Abbruch beenden den Adapter.
- Lease-Lebenszeichen läuft auch ohne Fortschrittsmeldung. GPU-OOM/GPU-Ausfall
  kann zu einem sichtbaren CPU-Rückfall führen; Modellfehler nicht.
- Dateinamen kommen aus dem `done.stems`-Vertrag des Adapters; FLOAT-WAV wird
  unterstützt. Ergebnisse werden vor der Fertigmeldung veröffentlicht.
- Fehlende/zu kleine Ergebnisse werden bis zum Synchronisierungslimit erneut
  geladen; Hashfehler vollständig gelieferter Dateien bleiben harte Fehler.
- Abbruch gewinnt auch beim Ergebnisdownload. Fehlgeschlagene/abgebrochene Jobs
  werden nicht durch verspätete Worker-Meldungen wiederbelebt.
- Gesamtzeitlimit wird auch bei nicht erreichbarer Ablage geprüft.

## Zeitgrenzen

| Einstellung / Umgebungsvariable | Standard |
|---|---|
| `pollIntervalMs` / `AIRODOX_STEM_REMOTE_POLL_MS` | 15 Sekunden |
| `workerWaitMs` / `AIRODOX_STEM_REMOTE_WAIT_MS` | 10 Minuten bis Übernahme |
| `workerLeaseMs` / `AIRODOX_STEM_REMOTE_LEASE_MS` | 3 Minuten ohne Lebenszeichen |
| `outputSyncWaitMs` / `AIRODOX_STEM_REMOTE_SYNC_MS` | 10 Minuten Ergebnis-Sync |
| `jobTimeoutMs` / `AIRODOX_STEM_REMOTE_TIMEOUT_MS` | 6 Stunden |

Einrichtungsdatei hat Vorrang vor Umgebungsvariablen. Transport bleibt `folder`
(`AIRODOX_STEM_REMOTE_DIR`) oder `rclone` (`AIRODOX_STEM_REMOTE_RCLONE`).
Keine Zugangsdaten werden in Manifesten, Quelltext oder App-Einstellungen benötigt.

## Prüfungen

```sh
npm run test:stems:remote
python colab/remote_worker.py --self-test
npm run stems:remote:notebook -- --check
npm run stems:remote:bundle
```

`stem-remote-python-worker.test.mjs`: Python-Regressionen mit explizitem Testadapter
(keine trainierte Separation). `stem-remote-python-integration.test.ts`: echter
Editor-Service → Python-Worker → Rückimport, einschließlich Wiederaufnahme,
Abbruch, Sync-Verzögerung, Zeitgrenzen und Originalschutz.

**Echter Modelltest (kein stiller Fallback, kein Skip erlaubt):**

```sh
python colab/remote_setup.py --model-dir stem-gate-run/models --device cpu
AIRODOX_STEM_MODEL_DIR="$PWD/stem-gate-run/models" AIRODOX_STEM_PYTHON=python \
  node scripts/run-tests.mjs --only stem-remote-real-model-live --fail-on-skip --timeout 1200000
```

Dieser Test verarbeitet echtes Audiomaterial mit trainierten Gewichten bei
44,1 und 48 kHz über den produktiven Python-Worker und prüft den Editorimport.
Nachweis: `stem-gate-run/remote-real-model-evidence.json`. Er beweist nicht die
reale Google-Verbindung, die Windows-GPU oder die musikalische Qualität auf
beliebigem Audiomaterial. Dafür ist die dokumentierte Vor-Ort-Abnahme erforderlich.


## Nachweiskette 0.4.4

Der Windows-Job hängt hart vom erfolgreichen Modell-/Notebook-Job ab. Das
exportierte Notebook wird in einer neuen Python-Umgebung auf Linux/CPU **bis
vor** `AIRDOX_AUTH_GATE` tatsächlich ausgeführt. Sein SHA256 wird beim Windows-
Build mit der ausgelieferten Notebook-Datei verglichen. Paket/Notebook sind
plattformübergreifend deterministisch (ZIP_STORED, feste Zeitstempel, LF).

`evidence-run.mjs` speichert echte Befehle, Exitcodes, Revision, Workflow und
redigierte Logs; `run-tests.mjs` zusätzlich die Einzeltests und Skip-Gründe.
`release_evidence.py` verweigert fehlende/falsche Revisionen, fehlgeschlagene
Pflichtstufen und übersprungene Modelltests. Es erstellt die gemeinsame
Auslieferung mit EXE-Hashes, Rohberichten, Windows-Screenshot und PowerShell-
Verifier. Die App prüft die eingebetteten Vorbereitungsnachweise per IPC.

Details: [START_HIER](COLAB_START_HIER.md), [Auth-Recherche](COLAB_AUTH_RECHERCHE.md).
