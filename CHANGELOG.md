# Changelog

Alle nennenswerten Änderungen an diesem Projekt werden hier dokumentiert.
Zum Versionsschema siehe [VERSIONING.md](./VERSIONING.md).

## [0.2] – 2026-09-06

### Hinzugefügt
- Versionsanzeige in der Titelleiste sowie neuer Dialog **Hilfe → Über Airdox Smart Editor**
  (`src/components/Modals/AboutModal.tsx`) mit Version und Build-Zeitpunkt.
- Zentrale Versionskonstanten in `src/version.ts`; Vite injiziert `__APP_VERSION__`
  und `__APP_BUILD_TIME__` zur Buildzeit.
- Effekt-Spuren-Modell: neue reine DSP-Engine `src/audio/effectEngine.ts`
  (GAIN, LOWPASS, ECHO) mit Typen `EffectTrack` / `EffectSegment` und Tests
  (`tests/effect-engine.test.ts`, in `npm test` eingebunden).
- `audioEngine.renderWorkingAudio` akzeptiert optional `effectTracks`.
- Projektdokumentation: `CHANGELOG.md`, `VERSIONING.md`, `TASKS.md`.
- Anwendungs-Icons unter `build/`.

### Geändert
- **Rebranding zu „Airdox Smart Editor"**: Paketname `airdox_smart_editor`,
  Electron `appId` `info.airdox.smarteditor`, überarbeitete `README.md`.
- Der Multi-Layer-Render-Inspector zeigt jetzt das reale Schichtenmodell aus
  `workingSegments` statt erfundener Beispieldaten.

## [0.1]

- Erste interne Fassung: Rekordbox-Import (XML, ANLZ, DB), nicht-destruktiver
  Wellenform-Editor, Pitch-/Tempo-Engine, WAV-Export.
