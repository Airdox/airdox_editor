# Waveform Data Origin

Every waveform must be traceable to a verifiable source. For Rekordbox tracks, exclusively ANLZ/PWV; local analysis of working buffer must not replace this source. Palette clips take slice from same analysis source.

## Guarantees

- No parallel own audio analysis as source for waveform or beatgrid of Rekordbox tracks. `analyzeAudioBuffer` not in deck load path (guarded by tests/renderer-original-data.test.ts)
- Rekordbox paths resolved deterministically: leading `/` removed, `share/` prefix normalized, anchor `<dbDir>/share/PIONEER/USBANLZ/...`. No search, no name reconstruction, no hash directory guessing
- PQTZ original times taken verbatim into BeatGrid.beats[]; only after last original beat uniform continuations with tailExtended:true
- Renderer draws beats at original time positions from beats[] (collectVisibleBeats, selectGridRenderBeats); uniform firstBeat + n·60/BPM only for grids without stored nodes and reports via uniformFallback
- Native ANLZ buckets preserved for untouched regions via analysisComposer; CLEAR stays empty (no invented floor); cross-rate insert resamples to preserve time; same-slot 4-bar palette round-trip detected as no-op via sample-exact check
- Palette clips carry analysis slice + beatOffsets for exact round-trip, drag-drop MIME `application/x-airdox-palette-clip` with timeline clamping
- No synthetic fallback in production renderer, honest empty state

## Diagnostic Chain

For a track, report must show at least:

```
ANLZ PPTH-Scan: scanned > 0, Treffer > 0
→ anlzAutoApplied: true
→ waveformSource: PWV...
→ waveformBuckets > 0
→ analysis.origin: REKORDBOX_ANLZ
→ Palette waveform.origin: REKORDBOX_ANLZ
```

If gate fails, gatekeeper ends with reason and next agent action. Empty state only correct when report provably found no ANLZ source; local recalculation must not silently hide.
