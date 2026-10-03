# Abschlussbericht – Externe Zerlegung (Google Colab): Button, Einrichtung, Verknüpfung

**Datum:** 2026-09-19
**Anfrage (Benutzer):** „Beschrifte den Button eindeutiger – den dafür bestimmt ist,
zerlegt zu werden, damit ich den Workflow auf Google Colab meinte. Verknüpfe den Button
mit der Logik für das externe Zerlegen der Audio in seine Einzelspuren. Stelle den
Import zu Drive sicher, dann die Übergabe an Colab, dann das Bearbeiten der
Audio-Zerlegung, die Ergebnisse wieder in Drive importieren und zur Verfügung zu
stellen. Der Editor zieht sich die Daten, speichert sie dauerhaft und verknüpft sie mit
dem Original-Track – ohne etwas an den rekordbox.xml, master.db oder den Originalen
Tracks zu ändern."

## 1. Befund – warum der externe Workflow bisher nicht erreichbar war

Die komplette Logik (Editor ⇄ Drive ⇄ Colab-Worker ⇄ Import) **bestand bereits**
(`src/stems/remote/`, `scripts/stem-remote-worker.ts`, `colab/airdox-stem-remote-worker.ipynb`,
IPC-Kanäle, HTTP-Endpunkte, Tests). Was fehlte, war die **Bedienung**:

| # | Defekt | Wirkung |
|---|--------|---------|
| 1 | In der Deck-Leiste gab es nur ein Häkchen **„Extern rechnen"**, das **erst sichtbar wurde, wenn ein Transport konfiguriert war** | Button praktisch unsichtbar |
| 2 | **Keine UI zur Einrichtung** der Jobablage (nur Umgebungsvariablen oder von Hand `RemoteJobs/settings.json`) | Condition aus #1 konnte nie erfüllt werden → Feature tot |
| 3 | `server.ts`: `/api/stems/remote` mit `express.json({ limit: '1mb' })` – der Start trägt aber die Arbeitskopie als base64 (6-min-Track ≈ 190 MB) | **HTTP 413** im Dev-/Browser-Pfad, bevor ein Byte ankommt |
| 4 | `remoteStemJobService.start()` ohne konfigurierte Ablage: nackter Transport-Fehler ohne stabile Kennung | Unklare Fehlermeldung statt Handlungsanweisung |

## 2. Änderungen

### 2.1 Eindeutiger Button (Bedienung)

Neuer Button **„Externe Zerlegung (Google Colab)"** (Cloud-Icon) in der
Qualitätszeile der Deck-Stem-Leiste – **immer sichtbar**, eindeutige Zustände:

| Zustand | Darstellung | Klick |
|---|---|---|
| nicht eingerichtet | neutral, gestrichelte Kante | öffnet den Einrichtungs-Dialog |
| eingerichtet, nicht gewählt | neutral | **startet die Zerlegung sofort** (Profile HIGH_QUALITY, extern aktiv) |
| extern gewählt | grün markiert | erneut klicken → stellt „lokal" wieder ein |
| externer Job aktiv | grün, „Colab-Job läuft…", Statuszeile mit Phase + GPU/CPU | – (Abbrechen daneben) |

Das alte, mehrdeutige Häkchen ist entfernt. Die Auswahl „extern" überlebt einen
Editor-Neustart (localStorage).

### 2.2 Einrichtungs-Dialog (`RemoteSetupModal`)

* **Ablauf in 4 Schritten** erklärt: Arbeitskopie → Drive; Colab-Worker nimmt Job
  an und rechnet (BS-RoFormer HQ, GPU/CPU); Stems + Ergebnis-Steckbrief zurück
  in denselben Drive-Ordner; Editor zieht sie automatisch, prüft, speichert
  dauerhaft, verknüpft mit dem Original-Track.
* **Read-only-Garantie** als eigener Kasten: Es wird ausschließlich die
  Arbeitskopie hochgeladen; Original, `rekordbox.xml` und `master.db` werden nie
  verändert (vom Original werden nur SHA-256/Größe/mtime gelesen – vor und nach
  dem Lauf).
* **Jobablage:** Drive-Sync-Ordner (empfohlen, per Systemdialog wählbar) oder
  rclone-Remote; „Speichern & Verbindung prüfen" persistiert nach
  `RemoteJobs/settings.json` und zeigt sofort grün/rot, ob die Ablage erreichbar
  ist.
* **Colab-Worker (einmalig, ca. 5 Min.):** Notebook `colab/airdox-stem-remote-worker.ipynb`
  (Bau: `npm run stems:remote:notebook`) nach Drive hochladen, in Colab öffnen,
  Laufzeit T4 (GPU) oder CPU, „Alles ausführen"; `JOB_ORDNER` muss den
  gewählten Drive-Ordner benennen.

### 2.3 Verknüpfung der Logik

* `App.tsx`: `handleStartExternalSeparation` – Button → Transport-Prüfung
  (ohne Ablage: Dialog statt Stillstand) → extern aktivieren + Profil
  `HIGH_QUALITY` → `runRemoteStemSeparation` (bestehender Pfad:
  `separateRemoteWithEngine` → Start → Polling → Stems laden).
* `server.ts`: Remote-Routen mit demselben JSON-Limit wie der lokale Job-Start
  (500 MB) – der Upload der Arbeitskopie funktioniert jetzt im
  Dev-/Browser-Pfad.
* `remoteStemJobService.start()`: fehlende Ablage ⇒
  `RemoteProtocolError('REMOTE_TRANSPORT_MISSING')` mit verständlichem Text
  (stabile Kennung für UI und Tests).
* `docs/STEM_REMOTE_HQ.md` §1/§2: UI als Primary-Setup; Umgebungsvariablen
  bleiben als Programmierpfad (Datei des Dialogs hat Vorrang).

### 2.4 Der Datenweg (Bestätigung der geforderten Kette)

```
[Button] → Arbeitskopie (nur Lesen vom Original)
         → Upload jobs/<jobId>/input/<track>.wav + manifest.json (Google Drive)
         → Colab-Worker (Claim mit Lease, Hash-Prüfung, BS-RoFormer HQ,
           Ergebnis + SHA-256 pro Stem zurück in denselben Drive-Ordner)
         → Editor-Poll: COMPLETED erkennen, Stems hart prüfen (Hash, WAV-Header,
           Kanäle, Dauer, Stille/Peak), dauerhaft speichern unter
           <Engine-Ordner>/stems/Separation/<track>/remote-<jobId>/ + job.json
         → über registerCompletedJob in den BESTEHENDEN lokalen Job-Pfad
           (derselbe wie bei lokaler Trennung) → TrackStems mit trackId +
           originalSha256 → Deck zeigt die 4 Stems
```

Wiederholung desselben Tracks: Idempotenzschlüssel (Input-Hash + Modell +
Profil) ⇒ kein zweiter Job, kein zweites Rechnen.

## 3. Nachweis

* **Neu:** `tests/stem-remote-setup-config.test.ts` – 8 Prüfungen:
  1. ohne Einrichtung: `configured=false`, klarer Grund, Start lehnt mit
     `REMOTE_TRANSPORT_MISSING` ab
  2. `configure()` Drive-Ordner: configured/reachable/Label, `settings.json`
  3. neue Instanz liest die Einrichtung (Editor-Neustart)
  4. fehlender Ordner: Job bleibt PREPARING/`transportDegraded` (kein FAILED)
  5. rclone-Ziel: gültig, Meldung benennt rclone
  6. **Upload nach Drive:** Arbeitskopie + Manifest in `jobs/<id>/`,
     Original byte-identisch (SHA-256 vorher/nachher)
  7. Idempotenz: zweiter Start ⇒ gleicher Job
  8. **kompletter Rückweg mit echtem Worker** (`runWorkerCycle` =
     Notebook-Code): COMPLETED nur nach Prüfung, 4 Stems dauerhaft auf Platte,
     lokaler Job-Verknüpfung, Original unverändert
* Komplette Suite: **62/62 bestanden**, 5 SKIP (Sandbox ohne
  torch/demucs/onnxruntime), `tsc --noEmit` sauber.

## 4. So läuft es auf dem Windows-Rechner

1. **App neu bauen** (wichtig – siehe vorheriger Bericht): `npm run build`
   (`dist/stems/node-bridge.cjs` + Renderer), dann `npm run desktop` oder
   `npm run package:win`.
2. **Colab-Worker einmalig starten:** `npm run stems:remote:notebook`
   → `colab/airdox-stem-remote-worker.ipynb` nach Google Drive hochladen →
   in Colab öffnen → Laufzeit T4 → „Alles ausführen" (läuft im Hintergrund).
3. **Im Editor:** Deck-Leiste → **„Externe Zerlegung (Google Colab)"** →
   Ordner `My Drive\airdox-stem-jobs` wählen (oder anlegen) →
   „Speichern & Verbindung prüfen" (grün = bereit).
4. **Trennen:** erneut auf den Button klicken. Fortschritt unten in der
   Leiste (Phase, GPU/CPU), Abbrechen jederzeit möglich. Die Stems erscheinen
   automatisch im Deck und bleiben dauerhaft verknüpft.
