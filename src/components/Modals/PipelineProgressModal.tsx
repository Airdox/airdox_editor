/**
 * @license
 * PipelineProgressModal – Live-Popup während des Track-Ladens.
 *
 * Zeigt zu Testzwecken sichtbar an, welche Code-Abschnitte der Ladepipeline
 * bereits durchlaufen wurden (XML/DB-Quelle → Master-DB-Gate → Audio →
 * Wellenform/Analysis → Deck). Der Status jeder Stufe stammt aus echten
 * Ergebnissen (Gate-Flags, Audio-/Analysis-Status) – nichts wird erfunden.
 */

import React from 'react';
import { Activity, CheckCircle2, Circle, Lock, MinusCircle, X, XCircle } from 'lucide-react';
import {
  PipelineStageState,
  PipelineStageStatus,
  pipelinePercent,
} from '../../rekordbox/pipelineProgress';

interface PipelineProgressModalProps {
  isOpen: boolean;
  trackTitle: string;
  stages: PipelineStageState[];
  onClose: () => void;
}

const STATUS_STYLE: Record<PipelineStageStatus, { text: string }> = {
  PENDING: { text: 'text-neutral-500' },
  RUNNING: { text: 'text-[#00a2ff]' },
  DONE: { text: 'text-[#00c853]' },
  FAILED: { text: 'text-[#ff4444]' },
  SKIPPED: { text: 'text-[#f59e0b]' },
};

function StageIcon({ status }: { status: PipelineStageStatus }) {
  switch (status) {
    case 'DONE':
      return <CheckCircle2 size={15} className="text-[#00c853] flex-shrink-0" />;
    case 'RUNNING':
      return (
        <div className="w-[15px] h-[15px] border-2 border-[#00a2ff] border-t-transparent rounded-full animate-spin flex-shrink-0" />
      );
    case 'FAILED':
      return <XCircle size={15} className="text-[#ff4444] flex-shrink-0" />;
    case 'SKIPPED':
      return <MinusCircle size={15} className="text-[#f59e0b] flex-shrink-0" />;
    default:
      return <Circle size={15} className="text-neutral-600 flex-shrink-0" />;
  }
}

export const PipelineProgressModal: React.FC<PipelineProgressModalProps> = ({
  isOpen,
  trackTitle,
  stages,
  onClose,
}) => {
  if (!isOpen || stages.length === 0) return null;

  const percent = pipelinePercent(stages);
  const failedStage = stages.find((s) => s.status === 'FAILED');
  const allDone = stages.every((s) => s.status === 'DONE' || s.status === 'SKIPPED');

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-xs flex items-center justify-center p-4 select-none animate-in fade-in duration-200">
      <div className="w-full max-w-lg bg-[#0f1016] border border-[#222432] rounded-xs shadow-2xl overflow-hidden flex flex-col text-neutral-200 text-xs">
        {/* Header */}
        <div className="h-10 bg-[#15161f] border-b border-[#222432] flex items-center justify-between px-3.5 flex-shrink-0">
          <div className="flex items-center space-x-2">
            <div className="w-6 h-6 rounded bg-[#0088ff]/15 border border-[#0088ff]/40 flex items-center justify-center text-[#00a2ff]">
              <Activity size={13} />
            </div>
            <div className="flex items-center space-x-2">
              <span className="font-bold text-white text-xs tracking-wide">
                Lade-Pipeline – Live-Status
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded-xs bg-[#00e5ff]/15 border border-[#00e5ff]/30 text-[#00e5ff] font-mono">
                PIPELINE-GATE
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:text-white text-neutral-400 hover:bg-[#20222e] rounded transition-colors"
            title="Popup schließen (Pipeline läuft im Hintergrund weiter)"
          >
            <X size={14} />
          </button>
        </div>

        <div className="p-4 space-y-3">
          {/* Track & Fortschritt */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11.5px]">
              <div className="flex items-center space-x-2 min-w-0">
                {allDone ? (
                  <CheckCircle2 size={16} className="text-[#00c853] flex-shrink-0" />
                ) : failedStage ? (
                  <XCircle size={16} className="text-[#ff4444] flex-shrink-0" />
                ) : (
                  <div className="w-3.5 h-3.5 border-2 border-[#0088ff] border-t-transparent rounded-full animate-spin flex-shrink-0" />
                )}
                <span className="font-bold text-white tracking-wide truncate">
                  {trackTitle || 'Track'}
                </span>
              </div>
              <span className="font-mono text-[10px] text-neutral-400">{percent}%</span>
            </div>
            <div className="h-1.5 bg-[#1a1c28] rounded-xs overflow-hidden">
              <div
                className={`h-full transition-all duration-300 ${
                  failedStage ? 'bg-[#ff4444]' : allDone ? 'bg-[#00c853]' : 'bg-[#0088ff]'
                }`}
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>

          {/* Read-Only-Garantie */}
          <div className="bg-[#0b1b12] border border-[#143d22] px-3 py-1.5 rounded-xs flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Lock size={12} className="text-[#00c853]" />
              <span className="text-[10px] font-semibold text-[#34d399]">
                Alle Rekordbox-Quellen werden ausschließlich lesend geöffnet
              </span>
            </div>
            <span className="font-mono text-[9px] text-[#00c853] bg-[#00c853]/10 px-1.5 py-0.5 rounded border border-[#00c853]/30">
              READ-ONLY
            </span>
          </div>

          {/* Stufenliste: welche Code-Abschnitte bereits durchlaufen wurden */}
          <div className="border border-[#222432] rounded-xs divide-y divide-[#1a1c28] max-h-80 overflow-y-auto">
            {stages.map((stage, index) => (
              <div
                key={stage.id}
                className={`flex items-start space-x-2.5 px-3 py-2 ${
                  stage.status === 'RUNNING' ? 'bg-[#0d1622]' : ''
                }`}
              >
                <span className="font-mono text-[9.5px] text-neutral-600 w-4 text-right pt-0.5 flex-shrink-0">
                  {index + 1}
                </span>
                <div className="pt-0.5">
                  <StageIcon status={stage.status} />
                </div>
                <div className="min-w-0 flex-1">
                  <div
                    className={`text-[11px] leading-tight ${STATUS_STYLE[stage.status].text} ${
                      stage.status === 'PENDING' ? 'opacity-70' : 'font-semibold'
                    }`}
                  >
                    {stage.label}
                  </div>
                  {stage.detail && (
                    <div className="font-mono text-[9.5px] text-neutral-500 truncate mt-0.5" title={stage.detail}>
                      {stage.detail}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Statuszeile */}
          {failedStage ? (
            <div className="bg-[#2a0f12] border border-[#4a1a20] px-3 py-2 rounded-xs text-[10.5px] text-[#ff8a8a]">
              <span className="font-bold">Pipeline angehalten:</span> Stufe „{failedStage.label}“ ist
              fehlgeschlagen. Es werden keine Ersatzdaten als Rekordbox-Daten dargestellt.
            </div>
          ) : allDone ? (
            <div className="bg-[#0b1b12] border border-[#143d22] px-3 py-2 rounded-xs text-[10.5px] text-[#34d399]">
              Alle Code-Abschnitte wurden erfolgreich durchlaufen – der Track liegt im Deck.
            </div>
          ) : (
            <div className="text-[10px] text-neutral-500 text-center">
              Pipeline läuft … die Liste aktualisiert sich mit jedem durchlaufenen Code-Abschnitt.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
