# AirDox 0.4.4 – Windows-Paket mit Nachweiskette

## 1 · Was ist bereits geprüft?

Dieses ZIP enthält **EXEs, Notebook, Worker, Rohlogs, Testergebnisse und
Prüfskript gemeinsam**. Kein separater CI-Download ist zur Einsicht nötig.

| Datei | Zweck |
|---|---|
| `airdox_SMART_Editor-0.4.4-setup.exe` | Windows-Installation |
| `airdox_SMART_Editor-0.4.4-portable.exe` | Portable Anwendung |
| `NACHWEISKETTE.json` | Commit, Workflow, Teststufen und Hash/Größe aller Lieferdateien |
| `PRUEFEN.ps1` | Offline-Prüfung dieser Dateien, nur lesend |
| `NACHWEISE/*.json` und `*.log` | Wirklich ausgeführte Befehle, Exitcodes, Zeiten und Rohlogs |
| `NACHWEISE/model-live-tests.json` | Echter Modelltest ohne erlaubten Skip |
| `NACHWEISE/remote-real-model-evidence.json` | 44,1/48-kHz-Modelllauf plus Editor-Rückimport, Originalhashes |
| `NACHWEISE/notebook-execution.json` | SHA256 des tatsächlich ausgeführten Export-Notebooks und Stoppzelle |
| `NACHWEISE/notebook-preauth-report.json` | Echte Vorbereitung/Testtrennung; `AUTH_REQUIRED`, Google nicht getestet |
| `NACHWEISE/windows-tests-tests.json` | Gesamtsuite einschließlich ausdrücklich aufgeführter Skips |
| `windows-smoke.json` und `.png` | Gepackte Windows-App, Renderer, IPC, enthaltene Dateien |
| `Colab/` | Passendes selbstenthaltendes Notebook, Worker-ZIP und Vorbereitungsnachweise auch innerhalb der EXE |
| `NACHWEISE/COLAB_AUTH_RECHERCHE.md` | Recherche, Entscheidung und offizielle Quellen |

**Keine versteckten Skips:** optionale lokale Engines/Qualitäts-Livetests der
Gesamtsuite können mangels ihrer anderen Gewichte übersprungen sein. Ihre
Namen/Gründe stehen im Bericht. Der für diesen Fernpfad maßgebliche echte
Modelltest und die exportierte Notebook-Vorbereitung dürfen nicht fehlen oder
übersprungen werden; sonst entsteht kein Windows-Downloadpaket.

## 2 · Integrität vor dem Start prüfen

1. ZIP vollständig in einen eigenen Ordner entpacken.
2. PowerShell dort öffnen. `& .\PRUEFEN.ps1` ausführen, soweit die eigene
   Ausführungsrichtlinie dies erlaubt. Das Skript vor dem Ausführen einsehen.
   Keine globale Sicherheitsrichtlinie ändern.
3. Erwartung: `PASS` für sämtliche Dateien und Pflichtstufen. Fehlende,
   abweichende oder beschädigte Dateien führen zu `FAIL`/Exitcode 1.

SHA256 ist **keine digitale Herausgebersignatur**. Wird das ganze Paket samt
Manifest ausgetauscht, kann es weiterhin in sich konsistent sein. EXEs sind
nicht Windows-code-signiert. Den Download ausschließlich aus dem bekannten
Repository/Workflow beziehen; der Source-Commit und die Workflow-URL stehen
im Manifest. Das Manifest hasht sich nicht selbst (sonst ein Zirkelschluss).

## 3 · Bis zur persönlichen Freigabe

1. EXE starten → Einrichtung der externen Zerlegung.
2. „Nachweise prüfen“ zeigt den **mitgelieferten CI-Stand**, nicht einen
   angeblichen Modelltest auf diesem PC. Die eingebetteten Dateien werden
   dabei lokal neu gehasht.
3. „Notebook speichern & Colab öffnen“ legt ausschließlich eine neue
   `.ipynb`-Datei an und öffnet die feste offizielle Colab-Adresse im normalen
   Browser. Keine Passwörter oder Tokens werden gespeichert/übernommen.
4. Colab kann **jetzt bereits die Google-Anmeldung** verlangen. Diese müssen
   Sie persönlich im Google-Browserdialog durchführen. Im Colab-Dialog das
   gespeicherte Notebook über „Hochladen“ öffnen.
5. Laufzeit wählen (GPU empfohlen). Zellen bis `AUTH_REQUIRED` ausführen:
   ZIP-/Dateihashprüfung → isolierte Installation → Modellprüfung → echte
   Testtrennung. Es ist **kein ZIP-Upload nach Drive** erforderlich.
6. Erst die markierte nächste Zelle verlangt den Drive-Zugriff. Die
   Zugriffsfreigabe ist nicht durch die vorherigen Tests erledigt.

Damit wird keine fehlende Nutzerautorisierung als Softwarefehler behandelt,
aber auch kein lokaler/CI-Test als erfolgreiche Google-Sitzung ausgegeben.

## 4 · Nach der Freigabe: persönlicher Ende-zu-Ende-Nachweis

1. Google Drive für Desktop auf Windows muss legitim angemeldet/synchronisiert
   sein. Im Editor einen eigenen Jobordner in „Meine Ablage“ auswählen.
2. Im Notebook `JOB_ORDNER` auf denselben relativen Ordnernamen setzen.
   Google-Bedingungen/Tarif prüfen; `WORKERBETRIEB_BESTAETIGT=True` setzen,
   wenn diese konkrete Nutzung zulässig ist. Das Notebook kauft kein Abo.
3. Drive-Zelle freigeben, dann Worker-Zelle starten. Standardmäßig beendet
   sich der Worker nach **einem** Job; für einen weiteren Job erneut starten.
4. Im Editor „Speichern & prüfen“: ein frischer Zufallswert muss über die
   Jobablage zum Worker und zurück kommen. Nur ein beschreibbarer Ordner oder
   altes Lebenszeichen ist **kein** bestandener Hin-/Rückweg. Die Anzeige
   aktualisiert sich bei offenem Dialog automatisch; Sync kann Minuten brauchen.
5. Anschließend eine Arbeitskopie eines Tracks trennen. Abnahme gemäß
   `NACHWEISE/COLAB_ABNAHME.md`: vier Stems zurückimportiert, Rate/Frames/Hashes
   korrekt, Originale unverändert. Erst dieser Lauf belegt die persönliche
   Google-/Drive-Strecke. Ein kurzer Test ist kein Qualitätsurteil über alle Tracks.

## Aussagegrenzen

- Linux-CPU-Modelltest ≠ Colab-GPU-Nachweis.
- Windows-Smoke startet die gepackte `win-unpacked`-Anwendung; der Installer-
  Dialog und der Portable-Selbstentpacker sind nicht separat durchgeklickt.
- Die EXE enthält Vorbereitungsnachweise. Ihr eigener späterer Build/Smoketest
  kann nicht vorab in derselben EXE stehen; diese Nachweise und die EXE-Hashes
  stehen deshalb gemeinsam im äußeren Downloadpaket.
- Es wurden keine Google-Zugangsdaten verwendet, keine kostenpflichtigen
  Cloud-Ressourcen angelegt und keine Nutzeroriginale für CI gelesen.
- Der gebündelte Musik-Testausschnitt hat CC BY-NC-SA 3.0; Attribution im
  Worker-ZIP unter `tests/fixtures/musdb-falcon69/README.md`. Er ist kein vom
  Nutzer lizenzfreigestellter Track und nicht für kommerzielle Verwertung gedacht.
