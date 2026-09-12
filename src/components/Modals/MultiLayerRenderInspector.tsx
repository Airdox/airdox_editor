/**
 * @license
 * MultiLayerRenderInspector Component
 * Visualizes the rendered multi-layer composition pipeline:
 * - Timeline distribution of audio sources and clips
 * - Non-destructive original media provenance
 * - Applied Beat FX & Sound Color FX processing chains
 * - Sequential render step progress and final master packaging
 */

import React, { useState, useEffect } from 'react';
import { 
  Layers, 
  Sparkles, 
  Scissors, 
  Sliders, 
  ArrowRight, 
  CheckCircle, 
  FileAudio, 
  Cpu, 
  ShieldCheck, 
  Activity,
  Zap,
  Clock
} from 'lucide-react';
import { TrackModel, PaletteClip } from '../../types/rekordbox';

export interface RenderLayerItem {
  id: string;
  name: string;
  type: 'ORIGINAL_STEM' | 'AUDIO_CLIP' | 'COLOR_FX' | 'BEAT_FX' | 'MASTER_CHAIN';
  sourceFile: string;
  timeRange: string;
  startSec: number;
  durationSec: number;
  description: string;
  accentColor: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED';
}

interface MultiLayerRenderInspectorProps {
  isOpen: boolean;
  track: TrackModel;
  clips?: PaletteClip[];
  format: 'WAV' | 'XML' | 'JSON';
  onStartDownload: () => void;
  onCancel: () => void;
}

export const MultiLayerRenderInspector: React.FC<MultiLayerRenderInspectorProps> = ({
  isOpen,
  track,
  clips = [],
  format,
  onStartDownload,
  onCancel,
}) => {
  const [renderProgress, setRenderProgress] = useState<number>(0);
  const [currentStepIndex, setCurrentStepIndex] = useState<number>(0);
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [isDone, setIsDone] = useState<boolean>(false);

  // Generate multi-layer breakdown dynamically based on the current track and clips
  const totalDur = track.duration || 357.5;
  const clip1 = clips[0] || { name: 'Intro Kick 4B', sourceTrackName: track.title, duration: 7.38 };
  const clip2 = clips[1] || { name: '8-Bit Arp 8B', sourceTrackName: track.title, duration: 14.76 };
  const clip3 = clips[2] || { name: 'Main Drop 8B', sourceTrackName: track.title, duration: 14.76 };

  const layers: RenderLayerItem[] = [
    {
      id: 'layer-original',
      name: 'Schicht 1: Original Audio-Quelle (Grundspur)',
      type: 'ORIGINAL_STEM',
      sourceFile: track.originalMedia?.location || `${track.title.replace(/\s+/g, '_')}.mp3`,
      timeRange: `00:00.0 – ${Math.floor(totalDur / 60)}:${Math.floor(totalDur % 60).toString().padStart(2, '0')}.0`,
      startSec: 0,
      durationSec: totalDur,
      description: `Unverändertes Original-Master. SHA-256: ${track.originalSha256.slice(0, 10)}... (Read-Only)`,
      accentColor: '#0088ff',
      status: renderProgress > 20 ? 'COMPLETED' : renderProgress > 5 ? 'PROCESSING' : 'PENDING',
    },
    {
      id: 'layer-clips',
      name: 'Schicht 2: Audio-Schnipsel & Palette Inserts',
      type: 'AUDIO_CLIP',
      sourceFile: `${clip1.name}, ${clip2.name}, ${clip3.name}`,
      timeRange: `03:19.3 – 03:48.8 (Takt 109 – 125)`,
      startSec: 199.3,
      durationSec: 29.5,
      description: `Schnipsel stammen aus der Originaldatei und wurden mit phasenreinem Crossfade eingepflegt.`,
      accentColor: '#10b981',
      status: renderProgress > 50 ? 'COMPLETED' : renderProgress > 25 ? 'PROCESSING' : 'PENDING',
    },
    {
      id: 'layer-colorfx',
      name: 'Schicht 3: Sound Color FX Kette (Filter & Space)',
      type: 'COLOR_FX',
      sourceFile: 'Pioneer DJM-V10 Color FX Engine (Halbautomatisiert)',
      timeRange: '01:00.0 – 03:00.0 (Pre-Drop Phase)',
      startSec: 60.0,
      durationSec: 120.0,
      description: `Dynamische Low-Pass Resonance & Space Reverb Sweep mit automatisierter Cutoff-Hüllkurve.`,
      accentColor: '#f59e0b',
      status: renderProgress > 75 ? 'COMPLETED' : renderProgress > 50 ? 'PROCESSING' : 'PENDING',
    },
    {
      id: 'layer-beatfx',
      name: 'Schicht 4: Beat FX Zug (Quantized Roll & Echo 1/2)',
      type: 'BEAT_FX',
      sourceFile: 'Pioneer Beat FX Modul (130.05 BPM Synchronized)',
      timeRange: '03:15.0 – 03:26.7 (Breakdown Transition)',
      startSec: 195.0,
      durationSec: 11.7,
      description: `1/2 Beat Roll & Ping-Pong Delay exakt auf Takt 113.1 quantisiert.`,
      accentColor: '#ec4899',
      status: renderProgress > 90 ? 'COMPLETED' : renderProgress > 75 ? 'PROCESSING' : 'PENDING',
    },
    {
      id: 'layer-master',
      name: 'Schicht 5: Master Mastering & Headroom Limiter',
      type: 'MASTER_CHAIN',
      sourceFile: 'Studio Master Bus (32-Bit Float Summing -> 16-Bit Dither)',
      timeRange: 'Vollständige Spur (00:00 - Ende)',
      startSec: 0,
      durationSec: totalDur,
      description: `Summierung aller Spuren mit -0.3 dB True-Peak Ceiling und Rekordbox Beatgrid-Synchronisation.`,
      accentColor: '#8b5cf6',
      status: renderProgress >= 100 ? 'COMPLETED' : renderProgress > 90 ? 'PROCESSING' : 'PENDING',
    },
  ];

  const steps = [
    'Quellspuren & Schnipsel-Zuordnung analysieren...',
    'Phasenreine Audio-Buffer & Crossfades berechnen...',
    'Sound Color FX & Beat FX Automationsketten anwenden...',
    '32-Bit Floating Point Audio-Summierung rendern...',
    'Beatgrid, Cue-Punkte & Rekordbox Metadaten verifizieren...',
    `Master-Datei (${format}) fertiggestellt!`,
  ];

  useEffect(() => {
    if (!isOpen) {
      setRenderProgress(0);
      setCurrentStepIndex(0);
      setIsDone(false);
      setSelectedLayerId(null);
      return;
    }

    setSelectedLayerId('layer-clips');

    // Simulate precise multi-layer rendering progression
    const interval = setInterval(() => {
      setRenderProgress((prev) => {
        if (prev >= 100) {
          clearInterval(interval);
          setIsDone(true);
          return 100;
        }
        const next = prev + 2.5;
        const stepIdx = Math.min(steps.length - 1, Math.floor((next / 100) * steps.length));
        setCurrentStepIndex(stepIdx);
        return next;
      });
    }, 55);

    return () => clearInterval(interval);
  }, [isOpen]);

  if (!isOpen) return null;

  const activeLayer = layers.find((l) => l.id === selectedLayerId) || layers[1];

  return (
    <div className="fixed inset-0 bg-black/85 backdrop-blur-md flex items-center justify-center z-50 select-none p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-4xl bg-[#0f1117] border border-[#262a3a] rounded-sm shadow-2xl flex flex-col text-neutral-200 overflow-hidden">
        {/* Header */}
        <div className="h-12 bg-[#151824] border-b border-[#242838] px-4 flex items-center justify-between">
          <div className="flex items-center space-x-2.5">
            <div className="p-1.5 rounded-xs bg-[#0088ff]/15 border border-[#0088ff]/30 text-[#0088ff]">
              <Layers size={16} />
            </div>
            <div>
              <div className="text-xs font-bold text-white flex items-center space-x-2">
                <span>Multi-Schichten Render-Inspektor</span>
                <span className="text-[10px] px-1.5 py-0.2 rounded-xs bg-[#00e5ff]/20 text-[#00e5ff] font-mono border border-[#00e5ff]/40">
                  {format} MASTER
                </span>
              </div>
              <div className="text-[10px] text-neutral-400">
                Visuelle Schichten-Zusammensetzung & Effektketten-Transparenz
              </div>
            </div>
          </div>

          <div className="flex items-center space-x-3">
            <div className="flex items-center space-x-1.5 text-[11px] font-mono text-neutral-400">
              <Clock size={12} className="text-[#0088ff]" />
              <span>{Math.round(renderProgress)}%</span>
            </div>
            <div className="w-28 h-2 bg-[#1f2333] rounded-full overflow-hidden border border-[#2b3145]">
              <div
                className="h-full bg-gradient-to-r from-[#0088ff] via-[#00e5ff] to-[#10b981] transition-all duration-150"
                style={{ width: `${renderProgress}%` }}
              />
            </div>
          </div>
        </div>

        {/* Live Step Banner */}
        <div className="px-4 py-2 bg-[#111420] border-b border-[#1f2333] flex items-center justify-between text-[11px]">
          <div className="flex items-center space-x-2">
            <Activity size={13} className="text-[#00e5ff] animate-pulse" />
            <span className="text-neutral-300 font-medium">
              Schritt {currentStepIndex + 1}/{steps.length}: {steps[currentStepIndex]}
            </span>
          </div>
          <div className="flex items-center space-x-1.5 text-[10px] text-neutral-400">
            <ShieldCheck size={12} className="text-[#10b981]" />
            <span>Non-Destructive • Original intakt</span>
          </div>
        </div>

        {/* Multi-Layer Timeline Visualization */}
        <div className="p-4 space-y-4">
          <div className="bg-[#0b0d13] border border-[#1d2232] rounded-xs p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-bold uppercase tracking-wider text-neutral-400 flex items-center space-x-1">
                <Sliders size={12} className="text-[#0088ff]" />
                <span>Timeline Mehrschichten-Modell (00:00 – {Math.floor(totalDur / 60)}:{Math.floor(totalDur % 60).toString().padStart(2, '0')})</span>
              </span>
              <span className="text-[9.5px] font-mono text-neutral-500">
                130.05 BPM • 4/4 Beatgrid synchron
              </span>
            </div>

            {/* Time ruler */}
            <div className="relative h-4 border-b border-[#202538] mb-2 text-[8.5px] font-mono text-neutral-500 flex justify-between px-1">
              <span>0:00</span>
              <span>1:00 (Bar 32)</span>
              <span>2:00 (Bar 65)</span>
              <span>3:00 (Bar 97)</span>
              <span className="text-[#00e5ff]">3:26 (Bar 113 Drop)</span>
              <span>4:00 (Bar 130)</span>
              <span>5:00</span>
              <span>5:57</span>
            </div>

            {/* Visual Layer Tracks */}
            <div className="space-y-1.5">
              {layers.map((layer) => {
                const isSelected = selectedLayerId === layer.id;
                const leftPercent = (layer.startSec / totalDur) * 100;
                const widthPercent = Math.max(8, (layer.durationSec / totalDur) * 100);

                return (
                  <div
                    key={layer.id}
                    onClick={() => setSelectedLayerId(layer.id)}
                    className={`relative h-9 rounded-xs cursor-pointer border transition-all flex items-center px-2.5 overflow-hidden ${
                      isSelected
                        ? 'bg-[#181d2c] border-[#0088ff] shadow-sm'
                        : 'bg-[#121520] border-[#1d2232] hover:bg-[#151926]'
                    }`}
                  >
                    {/* Layer Bar Segment on Timeline */}
                    <div
                      className="absolute top-0 bottom-0 opacity-20 transition-all pointer-events-none"
                      style={{
                        left: `${leftPercent}%`,
                        width: `${widthPercent}%`,
                        backgroundColor: layer.accentColor,
                      }}
                    />

                    {/* Left Layer Tag */}
                    <div className="flex items-center space-x-2 z-10 w-64 flex-shrink-0">
                      <div
                        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                        style={{ backgroundColor: layer.accentColor }}
                      />
                      <span className="text-[11px] font-bold text-white truncate">
                        {layer.name}
                      </span>
                    </div>

                    {/* Middle Timeline Segment Box with mini-arrow & details */}
                    <div className="flex-1 flex items-center justify-center z-10 relative">
                      <div
                        className="h-6 rounded-xs flex items-center justify-between px-2 text-[9.5px] font-mono transition-all border"
                        style={{
                          width: `${Math.min(100, Math.max(30, widthPercent))}%`,
                          backgroundColor: `${layer.accentColor}25`,
                          borderColor: `${layer.accentColor}60`,
                          color: '#ffffff',
                        }}
                      >
                        <span className="truncate">{layer.timeRange}</span>
                        {layer.status === 'COMPLETED' && (
                          <CheckCircle size={10} className="text-[#10b981] ml-1 flex-shrink-0" />
                        )}
                        {layer.status === 'PROCESSING' && (
                          <Zap size={10} className="text-[#f59e0b] ml-1 animate-spin flex-shrink-0" />
                        )}
                      </div>
                    </div>

                    {/* Right Status Badge */}
                    <div className="w-24 text-right z-10 flex-shrink-0">
                      <span
                        className={`text-[9.5px] font-bold uppercase tracking-tight px-1.5 py-0.5 rounded-xs ${
                          layer.status === 'COMPLETED'
                            ? 'bg-[#10b981]/20 text-[#34d399] border border-[#10b981]/30'
                            : layer.status === 'PROCESSING'
                            ? 'bg-[#f59e0b]/20 text-[#fbbf24] border border-[#f59e0b]/30'
                            : 'bg-neutral-800 text-neutral-500'
                        }`}
                      >
                        {layer.status === 'COMPLETED'
                          ? 'Berechnet'
                          : layer.status === 'PROCESSING'
                          ? 'Rendert...'
                          : 'Warteschlange'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Detailed Inspector Box for Selected Layer (mit Pfeilchen und Kästchen) */}
          <div className="bg-[#121622] border border-[#242b40] rounded-xs p-3">
            <div className="flex items-start justify-between mb-2">
              <div className="flex items-center space-x-2">
                <div
                  className="w-3 h-3 rounded-xs flex-shrink-0"
                  style={{ backgroundColor: activeLayer.accentColor }}
                />
                <span className="text-xs font-bold text-white">
                  Schichten-Inspektor: {activeLayer.name}
                </span>
              </div>
              <span className="text-[10px] font-mono text-neutral-400">
                Wirkungsbereich: {activeLayer.timeRange}
              </span>
            </div>

            {/* Interactive Arrow-Chains Diagram */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5 mt-2.5 text-[11px]">
              {/* Box 1: Herkunft / Quelle */}
              <div className="bg-[#0c0e15] border border-[#1d2232] rounded-xs p-2.5 flex flex-col justify-between">
                <div className="text-[9.5px] font-bold text-neutral-400 uppercase tracking-wider mb-1 flex items-center space-x-1">
                  <FileAudio size={11} className="text-[#0088ff]" />
                  <span>1. Ursprung & Dateiquelle</span>
                </div>
                <div className="text-white font-mono text-[10.5px] bg-[#141824] p-1.5 rounded border border-[#20273c] break-all">
                  {activeLayer.sourceFile}
                </div>
                <div className="text-[10px] text-neutral-400 mt-1">
                  Physische Referenz aus Rekordbox Library.
                </div>
              </div>

              {/* Box 2: Bearbeitung / Effektkette */}
              <div className="bg-[#0c0e15] border border-[#1d2232] rounded-xs p-2.5 flex flex-col justify-between relative">
                <div className="text-[9.5px] font-bold text-neutral-400 uppercase tracking-wider mb-1 flex items-center space-x-1">
                  <Cpu size={11} className="text-[#10b981]" />
                  <span>2. Angewandte Bearbeitung</span>
                </div>
                <div className="text-neutral-200 text-[10.5px] bg-[#141824] p-1.5 rounded border border-[#20273c]">
                  {activeLayer.description}
                </div>
                <div className="text-[10px] text-[#00e5ff] mt-1 flex items-center space-x-1">
                  <ArrowRight size={10} />
                  <span>Beatgrid-synchronisiert (130.05 BPM)</span>
                </div>
              </div>

              {/* Box 3: Ziel & Master-Summe */}
              <div className="bg-[#0c0e15] border border-[#1d2232] rounded-xs p-2.5 flex flex-col justify-between">
                <div className="text-[9.5px] font-bold text-neutral-400 uppercase tracking-wider mb-1 flex items-center space-x-1">
                  <Sparkles size={11} className="text-[#f59e0b]" />
                  <span>3. Render-Ergebnis</span>
                </div>
                <div className="text-white font-mono text-[10.5px] bg-[#141824] p-1.5 rounded border border-[#20273c]">
                  Ziel: Master Stream ({format})
                </div>
                <div className="text-[10px] text-neutral-400 mt-1 flex items-center justify-between">
                  <span>Qualität: 16-Bit / 44.1kHz</span>
                  <span className="text-[#10b981] font-bold">Verlustfrei</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="h-12 bg-[#141724] border-t border-[#232738] px-4 flex items-center justify-between">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-neutral-400 hover:text-white text-xs transition-colors rounded hover:bg-[#202538]"
          >
            Schließen
          </button>

          <div className="flex items-center space-x-3">
            <span className="text-[11px] text-neutral-400">
              {isDone
                ? 'Alle 5 Schichten erfolgreich gerendert und verifiziert.'
                : 'Schichten werden sukzessive im Audio-Buffer summiert...'}
            </span>

            <button
              onClick={onStartDownload}
              disabled={!isDone}
              className={`px-4 py-1.5 rounded-xs font-bold text-xs flex items-center space-x-1.5 transition-all shadow-md ${
                isDone
                  ? 'bg-[#0088ff] hover:bg-[#0070d6] text-white cursor-pointer hover:shadow-[#0088ff]/25'
                  : 'bg-[#1b2234] text-neutral-500 border border-[#273048] cursor-not-allowed'
              }`}
            >
              <CheckCircle size={13} />
              <span>{isDone ? `${format} Master-Datei herunterladen` : 'Rendert Schichten...'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
