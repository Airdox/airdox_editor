# Rekordbox pipeline implementation audit

Date: 2026-09-12 — extended with the edit-projection audit

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
| `src/App.tsx`, project reopen | Non-Rekordbox local project only; Rekordbox branch loads ANLZ with `tryAutoLoadAnlz`. | Allowed outside the Rekordbox branch |
| `src/App.tsx`, standalone local audio import | Explicit non-Rekordbox import (`LOCAL_ANALYSIS`), not XML/master.db workflow. | Isolated; not reachable from Rekordbox collection loading |
| `src/waveform/analyzer.ts` | Definition used only by the isolated contexts above. | Not a Rekordbox source |
| tests | Source-contract assertions. | Test only |

Deleted occurrence: the former `src/App.tsx` Delete/Clear call. Structural edits no longer
re-analyse anything — they re-project from stored ANLZ columns (see "Edit projection audit"),
so a Rekordbox track keeps its real waveform after Delete/Clear instead of losing it, and no
own peak analysis is reachable from an edit operation. See "Edit projection audit".

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

### `analyzeRangeBuckets(` / `analyzeAudioBuffer` inside `src/edit/`

| File / context | Classification | Decision |
|---|---|---|
| `src/edit/editWaveform.ts` (via `analyzeRange` dependency) | Explicit user-edit material only: called for a projected span that has **no** ANLZ ancestor (clipboard clip, stretched material). Every produced column is tagged `COMPUTED`, and the track origin becomes `USER_EDIT`. | Allowed for edited material; never used for original Rekordbox material |
| `src/edit/editWaveform.ts` overdub overlay | A mix has no stored ancestor either; only the overlaid window of the *clip* audio is measured, columns are tagged `MIX`. | Allowed for edited material |
| `src/App.tsx` | Does not pass a custom analyzer, so the documented peak/band estimator in `src/waveform/analyzer.ts` is used; no smoothing, averaging, interpolation or peak-hold reduction exists in that path. | Deliberate |

`spanAllowsVerbatimClipColumns()` is the gate: stored columns may only be copied when tempo
ratio is 1, pitch shift is 0, gain is neutral and the clip's source track id and source window
are known. Otherwise the span is computed and labelled — an edit never claims ANLZ data for
material it does not have.

### `extractMiniPeaks(`

| File / context | Classification | Decision |
|---|---|---|
| `src/App.tsx`, palette clip thumbnails | UI thumbnail of *edited user material* (clip preview strip), not a waveform in the Rekordbox production path. | Allowed; not used for deck rendering |

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
- The edit-span strip in `DetailWaveform.tsx` draws the projection (`ProjectedSpanView[]`) that
  produced the audible timeline, so the displayed blocks and the audio can never disagree.
- The projected composite is another variant set with per-column provenance; the pristine
  `baseAnalysis`/`baseAnalysisVariants` stay byte-exact and remain the source of every re-derivation.

## Edit projection audit

Structural edits (Insert, Replace, Overdub, Cut/Delete, Clear, Clip-Blocks from Palette oder
Sammlung per Drag & Drop) are stored as `EditSegment`s on the track. The segment list is the only
source of truth; the following artefacts are derived from it on every edit, on every Undo/Redo and
after every project reopen, by `projectTrackEdits()` in `src/edit/editModel.ts`:

- project timeline and its spans (`src/edit/editTimeline.ts`);
- project duration of the track and of the project;
- working audio (`src/edit/projectedAudio.ts`) — what playback and export hear;
- waveform variants with per-column provenance (`src/edit/editWaveform.ts`) — what the deck shows;
- the edit-strip blocks (`ProjectedSpanView[]`) that visualise the very same spans.

Copied, never recomputed: material that still has an ANLZ ancestor is assembled from the stored
columns of that ancestor by index arithmetic (`i = floor(t / secPerBucket)` → `j = floor(t′ /
secPerBucket)`). Neighbouring spans never share a boundary column, and a block copy is only used
when the source/project offset is an exact multiple of `secPerBucket`; otherwise the nearest column
is repeated or skipped — never averaged, never interpolated.

Recomputed and labelled: only material without an ANLZ ancestor (clipboard clip, time-stretched
material) is measured from the edited audio, tagged `COMPUTED`, and the track origin moves to
`USER_EDIT`. A time-stretched clip is never allowed to claim verbatim ANLZ columns.

Originals: the Rekordbox source file, XML, `master.db` and ANLZ stay read-only. The imported ANLZ
arrays are frozen in `baseAnalysis`/`baseAnalysisVariants` and are the only projection input, so a
composite can never be fed back into itself, and an edit cannot silently rewrite stored values.

Markers: cues, loops, phrases and beat nodes are re-timed incrementally with the same delta the
audio layout produced (`retimeCues`/`retimeLoops`/`retimePhrases`/`retimeBeatNodes`); inside removed
material they collapse to the cut position, and auto-fill beats across a gap are only added when the
deck already carried imported beat nodes — those nodes are flagged `insertGrid` and the grid origin
moves to `USER_EDIT`, so a modified Rekordbox grid stays visible as modified.

## Provenance

- PQTZ and PWV data: `REKORDBOX_ANLZ`.
- XML TEMPO scalars/cues: `REKORDBOX_XML`.
- Explicit beatgrid/cue edits: `USER_EDIT`.
- Generated demo/test origin: `GENERATED_TEST`.
- Deprecated `GENERATED_FALLBACK` and `tailExtended` fields remain type-compatible only for reading old project files and are never generated by the new Rekordbox pipeline.
- Waveform columns are labelled per source: `ANLZ` (identity copy), `ANLZ_RETIMED` (copied out of
  position by an edit), `CLIP_ANLZ` (copied from another track's ANLZ), `COMPUTED` (edited material
  without an ANLZ ancestor), `MIX` (overdub), `SILENCE` (Clear), `MISSING` (no data — drawn empty).
- A `WaveformAnalysisData` that is a projection carries `isEditComposite: true`; only the base
  arrays are ever used as a projection input, so a composite can never be fed back into itself.
- `.airdox` project files persist edit segments, marker positions and the frozen original
  duration — never waveform arrays. Reopening re-reads ANLZ and re-derives audio, waveform and
  duration from the segment list.

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
- deck-loader source contract: no scan, PPTH lookup, audio analysis, or uniform grid creation;
- timeline projection: identity, insert/replace/cut/clear/overdub layout, gapless multi-edit
  sequences, and the exact conditions under which stored columns may be reused
  (`tests/edit-timeline.test.ts`);
- waveform composition: byte-exact ANLZ reproduction when unedited, re-timed and clip-sourced
  columns without new analysis, computed columns only for genuinely new material, honest
  `MISSING`, real silence, overdub maxima, per-variant resolution, idempotent re-derivation
  (`tests/edit-waveform.test.ts`);
- orchestration: one derivation for audio/waveform/duration/telemetry, pristine base stays frozen,
  re-derivation cannot drift over Undo/Redo, no pseudo-waveform for decks without ANLZ
  (`tests/edit-model.test.ts`);
- projected audio: material really moves, gains apply, unresolved spans go silent, Clear zeroes
  exactly its window, paste honours its source window (`tests/edit-audio.test.ts`);
- drag & drop: payload accept/reject (including foreign and file drags), modifier → mode mapping,
  drop geometry planner, and the follow-up state of an actual drop through the real projection
  (`tests/edit-dnd.test.ts`).
