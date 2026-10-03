# Fern-Stems: Nachweiskette und Google-Freigabe

Stand 2026-10-03. **Kein produktiver Google-/Colab-Lauf wurde durch dieses Dokument behauptet.** Der lokale Test nutzt einen Pipeline-Double, nicht trainierte Gewichte. Qualitätsfreigabe siehe zusätzlich `colab/README.md` und `npm run test:stems:gate`.

## Ohne Google-Zugangsdaten: reproduzierbarer Nachweis

1. `npm ci` (Node >= 20), Python 3 bereitstellen.
2. `npm run stems:remote:evidence` ausführen. Bei Erfolg steht `stem-gate-run/remote-evidence.json` (gitignored, Berechtigungen 0600 auf POSIX). Bei Fehler ebenfalls den Bericht lesen; `checks[].passed` muss überall `true` sein. Der Befehl beendet sich dann mit Fehlercode 1.
3. Bericht aufbewahren: Commit-ID, Kennzeichen für **nicht commitete Änderungen**, SHA-256 der relevanten Quellen/Notebook/Testdateien, Testergebnisse und `scope: LOCAL_SIMULATION_ONLY`. Bei `trackedWorktreeDirty: true` ist die Commit-ID **nicht** allein eine eindeutige Bezeichnung des getesteten Inhalts; die Datei-Hashes mitarchivieren. Der Bericht enthält absichtlich keine Test-Logs, Tokens oder Audiodateien. SHA-256 belegt Inhaltsgleichheit, **nicht** Herkunft oder Google-Ausführung.
4. Die Kette im Test `tests/stem-remote-job-service.test.ts`: Original → Arbeitskopie → `manifest.json` mit Input-Hash → lokaler Ordnertransport → echter Worker-Code mit Pipeline-Double → Ergebnis-Hashes → Import; außerdem Neustart, Abbruch, Ausfall und ungültige Ergebnisse. Der Python-Worker hat einen separaten Selbsttest. Das ist eine lokale Protokollprobe, **kein** Beweis einer Synchronisierung zwischen Windows und Colab.

## Authentifizierung: vorhandene Lösung statt App-Credentials

**Empfehlung:** Google Drive für Desktop auf dem Windows-Rechner installieren und **im eigenen Google-Konto dort anmelden**. Die Anmeldung erfolgt bei Google/Drive für Desktop, nicht in AirDox. In „Meine Ablage“ `airdox-stem-jobs` anlegen; für häufige große Audio-Schreibvorgänge ist „Dateien spiegeln“ sinnvoller als Streaming (Speicherplatz einplanen). Den tatsächlichen lokalen Pfad dieses Ordners im Editor unter **Externe Zerlegung (Google Colab) → Einrichten → Jobablage wählen → Speichern & Verbindung prüfen** auswählen. Auf Colab fordert `drive.mount('/content/drive')` separat eine Benutzerfreigabe. Beide Seiten müssen **denselben Ordner desselben Kontos** sehen. Alternativ: rclone als Drive-Remote außerhalb der App konfigurieren und im Editor `gdrive:airdox-stem-jobs` wählen. Keine rclone-Konfiguration oder Token-Datei ins Repo kopieren.

Das ist kein Umgehen der Zustimmung: **spätestens beim Anmelden in Drive für Desktop beziehungsweise `drive.mount` muss der Kontoinhaber interaktiv zustimmen**. Wir können das nicht in dieser Sandbox stellvertretend durchführen. Wer statt Ordner-Sync eine direkte Drive-API in die App einbauen möchte, braucht eine Google-Cloud-App mit OAuth-Consent-Screen und Desktop-OAuth-Client sowie Benutzerzustimmung; ein Service-Account ist kein Ersatz für den Zugriff auf eine private „Meine Ablage“. Diese API-Integration ist hier bewusst **nicht** implementiert, weil der vorhandene Ordnertransport ohne App-Credentials auskommt.

Quellen (Google, geprüft 2026-10-03): [Drive für Desktop: Streaming/Spiegelung](https://support.google.com/drive/answer/13401938), [Offline-/Sync-Verhalten](https://support.google.com/drive/answer/16631477), [Drive API: Desktop-OAuth-Client und Consent](https://developers.google.com/workspace/drive/api/quickstart/nodejs), [Drive API: Tokens im Client](https://developers.google.com/workspace/drive/api/quickstart/python).

## Ab der Benutzerfreigabe: echte Abnahme, noch offen

1. Notebook mit `npm run stems:remote:notebook` erzeugen und `colab/airdox-stem-remote-worker.ipynb` in Colab öffnen. `JOB_ORDNER = "airdox-stem-jobs"` prüfen. Colab-Laufzeit wählen; Google-Drive-Mount **selbst** freigeben.
2. Notebook-Code aus **demselben Stand** bereitstellen (`REPO_URL`/`BRANCH` oder Archiv). Achtung: Default im Notebook ist `main`; wenn der getestete Stand nur auf dem Arbeitsbranch liegt, den Branch dort explizit setzen. Vor dem Lauf Commit und Hashes notieren. Nicht blind ein veraltetes Archiv verwenden.
3. Im Editor einen Testtrack mit externem HQ starten. In Drive `jobs/<jobId>/manifest.json` auf `PENDING` prüfen; nach Colab-Worker-Lauf `COMPLETED`, Output-Hashes und Rückimport im Editor prüfen. Original vor/nachher SHA-256 vergleichen. Lokal gespeicherten Nachweisbericht, anonymisierte Job-ID/Manifest und Ergebnis-Hashes aufbewahren; **keine** Audiodaten, Credentials oder Token-Dateien im Git-Repository oder öffentlichen PR ablegen.
4. Für **Qualität mit trainierten Gewichten** zusätzlich `colab/airdox-stem-gate.ipynb` nach `colab/README.md` ausführen und dessen Summary archivieren. Eine bestandene lokale Fernpfadprobe oder ein erfolgreicher Upload beweist keine Audioqualität, Windows-Verpackung oder fertige Produktfreigabe.

**Stopppunkt:** Ohne Kontoinhaber-Freigabe und erreichbaren Drive-/Colab-Lauf bleiben Schritte 1–4 dieses Abschnitts offen. Keine Zugangsdaten im Chat zusenden; Anmeldung ausschließlich in den offiziellen Google-Oberflächen durchführen.
