# Rekordbox pipeline implementation audit

Date: 2026-09-11  
Target desktop workflow: rekordbox **7.2.16**

This document records the post-implementation source audit required by `AGENTS.md`.

## Production flow

```text
XML TrackID + Location
  → one master.db only
  → guarded identity: XML TrackID == djmdContent.ID AND exact canonical path
  → that exact row's AnalysisDataPath
  → <master.db directory>/share/PIONEER/USBANLZ/...
  → DAT + deterministic EXT/2EX siblings
  → existing ANLZ parser
  → original PQTZ/PWV/PCO/PSSI model values
  → source-column/source-beat renderer
```

A failed identity, DB read, path resolution, ANLZ read, or required waveform decode is a visible pipeline error. It does not invoke PPTH lookup, file scanning, manual ANLZ assignment, local audio analysis, synthetic waveform generation, or grid reconstruction.

## Required-call audit

### `analyzeAudioBuffer(`

| File / context | Classification | Decision |
|---|---|---|
| `src/App.tsx`, Delete/Clear | Explicit audio editor operation; guarded by `isRekordboxOrigin`. Rekordbox tracks set waveform to `null` rather than re-analyzing. | Allowed outside the Rekordbox branch |
| `src/App.tsx`, project reopen | Non-Rekordbox local project only; Rekordbox branch loads ANLZ with `tryAutoLoadAnlz`. | Allowed outside the Rekordbox branch |
| `src/App.tsx`, standalone local audio import | Explicit non-Rekordbox import (`LOCAL_ANALYSIS`), not XML/master.db workflow. | Isolated; not reachable from Rekordbox collection loading |
| `src/waveform/analyzer.ts` | Definition used only by the isolated contexts above. | Not a Rekordbox source |
| tests | Source-contract assertions. | Test only |

`handleSelectTrackFromXml` contains no `analyzeAudioBuffer` call, enforced by `tests/track-guards.test.ts`.

### `buildBeatGridFromTempo(`

| File / context | Classification | Decision |
|---|---|---|
| `src/App.tsx`, collection model fallback | Only non-Rekordbox origins; Rekordbox origins receive an empty scalar grid until PQTZ. | Guarded |
| `src/App.tsx`, standalone local audio import | Explicit non-Rekordbox local import. | Isolated |
| `src/rekordbox/trackGuards.ts`, legacy project restore | Only non-Rekordbox project origins; old Rekordbox projects remain sparse. | Guarded |
| `src/rekordbox/xmlParser.ts` | Function definition and non-Rekordbox utility. XML parsing no longer calls it. | Not used to expand XML TEMPO |

`handleSelectTrackFromXml` contains no `buildBeatGridFromTempo` call, enforced by test.

### `generateAnalysisFromMetadata(`

No occurrence.

### `generateElectronicDjTrack(`

No occurrence.

## Analysis-address audit

- `electron/dbReader.cjs` reads `djmdContent.AnalysisDataPath` from the SQLCipher desktop `master.db`.
- The moved database path from `rekordboxAgent/storage/options.json` (`db-path`) ranks before a standard-location `master.db`.
- Automatic indexing accepts the first readable desktop `MASTER_DB` and never merges identity namespaces from multiple databases.
- `ONE_LIBRARY` is not used to link desktop XML tracks.
- `src/rekordbox/analysisResolver.ts` accepts only the `PIONEER/USBANLZ/...` relative subtree, strips leading separators/optional `share/`, rejects empty/dot/parent segments, and resolves below `<dbDir>/share`.
- No track name, artist, BPM, basename similarity, hash guessing, directory recursion, or path-only fallback participates in the production join.
- DAT/EXT/2EX use final-extension replacement in the same directory.
- Manual ANLZ file controls and their renderer IPC bridge were removed.
- Legacy PPTH scan helpers remain covered by isolated reverse-engineering tests inside `electron/dbReader.cjs`, but they are not exposed in `preload.cjs`, have no IPC handler, and have no production caller. PPTH decoded from an already addressed ANLZ file is diagnostic only.

## PQTZ audit

- `src/rekordbox/anlzParser.ts` retains every PQTZ entry's exact `time`, `beatInBar`, bar boundary, and `bpm = tempo_x100 / 100`.
- `src/rekordbox/databaseExtractor.ts` copies the decoded list without extending or rebuilding it.
- Short PQTZ data remains short; no tail is appended.
- Per-beat BPM survives project serialization/deserialization.
- XML TEMPO retains scalar metadata with an empty beat list; it is never expanded into analyzed beats.
- Rekordbox project files without persisted nodes remain sparse.
- PSSI timing uses existing PQTZ node positions, not `firstBeat + n × 60/BPM`.

## Renderer audit

- `DetailWaveform.tsx` uses `beatGrid.beats[]` directly for Rekordbox tracks. If nodes are absent, it draws no generated Rekordbox grid and quantize does not synthesize snap positions.
- `TrackOverview.tsx` uses the same stored beat nodes.
- Both waveform views consume actual ANLZ variants.
- Overview peak-hold aggregation and `peakHoldColumn` were removed.
- Overview draws each source ANLZ column as its own primitive at a proportional display coordinate.
- Detail draws each visible source column directly and selects only among genuine loaded ANLZ variants.
- Missing waveform data displays `MISSING_REKORDBOX_ANALYSIS`; no waveform replacement is rendered.

## Provenance

- PQTZ and PWV data: `REKORDBOX_ANLZ`.
- XML TEMPO scalars/cues: `REKORDBOX_XML`.
- Explicit beatgrid/cue edits: `USER_EDIT`.
- Generated demo/test origin: `GENERATED_TEST`.
- Deprecated `GENERATED_FALLBACK` and `tailExtended` fields remain type-compatible only for reading old project files and are never generated by the new Rekordbox pipeline.

## Validation coverage

- exact XML Location normalization;
- guarded rekordbox 7.2.16 ID + path identity;
- separate DB rows sharing one physical audio file;
- AnalysisDataPath share resolution and traversal rejection;
- DAT/EXT merge and deterministic siblings;
- PQTZ exact nonuniform times and per-beat BPM;
- no PQTZ tail creation;
- project persistence of original nodes;
- genuine waveform variant selection;
- no Overview aggregation;
- deck-loader source contract: no scan, PPTH lookup, audio analysis, or uniform grid creation.
