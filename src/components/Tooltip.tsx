/**
 * @license
 * Tooltip & Contextual Help Components
 * Provides sleek Pioneer DJ-styled tooltips, hover popovers, and an interactive audio glossary.
 */

import React, { useState, useRef, useEffect } from 'react';
import { HelpCircle, Info } from 'lucide-react';

export interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  position?: 'top' | 'bottom' | 'left' | 'right';
  delayMs?: number;
  className?: string;
}

export const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  position = 'top',
  delayMs = 250,
  className = '',
}) => {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<number | null>(null);

  const show = () => {
    timerRef.current = window.setTimeout(() => setVisible(true), delayMs);
  };

  const hide = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setVisible(false);
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const positionClasses = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-1.5',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-1.5',
    left: 'right-full top-1/2 -translate-y-1/2 mr-1.5',
    right: 'left-full top-1/2 -translate-y-1/2 ml-1.5',
  }[position];

  return (
    <div
      className={`relative inline-flex items-center ${className}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {visible && content && (
        <div
          className={`absolute z-[200] ${positionClasses} pointer-events-none transition-opacity duration-150 animate-in fade-in zoom-in-95`}
        >
          <div className="bg-[#12141c] border border-[#2b2f42] text-neutral-200 text-[11px] leading-snug rounded-xs px-2.5 py-1.5 shadow-2xl max-w-xs whitespace-normal backdrop-blur-md">
            {content}
          </div>
        </div>
      )}
    </div>
  );
};

export interface HelpBadgeProps {
  text: React.ReactNode;
  title?: string;
  size?: number;
  className?: string;
  position?: 'top' | 'bottom' | 'left' | 'right';
}

export const HelpBadge: React.FC<HelpBadgeProps> = ({
  text,
  title,
  size = 12,
  className = '',
  position = 'top',
}) => {
  return (
    <Tooltip
      position={position}
      content={
        <div className="space-y-1">
          {title && <div className="font-bold text-[#00c8ff] text-[11px]">{title}</div>}
          <div className="text-neutral-300 text-[10.5px] leading-relaxed">{text}</div>
        </div>
      }
    >
      <span
        className={`inline-flex items-center justify-center text-neutral-400 hover:text-[#00c8ff] cursor-help transition-colors p-0.5 ${className}`}
        aria-label={typeof text === 'string' ? text : 'Hilfe anzeigen'}
      >
        <HelpCircle size={size} />
      </span>
    </Tooltip>
  );
};

/** DJ & Audio Glossar für kontextuelle Hilfestellungen */
export const GLOSSARY = {
  STEMS: 'Aufteilung eines gemischten Songs in separate Tonspuren: Vocals (Gesang), Drums (Schlagzeug), Bass und Other (Melodie/Synths).',
  BS_ROFORMER: 'Band-Split RoFormer KI: Weltweit führende Quelltrennung mit 9.65 dB SDR (Gold-Standard) für Studio-Mastering.',
  HT_DEMUCS: 'Hybrid Transformer Demucs: Schnelle 4-Stem-Separation, besonders effizient als in-process ONNX für Live-DJ-Sets.',
  BEATGRID: 'Metrisches Taktraster aus Rekordbox mit BPM und Downbeat-Markern für taktgenaues Schneiden.',
  QUANTIZE: 'Automatisches Einrasten aller Aktionen (Cues, Loops, Schnitte) am Rekordbox Beatgrid.',
  ANLZ: 'Pioneer Rekordbox Binäranalyse (.DAT/.EXT/.2EX) mit 3-Band-/RGB-Wellenformen, Beats und Phrasen (Read-Only).',
  SDR: 'Signal-to-Distortion Ratio (in dB): Maß für die Reinheit und Qualität der getrennten Stems ohne Übersprechen.',
  DIRECTML: 'GPU-Beschleunigung unter Windows für Grafikkarten von NVIDIA, AMD und Intel.',
  CUDA: 'NVIDIA CUDA / TensorRT GPU-Beschleunigung für maximale KI-Inferenzgeschwindigkeit.',
  ACAPELLA: 'Reine Gesangsspur ohne Begleitmusik (Drums, Bass und Melodie stummgeschaltet).',
  INSTRUMENTAL: 'Vollständige Instrumentalspur (Gesang stummgeschaltet).',
  RIPPLE_DELETE: 'Löschen eines Audiobereichs, bei dem die nachfolgende Musik nahtlos nach vorne aufrückt.',
  CAMELOT_KEY: 'Harmonisches Tonartensystem (z.B. 8A = A-Moll) für nahtlose harmonische Übergänge.',
  LUFS: 'Loudness Units Full Scale – Internationaler EBU R128 Lautheitsstandard für Streaming und DJ-Sets.',
};
