# Stem-Laufzeit und Colab Free – Recherche und Umsetzung

Stand: 31.10.2026. Grundlage: aktueller Editor-Quellcode, reale Messungen auf diesem Rechner und die unten verlinkten Primärquellen.

## Entscheidung

Bereits vorhandene Stems lokal wiederverwenden. Neue Tracks lokal mit SCNet berechnen, wenn kein Upload gewünscht ist oder keine kostenlose Colab-GPU bereitsteht. Colab ist eine zusätzliche, manuell gestartete Möglichkeit für neue Trennungen. Ein dauerhaft verfügbarer kostenloser GPU-Dienst lässt sich damit nicht zusichern.

Der bestehende Colab-Pfad verwendet BS-RoFormer für vier Spuren. Das ist ein Qualitätsmodell; der aktuelle Code belegt nicht, dass es das schnellste Modell auf einer zugeteilten Colab-GPU ist. Die lokale SCNet-Optimierung und der Colab-Ablauf sind getrennte Verbesserungen.

## Was kostenlos möglich ist

Colab bietet kostenlose Notebook-Berechnungen mit eventuell zugeteilter GPU. Ressourcen und Laufzeit sind dynamisch begrenzt; die genannte Obergrenze von zwölf Stunden ist keine Zusage. Google schränkt unter anderem verteilte Worker und Fernsteuerung ein. Deshalb wurde der endlose Warteschlangendienst im Notebook durch einen ausdrücklich ausgewählten Einzellauf ersetzt. Das ist keine von Google bestätigte Freigabe der Integration. [Google Colab FAQ](https://research.google.com/colaboratory/faq.html)

Für den hier vorbereiteten Ablauf sind kein Colab Pro, keine gekauften Compute Units, kein Google-Cloud-Projekt und keine kostenpflichtige API vorgesehen. Bei fehlender GPU hält er an. Kein automatisches Upgrade, kein SSH-Tunnel, kein Webserver und keine Keep-alive-Automation sind Teil der Implementierung.

Ein privates Google-Konto hat laut Google bis zu 15 GB gemeinsamen Speicher für Drive, Gmail und weitere Dienste. Der tatsächlich freie Speicher des eigenen Kontos entscheidet, wie viele Tracks hineinpassen. Es wird kein zusätzliches Speicherkontingent gekauft. [Google Drive: Speicher verwalten](https://support.google.com/drive/answer/6374270?hl=de)

„Ohne Kosten“ meint hier ohne zusätzliche Dienstgebühren oder Abos. Vorhandener Internetzugang, Strom und Speicher auf dem eigenen Rechner werden weiter benötigt.

## Voraussetzungen und praktischer Ablauf

1. Kostenloses Google-Konto und freier Drive-Speicher. Google Drive für Desktop synchronisiert einen eigenen Ordner, beispielsweise `My Drive/airdox-stem-jobs`; alternativ unterstützt der Editor bereits rclone. Für die einfachste Einrichtung genügt der Sync-Ordner ohne eigene API-Schlüssel im Editor.
2. Im Editor diesen Ordner unter „Externe Zerlegung einrichten“ speichern und Verbindung prüfen. Bei bereits vorhandenem, passendem Ergebnis lädt die lokale Stem-Bibliothek die Stems ohne neue Separation.
3. Für einen neuen Track die externe Zerlegung starten. Arbeitskopie und Manifest müssen vollständig in Drive angekommen sein. Audio wird damit an Google übertragen; diese Variante ist keine ausschließlich lokale Verarbeitung.
4. Die hier bereitgestellten Dateien `airdox-stem-remote-worker.ipynb` und `airdox-editor-src.tar.gz` nach Drive kopieren. Das Archiv gehört bei unveränderter Notebook-Einstellung in `airdox-stem-jobs/`. Es enthält den aktuellen lokalen Quellcode; ein Git-Clone von main würde unveröffentlichte Änderungen nicht enthalten.
5. Notebook in Colab öffnen und eine kostenlose GPU-Laufzeit wählen, falls verfügbar. Einstellungen und Zelle 1 ausführen, Drive freigeben. Bei mehreren offenen Aufträgen die vollständige gewünschte `JOB_ID` eintragen und diese Zellen wiederholen.
6. Zellen 2–5 ausführen. Der Lauf prüft den Worker, lädt die festgelegte Referenzarchitektur und das benötigte Modell, verifiziert die Dateien und rechnet genau einen Auftrag. Ohne passenden Auftrag oder GPU erfolgt kein Modelldownload.
7. Nach `COMPLETED` Drive-Synchronisierung und lokalen Import abwarten. Die Stems liegen dauerhaft im lokalen `Separation`-Ordner. Danach die Colab-Laufzeit trennen. Nächster Track: neue bewusste Auftragsauswahl; fertige Jobs werden übersprungen.

Wird die Colab-Laufzeit beendet, ist ihr lokales Arbeitsverzeichnis nicht dauerhaft. Bereits nach Drive geschriebene Ergebnisse bleiben dort. Eine unterbrochene Separation besitzt im aktuellen Adapter keinen Zwischenstand zur Fortsetzung und muss erneut beginnen. Fehlerhafte Jobs werden nur nach ausdrücklicher Auswahl wiederholt.

## Laufzeit: die ganze Strecke zählt

Gesamtwartezeit = Laufzeitstart + Einrichtung/Modelldownload + Upload/Drive-Sync + Inferenz + Ergebnis-Sync + lokaler Import.

Rechenbeispiel, keine Messung des Internetanschlusses: Fünf Minuten Stereo mit 44.100 Hz und Float32 benötigen etwa 105,84 MB als WAV-Arbeitskopie. Vier gleich lange Stems benötigen etwa 423,36 MB; zusammen etwa 529,2 MB ohne Zusatzdateien. Allein 105,84 MB Upload bei 10 Mbit/s dauern theoretisch mindestens 84,7 Sekunden. 423,36 MB Download bei 50 Mbit/s dauern mindestens 67,7 Sekunden. Synchronisierung, Protokolloverhead und Modellstart kommen hinzu.

Die Rechnung arbeitet bereits mit einer Kopie unter `/content/airdox-work` und schreibt anschließend Ergebnisse nach Drive. Große Inferenzschleifen sollen nicht bei jedem Fenster Audio über Drive lesen. Modell und Python-Importe werden innerhalb derselben Laufzeit wiederverwendet; der Adapterprozess lädt das Modell bei einem neuen Auftrag erneut. Die dauerhafte lokale Wiederverwendung fertiger Stems spart die gesamte Kette.

Für den Transport bleibt vorerst Float32-WAV erhalten. PCM16/24-FLAC könnte Datenmenge sparen, würde aber die Float32-Arbeitskopie quantisieren und benötigt ein bewusst versioniertes Transportformat. ZIP auf Musik-WAVs ist kein garantierter großer Gewinn. Hier wurde keine verlustbehaftete Transportänderung eingebaut.

## Modelle und sinnvolle Geschwindigkeitshebel

| Weg | Einsatz | Grenzen / nächster Nachweis |
| --- | --- | --- |
| SCNet ONNX lokal | Bereits integrierter schneller Vier-Spuren-Pfad | CPU-Einstellungen auf diesem i3 real vermessen; keine CUDA-GPU vorhanden |
| BS-RoFormer in Colab | Bestehender HQ-Adapter und geprüftes Jobprotokoll | GPU-End-to-End-Lauf und konkrete Dauer stehen noch aus |
| HTDemucs in Colab | Kandidat für einen zusätzlichen Geschwindigkeitsmodus | Eigener Adapter/Modellvertrag und Vergleich mit identischem Audio erforderlich |
| SCNet PyTorch in Colab | Weiterer Kandidat für CUDA | Offizielle Gewichte, Konfiguration und Stem-Reihenfolge explizit integrieren und messen |

Demucs dokumentiert zusätzliche Rechenkosten durch Shifts und das feinabgestimmte Ensemble `htdemucs_ft`. `--two-stems vocals` berechnet weiterhin die vollständige Trennung. Für einen möglichen Geschwindigkeitsmodus deshalb zunächst einfaches `htdemucs`, keine Zusatz-Shifts und keine Ensembles vergleichen; Überlappung erst nach Hör-/Qualitätsprüfung reduzieren. Das ist eine Implementierungsempfehlung, keine bereits gemessene Colab-Beschleunigung. [Offizielle Demucs-Dokumentation](https://github.com/facebookresearch/demucs#separating-tracks)

SCNet hat eine offizielle PyTorch-Inferenz. Der kompakte ONNX-Download des lokalen audiojs-Modells enthält quantisierte Gewichte; die hier verwendete Berechnung läuft trotzdem mit Float32. Eine kleine Modelldatei bedeutet nicht automatisch Int8-Rechenleistung. [SCNet](https://github.com/starrytong/SCNet), [audiojs Neural](https://github.com/audiojs/neural)

MSST stellt mehrere Modellfamilien bereit. Abhängigkeiten sollten passend zur Architektur installiert und Quellcode-Version sowie Checkpoint festgehalten werden. Der Notebook-Stand pinnt die Referenzarchitektur auf `9cc76c03ccd4da5ddf3477e93d386a1648a77732`; Colabs PyTorch-Installation wird nicht absichtlich ersetzt. Zusatzpakete werden noch über Versionsbereiche aufgelöst, daher ist der vollständige Python-Stack noch nicht reproduzierbar eingefroren. [MSST](https://github.com/ZFTurbo/Music-Source-Separation-Training), [Kompatibilität](https://github.com/ZFTurbo/Music-Source-Separation-Training/blob/main/docs/compatibility.md)

GPU-FP16, größere Batches und längere Chunks sind mögliche nächste Versuche. Sie sind keine kostenlosen Geschwindigkeitsgarantien: VRAM, numerische Stabilität, Modellgeometrie und Klang müssen geprüft werden. Unvermessene Änderungen daran wurden nicht aktiviert. Auch ein aufwendiges TensorRT- oder torch.compile-Setup kann bei einzelnen Tracks mehr Startzeit kosten, als es spart.

## Lokale Messung und umgesetzte Änderung

Rechner: Intel Core i3-7020U, zwei physische/vier logische Kerne, rund 19,4 GiB RAM, Intel HD Graphics 620. Die Intel-Grafik wurde nicht als Beschleunigung vorausgesetzt.

Test: identisches zwölfsekündiges Stereo-Audio, reales SCNet-Modell, vier Fenster, PREVIEW-Überlappung unverändert, jeder Lauf mit eigener Worker-/Modellinstanz. Gemessen wird der Workerpfad einschließlich Vor-/Nachverarbeitung; Editorimport und Speicherung sind nicht Teil dieser Zahl.

| Erster Vergleich | Gesamtzeit | Reine Modellaufrufe |
| --- | ---: | ---: |
| Bisherige Einstellungen | 79,63 s | 61,70 s |
| Ein Rechenthread | 146,95 s | 131,67 s |
| Zwei Threads + Speicherwiederverwendung | 48,04 s | 37,15 s |
| Bisherige Einstellungen erneut | 67,30 s | 55,99 s |

Alle Ausgaben waren samplegenau gleich (maximale Abweichung 0). Die optimierte Variante war in diesem Vergleich 29–40 % schneller. Keine Hochrechnung als Zusage für komplette Songs: Hintergrundlast, Temperatur und Audio-/Fensterzahl beeinflussen das Ergebnis.

Umgesetzt: ONNX-Speicherarena und Speichermuster im SCNet-Worker aktiviert, auf Rechnern mit bis zu vier verfügbaren Rechenthreads höchstens zwei Inferenzthreads verwendet. Größere Rechner behalten die automatische Threadwahl. Worker-Isolation, Pause und Abbruch bleiben erhalten. Es werden keine zusätzliche Überlappung und keine Spurqualität eingespart. ONNX erklärt die Abhängigkeit der Threadwahl von Modell und Hardware; mehr Threads allein sind kein verlässlicher Geschwindigkeitsgewinn. [ONNX Runtime Threading](https://onnxruntime.ai/docs/performance/tune-performance/threading.html)

Messdaten: `artifacts/stem-cpu-20261031/report.json`. Der zusätzliche Bestätigungslauf wird separat unter `artifacts/stem-cpu-confirm-20261031/report.json` abgelegt.

Bestätigung über den tatsächlichen Worker-Ladepfad: bisherige Einstellungen 76,74 s, nur explizit zwei Threads 61,03 s, integrierte Optimierung 61,43 s. Wieder maximale Sample-Abweichung 0. Damit sind in diesem zweiten Vergleich rund **20 % weniger Bearbeitungszeit** belegt. Der zusätzliche Vorteil der Speicherarena ließ sich gegenüber explizit zwei Threads in diesem zweiten Durchlauf nicht isoliert bestätigen; der erste Vergleich war günstiger. Die Zahlen sind Einzelmessungen, kein statistisch abgesicherter Benchmark.

## Korrigierte Integrationsfehler

- Notebook läuft mit `--job-id`, `--once`, `--max-jobs 1`; fremde und abgeschlossene Aufträge bleiben unberührt.
- Automatische Wiederholung fehlgeschlagener Jobs und Download ohne offenen Auftrag entfernt.
- GPU-Prüfung vor Einrichtung und Modelltransfer; unbelegte Minutenversprechen entfernt.
- Kein erneutes `git pull` unmittelbar vor Inferenz; Architektur-Commit festgelegt.
- Modell- und Konfigurationsdatei werden vor Verwendung auf SHA256 geprüft. Der Hash der offiziellen HQ-Konfiguration wurde ergänzt.
- Archiv enthält jetzt `colab/remote_worker.py`; der enthaltene Wurzelordner `airdox-editor/` wird korrekt aufgelöst.
- Einrichtungstexte im Editor beschreiben die neue bewusste Notebook-Ausführung.

## Grenze des Nachweises

## Colab-Praxistest am 31.10.2026

Mit dem angemeldeten Konto wurde ein separates Notebook angelegt und eine
T4-Laufzeit ausgewählt. Der GPU-Selbsttest lief erfolgreich:

```text
GPU: Tesla T4
VRAM: 14.56 GiB
PyTorch: 2.11.0+cu130
Python: 3.13.16
```

Eine minimale CUDA-Zelle lief ebenfalls erfolgreich (`COLAB_GPU_PRACTICE_READY`).
Damit ist die Colab-Laufzeit technisch erreichbar und GPU-fähig. Die vollständige
AirDox-Stem-Trennung wurde in diesem Lauf nicht als bestanden markiert: Die
interaktive `files.upload()`-Zelle blieb nach dem Browser-Dateidialog hängen und
wurde abgebrochen; dadurch wurden weder Nutzer-Audio noch das lokale Archiv an
Colab übertragen. Das ist ein Transport-/UI-Problem des aktuellen Testwegs, kein
Nachweis gegen die GPU-Pipeline.

Typprüfung und Produktionsbuild erfolgreich. 15 gezielte Tests bestanden, keiner übersprungen: darunter Notebook-Auswahl mit fehlender GPU/unvollständigem Upload, gezielter Einzellauf, Wiederholungsverhalten, Remote-Protokoll, lokale Bibliothek sowie Worker-Pause und Abbruch.

Die lokalen CPU-Zeiten stammen von echter Inferenz. Die Worker-Protokolltests prüfen Auswahl, Abbruch-/Statusvertrag und Importdateien mit einem Testadapter. Sie beweisen keine echte Colab-GPU-Inferenz. In dieser Sitzung wurden keine Nutzeraudios zu Google hochgeladen und keine kostenpflichtigen Ressourcen aktiviert. Der erste reale Colab-Lauf einschließlich Modellimport, GPU-Speicherbedarf und Drive-Synchronisierung bleibt als End-to-End-Nachweis offen.

## Praxistest-Nachtrag

Der Zugriff auf Colab wurde nach ausdrücklichem Testauftrag mehrfach versucht, einschließlich eines Resets nach dem Schließen von Chrome. Sowohl die Browsersteuerung als auch die alternative Windows-Steuerung scheitern bereits beim Initialisieren mit `failed to write kernel assets: Das System kann den angegebenen Pfad nicht finden. (os error 3)`. Daher weiterhin kein tatsächlicher Colab-GPU-Nachweis und kein Upload.

Das neue Windows-Installationspaket wurde gebaut. Ein zusätzlicher Test im ELECTRON_RUN_AS_NODE-Modus scheiterte an der Auflösung von `onnxruntime-common` aus dem entpackten ASAR-Teil. Dieser Modus entspricht nicht dem normalen Desktop-Start; ein Test in der tatsächlichen Desktop-Anwendung bleibt erforderlich, bevor das Paket als praktisch abgenommen gilt.

## Übergabe-Nachweis (nachgerüstet)

Das Notebook enthält jetzt einen optionalen PRAKTIKUM_SELBSTTEST. Er erzeugt einen kurzen synthetischen Stereo-WAV-Auftrag direkt in Drive, startet den Worker mit --job-id --once --max-jobs 1 auf CUDA und prüft anschließend Manifeststatus, vier WAV-Ausgaben und die Ergebnisdatei. Der Test verändert keinen echten Editor-Auftrag und ist standardmäßig deaktiviert.

Im authentifizierten Colab-Praxistest wurde zusätzlich ein realer Drive-Auftrag verifiziert: Status COMPLETED, drums.wav, ass.wav, other.wav, ocals.wav (je 67,507,664 Bytes) und output/result.json vorhanden. GPU: Tesla T4, 14.56 GiB VRAM.
