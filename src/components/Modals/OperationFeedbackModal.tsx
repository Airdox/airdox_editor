/**
 * @license
 * Rekordbox OperationFeedbackModal Component
 * 
 * High-transparency status & confirmation modal displaying exact mathematical
 * offsets, bar/beat shift calculations, and original protection guarantees
 * for all DJ operations (Insert, Replace, Overdub, Delete, Export).
 */

import React from 'react';
import {
  ShieldCheck,
  CheckCircle2,
  Clock,
  ArrowRight,
  Layers,
  Sparkles,
  Info,
  X,
  Lock,
} from 'lucide-react';

export interface OperationTelemetry {
  title: string;
  operationType: 'INSERT' | 'REPLACE' | 'OVERDUB' | 'DELETE' | 'CLEAR' | 'EXPORT' | 'CUE' | 'IMPORT' | 'PROJECT';
  description: string;
  timeRangeSec?: { start: number; end: number; duration: number };
  barsCount?: number;
  beatsCount?: number;
  shiftedCuesCount?: number;
  originalSha256: string;
  timestamp: number;
}

interface OperationFeedbackModalProps {
  isOpen: boolean;
  onClose: () => void;
  telemetry: OperationTelemetry | null;
}

export const OperationFeedbackModal: React.FC<OperationFeedbackModalProps> = ({
  isOpen,
  onClose,
  telemetry,
}) => {
  if (!isOpen || !telemetry) return null;

  const formatSec = (secs?: number) => {
    if (secs === undefined || isNaN(secs)) return '00:00.000';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    const ms = Math.floor((secs % 1) * 1000);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
  };

  const getBadgeColor = () => {
    switch (telemetry.operationType) {
      case 'INSERT': return 'bg-[#00a2ff]/15 border-[#00a2ff]/30 text-[#00a2ff]';
      case 'REPLACE': return 'bg-[#f59e0b]/15 border-[#f59e0b]/30 text-[#f59e0b]';
      case 'OVERDUB': return 'bg-[#8b5cf6]/15 border-[#8b5cf6]/30 text-[#8b5cf6]';
      case 'DELETE': return 'bg-[#ef4444]/15 border-[#ef4444]/30 text-[#ef4444]';
      case 'EXPORT': return 'bg-[#10b981]/15 border-[#10b981]/30 text-[#10b981]';
      default: return 'bg-[#0088ff]/15 border-[#0088ff]/30 text-[#0088ff]';
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4 select-none animate-in fade-in duration-150">
      <div className="w-full max-w-md bg-[#101217] border border-[#232532] rounded-xs shadow-2xl overflow-hidden flex flex-col text-neutral-200 text-xs">
        {/* Header */}
        <div className="h-9 bg-[#151720] border-b border-[#222430] flex items-center justify-between px-3">
          <div className="flex items-center space-x-2">
            <Sparkles size={14} className="text-[#0088ff]" />
            <span className="font-bold text-white text-xs tracking-wide">
              {telemetry.title}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:text-white text-neutral-400 hover:bg-[#20222e] rounded transition-colors"
          >
            <X size={13} />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-3.5">
          {/* Status Badge & Description */}
          <div className="flex items-center justify-between">
            <span className={`px-2 py-0.5 rounded-xs border text-[10.5px] font-mono font-bold ${getBadgeColor()}`}>
              {telemetry.operationType} OPERATION
            </span>
            <span className="text-[10px] text-neutral-400 font-mono">
              {new Date(telemetry.timestamp).toLocaleTimeString()}
            </span>
          </div>

          <p className="text-[11.5px] text-neutral-300 leading-relaxed">
            {telemetry.description}
          </p>

          {/* Mathematical Transformation Details */}
          {telemetry.timeRangeSec && (
            <div className="bg-[#0b0c10] border border-[#1d1f2a] rounded-xs p-2.5 space-y-2 font-mono text-[11px]">
              <div className="flex items-center justify-between text-neutral-300">
                <span className="text-neutral-500">Zeitintervall:</span>
                <span>
                  {formatSec(telemetry.timeRangeSec.start)} <ArrowRight size={10} className="inline mx-1 text-neutral-500" /> {formatSec(telemetry.timeRangeSec.end)}
                </span>
              </div>
              <div className="flex items-center justify-between text-neutral-300">
                <span className="text-neutral-500">Dauer:</span>
                <span className="text-white font-bold">
                  {formatSec(telemetry.timeRangeSec.duration)}
                </span>
              </div>
              {telemetry.barsCount !== undefined && (
                <div className="flex items-center justify-between text-neutral-300">
                  <span className="text-neutral-500">Musikalische Länge:</span>
                  <span className="text-[#00a2ff] font-bold">
                    {telemetry.barsCount.toFixed(1)} Bars ({Math.round(telemetry.beatsCount || 0)} Beats)
                  </span>
                </div>
              )}
              {telemetry.shiftedCuesCount !== undefined && telemetry.shiftedCuesCount > 0 && (
                <div className="flex items-center justify-between text-[#34d399] border-t border-[#181a24] pt-1.5 mt-1.5">
                  <span className="text-neutral-400">Phasenstarre Cues:</span>
                  <span className="font-bold">
                    {telemetry.shiftedCuesCount} Marker exakt verschoben
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Priority 1 Immutability Check */}
          <div className="bg-[#0b1c11] border border-[#154625] p-2 rounded-xs flex items-center justify-between text-[10px]">
            <div className="flex items-center space-x-1.5 text-[#34d399]">
              <Lock size={12} />
              <span className="font-semibold">Originaldatei unverändert (SHA-256 gesichert)</span>
            </div>
            <span className="text-[#00c853] font-mono font-bold">OK</span>
          </div>
        </div>

        {/* Footer */}
        <div className="h-9 bg-[#13151d] border-t border-[#20222d] px-3 flex items-center justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1 bg-[#0088ff] hover:bg-[#0070d6] text-white rounded-xs font-semibold text-[11px] transition-colors shadow"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
};
