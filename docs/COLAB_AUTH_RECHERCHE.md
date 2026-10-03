# Google-Autorisierung und Automatisierung – technische Entscheidung

Stand: 04.10.2026 · AirDox 0.4.5

## Untersuchte offizielle Wege

| Weg | Was automatisierbar ist | Verbleibende Voraussetzung | Entscheidung |
|---|---|---|---|
| Offizielles `google-colab-cli` | Laufzeiten, Ausführung von Skripten/Notebooks, Dateien und Sitzungen | Python ≥3.12; laut aktueller README Linux/macOS; legitime OAuth-/ADC-Anmeldung, Berechtigungen, verfügbare Ressourcen | Zusatzweg implementiert: Version 0.7.4 und Wheel-SHA256 festgelegt; echte CLI-Ausführung bis zur OAuth-Code-Eingabe. Linux/macOS bzw. WSL, **nicht native Windows-Unterstützung**. |
| Native Desktop-OAuth-App | Autorisierung über Systembrowser und registrierten Loopback-Redirect | Eigenes korrekt registriertes Desktop-OAuth-Projekt, Scopes, State/PKCE und sichere Tokenspeicherung; Drive-OAuth ≠ Colab-Anmeldung | Kein improvisierter OAuth-Client; würde die Notebook-Anmeldung nicht ersetzen. |
| Colab Enterprise Scheduling | Planbare Notebook-Jobs mit Cloud-IAM | Cloud-Projekt, APIs, IAM/Servicekonto, GCS, Abrechnung | Kein stilles Provisionieren kostenpflichtiger Ressourcen. |
| Selbstenthaltendes Notebook | Paketentpacken, Installation, Hash-/Modellprüfung und Testtrennung ohne Drive-Zugriff | Google kann bereits zum Öffnen/Starten von Colab eine Anmeldung verlangen; Drive-Freigabe danach persönlich | **Implementierter Windows-Auslieferungsweg.** |

## Warum „alles vor der Authentifizierung“ zwei Grenzen hat

1. **Anmeldung bei Colab selbst:** ohne legitim angemeldete Google-Sitzung lässt
   sich keine persönliche Google-Laufzeit beanspruchen. Der Agent erhält keine
   Passwörter, Browsercookies, Refresh-Tokens oder Autorisierungscodes.
2. **Drive-Mount:** erst nach erfolgreicher Vorbereitung ruft das Notebook
   `google.colab.drive.mount()` auf. Google kann hier zusätzlich die Zustimmung
   verlangen. Das ist kein Ersatz für Schritt 1 und keine einmalig garantierte
   Dauerfreigabe.

Die CI führt dieselben exportierten Vorbereitungszellen auf Linux/CPU aus –
einschließlich Installation in einer neuen Python-Umgebung und echter Inferenz.
Sie stoppt **vor** der mit `AIRDOX_AUTH_GATE` markierten Zelle. So ist die
Vorbereitung tatsächlich ausführbar nachgewiesen, ohne eine Google-Sitzung zu
behaupten. Der CUDA-Paketindex und Google-GPU-Hardware sind davon nicht abgedeckt.

## Details zum offiziellen CLI (nicht mit dem Notebook verwechseln)

Die aktuelle README und tieferen Auth-Dokumente nennen unterschiedliche
Standardverfahren (ADC bzw. OAuth2). Der implementierte Helfer wählt deshalb
explizit `--auth=oauth2` und pinnt Version 0.7.4 samt Wheel-Hash. `colab auth` betrifft
zusätzlich die **GCP-Anmeldung in der Laufzeit**, nicht einfach den Login des
steuernden CLI. Drive-Mount ist eine weitere Berechtigungsgrenze.

Die dokumentierte gebündelte OAuth2-Variante verwendet den Google-SDK-Remote-
Redirect und eine lokale Codeeingabe. Das ist nicht das veraltete, blockierte
Out-of-Band-Verfahren. Ein eigener OAuth-Client kann nicht ohne passende
Redirect-Registrierung eingesetzt werden. Diese Recherche rechtfertigt weder
Cookie-Extraktion noch Tokenweitergabe im Chat. Ab 0.4.5 liegt `Colab/CLI_AUTORISIERUNG.py` als zusätzlicher Linux-/WSL-Weg
im Windows-Downloadpaket. Er bereitet den offiziellen CLI vor und prüft seinen
echten Autorisierungseinstieg. Er macht daraus keine native Windows-Funktion.

## Implementierte Schritte und Nachweise

1. Deterministisches ZIP aus Worker, Setup, Adapter, Katalog und lizenziertem
   Testausschnitt; Dateihashes und Source-Commit im Bundle.
2. ZIP als Base64 mit SHA256 direkt im ausgelieferten Notebook – kein vorheriges
   Hochladen nach Drive, keine GitHub-Anmeldung zum Download des privaten Repos.
3. Isoliertes Python 3.11, gepinnte direkte Abhängigkeiten, `pip check`.
4. Gepinnter Modellcheckpoint, SHA256-Prüfung, Produktionsadapter-Preflight.
5. Echter 2-Sekunden-Musikausschnitt bei 44,1/48 kHz über den Produktionsworker;
   vier Stems, Audio-Geometrie, endliche/nichtleere Werte, Output- und Inputhash.
6. `AUTH_REQUIRED` erst nach Erfolg, andernfalls Abbruch. Kein Drive-Import
   vorher. Prüfbericht bleibt in der Laufzeit und wird nach Zustimmung in die
   Jobablage kopiert.
7. Windows-Auslieferung hängt zwingend vom Modell-/Notebook-Job derselben
   Revision und desselben Workflow-Laufs ab. Rohlogs und JSON-Berichte werden
   eingebettet und mit den fertigen EXEs in einer Hash-Nachweiskette ausgeliefert.
8. App bietet sicheres Speichern des Notebooks und Öffnen der festen offiziellen
   Colab-Adresse; vorhandene Dateien und Originalquellen werden nicht überschrieben.
9. Nach Freigabe prüft ein neuer Zufalls-Challenge den Hin-/Rückweg zum Worker;
   das ersetzt nicht den anschließenden vollständigen Audiotest im Nutzerkonto.

## Nutzungsbedingungen und Kosten

Der kostenlose verwaltete Colab-Dienst beschränkt unter anderem verteilte
Worker und Umgehung der Notebook-Oberfläche. Ein externer Editor-Worker darf
nicht durch eine versteckte/unbeaufsichtigte Sitzung als garantiert kostenloser
Dienst dargestellt werden. Deshalb erfordert der Start eine ausdrückliche
Bestätigung der Nutzungs-/Tarifbedingungen und beendet sich standardmäßig nach
einem Job. Das ist **keine Zusicherung**, dass eine konkrete Nutzung zulässig
ist; aktuelle Google-Bedingungen sind maßgeblich. Kein Abo, Cloud-Projekt oder
kostenpflichtiger Job wird durch die Windows-App angelegt.

## Offizielle Quellen

- https://github.com/googlecolab/google-colab-cli (README: Plattformen, Befehle)
- https://github.com/googlecolab/google-colab-cli/blob/main/pyproject.toml (Python-Version)
- https://github.com/googlecolab/google-colab-cli/blob/main/docs/04_automation_and_utility.md (OAuth2/ADC und Laufzeit-Auth)
- https://github.com/googlecolab/google-colab-cli/discussions/50 (Windows-Diskussion; keine Supportgarantie)
- https://developers.google.com/identity/protocols/oauth2/native-app (native OAuth-Apps)
- https://datatracker.ietf.org/doc/html/rfc8252 (OAuth über externen Browser)
- https://research.google.com/colaboratory/faq.html (Drive-Freigabe, Ressourcen, Nutzungsgrenzen)
- https://docs.cloud.google.com/colab/docs/schedule-notebook-run (Enterprise-Scheduling)

Die CLI-Recherche wurde gegen Quellstand
`a84e094c67544e70d88649ba2d2a1d48511b3af7` gegengeprüft (kein installiertes CLI).

Web-Dokumente können sich nach diesem Stand ändern. Keine der Quellen belegt
einen erfolgreichen Lauf im Google-Konto des Nutzers.


## Konkrete CLI-Lösung ab 0.4.5: bis zur echten Eingabegrenze

Die veröffentlichte Distribution wurde direkt auf PyPI recherchiert und ihr
Authentifizierungscode im Wheel überprüft:

- Paket `google-colab-cli==0.7.4`, Python mindestens 3.12.
- Wheel `google_colab_cli-0.7.4-py3-none-any.whl`.
- SHA256 `1435f3533a7064f27b8b81252da85370427d6cf93b94e6c34737bd1cc68ec292`.
- Quelle: https://pypi.org/project/google-colab-cli/0.7.4/

Der Helfer lädt ausschließlich dieses geprüfte Wheel von PyPI, installiert es
in einer eigenen Umgebung und führt `pip check` aus. Dann startet er das
**tatsächlich installierte CLI** mit `--auth=oauth2 ... whoami` in einem frischen,
zugangsdatenfreien HOME und mit geschlossener Standardeingabe. Erwartet werden
die Google-OAuth-Adresse, der registrierte SDK-Redirect und die Aufforderung
`Enter the authorization code:`. Erst dann lautet der Befund `AUTH_REQUIRED`.
Ein beliebiger Fehler oder Netzfehler zählt ausdrücklich nicht als Erfolg.

Der veröffentlichte Bericht enthält Version, Wheel-Hash, installierte Pakete,
Scopes, Exitcode und die erreichte Grenze. OAuth-State, vollständige
Autorisierungs-URL, Codes und Tokens werden **nicht** in den Bericht übernommen.
Die Eingabe wurde absichtlich nicht bedient; es wurde keine Identität bei
Google verifiziert und keine Laufzeit angelegt. Auch ein erzeugter OAuth-Link
beweist noch nicht, dass Google das konkrete Konto/den Tarif akzeptieren wird.

### Persönliche Anmeldung – nur am eigenen Rechner

1. Optional vorhandenes Linux/macOS oder WSL mit Python >=3.12 verwenden.
   Windows-Nutzer ohne WSL bleiben beim selbstenthaltenden Notebook. Der Helfer
   aktiviert keine Windows-Systemfunktionen und installiert kein WSL.
2. Im entpackten Paket in den Ordner `Colab` wechseln und ausführen:
   `python3 CLI_AUTORISIERUNG.py prepare --report "$HOME/airdox-cli-auth-boundary.json"`.
3. Der automatische Test endet bei `AUTH_REQUIRED`, ohne eigene Konten anzufassen.
4. Für die persönliche Freigabe ausdrücklich in **diesem eigenen Terminal**:
   `python3 CLI_AUTORISIERUNG.py login --consent`.
5. Den vom offiziellen CLI angezeigten Google-Link im Browser öffnen. Scopes
   sorgfältig prüfen: Profil/E-Mail, Cloud Platform, Colaboratory und `drive.file`
   gehören zu den vom CLI angeforderten Berechtigungen. Bei fehlendem Vertrauen
   abbrechen, nicht bestätigen.
6. Den von Google angezeigten einmaligen Code ausschließlich im eigenen
   Terminal eingeben, **niemals im Chat**. Der Login-Aufruf wird nicht protokolliert.
7. Das CLI prüft anschließend die angemeldete Identität. Dies ist noch kein
   Drive-Mount und kein gestarteter GPU-Auftrag. Ressourcen werden nicht angelegt.

Der Helfer legt seine Runtime standardmäßig unter
`~/.local/share/airdox/colab-cli-0.7.4/` an. Zugangsdaten landen erst beim
persönlichen Login in dessen `credentials-home/.config/colab-cli/token.json`;
Verzeichnisrechte sind privat und neue Dateien erhalten durch umask 077 nur
Benutzerzugriff. Diese Daten niemals in ein Support-/Downloadpaket kopieren.
Berechtigungen lassen sich unter https://myaccount.google.com/permissions
widerrufen. Die vorbereitende CI besitzt diese Zugangsdaten nicht.

## Tatsächlicher Paketdownload statt nur Build-Verzeichnis

Ein nachgelagerter Job lädt auf einem **frischen Windows-Runner** den gebauten
Kandidaten herunter. Er prüft verpflichtende Dateinamen, jede Größe/jeden Hash,
die acht Pflichtstufen, den Source-Commit und den CLI-Grenzbericht. Zusätzliche
nicht verzeichnete Dateien werden ebenfalls abgelehnt. Danach werden
`NACHWEISE/download-audit.json` und `PAKET_INHALT.txt` beigefügt, das Manifest
aktualisiert und der endgültige Inhalt nochmals mit dem ausgelieferten Prüfer
geprüft. Erst danach wird das endgültige Downloadartefakt veröffentlicht.

Zusätzlich wird für diese Korrekturlieferung das bisherige Artefakt 0.4.4 mit ID
11288317441 aus Lauf 37162349219 separat heruntergeladen und untersucht. Der
Befund steht in `NACHWEISE/previous-package-audit.json`. Das beschreibt das
GitHub-Artefakt, nicht eine unbekannte Datei auf dem Nutzer-PC. Historische
Artefakte unterliegen der GitHub-Aufbewahrungsfrist; dieser Vergleich ist an
jene konkrete Korrekturlieferung gebunden.
