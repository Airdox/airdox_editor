# Colab v2 – Einrichtung und Abnahme (AirDox 0.4.4)

## Einrichtung auf Windows

1. Neue AirDox-EXE starten, „Externe Zerlegung (Google Colab)“ → Einrichtung.
2. Einen eigenen **synchronisierten** Drive-Unterordner wählen, etwa
   `G:\Meine Ablage\airdox-stem-jobs`. Ein beliebiger lokaler Ordner genügt nicht.
3. „Nachweise prüfen“ prüft die eingebetteten Lieferdateien lokal. Der angezeigte
   Modell-/Notebook-Test stammt aus CI, nicht von diesem PC. Die komplette
   Kette bis zu den fertigen EXEs liegt im Download unter `NACHWEISKETTE.json`.
4. „Notebook speichern & Colab öffnen“: Notebook bei Colab hochladen; die
   Anmeldung bei Google kann bereits hier nötig sein. **Kein Worker-ZIP nach
   Drive kopieren.** Die Vorbereitungszellen prüfen ihren eingebetteten Inhalt,
   installieren die Runtime und trennen den echten Testausschnitt automatisch.
5. Erst nach `AUTH_REQUIRED` die markierte Drive-Zelle persönlich freigeben.
   `JOB_ORDNER` muss zum Pfad relativ zu „Meine Ablage“ passen. Google-Bedingungen
   und Tarif prüfen, `WORKERBETRIEB_BESTAETIGT=True` setzen und den Worker bewusst
   starten. Standard: ein Auftrag, dann beenden. Keine Tokens weitergeben.
6. Nach „BEREIT“ im Editor „Speichern & prüfen“ anklicken. Ein neuer Zufallswert
   wird zum Worker gesendet und muss zurückkommen. Ordnerzugriff, Lebenszeichen
   und bestätigter Hin-/Rückweg sind getrennte Nachweise.
7. Track laden und externe Zerlegung starten. Nur **eine** Colab-Sitzung und
   ein Editor pro Jobordner; Drive bietet keine verteilten atomaren Sperren.

Colab-Sitzungen sind zeitlich begrenzt. Nach einem Ende/Neustart muss der Worker
wieder gestartet werden. Ein GPU-Platz wird von Google nicht garantiert.
Der unterstützte Fernpfad verwendet BS-RoFormer MUSDB18HQ (vier Stems).
48-kHz-Arbeitskopien werden lokal im Worker für das 44,1-kHz-Modell umgerechnet;
Ergebnisse werden anschließend in die ursprüngliche Samplerate zurückgeführt.

## Was als Nachweis zählt

**Protokolltest:** Editor → Ablage → echter Python-Worker mit Testadapter →
Import. Belegt Steuerung, Abbruch, Wiederaufnahme und Dateiverträge, aber keine
trainierte Separation und keine Google-Verbindung.

**Echter Modelltest:** derselbe Weg mit dem produktiven Adapter, verifiziertem
Checkpoint und realem Audiomaterial. Belegt eine funktionierende Berechnung,
keine pauschale Aussage über musikalische Trennqualität, Colab oder Windows-GPU.

**Windows/Colab-Abnahme:** die folgenden Schritte in einer echten Sitzung.
Ein GitHub-Actions-CPU-Lauf ist ausdrücklich kein Ersatz für diese Abnahme.

| Prüfung | Erwartung / festzuhaltender Nachweis |
|---|---|
| Versionen | EXE-Version, `bundle.json`, Colab-Ausgabe des Quellstands |
| Bereitschaft | Ordner erreichbar, frisches Worker-Lebenszeichen UND neue Challenge beantwortet |
| Echter Auftrag | Job-ID aus Windows im Colab-Log wiederfinden |
| Übernahme | Worker-ID, Gerät und Lebenszeichen sichtbar |
| Ergebnis | Vier SHA256-geprüfte Stems, Status erst nach lokalem Import fertig |
| Wiedergabe | Vocals, Drums, Bass, Other einzeln im Editor hörbar |
| Originalschutz | SHA256 des Originals vor/nach dem Lauf identisch |
| Abbruch | Während Berechnung abbrechen; kein nachträglicher Ergebnisimport |
| Neustart | Editor schließen, nach Worker-Abschluss öffnen; Ergebnis importierbar |
| Netzunterbrechung | Drive-Verbindung kurz trennen, wiederherstellen; kein stiller Hänger |
| Worker fehlt | Notebook stoppen; kein „bereit“, verständliche Meldung nach Zeitgrenze |

## Diagnose

Menü **Hilfe → System-Protokoll → Log-Ordner**. Die aktuelle Tagesdatei enthält
mehr Informationen als der UI-Ringpuffer. Zusätzlich aus der Jobablage sichern:

- `preauth-report.json` – tatsächliche Vorbereitung dieser Laufzeit (nach Freigabe kopiert)
- `connection/request.json`, `connection/response.json` – neue Zufallsanforderung/Antwort
- `worker.json` – Worker-Bereitschaft, Version, Gerät, letztes Lebenszeichen
- `jobs/<jobId>/manifest.json`, `claim.json`, ggf. `error.json`
- `jobs/<jobId>/logs/worker.log`
- bei Erfolg `jobs/<jobId>/output/result.json`

Keine Audiodateien, Zugangsdaten oder vollständigen Drive-Inhalte für eine
gewöhnliche Fehlerdiagnose weitergeben. Personenbezogene Pfade ggf. schwärzen.

Standardgrenzen: 10 Minuten bis Worker-Übernahme, 3 Minuten ohne Lebenszeichen,
10 Minuten Synchronisierungsfrist für Ergebnisse, 6 Stunden Gesamtzeit.
Bei Worker-Abbruch Job im Editor abbrechen/neu starten; alte Ergebnisse werden
nicht als Ergebnis eines neuen Jobs angenommen. Bereits erfolgreich importierte
Ergebnisse bleiben lokal erhalten.


Ausführliche Schrittfolge: [START_HIER](COLAB_START_HIER.md).
Recherche zur offiziellen CLI-/OAuth-Automatisierung und ihren Grenzen:
[COLAB_AUTH_RECHERCHE.md](COLAB_AUTH_RECHERCHE.md).
