/**
 * @license
 * Rekordbox ImportProgressModal Component
 * 
 * High-transparency modal displaying real-time telemetry, phase progress,
 * live cue counters, and activity audit log during non-blocking Rekordbox XML imports.
 */

import React, { useState } from 'react';
import {
  Activity,
  CheckCircle2,
  Database,
  FileCode,
  Layers,
  Lock,
  Radio,
  Bookmark,
  ChevronDown,
  ChevronUp,
  Terminal,
  X,
  Sparkles,
} from 'lucide-react';
import { XmlImportProgress } from '../../rekordbox/xmlParser';

interface ImportProgressModalProps {
  isOpen: boolean;
  progress: XmlImportProgress | null;
  onClose: () => void;
  onOpenCollection?: () => void;
}

export const ImportProgressModal: React.FC<ImportProgressModalProps> = ({
  isOpen,
  progress,
  onClose,
  onOpenCollection,
}) => {
  const [showLogDetails, setShowLogDetails] = useState<boolean>(true);

  if (!isOpen || !progress) return null;

  const isComplete = progress.phase === 'COMPLETE';
  const isError = progress.phase === 'ERROR';
  const percent = Math.min(100, Math.max(0, progress.percent ?? (progress as any).percentage ?? 0));
  const phaseText =
    progress.phaseText ||
    (progress.phase === 'READING'
      ? 'Lese XML-Dokument ein...'
      : progress.phase === 'COMPLETE'
      ? 'Import erfolgreich abgeschlossen'
      : progress.phase === 'ERROR'
      ? 'Fehler beim Import'
      : 'Verarbeite Rekordbox XML...');
  const memoryCues = progress.memoryCuesFound ?? (progress as any).parsedCues ?? 0;
  const hotCues = progress.hotCuesFound ?? 0;
  const loops = progress.loopsFound ?? (progress as any).parsedLoops ?? 0;
  const logMessages = Array.isArray(progress.logMessages)
    ? progress.logMessages
    : Array.isArray((progress as any).logLines)
    ? (progress as any).logLines
    : [];

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4 select-none animate-in fade-in duration-200">
      <div className="w-full max-w-xl bg-[#0f1016] border border-[#222432] rounded-xs shadow-2xl overflow-hidden flex flex-col text-neutral-200 text-xs">
        {/* Header */}
        <div className="h-10 bg-[#15161f] border-b border-[#222432] flex items-center justify-between px-3.5 flex-shrink-0">
          <div className="flex items-center space-x-2">
            <div className="w-6 h-6 rounded bg-[#0088ff]/15 border border-[#0088ff]/40 flex items-center justify-center text-[#00a2ff]">
              <Database size={13} />
            </div>
            <div className="flex items-center space-x-2">
              <span className="font-bold text-white text-xs tracking-wide">
                Rekordbox XML Import &amp; Live-Analyse
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded-xs bg-[#00e5ff]/15 border border-[#00e5ff]/30 text-[#00e5ff] font-mono">
                NON-BLOCKING
              </span>
            </div>
          </div>

          {(isComplete || isError) && (
            <button
              onClick={onClose}
              className="p-1 hover:text-white text-neutral-400 hover:bg-[#20222e] rounded transition-colors"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* Modal Body */}
        <div className="p-4 space-y-4">
          {/* Priority 1 Guarantee Banner */}
          <div className="bg-[#0b1b12] border border-[#143d22] px-3 py-2 rounded-xs flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Lock size={13} className="text-[#00c853]" />
              <span className="text-[10.5px] font-semibold text-[#34d399]">
                PRIORITÄT 1: Originaldateien sind 100% unveränderlich geschützt (Read-Only)
              </span>
            </div>
            <span className="font-mono text-[9.5px] text-[#00c853] bg-[#00c853]/10 px-1.5 py-0.5 rounded border border-[#00c853]/30">
              IMMUTABLE
            </span>
          </div>

          {/* Current Status Message & Spinner/Badge */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11.5px]">
              <div className="flex items-center space-x-2">
                {isComplete ? (
                  <CheckCircle2 size={16} className="text-[#00c853]" />
                ) : isError ? (
                  <span className="text-[#ff4444] font-bold">✕</span>
                ) : (
                  <div className="w-3.5 h-3.5 border-2 border-[#0088ff] border-t-transparent rounded-full animate-spin" />
                )}
                <span className="font-bold text-white tracking-wide">
                  {phaseText}
                </span>
              </div>
              <span className="font-mono font-bold text-sm text-[#00e5ff]">
                {percent}%
              </span>
            </div>

            {/* Glowing Progress Bar */}
            <div className="w-full h-2.5 bg-[#090a0d] rounded-full overflow-hidden p-0.5 border border-[#1e202d] relative shadow-inner">
              <div
                className={`h-full rounded-full transition-all duration-150 ${
                  isError
                    ? 'bg-[#ff3b30]'
                    : 'bg-gradient-to-r from-[#0055ff] via-[#00a2ff] to-[#00e5ff] shadow-[0_0_12px_rgba(0,162,255,0.7)]'
                }`}
                style={{ width: `${percent}%` }}
              />
            </div>

            {progress.currentTrackName && !isComplete && (
              <div className="text-[10.5px] text-neutral-400 truncate pt-0.5">
                Aktueller Track: <span className="text-neutral-200 font-mono">"{progress.currentTrackName}"</span>
              </div>
            )}
          </div>

          {/* Real-time Telemetry Matrix */}
          <div className="grid grid-cols-4 gap-2 text-[11px]">
            {/* Tracks Counter */}
            <div className="bg-[#12141c] border border-[#20222f] p-2.5 rounded-xs flex flex-col">
              <span className="text-[9.5px] font-semibold text-neutral-400 uppercase tracking-wider">
                Tracks
              </span>
              <span className="font-mono text-base font-bold text-white mt-1">
                {progress.processedTracks || 0}
                {progress.totalTracks > 0 && (
                  <span className="text-xs text-neutral-500 font-normal"> / {progress.totalTracks}</span>
                )}
              </span>
            </div>

            {/* Memory Cues */}
            <div className="bg-[#12141c] border border-[#20222f] p-2.5 rounded-xs flex flex-col">
              <div className="flex items-center space-x-1">
                <Bookmark size={11} className="text-[#ff3b30]" />
                <span className="text-[9.5px] font-semibold text-neutral-400 uppercase tracking-wider">
                  Memory Cues
                </span>
              </div>
              <span className="font-mono text-base font-bold text-[#ff3b30] mt-1">
                {memoryCues}
              </span>
            </div>

            {/* Hot Cues */}
            <div className="bg-[#12141c] border border-[#20222f] p-2.5 rounded-xs flex flex-col">
              <div className="flex items-center space-x-1">
                <Radio size={11} className="text-[#00a2ff]" />
                <span className="text-[9.5px] font-semibold text-neutral-400 uppercase tracking-wider">
                  Hot Cues
                </span>
              </div>
              <span className="font-mono text-base font-bold text-[#00a2ff] mt-1">
                {hotCues}
              </span>
            </div>

            {/* Loops */}
            <div className="bg-[#12141c] border border-[#20222f] p-2.5 rounded-xs flex flex-col">
              <div className="flex items-center space-x-1">
                <Layers size={11} className="text-[#ff9500]" />
                <span className="text-[9.5px] font-semibold text-neutral-400 uppercase tracking-wider">
                  Loops
                </span>
              </div>
              <span className="font-mono text-base font-bold text-[#ff9500] mt-1">
                {loops}
              </span>
            </div>
          </div>

          {/* Expandable Live Audit Log Terminal */}
          <div className="border border-[#1f212d] rounded-xs bg-[#090a0e] overflow-hidden">
            <button
              onClick={() => setShowLogDetails(!showLogDetails)}
              className="w-full h-6 px-2.5 bg-[#12141c] border-b border-[#1b1c28] flex items-center justify-between text-[10px] text-neutral-400 hover:text-white transition-colors"
            >
              <div className="flex items-center space-x-1.5">
                <Terminal size={11} className="text-[#00e5ff]" />
                <span className="font-bold uppercase tracking-wider">Echtzeit Transparenz-Protokoll</span>
              </div>
              {showLogDetails ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>

            {showLogDetails && (
              <div className="p-2 font-mono text-[10px] text-neutral-300 space-y-1 max-h-32 overflow-y-auto leading-relaxed divide-y divide-[#151620]">
                {logMessages.length === 0 ? (
                  <div className="text-neutral-500 italic py-1">Initialisiere Analyse...</div>
                ) : (
                  logMessages.map((msg, idx) => (
                    <div key={idx} className="pt-0.5 pb-0.5 text-neutral-400 hover:text-neutral-200">
                      {msg}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="h-11 bg-[#13141d] border-t border-[#20222d] px-3.5 flex items-center justify-between flex-shrink-0">
          <div className="text-[10.5px] text-neutral-400 flex items-center space-x-1.5">
            <span className="w-2 h-2 rounded-full bg-[#00c853]" />
            <span>UI-Thread aktiv &amp; reaktionsfähig</span>
          </div>

          <div className="flex items-center space-x-2">
            {isComplete && onOpenCollection && (
              <button
                onClick={() => {
                  onClose();
                  onOpenCollection();
                }}
                className="px-3 py-1 bg-[#0088ff] hover:bg-[#0070d6] text-white rounded-xs font-semibold text-[11px] transition-colors flex items-center space-x-1 shadow"
              >
                <Sparkles size={12} />
                <span>Zur Track-Auswahl</span>
              </button>
            )}

            <button
              onClick={onClose}
              disabled={!isComplete && !isError}
              className={`px-3 py-1 rounded-xs font-medium text-[11px] transition-colors ${
                isComplete || isError
                  ? 'bg-[#222430] hover:bg-[#2b2e3e] text-white'
                  : 'bg-[#181922] text-neutral-500 cursor-not-allowed'
              }`}
            >
              {isComplete ? 'Schließen' : 'Wird verarbeitet...'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
