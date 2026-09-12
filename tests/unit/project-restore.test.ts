/**
 * @license
 * Project restore rules, tested at the seam where they live (`src/project/restore.ts`).
 *
 * These are the two rules that decide whether a re-opened project still describes
 * the same material:
 *   R1–R3  a palette clip may only claim a source window when the saved file says
 *          that window was verified — an old or unverified clip comes back WITHOUT
 *          the claim, so nothing downstream can read project seconds as original
 *          positions again,
 *   R4–R6  the original audio is re-opened read-only, and when that fails the track
 *          loads metadata-only with `MISSING` on record instead of getting any
 *          replacement audio.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { DataOrigin } from '../../src/types/rekordbox';
import type { SerializedPaletteClip } from '../../src/rekordbox/projectFile';
import { rebuildTrackFromSerialized, reopenTrackSourceAudio, restorePaletteClips } from '../../src/project/restore';
import type { SerializedTrack } from '../../src/rekordbox/projectFile';

const fakeCtx = {
  decodeAudioData: async (ab: ArrayBuffer) => ({
    duration: (ab.byteLength / 4) / 44100,
    sampleRate: 44100,
    numberOfChannels: 1,
    length: ab.byteLength / 4,
    getChannelData: () => new Float32Array(ab.byteLength / 4),
  }),
} as unknown as AudioContext;

const storedClip = (over: Partial<SerializedPaletteClip> = {}): SerializedPaletteClip => ({
  id: 'clip-1',
  name: 'Set (3.0 Bars)',
  sourceTrackId: 't1',
  sourceTrackName: 'Set',
  sourceStart: 3,
  sourceEnd: 6,
  duration: 3,
  beats: 6,
  bars: 3,
  bpm: 120,
  key: '8A',
  color: '#00a2ff',
  miniPeaks: [0.1, 0.9, 0.4],
  previewOrigin: 'ANLZ',
  previewNote: 'Vorschau: gespeicherte Spalten',
  origin: DataOrigin.PROJECT,
  ...over,
});

describe('restorePaletteClips — Quellfenster nur nach Vermerk im Projekt', () => {
  it('R1: sourceMapped:true behält Fenster und Vorschau-Herkunft', async () => {
    const [clip] = await restorePaletteClips([storedClip({ sourceMapped: true })], fakeCtx);
    expect(clip.sourceMapped).toBe(true);
    expect(clip.sourceStart).toBe(3);
    expect(clip.sourceEnd).toBe(6);
    expect(clip.sourceTrackId).toBe('t1');
    expect(clip.miniPeaks).toEqual([0.1, 0.9, 0.4]);
    expect(clip.previewOrigin).toBe('ANLZ');
    expect(clip.previewNote).toContain('gespeicherte Spalten');
  });

  it('R2: ohne Vermerk (alte Projekte) kommt der Clip ohne Quellenanspruch zurück', async () => {
    const withoutFlag = await restorePaletteClips([storedClip()], fakeCtx);
    expect(withoutFlag[0].sourceMapped).toBe(false);
    const falseFlag = await restorePaletteClips([storedClip({ sourceMapped: false })], fakeCtx);
    expect(falseFlag[0].sourceMapped).toBe(false);
    // Das Fenster selbst bleibt als Materialschnitt erhalten — nur die Behauptung,
    // es sei eine Position im Original, wird nicht wieder aufgestellt.
    expect(falseFlag[0].sourceStart).toBe(3);
    expect(falseFlag[0].audioBuffer).toBeUndefined();
  });

  it('R3: eingebettetes Clip-Audio wird dekodiert, eine leere Basis bleibt leer', async () => {
    const wav = Buffer.from(new Uint8Array(16)).toString('base64');
    const [withAudio] = await restorePaletteClips([storedClip({ clipWavBase64: wav })], fakeCtx);
    expect(withAudio.audioBuffer?.sampleRate).toBe(44100);
    const [empty] = await restorePaletteClips([storedClip({ clipWavBase64: undefined })], fakeCtx);
    expect(empty.audioBuffer).toBeUndefined();
    expect(await restorePaletteClips([], fakeCtx)).toEqual([]);
  });
});

describe('reopenTrackSourceAudio — nur lesend, kein Ersatz-Audio', () => {
  afterEach(() => {
    delete (window as unknown as { rekordboxDesktop?: unknown }).rekordboxDesktop;
  });

  it('R4: liegendes Audio wird genommen, die Bridge gar nicht erst gefragt', async () => {
    let calls = 0;
    (window as unknown as { rekordboxDesktop: unknown }).rekordboxDesktop = {
      readOriginalAudio: async () => {
        calls += 1;
        return { data: new Uint8Array(8), path: 'D:/x.wav', size: 8, modifiedAt: 0 };
      },
    };
    const buffer = { duration: 4 } as AudioBuffer;
    const result = await reopenTrackSourceAudio(
      { audioBuffer: buffer, originalMedia: { location: 'file://D:/x.wav', accessMode: 'READ_ONLY', status: 'AVAILABLE' } },
      fakeCtx,
      { category: 'SYSTEM', message: 'test' }
    );
    expect(calls).toBe(0);
    expect(result.audioBuffer).toBe(buffer);
  });

  it('R5: über die Bridge gelöst wird AVAILABLE mit aufgelöstem Pfad', async () => {
    (window as unknown as { rekordboxDesktop: unknown }).rekordboxDesktop = {
      readOriginalAudio: async () => ({
        data: new Uint8Array(8).buffer,
        path: 'D:\\Rekordbox\\Set.wav',
        size: 4096,
        modifiedAt: 1234,
      }),
    };
    const result = await reopenTrackSourceAudio(
      { audioBuffer: null, originalMedia: { location: 'file://D:/Rekordbox/Set.wav', accessMode: 'READ_ONLY', status: 'UNVERIFIED' } },
      fakeCtx,
      { category: 'SYSTEM', message: 'test' }
    );
    expect(result.audioBuffer?.sampleRate).toBe(44100);
    expect(result.originalMedia?.status).toBe('AVAILABLE');
    expect(result.originalMedia?.resolvedPath).toBe('D:\\Rekordbox\\Set.wav');
    expect(result.originalMedia?.size).toBe(4096);
  });

  it('R6: Fehlschlag bleibt ein Fehlschlag — MISSING, ohne Audio, ohne Wurf', async () => {
    (window as unknown as { rekordboxDesktop: unknown }).rekordboxDesktop = {
      readOriginalAudio: async () => {
        throw new Error('gesperrt');
      },
    };
    const result = await reopenTrackSourceAudio(
      { audioBuffer: null, originalMedia: { location: 'file://D:/fehlt.wav', accessMode: 'READ_ONLY', status: 'UNVERIFIED' } },
      fakeCtx,
      { category: 'SYSTEM', message: 'test' }
    );
    expect(result.audioBuffer).toBeNull();
    expect(result.originalMedia?.status).toBe('MISSING');
  });
});

const storedTrack = (over: Partial<SerializedTrack> = {}): SerializedTrack => ({
  id: 't1',
  title: 'Set',
  artist: 'KA',
  album: 'Album',
  bpm: 128,
  key: '8A',
  duration: 10,
  sampleRate: 44100,
  channels: 2,
  originalSha256: 'sha256-t1',
  isOriginalUntouched: true,
  origin: DataOrigin.REKORDBOX_XML,
  beatGrid: {
    firstBeat: 0.2,
    bpm: 128,
    meter: 4,
    origin: DataOrigin.REKORDBOX_ANLZ,
    beats: [
      { time: 0.2, isBarStart: true, barNumber: 1, beatInBar: 1 },
      { time: 0.66875, isBarStart: false, barNumber: 1, beatInBar: 2, tailExtended: true },
    ],
  },
  cues: [],
  loops: [],
  workingSegments: [],
  ...over,
});

describe('rebuildTrackFromSerialized — wieder dasselbe Projekt', () => {
  it('R7: Edit-Segmente inklusive Clip-Audio und Herkunfts-Feldern', async () => {
    const wav = Buffer.from(new Uint8Array(16)).toString('base64');
    const track = await rebuildTrackFromSerialized(
      storedTrack({
        workingSegments: [
          {
            id: 'edit-1',
            type: 'CUT',
            trackId: 't1',
            sourceStart: 2,
            sourceEnd: 3,
            projectStart: 2,
            projectDuration: 1,
            gain: 1,
          },
          {
            id: 'edit-2',
            type: 'INSERT',
            trackId: 't1',
            sourceStart: 0,
            sourceEnd: 2,
            projectStart: 0,
            projectDuration: 2,
            gain: 0.5,
            clipId: 'clip-1',
            clipWavBase64: wav,
            sourceTrackId: 't2',
            sourceClipStart: 4,
            tempoRatio: 1.05,
            pitchShift: -2,
          },
        ] as SerializedTrack['workingSegments'],
      }),
      fakeCtx
    );
    expect(track.workingSegments).toHaveLength(2);
    const [plain, withClip] = track.workingSegments!;
    expect(plain.id).toBe('edit-1');
    // Felder, die der Datensatz nicht enthält, werden nicht erfunden.
    expect('sourceTrackId' in plain).toBe(false);
    expect('clipBuffer' in plain).toBe(true);
    expect(plain.clipBuffer).toBeUndefined();
    expect(withClip.sourceTrackId).toBe('t2');
    expect(withClip.sourceClipStart).toBe(4);
    expect(withClip.tempoRatio).toBeCloseTo(1.05, 9);
    expect(withClip.pitchShift).toBe(-2);
    expect(withClip.gain).toBeCloseTo(0.5, 9);
    expect((withClip.clipBuffer as AudioBuffer).sampleRate).toBe(44100);
    // Die analysierte Wellenform kommt NIE aus der gespeicherten Sitzung, sondern
    // wird nach dem Laden aus ANLZ neu projiziert.
    expect(track.analysis).toBeNull();
  });

  it('R8: Beat-Knoten wortwörtlich übernommen, Alter ohne Knoten erfindet nichts', async () => {
    const track = await rebuildTrackFromSerialized(storedTrack(), fakeCtx);
    expect(track.beatGrid.beats.map((b) => b.time)).toEqual([0.2, 0.66875]);
    expect(track.beatGrid.beats[1].tailExtended).toBe(true);
    expect(track.beatGrid.origin).toBe(DataOrigin.REKORDBOX_ANLZ);
    expect(track.beatGrid.firstBeat).toBeCloseTo(0.2, 9);

    const legacy = await rebuildTrackFromSerialized(
      storedTrack({ beatGrid: { firstBeat: 0, bpm: 128, meter: 4 } }),
      fakeCtx
    );
    // Ein Rekordbox-Track ohne gespeicherte Knoten bekommt kein fabriziertes Grid.
    expect(legacy.beatGrid.beats.length).toBe(0);
  });
});
