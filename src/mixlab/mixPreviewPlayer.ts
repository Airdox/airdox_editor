/**
 * @license
 * Mix Lab preview player — read-only WebAudio playback of the mix preview.
 *
 * DATA-INTEGRITY CONTRACT (von A bis Z):
 *  - Plays ONLY already-loaded in-memory AudioBuffers (track audioBuffer /
 *    clip audioBuffer) through fresh source nodes. The buffers are never
 *    written to; crossfade gains happen in GainNode envelopes at playback
 *    time only.
 *  - Uses the app's shared AudioContext via `audioEngine.getContext()` but
 *    owns its own source/gain graph, so the main transport and master bus
 *    are left untouched (preview audio is mixed at 70 % into the context
 *    destination, not into the master meter bus).
 *  - No project state is read for writing, no segment is created, nothing
 *    is persisted. The preview exists only while it plays.
 */

import { audioEngine } from '../audio/audioEngine';
import { MixCurve, crossfadeGainsAt } from './mixPreviewModel';

export interface MixPreviewPlaybackParams {
  bufferA: AudioBuffer;
  /** Position inside A from which A starts (window start). */
  offsetA: number;
  bufferB: AudioBuffer;
  /** Position inside B from which B starts playing (drop offset). */
  offsetB: number;
  /** Mix-timeline time (relative to window start) where the crossfade begins. */
  crossfadeStartInWindow: number;
  crossfadeSeconds: number;
  curve: MixCurve;
  /** Total window length in seconds. */
  windowDuration: number;
  /** Mix-timeline time (relative to window start) where B starts. */
  bStartInWindow: number;
}

interface LivePreview {
  sourceA: AudioBufferSourceNode;
  sourceB: AudioBufferSourceNode;
  gainA: GainNode;
  gainB: GainNode;
  monitor: GainNode;
  startedAt: number; // AudioContext time of window start
  windowStart: number; // mix-timeline seconds of window start (absolute A time)
  windowDuration: number;
}

const PREVIEW_LEVEL = 0.7;
const ENVELOPE_RESOLUTION_PER_SECOND = 200;

export class MixPreviewPlayer {
  private live: LivePreview | null = null;

  get isPlaying(): boolean {
    return this.live !== null;
  }

  /**
   * Starts the preview. Returns the absolute mix-timeline time of the window
   * start (for the playhead), or null when buffers are missing.
   */
  play(params: MixPreviewPlaybackParams): number | null {
    this.stop();
    const { bufferA, bufferB } = params;
    if (!bufferA || !bufferB) return null;

    const ctx = audioEngine.getContext();
    const monitor = ctx.createGain();
    monitor.gain.value = PREVIEW_LEVEL;
    monitor.connect(ctx.destination);

    const gainA = ctx.createGain();
    const gainB = ctx.createGain();
    gainA.connect(monitor);
    gainB.connect(monitor);

    const windowDuration = Math.max(0.1, params.windowDuration);
    const points = Math.max(32, Math.ceil(windowDuration * ENVELOPE_RESOLUTION_PER_SECOND));
    const curveA = new Float32Array(points + 1);
    const curveB = new Float32Array(points + 1);
    const cfStart = Math.max(0, params.crossfadeStartInWindow);
    const cfEnd = cfStart + Math.max(0.05, params.crossfadeSeconds);

    for (let i = 0; i <= points; i++) {
      const t = (i / points) * windowDuration;
      let a = 0;
      let b = 0;
      if (t < cfStart) {
        a = 1;
      } else if (t < cfEnd) {
        const g = crossfadeGainsAt(params.curve, (t - cfStart) / Math.max(0.05, cfEnd - cfStart));
        a = g.a;
        b = g.b;
      } else {
        b = 1;
      }
      curveA[i] = a;
      curveB[i] = b;
    }

    const now = ctx.currentTime + 0.08;

    const sourceA = ctx.createBufferSource();
    sourceA.buffer = bufferA;
    sourceA.connect(gainA);
    sourceA.start(now, Math.max(0, params.offsetA));
    sourceA.stop(now + windowDuration);
    gainA.gain.setValueCurveAtTime(curveA, now, windowDuration);

    const bStartDelay = Math.max(0, Math.min(windowDuration, params.bStartInWindow));
    const sourceB = ctx.createBufferSource();
    sourceB.buffer = bufferB;
    sourceB.connect(gainB);
    sourceB.start(now + bStartDelay, Math.max(0, params.offsetB));
    sourceB.stop(now + windowDuration);
    gainB.gain.setValueCurveAtTime(curveB, now, windowDuration);

    this.live = {
      sourceA,
      sourceB,
      gainA,
      gainB,
      monitor,
      startedAt: now,
      windowStart: 0, // set by caller bookkeeping (absolute time handled by the view)
      windowDuration,
    };
    return now;
  }

  /** Elapsed window seconds since the preview started (clamped to the window). */
  getElapsedWindowSeconds(): number {
    if (!this.live) return 0;
    const ctx = audioEngine.getContext();
    return Math.min(this.live.windowDuration, Math.max(0, ctx.currentTime - this.live.startedAt));
  }

  stop(): void {
    if (!this.live) return;
    const { sourceA, sourceB, gainA, gainB, monitor } = this.live;
    this.live = null;
    for (const source of [sourceA, sourceB]) {
      try {
        source.stop();
      } catch {
        // already stopped
      }
      try {
        source.disconnect();
      } catch {
        // already disconnected
      }
    }
    for (const node of [gainA, gainB, monitor]) {
      try {
        node.disconnect();
      } catch {
        // already disconnected
      }
    }
  }
}
