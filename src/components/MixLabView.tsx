/**
 * @license
 * Mix Lab View (Stage 2 vertical slice) — kreative Mix-Vorschau.
 *
 * FEATURES (Vertikalschnitt):
 *  - zwei Clip-/Track-Slots (A ausgehend / B eingehend, Track oder Palette-Clip)
 *  - Drop-Zielvorschau: B-Start, B-Offset, Landung in A-Bezug, Ghost-Region
 *  - Beat-synchronisierte Übergangsvorschau: Anker auf verbatim ANLZ-Beats
 *    (Off/Beat/Bar), BPM-Drift-Hinweis ohne Tempo-Anpassung
 *  - Crossfade-Kurve: Linear / Equal Power / Slow-In-Fast-Out / Fast-In-Slow-Out
 *  - Original-Waveform (reine ANLZ-Daten) plus transparente Mix-Layer
 *    (Gain-Envelopes, Crossfade-Fenster, Ghost-Drop)
 *
 * DATA-INTEGRITY CONTRACT (von A bis Z):
 *  - REIN READ-ONLY VORSCHEAU: Slots referenzieren Tracks/Clips nur per ID.
 *    Es wird kein Segment erzeugt, nichts in das Projekt geschrieben und
 *    keine Originaldatei (ANLZ/PPTH/PWV, DB, XML, Audio) angefasst.
 *  - Waveforms werden ausschließlich über den MixPreviewModel (und damit
 *    selectTrackWaveform) aus echten ANLZ-Varianten gelöst; fehlt die
 *    Waveform, zeigt die Ansicht den ehrlichen Leerzustand — keine Synthese.
 *  - Beat-Linien stammen verbatim aus dem ANLZ/PQTZ-Grid.
 *  - Audio-Vorschau spielt nur geladene In-Memory-Buffer über eine
 *    temporäre Gain-Envelope ab (MixPreviewPlayer) — ohne jeden Schreibzugriff.
 *  - Es gibt bewusst KEINEN "Übernehmen"-Button: das Projekt ändert sich
 *    durch den Mix Lab nie.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PaletteClip, TrackModel, WaveformAnalysisData } from '../types/rekordbox';
import { waveformMissingNotice } from '../waveform/renderModel';
import {
  CROSSFADE_BEAT_OPTIONS,
  MIX_CURVES,
  MixCurve,
  MixPreviewResult,
  MixSlotRef,
  MixSnapMode,
  computeMixPreview,
  describeDropTarget,
  formatMixTime,
} from '../mixlab/mixPreviewModel';
import { MixPreviewPlayer } from '../mixlab/mixPreviewPlayer';
import { AlertTriangle, Disc2, Play, ShieldCheck, Square, X } from 'lucide-react';

interface MixLabViewProps {
  tracks: TrackModel[];
  paletteClips: PaletteClip[];
  activeTrackId: string;
  onClose: () => void;
}

const PAD = 14;
const RULER_H = 26;
const GAP = 18;

function mmss(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function pickDefaultSlots(
  tracks: TrackModel[],
  clips: PaletteClip[],
  activeTrackId: string
): { a: MixSlotRef | null; b: MixSlotRef | null } {
  const first = tracks.find((t) => t.id === activeTrackId) ?? tracks[0] ?? null;
  if (!first) return { a: null, b: null };
  const a: MixSlotRef = { kind: 'TRACK', trackId: first.id };
  const otherTrack = tracks.find((t) => t.id !== first.id);
  const b: MixSlotRef | null = otherTrack
    ? { kind: 'TRACK', trackId: otherTrack.id }
    : clips.length > 0
      ? { kind: 'CLIP', trackId: clips[0].sourceTrackId, clipId: clips[0].id }
      : null;
  return { a, b };
}

function defaultTransitionPosition(track: TrackModel | null | undefined): number {
  if (!track) return 0;
  const bpm = track.bpm > 0 ? track.bpm : 120;
  const spb = 60 / bpm;
  const firstBeat = track.beatGrid ? track.beatGrid.firstBeat : 0;
  return Math.min(Math.max(0, firstBeat + 32 * spb), Math.max(0, track.duration - spb * 2));
}

export const MixLabView: React.FC<MixLabViewProps> = ({ tracks, paletteClips, activeTrackId, onClose }) => {
  const defaults = useMemo(
    () => pickDefaultSlots(tracks, paletteClips, activeTrackId),
    [tracks, paletteClips, activeTrackId]
  );
  const [slotA, setSlotA] = useState<MixSlotRef | null>(defaults.a);
  const [slotB, setSlotB] = useState<MixSlotRef | null>(defaults.b);
  const [curve, setCurve] = useState<MixCurve>('EQUAL_POWER');
  const [crossfadeBeats, setCrossfadeBeats] = useState<number>(4);
  const [beatSnap, setBeatSnap] = useState<MixSnapMode>('BAR');
  const [transitionPosition, setTransitionPosition] = useState<number>(() =>
    defaultTransitionPosition(tracks.find((t) => t.id === (defaults.a?.trackId ?? '')))
  );

  const [isPreviewing, setIsPreviewing] = useState<boolean>(false);
  const [previewElapsed, setPreviewElapsed] = useState<number | null>(null);

  const playerRef = useRef<MixPreviewPlayer | null>(null);
  const rafRef = useRef<number>(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number }>({ w: 1200, h: 320 });

  if (!playerRef.current) playerRef.current = new MixPreviewPlayer();

  // ── Canvas sizing ─────────────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setCanvasSize({ w: Math.max(320, el.clientWidth), h: Math.max(200, el.clientHeight) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Pure preview model (read-only) ────────────────────────────────────────
  const preview: MixPreviewResult | null = useMemo(() => {
    if (!slotA || !slotB) return null;
    return computeMixPreview(
      { slotA, slotB, curve, crossfadeBeats, beatSnap, transitionPosition },
      tracks,
      paletteClips
    );
  }, [slotA, slotB, curve, crossfadeBeats, beatSnap, transitionPosition, tracks, paletteClips]);

  const sameSourceWarning =
    slotA && slotB && slotA.trackId === slotB.trackId && slotA.clipId === slotB.clipId && slotA.kind === slotB.kind;

  // ── Preview playback (in-memory buffers only) ─────────────────────────────
  const stopPreview = useCallback(() => {
    if (playerRef.current) playerRef.current.stop();
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    setIsPreviewing(false);
    setPreviewElapsed(null);
  }, []);

  // Any model change invalidates a running preview.
  useEffect(() => {
    stopPreview();
  }, [preview, stopPreview]);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (playerRef.current) playerRef.current.stop();
    };
  }, []);

  const previewBlockReason = useMemo(() => {
    if (!preview) return 'Beide Slots müssen gewählt sein.';
    const missing: string[] = [];
    if (!preview.trackA.audioBuffer) missing.push('A: Audio nicht geladen');
    if (!((preview.clipB ? preview.clipB.audioBuffer : preview.trackB.audioBuffer))) {
      missing.push('B: Audio nicht geladen');
    }
    return missing.length > 0 ? `Audio-Vorschau nicht möglich — ${missing.join(' · ')}.` : null;
  }, [preview]);

  const startPreview = useCallback(() => {
    if (!preview || previewBlockReason) return;
    const player = playerRef.current;
    if (!player) return;
    const bufferA = preview.trackA.audioBuffer;
    const bufferB = preview.clipB ? preview.clipB.audioBuffer : preview.trackB.audioBuffer;
    if (!bufferA || !bufferB) return;

    const winStart = preview.window.start;
    const winDur = preview.window.end - preview.window.start;
    const bStartRel = preview.drop.startOnMix - winStart;
    const offsetB = bStartRel >= 0 ? preview.drop.offsetIntoB : preview.drop.offsetIntoB + bStartRel;

    const started = player.play({
      bufferA,
      offsetA: winStart,
      bufferB,
      offsetB,
      crossfadeStartInWindow: Math.max(0, preview.anchor.time - winStart),
      crossfadeSeconds: preview.crossfadeSeconds,
      curve: preview.curve,
      windowDuration: winDur,
      bStartInWindow: Math.max(0, bStartRel),
    });
    if (started === null) return;
    setIsPreviewing(true);
    const tick = () => {
      const elapsed = player.getElapsedWindowSeconds();
      setPreviewElapsed(elapsed);
      if (player.isPlaying && elapsed < winDur) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setIsPreviewing(false);
        setPreviewElapsed(null);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [preview, previewBlockReason]);

  // ── Timeline interaction: click sets the transition position ─────────────
  const handleCanvasPointer = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas || !preview) return;
      const rect = canvas.getBoundingClientRect();
      const frac = (e.clientX - rect.left - PAD) / Math.max(1, rect.width - PAD * 2);
      const t = preview.window.start + Math.max(0, Math.min(1, frac)) * (preview.window.end - preview.window.start);
      setTransitionPosition(t);
    },
    [preview]
  );

  // ── Canvas rendering (original ANLZ data + transparent mix layers) ───────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvasSize.w;
    const H = canvasSize.h;
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#0b0c0e';
    g.fillRect(0, 0, W, H);

    if (!preview) {
      g.fillStyle = '#6b6f78';
      g.font = '13px system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText('Wähle für beide Slots einen Track oder einen Palette-Clip aus.', W / 2, H / 2);
      return;
    }

    const innerW = W - PAD * 2;
    const laneH = (H - PAD - GAP - RULER_H - PAD) / 2;
    const yA0 = PAD;
    const yA1 = PAD + laneH;
    const yB0 = yA1 + GAP;
    const yB1 = yB0 + laneH;
    const winStart = preview.window.start;
    const winDur = Math.max(0.001, preview.window.end - preview.window.start);
    const xOf = (t: number) => PAD + ((t - winStart) / winDur) * innerW;
    const tOf = (x: number) => winStart + ((x - PAD) / innerW) * winDur;

    // Lane backgrounds
    g.fillStyle = '#101216';
    g.fillRect(PAD, yA0, innerW, laneH);
    g.fillRect(PAD, yB0, innerW, laneH);
    g.strokeStyle = '#1d2026';
    g.strokeRect(PAD + 0.5, yA0 + 0.5, innerW - 1, laneH - 1);
    g.strokeRect(PAD + 0.5, yB0 + 0.5, innerW - 1, laneH - 1);

    const anchor = preview.anchor.time;
    const cfEnd = anchor + preview.crossfadeSeconds;
    const bStartMix = preview.drop.startOnMix;

    // ── Original waveforms (genuine ANLZ data only; null = honest empty) ────
    const drawWaveform = (
      yTop: number,
      yBottom: number,
      waveform: WaveformAnalysisData | null,
      trackDuration: number,
      color: string,
      noticeTitle: string,
      localTimeAt: (mixT: number) => number | null
    ) => {
      if (!waveform) {
        g.save();
        g.beginPath();
        g.rect(PAD, yTop, innerW, yBottom - yTop);
        g.clip();
        g.fillStyle = '#5b5f68';
        g.font = '11px system-ui, sans-serif';
        g.textAlign = 'center';
        g.fillText(noticeTitle, PAD + innerW / 2, (yTop + yBottom) / 2 - 2);
        g.restore();
        return;
      }
      g.save();
      g.beginPath();
      g.rect(PAD, yTop, innerW, yBottom - yTop);
      g.clip();
      const mid = (yTop + yBottom) / 2;
      const hMax = (yBottom - yTop) / 2 - 3;
      g.strokeStyle = color;
      g.lineWidth = 1;
      for (let px = PAD; px < W - PAD; px += 2) {
        const mixT = tOf(px);
        const localT = localTimeAt(mixT);
        if (localT === null || localT < 0 || localT >= trackDuration) continue;
        const bucket = Math.min(waveform.length - 1, Math.max(0, Math.floor((localT / trackDuration) * waveform.length)));
        const amp = Math.max(
          Math.abs(waveform.peaks[bucket]),
          Math.abs(waveform.peaksL[bucket]),
          Math.abs(waveform.peaksR[bucket])
        );
        const barH = Math.max(1, amp * hMax);
        g.beginPath();
        g.moveTo(px + 1, mid - barH);
        g.lineTo(px + 1, mid + barH);
        g.stroke();
      }
      g.restore();
    };

    const bClip = preview.clipB;
    drawWaveform(
      yA0, yA1,
      preview.aWaveform,
      preview.trackA.duration,
      'rgba(0, 162, 255, 0.85)',
      waveformMissingNotice(preview.trackA).title,
      (mixT) => (mixT >= preview.window.start && mixT <= preview.window.end ? mixT : null)
    );
    drawWaveform(
      yB0, yB1,
      preview.bWaveform,
      preview.trackB.duration,
      'rgba(255, 176, 32, 0.8)',
      waveformMissingNotice(preview.trackB).title,
      (mixT) => {
        const localT = mixT - bStartMix + preview.drop.offsetIntoB;
        if (bClip) {
          return localT >= bClip.sourceStart && localT <= bClip.sourceEnd ? localT : null;
        }
        return localT >= 0 && localT <= preview.trackB.duration ? localT : null;
      }
    );

    // ── Transparent mix layers ──────────────────────────────────────────────
    const gainAAt = (t: number): number => {
      if (t < anchor) return 1;
      if (t < cfEnd) {
        const n = preview.envelopeA.length - 1;
        const f = Math.max(0, Math.min(1, (t - anchor) / preview.crossfadeSeconds));
        return preview.envelopeA[Math.round(f * n)];
      }
      return 0;
    };
    const gainBAt = (t: number): number => {
      if (t < bStartMix || t < anchor) return 0;
      if (t < cfEnd) {
        const n = preview.envelopeB.length - 1;
        const f = Math.max(0, Math.min(1, (t - anchor) / preview.crossfadeSeconds));
        return preview.envelopeB[Math.round(f * n)];
      }
      return 1;
    };
    const drawGainArea = (
      yTop: number,
      yBottom: number,
      from: number,
      to: number,
      valueAt: (t: number) => number,
      fill: string,
      stroke: string,
      fromTop: boolean
    ) => {
      const x0 = Math.max(PAD, xOf(from));
      const x1 = Math.min(W - PAD, xOf(to));
      if (x1 <= x0) return;
      g.save();
      g.beginPath();
      g.rect(PAD, yTop, innerW, yBottom - yTop);
      g.clip();
      g.beginPath();
      let first = true;
      for (let px = x0; px <= x1; px += 2) {
        const gain = valueAt(tOf(px));
        const y = fromTop ? yTop + 3 + (1 - gain) * (laneH - 6) : yBottom - 3 - gain * (laneH - 6);
        if (first) {
          g.moveTo(px, y);
          first = false;
        } else {
          g.lineTo(px, y);
        }
      }
      g.lineTo(x1, fromTop ? yTop : yBottom);
      g.lineTo(x0, fromTop ? yTop : yBottom);
      g.closePath();
      g.fillStyle = fill;
      g.fill();
      g.strokeStyle = stroke;
      g.lineWidth = 1;
      g.stroke();
      g.restore();
    };
    // A full-gain before the anchor, envelope inside the crossfade window.
    drawGainArea(yA0, yA1, preview.window.start, cfEnd, gainAAt, 'rgba(0, 162, 255, 0.14)', 'rgba(0, 162, 255, 0.55)', true);
    // B silent until the anchor, envelope inside the crossfade window, full after.
    drawGainArea(yB0, yB1, Math.max(bStartMix, preview.window.start), preview.window.end, gainBAt, 'rgba(255, 176, 32, 0.14)', 'rgba(255, 176, 32, 0.55)', false);

    // Crossfade window shading
    g.save();
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.fillRect(xOf(anchor), yA0, Math.max(1, xOf(cfEnd) - xOf(anchor)), yB1 - yA0);
    g.strokeStyle = 'rgba(255,255,255,0.25)';
    g.setLineDash([3, 3]);
    g.beginPath();
    g.moveTo(xOf(anchor), yA0);
    g.lineTo(xOf(anchor), yB1);
    g.moveTo(xOf(cfEnd), yA0);
    g.lineTo(xOf(cfEnd), yB1);
    g.stroke();
    g.setLineDash([]);
    g.restore();

    // ── Ghost drop region (B's first bars, dashed) ─────────────────────────
    const ghost = preview.drop.ghostOnMix;
    if (ghost) {
      g.save();
      const gx0 = Math.max(PAD, xOf(ghost.start));
      const gx1 = Math.min(W - PAD, xOf(ghost.end));
      if (gx1 > gx0) {
        g.strokeStyle = 'rgba(255, 176, 32, 0.6)';
        g.setLineDash([6, 4]);
        g.lineWidth = 1;
        g.strokeRect(gx0 + 0.5, yB0 + 2.5, gx1 - gx0 - 1, laneH - 5);
        g.setLineDash([]);
        g.fillStyle = 'rgba(255, 176, 32, 0.75)';
        g.font = '10px ui-monospace, monospace';
        g.textAlign = 'left';
        g.fillText(`Drop-Vorschau · B Bar 1–4${preview.drop.clamped ? ' (Offset geclampt)' : ''}`, gx0 + 6, yB0 + 14);
      }
      g.restore();
    }

    // ── Beat lines (verbatim ANLZ/PQTZ times) ───────────────────────────────
    const drawBeatLines = (
      yTop: number,
      yBottom: number,
      beats: { time: number; isBar: boolean; barNumber: number; tail: boolean }[],
      mixTimeOf: (beatTime: number) => number
    ) => {
      g.save();
      g.beginPath();
      g.rect(PAD, yTop, innerW, yBottom - yTop);
      g.clip();
      for (const beat of beats) {
        const mixT = mixTimeOf(beat.time);
        if (mixT < winStart || mixT > winStart + winDur) continue;
        const x = xOf(mixT);
        const alpha = beat.tail ? 0.3 : beat.isBar ? 0.5 : 0.25;
        g.strokeStyle = `rgba(255,255,255,${alpha})`;
        g.lineWidth = 1;
        g.beginPath();
        if (beat.isBar) {
          g.moveTo(x, yBottom - 20);
          g.lineTo(x, yBottom - 2);
        } else {
          g.moveTo(x, yBottom - 9);
          g.lineTo(x, yBottom - 2);
        }
        g.stroke();
        if (beat.isBar && !beat.tail) {
          g.fillStyle = 'rgba(255,255,255,0.55)';
          g.font = '9px ui-monospace, monospace';
          g.textAlign = 'left';
          g.fillText(String(beat.barNumber), x + 2, yBottom - 22);
        }
      }
      g.restore();
    };
    drawBeatLines(yA0, yA1, preview.aBeats, (t) => t);
    drawBeatLines(yB0, yB1, preview.bBeats, (t) => bStartMix + (t - preview.drop.offsetIntoB));

    // Lane labels
    g.font = '10px ui-monospace, monospace';
    g.textAlign = 'left';
    g.fillStyle = 'rgba(0, 162, 255, 0.9)';
    g.fillText('A · ausgehend', PAD + 6, yA0 + 12);
    g.fillStyle = 'rgba(255, 176, 32, 0.9)';
    g.fillText('B · eingehend', PAD + 6, yB0 + 12);

    // ── Anchor line + label ─────────────────────────────────────────────────
    const ax = xOf(anchor);
    g.save();
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(ax, yA0);
    g.lineTo(ax, yB1);
    g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.font = '10px ui-monospace, monospace';
    g.textAlign = ax > W / 2 ? 'right' : 'left';
    g.fillText(
      `Anker ${formatMixTime(anchor)} · Bar ${preview.anchor.barNumber}/Beat ${preview.anchor.beatInBar}${preview.anchor.uniformFallback ? ' (Uniform)' : ''}`,
      ax + (ax > W / 2 ? -4 : 4),
      yA0 - 3
    );
    g.restore();

    // ── Playhead (preview playback only) ────────────────────────────────────
    if (previewElapsed !== null) {
      const t = winStart + previewElapsed;
      const px = xOf(t);
      g.save();
      g.strokeStyle = '#ffffff';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(px, yA0);
      g.lineTo(px, yB1);
      g.stroke();
      g.fillStyle = '#ffffff';
      g.font = '10px ui-monospace, monospace';
      g.textAlign = 'center';
      g.fillText(formatMixTime(t), px, yB1 + 14);
      g.restore();
    }

    // ── Ruler ───────────────────────────────────────────────────────────────
    const rulerY = yB1 + GAP * 0.6;
    g.strokeStyle = '#1d2026';
    g.beginPath();
    g.moveTo(PAD, rulerY);
    g.lineTo(W - PAD, rulerY);
    g.stroke();
    const steps = [0.5, 1, 2, 5, 10, 15, 30];
    const target = winDur / 8;
    const step = steps.find((s) => s >= target) ?? 30;
    let t0 = Math.ceil(winStart / step) * step;
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.font = '9px ui-monospace, monospace';
    g.textAlign = 'center';
    for (let t = t0; t <= winStart + winDur + 1e-9; t += step) {
      const x = xOf(t);
      g.beginPath();
      g.moveTo(x, rulerY);
      g.lineTo(x, rulerY - 4);
      g.strokeStyle = 'rgba(255,255,255,0.3)';
      g.stroke();
      g.fillText(mmss(t), x, rulerY + 12);
    }
  }, [preview, canvasSize, previewElapsed]);

  // ── Slot card ─────────────────────────────────────────────────────────────
  const renderSlot = (
    label: 'A' | 'B',
    slot: MixSlotRef | null,
    setSlot: (s: MixSlotRef | null) => void,
    colorText: string,
    previewSide: 'a' | 'b'
  ) => {
    const info = preview
      ? previewSide === 'a'
        ? { track: preview.trackA, prov: preview.aProvenance }
        : { track: preview.trackB, prov: preview.bProvenance }
      : null;
    const clip = previewSide === 'b' && preview ? preview.clipB : null;
    const noTracks = tracks.length === 0;
    const noClips = paletteClips.length === 0;

    return (
      <div className="rounded-sm border border-[#23252c] bg-[#101216] p-2.5 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`text-xs font-bold ${colorText}`}>Slot {label}</span>
            {info &&
              (info.prov.sourceTag ? (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#10b981]/10 text-[#34d399] border border-[#10b981]/30 font-mono">
                  ANLZ · {info.prov.sourceTag} · {info.prov.origin}
                </span>
              ) : (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/30 font-mono">
                  keine ANLZ-Waveform
                </span>
              ))}
          </div>
          <span className="text-[9px] text-neutral-500 font-mono uppercase">read-only</span>
        </div>

        <div className="flex gap-2">
          <select
            value={slot?.kind ?? 'TRACK'}
            onChange={(e) => {
              const kind = e.target.value as 'TRACK' | 'CLIP';
              if (kind === 'TRACK') {
                const first = tracks[0];
                setSlot(first ? { kind, trackId: first.id } : null);
              } else {
                const first = paletteClips[0];
                setSlot(first ? { kind, trackId: first.sourceTrackId, clipId: first.id } : null);
              }
            }}
            className="h-7 text-[11px] bg-[#16181d] border border-[#2b2d35] rounded-sm px-1.5 text-neutral-300 focus:outline-none focus:border-[#0088ff]"
          >
            <option value="TRACK">Track</option>
            <option value="CLIP" disabled={noClips}>
              Palette-Clip
            </option>
          </select>
          {slot?.kind === 'TRACK' && (
            <select
              value={slot.trackId}
              onChange={(e) => setSlot({ kind: 'TRACK', trackId: e.target.value })}
              disabled={noTracks}
              className="h-7 flex-1 min-w-0 text-[11px] bg-[#16181d] border border-[#2b2d35] rounded-sm px-1.5 text-neutral-300 focus:outline-none focus:border-[#0088ff] disabled:opacity-40"
            >
              {tracks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.artist ? `${t.artist} – ` : ''}{t.title}
                </option>
              ))}
              {noTracks && <option value="">Keine Tracks geladen</option>}
            </select>
          )}
          {slot?.kind === 'CLIP' && (
            <select
              value={slot.clipId ?? ''}
              onChange={(e) => {
                const c = paletteClips.find((x) => x.id === e.target.value);
                setSlot(c ? { kind: 'CLIP', trackId: c.sourceTrackId, clipId: c.id } : null);
              }}
              disabled={noClips}
              className="h-7 flex-1 min-w-0 text-[11px] bg-[#16181d] border border-[#2b2d35] rounded-sm px-1.5 text-neutral-300 focus:outline-none focus:border-[#0088ff] disabled:opacity-40"
            >
              {paletteClips.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.sourceTrackName}, {c.sourceStart.toFixed(1)}–{c.sourceEnd.toFixed(1)} s)
                </option>
              ))}
              {noClips && <option value="">Keine Clips in der Palette</option>}
            </select>
          )}
        </div>

        {info && (
          <div className="text-[10px] text-neutral-400 font-mono truncate">
            {clip
              ? `Clip: ${clip.name} · ${clip.bpm.toFixed(1)} BPM · ${clip.key || '—'} · ${clip.duration.toFixed(2)} s`
              : `${info.track.artist ? `${info.track.artist} – ` : ''}${info.track.title} · ${info.track.bpm.toFixed(1)} BPM · ${info.track.key || '—'} · ${mmss(info.track.duration)}`}
          </div>
        )}
        {!slot && (
          <div className="text-[10px] text-neutral-500">
            {noTracks && noClips ? 'Keine Quelle verfügbar — importiere zuerst Tracks.' : 'Quelle wählen…'}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 bg-[#0b0c0e] flex flex-col">
      {/* Header */}
      <div className="h-12 flex items-center justify-between px-4 border-b border-[#18191d] bg-[#0a0b0d] shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <Disc2 size={17} className="text-[#00e5ff] shrink-0" />
          <span className="text-sm font-semibold tracking-wide text-neutral-100 whitespace-nowrap">Mix Lab</span>
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#0088ff]/15 text-[#00a2ff] border border-[#0088ff]/30 font-mono whitespace-nowrap">
            VORSCHEAU · KEINE PROJEKTÄNDERUNG
          </span>
          {sameSourceWarning && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-yellow-500/10 text-yellow-400 border border-yellow-500/30 font-mono flex items-center gap-1">
              <AlertTriangle size={10} /> A und B nutzen dieselbe Quelle
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="flex items-center gap-1 text-[10px] text-[#34d399] font-mono">
            <ShieldCheck size={12} /> Read-Only
          </span>
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-sm bg-[#181a20] hover:bg-[#0088ff] border border-[#2b2d35] text-[11px] text-neutral-300 hover:text-white transition-colors"
          >
            <X size={12} /> Schließen
          </button>
        </div>
      </div>

      {/* Slots */}
      <div className="grid grid-cols-2 gap-3 p-3 shrink-0">
        {renderSlot('A', slotA, setSlotA, 'text-[#00a2ff]', 'a')}
        {renderSlot('B', slotB, setSlotB, 'text-[#ffb020]', 'b')}
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 pb-2 text-[11px] text-neutral-300 shrink-0">
        <label className="flex items-center gap-1.5">
          <span className="text-neutral-500">Kurve</span>
          <select
            value={curve}
            onChange={(e) => setCurve(e.target.value as MixCurve)}
            className="h-7 bg-[#16181d] border border-[#2b2d35] rounded-sm px-1.5 focus:outline-none focus:border-[#0088ff]"
          >
            {MIX_CURVES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-neutral-500">Crossfade</span>
          <select
            value={String(crossfadeBeats)}
            onChange={(e) => setCrossfadeBeats(Number(e.target.value))}
            className="h-7 bg-[#16181d] border border-[#2b2d35] rounded-sm px-1.5 focus:outline-none focus:border-[#0088ff]"
          >
            {CROSSFADE_BEAT_OPTIONS.map((b) => (
              <option key={b} value={String(b)}>
                {b} Beats
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-neutral-500">Beat-Snap</span>
          <select
            value={beatSnap}
            onChange={(e) => setBeatSnap(e.target.value as MixSnapMode)}
            className="h-7 bg-[#16181d] border border-[#2b2d35] rounded-sm px-1.5 focus:outline-none focus:border-[#0088ff]"
          >
            <option value="OFF">Aus</option>
            <option value="BEAT">Nächster Beat</option>
            <option value="BAR">Nächster Bar-Anfang</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-neutral-500">Übergang bei</span>
          <input
            type="number"
            step={0.1}
            min={0}
            value={Number(transitionPosition.toFixed(3))}
            onChange={(e) => setTransitionPosition(Math.max(0, Number(e.target.value) || 0))}
            className="w-24 h-7 bg-[#16181d] border border-[#2b2d35] rounded-sm px-1.5 font-mono focus:outline-none focus:border-[#0088ff]"
          />
          <span className="text-neutral-500">s{preview && preview.anchor.snapped ? ' → Anker' : ''}</span>
        </label>
        <div className="flex items-center gap-1.5">
          <button
            onClick={startPreview}
            disabled={!isPreviewing || !!previewBlockReason}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-sm bg-[#10b981]/15 hover:bg-[#10b981]/30 border border-[#10b981]/40 text-[#34d399] disabled:opacity-40 transition-colors"
            title={previewBlockReason ?? 'Mix-Vorschau abspielen (In-Memory-Buffer, ohne Schreibzugriff)'}
          >
            <Play size={11} /> Vorschau
          </button>
          <button
            onClick={stopPreview}
            disabled={!isPreviewing}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-sm bg-[#181a20] hover:bg-[#26282f] border border-[#2b2d35] text-neutral-300 disabled:opacity-40 transition-colors"
          >
            <Square size={11} /> Stopp
          </button>
        </div>
        {previewBlockReason && (
          <span className="flex items-center gap-1 text-[10px] text-yellow-400">
            <AlertTriangle size={11} /> {previewBlockReason}
          </span>
        )}
      </div>

      {/* Timeline */}
      <div className="flex-1 min-h-0 px-3 pb-1 flex flex-col">
        <div ref={containerRef} className="flex-1 relative rounded-sm border border-[#1d2026] overflow-hidden">
          <canvas
            ref={canvasRef}
            className="w-full h-full block cursor-crosshair"
            onPointerDown={handleCanvasPointer}
          />
        </div>
      </div>

      {/* Drop target + provenance/issues */}
      <div className="h-44 grid grid-cols-2 gap-px bg-[#18191d] border-t border-[#18191d] shrink-0">
        <div className="bg-[#0d0e11] p-3 overflow-auto">
          <div className="text-[9px] uppercase tracking-wider text-neutral-500 mb-1.5 font-semibold">
            Drop-Zielvorschau
          </div>
          {preview ? (
            <pre className="text-[10.5px] leading-relaxed font-mono text-neutral-300 whitespace-pre-wrap">
              {describeDropTarget(preview)}
            </pre>
          ) : (
            <div className="text-[11px] text-neutral-500">Keine Vorschau — beide Slots wählen.</div>
          )}
        </div>
        <div className="bg-[#0d0e11] p-3 overflow-auto">
          <div className="text-[9px] uppercase tracking-wider text-neutral-500 mb-1.5 font-semibold">
            Provenance & Hinweise
          </div>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {preview && (
              <>
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#10b981]/10 text-[#34d399] border border-[#10b981]/30 font-mono">
                  A: {preview.aProvenance.sourceTag ?? 'keine Waveform'}
                </span>
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#10b981]/10 text-[#34d399] border border-[#10b981]/30 font-mono">
                  B: {preview.bProvenance.sourceTag ?? 'keine Waveform'}
                </span>
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#0088ff]/10 text-[#00a2ff] border border-[#0088ff]/30 font-mono">
                  Beats: ANLZ/PQTZ verbatim
                </span>
              </>
            )}
          </div>
          <ul className="space-y-1 text-[10.5px] text-neutral-400">
            {(preview?.issues ?? []).map((issue, i) => (
              <li key={i} className="flex gap-1.5">
                <AlertTriangle size={11} className="text-yellow-500 shrink-0 mt-0.5" />
                <span>{issue}</span>
              </li>
            ))}
            {!preview?.issues?.length && (
              <li className="text-neutral-500">Keine Hinweise — alle Vorschau-Quellen vollständig.</li>
            )}
          </ul>
        </div>
      </div>

      {/* Footer */}
      <div className="h-7 px-3 flex items-center text-[10px] text-neutral-500 border-t border-[#18191d] bg-[#0a0b0d] shrink-0">
        Reine Vorschau — der Mix Lab verändert weder das Projekt noch die Originaldaten (Read-Only, keine Synthese).
        &nbsp;Klick auf die Timeline setzt die Übergangsposition.
      </div>
    </div>
  );
};
