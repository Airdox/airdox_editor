# Bestands- und Statusbericht: Externe Stem-Zerlegung (Google Colab & Google Drive)

**Datum:** 2026-10-04  
**Projekt:** airdox_SMART_Editor  
**Komponente:** Fernpfad / Remote Stem Separation (`src/stems/remote/`, `colab/`)  
**Status:** Code vollständig implementiert & lokal im Testbetrieb validiert; **Live-Ende-zu-Ende-Datentransport über echtes Google Drive & Colab steht noch aus**.

---

## 1. Die drei Kernfragen auf den Punkt beantwortet

### Frage A: Besteht die Verbindung zu Google Drive und sind schon Daten dorthin geflossen?
* **Technischer Aufbau:** Der Editor baut **keine direkte TCP/API-Verbindung** zu Google-Servern auf (keine OAuth-App, keine Passwörter oder Google-Tokens im Quellcode). Stattdessen nutzt der Editor das lokale Dateisystem: Sie wählen im Editor einen Ordner aus, der von der Software **Google Drive für Desktop** (oder `rclone`) überwacht und synchronisiert wird (z. B. `G:\Meine Ablage\airdox-stem-jobs`).
* **Sind Daten geflossen?**
  * **Lokal auf die Festplatte:** **Ja.** Der Editor erzeugt die Arbeitskopie (`input/<track>.wav`) und das Auftragsmanifest (`manifest.json`) und legt sie atomar im gewählten Ordner ab. Das ist im Nutzer-Log (Job `915db325...`) dokumentiert.
  * **Tatsächlich hoch in die Google-Cloud:** **Unbekannt / nicht nachweisbar durch die App.** Ob *Google Drive für Desktop* die Dateien anschließend erfolgreich in Googles Cloud hochgeladen hat, kann der Editor nicht sehen, da er keinen Zugriff auf den internen Status des Google-Synchronisations-Clients hat.

### Frage B: Steht die Verbindung von Drive zu Colab und sind Daten dorthin oder zurück geflossen?
* **Klares Fazit:** **Nein, in der Realität sind noch keine Daten zwischen Google Drive und Colab geflossen.**
* **Befund aus den Logs:**
  * Der Job `915db325...` blieb im Status `RUNNING` mit dem Hinweis `„Wartet auf den externen Rechner“` stehen.
  * Ein Google-Colab-Worker hat die Datei **weder beansprucht noch heruntergeladen**. Es wurde keine `claim.json` und kein Lebenszeichen (`worker.status.json`) erzeugt.
  * Es wurden **keine Stems erzeugt** und **keine Daten von Colab zurück nach Drive** geschrieben.
  * Der Durchlauf wurde schließlich durch wiederholte Klicks auf „Abbrechen“ beendet.

### Frage C: Woher kommen die Gewichte bei Colab und müssen wir sie trainieren?
* **Selbst trainieren:** **Nein.** Ein Modell wie BS-RoFormer erfordert tausende Stunden Audio-Material und Rechenzentrum-GPUs. Wir trainieren nichts selbst.
* **Wie Colab an die Gewichte kommt:** Vollautomatisch. Im Colab-Notebook (`airdox-stem-remote-worker.ipynb`, Zelle 3) lädt ein Download-Skript den fertig trainierten Checkpoint (`model_bs_roformer_ep_17_sdr_9.6568.ckpt`, ~503 MB) direkt über GitHub Releases von ZFTurbo (MIT-Lizenz). Colab verfügt über 500+ Mbit/s Anbindung; der Download dauert nur wenige Sekunden.
* **Muss der lokale PC Gewichte haben?** **Nein!** Für den Colab-Weg benötigt Ihr PC weder Python, noch PyTorch, noch Modellgewichte.

---

## 2. Detaillierter Stand: Was ist fertig implementiert?

Die gesamte Code-Pipeline ist fertig geschrieben und mit automatisierten Tests abgesichert:

| Komponente | Datei / Pfad | Stand | Funktion |
|---|---|---|---|
| **Deck-Button & Dialog** | `src/components/DeckStemsControl.tsx`, `RemoteSetupModal.tsx` | **Fertig** | Button „Externe Zerlegung (Google Colab)“ mit Zuständen (nicht eingerichtet, bereit, aktiv, abbrechen). Dialog zur Ordnerwahl. |
| **Original-Schutz** | `src/stems/remote/remoteStemJobService.ts` | **Fertig** | Liest das Original nur read-only (prüft SHA-256 vor und nach dem Lauf). Erzeugt eine separate Arbeitskopie als `.wav`. `rekordbox.xml` und `master.db` werden niemals berührt. |
| **Dateisystem-Transport** | `src/stems/remote/transport.ts` | **Fertig** | Schreibt atomar (`.tmp` + `rename`), damit Google Drive keine halbfertigen Dateien hochlädt. |
| **Colab-Notebook** | `colab/airdox-stem-remote-worker.ipynb` | **Fertig** | Mountet Google Drive, lädt Modellgewichte aus dem GitHub-Release, verifiziert SHA-256, scannt Jobs. |
| **Colab-Worker-Engine** | `colab/remote_worker.py` | **Fertig** | Exklusiver Claim (`claim.json`), fortlaufender Heartbeat (`worker.status.json`), Inferenz via BS-RoFormer, Rückschreiben der 4 Stems. |
| **Inferenz-Abbruch** | `remote_worker.py` & `remoteStemJobService.ts` | **Fertig** | Pollt alle 5 Sekunden `cancel.flag` während der GPU-Rechnung; beendet den Prozess sofort (SIGTERM/SIGKILL). |
| **Ergebnis-Import** | `src/stems/remote/remoteStemJobService.ts` | **Fertig** | Überwacht Status `COMPLETED`, prüft Output-Hashes, importiert Stems in den lokalen Cache und verknüpft sie mit dem Track. |

---

## 3. Warum hat der letzte echte Durchlauf nicht geklappt?

Bei der Analyse des bisherigen Probelaufs wurden zwei Fehler im Quellcode aufgedeckt, die inzwischen behoben wurden:

1. **Parameterkonflikt in Colab:**
   * Das Notebook startete den Worker mit `--model <id>`.
   * Python interpretierte dies als Abkürzung für `--model-dir`, wodurch der Modellpfad mit der Modell-ID überschrieben wurde. Der Worker stürzte in Zelle 5 sofort ab, bevor er den Job überhaupt sehen oder beanspruchen konnte.
   * *Status:* Behoben (`allow_abbrev=False`, explizite Argumentbehandlung).

2. **Google Drive Ordner-Diskrepanz oder inaktive Colab-Laufzeit:**
   * Wenn im Editor ein Ordner gewählt wird (z. B. `G:\Meine Ablage\airdox-stem-jobs`), das Colab-Notebook in Zelle 1 aber auf einen anderen Pfad konfiguriert ist, „sehen“ sich die beiden Seiten nicht.
   * Wenn Zelle 5 in Colab nicht gestartet wurde oder die Colab-Sitzung pausiert war, pollt kein Worker nach neuen Jobs.

---

## 4. Konkrete Checkliste für den ersten erfolgreichen Live-Test

Sobald der nächste Testlauf gestartet wird, müssen folgende Voraussetzungen erfüllt sein:

1. **Google Drive für Desktop** auf dem PC aktiv und angemeldet.
2. **Im Editor:**
   * Klick auf das Cloud-Symbol → *Einrichten*.
   * Den lokalen Synchronisationsordner von Google Drive auswählen (z. B. `.../airdox-stem-jobs`).
   * Auf *Speichern & Verbindung prüfen* klicken (muss grün bestätigen).
3. **In Google Colab:**
   * `colab/airdox-stem-remote-worker.ipynb` öffnen und auf GPU (T4) schalten.
   * In Zelle 1 `JOB_ORDNER` exakt auf den gleichen Drive-Ordner einstellen (`/content/drive/MyDrive/airdox-stem-jobs`).
   * Zellen 1 bis 5 ausführen. Zelle 5 muss dauerhaft laufen und alle 60 Sekunden `Warte auf Jobs …` ausgeben.
4. **Im Editor:** Track laden und *„Externe Zerlegung (Google Colab)“* auslösen.
5. **Ergebnisüberprüfung:**
   * Editor wechselt von `Wartet auf den externen Rechner` zu `Worker aktiv`.
   * In Colab startet die Inferenz.
   * Nach Fertigstellung importiert der Editor die 4 Stems automatisch.
