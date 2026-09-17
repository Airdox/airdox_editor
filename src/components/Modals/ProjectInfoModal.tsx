/**
 * @license
 * Rekordbox ProjectInfoModal Component
 * Transparency modal displaying Data Origin, Verified Rekordbox XML integrity,
 * and Original File Protection SHA-256 guarantees.
 */

import React from 'react';
import { X, ShieldCheck, Database, FileText, CheckCircle2, Lock } from 'lucide-react';
import { TrackModel } from '../../types/rekordbox';

interface ProjectInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
  track: TrackModel;
}

export const ProjectInfoModal: React.FC<ProjectInfoModalProps> = ({
  isOpen,
  onClose,
  track,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/75 backdrop-blur-xs flex items-center justify-center z-50 select-none p-4">
      <div className="w-full max-w-xl bg-[#12141a] border border-[#272935] rounded-xs shadow-2xl overflow-hidden flex flex-col text-neutral-200 text-xs">
        {/* Modal Header */}
        <div className="h-9 bg-[#171922] border-b border-[#252834] flex items-center justify-between px-3">
          <div className="flex items-center space-x-2">
            <ShieldCheck size={16} className="text-[#00c853]" />
            <span className="font-bold text-white text-xs tracking-wide">
              Rekordbox Data Layer & Originalschutz
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:text-white text-neutral-400 hover:bg-[#252834] rounded transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-4 space-y-4 max-h-[80vh] overflow-y-auto">
          {/* Priority 1: Original Protection */}
          <div className="bg-[#0b2014] border border-[#174627] p-3 rounded-xs flex items-start space-x-3">
            <Lock size={18} className="text-[#00c853] flex-shrink-0 mt-0.5" />
            <div className="space-y-1">
              <span className="font-bold text-[#34d399] text-xs block">
                PRIORITÄT 1: Originaldateien sind 100% unveränderlich geschützt
              </span>
              <p className="text-[11px] text-neutral-300 leading-relaxed">
                Original-Audiodateien und Rekordbox-Quelldatenbanken werden ausschließlich im Read-Only-Modus geöffnet. Sämtliche Schnitte, Inserts, Replaces und Overdubs finden in einer nichtdestruktiven Working-Copy-Ebene statt.
              </p>
              <div className="pt-1 font-mono text-[10px] text-neutral-400">
                Original SHA-256 Prüfsumme:{' '}
                <span className="text-[#34d399] font-bold">{track.originalSha256}</span>
              </div>
            </div>
          </div>

          {/* Sourced Data Matrix */}
          <div>
            <span className="text-neutral-400 font-bold uppercase text-[10px] tracking-wider block mb-2">
              Verifizierte Datenquellen (Unified DJ Model)
            </span>
            <div className="border border-[#20222d] rounded-xs divide-y divide-[#1e202a] bg-[#0d0e13]">
              <div className="p-2.5 flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <Database size={13} className="text-[#00a2ff]" />
                  <span className="font-medium text-white">Beatgrid & Tempo Map</span>
                </div>
                <div className="flex items-center space-x-1.5 text-[#00c853]">
                  <CheckCircle2 size={12} />
                  <span className="font-mono text-[10px] font-bold">REKORDBOX XML (VERIFIZIERT)</span>
                </div>
              </div>

              <div className="p-2.5 flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <FileText size={13} className="text-[#00a2ff]" />
                  <span className="font-medium text-white">Memory Cues & Hot Cues</span>
                </div>
                <div className="flex items-center space-x-1.5 text-[#00c853]">
                  <CheckCircle2 size={12} />
                  <span className="font-mono text-[10px] font-bold">REKORDBOX XML ({track.cues.length} Cues)</span>
                </div>
              </div>

              <div className="p-2.5 flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <FileText size={13} className="text-[#ff9500]" />
                  <span className="font-medium text-white">Loops & Quantize Alignment</span>
                </div>
                <div className="flex items-center space-x-1.5 text-[#00c853]">
                  <CheckCircle2 size={12} />
                  <span className="font-mono text-[10px] font-bold">REKORDBOX XML ({track.loops.length} Loops)</span>
                </div>
              </div>

              <div className="p-2.5 flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <Database size={13} className="text-[#d946ef]" />
                  <span className="font-medium text-white">Frequenzanalyse (RGB / 3BAND)</span>
                </div>
                <div className="flex items-center space-x-1.5 text-[#00a2ff]">
                  <CheckCircle2 size={12} />
                  <span className="font-mono text-[10px] font-bold">3-BAND IIR DSP (Echtzeit)</span>
                </div>
              </div>
            </div>
          </div>

          {/* Mathematical Transformation Specs */}
          <div className="bg-[#151720] border border-[#222532] p-3 rounded-xs space-y-1.5 text-[11px]">
            <span className="font-bold text-white block">Phasenstarre Zeittransformation</span>
            <p className="text-neutral-400 leading-relaxed">
              Bei Schnitt- und Einfügeoperationen (Delete, Cut, Insert) verschieben sich nachfolgende Beatgrid-Knoten, Memory Cues und Hot Cues exakt um die entsprechende Takt- und Beatdauer, ohne Phasendrift.
            </p>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="h-10 bg-[#151720] border-t border-[#232532] px-3 flex items-center justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1 bg-[#0088ff] hover:bg-[#0070d6] text-white rounded-xs font-semibold text-[11.5px] transition-colors"
          >
            Schließen
          </button>
        </div>
      </div>
    </div>
  );
};
