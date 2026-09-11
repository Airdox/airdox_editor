# Airdox Agent Contract

This file is repository-wide and binding for every human or automated contributor.

## Authoritative architecture

Read [`REKORDBOX_PIPELINE_ARCHITECTURE.md`](./REKORDBOX_PIPELINE_ARCHITECTURE.md) before changing Rekordbox import, database, ANLZ, beatgrid, waveform, cue, phrase, editor, or renderer code.

Target Rekordbox version for the current desktop workflow: **7.2.16**.

## Non-negotiable Rekordbox data flow

```text
Rekordbox XML Location ───────────────→ original audio → playback/edit/export only
Rekordbox XML identity → master.db row → AnalysisDataPath → DAT/EXT/2EX
                                                       ↓
                                      ANLZ waveform/PQTZ/cues/PSSI
                                                       ↓
                                           model → editor → renderer
```

1. `master.db` is authoritative for the exact track row and `AnalysisDataPath`.
2. Runtime linkage must be deterministic, unique, and diagnosable. Never use title, artist, BPM, filename similarity, fuzzy matching, directory scanning, or manual ANLZ assignment.
3. XML `TrackID == djmdContent.ID` is not an official cross-version guarantee. For Rekordbox 7.2.16 it may only be used as a guarded contract: exactly one ID row plus exact canonical XML-Location/DB-FolderPath consistency. When the ID contract does not confirm, the **unique exact canonical path contract** (XML `Location` ↔ `djmdContent.FolderPath`, the verified 52af2dc pipeline) is the only permitted secondary linkage: ambiguous paths (same path, different analysis rows) are hard-excluded from the index. If neither contract resolves, it is a visible pipeline error, never permission to guess.
4. Resolve `AnalysisDataPath` only relative to the directory containing the opened `master.db`: strip leading separators and an optional `share/`, then resolve below `<db-root>/share/`. Reject traversal.
5. DAT/EXT/2EX siblings may only be obtained by replacing the final extension in the same DB-addressed directory.
6. PPTH may be decoded for diagnostics only. It must never locate or select an ANLZ file.

## Analysis integrity

- Reuse the existing ANLZ parser. Do not create a parallel parser.
- Preserve every decoded PQTZ beat time and per-beat BPM. Never replace PQTZ entries with `firstBeat + n * 60/BPM`, and never append a generated tail.
- Waveforms come only from real ANLZ PWAV/PWV2–PWV7 values.
- Preserve real variants separately: preview, detail, color preview/detail, and 3-band preview/detail.
- No audio analysis, synthetic waveform, pseudo-amplitude, generated frequency bands, smoothing, averaging, interpolation, peak-hold reduction, or beatgrid reconstruction in the Rekordbox production path.
- If required ANLZ data cannot be loaded, expose `MISSING_REKORDBOX_ANALYSIS`/a precise pipeline error and render no replacement waveform or beatgrid.
- Audio remains available for playback, scrubbing, edits, DSP, preview, and export, but not as an analysis source for Rekordbox tracks.

## Provenance and editing

- ANLZ waveform/PQTZ: `REKORDBOX_ANLZ`.
- XML TEMPO metadata: `REKORDBOX_XML`.
- Explicit user changes: `USER_EDIT`.
- Generated test/demo material: `GENERATED_TEST` (never a Rekordbox origin).
- Auto-align must never run automatically. If explicitly invoked, retain the imported grid for undo/audit and visibly state that the Rekordbox grid was changed.

## Required working method

Make pipeline changes in this order and validate after each stage:

1. `AnalysisDataPath` resolver and strict XML↔DB linkage.
2. Verbatim PQTZ transport into the model.
3. Renderer consumption of original waveform columns and beat nodes.
4. Removal/isolation of own and synthetic analysis from the Rekordbox production path.

For each stage:

1. add or update focused tests;
2. run the focused tests;
3. fix failures;
4. inspect the data flow and provenance;
5. run `npm test`, `npm run lint`, `npm run build`, and `git diff --check` before completion.

After implementation, audit every occurrence of:

```text
analyzeAudioBuffer(
buildBeatGridFromTempo(
generateAnalysisFromMetadata(
generateElectronicDjTrack(
USBANLZ
AnalysisDataPath
ANLZ0000
PQTZ
PWV2 PWV3 PWV4 PWV5 PWV6 PWV7
```

Document whether each remaining call is production, explicit user editing, non-Rekordbox local import, or test code. A call reachable from XML/Rekordbox deck loading is forbidden unless it only decodes or displays Rekordbox-owned values.
