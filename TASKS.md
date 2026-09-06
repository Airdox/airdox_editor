# Aufgaben

Arbeitsliste für Airdox Smart Editor. Erledigte Punkte bleiben mit Häkchen
stehen, damit der Verlauf nachvollziehbar ist. Versionsbezug siehe
[CHANGELOG.md](./CHANGELOG.md).

## Erledigt (0.2)

- [x] Rebranding zu „Airdox Smart Editor" (Paketname, `appId`, `productName`, README)
- [x] Anwendungs-Icons unter `build/` und Einbindung in electron-builder
- [x] Zentrale Version (`src/version.ts`, Build-Injektion über Vite)
- [x] Über-Dialog unter Hilfe → Über Airdox Smart Editor, Versionsbadge in der Titelleiste
- [x] Versionsschema dokumentiert (`VERSIONING.md`) und Changelog angelegt
- [x] Render-Inspektor auf das reale Schichtenmodell aus `workingSegments` umgestellt
- [x] Effekt-Spuren-Datenmodell (`EffectTrack` / `EffectSegment`)
- [x] Reine DSP-Effekt-Engine (Gain, Lowpass, Echo) mit Unit-Tests
- [x] `renderWorkingAudio` akzeptiert Effekt-Spuren

## Als Nächstes

- [ ] Effekt-Spuren in der UI: eigene Spur unterhalb der Wellenform, Segmente per
      Drag anlegen und in der Länge ändern
- [ ] Effekt-Parameter-Panel (Cutoff, Delay-Zeit, Feedback, Mix) mit Live-Vorschau
- [ ] Effekt-Spuren in der Projektdatei speichern und laden
- [ ] Effekt-Spuren beim WAV-Export berücksichtigen
- [ ] Automationskurven statt konstanter Parameter pro Segment

## Später

- [ ] Weitere Effekttypen: Hochpass, Bitcrusher, Reverb
- [ ] Beatgrid-Quantisierung beim Anlegen von Effektsegmenten
- [ ] Mehrspur-Mixdown mehrerer Tracks auf eine Zeitachse
- [ ] Export der Bearbeitung als Rekordbox-kompatible Cue-/Memo-Punkte
- [ ] macOS- und Linux-Build-Ziele

## Technische Schulden

- [ ] `src/App.tsx` ist über 2000 Zeilen lang – Zustand in Hooks/Reducer auslagern
- [ ] Palette-Clips halten `AudioBuffer` direkt im Zustand; Speicherverbrauch prüfen
- [ ] Testsuite läuft als Kette von `tsx`-Aufrufen – auf einen Runner umstellen
