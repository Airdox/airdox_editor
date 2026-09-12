/**
 * @license
 * EditAssistantModal Component for airdox_SMART_Editor
 * Displays live buffer integrity diagnostics, validation rules, and safety alerts.
 */

import React from 'react';
import {
  ShieldCheck,
  ShieldAlert,
  AlertOctagon,
  CheckCircle2,
  X,
  Sliders,
  FileAudio,
  Cpu,
  Scissors,
} from 'lucide-react';
import { EditValidationResult, BufferIntegritySummary } from '../../types/editAssistant';

interface EditAssistantModalProps {
  isOpen: boolean;
  onClose: () => void;
  lastValidation: EditValidationResult | null;
  summary: BufferIntegritySummary;
  autoCorrect: boolean;
  onToggleAutoCorrect: (enabled: boolean) => void;
}

export const EditAssistantModal: React.FC<EditAssistantModalProps> = ({
  isOpen,
  onClose,
  lastValidation,
  summary,
  autoCorrect,
  onToggleAutoCorrect,
}) => {
  if (!isOpen) return null;

  const hasIssues = lastValidation && lastValidation.issues.length > 0;
  const hasError = lastValidation && lastValidation.issues.some((i) => i.severity === 'error');

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center z-50 select-none p-4">
      <div className="w-full max-w-lg bg-[#12141c] border border-[#262836] rounded shadow-2xl overflow-hidden flex flex-col text-neutral-200 text-xs">
        {/* Header */}
        <div className="h-10 bg-[#171922] border-b border-[#252834] flex items-center justify-between px-3">
          <div className="flex items-center space-x-2">
            <div
              className={`w-6 h-6 rounded flex items-center justify-center ${
                hasError
                  ? 'bg-red-950/60 border border-red-500/50 text-red-400'
                  : 'bg-[#0088ff]/20 border border-[#0088ff]/50 text-[#00e5ff]'
              }`}
            >
              {hasError ? <AlertOctagon size={14} /> : <ShieldCheck size={14} />}
            </div>
            <span className="font-bold text-white text-xs tracking-wide">
              Edit Assistant – Puffer- &amp; Auswahl-Integrität
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:text-white text-neutral-400 hover:bg-[#252834] rounded transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-3.5 max-h-[75vh] overflow-y-auto">
          {/* Status banner */}
          <div
            className={`p-3 rounded border flex items-start space-x-2.5 ${
              hasError
                ? 'bg-[#221013] border-[#ff453a]/40 text-red-200'
                : 'bg-[#0d1f14] border-emerald-800/40 text-emerald-200'
            }`}
          >
            {hasError ? (
              <ShieldAlert size={18} className="text-[#ff453a] flex-shrink-0 mt-0.5" />
            ) : (
              <CheckCircle2 size={18} className="text-emerald-400 flex-shrink-0 mt-0.5" />
            )}
            <div className="space-y-1">
              <span className="font-bold text-xs block text-white">
                {hasError
                  ? `Sicherheitswarnung bei ${lastValidation?.operation || 'Bearbeitung'}`
                  : 'Puffer-Integrität aktiv und geschützt'}
              </span>
              <p className="text-[11px] leading-relaxed opacity-90">
                {hasError
                  ? 'Der Edit Assistant hat eine unzulässige Operation oder beschädigte Bereichsgrenzen abgefangen, um Audio-Pufferverlust zu verhindern.'
                  : 'Alle Schnitt- und Kopier-Operationen werden in Echtzeit auf Bereichsgrenzen, Mindest-Samplelängen und Nicht-Destruktivität validiert.'}
              </p>
            </div>
          </div>

          {/* Last Validation Issues Breakdown */}
          {hasIssues && lastValidation && (
            <div className="bg-[#0e1015] border border-[#232530] p-3 rounded space-y-2">
              <div className="flex items-center justify-between text-[11px] font-mono border-b border-[#1c1e28] pb-1.5">
                <span className="text-neutral-400">Letzte Prüfung:</span>
                <span className="text-[#00e5ff] font-bold">{lastValidation.operation}</span>
              </div>
              <div className="space-y-1.5">
                {lastValidation.issues.map((issue, idx) => (
                  <div
                    key={idx}
                    className={`p-2 rounded text-[11px] font-mono space-y-1 ${
                      issue.severity === 'error'
                        ? 'bg-[#2b1215] border border-red-900/60 text-red-300'
                        : issue.severity === 'warning'
                        ? 'bg-[#292210] border border-amber-800/60 text-amber-200'
                        : 'bg-[#121c2b] border border-blue-900/60 text-blue-200'
                    }`}
                  >
                    <div className="flex items-center space-x-1.5 font-bold">
                      <span className="text-[9px] uppercase px-1 py-0.5 rounded bg-black/40">
                        {issue.code}
                      </span>
                      <span>{issue.message}</span>
                    </div>
                    {issue.remedy && (
                      <div className="text-[10px] text-neutral-300 font-sans pl-1 border-l-2 border-current/40">
                        Lösung: {issue.remedy}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Buffer & Selection Diagnostics */}
          <div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
            {/* Audio Buffer Box */}
            <div className="bg-[#0e1015] border border-[#232530] p-2.5 rounded space-y-1.5">
              <div className="flex items-center space-x-1.5 text-neutral-400 font-semibold text-[10.5px]">
                <FileAudio size={13} className="text-[#00a2ff]" />
                <span>Audio-Puffer</span>
              </div>
              <div className="space-y-0.5 text-[10px] text-neutral-300">
                <div className="flex justify-between">
                  <span>Status:</span>
                  <span className={summary.hasBuffer ? 'text-emerald-400' : 'text-neutral-500'}>
                    {summary.hasBuffer ? 'Geladen' : 'Kein Audio'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Dauer:</span>
                  <span className="text-white">{summary.bufferDuration.toFixed(3)}s</span>
                </div>
                <div className="flex justify-between">
                  <span>Abtastrate:</span>
                  <span className="text-neutral-300">{summary.sampleRate} Hz</span>
                </div>
                <div className="flex justify-between">
                  <span>Kanäle / Samples:</span>
                  <span className="text-neutral-300">
                    {summary.bufferChannels}ch / {summary.sampleCount.toLocaleString()}
                  </span>
                </div>
              </div>
            </div>

            {/* Selection Box */}
            <div className="bg-[#0e1015] border border-[#232530] p-2.5 rounded space-y-1.5">
              <div className="flex items-center space-x-1.5 text-neutral-400 font-semibold text-[10.5px]">
                <Scissors size={13} className="text-amber-400" />
                <span>Auswahl-Puffer</span>
              </div>
              <div className="space-y-0.5 text-[10px] text-neutral-300">
                <div className="flex justify-between">
                  <span>Status:</span>
                  <span className={summary.hasSelection ? 'text-emerald-400' : 'text-neutral-500'}>
                    {summary.hasSelection ? 'Ausgewählt' : 'Keine Auswahl'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Länge:</span>
                  <span className="text-white">{summary.selectionDuration.toFixed(3)}s</span>
                </div>
                <div className="flex justify-between">
                  <span>Sample-Anzahl:</span>
                  <span className="text-neutral-300">{summary.selectionSamples.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span>Zwischenablage:</span>
                  <span className={summary.hasClipboard ? 'text-[#00e5ff]' : 'text-neutral-500'}>
                    {summary.hasClipboard ? `${summary.clipboardDuration.toFixed(2)}s` : 'Leer'}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Assistant Options */}
          <div className="bg-[#151722] border border-[#262938] p-3 rounded flex items-center justify-between">
            <div className="space-y-0.5">
              <span className="font-semibold text-white text-xs block">
                Automatische Bereichskorrektur (Auto-Clamp)
              </span>
              <p className="text-[10.5px] text-neutral-400">
                Korrigiert leichte Rundungsüberläufe am Track-Ende und invertierte Start-/Endzeiten automatisch.
              </p>
            </div>
            <button
              onClick={() => onToggleAutoCorrect(!autoCorrect)}
              className={`px-3 py-1 rounded text-xs font-semibold font-mono transition-colors ${
                autoCorrect
                  ? 'bg-[#0088ff] text-white hover:bg-[#0099ff]'
                  : 'bg-[#252834] text-neutral-400 hover:text-white'
              }`}
            >
              {autoCorrect ? 'AKTIV' : 'AUS'}
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="h-10 bg-[#171922] border-t border-[#252834] px-4 flex items-center justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1 rounded bg-[#252834] hover:bg-[#323646] text-neutral-200 text-xs font-medium transition-colors"
          >
            Schließen
          </button>
        </div>
      </div>
    </div>
  );
};
