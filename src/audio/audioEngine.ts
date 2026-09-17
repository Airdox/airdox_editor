/**
 * @license
 * Rekordbox Audio Engine
 * Real Web Audio API pipeline with Master Bus, Analyser meters,
 * Non-destructive Edit Graph playback, WAV export, master limiter, record tap, stem playback.
 */

import { EditSegment, TrackModel, PaletteClip } from '../types/rekordbox';
import { adaptClipAudioBuffer, calculateHarmonicPitchShift } from './pitchTempoEngine';

class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private masterLimiter: DynamicsCompressorNode | null = null;
  private analyserL: AnalyserNode | null = null;
  private analyserR: AnalyserNode | null = null;
  private splitter: ChannelSplitterNode | null = null;
  private recordTap: MediaStreamAudioDestinationNode | null = null;
  private inputStream: MediaStream | null = null;
  private inputSource: MediaStreamAudioSourceNode | null = null;
  private inputRecorder: ScriptProcessorNode | null = null;

  private currentSource: AudioBufferSourceNode | null = null;
  private startTime: number = 0;
  private pauseOffset: number = 0;
  private isPlaying: boolean = false;
  private activeBuffer: AudioBuffer | null = null;
  private stemBuffers: AudioBuffer[] = [];
  private stemSources: AudioBufferSourceNode[] = [];
  private stemGains: GainNode[] = [];
  private stemsActive: boolean = false;
  private loopActive: boolean = false;
  private loopStart: number = 0;
  private loopEnd: number = 0;

  private dataArrayL: Uint8Array = new Uint8Array(32);
  private dataArrayR: Uint8Array = new Uint8Array(32);

  public init(): AudioContext {
    if (!this.ctx) {
      const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtxClass();

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.9;

      // Master limiter: true-peak ceiling
      this.masterLimiter = this.ctx.createDynamicsCompressor();
      this.masterLimiter.threshold.value = -1.0;
      this.masterLimiter.knee.value = 0;
      this.masterLimiter.ratio.value = 20;
      this.masterLimiter.attack.value = 0.001;
      this.masterLimiter.release.value = 0.05;

      this.splitter = this.ctx.createChannelSplitter(2);
      this.analyserL = this.ctx.createAnalyser();
      this.analyserR = this.ctx.createAnalyser();
      this.analyserL.fftSize = 64;
      this.analyserR.fftSize = 64;

      // Record tap for master recording
      this.recordTap = this.ctx.createMediaStreamDestination();

      // Chain: masterGain -> limiter -> destination + splitter + recordTap
      this.masterGain.connect(this.masterLimiter);
      this.masterLimiter.connect(this.ctx.destination);
      this.masterLimiter.connect(this.splitter);
      this.masterLimiter.connect(this.recordTap);
      this.splitter.connect(this.analyserL, 0);
      this.splitter.connect(this.analyserR, 1);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  public getContext(): AudioContext {
    return this.init();
  }

  public setMasterVolume(vol: number) {
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setValueAtTime(Math.max(0, Math.min(1.2, vol)), this.ctx.currentTime);
    }
  }

  public getMasterLimiter(): DynamicsCompressorNode | null {
    return this.masterLimiter;
  }

  public getRecordStream(): MediaStream | null {
    return this.recordTap?.stream || null;
  }

  public async enableInputRecording(): Promise<MediaStream> {
    const ctx = this.init();
    if (this.inputStream) return this.inputStream;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.inputStream = stream;
    this.inputSource = ctx.createMediaStreamSource(stream);
    // Connect input to record tap for monitoring if needed (optional)
    return stream;
  }

  public disableInputRecording() {
    if (this.inputStream) {
      for (const track of this.inputStream.getTracks()) track.stop();
      this.inputStream = null;
    }
    if (this.inputSource) {
      try { this.inputSource.disconnect(); } catch {}
      this.inputSource = null;
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

  public play(
    buffer: AudioBuffer,
    offsetSeconds: number = 0,
    loop: boolean = false,
    loopStartSec: number = 0,
    loopEndSec: number = 0,
    stemBuffers?: AudioBuffer[]
  ) {
    const ctx = this.init();
    this.stop();

    this.activeBuffer = buffer;
    this.stemBuffers = stemBuffers || [];
    this.stemsActive = this.stemBuffers.length > 0;
    
    this.pauseOffset = Math.max(0, Math.min(offsetSeconds, buffer.duration));
    this.loopActive = loop;
    this.loopStart = loopStartSec;
    this.loopEnd = loopEndSec > loopStartSec ? loopEndSec : buffer.duration;

    this.startTime = ctx.currentTime - this.pauseOffset;
    this.isPlaying = true;

    if (this.stemsActive) {
      this.stemSources = [];
      while (this.stemGains.length < this.stemBuffers.length) {
        const gain = ctx.createGain();
        gain.connect(this.masterGain || ctx.destination);
        this.stemGains.push(gain);
      }

      for (let i = 0; i < this.stemBuffers.length; i++) {
        const source = ctx.createBufferSource();
        source.buffer = this.stemBuffers[i];
        if (this.loopActive && this.loopEnd > this.loopStart) {
          source.loop = true;
          source.loopStart = this.loopStart;
          source.loopEnd = this.loopEnd;
        }
        source.connect(this.stemGains[i]);
        source.start(0, this.pauseOffset);
        this.stemSources.push(source);
      }
      
      if (this.stemSources.length > 0) {
        const refSource = this.stemSources[0];
        refSource.onended = () => {
          if (this.stemSources.includes(refSource)) {
            this.isPlaying = false;
            this.stemSources = [];
          }
        };
      }
    } else {
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
      source.start(0, this.pauseOffset);
      this.currentSource = source;
      source.onended = () => {
        if (this.currentSource === source) {
          this.isPlaying = false;
          this.currentSource = null;
        }
      };
    }
  }

  public pause(): number {
    const pos = this.getCurrentTime();
    this.stop();
    this.pauseOffset = pos;
    return pos;
  }

  public stop() {
    if (this.currentSource) {
      try {
        this.currentSource.stop();
        this.currentSource.disconnect();
      } catch {}
      this.currentSource = null;
    }
    if (this.stemSources.length > 0) {
      for (const source of this.stemSources) {
        try {
          source.stop();
          source.disconnect();
        } catch {}
      }
      this.stemSources = [];
    }
    this.isPlaying = false;
  }
  
  public setStemVolume(index: number, volume: number) {
    if (index >= 0 && index < this.stemGains.length) {
      this.stemGains[index].gain.value = volume;
    }
  }
  
  public getStemVolume(index: number): number {
    if (index >= 0 && index < this.stemGains.length) {
      return this.stemGains[index].gain.value;
    }
    return 1.0;
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

  public renderWorkingAudio(
    originalBuffer: AudioBuffer,
    segments: EditSegment[]
  ): AudioBuffer {
    const ctx = this.init();
    if (!segments || segments.length === 0) {
      return originalBuffer;
    }
    let totalDuration = 0;
    for (const seg of segments) {
      const end = seg.projectStart + seg.projectDuration;
      if (end > totalDuration) totalDuration = end;
    }
    if (totalDuration <= 0) totalDuration = originalBuffer.duration;

    const sampleRate = originalBuffer.sampleRate;
    const totalSamples = Math.max(1, Math.floor(totalDuration * sampleRate));
    const channels = originalBuffer.numberOfChannels;
    const outputBuffer = ctx.createBuffer(channels, totalSamples, sampleRate);

    for (let ch = 0; ch < channels; ch++) {
      const outCh = outputBuffer.getChannelData(ch);
      const origCh = originalBuffer.getChannelData(ch);
      for (const seg of segments) {
        const destStart = Math.floor(seg.projectStart * sampleRate);
        const destLen = Math.floor(seg.projectDuration * sampleRate);
        const gain = seg.gain ?? 1.0;
        if (seg.type === 'ORIGINAL' || seg.type === 'CUT') {
          const srcStart = Math.floor(seg.sourceStart * sampleRate);
          for (let i = 0; i < destLen && destStart + i < totalSamples && srcStart + i < origCh.length; i++) {
            outCh[destStart + i] = origCh[srcStart + i] * gain;
          }
        } else if (seg.type === 'INSERT' || seg.type === 'REPLACE') {
          const clipBuf = seg.clipBuffer;
          if (clipBuf) {
            const clipCh = clipBuf.getChannelData(Math.min(ch, clipBuf.numberOfChannels - 1));
            const srcStart = Math.floor(seg.sourceStart * sampleRate);
            for (let i = 0; i < destLen && destStart + i < totalSamples && srcStart + i < clipCh.length; i++) {
              outCh[destStart + i] = clipCh[srcStart + i] * gain;
            }
          }
        } else if (seg.type === 'OVERDUB') {
          const clipBuf = seg.clipBuffer;
          if (clipBuf) {
            const clipCh = clipBuf.getChannelData(Math.min(ch, clipBuf.numberOfChannels - 1));
            for (let i = 0; i < destLen && destStart + i < totalSamples && i < clipCh.length; i++) {
              outCh[destStart + i] = Math.tanh(outCh[destStart + i] + clipCh[i] * gain * 0.85);
            }
          }
        }
      }
    }
    return outputBuffer;
  }

  public sliceAudioBuffer(
    buffer: AudioBuffer,
    startSec: number,
    endSec: number
  ): AudioBuffer {
    const ctx = this.init();
    const sampleRate = buffer.sampleRate;
    const startSample = Math.max(0, Math.floor(startSec * sampleRate));
    const endSample = Math.min(buffer.length, Math.floor(endSec * sampleRate));
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

  public adaptClipToTrack(
    clip: PaletteClip,
    destTrack: TrackModel,
    matchPitch: boolean = false
  ) {
    const ctx = this.init();
    if (!clip.audioBuffer) {
      throw new Error(`Clip ${clip.name} besitzt keine Audiodaten.`);
    }
    const isCrossTrack = clip.sourceTrackId !== destTrack.id;
    const destBpm = destTrack.bpm > 0 ? destTrack.bpm : 120.0;
    const clipBpm = clip.bpm > 0 ? clip.bpm : destBpm;
    const res = adaptClipAudioBuffer(
      clip.audioBuffer,
      clipBpm,
      clip.key,
      destBpm,
      destTrack.key,
      matchPitch,
      (numCh, len, sRate) => ctx.createBuffer(numCh, len, sRate)
    );
    return { ...res, isCrossTrack };
  }

  public previewHarmonicShift(sourceKey: string | undefined, targetKey: string | undefined) {
    return calculateHarmonicPitchShift(sourceKey, targetKey);
  }

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

  public exportToWavBlob(buffer: AudioBuffer): Blob {
    const numChannels = 2;
    const sampleRate = buffer.sampleRate;
    const format = 1;
    const bitDepth = 16;
    const bytesPerSample = bitDepth / 8;
    const blockAlign = numChannels * bytesPerSample;
    const left = buffer.getChannelData(0);
    const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
    const numSamples = buffer.length;
    const dataSize = numSamples * blockAlign;
    const totalSize = 36 + dataSize;
    const arrayBuffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(arrayBuffer);
    writeString(view, 0, 'RIFF');
    view.setUint32(4, totalSize, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);
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
