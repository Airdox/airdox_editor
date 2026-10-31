# Stem-Ansicht und dauerhafte Wiederaufnahme – 30.10.2026

Die Stem-Zeile bietet einen dauerhaften Ein-/Ausklappschalter; zusätzlich liegt der Schalter unter Betrachten. Einklappen behält die geladenen Kanäle und Mischereinstellungen. Max. Platz blendet den Mixer aus, die Stem-Zeile öffnet ihn wieder. Während einer Berechnung bleibt der Fortschritt sichtbar.

Die Top-Bar hatte `overflow-hidden`: ihre absolut positionierten Menüs wurden an der Leistenhöhe abgeschnitten. Die Leiste lässt den Überhang jetzt zu und hält ihn oberhalb des Viewports.

Fertige WAVs und job.json bleiben in `%APPDATA%/airdox_SMART_Editor/stems/Separation` und im bestehenden dauerhaften Cache. Eine neue Suche öffnet vorhandene Ergebnisse einschließlich alter Separationsordner und ihrer Historie. Zuordnung erfolgt über den SHA-256-Fingerabdruck der vollständigen kanonischen PCM-Arbeitskopie, unabhängig von temporären Track-IDs. Alle erwarteten Spuren müssen vollständig, vorhanden und checksum-korrekt sein. Für einen expliziten Modell-/Profilauftrag gelten zusätzliche Filter. Die Wiederaufnahme benötigt keine Modellgewichte und startet keine Inferenz. Ein veränderter Audiopuffer bekommt keine Stems eines anderen Schnittstands.

## Nachweise

- TypeScript-Prüfung und Produktionsbuild: Exit 0.
- StemCenter, IPC-Vertrag und neue Saved-Library-Regression: 3/3 bestanden.
- Bestehende Job-Service-Tests einschließlich Fail-fast: 2/2 bestanden.
- Saved-Library-Test prüft Neustart, fehlende Modelle, keine Backend-Aufrufe, WAV-Readback, falsche Eingabe/Profil/Modell und gleich große beschädigte Dateien.
- Echte Electron-Oberfläche: zweimal neu gestartet, dieselbe zuvor zerlegte Audiodatei unter jeweils neuer Track-ID importiert; vier Kanalregler automatisch wiederhergestellt, ausschließlich abgeschlossene cacheHit-Jobs. Ein-/Ausblenden, Betrachten-Schalter, Fokus-Rückkehr sowie Datei/Bearbeiten/Betrachten per echtem Hit-Test geprüft. Keine pageerrors.
- Derselbe Lauf im fertigen ASAR-Windows-Paket: bestanden. Evidenz und Screenshots: `artifacts/stem-library-packaged-20261030/report.json` und benachbarte PNGs. Quelllauf: `artifacts/stem-library-desktop-20261030`.
- Vorhandener Nutzertrack `track_87868672`: Produktionsbridge findet alle vier validierten Spuren, Dauer 356.989365 s, SCNet, cacheHit=true. Keine erneute Trennung ausgeführt.
- Paket-Hook bestätigt SQLCipher-Ladbarkeit mit Electron 42 / ABI 146 und ANLZ-Modul im Paket.

## Übergabe

Installer: `release/stem-view-cache-20261030/airdox_SMART_Editor-0.4.2-setup.exe`

SHA-256: `5a48a9b8e8d1baec89a4d3984418757fe5d1aaa4c6f8bf9c9df99ebc9420c655`

Der laufende installierte Editor wurde nicht beendet oder ersetzt. Für die Nutzung der Korrektur muss der Nutzer seine Arbeit speichern, den Editor schließen und den neuen Installer ausführen. Vorhandene Separationsdateien werden von der Korrektur lesend wiederverwendet. Die Abnahme betrifft Wiederaufnahme und Bedienung; eine neue musikalische Modellqualitätsbewertung wurde nicht durchgeführt.
