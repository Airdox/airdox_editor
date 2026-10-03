# Rekordbox-Import auf dem Windows-PC wirklich prüfen

Diese Anleitung führt vom lokalen Repository bis zum echten Importversuch mit
`D:\PIONEER`. Sie ist für PowerShell geschrieben und setzt keine
Programmierkenntnisse voraus.

> **Wichtig:** Die echten Dateien auf `D:\PIONEER` sind nur auf dem Windows-PC
> erreichbar, an den das Laufwerk angeschlossen ist. Die hier beschriebenen
> Prüfungen müssen daher dort ausgeführt werden; ein grüner Linux-/CI-Test ist
> kein Ersatz für den echten SQLCipher-/ANLZ-Lauf.

## Was die Prüfungen tun – und was nicht

- `master.db`, `exportLibrary.db`, XML, ANLZ (`.DAT`, `.EXT`, `.2EX`) und
  Original-Audio werden ausschließlich gelesen. Die Datenbankverbindung wird
  read-only geöffnet; Datenbank, ANLZ und Audio werden während des Zugriffs
  auf unveränderte Dateigröße und Änderungszeit (mtime) geprüft.
- Der SQLCipher-Funktionstest erstellt kurzzeitig eine **separate Probe-Datei
  im Windows-Temp-Ordner** und entfernt sie danach. Er schreibt nichts auf
  `D:\PIONEER`.
- Der Import verlangt die feste Kette **Datenbank → echte Rekordbox-ANLZ →
  Original-Audio**. Eine fehlende Quelle ist ein Fehler; die App berechnet
  keine Ersatz-Waveform, FFT oder Beatgrid. Ein erfolgreicher Import muss als
  Analyseherkunft `REKORDBOX_ANLZ` ausweisen.
- Export- und Projektdateien werden getrennt und nur unter einem neuen,
  ausgewählten Zielpfad gespeichert. Ein Export darf niemals eine Quelldatei
  überschreiben.

## 1. Vor dem Start: Rekordbox-Dateien nur ansehen

1. Verbinde das Laufwerk und prüfe im Explorer, dass `D:\PIONEER` erreichbar
   ist.
2. Beende Rekordbox vollständig, damit Rekordbox die Datenbank nicht während
   unserer Prüfung aktualisiert.
3. Öffne **PowerShell** und führe diese reine Suchabfrage aus:

```powershell
$dbFiles = Get-ChildItem -LiteralPath 'D:\PIONEER' -Recurse -File `
  -Filter '*.db' -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -in @('master.db', 'exportLibrary.db') }
$dbFiles | Select-Object FullName, Length, LastWriteTime | Format-Table -AutoSize
```

Die Ausgabe zeigt den genauen Datenbankpfad, die Größe und die Änderungszeit.
Es wird nichts angelegt oder verändert. Die Suche kann bei einem großen
Laufwerk etwas dauern.

- `master.db` ist die normale lokale Rekordbox-Bibliothek.
- `exportLibrary.db` ist eine OneLibrary-/Device-Library-Datenbank.
- `D:\PIONEER\Master\master.db` ist die typische Ablage einer **extern
  geführten** Bibliothek (Rekordbox-Bibliothek auf einem eigenen Laufwerk).
  Dieser Unterordner `Master` wird mit durchsucht.
- Der automatische Suchweg kennt `D:\PIONEER` sowie die Unterordner `Master`,
  `rekordbox7`, `rekordbox6` und `rekordbox` (Groß-/Kleinschreibung egal). Er
  durchsucht nicht beliebig das ganze Laufwerk. Ein explizit gesetzter Pfad
  (Schritt 4) ist für eine anderswo abgelegte Datei gedacht.
- Existieren beide Datenbanktypen, hat `master.db` innerhalb der gefundenen
  Kandidaten Vorrang. Der Doctor zeigt später den tatsächlich gewählten Pfad.
  **Dateien nicht umbenennen oder verschieben**, um die Suche zu beeinflussen.

### Analysis-Data-Root (wo die ANLZ-Dateien liegen)

Rekordbox speichert in `djmdContent.AnalysisDataPath` keine vollständigen
Pfade, sondern Pfade relativ zum **Analysis-Data-Root**
(`/PIONEER/USBANLZ/…`). Der Root steht in derselben `options.json` wie der
Datenbankpfad, unter dem Schlüssel `analysis-data-root-path`. Bei einer
extern geführten Bibliothek ist das z. B. `D:\\PIONEER\\Master\\share` – die
Datei liegt dann unter
`D:\\PIONEER\\Master\\share\\PIONEER\\USBANLZ\\…`. **Nicht** unter
`D:\\PIONEER\\USBANLZ\\…`.

Diese reine Leseabfrage zeigt beide Einträge an:

```powershell
$optionsPath = Join-Path $env:APPDATA 'Pioneer\rekordboxAgent\storage\options.json'
if (Test-Path -LiteralPath $optionsPath) {
  $options = Get-Content -LiteralPath $optionsPath -Raw | ConvertFrom-Json
  $options.options | Where-Object { $_[0] -in @('db-path', 'analysis-data-root-path') } |
    ForEach-Object { [pscustomobject]@{ Key = $_[0]; Value = $_[1] } } | Format-Table -AutoSize
} else {
  "options.json nicht gefunden: $optionsPath"
}
```

Der Gate löst relative `/PIONEER/...`-Pfade genau gegen diesen Root auf
(`editor_patch/analysisPath.cjs`); erster Kandidat ist immer
`analysis-data-root-path`. Steht dort ein anderer oder veralteter Pfad,
meldet der Doctor `ANLZ_NOT_FOUND` und nennt die geprüften Kandidaten. Die
`options.json` darf dafür nicht umbenannt oder bearbeitet werden – sie ist
eine Rekordbox-Datei.

Falls die Datenbanksuche keine Ausgabe liefert, prüfe, ob das richtige
Laufwerk angeschlossen ist und ob sich die Datenbank tatsächlich in diesem
Ordnerbaum befindet. Rekordbox kann zusätzlich eine Datenbank in seinem AppData-Ordner
haben; der Doctor meldet, welche Datei er gefunden hat.

## 2. Das richtige Repository und Werkzeuge öffnen

Verwende ein Repository, das die aktuelle Änderung enthält. Wenn das Projekt
noch nicht auf dem PC liegt, klone den Arbeitsbranch:

```powershell
git clone --branch arena/01a0f5aa-airdox-editor --single-branch `
  https://github.com/Airdox/airdox_editor.git "$HOME\airdox_editor"
```

Wenn du bereits einen Clone hast und den lokalen Branch noch nicht angelegt
hast, hole ihn so:

```powershell
git fetch origin arena/01a0f5aa-airdox-editor
git switch --track -c arena/01a0f5aa-airdox-editor origin/arena/01a0f5aa-airdox-editor
```

Falls der lokale Branch bereits existiert:

```powershell
git fetch origin
git switch arena/01a0f5aa-airdox-editor
git pull --ff-only origin arena/01a0f5aa-airdox-editor
```

Wenn Git wegen eigener, ungesicherter Änderungen nicht wechseln oder
aktualisieren kann, **nicht** `git reset` ausführen: Änderungen zuerst sichern
oder eine frische Kopie in einen neuen Ordner klonen.

Wechsle danach in den Repository-Ordner. Bei einem neuen Clone ist das der
folgende Pfad; bei einem bestehenden Clone musst du ihn gegebenenfalls
anpassen:

```powershell
Set-Location -LiteralPath "$HOME\airdox_editor"
Test-Path .\scripts\run-electron-node.mjs
node --version
npm --version
git --version
git branch --show-current
```

`Test-Path` muss `True` ausgeben. Node.js **20 oder neuer** (LTS empfohlen),
Git und npm müssen installiert sein. Falls `Test-Path` `False` meldet, ist
hier ein älterer Repository-Stand geöffnet; führe die folgenden Tests damit
noch nicht aus.

Installiere anschließend genau die im Lockfile festgelegten Abhängigkeiten:

```powershell
npm ci
```

`npm ci` ersetzt nur den Ordner `node_modules` dieses Repositorys. Es löscht
keine Rekordbox-Dateien und ändert keine Quelldateien auf `D:\PIONEER`. Der
Vorgang benötigt Internetzugriff und kann einige Minuten dauern.

## 3. SQLCipher für Electron bauen

Das native Modul muss zu der im Projekt verwendeten Electron-Version passen.
Baue es deshalb mit dem Projektbefehl und nicht mit einem gewöhnlichen
`npm rebuild`:

```powershell
npm run rekordbox:native:rebuild
npm run rekordbox:native:check
```

Der erste Befehl erzwingt den Build; der zweite muss danach `Status: OK`
melden. Der Build kann passende vorgefertigte Dateien laden oder lokal
kompilieren. Wenn eine Kompilierung fehlschlägt, installiere **Visual Studio
Build Tools** mit der Workload **Desktopentwicklung mit C++** (MSVC und ein
Windows SDK); installiere bei einer expliziten Python-/node-gyp-Meldung auch
Python 3. Schließe danach PowerShell, öffne es erneut und wiederhole den
Build.

Eine Meldung des Build-Skripts, dass das Binary aus der normalen Node-Version
nicht ladbar ist, ist allein **kein** Beweis für einen Fehler: Das Modul ist
für Electron gebaut. Entscheidend ist der nächste Test, der Electron selbst
startet. Bei TLS-/Zertifikatsfehlern beim Download bitte Netzwerk, Proxy,
Unternehmenszertifikat und Systemdatum prüfen; die Zertifikatsprüfung nicht
deaktivieren.

## 4. Native Laufzeit und echte Datenbank prüfen

```powershell
npm run rekordbox:preflight -- --require-db
```

Dieser Befehl muss mit Exit-Code `0` enden. Er prüft in Electron:

1. Electron-Version und ABI;
2. ob `better-sqlite3-multiple-ciphers` tatsächlich geladen werden kann;
3. ob SQLCipher eine temporäre verschlüsselte Probe-Datei schreiben und
   wieder lesen kann;
4. ob eine unterstützte Rekordbox-Datenbank read-only geöffnet werden kann
   und ihre Größe/mtime gleich bleiben.

`--require-db` macht eine fehlende Datenbank zu einem Fehler statt zu einem
unauffälligen Überspringen. Der Preflight weist **noch nicht** nach, dass ein
bestimmter Track eine passende ANLZ-Datei und lokales Audio besitzt; dafür
folgen Doctor und Runtime-Smoke-Test.

### Den Datenbankpfad ausdrücklich festlegen (empfohlen für D:\PIONEER)

Wenn auf dem PC mehrere Rekordbox-Datenbanken existieren, kopiere den exakten
`D:\PIONEER`-Pfad aus Schritt 1 und setze ihn nur für dieses PowerShell-Fenster.
So ist klar, dass genau diese Bibliothek getestet wird und keine andere
AppData-Datenbank. Verwende nur eine vorhandene Datei namens `master.db` oder
`exportLibrary.db`:

```powershell
$env:AIRODOX_REKORDBOX_DB = 'D:\PIONEER\Master\master.db'
npm run rekordbox:preflight -- --require-db
```

Wenn du zwei bekannte Bibliotheken ausdrücklich zulassen möchtest, trenne die
Dateipfade mit einem Semikolon:

```powershell
$env:AIRODOX_REKORDBOX_DB = 'D:\PIONEER\Master\master.db;D:\PIONEER\rekordbox\exportLibrary.db'
```

Ist dieser Override gesetzt, sucht die App **nur** die angegebenen Pfade; ein
falsch geschriebener Override fällt nicht still auf eine andere Datenbank
zurück. Um danach zur automatischen Suche zurückzukehren:

```powershell
Remove-Item Env:AIRODOX_REKORDBOX_DB -ErrorAction SilentlyContinue
```

### Den Analysis-Data-Root ausdrücklich festlegen (nur zur Diagnose)

Normalerweise kommt der Root aus der `options.json` (siehe Schritt 1). Nur
wenn diese Datei nicht gelesen werden kann oder eine Bibliothek von einem
Fremdrechner geprüft wird, kann er für dieses PowerShell-Fenster gesetzt
werden:

```powershell
$env:AIRODOX_REKORDBOX_ANALYSIS_ROOT = 'D:\PIONEER\Master\share'
```

Mehrere Wurzeln werden mit Semikolon getrennt. Der Override ist exakt: es
werden dann ausschließlich diese Wurzeln geprüft. Zurück zur automatischen
Auflösung:

```powershell
Remove-Item Env:AIRODOX_REKORDBOX_ANALYSIS_ROOT -ErrorAction SilentlyContinue
```

## 5. Einen Track durch die echte Importkette prüfen

Die mitgelieferte XML-Sammlung enthält den Track mit der TrackID `142225026`;
der Doctor und der Smoke-Test verwenden diese ID standardmäßig. Schließe
Rekordbox weiterhin vollständig und führe aus:

```powershell
npm run rekordbox:doctor -- 142225026
```

Der Doctor zeigt den Datenbankpfad, den Track, den ANLZ-Pfad, die dekodierte
Waveform, den PPTH-Pfad zum Original-Audio und den eindeutigen Gate-Code. Der
erfolgreiche Abschluss lautet:

```text
FINAL:
  OK / REKORDBOX_ANLZ
```

Falls du eine andere TrackID prüfen möchtest, übergib sie nach `--`:

```powershell
npm run rekordbox:doctor -- --trackid 142225026
```

Du kannst die IDs und Titel der ersten Tracks in der mitgelieferten XML zur
Orientierung anzeigen:

```powershell
Select-Xml -Path '.\rekordbox_export2.xml' `
  -XPath '/DJ_PLAYLISTS/COLLECTION/TRACK[position() <= 10]' |
  ForEach-Object {
    [pscustomobject]@{
      TrackID = $_.Node.GetAttribute('TrackID')
      Titel   = $_.Node.GetAttribute('Name')
    }
  } | Format-Table -AutoSize
```

Ein Track muss mit derselben TrackID in der gefundenen lokalen Datenbank
vorkommen. Meldet der Doctor `TRACK_NOT_FOUND_IN_MASTER_DB`, passt die
verwendete Datenbank nicht zu dieser XML-Sammlung oder es wurde eine andere
Bibliothek gewählt. Wähle nicht willkürlich eine andere Audiodatei und
versuche nicht, das Gate zu umgehen.

Führe danach den vollständigen echten Windows-Smoke-Test aus:

```powershell
npm run test:rekordbox:runtime -- 142225026
```

Er liest die echte Datenbank, die echte ANLZ-Waveform und den Originalpfad und
prüft, dass die Dateigrößen und mtime von Datenbank, ANLZ und Original-Audio
während des Tests gleich geblieben sind. Die erwartete Schlussmeldung ist:

```text
REKORDBOX RUNTIME SMOKE: OK / REKORDBOX_ANLZ
```

Ein `SKIP` ist **kein** erfolgreicher Echtlauf. Auf Windows mit `--require-db`
und korrekt gefundener Bibliothek sollte der Smoke-Test weder wegen einer
fehlenden Datenbank überspringen noch einen fehlenden SQLCipher-Nachweis
verschweigen.

## 6. Die Desktop-App starten und einen Track laden

Erst nachdem Preflight, Doctor und Runtime-Smoke erfolgreich waren:

```powershell
npm run desktop
```

Der Befehl baut die App, prüft/rebaut das native Modul bei Bedarf und startet
Electron. In der App:

1. **Track-Import…** öffnen.
2. Im Fenster **Rekordbox Track-Auswahl** nach dem gewünschten Titel suchen.
   Die Suche filtert die gesamte Sammlung; es ist nicht nötig, durch alle
   Einträge zu scrollen.
3. Den passenden Track wählen und **In Deck laden** anklicken.
4. Nur fortfahren, wenn das Laden erfolgreich ist und die Herkunft als
   Rekordbox-ANLZ (Waveform-Tag/Bucket-Zahl) ausgewiesen wird.

Die kleine Statuszeile zur XML-Location prüft zunächst genau den in der XML
stehenden Pfad. Eine geräteinterne Location wie
`file://localhost//contents_…` kann dort als nicht lokal erscheinen; der
Gate kann nur dann trotzdem laden, wenn Datenbank/ANLZ den exakten PPTH-Pfad
zu einer erreichbaren Originaldatei belegen. **Ein Gate-Fehler darf nicht
ignoriert werden.** Die Originaldatei wird nur lesend geladen.

## 7. Automatisierte Regressionen (zusätzlich zum echten Windows-Lauf)

Diese Befehle prüfen Typen, ANLZ-Struktur und Rekordbox-/ANLZ-Regressionen:

```powershell
npm run lint
npm run build:anlz-structure:check
node scripts/run-tests.mjs --filter rekordbox --filter anlz
```

Das sind wichtige Softwaretests, aber kein Ersatz für
`npm run test:rekordbox:runtime` mit dem echten Windows-Datenträger.

## Fehlercodes: Was als Nächstes tun

| Code/Anzeige | Bedeutung | Nächster sicherer Schritt |
| --- | --- | --- |
| `SQLCIPHER_UNAVAILABLE` | Native Erweiterung fehlt oder passt nicht zur Electron-ABI. | `npm run rekordbox:native:rebuild`, dann Preflight wiederholen; bei Compilerfehlern Build Tools/Python prüfen. |
| `MASTER_DB_NOT_FOUND` | Keine unterstützte Datenbank am Suchort. | In Schritt 1 nach den bekannten Dateinamen suchen; den exakten Pfad mit `AIRODOX_REKORDBOX_DB` setzen. |
| `MASTER_DB_OPEN_FAILED` / `MASTER_DB_SCHEMA_INVALID` | Datei lässt sich nicht mit erwartetem Schema lesen. | Rekordbox schließen, den tatsächlichen Datenbankpfad prüfen und Doctor erneut ausführen. Quelldatei nicht bearbeiten. |
| `TRACK_NOT_FOUND_IN_MASTER_DB` | XML-TrackID ist in der gewählten Bibliothek nicht vorhanden. | Prüfen, ob XML und Datenbank zur selben Bibliothek gehören; keinen ähnlichen Track als Ersatz laden. |
| `ANLZ_NOT_FOUND` | Der in der Datenbank referenzierte ANLZ-Pfad ist an keinem Kandidaten erreichbar. Der Doctor nennt die geprüften Pfade. | Prüfen, ob `analysis-data-root-path` (Schritt 1) auf den Ordner zeigt, unter dem `PIONEER\USBANLZ` liegt, und ob dieses Laufwerk angeschlossen ist; Dateien nicht umbenennen. Der Gate sucht keine gleichnamige Datei an anderer Stelle und rechnet nichts selbst. |
| `ANLZ_INVALID`, `REKORDBOX_WAVEFORM_MISSING`, `ANLZ_WAVEFORM_UNREADABLE` | ANLZ ist ungültig oder enthält keine lesbare Rekordbox-Waveform. | Import stoppen; keine lokale Ersatzanalyse starten. |
| `ANLZ_SOURCE_MISMATCH` | Der PPTH-Pfad in der ANLZ passt nicht zum ausgewählten Original. | Import stoppen; nicht eine andere Datei mit gleichem Titel auswählen. |
| `ORIGINAL_AUDIO_NOT_FOUND` | Das Original-Audio am exakten lokalen Pfad ist nicht erreichbar. | Ursprüngliches Laufwerk/Verzeichnis verbinden und erneut prüfen. |

Bei jedem Fehler gilt: **nicht** die Quelldatenbank, XML, ANLZ oder das Audio
verschieben/umbenennen/überschreiben; keine Fehlermeldung übergehen und keine
synthetische Analyse als Ersatz akzeptieren. Der Import ist nur erfolgreich,
wenn der Gate `OK / REKORDBOX_ANLZ` meldet.
