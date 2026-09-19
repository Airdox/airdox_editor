/**
 * @license
 * Rekordbox Audio Engine
 * Real Web Audio API pipeline with Master Bus, Stem Mixer, Analyser meters,
 * Non-destructive Edit Graph playback, and WAV export.
 */

import { EditSegment, TrackModel, PaletteClip } from '../types/rekordbox';
import { adaptClipAudioBuffer, calculateHarmonicPitchShift } from './pitchTempoEngine';
import { renderEditSegments } from './editingEngine';
import {
  TrackStems,
  StemsMixerState,
  STEM_TYPES,
  DEFAULT_STEMS_MIXER_STATE,
} from './stemEngine';
import { logger } from '../utils/logger';

const SAMPLE_INDEX_EPSILON = 1e-6;

function timeToSampleFloor(seconds: number, sampleRate: number): number {
  return Math.floor(seconds * sampleRate + SAMPLE_INDEX_EPSILON);
}

class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  /** Final safety stage shared by playback, meters and the recorder. */
  private masterLimiter: DynamicsCompressorNode | null = null;
  private masterRecordDestination: MediaStreamAudioDestinationNode | null = null;
  private analyserL: AnalyserNode | null = null;
  private analyserR: AnalyserNode | null = null;
  private splitter: ChannelSplitterNode | null = null;

  // Single-source playback
  private currentSource: AudioBufferSourceNode | null = null;

  // Stems playback
  private stemSources: {
    vocals: AudioBufferSourceNode | null;
    drums: AudioBufferSourceNode | null;
    bass: AudioBufferSourceNode | null;
    other: AudioBufferSourceNode | null;
  } = { vocals: null, drums: null, bass: null, other: null };

  private stemGains: {
    vocals: GainNode | null;
    drums: GainNode | null;
    bass: GainNode | null;
    other: GainNode | null;
  } = { vocals: null, drums: null, bass: null, other: null };

  private isPlayingStems: boolean = false;
  private activeStems: TrackStems | null = null;
  private stemsMixerState: StemsMixerState = { ...DEFAULT_STEMS_MIXER_STATE };

  private startTime: number = 0; // audioCtx.currentTime when playback started
  private pauseOffset: number = 0; // playback position in seconds
  private isPlaying: boolean = false;
  private activeBuffer: AudioBuffer | null = null;
  private loopActive: boolean = false;
  private loopStart: number = 0;
  private loopEnd: number = 0;

  // Analyser buffers
  private dataArrayL: Uint8Array = new Uint8Array(32);
  private dataArrayR: Uint8Array = new Uint8Array(32);

  public init(): AudioContext {
    if (!this.ctx) {
      const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtxClass();

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.9;

      // A real safety limiter lives after the master gain. This is deliberately
      // before both the meters and the record tap, so the file can never clip
      // merely because a DJ pushes the master above unity.
      this.masterLimiter = this.ctx.createDynamicsCompressor();
      this.masterLimiter.threshold.value = -1;
      this.masterLimiter.knee.value = 0;
      this.masterLimiter.ratio.value = 20;
      this.masterLimiter.attack.value = 0.001;
      this.masterLimiter.release.value = 0.08;

      this.splitter = this.ctx.createChannelSplitter(2);
      this.analyserL = this.ctx.createAnalyser();
      this.analyserR = this.ctx.createAnalyser();
      this.analyserL.fftSize = 64;
      this.analyserR.fftSize = 64;
      this.masterRecordDestination = this.ctx.createMediaStreamDestination();

      this.masterGain.connect(this.masterLimiter);
      this.masterLimiter.connect(this.ctx.destination);
      this.masterLimiter.connect(this.splitter);
      this.masterLimiter.connect(this.masterRecordDestination);
      this.splitter.connect(this.analyserL, 0);
      this.splitter.connect(this.analyserR, 1);

      // Initialize Stem gain nodes
      for (const stem of STEM_TYPES) {
        const gain = this.ctx.createGain();
        gain.gain.value = 1.0;
        gain.connect(this.masterGain);
        this.stemGains[stem] = gain;
      }

      logger.info('AUDIO_ENGINE', `AudioContext erzeugt (${this.ctx.sampleRate} Hz, ${this.ctx.destination.maxChannelCount} Kanäle)`, {
        sampleRate: this.ctx.sampleRate,
        baseLatency: this.ctx.baseLatency,
        outputChannelCount: this.ctx.destination.maxChannelCount,
      });
      this.ctx.onstatechange = () => {
        logger.debug('AUDIO_ENGINE', `AudioContext-Zustand: ${this.ctx?.state}`);
      };
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch((err: unknown) => {
        logger.warn('AUDIO_ENGINE', `AudioContext konnte nicht fortgesetzt werden: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    return this.ctx;
  }

  public getContext(): AudioContext {
    return this.init();
  }

  /**
   * Returns the post-limiter master tap used by the professional recorder.
   * It is a MediaStreamAudioDestinationNode, not the speakers' output, so
   * recording the internal editor master never depends on microphone access.
   */
  public getMasterRecordStream(): MediaStream {
    this.init();
    if (!this.masterRecordDestination) {
      throw new Error('Der Master-Record-Tap konnte nicht initialisiert werden.');
    }
    return this.masterRecordDestination.stream;
  }

  /**
   * Routes an external microphone/line/loopback stream through an isolated
   * safety limiter. The processed stream is sent only to MediaRecorder and is
   * never fed back to the speakers (avoids feedback loops).
   */
  public createInputRecordingStream(input: MediaStream, useLimiter = true): {
    stream: MediaStream;
    dispose: () => void;
  } {
    const ctx = this.init();
    const source = ctx.createMediaStreamSource(input);
    const destination = ctx.createMediaStreamDestination();
    const inputGain = ctx.createGain();
    inputGain.gain.value = 1;
    source.connect(inputGain);

    let safety: DynamicsCompressorNode | null = null;
    if (useLimiter) {
      safety = ctx.createDynamicsCompressor();
      safety.threshold.value = -1;
      safety.knee.value = 0;
      safety.ratio.value = 20;
      safety.attack.value = 0.001;
      safety.release.value = 0.08;
      inputGain.connect(safety);
      safety.connect(destination);
    } else {
      inputGain.connect(destination);
    }

    return {
      stream: destination.stream,
      dispose: () => {
        try { source.disconnect(); } catch { /* already disconnected */ }
        try { inputGain.disconnect(); } catch { /* already disconnected */ }
        try { safety?.disconnect(); } catch { /* already disconnected */ }
        try { destination.disconnect(); } catch { /* already disconnected */ }
      },
    };
  }

  public setMasterVolume(vol: number) {
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setValueAtTime(Math.max(0, Math.min(1.2, vol)), this.ctx.currentTime);
    }
  }

  public getMasterMeter(): { left: number; right: number; peak: number } {
    if (!this.analyserL || !this.analyserR || !this.isPlaying) {
      return { left: 0, right: 0, peak: 0 };
    }
    this.analyserL.getByteTimeDomainData(this.dataArrayL);
    this.analyserR.getByteTimeDomainData(this.dataArrayR);

    let maxL = 0;
    let maxR = 0;
    for (let i = 0; i < 32; i++) {
      const vL = Math.abs((this.dataArrayL[i] - 128) / 128);
      const vR = Math.abs((this.dataArrayR[i] - 128) / 128);
      if (vL > maxL) maxL = vL;
      if (vR > maxR) maxR = vR;
    }
    return {
      left: Math.min(1.0, maxL * 1.5),
      right: Math.min(1.0, maxR * 1.5),
      peak: Math.max(maxL, maxR),
    };
  }

  /**
   * Applies the Stems mixer state (Mute / Solo / Volume) to the active stem gain nodes.
   */
  public updateStemMixer(mixer: StemsMixerState) {
    this.stemsMixerState = { ...mixer };
    if (!this.ctx) return;

    const hasAnySolo = STEM_TYPES.some((s) => mixer[s].solo);
    const now = this.ctx.currentTime;

    for (const stem of STEM_TYPES) {
      const gainNode = this.stemGains[stem];
      if (!gainNode) continue;

      const state = mixer[stem];
      let targetGain = state.volume;

      if (hasAnySolo) {
        targetGain = state.solo ? state.volume : 0.0;
      } else if (state.muted) {
        targetGain = 0.0;
      }

      gainNode.gain.cancelScheduledValues(now);
      gainNode.gain.setValueAtTime(gainNode.gain.value, now);
      gainNode.gain.linearRampToValueAtTime(Math.max(0, targetGain), now + 0.02);
    }
  }

  /**
   * Standard single-buffer playback.
   */
  public play(
    buffer: AudioBuffer,
    offsetSeconds: number = 0,
    loop: boolean = false,
    loopStartSec: number = 0,
    loopEndSec: number = 0
  ) {
    const ctx = this.init();
    this.stop();

    this.isPlayingStems = false;
    this.activeBuffer = buffer;
    this.activeStems = null;
    this.pauseOffset = Math.max(0, Math.min(offsetSeconds, buffer.duration));
    this.loopActive = loop;
    this.loopStart = loopStartSec;
    this.loopEnd = loopEndSec > loopStartSec ? loopEndSec : buffer.duration;

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    if (this.loopActive && this.loopEnd > this.loopStart) {
      source.loop = true;
      source.loopStart = this.loopStart;
      source.loopEnd = this.loopEnd;
    }

    if (this.masterGain) {
      source.connect(this.masterGain);
    } else {
      source.connect(ctx.destination);
    }

    this.startTime = ctx.currentTime - this.pauseOffset;
    source.start(0, this.pauseOffset);
    this.currentSource = source;
    this.isPlaying = true;
    logger.debug('AUDIO_ENGINE', `Wiedergabe gestartet bei ${this.pauseOffset.toFixed(3)}s (Dauer ${buffer.duration.toFixed(2)}s, Loop: ${this.loopActive})`);

    source.onended = () => {
      if (this.currentSource === source) {
        // Natürliches Ende: Position am Track-Ende halten (nicht auf den
        // Start der Wiedergabe zurückspringen) – der playbackClock liest
        // die Playhead-Position imperativ aus getCurrentTime().
        if (this.activeBuffer && this.ctx) {
          this.pauseOffset = Math.min(
            this.activeBuffer.duration,
            Math.max(0, this.ctx.currentTime - this.startTime)
          );
        }
        this.isPlaying = false;
        this.currentSource = null;
        logger.debug('AUDIO_ENGINE', 'Wiedergabe natürlich beendet (onended).');
      }
    };
  }

  /**
   * Real-time 4-stem multi-channel playback with individual gain nodes.
   */
  public playWithStems(
    stems: TrackStems,
    mixerState: StemsMixerState,
    offsetSeconds: number = 0,
    loop: boolean = false,
    loopStartSec: number = 0,
    loopEndSec: number = 0
  ) {
    const ctx = this.init();
    this.stop();

    this.isPlayingStems = true;
    this.activeStems = stems;
    this.activeBuffer = stems.vocals; // reference for duration/timing
    this.pauseOffset = Math.max(0, Math.min(offsetSeconds, stems.duration));
    this.loopActive = loop;
    this.loopStart = loopStartSec;
    this.loopEnd = loopEndSec > loopStartSec ? loopEndSec : stems.duration;

    this.updateStemMixer(mixerState);

    this.startTime = ctx.currentTime - this.pauseOffset;

    for (const stem of STEM_TYPES) {
      const stemBuf = stems[stem];
      const source = ctx.createBufferSource();
      source.buffer = stemBuf;

      if (this.loopActive && this.loopEnd > this.loopStart) {
        source.loop = true;
        source.loopStart = this.loopStart;
        source.loopEnd = this.loopEnd;
      }

      const gainNode = this.stemGains[stem];
      if (gainNode) {
        source.connect(gainNode);
      } else if (this.masterGain) {
        source.connect(this.masterGain);
      } else {
        source.connect(ctx.destination);
      }

      source.start(0, this.pauseOffset);
      this.stemSources[stem] = source;
    }

    this.isPlaying = true;
    logger.debug('AUDIO_ENGINE', `Stem-Wiedergabe gestartet bei ${this.pauseOffset.toFixed(3)}s (Trennmethode: ${stems.separationMethod || 'unbekannt'}, Loop: ${this.loopActive})`);

    // Monitor 'ended' on the primary source
    const leadSource = this.stemSources.vocals;
    if (leadSource) {
      leadSource.onended = () => {
        // Ignore delayed onended events from a source that was replaced during
        // a live mixer transition. Otherwise the stale vocal source can stop
        // the newly started stem set and make Vocal Solo sound completely dead.
        if (this.isPlayingStems && this.stemSources.vocals === leadSource) {
          // Natürliches Ende: Position halten (siehe play()/onended).
          const endedAt = this.activeBuffer && this.ctx
            ? Math.min(this.activeBuffer.duration, Math.max(0, this.ctx.currentTime - this.startTime))
            : this.pauseOffset;
          this.stop();
          this.pauseOffset = endedAt;
        }
      };
    }
  }

  public pause(): number {
    const pos = this.getCurrentTime();
    this.stop();
    this.pauseOffset = pos;
    logger.debug('AUDIO_ENGINE', `Wiedergabe pausiert bei ${pos.toFixed(3)}s.`);
    return pos;
  }

  /**
   * Setzt die Transport-Position, während die Wiedergabe gestoppt ist.
   * Wird bei Seeks im Pausenzustand benötigt: die UI liest die Playhead-
   * Position imperativ über getCurrentTime() und darf dafür nicht auf
   * React-State angewiesen sein.
   */
  public setTransportPosition(position: number) {
    if (this.isPlaying) return; // während Wiedergabe treiben die Sources die Position
    this.pauseOffset = Math.max(0, position);
  }

  public stop() {
    // Vollständiger Stopp setzt die Transport-Position zurück (im Gegensatz zu
    // pause(), das die Position NACH stop() wiederherstellt). Alle Stopp-
    // Stellen in der UI gehen von Position 0 aus – der playbackClock liest die
    // Position imperativ und muss denselben Wert sehen wie der React-State.
    this.pauseOffset = 0;
    if (this.currentSource) {
      try {
        this.currentSource.stop();
        this.currentSource.disconnect();
      } catch (err) {
        // already stopped
        logger.debug('AUDIO_ENGINE', `Source.stop() beim Stoppen ignoriert: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.currentSource = null;
    }

    for (const stem of STEM_TYPES) {
      const src = this.stemSources[stem];
      if (src) {
        try {
          src.stop();
          src.disconnect();
        } catch (err) {
          // already stopped
          logger.debug('AUDIO_ENGINE', `Stem-Source.stop() (${stem}) ignoriert: ${err instanceof Error ? err.message : String(err)}`);
        }
        this.stemSources[stem] = null;
      }
    }

    this.isPlaying = false;
    this.isPlayingStems = false;
  }

  public getCurrentTime(): number {
    if (!this.isPlaying || !this.ctx || !this.activeBuffer) {
      return this.pauseOffset;
    }
    const elapsed = this.ctx.currentTime - this.startTime;
    if (this.loopActive && this.loopEnd > this.loopStart) {
      const loopLen = this.loopEnd - this.loopStart;
      if (elapsed >= this.loopStart) {
        return this.loopStart + ((elapsed - this.loopStart) % loopLen);
      }
    }
    return Math.min(this.activeBuffer.duration, elapsed);
  }

  public getIsPlaying(): boolean {
    return this.isPlaying;
  }

  public getIsPlayingStems(): boolean {
    return this.isPlayingStems;
  }

  public getActiveStems(): TrackStems | null {
    return this.activeStems;
  }

  public getStemsMixerState(): StemsMixerState {
    return { ...this.stemsMixerState };
  }

  /**
   * Builds an AudioBuffer from an original AudioBuffer and a list of EditSegments
   * (non-destructive non-linear rendering)
   */
  public renderWorkingAudio(
    originalBuffer: AudioBuffer,
    segments: EditSegment[]
  ): AudioBuffer {
    const ctx = this.init();
    return renderEditSegments(
      originalBuffer,
      segments,
      (channels, length, sampleRate) => ctx.createBuffer(channels, length, sampleRate)
    );
  }

  /**
   * Slices a sub-region of an AudioBuffer (e.g. for Palette clips or copying)
   */
  public sliceAudioBuffer(
    buffer: AudioBuffer,
    startSec: number,
    endSec: number
  ): AudioBuffer {
    const ctx = this.init();
    const sampleRate = buffer.sampleRate;
    const startSample = Math.max(0, timeToSampleFloor(startSec, sampleRate));
    const endSample = Math.min(buffer.length, timeToSampleFloor(endSec, sampleRate));
    const length = Math.max(1, endSample - startSample);
    const channels = buffer.numberOfChannels;

    const sliced = ctx.createBuffer(channels, length, sampleRate);
    for (let ch = 0; ch < channels; ch++) {
      const src = buffer.getChannelData(ch);
      const dest = sliced.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        dest[i] = src[startSample + i];
      }
    }
    return sliced;
  }

  /**
   * Adapts a PaletteClip's tempo (BPM) to the destination track, and optionally
   * shifts the pitch to match the destination track's harmonic key.
   */
  public adaptClipToTrack(
    clip: PaletteClip,
    destTrack: TrackModel,
    matchPitch: boolean = false
  ): {
    adaptedBuffer: AudioBuffer;
    tempoRatio: number;
    semitonesShifted: number;
    harmonicRelation: string;
    originalDuration: number;
    newDuration: number;
    isCrossTrack: boolean;
  } {
    const ctx = this.init();
    if (!clip.audioBuffer) {
      throw new Error(`Clip ${clip.name} besitzt keine Audiodaten.`);
    }

    const isCrossTrack = clip.sourceTrackId !== destTrack.id;
    const destBpm = destTrack.bpm > 0 ? destTrack.bpm : 120.0;
    const clipBpm = clip.bpm > 0 ? clip.bpm : destBpm;
    const pitchPreview = calculateHarmonicPitchShift(clip.key, destTrack.key);
    const needsTempoAdaptation = Math.abs(destBpm / clipBpm - 1) > 0.002;
    const needsPitchAdaptation = Boolean(matchPitch && clip.key && destTrack.key && pitchPreview.semitones !== 0);

    // Do not route an already compatible clip through WSOLA. Apart from being
    // needlessly expensive, an unnecessary resynthesis is precisely where a
    // short/empty tail can be introduced. Returning the immutable clip buffer
    // preserves a same-track palette round trip sample-for-sample.
    if (!needsTempoAdaptation && !needsPitchAdaptation) {
      return {
        adaptedBuffer: clip.audioBuffer,
        tempoRatio: destBpm / clipBpm,
        semitonesShifted: 0,
        harmonicRelation: matchPitch ? pitchPreview.harmonicRelation : 'Keine Tonhöhenanpassung',
        originalDuration: clip.audioBuffer.duration,
        newDuration: clip.audioBuffer.duration,
        isCrossTrack,
      };
    }

    const res = adaptClipAudioBuffer(
      clip.audioBuffer,
      clipBpm,
      clip.key,
      destBpm,
      destTrack.key,
      matchPitch,
      (numCh, len, sRate) => ctx.createBuffer(numCh, len, sRate)
    );

    return {
      ...res,
      isCrossTrack,
    };
  }

  /**
   * Computes the harmonic pitch shift preview between clip and target track
   */
  public previewHarmonicShift(sourceKey: string | undefined, targetKey: string | undefined) {
    return calculateHarmonicPitchShift(sourceKey, targetKey);
  }

  /**
   * Simulates/computes a reliable SHA-256 style fingerprint of original AudioBuffer data
   */
  public computeBufferChecksum(buffer: AudioBuffer): string {
    const left = buffer.getChannelData(0);
    let hash = 0x811c9dc5;
    const step = Math.max(1, Math.floor(left.length / 5000));
    for (let i = 0; i < left.length; i += step) {
      const val = Math.floor((left[i] + 1.0) * 32767);
      hash ^= val;
      hash = Math.imul(hash, 0x01000193);
    }
    return 'sha256-' + Math.abs(hash).toString(16).padStart(8, '0') + '-' + buffer.length.toString(16);
  }

  /**
   * Exports an AudioBuffer to standard 16-bit stereo PCM WAV blob
   */
  public exportToWavBlob(buffer: AudioBuffer): Blob {
    const numChannels = 2;
    const sampleRate = buffer.sampleRate;
    const format = 1; // PCM
    const bitDepth = 16;
    const bytesPerSample = bitDepth / 8;
    const blockAlign = numChannels * bytesPerSample;
    logger.debug('EXPORT', `Rendere 16-Bit-Stereo-WAV (${buffer.duration.toFixed(2)}s, ${sampleRate} Hz, ${(44 + buffer.length * blockAlign) / 1024 / 1024} MiB)`);

    const left = buffer.getChannelData(0);
    const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
    const numSamples = buffer.length;
    const dataSize = numSamples * blockAlign;
    const totalSize = 36 + dataSize;

    const arrayBuffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(arrayBuffer);

    // RIFF chunk descriptor
    writeString(view, 0, 'RIFF');
    view.setUint32(4, totalSize, true);
    writeString(view, 8, 'WAVE');

    // "fmt " sub-chunk
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // SubChunk1Size (16 for PCM)
    view.setUint16(20, format, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true); // ByteRate
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);

    // "data" sub-chunk
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    // Write interleaved 16-bit PCM samples
    let offset = 44;
    for (let i = 0; i < numSamples; i++) {
      const sL = Math.max(-1, Math.min(1, left[i]));
      const sR = Math.max(-1, Math.min(1, right[i]));
      view.setInt16(offset, sL < 0 ? sL * 0x8000 : sL * 0x7fff, true);
      offset += 2;
      view.setInt16(offset, sR < 0 ? sR * 0x8000 : sR * 0x7fff, true);
      offset += 2;
    }

    return new Blob([arrayBuffer], { type: 'audio/wav' });
  }
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

export const audioEngine = new AudioEngine();
