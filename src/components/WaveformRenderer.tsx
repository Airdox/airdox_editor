import React, { useEffect, useRef } from 'react';
import { WaveformRGBFrame, BeatGridEntry } from '../utils/anlzParser';

interface WaveformRendererProps {
  frames: WaveformRGBFrame[];
  beatGrid?: BeatGridEntry[];
  zoomFactor?: number; // Skalierung horizontal
  height?: number;
}

export const WaveformRenderer: React.FC<WaveformRendererProps> = ({
  frames,
  beatGrid = [],
  zoomFactor = 1,
  height = 120,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const centerY = height / 2;

    // Canvas aufräumen
    ctx.fillStyle = '#0f172a'; // Dunkler Hintergrund (Slate-900)
    ctx.fillRect(0, 0, width, height);

    if (frames.length === 0) return;

    const barWidth = 2 * zoomFactor;

    // 1. 3-Band RGB Waveform rendern (Low = Rot, Mid = Grün, High = Blau)
    frames.forEach((frame, idx) => {
      const x = idx * barWidth;
      if (x > width) return;

      // Höhenberechnungen skaliert auf Canvas-Höhe
      const lowH = (frame.low / 255) * (centerY * 0.85);
      const midH = (frame.mid / 255) * (centerY * 0.70);
      const highH = (frame.high / 255) * (centerY * 0.50);

      // Bass (Low) - Rot
      ctx.fillStyle = 'rgba(239, 68, 68, 0.85)';
      ctx.fillRect(x, centerY - lowH, barWidth - 0.5, lowH * 2);

      // Mitten (Mid) - Grün
      ctx.fillStyle = 'rgba(34, 197, 94, 0.75)';
      ctx.fillRect(x, centerY - midH, barWidth - 0.5, midH * 2);

      // Höhen (High) - Blau
      ctx.fillStyle = 'rgba(59, 130, 246, 0.9)';
      ctx.fillRect(x, centerY - highH, barWidth - 0.5, highH * 2);
    });

    // 2. Rekordbox Beatgrid Overlays einzeichnen
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.lineWidth = 1;

    beatGrid.forEach((entry) => {
      const x = (entry.sampleOffset / 150) * barWidth; // Rekordbox-Mapping Offset
      if (x >= 0 && x <= width) {
        ctx.beginPath();
        // Erster Beat im Takt (Eins) hervorheben
        if (entry.beatNumber === 1) {
          ctx.strokeStyle = 'rgba(234, 179, 8, 0.9)'; // Gelb für Beat 1
          ctx.lineWidth = 1.5;
        } else {
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
          ctx.lineWidth = 1;
        }
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
    });
  }, [frames, beatGrid, zoomFactor, height]);

  return (
    <div className="w-full overflow-x-auto bg-slate-900 p-2 rounded-lg shadow-inner">
      <canvas
        ref={canvasRef}
        width={Math.max(800, frames.length * 2 * zoomFactor)}
        height={height}
        className="block rounded"
      />
    </div>
  );
};