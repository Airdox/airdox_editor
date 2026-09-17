import React, { useRef, useEffect } from 'react';
import type { WaveformAnalysisData } from '../types/rekordbox';

interface Props {
  analysis: WaveformAnalysisData | null;
  width?: number;
  height?: number;
  startSec?: number;
  endSec?: number;
  color?: string;
}

/**
 * Detailed clip waveform identical to DetailWaveform – no synthetic fallback in production
 */
export const ClipWaveform: React.FC<Props> = ({ analysis, width = 300, height = 60, startSec = 0, endSec, color }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);

    if (!analysis || !analysis.peaks || analysis.peaks.length === 0) {
      // Honest empty state – no invented floor
      ctx.fillStyle = '#222';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#666';
      ctx.font = '10px sans-serif';
      ctx.fillText('No waveform – ANLZ not found', 5, height / 2);
      return;
    }

    const totalBuckets = analysis.length;
    const secPerBucket = analysis.secPerBucket || 0.005;
    const startBucket = Math.floor(startSec / secPerBucket);
    const endBucket = endSec ? Math.floor(endSec / secPerBucket) : totalBuckets;
    const visibleBuckets = Math.max(1, endBucket - startBucket);

    // Draw detailed waveform identical to DetailWaveform (continuous envelope, no synthetic bars)
    ctx.beginPath();
    ctx.strokeStyle = color || '#00a2ff';
    ctx.lineWidth = 1;

    for (let i = 0; i < width; i++) {
      const bucketIdx = startBucket + Math.floor((i / width) * visibleBuckets);
      if (bucketIdx < 0 || bucketIdx >= totalBuckets) continue;
      const peak = analysis.peaks[bucketIdx] || 0;
      const low = analysis.lowEnergy?.[bucketIdx] || 0;
      const mid = analysis.midEnergy?.[bucketIdx] || 0;
      const high = analysis.highEnergy?.[bucketIdx] || 0;

      // Use spectral color per column RGB
      const r = Math.floor((low * 0.8 + mid * 0.2) * 255);
      const g = Math.floor((mid * 0.7 + low * 0.3) * 255);
      const b = Math.floor((high * 0.8 + mid * 0.2) * 255);
      ctx.fillStyle = `rgb(${r},${g},${b})`;

      const h = peak * height;
      const y = (height - h) / 2;
      ctx.fillRect(i, y, 1, h);
    }
  }, [analysis, width, height, startSec, endSec, color]);

  return <canvas ref={canvasRef} width={width} height={height} className="rounded bg-black" />;
};

export default ClipWaveform;
